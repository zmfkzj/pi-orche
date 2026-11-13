import { describe, expect, it } from "vitest";
import { DECLARED_TOOL_WAIT_MAX_MS, declaredBashTimeoutMs, declaredToolTimeoutMs, DEFAULT_LIVENESS_WINDOW_MS, KNOWN_TOOL_TIMEOUTS_MS, LivenessTracker, TOOL_INFLIGHT_MAX_MS, TOOL_TIMEOUT_GRACE_MS } from "../../src/agent/liveness.js";
import { ExtendableDeadline } from "../../src/orchestration/run/extension.js";

/**
 * R7 (P2-3): a long quiet wait that the worker declares (bash with an explicit `timeout`) counts as working within that timeout,
 * a silent bash without one still looks idle after the window, and the extension budget still bounds the whole assignment.
 */
const start = (tracker: LivenessTracker, at: number, args: Record<string, unknown>) => {
  tracker.observe({ type: "agent_start" }, at);
  tracker.observe({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args }, at);
};

describe("declared quiet waits", () => {
  it("reads the declared timeout from numbers and integer strings only", () => {
    expect(declaredBashTimeoutMs({ command: "sleep 600", timeout: 900 })).toBe(900_000);
    expect(declaredBashTimeoutMs({ command: "sleep 600", timeout: "900" })).toBe(900_000);
    expect(declaredBashTimeoutMs({ command: "sleep 600" })).toBeUndefined();
    expect(declaredBashTimeoutMs({ timeout: 0 })).toBeUndefined();
    expect(declaredBashTimeoutMs({ timeout: "soon" })).toBeUndefined();
  });

  it("a silent bash with a declared timeout stays active until that timeout (plus grace), then not", () => {
    const tracker = new LivenessTracker({ id: "W1", role: "implement" });
    start(tracker, 0, { command: "sleep 3000", timeout: 3600 });
    const during = tracker.session(30 * 60_000);
    expect(during).toMatchObject({ state: "tool", active: true });
    expect(during.detail).toContain("declared quiet wait up to 1h");
    expect(during.detail).toContain("no recent progress");
    const after = tracker.session(3600_000 + TOOL_TIMEOUT_GRACE_MS + 1);
    expect(after.active).toBe(false);
    expect(after.detail).toContain("(passed)");
  });

  it("a silent bash without a timeout is idle after the window, as before", () => {
    const tracker = new LivenessTracker({ id: "W1", role: "implement" });
    start(tracker, 0, { command: "sleep 3000" });
    expect(tracker.session(DEFAULT_LIVENESS_WINDOW_MS - 1).active).toBe(true);
    expect(tracker.session(DEFAULT_LIVENESS_WINDOW_MS + 1).active).toBe(false);
  });

  it("output still counts as progress, and the extension budget still caps a declared wait", () => {
    const tracker = new LivenessTracker({ id: "W1", role: "implement" });
    start(tracker, 0, { command: "./watch.sh", timeout: 36_000 });
    tracker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", partialResult: { content: [{ type: "text", text: "tick" }] } }, 10 * 60_000);
    expect(tracker.session(11 * 60_000).detail).toMatch(/output 1m ago/);
    // The deadline extends while the wait is declared, but never past base + maxExtensions × extensionMs.
    let now = 0;
    const deadline = ExtendableDeadline.fromLimits({ assignmentMs: 60_000, extensionMs: 60_000, maxExtensions: 2, activityWindowMs: DEFAULT_LIVENESS_WINDOW_MS } as never, { baseMs: 60_000, startedAt: 0, now: () => now });
    const extensions: boolean[] = [];
    for (const at of [60_000, 120_000, 180_000]) {
      now = at;
      const result = deadline.tryExtend({ scope: "assignment", stage: "W1", liveness: tracker.liveness(at) });
      extensions.push(result.extended && result.fresh !== false);
    }
    expect(extensions).toEqual([true, true, false]);
  });
});

/**
 * A long silent non-bash tool (e.g. a tool that runs a test suite twice and reports once) that declares its own wait as
 * `timeoutSeconds` / `timeoutMs` counts as working until that wait (plus grace), not only for the generic 10 minutes; without a
 * usable declaration nothing changes, a declaration never shortens a bound, and every bound stays finite from the start.
 */
