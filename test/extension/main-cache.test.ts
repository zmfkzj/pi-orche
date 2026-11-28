import { describe, expect, it } from "vitest";
import { DEFAULT_FALLBACK_TTL_MINUTES, DEFAULT_MAIN_CACHE, keepalivePlan, MIN_AUTO_KEEPALIVE_MS, parseMainCacheConfig, warmingOverride, type KeepaliveInputs, type MainCacheSettings } from "../../src/extension/main-cache.js";
import { loadOrcheConfigFile } from "../../src/extension/config.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Main's prompt cache while an orche task runs (src/extension/main-cache.ts): the `mainCache` config, the cache_warming_decision
 * override for models without prices, and when an attached wait is released by a keepalive.
 */
const MIN = 60_000;
const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const claude = (cost = free, promptCache: Record<string, number> | undefined = { short: 3600, long: 3600 }) =>
  ({ provider: "cliproxyapi", id: "bts/claude-opus-5-5", api: "anthropic-messages", cost, ...(promptCache ? { promptCache } : {}), compat: { forceAdaptiveThinking: true } }) as never;
const gemini = { provider: "cliproxyapi", id: "gemini-4-neon-xhigh", api: "openai-completions", cost: free } as never;
const settings = (over: Partial<MainCacheSettings> = {}): MainCacheSettings => ({ ...DEFAULT_MAIN_CACHE, assumedTtlMinutes: {}, ...over });
const plan = (over: Partial<KeepaliveInputs>) => keepalivePlan({ model: claude(), settings: settings(), warmingMode: "idle", thinking: "high", promptTokens: 200_000, jobRunning: true, ...over });

