import { describe, expect, it } from "vitest";
import {
  aggregateLiveness, DEFAULT_LIVENESS_WINDOW_MS, formatDuration, heartbeatOfEvent, isIdleHeartbeat, KNOWN_TOOL_TIMEOUTS_MS, LivenessTracker,
  mergeLiveness, parseBashHeartbeat, REQUEST_WAIT_MAX_MS, TOOL_INFLIGHT_MAX_MS, TOOL_TIMEOUT_GRACE_MS, toolInflightBoundMs,
  type BashHeartbeatSample, type LivenessEvent,
} from "../../src/agent/liveness.js";

const T0 = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60_000;
const WINDOW = MINUTE;

const track = (id = "W1", extra: Partial<ConstructorParameters<typeof LivenessTracker>[0]> = {}) => new LivenessTracker({ id, role: "implementer", ...extra });
const beat = (extra: Partial<BashHeartbeatSample> = {}): BashHeartbeatSample => ({
  type: "bash_heartbeat", seq: 1, at: T0, elapsedMs: 15_000, outputBytes: 0, newOutput: false, procAvailable: true, progressing: false, ...extra,
});
const update = (toolCallId: string, details?: unknown, toolName = "bash") => ({ type: "tool_execution_update", toolCallId, toolName, args: {}, partialResult: { content: [{ type: "text", text: "partial output" }], details } });
const heartbeat = (toolCallId: string, extra: Partial<BashHeartbeatSample> = {}) => ({ type: "tool_execution_update", toolCallId, toolName: "bash", args: {}, partialResult: { content: [], details: { heartbeat: beat(extra) } } });
const start = (toolCallId: string, toolName = "bash") => ({ type: "tool_execution_start", toolCallId, toolName, args: {} });
const end = (toolCallId: string, toolName = "bash") => ({ type: "tool_execution_end", toolCallId, toolName, result: {}, isError: false });
const delta = { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x" } };

describe("(e) model output marks a session active; an idle session is not", () => {
  it("is idle and inactive before any event, with no reasons", () => {
    const tracker = track();
    const verdict = tracker.liveness(T0, WINDOW);
    expect(verdict).toEqual({ active: false, reasons: [], sessions: [{ id: "W1", role: "implementer", state: "idle", active: false, detail: "idle" }] });
  });

  it("streaming within the window is active and says when the last delta came", () => {
    const tracker = track();
    tracker.observe({ type: "agent_start" }, T0);
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe(delta, T0 + SECOND);
    const verdict = tracker.liveness(T0 + 6 * SECOND, WINDOW);
    expect(verdict.active).toBe(true);
    expect(verdict.reasons).toEqual(["W1 streaming 5s ago"]);
    expect(verdict.sessions).toEqual([{ id: "W1", role: "implementer", state: "streaming", active: true, lastSignalAt: T0 + SECOND, detail: "streaming 5s ago" }]);
  });

  it("thinking and tool-call deltas count as output too", () => {
    for (const type of ["thinking_delta", "toolcall_delta"]) {
      const tracker = track();
      tracker.observe({ type: "turn_start" }, T0);
      tracker.observe({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type, delta: "…" } }, T0 + 2 * SECOND);
      expect(tracker.liveness(T0 + 3 * SECOND, WINDOW)).toMatchObject({ active: true, sessions: [{ state: "streaming", lastSignalAt: T0 + 2 * SECOND }] });
    }
  });

  it("an idle worker never counts, even one that produced output a second ago", () => {
    const tracker = track();
    tracker.observe({ type: "agent_start" }, T0);
    tracker.observe(delta, T0 + SECOND);
    tracker.observe({ type: "agent_end", messages: [], willRetry: false }, T0 + 2 * SECOND);
    tracker.observe({ type: "agent_settled" }, T0 + 2 * SECOND);
    const verdict = tracker.liveness(T0 + 3 * SECOND, WINDOW);
    expect(verdict.active).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.sessions[0]).toMatchObject({ state: "idle", active: false, lastSignalAt: T0 + SECOND, detail: "idle, last signal 2s ago" });
  });

  it("the owner can force the idle verdict (a worker without an assignment)", () => {
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe(delta, T0 + SECOND);
    expect(tracker.liveness(T0 + 2 * SECOND, WINDOW, { idle: true })).toMatchObject({ active: false, sessions: [{ state: "idle", active: false }] });
  });

  it("output older than the window stops counting, a request in flight keeps counting only within its bound", () => {
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe(delta, T0);
    // 90 s of silence with a 60 s window: the request still counts (bounded), but no longer as fresh output.
    const stalled = tracker.liveness(T0 + 90 * SECOND, WINDOW);
    expect(stalled.active).toBe(true);
    expect(stalled.sessions[0]).toMatchObject({ state: "streaming", detail: "request in flight 1m30s, last output 1m30s ago" });
    const stuck = tracker.liveness(T0 + REQUEST_WAIT_MAX_MS + SECOND, WINDOW);
    expect(stuck.active).toBe(false);
    expect(stuck.sessions[0]!.detail).toContain("past the 5m bound");
  });
});

