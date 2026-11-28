/**
 * Main's prompt cache while an orche task runs (`mainCache` in orche.config.json; docs/main-cache.md).
 *
 * While main waits for a worker it sends no request of its own, so its prompt cache entry ages out: Pi's built-in CacheWarmer
 * (pi-coding-agent `core/cache-warmer.ts`, numbers in pi-ai `cache-warming.ts`) refreshes it with a one-token replay of main's last
 * request at 90% of the model's `promptCache` TTL, but only for 60 minutes after the real request that started it, and only while
 * its economics say a refresh pays (`expectedSavings >= $0.05`), which a model priced at 0 (subscription routes) never does.
 *
 * Two levers, both main-session only:
 * - `warming` (default on): while an orche background job runs, every `cache_warming_decision` that Pi resolved to `stop` (a model
 *   without prices, or a priced one whose refresh Pi found below its $0.05 savings threshold) is turned into `warm`. Prices are never
 *   faked (cost display unchanged). Without a running background job Pi's decision stands.
 * - `keepalive` (default "auto"): an attached orche_task / orche_task_attach wait is released on schedule (detach reason
 *   `keepalive`) shortly before main's cache would expire, so main's next request (re-attaching) reads and refreshes the cache and
 *   starts a new CacheWarmer window. "auto" schedules it after what the CacheWarmer covers (or from an assumed lifetime for models
 *   that declare none); a number is a fixed interval.
 */
import {
  CACHE_WARMING_MAX_AGE_MS,
  evaluateCacheWarming,
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  isCacheWarmingReplayable,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";

export interface MainCacheSettings {
  /** Turn Pi's `stop` warming decisions into `warm` while an orche background job runs (`cache_warming_decision`). */
  warming: boolean;
  /** Keepalive detach of attached waits: "auto" (from the model's cache lifetime and Pi's warming), off, or a fixed interval in minutes. */
  keepalive: "auto" | false | number;
  /**
   * Cache lifetime in minutes to assume for models that declare no `promptCache` (Pi cannot warm them), by `provider/id` or `id`,
   * `*` matching any characters; the first matching key wins. Used by "auto" keepalive only.
   */
  assumedTtlMinutes: Record<string, number>;
  /**
   * Lifetime in minutes assumed for a model with neither `promptCache` nor a matching `assumedTtlMinutes` key ("auto" keepalive
   * only); `false`: no keepalive for such models. Default {@link DEFAULT_FALLBACK_TTL_MINUTES}.
   */
  fallbackTtlMinutes: number | false;
}

/**
 * Default `fallbackTtlMinutes`: CLIProxyAPI's Gemini routes kept about 96% of their cache up to 45 minutes and lost it at 45-50 minutes
 * (docs/main-cache.md), so 40 minutes, a keepalive every 36, keeps an unknown cache that behaves like them warm.
 */
export const DEFAULT_FALLBACK_TTL_MINUTES = 40;

export const DEFAULT_MAIN_CACHE: Readonly<MainCacheSettings> = Object.freeze({ warming: true, keepalive: "auto", assumedTtlMinutes: Object.freeze({}) as Record<string, number>, fallbackTtlMinutes: DEFAULT_FALLBACK_TTL_MINUTES });

/** A fresh copy of the defaults (the frozen map must not be shared). */
export const defaultMainCache = (): MainCacheSettings => ({ ...DEFAULT_MAIN_CACHE, assumedTtlMinutes: {} });

/** "auto" never releases a wait more often than this: each keepalive costs main a full request, which Pi's one-token warms avoid for short lifetimes. */
export const MIN_AUTO_KEEPALIVE_MS = 10 * 60_000;
/** Pi schedules each warm after the previous one has returned, so its warms drift late; "auto" assumes the last one lands this much earlier in the window. */
const WARM_DRIFT_MS = 2 * 60_000;

/** Bounds of a keepalive interval (minutes) in the config: a positive number up to a day. */
const MAX_KEEPALIVE_MINUTES = 24 * 60;

/**
 * `mainCache` in orche.config.json: `false` (all off), `true` (defaults), or an object with `warming`, `keepalive`
 * (`"auto"`, `false` or minutes), `assumedTtlMinutes` and `fallbackTtlMinutes` (minutes or `false`).
 */
export function parseMainCacheConfig(value: unknown): MainCacheSettings {
  if (value === false) return { warming: false, keepalive: false, assumedTtlMinutes: {}, fallbackTtlMinutes: false };
  if (value === true) return defaultMainCache();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.mainCache: expected false, true or an object");
  const settings = value as Record<string, unknown>;
  const unknown = Object.keys(settings).filter(key => !["warming", "keepalive", "assumedTtlMinutes", "fallbackTtlMinutes"].includes(key));
  if (unknown.length) throw new Error(`config.mainCache: unknown field ${unknown.join(", ")}`);
  if (settings.warming !== undefined && typeof settings.warming !== "boolean") throw new Error("config.mainCache.warming: expected boolean");
  const keepalive = settings.keepalive;
  if (keepalive !== undefined && keepalive !== "auto" && keepalive !== false && !(typeof keepalive === "number" && Number.isFinite(keepalive) && keepalive > 0 && keepalive <= MAX_KEEPALIVE_MINUTES)) {
    throw new Error(`config.mainCache.keepalive: expected "auto", false or minutes (0 < n <= ${MAX_KEEPALIVE_MINUTES})`);
  }
  const assumed: Record<string, number> = {};
  if (settings.assumedTtlMinutes !== undefined) {
    const map = settings.assumedTtlMinutes;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("config.mainCache.assumedTtlMinutes: expected an object of model pattern -> minutes");
    for (const [pattern, minutes] of Object.entries(map)) {
      if (!pattern.trim()) throw new Error("config.mainCache.assumedTtlMinutes: empty model pattern");
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_KEEPALIVE_MINUTES) throw new Error(`config.mainCache.assumedTtlMinutes.${pattern}: expected minutes (0 < n <= ${MAX_KEEPALIVE_MINUTES})`);
      assumed[pattern] = minutes;
    }
  }
  const fallback = settings.fallbackTtlMinutes;
  if (fallback !== undefined && fallback !== false && !(typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0 && fallback <= MAX_KEEPALIVE_MINUTES)) {
    throw new Error(`config.mainCache.fallbackTtlMinutes: expected false or minutes (0 < n <= ${MAX_KEEPALIVE_MINUTES})`);
  }
  return {
    warming: (settings.warming as boolean | undefined) ?? DEFAULT_MAIN_CACHE.warming,
    keepalive: (keepalive as MainCacheSettings["keepalive"] | undefined) ?? DEFAULT_MAIN_CACHE.keepalive,
    assumedTtlMinutes: assumed,
    fallbackTtlMinutes: (fallback as number | false | undefined) ?? DEFAULT_MAIN_CACHE.fallbackTtlMinutes,
  };
}