describe("mainCache config", () => {
  it("defaults to warming on, auto keepalive and a 40-minute fallback lifetime; false turns all off; true is the defaults", () => {
    expect(DEFAULT_FALLBACK_TTL_MINUTES).toBe(40);
    expect(DEFAULT_MAIN_CACHE).toEqual({ warming: true, keepalive: "auto", assumedTtlMinutes: {}, fallbackTtlMinutes: 40 });
    expect(parseMainCacheConfig(false)).toEqual({ warming: false, keepalive: false, assumedTtlMinutes: {}, fallbackTtlMinutes: false });
    expect(parseMainCacheConfig(true)).toEqual({ warming: true, keepalive: "auto", assumedTtlMinutes: {}, fallbackTtlMinutes: 40 });
    expect(parseMainCacheConfig({ warming: false, keepalive: 45, assumedTtlMinutes: { "gemini-4-neon-*": 40 }, fallbackTtlMinutes: false })).toEqual({ warming: false, keepalive: 45, assumedTtlMinutes: { "gemini-4-neon-*": 40 }, fallbackTtlMinutes: false });
    expect(parseMainCacheConfig({ keepalive: false })).toEqual({ warming: true, keepalive: false, assumedTtlMinutes: {}, fallbackTtlMinutes: 40 });
    expect(parseMainCacheConfig({ fallbackTtlMinutes: 25 })).toMatchObject({ fallbackTtlMinutes: 25 });
  });

  it("rejects unknown fields and bad values", () => {
    expect(() => parseMainCacheConfig({ ttl: 5 })).toThrow(/unknown field ttl/);
    expect(() => parseMainCacheConfig({ warming: "yes" })).toThrow(/warming: expected boolean/);
    expect(() => parseMainCacheConfig({ keepalive: 0 })).toThrow(/keepalive/);
    expect(() => parseMainCacheConfig({ keepalive: "on" })).toThrow(/keepalive/);
    expect(() => parseMainCacheConfig({ assumedTtlMinutes: { "gemini-*": -1 } })).toThrow(/assumedTtlMinutes\.gemini-\*/);
    expect(() => parseMainCacheConfig({ assumedTtlMinutes: [] })).toThrow(/assumedTtlMinutes/);
    expect(() => parseMainCacheConfig(3)).toThrow(/expected false, true or an object/);
    for (const bad of [0, -5, true, "40", 2000]) expect(() => parseMainCacheConfig({ fallbackTtlMinutes: bad })).toThrow(/fallbackTtlMinutes/);
  });

  it("loads from orche.config.json next to the other settings (default when absent, an error for a bad value)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-main-cache-"));
    try {
      const path = join(dir, "orche.config.json");
      await writeFile(path, JSON.stringify({ routes: {}, default: { model: "p/m" } }));
      expect((await loadOrcheConfigFile(path)).mainCache).toEqual({ warming: true, keepalive: "auto", assumedTtlMinutes: {}, fallbackTtlMinutes: 40 });
      await writeFile(path, JSON.stringify({ routes: {}, default: { model: "p/m" }, mainCache: { keepalive: 30, assumedTtlMinutes: { "cliproxyapi/gemini-*": 40 } } }));
      expect((await loadOrcheConfigFile(path)).mainCache).toEqual({ warming: true, keepalive: 30, assumedTtlMinutes: { "cliproxyapi/gemini-*": 40 }, fallbackTtlMinutes: 40 });
      await writeFile(path, JSON.stringify({ routes: {}, default: { model: "p/m" }, mainCache: { keepalive: -2 } }));
      await expect(loadOrcheConfigFile(path)).rejects.toThrow(/mainCache\.keepalive/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("cache_warming_decision override", () => {
  const stop = { action: "stop" as const };
  it("turns every stop into warm while a background job runs and warming is on, whatever the model's prices", () => {
    expect(warmingOverride(stop, true, { warming: true })).toEqual({ action: "warm" });
    expect(warmingOverride(stop, false, { warming: true })).toBeUndefined();
    expect(warmingOverride(stop, true, { warming: false })).toBeUndefined();
  });

  it("leaves a warm decision alone", () => {
    expect(warmingOverride({ action: "warm" }, true, { warming: true })).toBeUndefined();
  });
});

describe("keepalive plan", () => {
  it("1h TTL that Pi keeps warming (unpriced with the override): after the warmer's 60-minute window, before the last warm's entry expires", () => {
    // Pi warms at 54 min (90% of 60) and stops before 108 > 60: the entry lives until 114 min; 5 min margin.
    expect(plan({})).toEqual({ delayMs: 109 * MIN, basis: "warmer-window", ttlMs: 60 * MIN });
    // A priced model whose refresh pays (200k tokens of Opus) is warmed by Pi itself: same window.
    expect(plan({ model: claude(opus) })).toEqual({ delayMs: 109 * MIN, basis: "warmer-window", ttlMs: 60 * MIN });
  });

  it("5-minute TTL: Pi's warms every 4.5 minutes cover about an hour; keepalive at 58 minutes", () => {
    const p = plan({ model: claude(opus, { short: 300 }) });
    expect(p).toMatchObject({ basis: "warmer-window", ttlMs: 5 * MIN });
    // 12 warms (54 min, drift allowance) + 5 min lifetime - 1 min margin.
    expect(p!.delayMs).toBe(54 * MIN + 5 * MIN - MIN);
  });

  it("Pi cannot warm (warming off, override off for an unpriced model, budget thinking): one lifetime minus the margin", () => {
    expect(plan({ warmingMode: "off" })).toEqual({ delayMs: 55 * MIN, basis: "ttl", ttlMs: 60 * MIN });
    expect(plan({ settings: settings({ warming: false }) })).toEqual({ delayMs: 55 * MIN, basis: "ttl", ttlMs: 60 * MIN });
    const budget = { provider: "anthropic", id: "claude-x", api: "anthropic-messages", cost: opus, promptCache: { short: 3600 } } as never;
    expect(plan({ model: budget })).toEqual({ delayMs: 55 * MIN, basis: "ttl", ttlMs: 60 * MIN });
  });

  it("a priced model Pi would stop for economics: the override keeps Pi warming (warmer window); with the override off, no keepalive", () => {
    expect(plan({ model: claude(opus), promptTokens: 2_000 })).toEqual({ delayMs: 109 * MIN, basis: "warmer-window", ttlMs: 60 * MIN });
    expect(plan({ model: claude(opus), promptTokens: 0 })).toEqual({ delayMs: 109 * MIN, basis: "warmer-window", ttlMs: 60 * MIN });
    expect(plan({ model: claude(opus), promptTokens: 2_000, settings: settings({ warming: false }) })).toBeUndefined();
    expect(plan({ model: claude(opus), promptTokens: 2_000, jobRunning: false })).toBeUndefined();
    // Override off but Pi's own economics warm (a large prompt): the warmer window.
    expect(plan({ model: claude(opus), settings: settings({ warming: false }) })).toMatchObject({ basis: "warmer-window" });
  });

  it("no keepalive below the 10-minute floor", () => {
    expect(plan({ model: claude(free, { short: 300 }), warmingMode: "off" })).toBeUndefined();
    expect(MIN_AUTO_KEEPALIVE_MS).toBe(10 * MIN);
  });

  it("a model without promptCache: the first matching assumedTtlMinutes key, else the 40-minute fallback (36-minute release), unless it is false", () => {
    expect(plan({ model: gemini })).toEqual({ delayMs: 36 * MIN, basis: "fallback-ttl", ttlMs: 40 * MIN });
    expect(plan({ model: gemini, settings: settings({ fallbackTtlMinutes: 25 }) })).toEqual({ delayMs: 22.5 * MIN, basis: "fallback-ttl", ttlMs: 25 * MIN });
    expect(plan({ model: gemini, settings: settings({ fallbackTtlMinutes: false }) })).toBeUndefined();
    expect(plan({ model: gemini, settings: settings({ fallbackTtlMinutes: 8 }) })).toBeUndefined();
    expect(plan({ model: gemini, settings: settings({ assumedTtlMinutes: { "gemini-4-neon-*": 20, "*": 60 } }) })).toEqual({ delayMs: 18 * MIN, basis: "assumed-ttl", ttlMs: 20 * MIN });
    expect(plan({ model: gemini, settings: settings({ assumedTtlMinutes: { "claude-*": 20, "*": 60 } }) })).toEqual({ delayMs: 55 * MIN, basis: "assumed-ttl", ttlMs: 60 * MIN });
    // A declared promptCache wins over assumptions and the fallback.
    expect(plan({ settings: settings({ assumedTtlMinutes: { "*": 20 }, fallbackTtlMinutes: 10 }) })).toMatchObject({ basis: "warmer-window", ttlMs: 60 * MIN });
    expect(plan({ model: gemini, settings: settings({ assumedTtlMinutes: { "cliproxyapi/gemini-4-*": 40 } }) })).toEqual({ delayMs: 36 * MIN, basis: "assumed-ttl", ttlMs: 40 * MIN });
    expect(plan({ model: gemini, settings: settings({ assumedTtlMinutes: { "gemini-4-neon-xhigh": 40 } }) })).toMatchObject({ basis: "assumed-ttl" });
    expect(plan({ model: gemini, settings: settings({ assumedTtlMinutes: { "claude-*": 40 } }) })).toMatchObject({ basis: "fallback-ttl" });
    // Gemini with the cliproxyapi overlay's declared 40-minute lifetime (zero prices, warmed by the override): Pi warms at 36 min, then 76 > 58 stops; entry lives to 76, 4 min margin.
    expect(plan({ model: { ...(gemini as object), promptCache: { short: 2400, long: 2400 } } as never })).toEqual({ delayMs: 72 * MIN, basis: "warmer-window", ttlMs: 40 * MIN });
  });

  it("a configured interval is used as it is for every model; false and no model mean none", () => {
    expect(plan({ model: gemini, settings: settings({ keepalive: 30 }) })).toEqual({ delayMs: 30 * MIN, basis: "configured" });
    expect(plan({ settings: settings({ keepalive: false }) })).toBeUndefined();
    expect(plan({ model: undefined })).toBeUndefined();
  });
});
