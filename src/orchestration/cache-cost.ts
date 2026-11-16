/**
 * A conservative, single-next-request comparison for changing a reused worker's
 * model versus keeping its warm prefix. Only acts with observed cache reads and
 * complete, nonzero per-token pricing. Unknown or stale telemetry never vetoes
 * a requested model change.
 */
export interface CacheCostModel {
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
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
/** A stale cache isn't a discount. Claude's short TTL is generally about five minutes. */
export const MAX_CACHE_AGE_MS = 4 * 60 * 1000;

export function compareCachedModelSwitch(
  current: CacheCostModel,
  target: CacheCostModel,
  observation: CacheObservation | undefined,
  now = Date.now(),
): SwitchDecision {
  if (!observation || observation.cacheRead <= 0) return { action: "switch", reason: "no measured cache reuse" };
  if (!validTokens(observation.input) || !validTokens(observation.cacheRead) ||
      !validTokens(observation.cacheWrite) || !validTokens(observation.output) ||
      observation.at > now || now - observation.at > MAX_CACHE_AGE_MS) {
    return { action: "switch", reason: "invalid or stale cache observation" };
  }
  const a = current.cost, b = target.cost;
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
