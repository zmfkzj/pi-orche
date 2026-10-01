import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import { createSession } from "../../src/pi/session-factory.js";
import { loadProviderExtensions } from "../../src/pi/provider-extensions.js";
import { WorkspaceAudit } from "../../src/orchestration/workspace.js";
import type { RunContext, RunOptions } from "../../src/orchestration/run/types.js";
import { guardWrite, waitOutcomes } from "../../src/orchestration/run/context.js";
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
