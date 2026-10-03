import { afterEach, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent/agent-manager.js";
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

it("request budget updates retain nonnegative safe-integer validation", () => {
  const manager = new AgentManager();
  managers.push(manager);
  for (const budget of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => manager.setRequestBudget(budget)).toThrow("requestBudget must be a nonnegative safe integer");
  }
  expect(() => manager.setRequestBudget(0)).not.toThrow();
  expect(() => manager.setRequestBudget(1)).not.toThrow();
});
