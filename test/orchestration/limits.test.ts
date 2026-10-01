import { describe, expect, it } from "vitest";
import { defaultRunLimits, parseRunLimits, resolveRunLimits, type RunLimits } from "../../src/orchestration/limits.js";
import { parseRouteConfig, RouteConfigError } from "../../src/orchestration/routing.js";
import { defaultRunLimits as exportedDefaults, runOrchestrated } from "../../src/orchestration/coordinator.js";
import { runBaseline } from "../../src/eval/baseline.js";

const invalid = [null, [], 42, "3600000", { typo: 1 }, { overallMs: "1" }, { overallMs: NaN }, { overallMs: Infinity }, { explorationMs: -1 }, { assignmentMs: null }, { decisionMs: false }, { maxFixRounds: 0.5 }, { decisionRepairs: 3 }, { decisionRepairs: 1.5 }, { assignmentRequests: 1.5 }, { assignmentRequests: Number.MAX_SAFE_INTEGER + 1 }, { overallMs: undefined }];

describe("run limits", () => {
  it("defaults to one hour and retains compatible exports", () => {
    expect(resolveRunLimits()).toEqual({ overallMs: 3600000, explorationMs: 1200000, assignmentMs: 3600000, decisionMs: 1800000, maxFixRounds: 1, decisionRepairs: 2, assignmentRequests: 150 });
    expect(exportedDefaults).toBe(defaultRunLimits);
  });

  it("merges explicit config and API limits before deriving missing phase caps", () => {
    expect(resolveRunLimits({ overallMs: 120000 })).toMatchObject({ overallMs: 120000, explorationMs: 40000, assignmentMs: 120000, decisionMs: 60000 });
    expect(resolveRunLimits({ overallMs: 120000, decisionMs: 45000 }, { overallMs: 900000 })).toMatchObject({ overallMs: 900000, explorationMs: 300000, assignmentMs: 900000, decisionMs: 45000 });
    expect(resolveRunLimits({ decisionMs: 45000 }, { decisionMs: 1234 })).toMatchObject({ overallMs: 3600000, explorationMs: 1200000, assignmentMs: 3600000, decisionMs: 1234 });
    expect(resolveRunLimits({ decisionMs: 45000 })).toMatchObject({ overallMs: 3600000, explorationMs: 1200000, assignmentMs: 3600000, decisionMs: 45000 });
    expect(resolveRunLimits({ explorationMs: 1, assignmentMs: 2, maxFixRounds: 0, assignmentRequests: 0 }, { overallMs: 30, decisionRepairs: 1 })).toMatchObject({ explorationMs: 1, assignmentMs: 2, decisionMs: 15, maxFixRounds: 0, assignmentRequests: 0, decisionRepairs: 1 });
  });

  it("accepts finite fractional times and zero without treating it as unlimited", () => {
    expect(resolveRunLimits({ overallMs: 0 })).toMatchObject({ overallMs: 0, explorationMs: 0, assignmentMs: 0, decisionMs: 0 });
    expect(parseRunLimits({ overallMs: 1.5, decisionRepairs: 0, assignmentRequests: 0 })).toEqual({ overallMs: 1.5, decisionRepairs: 0, assignmentRequests: 0 });
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