type CacheModel = Pick<Model<Api>, "provider" | "id" | "api" | "cost"> & Partial<Pick<Model<Api>, "promptCache" | "compat">>;

/** A model without any price (subscription routes registered at 0, or no cost at all): Pi cannot weigh a refresh for it. */
export function hasNoPricing(model: CacheModel | undefined): boolean {
  const cost = model?.cost as Partial<Model<Api>["cost"]> | undefined;
  if (!cost) return true;
  return !(cost.input || cost.output || cost.cacheRead || cost.cacheWrite);
}

/**
 * The `cache_warming_decision` override: `warm` whenever Pi resolved a refresh to `stop` while an orche background job runs and
 * `warming` is on, whatever the model's prices (none, or a refresh below Pi's savings threshold); nothing (Pi's decision stands)
 * otherwise. Pi only asks when warming is on, the model declares a lifetime and the request can be replayed.
 */
export function warmingOverride(event: { action: "warm" | "stop" }, jobRunning: boolean, settings: Pick<MainCacheSettings, "warming">): { action: "warm" } | undefined {
  if (!settings.warming || !jobRunning || event.action !== "stop") return undefined;
  return { action: "warm" };
}

/** `*`-glob match of a config key against `provider/id` or `id`. */
function matches(pattern: string, model: CacheModel): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return regex.test(`${model.provider}/${model.id}`) || regex.test(model.id);
}

export function assumedTtlMs(model: CacheModel, settings: Pick<MainCacheSettings, "assumedTtlMinutes">): number | undefined {
  for (const [pattern, minutes] of Object.entries(settings.assumedTtlMinutes)) if (matches(pattern, model)) return minutes * 60_000;
  return undefined;
}

