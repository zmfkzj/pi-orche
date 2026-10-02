import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { OrcheController, formatOutcome } from "../../src/extension/controller.js";
import { describeProgress } from "../../src/extension/progress.js";
import { LivenessTracker, aggregateLiveness } from "../../src/agent/liveness.js";
import { runOrchestrated, type RunOptions, type RunReport } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import type { RunLimits } from "../../src/orchestration/limits.js";
import { bounded, remaining } from "../../src/orchestration/run/context.js";
import { cancellationDiagnostic, expiry, runDeadline, timeoutError } from "../../src/orchestration/run/deadline.js";
import type { RunContext } from "../../src/orchestration/run/types.js";
import { createSession } from "../../src/pi/session-factory.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

// Real sessions by default; a test that needs a scripted coordinator replaces the next createSession call only.
vi.mock("../../src/pi/session-factory.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/pi/session-factory.js")>();
  return { ...actual, createSession: vi.fn(actual.createSession) };
});

/** Not a git work tree: these runs must not snapshot or write refs into the developer's repository. */
const outsideGit = tmpdir();
const never = () => new Promise<never>(() => {});
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const classifyAnswer = decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" });
const analysis = tool("report_result", { kind: "answer", summary: "explained", data: { evidence: ["core.mjs"] } });
const approve = decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" });

/** A model request that is in flight for `ms` (the session counts as working while it is), or until the run aborts it. */
const slow = (ms: number, then: AssistantMessage): FauxResponseStep => async (_context, options) => {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    const stop = () => { clearTimeout(timer); resolve(); };
    if (options?.signal?.aborted) stop(); else options?.signal?.addEventListener("abort", stop, { once: true });
  });
  return then;
};
/** A model request that never answers until the run aborts it. */
const hold = (): FauxResponseStep => async (_context, options) => {
  await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  return reply("stopped");
};
const ofType = <T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) => events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);

async function run(steps: FauxResponseStep[], limits: Partial<RunLimits>, extra: Partial<RunOptions> = {}) {
  const f = await fauxRuntime(steps);
  const events: RunEvent[] = [];
  const report = await runOrchestrated({
    problem: "Explain the code.", cwd: outsideGit, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime,
    workspaceAudit: false, limits, sink: event => events.push(event), ...extra,
  });
  return { report, events };
}

