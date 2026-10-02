import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { directorySessionRecords, safeFileName, type AgentRecordEntry, type RecordedActor, type SessionRecords } from "../../src/agent/records.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orche-agent-records-"));
  roots.push(root);
  return root;
}
const result = (kind = "explore") => reply([call("report_result", { kind, summary: "done" })], { stopReason: "toolUse" });
async function setup(steps: FauxResponseStep[], records?: SessionRecords, spawn: { sessionFile?: string; sessionDir?: string } = {}) {
  const f = await fauxRuntime(steps);
  const cwd = await temp();
  const manager = new AgentManager(f.runtime, records ? { records } : {});
  managers.push(manager);
  await manager.spawn({ id: "A1", role: "explorer-path", route: { ...f.route, thinking: "low" }, modelRuntime: f.runtime, cwd, instructions: "test", tools: [], ...spawn });
  return { f, manager, cwd };
}
const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);

describe("AgentManager records", () => {
  it("keeps everything in memory and still describes the agent when no records hook is given", async () => {
    const { f, manager } = await setup([result()]);
    manager.assign("A1", "explore", "look");
    const waited = await manager.wait("A1", 5000);
    expect(waited).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(manager.session("A1").sessionFile).toBeUndefined();
    const entry = manager.agentRecord("A1");
    expect(entry).toMatchObject({ id: "A1", role: "explorer-path", kind: "worker", model: f.route.model, thinking: "low", requests: 1, status: "completed", assignments: 1 });
    expect(entry.models).toEqual({ [f.route.model]: 1 });
    expect(entry.sessionFile).toBeUndefined();
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(manager.agentRecords().map(item => item.id)).toEqual(["A1"]);
  });

  it("asks the hook for a target, persists the worker's session there and reports its entry once, at disposal", async () => {
    const root = await temp();
    const asked: RecordedActor[] = [];
    const entries: AgentRecordEntry[] = [];
    const records: SessionRecords = {
      sessionTarget: actor => { asked.push(actor); return { sessionFile: join(root, "sessions", `${safeFileName(actor.id)}.jsonl`) }; },
      onAgent: entry => { entries.push(entry); },
    };
    const { f, manager } = await setup([result(), result()], records);
    expect(asked).toEqual([{ id: "A1", role: "explorer-path", kind: "worker" }]);
    manager.assign("A1", "explore", "first");
    await manager.wait("A1", 5000);
    manager.assign("A1", "explore", "second");
    await manager.wait("A1", 5000);
    expect(entries).toEqual([]);
    const file = join(root, "sessions", "A1.jsonl");
    expect(manager.session("A1").sessionFile).toBe(file);
    await manager.dispose();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "A1", kind: "worker", model: f.route.model, thinking: "low", requests: 2, assignments: 2, status: "completed", sessionFile: file });
    await manager.dispose();
    expect(entries).toHaveLength(1);
    // Both assignments are in the one stable transcript, with the worker's own assistant messages.
    const list = await lines(file);
    expect(list[0]).toMatchObject({ type: "session" });
    expect(list.filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(2);
    expect(((await stat(file)).mode & 0o777)).toBe(0o600);
  });

  it("a worker that ends without a RESULT is recorded as no_result, a stopped one as stopped", async () => {
    const entries: AgentRecordEntry[] = [];
    const { manager } = await setup([reply("I am done but never report"), reply("still no report")], { onAgent: entry => { entries.push(entry); } });
    manager.assign("A1", "explore", "look");
    const waited = await manager.wait("A1", 5000);
    expect(waited).toMatchObject({ type: "outcome", outcome: { status: "no_result" } });
    expect(manager.agentRecord("A1")).toMatchObject({ status: "no_result", requests: 2, assignments: 1 });
    await manager.dispose();
    expect(entries[0]).toMatchObject({ status: "no_result" });
  });

  it("reports a worker that is still running when the manager is disposed as stopped, with the requests it made", async () => {
    const entries: AgentRecordEntry[] = [];
    const entered = deferred();
    const blocked: FauxResponseStep = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted");
    };
    const { manager } = await setup([blocked], { onAgent: entry => { entries.push(entry); } });
    manager.assign("A1", "explore", "slow");
    await entered.promise;
    expect(manager.agentRecord("A1").status).toBe("running");
    await manager.disposeWithin(1000);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "A1", status: "stopped" });
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("an explicit sessionFile on the spawn wins: the hook is not asked", async () => {
    const root = await temp();
    let asked = 0;
    const file = join(root, "stable", "W1.jsonl");
    const { manager } = await setup([result()], { sessionTarget: () => { asked++; return { sessionFile: join(root, "other.jsonl") }; } }, { sessionFile: file });
    expect(asked).toBe(0);
    expect(manager.session("A1").sessionFile).toBe(file);
    expect(manager.agentRecord("A1").sessionFile).toBe(file);
  });

  it("a throwing hook means no records, not a failed spawn", async () => {
    const { manager } = await setup([result()], { sessionTarget: () => { throw new Error("hook broke"); }, onAgent: () => { throw new Error("collector broke"); } });
    manager.assign("A1", "explore", "look");
    expect(await manager.wait("A1", 5000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(manager.session("A1").sessionFile).toBeUndefined();
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it("directorySessionRecords names files after the agent, uniquely, and collects the entries", async () => {
    const root = await temp();
    const records = directorySessionRecords(join(root, "out"));
    expect(records.sessionTarget!({ id: "A1", role: "r", kind: "worker" })).toEqual({ sessionFile: join(root, "out", "A1.jsonl") });
    expect(records.sessionTarget!({ id: "A1", role: "r", kind: "worker" })).toEqual({ sessionFile: join(root, "out", "A1-2.jsonl") });
    expect(records.sessionTarget!({ id: "advisor:sec#1", role: "advisor", kind: "advisor" })).toEqual({ sessionFile: join(root, "out", "advisor-sec-1.jsonl") });
    const { manager } = await setup([result()], records);
    await manager.dispose();
    expect(records.entries.map(entry => entry.id)).toEqual(["A1"]);
  });
});