describe("(f) request-in-flight and non-bash tool in-flight bounds", () => {
  it("a request with no output counts up to REQUEST_WAIT_MAX_MS since it started, not beyond", () => {
    expect(REQUEST_WAIT_MAX_MS).toBe(5 * MINUTE);
    const tracker = track();
    tracker.observe({ type: "agent_start" }, T0);
    tracker.observe({ type: "turn_start" }, T0);
    const within = tracker.liveness(T0 + REQUEST_WAIT_MAX_MS - SECOND, 30 * SECOND);
    expect(within.active).toBe(true);
    expect(within.sessions[0]).toMatchObject({ state: "request-wait", detail: "request in flight 4m59s, no output yet" });
    expect(within.reasons).toEqual(["W1 request in flight 4m59s, no output yet"]);
    const beyond = tracker.liveness(T0 + REQUEST_WAIT_MAX_MS + SECOND, 30 * SECOND);
    expect(beyond.active).toBe(false);
    expect(beyond.reasons).toEqual([]);
    expect(beyond.sessions[0]).toMatchObject({ state: "request-wait", active: false });
    expect(beyond.sessions[0]!.detail).toBe("request in flight 5m01s, no output yet (no sign of life for 5m01s, past the 5m bound)");
  });

  it("the request bound is not stretched by a large window", () => {
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    expect(tracker.liveness(T0 + 6 * MINUTE, 30 * MINUTE).active).toBe(false);
  });

  it("provider retry backoff is a request in flight (and ends with the retry)", () => {
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe({ type: "message_end", message: { role: "assistant", stopReason: "error" } }, T0 + SECOND);
    tracker.observe({ type: "agent_end", messages: [], willRetry: true }, T0 + SECOND);
    tracker.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: "503" }, T0 + SECOND);
    const waiting = tracker.liveness(T0 + 2 * SECOND, 500);
    expect(waiting.active).toBe(true);
    expect(waiting.sessions[0]).toMatchObject({ state: "request-wait", detail: "provider retry backoff (attempt 1/2, 1s)" });
    // A failed request is not output: the error message did not become a signal.
    expect(waiting.sessions[0]!.lastSignalAt).toBeUndefined();
    tracker.observe({ type: "agent_start" }, T0 + 2 * SECOND);
    tracker.observe(delta, T0 + 3 * SECOND);
    expect(tracker.liveness(T0 + 4 * SECOND, WINDOW).sessions[0]).toMatchObject({ state: "streaming", detail: "streaming 1s ago" });
  });

  it("a non-bash tool in flight counts up to TOOL_INFLIGHT_MAX_MS even without updates, then stops", () => {
    expect(TOOL_INFLIGHT_MAX_MS).toBe(10 * MINUTE);
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe(start("c1", "ast_rewrite"), T0);
    const within = tracker.liveness(T0 + 9 * MINUTE, WINDOW);
    expect(within.active).toBe(true);
    expect(within.sessions[0]).toMatchObject({ state: "tool", detail: "ast_rewrite running 9m, no updates" });
    const beyond = tracker.liveness(T0 + TOOL_INFLIGHT_MAX_MS + SECOND, WINDOW);
    expect(beyond.active).toBe(false);
    expect(beyond.reasons).toEqual([]);
    expect(beyond.sessions[0]!.detail).toBe("ast_rewrite running 10m, no updates, past the 10m bound");
  });

  it("partial output of a non-bash tool keeps it active beyond the bound, within the window", () => {
    const tracker = track();
    tracker.observe(start("c1", "diagnostics"), T0);
    tracker.observe(update("c1", undefined, "diagnostics"), T0 + 11 * MINUTE);
    expect(tracker.liveness(T0 + 11 * MINUTE + 10 * SECOND, WINDOW)).toMatchObject({ active: true, reasons: ["W1 diagnostics running 11m, update 10s ago"] });
    expect(tracker.liveness(T0 + 12 * MINUTE + SECOND, WINDOW).active).toBe(false);
  });

  it("a tool with its own known timeout is bounded by it (plus the grace), not by the generic bound", () => {
    expect(toolInflightBoundMs("generate_image")).toBe(KNOWN_TOOL_TIMEOUTS_MS.generate_image! + TOOL_TIMEOUT_GRACE_MS);
    expect(toolInflightBoundMs("generate_image", { generate_image: 20 * MINUTE })).toBe(20 * MINUTE + TOOL_TIMEOUT_GRACE_MS);
    expect(toolInflightBoundMs("ast_search")).toBe(TOOL_INFLIGHT_MAX_MS);
    expect(toolInflightBoundMs("toString")).toBe(TOOL_INFLIGHT_MAX_MS); // not an inherited property

    const image = track();
    image.observe(start("g1", "generate_image"), T0);
    expect(image.liveness(T0 + 200 * SECOND, WINDOW).active).toBe(true);
    expect(image.liveness(T0 + 211 * SECOND, WINDOW).active).toBe(false);

    const configured = track("W2", { toolTimeoutsMs: { generate_image: 20 * MINUTE } });
    configured.observe(start("g1", "generate_image"), T0);
    expect(configured.liveness(T0 + 15 * MINUTE, WINDOW).active).toBe(true);
    expect(configured.liveness(T0 + 21 * MINUTE, WINDOW).active).toBe(false);
  });

  it("a tool event within the window counts: a tool that just ended is a signal", () => {
    const tracker = track();
    tracker.observe(start("c1", "read"), T0);
    tracker.observe(end("c1", "read"), T0 + SECOND);
    // Between steps: the next request is about to go out.
    expect(tracker.liveness(T0 + 2 * SECOND, WINDOW)).toMatchObject({ active: true, sessions: [{ state: "request-wait", lastSignalAt: T0 + SECOND }] });
  });
});