const dirs: string[] = [];
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("a run's deadline is extended while the run is working (real sessions, short caps)", () => {
  it("(a) active at the overall deadline: extended once, the run completes, nothing times out", async () => {
    // The analyst's one request outlasts the 600 ms base cap by far, but it is in flight the whole time: the run is working.
    const { report, events } = await run([classifyAnswer, slow(1200, analysis), approve], { overallMs: 600, assignmentMs: 10_000, decisionMs: 10_000, explorationMs: 10_000, extensionMs: 5000, maxExtensions: 3 });
    expect(report.status).toBe("done");
    expect(report.answer).toBe("explained");
    expect(report.timeouts).toBeUndefined();
    expect(report.finishedAt - report.startedAt).toBeGreaterThan(1180); // it really ran past the base cap
    expect(report.extensions).toHaveLength(1);
    expect(report.extensions![0]).toMatchObject({ n: 1, max: 3, scope: "overall", stage: "answer outcomes", extensionMs: 5000, overallExtended: true, reasons: [expect.stringMatching(/^A1 request in flight/)] });
    expect(report.extensions![0]!.newDeadline - report.extensions![0]!.previousDeadline).toBe(5000);
    expect(report.extensions![0]!.previousDeadline).toBe(report.startedAt + 600);
    // One event, in the stream, before the run finished; the two timers that expired together did not extend twice.
    const extended = ofType(events, "deadline_extended");
    expect(extended).toEqual([expect.objectContaining({ type: "deadline_extended", scope: "overall", stage: "answer outcomes", extension: 1, maxExtensions: 3, extensionMs: 5000, newDeadline: report.startedAt + 5600, overallDeadline: report.startedAt + 5600 })]);
    expect(events.findIndex(event => event.type === "deadline_extended")).toBeLessThan(events.findIndex(event => event.type === "run_finished"));
    expect(ofType(events, "run_timeout")).toEqual([]);
  });

  it("(c) at most three extensions, then the deadline is a hard cap that says the budget is used up", async () => {
    // The coordinator's first request never answers: it is in flight (working) at every deadline, 400 ms + 3 x 100 ms.
    const { report, events } = await run([hold()], { overallMs: 400, extensionMs: 100, maxExtensions: 3, decisionMs: 100_000, assignmentMs: 100_000 });
    expect(report.status).toBe("failed");
    expect(report.finishedAt - report.startedAt).toBeGreaterThanOrEqual(680);
    expect(report.extensions!.map(extension => extension.n)).toEqual([1, 2, 3]);
    expect(report.extensions!.every(extension => extension.max === 3 && extension.scope === "overall" && extension.stage === "Coordinator decision")).toBe(true);
    expect(ofType(events, "deadline_extended").map(event => event.extension)).toEqual([1, 2, 3]);
    expect(report.summary).toContain("overall timeout at Coordinator decision");
    expect(report.summary).toContain("extension budget 3/3 used");
    expect(report.timeouts).toHaveLength(1);
    expect(report.timeouts![0]).toMatchObject({
      scope: "overall", stage: "Coordinator decision",
      extensions: { used: 3, max: 3, extensionMs: 100, notExtended: { reason: "budget", message: "extension budget 3/3 used" } },
    });
    // The cap it ended at is the extended one (400 + 3 x 100 ms), however the two timers that expired together ordered themselves
    // (reported as the overall cap, or as the decision cap with the overall deadline as its effective cap).
    expect(report.timeouts![0]!.effectiveCapMs).toBeGreaterThanOrEqual(690);
    expect(report.timeouts![0]!.effectiveCapMs).toBeLessThan(800);
    expect(ofType(events, "run_timeout")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "failed" });
  });

  it("(d) a phase cap extended past the overall deadline extends both, counted once", async () => {
    // The decision cap (150 ms) expires while the coordinator's request is in flight; its extension (+1 s) reaches past the 600 ms overall
    // deadline, which therefore moves too. The request answers at ~900 ms: past the base overall deadline, with no second extension.
    const { report, events } = await run([slow(900, classifyAnswer), analysis, approve], { overallMs: 600, decisionMs: 150, extensionMs: 1000, maxExtensions: 3, assignmentMs: 10_000, explorationMs: 10_000 });
    expect(report.status).toBe("done");
    expect(report.timeouts).toBeUndefined();
    expect(report.finishedAt - report.startedAt).toBeGreaterThan(880);
    expect(report.extensions).toHaveLength(1); // not two: the overall deadline moved with the phase cap
    expect(report.extensions![0]).toMatchObject({ n: 1, max: 3, scope: "phase", stage: "Coordinator decision", overallExtended: true });
    expect(report.extensions![0]!.newDeadline - report.extensions![0]!.previousDeadline).toBe(1000);
    expect(report.extensions![0]!.overallDeadline).toBe(report.startedAt + 600 + 1000); // the overall deadline moved by the same extension
    expect(ofType(events, "deadline_extended")).toHaveLength(1);
    // The event carries the overall deadline after the extension, which a UI needs to show the current cap (here the phase cap moved it too).
    expect(ofType(events, "deadline_extended")[0]).toMatchObject({ scope: "phase", overallDeadline: report.startedAt + 600 + 1000 });
  });

  it("(g) the user's cancellation during an extension window cancels at once", async () => {
    const controller = new AbortController();
    const extended = deferred();
    const events: RunEvent[] = [];
    const f = await fauxRuntime([hold()]);
    // A minute of extension is granted at 500 ms; the user cancels right after it, and the run must not wait for any of that minute.
    const running = runOrchestrated({
      problem: "Explain the code.", cwd: outsideGit, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, workspaceAudit: false,
      limits: { overallMs: 500, extensionMs: 60_000, maxExtensions: 3, decisionMs: 100_000 }, signal: controller.signal,
      sink: event => { events.push(event); if (event.type === "deadline_extended") extended.resolve(); },
    });
    await extended.promise;
    const cancelledAt = Date.now();
    controller.abort();
    const report = await running;
    expect(Date.now() - cancelledAt).toBeLessThan(1500);
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    expect(report.timeouts).toBeUndefined();
    expect(ofType(events, "run_timeout")).toEqual([]);
    expect(report.extensions).toHaveLength(1); // the one that was granted before the cancellation stays on the record
    expect(report.cancellation).toMatchObject({ scope: "cancelled", configuredCapMs: 60_500, extensions: { used: 1, max: 3 } });
    expect(events.at(-1)).toMatchObject({ type: "run_finished", summary: "cancelled" });
  });

  it("(b) nothing is working at the deadline (runtime startup hangs): times out as before, saying why it was not extended", async () => {
    const events: RunEvent[] = [];
    const report = await runOrchestrated({
      problem: "x", cwd: outsideGit, routes: { routes: {}, default: { model: "faux/test" } }, workspaceAudit: false, createRuntime: () => never() as Promise<ModelRuntime>,
      limits: { overallMs: 60 }, sink: event => events.push(event),
    });
    expect(report.status).toBe("failed");
    expect(report.finishedAt - report.startedAt).toBeLessThan(1500); // no extension window was waited out
    expect(report.summary).toContain("overall timeout at startup/runtime");
    expect(report.summary).toContain("(not extended: no activity in the last 2m)");
    expect(report.extensions).toBeUndefined();
    expect(report.timeouts![0]).toMatchObject({ scope: "overall", stage: "startup/runtime", configuredCapMs: 60, effectiveCapMs: 60, extensions: { used: 0, max: 10, notExtended: { reason: "idle", message: "not extended: no activity in the last 2m" } } });
    expect(ofType(events, "deadline_extended")).toEqual([]);
  });

  it("extending can be switched off (maxExtensions 0): an active run times out at the base cap and the message says nothing about extensions", async () => {
    const { report } = await run([hold()], { overallMs: 500, maxExtensions: 0, decisionMs: 100_000, assignmentMs: 100_000 });
    expect(report.status).toBe("failed");
    expect(report.finishedAt - report.startedAt).toBeLessThan(1500);
    expect(report.summary).toMatch(/^overall timeout at Coordinator decision \(EXPLORE\): elapsed \d+ms, cap \d+ms, effective \d+ms$/); // nothing after the numbers
    expect(report.extensions).toBeUndefined();
    expect(report.timeouts![0]!.extensions).toBeUndefined();
  });
});