export interface KeepalivePlan {
  /** Time from main's last request (the turn that started the wait) to the keepalive detach. */
  delayMs: number;
  /** Why this interval: for tests and the tool's details. */
  basis: "configured" | "warmer-window" | "ttl" | "assumed-ttl" | "fallback-ttl";
  /** The cache lifetime it was computed from, when known. */
  ttlMs?: number;
}

export interface KeepaliveInputs {
  model: CacheModel | undefined;
  settings: MainCacheSettings;
  /** Pi's `cacheWarming` setting (`off` | `streaming` | `idle`; Pi's default is idle). */
  warmingMode: string | undefined;
  /** Main's thinking level: Anthropic budget thinking cannot be replayed. */
  thinking: string | undefined;
  /** Main's last prompt size in tokens (Pi's economics); 0 when unknown. */
  promptTokens: number;
  /** Whether an orche background job runs (the `warming` override applies). */
  jobRunning: boolean;
}

/** Margin before the cache's expiry at which keepalive fires: 10% of the lifetime, between 1 and 5 minutes. */
const marginMs = (ttlMs: number) => Math.min(5 * 60_000, Math.max(60_000, Math.floor(ttlMs * 0.1)));

/**
 * When an attached wait should be released so that main refreshes its cache, measured from main's last request; undefined: no
 * keepalive. "auto":
 * - the model declares a cache lifetime and Pi's CacheWarmer will keep refreshing it (warming on, replayable request, and either the
 *   `warming` override during a background job or Pi's own economics saying `warm`): after the CacheWarmer's 60-minute window, i.e.
 *   its last warm plus one lifetime, minus a margin (1h TTL: 109 minutes; 40m: 72; 5m: 58);
 * - it declares a lifetime but Pi will not warm it: one lifetime minus the margin, unless the override is off and Pi stops for a
 *   priced model's economics (then a full request is not worth it either);
 * - no declared lifetime: `assumedTtlMinutes` (first matching key), else `fallbackTtlMinutes`, minus the margin; nothing when the
 *   fallback is `false`.
 * Intervals below {@link MIN_AUTO_KEEPALIVE_MS} are skipped. A configured number is used as it is.
 */
export function keepalivePlan(inputs: KeepaliveInputs): KeepalivePlan | undefined {
  const { model, settings } = inputs;
  if (settings.keepalive === false) return undefined;
  if (typeof settings.keepalive === "number") return { delayMs: Math.round(settings.keepalive * 60_000), basis: "configured" };
  if (!model) return undefined;
  const auto = (delayMs: number, basis: KeepalivePlan["basis"], ttlMs: number): KeepalivePlan | undefined => delayMs >= MIN_AUTO_KEEPALIVE_MS ? { delayMs, basis, ttlMs } : undefined;
  let ttlMs: number | undefined;
  try { ttlMs = getPromptCacheTtlMs(model as Model<Api>, undefined); } catch { ttlMs = undefined; }
  if (ttlMs === undefined) {
    const assumed = assumedTtlMs(model, settings);
    if (assumed !== undefined) return auto(assumed - marginMs(assumed), "assumed-ttl", assumed);
    if (settings.fallbackTtlMinutes === false) return undefined;
    const fallback = settings.fallbackTtlMinutes * 60_000;
    return auto(fallback - marginMs(fallback), "fallback-ttl", fallback);
  }
  const delay = getCacheWarmingDelayMs(ttlMs);
  const replayable = isCacheWarmingReplayable(model as Model<Api>, inputs.thinking && inputs.thinking !== "off" ? { reasoning: inputs.thinking as never } : undefined);
  const warmingOn = inputs.warmingMode !== "off" && delay !== undefined && replayable;
  if (warmingOn) {
    const overridden = settings.warming && inputs.jobRunning;
    let economics: ReturnType<typeof evaluateCacheWarming> | undefined;
    try { economics = evaluateCacheWarming(model as Model<Api>, Math.max(0, inputs.promptTokens), "streaming"); } catch { economics = undefined; }
    if (overridden || economics?.action === "warm") {
      const warms = Math.max(0, Math.floor((CACHE_WARMING_MAX_AGE_MS - WARM_DRIFT_MS) / delay!));
      return auto(warms * delay! + ttlMs - marginMs(ttlMs), "warmer-window", ttlMs);
    }
    // Override off, and Pi weighed a refresh of a priced model and found it not worth $0.05: a full main request is not worth it either.
    if (economics?.economicsAvailable) return undefined;
  }
  return auto(ttlMs - marginMs(ttlMs), "ttl", ttlMs);
}