describe("bash heartbeats", () => {
  it("a progressing heartbeat (cpu/io) is a progress signal and says so", () => {
    const tracker = track("W2");
    tracker.observe(start("b1"), T0);
    tracker.observe(heartbeat("b1", { progressing: true, cpuMs: 1200, processes: 2 }), T0 + 15 * SECOND);
    const verdict = tracker.liveness(T0 + 20 * SECOND, WINDOW);
    expect(verdict.active).toBe(true);
    expect(verdict.reasons).toEqual(["W2 bash running 20s, cpu/io activity 5s ago (cpu 1.2s, 2 procs)"]);
    expect(verdict.sessions[0]).toMatchObject({ state: "tool", active: true, lastSignalAt: T0 + 15 * SECOND });
  });

  it("heartbeats that are alive but not progressing do not count: reported in the detail, inactive once the last progress is older than the window", () => {
    const tracker = track("W2");
    tracker.observe(start("b1"), T0);
    for (let at = 15 * SECOND; at <= 14 * MINUTE; at += 15 * SECOND) tracker.observe(heartbeat("b1", { seq: at / 15_000, elapsedMs: at, cpuMs: 40, processes: 1 }), T0 + at);
    // Within the window of the tool's start it is still fresh...
    expect(tracker.liveness(T0 + 30 * SECOND, WINDOW).active).toBe(true);
    // ...but a silent, idle `sleep` for 14 minutes is alive and not progressing, however many heartbeats came.
    const verdict = tracker.liveness(T0 + 14 * MINUTE, WINDOW);
    expect(verdict.active).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.sessions[0]).toMatchObject({ state: "tool", active: false, lastSignalAt: T0 });
    expect(verdict.sessions[0]!.detail).toBe("bash running 14m, no output yet, alive but not progressing (cpu 40ms, 1 proc)");
  });

  it("names an idle process as soon as its latest heartbeat says so, while the window still counts the start; a busy one again drops the remark", () => {
    const tracker = track("W2");
    tracker.observe(start("b1"), T0);
    tracker.observe(heartbeat("b1", { cpuMs: 10, processes: 1 }), T0 + 15 * SECOND);
    const idle = tracker.liveness(T0 + 20 * SECOND, WINDOW);
    expect(idle.active).toBe(true); // the command started 20 s ago, inside the window
    expect(idle.reasons).toEqual(["W2 bash running 20s, no output yet, alive but not progressing (cpu 10ms, 1 proc)"]);
    tracker.observe(heartbeat("b1", { seq: 2, progressing: true, cpuMs: 900, processes: 1 }), T0 + 30 * SECOND);
    expect(tracker.liveness(T0 + 31 * SECOND, WINDOW).reasons).toEqual(["W2 bash running 31s, cpu/io activity 1s ago (cpu 900ms, 1 proc)"]);
    tracker.observe(heartbeat("b1", { seq: 3, cpuMs: 900, processes: 1 }), T0 + 45 * SECOND);
    expect(tracker.liveness(T0 + 46 * SECOND, WINDOW).reasons).toEqual(["W2 bash running 46s, cpu/io activity 16s ago, alive but not progressing (cpu 900ms, 1 proc)"]);
  });

  it("a bash call is not bounded like another tool: only its own progress counts", () => {
    const tracker = track();
    tracker.observe(start("b1"), T0);
    // Younger than the generic tool bound, yet inactive: a non-bash tool would still count here.
    expect(tracker.liveness(T0 + 5 * MINUTE, WINDOW).active).toBe(false);
  });

  it("progress expires with the window", () => {
    const tracker = track();
    tracker.observe(start("b1"), T0);
    tracker.observe(heartbeat("b1", { progressing: true, cpuMs: 900, processes: 1 }), T0 + 30 * SECOND);
    expect(tracker.liveness(T0 + 80 * SECOND, WINDOW).active).toBe(true);
    expect(tracker.liveness(T0 + 100 * SECOND, WINDOW).active).toBe(false);
    // A later progressing heartbeat revives it.
    tracker.observe(heartbeat("b1", { seq: 2, progressing: true, ioBytes: 4096 }), T0 + 105 * SECOND);
    expect(tracker.liveness(T0 + 110 * SECOND, WINDOW).active).toBe(true);
  });

  it("output is progress: a heartbeat that saw new output, and plain partial output, say `output`", () => {
    const tracker = track("W2");
    tracker.observe(start("b1"), T0);
    tracker.observe(update("b1", { truncation: undefined }), T0 + 13 * MINUTE + 40 * SECOND);
    const verdict = tracker.liveness(T0 + 14 * MINUTE, WINDOW);
    expect(verdict.reasons).toEqual(["W2 bash running 14m, output 20s ago"]);
    const viaHeartbeat = track("W3");
    viaHeartbeat.observe(start("b1"), T0);
    viaHeartbeat.observe(heartbeat("b1", { progressing: true, newOutput: true, outputBytes: 10 }), T0 + 15 * SECOND);
    expect(viaHeartbeat.liveness(T0 + 20 * SECOND, WINDOW).reasons).toEqual(["W3 bash running 20s, output 5s ago"]);
  });

  it("new output makes a heartbeat progressing even when the sender said otherwise", () => {
    expect(parseBashHeartbeat({ heartbeat: beat({ newOutput: true, progressing: false }) })?.progressing).toBe(true);
  });

  it("without /proc a silent command cannot prove progress: reported as such, not counted", () => {
    const tracker = track();
    tracker.observe(start("b1"), T0);
    tracker.observe(heartbeat("b1", { procAvailable: false }), T0 + 15 * SECOND);
    const verdict = tracker.liveness(T0 + 5 * MINUTE, WINDOW);
    expect(verdict.active).toBe(false);
    expect(verdict.sessions[0]!.detail).toBe("bash running 5m, no output yet, alive but not progressing (no /proc data)");
  });

  it("a heartbeat is not partial output: only progress refreshes the last signal", () => {
    const tracker = track();
    tracker.observe(start("b1"), T0);
    tracker.observe(heartbeat("b1"), T0 + 15 * SECOND);
    expect(tracker.liveness(T0 + 16 * SECOND, WINDOW).sessions[0]!.lastSignalAt).toBe(T0);
  });

  it("the empty update a tool sends when it starts is not output", () => {
    const tracker = track();
    tracker.observe(start("b1"), T0);
    tracker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [], details: undefined } }, T0 + SECOND);
    tracker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "" }] } }, T0 + 2 * SECOND);
    expect(tracker.liveness(T0 + 3 * SECOND, WINDOW).sessions[0]).toMatchObject({ lastSignalAt: T0, detail: "bash running 3s, no output yet" });
    // Text, an image, or details do count.
    tracker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "line" }] } }, T0 + 4 * SECOND);
    expect(tracker.liveness(T0 + 5 * SECOND, WINDOW).sessions[0]).toMatchObject({ lastSignalAt: T0 + 4 * SECOND, detail: "bash running 5s, output 1s ago" });
    tracker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [{ type: "image" }] } }, T0 + 6 * SECOND);
    expect(tracker.liveness(T0 + 7 * SECOND, WINDOW).sessions[0]!.lastSignalAt).toBe(T0 + 6 * SECOND);
    tracker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [], details: { fullOutputPath: "/tmp/x" } } }, T0 + 8 * SECOND);
    expect(tracker.liveness(T0 + 9 * SECOND, WINDOW).sessions[0]!.lastSignalAt).toBe(T0 + 8 * SECOND);
  });

  it("a finished tool leaves no flight behind", () => {
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe(start("b1"), T0);
    tracker.observe(heartbeat("b1", { progressing: true, cpuMs: 100 }), T0 + 15 * SECOND);
    tracker.observe(end("b1"), T0 + 20 * SECOND);
    expect(tracker.state()).toBe("request-wait");
    expect(tracker.liveness(T0 + 21 * SECOND, WINDOW).sessions[0]!.detail).toContain("request in flight");
  });
});

