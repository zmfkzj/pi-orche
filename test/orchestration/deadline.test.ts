import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import { createSession } from "../../src/pi/session-factory.js";
import { loadProviderExtensions } from "../../src/pi/provider-extensions.js";
import { WorkspaceAudit } from "../../src/orchestration/workspace.js";
import type { RunContext, RunOptions } from "../../src/orchestration/run/types.js";
import { guardWrite, waitOutcomes } from "../../src/orchestration/run/context.js";
import { cancellationDiagnostic, timeoutError } from "../../src/orchestration/run/deadline.js";
import { aggregateLiveness, DEFAULT_LIVENESS_WINDOW_MS, LivenessTracker, type BashHeartbeatSample } from "../../src/agent/liveness.js";
import type { RunEvent } from "../../src/orchestration/events.js";
vi.mock("../../src/pi/session-factory.js", () => ({ createSession: vi.fn() }));
vi.mock("../../src/pi/provider-extensions.js", () => ({ loadProviderExtensions: vi.fn() }));
const never = () => new Promise<never>(() => {});
const runtime = {} as ModelRuntime;
const options = (extra: Partial<RunOptions> = {}): RunOptions => ({ problem: "test", cwd: process.cwd(), routes: { routes: {}, default: { model: "faux/test" } }, modelRuntime: runtime, workspaceAudit: false, limits: { overallMs: 50, decisionMs: 500, assignmentMs: 500 }, ...extra });
function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(), subscribe: vi.fn(() => () => {}), ...overrides } as unknown as AgentSession;
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function finish(run: Promise<Awaited<ReturnType<typeof runOrchestrated>>>) { await vi.advanceTimersByTimeAsync(60); return run; }
it("bounds runtime startup and does not create sessions after late runtime completion", async () => {
  const deferred = Promise.withResolvers<ModelRuntime>();
  vi.spyOn(ModelRuntime, "create").mockReturnValue(deferred.promise);
  const events: RunEvent[] = [];
  const run = runOrchestrated(options({ modelRuntime: undefined, sink: e => events.push(e) }));
  const report = await finish(run);
  expect(report).toMatchObject({ status: "failed", timeouts: [{ scope: "overall", stage: "startup/runtime", configuredCapMs: 50, effectiveCapMs: 50 }], cleanup: { incomplete: true } });
  expect(events.filter(e => e.type === "run_timeout")).toHaveLength(1);
  deferred.resolve(runtime); await Promise.resolve(); await Promise.resolve();
  expect(createSession).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds provider startup, disposes a late provider once, and observes late rejection", async () => {
  const deferred = Promise.withResolvers<Awaited<ReturnType<typeof loadProviderExtensions>>>();
  vi.mocked(loadProviderExtensions).mockReturnValue(deferred.promise);
  const run = runOrchestrated(options({ routes: { routes: {}, providerExtensions: ["fake"] } }));
  const report = await finish(run);
  expect(report.timeouts?.[0]?.stage).toBe("startup/providers");
  const dispose = vi.fn(); deferred.resolve({ dispose } as unknown as Awaited<ReturnType<typeof loadProviderExtensions>>);
  await vi.advanceTimersByTimeAsync(0);
  expect(dispose).toHaveBeenCalledTimes(1); expect(createSession).not.toHaveBeenCalled();
  vi.mocked(loadProviderExtensions).mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 100)));
  await finish(runOrchestrated(options({ routes: { routes: {}, providerExtensions: ["fake"] } })));
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds coordinator creation and disposes its late session without prompting or accepting decisions", async () => {
  const deferred = Promise.withResolvers<AgentSession>();
  vi.mocked(createSession).mockReturnValue(deferred.promise);
  const report = await finish(runOrchestrated(options()));
  expect(report.timeouts?.[0]?.stage).toBe("startup/coordinator");
  const late = session(); deferred.resolve(late); await vi.advanceTimersByTimeAsync(0);
  expect(late.dispose).toHaveBeenCalledTimes(1); expect(late.prompt).not.toHaveBeenCalled();
  const tool = vi.mocked(createSession).mock.calls[0]![0].customTools![0]!;
  await expect(tool.execute("late", { decision: { type: "fail", reason: "late" } }, undefined, undefined, {} as never)).rejects.toThrow("cancelled");
});
it("distinguishes manual cancellation from an active decision overall timeout", async () => {
  vi.mocked(createSession).mockResolvedValue(session({ prompt: vi.fn(never) }));
  const report = await finish(runOrchestrated(options()));
  expect(report.summary).toContain("overall timeout at Coordinator decision");
  expect(report.timeouts?.[0]).toMatchObject({ scope: "overall", phase: "EXPLORE" });
  const controller = new AbortController();
  const run = runOrchestrated(options({ signal: controller.signal }));
  await vi.advanceTimersByTimeAsync(1); controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(await run).toMatchObject({ status: "failed", summary: "cancelled" });
  expect((await run).timeouts).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
});
function failingCoordinator(abort = vi.fn(async () => {})) {
  vi.mocked(createSession).mockImplementation(async opts => session({ abort, prompt: vi.fn(async () => {
    await opts.customTools![0]!.execute("decision", { decision: { type: "fail", reason: "test failure" } }, undefined, undefined, {} as never);
  }) }));
}
it("bounds teardown without extra grace and reports pending uncooperative abort", async () => {
  failingCoordinator(vi.fn(never));
  const report = await finish(runOrchestrated(options()));
  expect(report.timeouts?.[0]?.stage).toBe("cleanup/sessions");
  expect(report.cleanup?.pending).toContain("coordinator");
  expect(report.finishedAt - report.startedAt).toBeLessThanOrEqual(52);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds final workspace audit and aborts its owned signal", async () => {
  failingCoordinator();
  let signal: AbortSignal | undefined;
  let snapshots = 0;
  vi.spyOn(WorkspaceAudit, "open").mockImplementation(async (_cwd, supplied) => {
    signal = supplied;
    return { snapshot: vi.fn(() => ++snapshots === 1 ? Promise.resolve("tree") : never()), checkpoint: vi.fn(async () => "commit"), diff: vi.fn(async () => []), close: vi.fn(async () => {}) } as unknown as WorkspaceAudit;
  });
  const report = await finish(runOrchestrated(options({ workspaceAudit: true })));
  expect(report.timeouts?.[0]?.stage).toBe("cleanup/final-workspace");
  expect(signal?.aborted).toBe(true); expect(report.cleanup?.pending).toContain("final-workspace");
  expect(vi.getTimerCount()).toBe(0);
});

