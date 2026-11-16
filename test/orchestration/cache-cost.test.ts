import { describe, expect, it } from "vitest";
import {
  compareCachedModelSwitch, MAX_CACHE_AGE_MS, type CacheCostModel, type CacheObservation,
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