describe("structural heartbeat parsing", () => {
  it("accepts the T1 shape and nothing else", () => {
    const sample = beat({ progressing: true, cpuMs: 5, ioBytes: 7, processes: 3, newOutput: true, outputBytes: 9 });
    expect(parseBashHeartbeat({ heartbeat: sample })).toEqual(sample);
    expect(heartbeatOfEvent(heartbeat("b1", { progressing: true }))).toMatchObject({ type: "bash_heartbeat", progressing: true });
    for (const junk of [undefined, null, 5, "x", {}, { heartbeat: null }, { heartbeat: { type: "other", progressing: true } }, { heartbeat: "bash_heartbeat" }]) {
      expect(parseBashHeartbeat(junk), JSON.stringify(junk)).toBeUndefined();
    }
    expect(heartbeatOfEvent({ type: "message_update" })).toBeUndefined();
    expect(heartbeatOfEvent({ type: "tool_execution_update", partialResult: 5 } as never)).toBeUndefined();
  });

  it("drops non-finite numbers instead of trusting them", () => {
    const parsed = parseBashHeartbeat({ heartbeat: { type: "bash_heartbeat", progressing: true, cpuMs: Number.NaN, ioBytes: "9", processes: Infinity, procAvailable: true } });
    expect(parsed).toMatchObject({ progressing: true, procAvailable: true, seq: 0 });
    expect(parsed).not.toHaveProperty("cpuMs");
    expect(parsed).not.toHaveProperty("ioBytes");
    expect(parsed).not.toHaveProperty("processes");
  });

  it("isIdleHeartbeat tells a heartbeat of an idle process from activity", () => {
    expect(isIdleHeartbeat(heartbeat("b1"))).toBe(true);
    expect(isIdleHeartbeat(heartbeat("b1", { progressing: true }))).toBe(false);
    expect(isIdleHeartbeat(update("b1", { truncation: undefined }))).toBe(false);
    expect(isIdleHeartbeat(delta)).toBe(false);
  });
});