it("inbox messages cannot reset a phase deadline; cancelled guarded writes are rejected", async () => {
  const waits: number[] = [];
  const ctx = {
    startedAt: Date.now(), options: options(), limits: { overallMs: 50, assignmentMs: 10 }, state: { phase: "EXECUTE" },
    mainNotes: [], bufferedNoteIds: new Set(), activeTasks: new Map(), cancelled: false, cancel: vi.fn(),
    manager: { list: () => [], wait: (_id: string, ms: number) => {
      waits.push(ms);
      return new Promise(resolve => setTimeout(() => resolve(ms <= 2 ? { type: "timeout" } : { type: "message", message: { id: String(ms), type: "note", from: "A1", to: "main", content: "information" } }), Math.min(ms, 2)));
    } },
  } as unknown as RunContext;
  const pending = waitOutcomes(ctx, "implement", new Set(["A1"]));
  const checked = expect(pending).rejects.toThrow("phase timeout at implement outcomes");
  await vi.advanceTimersByTimeAsync(15); await checked;
  expect(waits).toEqual([10, 8, 6, 4, 2]);
  expect(ctx.cancel).toHaveBeenCalledTimes(1);
  ctx.cancelled = true;
  expect(guardWrite(ctx, "A1", "write", { path: "owned.txt", content: "late" })).toContain("cancelled");
  expect(vi.getTimerCount()).toBe(0);
});

