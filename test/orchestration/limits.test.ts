import { describe, expect, it } from "vitest";
import { defaultRunLimits, parseRunLimits, resolveRunLimits, type RunLimits } from "../../src/orchestration/limits.js";
import { DEFAULT_LIVENESS_WINDOW_MS } from "../../src/agent/liveness.js";
import { parseRouteConfig, RouteConfigError } from "../../src/orchestration/routing.js";
import { defaultRunLimits as exportedDefaults, runOrchestrated } from "../../src/orchestration/coordinator.js";
import { runBaseline } from "../../src/eval/baseline.js";
import { ExtendableDeadline } from "../../src/orchestration/run/extension.js";

const invalid = [null, [], 42, "3600000", { typo: 1 }, { overallMs: "1" }, { overallMs: NaN }, { overallMs: Infinity }, { explorationMs: -1 }, { assignmentMs: null }, { decisionMs: false }, { maxFixRounds: 0.5 }, { decisionRepairs: 3 }, { decisionRepairs: 1.5 }, { assignmentRequests: 1.5 }, { assignmentRequests: Number.MAX_SAFE_INTEGER + 1 }, { overallMs: undefined },
  // The extension keys are validated like the others: finite non-negative numbers, `maxExtensions` an integer.
  { extensionMs: -1 }, { extensionMs: "1800000" }, { extensionMs: NaN }, { extensionMs: Infinity }, { extensionMs: null }, { extensionMs: undefined },
  { maxExtensions: -1 }, { maxExtensions: 1.5 }, { maxExtensions: "3" }, { maxExtensions: Infinity }, { maxExtensions: NaN }, { maxExtensions: Number.MAX_SAFE_INTEGER + 1 }, { maxExtensions: true },
  { activityWindowMs: -1 }, { activityWindowMs: "120000" }, { activityWindowMs: NaN }, { activityWindowMs: Infinity }, { activityWindowMs: undefined },
  { extensions: 3 }, { extensionMS: 1 }];