describe("state changes (what goes into the events stream)", () => {
  it("reports a change of state once, never per delta or per heartbeat", () => {
    const events: LivenessEvent[] = [];
    const tracker = track("W3", { onChange: event => events.push(event) });
    tracker.observe({ type: "agent_start" }, T0);
    tracker.observe({ type: "turn_start" }, T0);
    for (let i = 1; i <= 20; i++) tracker.observe(delta, T0 + i * 100);
    tracker.observe({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } }, T0 + 3000);
    tracker.observe(start("b1"), T0 + 3000);
    for (let i = 1; i <= 40; i++) tracker.observe(heartbeat("b1", { seq: i, progressing: i % 2 === 0, cpuMs: i * 10 }), T0 + 3000 + i * 15_000);
    tracker.observe(end("b1"), T0 + 700_000);
    tracker.observe({ type: "turn_end", message: {}, toolResults: [] }, T0 + 700_000);
    tracker.observe({ type: "turn_start" }, T0 + 700_001);
    tracker.observe({ type: "agent_end", messages: [], willRetry: false }, T0 + 701_000);
    tracker.observe({ type: "agent_settled" }, T0 + 701_000);
    expect(events.map(event => event.state)).toEqual(["request-wait", "streaming", "tool", "request-wait", "idle"]);
    expect(events).toEqual([
      { type: "liveness", timestamp: T0, agentId: "W3", role: "implementer", state: "request-wait" },
      { type: "liveness", timestamp: T0 + 100, agentId: "W3", role: "implementer", state: "streaming" },
      { type: "liveness", timestamp: T0 + 3000, agentId: "W3", role: "implementer", state: "tool", detail: "bash" },
      { type: "liveness", timestamp: T0 + 700_000, agentId: "W3", role: "implementer", state: "request-wait" },
      { type: "liveness", timestamp: T0 + 701_000, agentId: "W3", role: "implementer", state: "idle" },
    ]);
  });

  it("names the tools in flight and the retry in the short detail", () => {
    const events: LivenessEvent[] = [];
    const tracker = track("W3", { onChange: event => events.push(event) });
    tracker.observe(start("a", "read"), T0);
    tracker.observe(start("b", "grep"), T0);
    tracker.observe(end("a", "read"), T0 + 1);
    tracker.observe(end("b", "grep"), T0 + 2);
    tracker.observe({ type: "agent_end", messages: [], willRetry: true }, T0 + 3);
    tracker.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 250, errorMessage: "x" }, T0 + 4);
    expect(events.map(event => [event.state, event.detail])).toEqual([["tool", "read"], ["request-wait", undefined]]);
    const other = track("W4", { onChange: event => events.push(event) });
    other.observe({ type: "agent_start" }, T0);
    other.observe(delta, T0);
    other.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 250, errorMessage: "x" }, T0 + 1);
    expect(events.at(-1)).toMatchObject({ agentId: "W4", state: "request-wait", detail: "retry 1/1" });
  });

  it("an observer that throws cannot affect the tracker", () => {
    const tracker = track("W1", { onChange: () => { throw new Error("boom"); } });
    expect(() => tracker.observe({ type: "turn_start" }, T0)).not.toThrow();
    expect(tracker.state()).toBe("request-wait");
  });

  it("ignores malformed and unrelated events", () => {
    const tracker = track();
    for (const event of [
      { type: "message_update" }, { type: "tool_execution_update" }, { type: "tool_execution_update", partialResult: null }, { type: "message_end" },
      { type: "message_end", message: null }, { type: "queue_update", steering: [], followUp: [] }, { type: "entry_appended" }, { type: "nonsense" },
    ]) expect(() => tracker.observe(event as never, T0)).not.toThrow();
    expect(tracker.state()).not.toBe("tool");
  });
});