// ---- (i) timeout diagnostics say what each session was doing ----
const MINUTE = 60_000;
const heartbeat = (extra: Partial<BashHeartbeatSample> = {}) => ({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [], details: { heartbeat: { type: "bash_heartbeat", seq: 1, at: 0, elapsedMs: 0, outputBytes: 0, newOutput: false, procAvailable: true, progressing: false, ...extra } } } });
const delta = { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x" } };
/** A context shaped like a run in progress: one coordinator tracker and a manager that lists one worker and reports its liveness. */
function runningContext(worker: LivenessTracker, coordinator?: LivenessTracker) {
  const sink: RunEvent[] = [];
  const ctx = {
    startedAt: Date.now() - 20 * MINUTE, options: options({ sink: event => sink.push(event) }), limits: { overallMs: 50, assignmentMs: 10 }, state: { phase: "EXECUTE" },
    activeTasks: new Map([["W2", { id: "change" }]]), cancelled: false, cancel: vi.fn(), ...(coordinator ? { coordinatorLiveness: coordinator } : {}),
    manager: {
      list: () => [{ id: "W2", status: "running", currentAssignment: { id: "assignment-1", kind: "implement" }, requestCount: 3, lastToolName: "bash", lastActivityAt: 1 }],
      liveness: (now: number, windowMs: number) => aggregateLiveness([worker], now, windowMs),
    },
  } as unknown as RunContext;
  return { ctx, sink };
}
it("(i) a timeout diagnostic carries each worker's liveness state and detail, the coordinator's, and the reasons the run still counted as working", () => {
  const now = Date.now();
  const worker = new LivenessTracker({ id: "W2", role: "implementer" });
  worker.observe({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: {} }, now - 14 * MINUTE);
  worker.observe({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", args: {}, partialResult: { content: [], details: {} } }, now - 20_000);
  const coordinator = new LivenessTracker({ id: "coordinator", role: "coordinator" });
  coordinator.observe({ type: "agent_start" }, now - 10_000);
  coordinator.observe(delta, now - 5000);
  const { ctx, sink } = runningContext(worker, coordinator);

  const error = timeoutError(ctx, "implement outcomes", 10, 10, "phase");
  expect(error.diagnostic.workers).toEqual([expect.objectContaining({
    id: "W2", taskId: "change", requestCount: 3, lastToolName: "bash",
    liveness: { state: "tool", active: true, detail: "bash running 14m, output 20s ago", lastSignalAt: now - 20_000 },
  })]);
  expect(error.diagnostic.coordinator).toEqual({ state: "streaming", active: true, detail: "streaming 5s ago", lastSignalAt: now - 5000 });
  expect(error.diagnostic.liveness).toEqual({ windowMs: DEFAULT_LIVENESS_WINDOW_MS, active: true, reasons: ["coordinator streaming 5s ago", "W2 bash running 14m, output 20s ago"] });
  // The same diagnostic goes to the event stream and the run's timeouts list.
  expect(sink.find(event => event.type === "run_timeout")).toMatchObject({ diagnostic: { liveness: { reasons: expect.arrayContaining(["W2 bash running 14m, output 20s ago"]) } } });
  expect(ctx.timeouts).toHaveLength(1);
});
it("(i) a stuck worker is shown as alive but not progressing, and the run as not active", () => {
  const now = Date.now();
  const worker = new LivenessTracker({ id: "W2", role: "implementer" });
  worker.observe({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: {} }, now - 14 * MINUTE);
  for (let at = 15_000; at < 14 * MINUTE; at += 15_000) worker.observe(heartbeat({ cpuMs: 40, processes: 1 }), now - 14 * MINUTE + at);
  const { ctx } = runningContext(worker);
  const diagnostic = cancellationDiagnostic(ctx);
  expect(diagnostic.workers[0]!.liveness).toMatchObject({ state: "tool", active: false, detail: "bash running 14m, no output yet, alive but not progressing (cpu 40ms, 1 proc)" });
  expect(diagnostic.liveness).toEqual({ windowMs: DEFAULT_LIVENESS_WINDOW_MS, active: false, reasons: [] });
  expect(diagnostic).not.toHaveProperty("coordinator");
});
it("(i) a diagnostic never fails because liveness is missing or broken", () => {
  const worker = new LivenessTracker({ id: "W2", role: "implementer" });
  const { ctx } = runningContext(worker);
  (ctx.manager as unknown as { liveness: () => never }).liveness = () => { throw new Error("broken"); };
  const broken = timeoutError(ctx, "stage", 10, 10, "phase").diagnostic;
  expect(broken.workers).toHaveLength(1);
  expect(broken.workers[0]).not.toHaveProperty("liveness");
  expect(broken).not.toHaveProperty("liveness");
  delete (ctx.manager as unknown as { liveness?: unknown }).liveness; // a manager double without liveness
  expect(timeoutError(ctx, "stage", 10, 10, "phase").diagnostic.workers[0]).not.toHaveProperty("liveness");
});
it("(i) an overall timeout while the coordinator is streaming names it in the run's timeout diagnostic", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const prompt = vi.fn(() => {
    for (const event of [{ type: "agent_start" }, { type: "turn_start" }, delta]) for (const listener of listeners) listener(event);
    return never();
  });
  vi.mocked(createSession).mockResolvedValue(session({ prompt, subscribe: vi.fn((listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; }) as never }));
  const events: RunEvent[] = [];
  const report = await finish(runOrchestrated(options({ sink: event => events.push(event) })));
  expect(report.timeouts?.[0]).toMatchObject({
    scope: "overall", stage: "Coordinator decision",
    coordinator: { state: "streaming", active: true },
    liveness: { active: true, reasons: [expect.stringMatching(/^coordinator streaming \d+s ago$/)] },
  });
  expect(events.find(event => event.type === "run_timeout")).toMatchObject({ diagnostic: { coordinator: { state: "streaming" } } });
  expect(events.filter(event => event.type === "liveness").map(event => event.state)).toEqual(["request-wait", "streaming"]);
  expect(vi.getTimerCount()).toBe(0);
});