describe("run limits", () => {
  it("defaults to thirty minutes (base) with ten 30-minute extensions (a 5h30m ceiling) and retains compatible exports", () => {
    expect(resolveRunLimits()).toEqual({
      overallMs: 1800000, explorationMs: 600000, assignmentMs: 1800000, decisionMs: 900000, maxFixRounds: 1, decisionRepairs: 2, assignmentRequests: 150,
      extensionMs: 1800000, maxExtensions: 10, activityWindowMs: DEFAULT_LIVENESS_WINDOW_MS,
    });
    expect(defaultRunLimits).toMatchObject({ overallMs: 1_800_000, extensionMs: 1_800_000, maxExtensions: 10, activityWindowMs: 120_000 });
    // The default hard ceiling: overallMs + maxExtensions × extensionMs = 30 min + 10 × 30 min = 5 h 30 min.
    expect(ExtendableDeadline.fromLimits(resolveRunLimits()).hardLimitMs).toBe(19_800_000);
    expect(ExtendableDeadline.fromLimits(resolveRunLimits({ maxExtensions: 5, extensionMs: 600_000 })).hardLimitMs).toBe(1_800_000 + 5 * 600_000);
    // The default phase caps are the ones derived from the default base overall cap.
    expect(resolveRunLimits()).toEqual({ ...defaultRunLimits, explorationMs: defaultRunLimits.overallMs / 3, assignmentMs: defaultRunLimits.overallMs, decisionMs: defaultRunLimits.overallMs / 2 });
    expect(exportedDefaults).toBe(defaultRunLimits);
  });

  it("merges explicit config and API limits before deriving missing phase caps", () => {
    expect(resolveRunLimits({ overallMs: 120000 })).toMatchObject({ overallMs: 120000, explorationMs: 40000, assignmentMs: 120000, decisionMs: 60000 });
    expect(resolveRunLimits({ overallMs: 120000, decisionMs: 45000 }, { overallMs: 900000 })).toMatchObject({ overallMs: 900000, explorationMs: 300000, assignmentMs: 900000, decisionMs: 45000 });
    expect(resolveRunLimits({ decisionMs: 45000 }, { decisionMs: 1234 })).toMatchObject({ overallMs: 1800000, explorationMs: 600000, assignmentMs: 1800000, decisionMs: 1234 });
    expect(resolveRunLimits({ decisionMs: 45000 })).toMatchObject({ overallMs: 1800000, explorationMs: 600000, assignmentMs: 1800000, decisionMs: 45000 });
    expect(resolveRunLimits({ explorationMs: 1, assignmentMs: 2, maxFixRounds: 0, assignmentRequests: 0 }, { overallMs: 30, decisionRepairs: 1 })).toMatchObject({ explorationMs: 1, assignmentMs: 2, decisionMs: 15, maxFixRounds: 0, assignmentRequests: 0, decisionRepairs: 1 });
  });

  it("accepts finite fractional times and zero without treating it as unlimited", () => {
    expect(resolveRunLimits({ overallMs: 0 })).toMatchObject({ overallMs: 0, explorationMs: 0, assignmentMs: 0, decisionMs: 0 });
    expect(parseRunLimits({ overallMs: 1.5, decisionRepairs: 0, assignmentRequests: 0 })).toEqual({ overallMs: 1.5, decisionRepairs: 0, assignmentRequests: 0 });
  });

  it("accepts the extension keys (zero disables, fractional times are allowed) and derives the phase caps from the base overall only", () => {
    expect(parseRunLimits({ extensionMs: 60_000, maxExtensions: 2, activityWindowMs: 30_000 })).toEqual({ extensionMs: 60_000, maxExtensions: 2, activityWindowMs: 30_000 });
    expect(parseRunLimits({ maxExtensions: 0, extensionMs: 0, activityWindowMs: 0 })).toEqual({ maxExtensions: 0, extensionMs: 0, activityWindowMs: 0 });
    expect(parseRunLimits({ extensionMs: 1.5, activityWindowMs: 0.5 })).toEqual({ extensionMs: 1.5, activityWindowMs: 0.5 });
    // Defaults < config < API, per key.
    expect(resolveRunLimits({ maxExtensions: 1, extensionMs: 5 }, { maxExtensions: 0 })).toMatchObject({ maxExtensions: 0, extensionMs: 5, activityWindowMs: DEFAULT_LIVENESS_WINDOW_MS });
    // Extending never changes the derived caps: they come from the BASE overall cap.
    expect(resolveRunLimits({ overallMs: 90_000, extensionMs: 1_000_000, maxExtensions: 9 })).toMatchObject({ overallMs: 90_000, explorationMs: 30_000, assignmentMs: 90_000, decisionMs: 45_000, extensionMs: 1_000_000, maxExtensions: 9 });
  });

  it("names the offending extension key and what it expects", () => {
    expect(() => parseRouteConfig({ routes: {}, limits: { maxExtensions: 1.5 } })).toThrow("config.limits.maxExtensions: expected a non-negative integer");
    expect(() => parseRouteConfig({ routes: {}, limits: { extensionMs: -1 } })).toThrow("config.limits.extensionMs: expected a finite non-negative number");
    expect(() => resolveRunLimits(undefined, { activityWindowMs: NaN })).toThrow("options.limits.activityWindowMs");
    expect(() => resolveRunLimits(undefined, { maxExtensions: -1 })).toThrow("options.limits.maxExtensions");
  });

  it("parses config without inserting phase defaults", () => {
    const config = parseRouteConfig({ routes: {}, limits: { overallMs: 3600000 } });
    expect(config.limits).toEqual({ overallMs: 3600000 });
    expect(parseRouteConfig({ routes: {} }).limits).toBeUndefined();
    expect(parseRouteConfig({ routes: {}, limits: defaultRunLimits }).limits).toEqual(defaultRunLimits);
  });

  it.each(invalid.map(value => [value]))("rejects malformed limits %j in parser and both resolver inputs", value => {
    expect(() => parseRouteConfig({ routes: {}, limits: value })).toThrow(RouteConfigError);
    expect(() => parseRouteConfig({ routes: {}, limits: value })).toThrow(/config\.limits/);
    expect(() => resolveRunLimits(value as Partial<RunLimits>)).toThrow(/config\.limits/);
    expect(() => resolveRunLimits(undefined, value as Partial<RunLimits>)).toThrow(/options\.limits/);
  });

  it("identifies the offending key", () => {
    expect(() => parseRouteConfig({ routes: {}, limits: { decisionRepairs: 3 } })).toThrow("config.limits.decisionRepairs");
    expect(() => parseRouteConfig({ routes: {}, limits: { seconds: 3600 } })).toThrow("config.limits.seconds");
  });

  it("validates directly constructed configs/options before either API starts sessions", async () => {
    for (const run of [runOrchestrated, runBaseline]) {
      await expect(run({ problem: "test", cwd: "/nonexistent", routes: { routes: {}, limits: { decisionRepairs: 3 } } })).rejects.toThrow("config.limits.decisionRepairs");
      await expect(run({ problem: "test", cwd: "/nonexistent", routes: { routes: {} }, limits: { assignmentRequests: -1 } })).rejects.toThrow("options.limits.assignmentRequests");
    }
  });
});