describe("merging", () => {
  it("combines several sessions: active when any is, with every active session's reason", () => {
    const worker = track("W1");
    worker.observe({ type: "turn_start" }, T0);
    worker.observe(delta, T0);
    const sleeper = track("W2");
    sleeper.observe(start("b1"), T0);
    const idle = track("W3");
    const coordinator = new LivenessTracker({ id: "coordinator", role: "coordinator" });
    coordinator.observe({ type: "agent_start" }, T0 + 110 * SECOND);
    coordinator.observe(delta, T0 + 115 * SECOND);

    const now = T0 + 2 * MINUTE;
    const merged = aggregateLiveness([worker, sleeper, idle, coordinator], now, WINDOW);
    expect(merged.active).toBe(true);
    expect(merged.reasons).toEqual(["W1 request in flight 2m, last output 2m ago", "coordinator streaming 5s ago"]);
    expect(merged.sessions.map(session => [session.id, session.state, session.active])).toEqual([
      ["W1", "streaming", true], ["W2", "tool", false], ["W3", "idle", false], ["coordinator", "streaming", true],
    ]);
    expect(mergeLiveness(worker.liveness(now, WINDOW), undefined, idle.liveness(now, WINDOW))).toEqual({
      active: true, reasons: worker.liveness(now, WINDOW).reasons, sessions: [worker.session(now, WINDOW), idle.session(now, WINDOW)],
    });
  });

  it("nothing merged is inactive", () => {
    expect(mergeLiveness()).toEqual({ active: false, reasons: [], sessions: [] });
    expect(aggregateLiveness([track(), track("W2")], T0, WINDOW).active).toBe(false);
  });
});

describe("formatting and defaults", () => {
  it("formats durations compactly", () => {
    expect([0, 999, 45_000, 120_000, 125_000, 14 * MINUTE, 3_600_000, 3_900_000, -5].map(formatDuration)).toEqual(["0s", "0s", "45s", "2m", "2m05s", "14m", "1h", "1h05m", "0s"]);
  });

  it("falls back to the default window for a nonsensical one", () => {
    const tracker = track();
    tracker.observe({ type: "turn_start" }, T0);
    tracker.observe(delta, T0);
    expect(DEFAULT_LIVENESS_WINDOW_MS).toBe(2 * MINUTE);
    expect(tracker.liveness(T0 + MINUTE, Number.NaN).sessions[0]!.detail).toBe("streaming 1m ago");
    expect(tracker.liveness(T0 + MINUTE, -1).active).toBe(true);
  });
});
