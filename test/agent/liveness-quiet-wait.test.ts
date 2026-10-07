import { describe, expect, it } from "vitest";
import { declaredBashTimeoutMs, DEFAULT_LIVENESS_WINDOW_MS, LivenessTracker, TOOL_TIMEOUT_GRACE_MS } from "../../src/agent/liveness.js";
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
