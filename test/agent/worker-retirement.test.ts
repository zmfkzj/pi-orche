import { afterEach, expect, it, vi } from "vitest";
import { AgentManager, WORKER_DISPOSE_TIMEOUT_MS, WORKER_STOP_TIMEOUT_MS } from "../../src/agent/agent-manager.js";
import { fauxRuntime } from "../helpers/faux.js";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";

const managers: AgentManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  vi.restoreAllMocks();
});

it("disposal retains only lightweight status and records, not sessions, adapters or callbacks", async () => {
  const f = await fauxRuntime([reply([call("report_result", { kind: "explore", summary: "done" })], { stopReason: "toolUse" })]);
  const onAgent = vi.fn();
  const manager = new AgentManager(f.runtime, { records: { onAgent } });
  managers.push(manager);
  await manager.spawn({ id: "a", role: "test", cwd: process.cwd(), instructions: "test", route: f.route, tools: [] });
  const session = manager.session("a");
  manager.assign("a", "explore", "start");
  expect(await manager.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
  expect(session.messages.length).toBeGreaterThan(0);
  const record = manager.agentRecord("a");
  await manager.dispose("a");
  const internals = manager as unknown as { workers: Map<string, unknown>; retired: Map<string, Record<string, unknown>> };
  expect(internals.workers.has("a")).toBe(false);
  expect(Object.keys(internals.retired.get("a")!).sort()).toEqual(["liveness", "record", "snapshot"]);
  expect(manager.get("a")).toMatchObject({ status: "disposed", completedAssignments: 1 });
  expect(manager.list()).toEqual([manager.get("a")]);
  expect(manager.agentRecords()).toEqual([record]);
  expect(onAgent).toHaveBeenCalledExactlyOnceWith(record);
  expect(() => manager.session("a")).toThrow("Unknown agent");
  expect(() => manager.detach("a")).toThrow("Unknown agent");
  expect(await manager.send({ id: "note", type: "note", from: "main", to: "a", content: "hi" })).toMatchObject({ status: "rejected", reason: "Agent disposed" });
  expect(manager.workerLiveness("a")).toMatchObject({ active: false, state: "idle" });
  await manager.dispose("a");
  expect(onAgent).toHaveBeenCalledOnce();
});

it("bounded stop force-disposes an unresponsive SDK abort and observes late rejections", async () => {
  const f = await fauxRuntime([]);
  const manager = new AgentManager(f.runtime, { stopTimeoutMs: 5 });
  managers.push(manager);
  await manager.spawn({ id: "a", role: "test", cwd: process.cwd(), instructions: "test", route: f.route, tools: [] });
  const session = manager.session("a");
  const late = Promise.withResolvers<void>();
  vi.spyOn(session, "prompt").mockReturnValue(new Promise(() => {}));
  vi.spyOn(session, "abort").mockReturnValue(late.promise);
  const dispose = vi.spyOn(session, "dispose");
  manager.assign("a", "explore", "start");
  await manager.stop("a");
  expect(dispose).toHaveBeenCalledOnce();
  expect(manager.get("a").status).toBe("disposed");
  expect(await manager.wait("a", 0)).toMatchObject({ type: "outcome", outcome: { status: "stopped" } });
  expect((manager as unknown as { workers: Map<string, unknown> }).workers.size).toBe(0);
  late.reject(new Error("late SDK abort failure"));
  await new Promise(resolve => setTimeout(resolve, 0));
});

/** A default-configured manager whose worker is mid-assignment (its prompt never settles) and whose SDK abort settles only when the test says so. */
async function hungWorker() {
  const f = await fauxRuntime([]);
  const manager = new AgentManager(f.runtime);
  managers.push(manager);
  await manager.spawn({ id: "a", role: "test", cwd: process.cwd(), instructions: "test", route: f.route, tools: [] });
  const session = manager.session("a");
  const abort = Promise.withResolvers<void>();
  vi.spyOn(session, "prompt").mockReturnValue(new Promise(() => {}));
  vi.spyOn(session, "abort").mockReturnValue(abort.promise);
  const dispose = vi.spyOn(session, "dispose");
  manager.assign("a", "explore", "start");
  return { manager, abort, dispose };
}

it("the default grace after an abort signal is 30 seconds, then an unresponsive worker is force-disposed", async () => {
  expect(WORKER_STOP_TIMEOUT_MS).toBe(30_000);
  const { manager, abort, dispose } = await hungWorker();
  vi.useFakeTimers();
  try {
    let stopped = false;
    const stop = manager.stop("a").then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stopped).toBe(false);
    expect(manager.get("a").status).toBe("stopping");
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.get("a").status).toBe("disposed");
    expect(await manager.wait("a", 0)).toMatchObject({ type: "outcome", outcome: { status: "stopped" } });
    abort.reject(new Error("late SDK abort failure"));
    await Promise.resolve();
  } finally {
    abort.resolve();
    vi.useRealTimers();
  }
});

it("a responsive abort returns as soon as it settles, without waiting out the grace, and keeps the worker", async () => {
  const { manager, abort, dispose } = await hungWorker();
  vi.useFakeTimers();
  try {
    let stopped = false;
    const stop = manager.stop("a").then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(stopped).toBe(false);
    expect(manager.get("a").status).toBe("stopping");
    abort.resolve();
    await stop;
    expect(manager.get("a").status).toBe("idle");
    expect(dispose).not.toHaveBeenCalled();
    expect(await manager.wait("a", 0)).toMatchObject({ type: "outcome", outcome: { status: "stopped" } });
  } finally {
    abort.resolve();
    vi.useRealTimers();
  }
});

it("dispose bounds an unresponsive abort by 1 second and releases a stop already waiting out the grace", async () => {
  expect(WORKER_DISPOSE_TIMEOUT_MS).toBe(1000);
  const { manager, abort, dispose } = await hungWorker();
  vi.useFakeTimers();
  try {
    let stopped = false, disposed = false;
    const stop = manager.stop("a").then(() => { stopped = true; });
    const disposal = manager.dispose("a").then(() => { disposed = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(disposed).toBe(false);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await disposal;
    await stop;
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.get("a").status).toBe("disposed");
  } finally {
    abort.resolve();
    vi.useRealTimers();
  }
});

it("request checkpoint updates retain nonnegative safe-integer validation", () => {
  const manager = new AgentManager();
  managers.push(manager);
  for (const every of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => manager.setRequestCheckpoint(every)).toThrow("requestCheckpoint must be a nonnegative safe integer");
  }
  expect(() => manager.setRequestCheckpoint(0)).not.toThrow();
  expect(() => manager.setRequestCheckpoint(1)).not.toThrow();
});