describe("a scripted coordinator under fake time", () => {
  const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({ prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(), subscribe: vi.fn(() => () => {}), ...overrides }) as unknown as AgentSession;
  const options = (extra: Partial<RunOptions> = {}): RunOptions => ({ problem: "test", cwd: process.cwd(), routes: { routes: {}, default: { model: "faux/test" } }, modelRuntime: {} as ModelRuntime, workspaceAudit: false, ...extra });
  /** A coordinator whose first request has started (its events reach the liveness tracker), then runs `script`. */
  function coordinator(script: (decide: (value: unknown) => Promise<unknown>) => Promise<void>, abort: AgentSession["abort"] = vi.fn(async () => {})) {
    const listeners: Array<(event: unknown) => void> = [];
    vi.mocked(createSession).mockImplementationOnce(async opts => session({
      abort, subscribe: vi.fn((listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; }) as never,
      prompt: vi.fn(async () => {
        for (const event of [{ type: "agent_start" }, { type: "turn_start" }]) for (const listener of listeners) listener(event);
        await script(value => opts.customTools![0]!.execute("decision", { decision: value }, undefined, undefined, {} as never));
      }),
    }));
  }
  beforeEach(() => { vi.useFakeTimers(); });

  it("(b) a coordinator that never reports anything is idle: times out at the cap, with the reason", async () => {
    vi.mocked(createSession).mockImplementationOnce(async () => session({ prompt: vi.fn(never) }));
    const events: RunEvent[] = [];
    const running = runOrchestrated(options({ limits: { overallMs: 50, decisionMs: 5000, assignmentMs: 5000 }, sink: event => events.push(event) }));
    await vi.advanceTimersByTimeAsync(60);
    const report = await running;
    expect(report.summary).toBe("overall timeout at Coordinator decision (EXPLORE): elapsed 50ms, cap 50ms, effective 50ms (not extended: no activity in the last 2m)");
    expect(report.finishedAt - report.startedAt).toBe(50);
    expect(report.extensions).toBeUndefined();
    expect(ofType(events, "deadline_extended")).toEqual([]);
    expect(report.timeouts![0]!.extensions).toEqual({ used: 0, max: 10, extensionMs: 1_800_000, windowMs: 120_000, notExtended: { reason: "idle", message: "not extended: no activity in the last 2m" } });
    // The same words reach the progress line of the timeout.
    expect(describeProgress(ofType(events, "run_timeout")[0]!)).toBe("overall timeout at Coordinator decision (50ms; cap 50ms): not extended: no activity in the last 2m");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(b) a request that has shown no sign of life for longer than the 5-minute bound stops counting: extended while it did, then times out", async () => {
    // Decision cap = overall cap = 3 min. At 3 min the request (sent at 0) is 3 min old: working. At 6 min it is 6 min old: not any more.
    coordinator(() => never());
    const running = runOrchestrated(options({ limits: { overallMs: 180_000, decisionMs: 180_000, assignmentMs: 180_000, extensionMs: 180_000, maxExtensions: 3 } }));
    await vi.advanceTimersByTimeAsync(400_000);
    const report = await running;
    expect(report.extensions).toHaveLength(1);
    // The run-level timer and the phase timer expire together; whichever is asked first extends, the other finds it done.
    expect(report.extensions![0]).toMatchObject({ n: 1, scope: expect.stringMatching(/^(overall|phase)$/), stage: "Coordinator decision", elapsedMs: 180_000, reasons: ["coordinator request in flight 3m, no output yet"] });
    expect(report.finishedAt - report.startedAt).toBe(360_000);
    expect(report.timeouts![0]).toMatchObject({ scope: expect.stringMatching(/^(overall|phase)$/), configuredCapMs: 360_000, effectiveCapMs: 360_000, extensions: { used: 1, max: 3, notExtended: { reason: "idle" } } });
    expect(report.summary).toContain("(extended 1/3; not extended: no activity in the last 2m)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(e) the cleanup budget is what is left of the EXTENDED overall deadline, not of the base cap", async () => {
    // Extended at 50 ms (+100 ms). The coordinator gives up at 70 ms, past the base cap, and its abort never completes: cleanup may
    // use what is left of the extended deadline (until 150 ms). With the base cap it would have had nothing left and ended at 70 ms.
    coordinator(async decide => { await new Promise(resolve => setTimeout(resolve, 70)); await decide({ type: "fail", reason: "gave up" }); }, vi.fn(never));
    const running = runOrchestrated(options({ limits: { overallMs: 50, decisionMs: 5000, assignmentMs: 5000, extensionMs: 100, maxExtensions: 3 } }));
    await vi.advanceTimersByTimeAsync(300);
    const report = await running;
    expect(report.extensions).toHaveLength(1);
    expect(report.cleanup).toMatchObject({ incomplete: true, pending: expect.arrayContaining(["coordinator"]) });
    expect(report.finishedAt - report.startedAt).toBeGreaterThanOrEqual(150);
    expect(report.finishedAt - report.startedAt).toBeLessThanOrEqual(152);
    // No grace on top of the extended deadline: expiring during cleanup is a hard timeout, not another extension.
    expect(report.timeouts).toHaveLength(1);
    expect(report.timeouts![0]).toMatchObject({ scope: "overall", stage: "cleanup/sessions", configuredCapMs: 150, extensions: { used: 1, max: 3, notExtended: { reason: "disabled" } } });
    // The run had failed on its own ("gave up"); the report says the cleanup ran into the extended deadline, without a word about extensions.
    expect(report.summary).toBe("overall timeout at cleanup/sessions (FAILED): elapsed 150ms, cap 150ms, effective 150ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(e)(g) cancelling in the extension window cancels at once, and its diagnostic uses the extended deadline", async () => {
    coordinator(() => never());
    const controller = new AbortController();
    const running = runOrchestrated(options({ limits: { overallMs: 50, decisionMs: 5000, assignmentMs: 5000, extensionMs: 100, maxExtensions: 3 }, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(60); // extended at 50 ms: the deadline is 150 ms
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const report = await running;
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    expect(report.finishedAt - report.startedAt).toBe(60); // not 150
    expect(report.timeouts).toBeUndefined();
    expect(report.extensions).toHaveLength(1);
    expect(report.cancellation).toMatchObject({ scope: "cancelled", configuredCapMs: 150, effectiveCapMs: 90, stage: "Coordinator decision", extensions: { used: 1, max: 3 } });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the run's deadline on a context (fake time)", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  /** A context shaped like a run in progress: one worker with a tool in flight (working), and a sink. */
  function context(limits: Partial<RunLimits> = {}, working = true) {
    const sink: RunEvent[] = [];
    const worker = new LivenessTracker({ id: "W2", role: "implementer" });
    if (working) worker.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "ast_rewrite", args: {} });
    const ctx = {
      startedAt: Date.now(), options: { problem: "p", cwd: process.cwd(), routes: { routes: {} }, sink: (event: RunEvent) => sink.push(event) },
      limits: { overallMs: 50, assignmentMs: 10, extensionMs: 100, maxExtensions: 3, activityWindowMs: 120_000, ...limits }, state: { phase: "EXECUTE" },
      activeTasks: new Map(), cancelled: false, cancel: vi.fn(),
      manager: { list: () => [], liveness: (now: number, windowMs: number) => aggregateLiveness([worker], now, windowMs) },
    } as unknown as RunContext;
    return { ctx, sink, worker };
  }

  it("(e) remaining(), the caps and the cancellation diagnostic follow the extended overall deadline", () => {
    const { ctx, sink } = context();
    expect(remaining(ctx, 1000)).toBe(50);
    expect(cancellationDiagnostic(ctx)).toMatchObject({ configuredCapMs: 50, effectiveCapMs: 50, extensions: { used: 0, max: 3 } });
    vi.advanceTimersByTime(50);
    expect(remaining(ctx, 1000)).toBe(0);
    expect(expiry(ctx, "implement outcomes")).toBeUndefined(); // working: extended
    expect(sink).toEqual([expect.objectContaining({ type: "deadline_extended", scope: "overall", stage: "implement outcomes", extension: 1, maxExtensions: 3, extensionMs: 100, reasons: [expect.stringMatching(/^W2 ast_rewrite running/)] })]);
    expect(runDeadline(ctx).overallDeadline - ctx.startedAt).toBe(150);
    expect(remaining(ctx, 1000)).toBe(100);
    expect(remaining(ctx, 30)).toBe(30);
    expect(cancellationDiagnostic(ctx)).toMatchObject({ configuredCapMs: 150, effectiveCapMs: 100, extensions: { used: 1, max: 3, extensionMs: 100 } });
    vi.advanceTimersByTime(60);
    expect(cancellationDiagnostic(ctx)).toMatchObject({ configuredCapMs: 150, effectiveCapMs: 40 });
  });

  it("(c)(e) three extensions, then a timeout whose cap and diagnostic are the extended ones and which says the budget is used up", () => {
    const { ctx, sink } = context();
    for (const n of [1, 2, 3]) {
      vi.advanceTimersByTime(runDeadline(ctx).overallRemainingMs());
      expect(expiry(ctx, "implement outcomes")).toBeUndefined();
      expect(runDeadline(ctx).used).toBe(n);
    }
    vi.advanceTimersByTime(runDeadline(ctx).overallRemainingMs());
    const error = expiry(ctx, "implement outcomes");
    expect(error?.message).toBe("overall timeout at implement outcomes (EXECUTE): elapsed 350ms, cap 350ms, effective 350ms (extension budget 3/3 used)");
    expect(error?.diagnostic).toMatchObject({ scope: "overall", configuredCapMs: 350, effectiveCapMs: 350, extensions: { used: 3, max: 3, extensionMs: 100, windowMs: 120_000, notExtended: { reason: "budget", message: "extension budget 3/3 used" } } });
    expect(sink.filter(event => event.type === "deadline_extended")).toHaveLength(3);
    expect(sink.filter(event => event.type === "run_timeout")).toHaveLength(1);
    expect(ctx.timeouts).toHaveLength(1);
    // It stays a hard cap: asking again costs nothing and changes nothing.
    expect(expiry(ctx, "implement outcomes")?.diagnostic.extensions?.notExtended?.reason).toBe("budget");
    expect(runDeadline(ctx).overallDeadline - ctx.startedAt).toBe(350);
  });

  it("(b) an idle run is not extended: the timeout says no activity in the window", () => {
    const { ctx } = context({}, false);
    vi.advanceTimersByTime(50);
    const error = expiry(ctx, "implement outcomes");
    expect(error?.message).toBe("overall timeout at implement outcomes (EXECUTE): elapsed 50ms, cap 50ms, effective 50ms (not extended: no activity in the last 2m)");
    expect(error?.diagnostic.extensions).toMatchObject({ used: 0, max: 3, notExtended: { reason: "idle" } });
    expect(runDeadline(ctx).overallDeadline - ctx.startedAt).toBe(50);
    // A worker whose only sign of life is older than the window does not count either (the window is read from the limits).
    const stale = context({ activityWindowMs: 1000 }, false);
    stale.worker.observe({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} }, Date.now() - 5000);
    vi.advanceTimersByTime(50);
    expect(expiry(stale.ctx, "implement outcomes")?.diagnostic.extensions).toMatchObject({ windowMs: 1000, notExtended: { reason: "idle" } });
  });

  it("(d) an expiring phase cap extends the overall deadline with it, as one extension", () => {
    const { ctx, sink } = context({ overallMs: 50 });
    const phase = runDeadline(ctx).phase(30, "Redirect");
    vi.advanceTimersByTime(30);
    expect(expiry(ctx, "Redirect", phase)).toBeUndefined();
    expect(runDeadline(ctx).used).toBe(1);
    expect(phase.deadline - ctx.startedAt).toBe(130); // 30 + 100
    expect(runDeadline(ctx).overallDeadline - ctx.startedAt).toBe(150); // 50 + 100: it would have cut the phase at 50
    expect(sink).toEqual([expect.objectContaining({ type: "deadline_extended", scope: "phase", stage: "Redirect", extension: 1, newDeadline: ctx.startedAt + 130 })]);
    // At 50 ms the overall timer of the run fires: the deadline already moved, so that costs nothing.
    vi.advanceTimersByTime(20);
    expect(expiry(ctx, "answer outcomes")).toBeUndefined();
    expect(runDeadline(ctx).used).toBe(1);
    expect(sink.filter(event => event.type === "deadline_extended")).toHaveLength(1);
  });

  it("bounded(): extends a working phase twice (re-arming the timer), then times out on the budget and cancels the run once", async () => {
    const { ctx, sink } = context({ overallMs: 10_000, maxExtensions: 2 });
    const pending = bounded(ctx, never(), 30, "Redirect");
    const checked = expect(pending).rejects.toThrow("phase timeout at Redirect (EXECUTE): elapsed 230ms, cap 230ms, effective 230ms (extension budget 2/2 used)");
    await vi.advanceTimersByTimeAsync(29);
    expect(sink).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.filter(event => event.type === "deadline_extended").map(event => (event as { extension: number }).extension)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.filter(event => event.type === "deadline_extended")).toHaveLength(2);
    expect(ctx.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.timeouts![0]).toMatchObject({ scope: "phase", configuredCapMs: 230, effectiveCapMs: 230, extensions: { used: 2, max: 2, notExtended: { reason: "budget" } } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("timeoutError() can carry the reason it was not extended", () => {
    const { ctx } = context();
    const idle = { extended: false as const, reason: "idle" as const, n: 0, max: 3, windowMs: 120_000, message: "not extended: no activity in the last 2m" };
    const error = timeoutError(ctx, "implement outcomes", 10, 10, "phase", idle);
    expect(error.message).toBe("phase timeout at implement outcomes (EXECUTE): elapsed 0ms, cap 10ms, effective 10ms (not extended: no activity in the last 2m)");
    vi.advanceTimersByTime(50);
    expect(runDeadline(ctx).tryExtend({ scope: "overall", stage: "implement outcomes", liveness: { active: true, reasons: ["W2 x"], sessions: [] } })).toMatchObject({ extended: true, fresh: true });
    expect(timeoutError(ctx, "implement outcomes", 10, 10, "phase", { ...idle, n: 1 }).message).toContain("(extended 1/3; not extended: no activity in the last 2m)");
    expect(error.diagnostic.extensions?.notExtended).toEqual({ reason: "idle", message: "not extended: no activity in the last 2m" });
    expect(timeoutError(ctx, "implement outcomes", 10, 10, "phase").message).not.toContain("not extended"); // as before when nobody asked
  });
});

describe("(j) what an extended run reports (controller, records, progress)", () => {
  it("shows the extension in the progress lines, events.jsonl, run.json, the details and the final text", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orche-ext-agent-"));
    const cwd = await mkdtemp(join(tmpdir(), "orche-ext-cwd-"));
    dirs.push(agentDir, cwd);
    const f = await fauxRuntime([classifyAnswer, slow(1200, analysis), approve]);
    const [provider, id] = f.route.model.split("/");
    const limits = { overallMs: 600, assignmentMs: 10_000, decisionMs: 10_000, explorationMs: 10_000, extensionMs: 5000, maxExtensions: 3 };
    const controller = new OrcheController({ agentDir, createRuntime: async () => f.runtime, run: (options: RunOptions) => runOrchestrated({ ...options, limits }) });
    const lines: string[] = [];
    const outcome = await controller.run({ request: "Explain the code.", cwd, model: { provider: provider!, id: id! }, thinking: "high", projectTrusted: true, onProgress: progress => lines.push(...progress) });
    expect(outcome.report.status).toBe("done");

    // Progress line (a milestone), as the user sees it while the run goes on.
    expect(lines).toContainEqual(expect.stringMatching(/^⏱ timeout extended 1\/3 \(\+5s\): A1 request in flight/));
    expect(outcome.details.progress.some(line => line.startsWith("⏱ timeout extended 1/3 (+5s):"))).toBe(true);

    // Tool details and final text.
    expect(outcome.details.extensions).toEqual(outcome.report.extensions);
    expect(outcome.details.extensions).toHaveLength(1);
    const text = formatOutcome(outcome);
    expect(text).toMatch(/Timeout extensions: 1\/3 used \(\+5s each\)\n  1\/3 at [0-9hms]+, overall "answer outcomes": A1 request in flight/);

    // Records: the event stream and the manifest.
    const record = outcome.details.record!;
    expect(record).toBeTruthy();
    const events = (await readFile(join(record, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string });
    expect(events.filter(event => event.type === "deadline_extended")).toEqual([expect.objectContaining({ type: "deadline_extended", scope: "overall", stage: "answer outcomes", extension: 1, maxExtensions: 3, extensionMs: 5000, reasons: [expect.stringMatching(/^A1 request in flight/)] })]);
    const manifest = JSON.parse(await readFile(join(record, "run.json"), "utf8")) as { status: string; extensions?: Array<Record<string, unknown>> };
    expect(manifest.status).toBe("done");
    expect(manifest.extensions).toEqual([expect.objectContaining({ n: 1, max: 3, scope: "overall", stage: "answer outcomes", extensionMs: 5000, overallExtended: true })]);
  });

  it("a run that never needed one reports nothing about extensions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orche-ext-cwd-"));
    dirs.push(cwd);
    const { report, events } = await run([classifyAnswer, analysis, approve], { overallMs: 10_000, decisionMs: 5000, assignmentMs: 5000 }, { cwd });
    expect(report.status).toBe("done");
    expect(report.extensions).toBeUndefined();
    expect(ofType(events, "deadline_extended")).toEqual([]);
    expect(formatOutcome({ report, text: report.answer, source: { kind: "session" } as never, cancelledByUser: false, details: { status: report.status, taskClass: report.taskClass, durationMs: 1, config: "c", ignoredConfigs: [], tasks: 0, requests: 0, inputTokens: 0, outputTokens: 0, advisorRequests: 0, models: {}, contextWindows: {}, cancelled: false, progress: [] } })).not.toContain("Timeout extensions");
  });

  it("describeProgress renders the event the way the run shows it", () => {
    const event: RunEvent = { type: "deadline_extended", timestamp: 1, scope: "phase", stage: "Redirect", extension: 2, maxExtensions: 3, extensionMs: 1_800_000, newDeadline: 5, reasons: ["W2 bash running 12m, cpu/io activity 20s ago (cpu 900ms)", "coordinator streaming 5s ago"] };
    expect(describeProgress(event)).toBe("⏱ timeout extended 2/3 (+30m): W2 bash running 12m, cpu/io activity 20s ago (cpu 900ms); coordinator streaming 5s ago");
  });

  it("formatOutcome lists the extensions of a failed run next to its timeout summary", () => {
    const report: RunReport = {
      status: "failed", summary: "overall timeout at implement backlog (EXECUTE): elapsed 7200000ms, cap 7200000ms, effective 7200000ms (extension budget 3/3 used)", tasks: [], startedAt: 0, finishedAt: 7_200_000, taskClass: "change", answer: "x",
      extensions: [1, 2, 3].map(n => ({ n, max: 3, scope: "overall" as const, stage: "implement backlog", extensionMs: 1_800_000, at: n * 1_800_000, elapsedMs: n * 1_800_000, previousDeadline: n * 1_800_000, newDeadline: (n + 1) * 1_800_000, overallDeadline: (n + 1) * 1_800_000, overallExtended: true, reasons: [`W${n} bash running 12m`] })),
    };
    const text = formatOutcome({ report, text: report.summary, source: { kind: "session" } as never, cancelledByUser: false, details: { status: "failed", taskClass: "change", durationMs: 7_200_000, config: "c", ignoredConfigs: [], tasks: 0, requests: 0, inputTokens: 0, outputTokens: 0, advisorRequests: 0, models: {}, contextWindows: {}, cancelled: false, progress: [] } });
    expect(text).toContain("extension budget 3/3 used");
    expect(text).toContain("Timeout extensions: 3/3 used (+30m each)\n  1/3 at 30m, overall \"implement backlog\": W1 bash running 12m\n  2/3 at 1h, overall \"implement backlog\": W2 bash running 12m\n  3/3 at 1h30m, overall \"implement backlog\": W3 bash running 12m");
  });
});