describe("declared waits of non-bash tools", () => {
  const MINUTE = 60_000;
  const startTool = (tracker: LivenessTracker, name: string, args: Record<string, unknown>, at = 0) => {
    tracker.observe({ type: "agent_start" }, at);
    tracker.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: name, args }, at);
  };

  it("reads timeoutMs / timeoutSeconds only, as positive finite numbers or numeric strings; the larger wins, clamped", () => {
    expect(declaredToolTimeoutMs({ timeoutSeconds: 2400 })).toBe(2_400_000);
    expect(declaredToolTimeoutMs({ timeoutSeconds: "2400" })).toBe(2_400_000);
    expect(declaredToolTimeoutMs({ timeoutMs: 90_000 })).toBe(90_000);
    expect(declaredToolTimeoutMs({ timeoutMs: 60_000, timeoutSeconds: 1800 })).toBe(1_800_000);
    expect(declaredToolTimeoutMs({ timeoutMs: 3_600_000, timeoutSeconds: 60 })).toBe(3_600_000);
    // bare `timeout` has no common unit across tools: never read for a non-bash tool.
    expect(declaredToolTimeoutMs({ timeout: 5000 })).toBeUndefined();
    for (const bad of [{}, { timeoutSeconds: 0 }, { timeoutSeconds: -5 }, { timeoutMs: Number.POSITIVE_INFINITY }, { timeoutMs: Number.NaN }, { timeoutSeconds: "soon" }, { timeoutSeconds: "-1" }, { timeoutSeconds: null }, { timeoutSeconds: [60] }])
      expect(declaredToolTimeoutMs(bad)).toBeUndefined();
    expect(declaredToolTimeoutMs(undefined)).toBeUndefined();
    expect(declaredToolTimeoutMs("timeoutSeconds")).toBeUndefined();
    // seconds -> ms overflow is not finite: ignored; a finite but huge declaration is clamped.
    expect(declaredToolTimeoutMs({ timeoutSeconds: Number.MAX_VALUE })).toBeUndefined();
    expect(declaredToolTimeoutMs({ timeoutSeconds: 10 ** 12 })).toBe(DECLARED_TOOL_WAIT_MAX_MS);
    expect(declaredToolTimeoutMs({ timeoutSeconds: Number.MAX_VALUE, timeoutMs: 120_000 })).toBe(120_000);
  });

  it("a silent tool with a declared 40-minute wait stays active past the generic bound until the declaration plus grace", () => {
    const tracker = new LivenessTracker({ id: "W1", role: "implement" });
    startTool(tracker, "long_check", { command: "npx vitest run", timeoutSeconds: 2400 });
    const past = tracker.session(TOOL_INFLIGHT_MAX_MS + 15 * MINUTE);
    expect(past).toMatchObject({ state: "tool", active: true });
    expect(past.detail).toBe("long_check running 25m, no updates, declared wait up to 40m");
    expect(tracker.session(2_400_000 + TOOL_TIMEOUT_GRACE_MS).active).toBe(true);
    const after = tracker.session(2_400_000 + TOOL_TIMEOUT_GRACE_MS + 1);
    expect(after.active).toBe(false);
    expect(after.detail).toContain("past the 40m bound");
  });

  it("without a usable declaration the generic 10-minute bound is unchanged", () => {
    for (const args of [{}, { timeout: 2400 }, { timeoutSeconds: 0 }, { timeoutMs: Number.POSITIVE_INFINITY }]) {
      const tracker = new LivenessTracker({ id: "W1", role: "implement" });
      startTool(tracker, "long_check", args);
      expect(tracker.session(TOOL_INFLIGHT_MAX_MS).active).toBe(true);
      expect(tracker.session(TOOL_INFLIGHT_MAX_MS + 1).active).toBe(false);
    }
  });

  it("a declaration never shortens a known or generic bound, and extends a known one", () => {
    const shortDecl = new LivenessTracker({ id: "W1", role: "implement" });
    startTool(shortDecl, "browser_fetch", { url: "https://example.org", timeoutMs: 5_000 });
    expect(shortDecl.session(TOOL_INFLIGHT_MAX_MS).active).toBe(true);
    expect(shortDecl.session(TOOL_INFLIGHT_MAX_MS + 1).active).toBe(false);

    const knownShort = new LivenessTracker({ id: "W1", role: "implement" });
    startTool(knownShort, "generate_image", { prompt: "x", timeoutMs: 1_000 });
    expect(knownShort.session(KNOWN_TOOL_TIMEOUTS_MS.generate_image! + TOOL_TIMEOUT_GRACE_MS).active).toBe(true);
    expect(knownShort.session(KNOWN_TOOL_TIMEOUTS_MS.generate_image! + TOOL_TIMEOUT_GRACE_MS + 1).active).toBe(false);

    const knownLong = new LivenessTracker({ id: "W1", role: "implement", toolTimeoutsMs: { generate_image: 20 * MINUTE } });
    startTool(knownLong, "generate_image", { prompt: "x", timeoutSeconds: 1800 });
    expect(knownLong.session(29 * MINUTE).active).toBe(true);
    expect(knownLong.session(30 * MINUTE + TOOL_TIMEOUT_GRACE_MS + 1).active).toBe(false);
  });

  it("the largest declaration is still finite from the start, and the extension budget still caps the assignment", () => {
    const tracker = new LivenessTracker({ id: "W1", role: "implement" });
    startTool(tracker, "long_check", { timeoutSeconds: 10 ** 12 });
    expect(tracker.session(DECLARED_TOOL_WAIT_MAX_MS + TOOL_TIMEOUT_GRACE_MS).active).toBe(true);
    expect(tracker.session(DECLARED_TOOL_WAIT_MAX_MS + TOOL_TIMEOUT_GRACE_MS + 1).active).toBe(false);
    let now = 0;
    const deadline = ExtendableDeadline.fromLimits({ assignmentMs: 60_000, extensionMs: 60_000, maxExtensions: 2, activityWindowMs: DEFAULT_LIVENESS_WINDOW_MS } as never, { baseMs: 60_000, startedAt: 0, now: () => now });
    const extensions: boolean[] = [];
    for (const at of [60_000, 120_000, 180_000]) {
      now = at;
      const result = deadline.tryExtend({ scope: "assignment", stage: "W1", liveness: tracker.liveness(at) });
      extensions.push(result.extended && result.fresh !== false);
    }
    expect(extensions).toEqual([true, true, false]);
  });

  it("a bash call keeps its own rule: timeoutSeconds is not a bash declaration, `timeout` still is", () => {
    const tracker = new LivenessTracker({ id: "W1", role: "implement" });
    startTool(tracker, "bash", { command: "sleep 3000", timeoutSeconds: 3600 });
    expect(tracker.session(DEFAULT_LIVENESS_WINDOW_MS + 1).active).toBe(false);
    expect(declaredBashTimeoutMs({ command: "sleep 1", timeout: 60 })).toBe(60_000);
  });
});
