import { describe, expect, it } from "vitest";
import {
  cacheAgeLimitMs, compareCachedModelSwitch, MAX_CACHE_AGE_MS, OPENAI_EXTENDED_CACHE_AGE_MS, type CacheCostModel, type CacheObservation,
} from "../../src/orchestration/cache-cost.js";

const current: CacheCostModel = { cost: { input: 12, output: 60, cacheRead: 1.2, cacheWrite: 15 } };
const cheap: CacheCostModel = { cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } };
const veryCheap: CacheCostModel = { cost: { input: 0.4, output: 2, cacheRead: 0.04, cacheWrite: 0.5 } };
const now = 100_000_000;
const warm: CacheObservation = { model: "cliproxyapi/claude-opus-5-5", at: now - 1000, input: 3000, cacheRead: 100_000, cacheWrite: 0, output: 1000 };

describe("model switch versus cache reuse", () => {
  it("retains a warm expensive model when its cached prefix beats a cheaper cold model", () => {
    const d = compareCachedModelSwitch(current, cheap, warm, now);
    expect(d.action).toBe("keep");
    if (d.action === "keep") expect(d.keepUSD).toBeLessThan(d.switchUSD);
  });

  it("switches when candidate's cold input and output are cheaper", () => {
    const d = compareCachedModelSwitch(current, veryCheap, warm, now);
    expect(d.action).toBe("switch");
    expect(d.keepUSD).toBeGreaterThan(d.switchUSD ?? 0);
  });

  it("uses long-context catalog price tiers instead of a misleading base rate", () => {
    const tiered: CacheCostModel = { cost: {
      input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 50_000, input: 40, output: 60, cacheRead: 10, cacheWrite: 42 }],
    } };
    const d = compareCachedModelSwitch(tiered, cheap, warm, now);
    expect(d.action).toBe("switch");
  });

  it("uses the observed cache-write usage at the current model's write price", () => {
    const a: CacheCostModel = { cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 100 } };
    const b: CacheCostModel = { cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } };
    const d = compareCachedModelSwitch(a, b, { ...warm, cacheRead: 10, cacheWrite: 100_000, input: 50 }, now);
    expect(d.action).toBe("switch");
  });

  it("does not claim a cache discount without observed cached input", () => {
    expect(compareCachedModelSwitch(current, cheap, { ...warm, cacheRead: 0 }, now).action).toBe("switch");
    expect(compareCachedModelSwitch(current, cheap, undefined, now).action).toBe("switch");
  });

  it("declines to rely on expired, future or corrupt telemetry", () => {
    expect(compareCachedModelSwitch(current, cheap, { ...warm, at: now - MAX_CACHE_AGE_MS - 1 }, now).action).toBe("switch");
    expect(compareCachedModelSwitch(current, cheap, { ...warm, at: now + 1 }, now).action).toBe("switch");
    expect(compareCachedModelSwitch(current, cheap, { ...warm, input: NaN }, now).action).toBe("switch");
  });

  it("does not make a financial switch decision with unknown or fabricated zero catalog prices", () => {
    expect(compareCachedModelSwitch(current, { cost: { input: 0, output: 0, cacheRead: 0 } }, warm, now).action).toBe("switch");
    expect(compareCachedModelSwitch({ cost: { input: 12, output: 60, cacheRead: 12 } }, cheap, warm, now).action).toBe("switch");
  });

  it("accounts for candidate cache-write premiums rather than assuming every cold token costs input price", () => {
    const normal = compareCachedModelSwitch(current, { cost: { input: 0.5, output: 1, cacheRead: 0.1 } }, warm, now);
    const premium = compareCachedModelSwitch(current, { cost: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 30 } }, warm, now);
    expect(normal.action).toBe("switch");
    expect(premium.action).toBe("keep");
  });
});

