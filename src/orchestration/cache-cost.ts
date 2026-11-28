/**
 * A conservative, single-next-request comparison for changing a reused worker's
 * model versus keeping its warm prefix. Only acts with observed cache reads and
 * complete, nonzero per-token pricing. Unknown or stale telemetry never vetoes
 * a requested model change.
 */
export interface CacheCostModel {
  /** Pi model identity (optional): selects the cache age limit, see cacheAgeLimitMs. Price-only callers get the short default. */
  id?: string;
  api?: string;
  cost?: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
  };
}
export interface CacheObservation {
  model: string;
  at: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export type SwitchDecision =
  | { action: "switch"; reason: string; keepUSD?: number; switchUSD?: number }
  | { action: "keep"; reason: string; keepUSD: number; switchUSD: number };

const validPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const validTokens = (value: number) => Number.isFinite(value) && value >= 0;

/** Select a catalog's long-context pricing for the observed input token count.
 * Invalid tiers fail closed instead of assuming base pricing is authoritative. */
function rateAt(model: CacheCostModel, tokens: number) {
  const base = model.cost;
  if (!base) return undefined;
  let rate: NonNullable<CacheCostModel["cost"]> = base;
  for (const tier of base.tiers ?? []) {
    if (!validTokens(tier.inputTokensAbove) || !validPrice(tier.input) ||
        !validPrice(tier.output) || !validPrice(tier.cacheRead) || tier.cacheWrite < 0 || !Number.isFinite(tier.cacheWrite)) return undefined;
    if (tokens > tier.inputTokensAbove && (!("inputTokensAbove" in rate) || tier.inputTokensAbove > (rate as { inputTokensAbove: number }).inputTokensAbove)) rate = tier;
  }
  return rate;
}
/** A stale cache isn't a discount. Claude's short TTL is generally about five minutes: the default for every model
 * not known to keep its prompt cache longer. */
export const MAX_CACHE_AGE_MS = 4 * 60 * 1000;
/** OpenAI GPT-5.6 and later document a minimum cache lifetime of 30 minutes (the default `prompt_cache_options.ttl`
 * "30m", refreshed by every read; https://developers.openai.com/api/docs/guides/prompt-caching), applied here to every
 * OpenAI API family route, CLIProxyAPI/Codex included. A heuristic matching that documented minimum, not a TTL
 * guarantee: earlier GPT models (in_memory retention, typically 5-10 minutes) keep the short default. */
export const OPENAI_EXTENDED_CACHE_AGE_MS = 30 * 60 * 1000;

const OPENAI_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses", "openai-completions"]);

/** GPT-5.6+ and GPT-6+ by numeric major/minor of the model id's last path segment (route prefixes such as
 * `openai/` are ignored; `gpt-5.10` counts as 5.10, not 5.1). */
function hasExtendedOpenAICache(model: CacheCostModel): boolean {
  if (typeof model.id !== "string") return false;
  if (model.api !== undefined && !OPENAI_APIS.has(model.api)) return false;
  const match = /^gpt-(\d+)(?:\.(\d+))?(?![\d.])/i.exec(model.id.slice(model.id.lastIndexOf("/") + 1));
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/** How old the warm model's cache observation may be before it no longer counts as a discount. */
export function cacheAgeLimitMs(model: CacheCostModel): number {
  return hasExtendedOpenAICache(model) ? OPENAI_EXTENDED_CACHE_AGE_MS : MAX_CACHE_AGE_MS;
}

export function compareCachedModelSwitch(
  current: CacheCostModel,
  target: CacheCostModel,
  observation: CacheObservation | undefined,
  now = Date.now(),
): SwitchDecision {
  if (!observation || observation.cacheRead <= 0) return { action: "switch", reason: "no measured cache reuse" };
  if (!validTokens(observation.input) || !validTokens(observation.cacheRead) ||
      !validTokens(observation.cacheWrite) || !validTokens(observation.output) ||
      !Number.isFinite(observation.at) || observation.at > now || now - observation.at > cacheAgeLimitMs(current)) {
    return { action: "switch", reason: "invalid or stale cache observation" };
  }
  const tokens = observation.input + observation.cacheRead + observation.cacheWrite;
  const a = rateAt(current, tokens), b = rateAt(target, tokens);
  if (!a || !b || !validPrice(a.input) || !validPrice(a.cacheRead) ||
      !validPrice(a.output) || !validPrice(b.input) || !validPrice(b.output) ||
      a.cacheRead >= a.input) {
    return { action: "switch", reason: "incomplete or non-beneficial cache pricing" };
  }
  // The previous response's cache-read tokens are the only prefix known to be
  // warm. The next target call must write that prefix afresh.
  const warm = observation.cacheRead;
  const fresh = observation.input;
  const writes = observation.cacheWrite;
  // Cache-write tokens are billed separately by providers such as Anthropic.
  // The new model must establish the previously cached prefix at its cold/writing
  // rate, whereas the current model reads that prefix at the discounted rate.
  const currentWriteRate = validPrice(a.cacheWrite) ? a.cacheWrite : a.input;
  const targetWriteRate = validPrice(b.cacheWrite) ? b.cacheWrite : b.input;
  const keepUSD = (warm * a.cacheRead + fresh * a.input + writes * currentWriteRate +
    observation.output * a.output) / 1_000_000;
  const switchUSD = ((warm + writes) * targetWriteRate + fresh * b.input +
    observation.output * b.output) / 1_000_000;
  if (keepUSD < switchUSD) return { action: "keep", reason: "measured warm prefix is cheaper for the next call", keepUSD, switchUSD };
  return { action: "switch", reason: "candidate costs no more than retaining the warm prefix", keepUSD, switchUSD };
}