describe("cache age limit of the warm model", () => {
  const minutes = (count: number) => count * 60_000;
  const gpt = (id: string, api = "openai-responses"): CacheCostModel => ({ ...current, id, api });
  const claude: CacheCostModel = { ...current, id: "claude-opus-5-5", api: "anthropic-messages" };

  it("keeps the conservative short limit for Claude, older GPT, unknown and price-only models", () => {
    expect(MAX_CACHE_AGE_MS).toBe(minutes(4));
    for (const model of [claude, gpt("gpt-5.5"), gpt("gpt-5.4-mini"), gpt("gpt-4o"), gpt("gpt-5"), gpt("o3"), gpt("gpt-5.6.1"), current, { ...current, id: "some-model" }]) {
      expect(cacheAgeLimitMs(model)).toBe(MAX_CACHE_AGE_MS);
    }
    // A GPT id on a non-OpenAI API is not assumed to have OpenAI's cache lifetime.
    expect(cacheAgeLimitMs(gpt("gpt-5.6", "anthropic-messages"))).toBe(MAX_CACHE_AGE_MS);
  });

  it("gives GPT-5.6+ and GPT-6+ on OpenAI APIs (native, Codex, CLIProxyAPI, route-prefixed ids) their documented 30-minute minimum TTL as the limit", () => {
    expect(OPENAI_EXTENDED_CACHE_AGE_MS).toBe(minutes(30));
    for (const model of [gpt("gpt-5.6"), gpt("gpt-5.6-sol"), gpt("gpt-5.10"), gpt("gpt-6"), gpt("gpt-6.2-codex", "openai-codex-responses"),
      gpt("GPT-6.1-terra", "azure-openai-responses"), gpt("gpt-5.7", "openai-completions"), gpt("openai/gpt-6.2-sol"), { ...current, id: "gpt-6.1" }]) {
      expect(cacheAgeLimitMs(model)).toBe(OPENAI_EXTENDED_CACHE_AGE_MS);
    }
  });

  it("a warm GPT-5.6+/GPT-6 prefix still counts after 4 minutes, until the extended limit", () => {
    for (const warmModel of [gpt("gpt-5.6-sol"), gpt("gpt-6.2-codex", "openai-codex-responses")]) {
      const at = (age: number): CacheObservation => ({ ...warm, model: "cliproxyapi/" + warmModel.id, at: now - age });
      const keep = compareCachedModelSwitch(warmModel, cheap, at(minutes(10)), now);
      expect(keep.action).toBe("keep");
      expect(compareCachedModelSwitch(warmModel, cheap, at(minutes(29)), now).action).toBe("keep");
      expect(compareCachedModelSwitch(warmModel, cheap, at(minutes(30)), now).action).toBe("keep");
      expect(compareCachedModelSwitch(warmModel, cheap, at(minutes(30) + 1), now)).toMatchObject({ action: "switch", reason: "invalid or stale cache observation" });
    }
  });

  it("the limit follows the warm (current) model, not the target: Claude and older GPT stay short even when switching to GPT-6", () => {
    const old = { ...warm, at: now - minutes(10) };
    expect(compareCachedModelSwitch(claude, gpt("gpt-6.2-sol"), old, now)).toMatchObject({ action: "switch", reason: "invalid or stale cache observation" });
    expect(compareCachedModelSwitch(gpt("gpt-5.5"), gpt("gpt-6.2-sol"), old, now)).toMatchObject({ action: "switch", reason: "invalid or stale cache observation" });
    expect(compareCachedModelSwitch(claude, cheap, { ...warm, at: now - MAX_CACHE_AGE_MS }, now).action).toBe("keep");
  });

  it("the extended limit relaxes only the age: future, non-finite and corrupt telemetry and missing cache reads still switch", () => {
    const model = gpt("gpt-6.2-sol");
    expect(compareCachedModelSwitch(model, cheap, { ...warm, at: now + 1 }, now).action).toBe("switch");
    expect(compareCachedModelSwitch(model, cheap, { ...warm, at: Number.NaN }, now).action).toBe("switch");
    expect(compareCachedModelSwitch(model, cheap, { ...warm, cacheWrite: Number.POSITIVE_INFINITY }, now).action).toBe("switch");
    expect(compareCachedModelSwitch(model, cheap, { ...warm, cacheRead: 0, at: now - minutes(10) }, now)).toMatchObject({ action: "switch", reason: "no measured cache reuse" });
    expect(compareCachedModelSwitch({ id: "gpt-6.2-sol", api: "openai-responses", cost: { input: 12, output: 60, cacheRead: 12 } }, cheap, { ...warm, at: now - minutes(10) }, now)).toMatchObject({ action: "switch", reason: "incomplete or non-beneficial cache pricing" });
  });
});
