import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated, type RunOptions } from "../../src/orchestration/coordinator.js";
import * as factory from "../../src/pi/session-factory.js";
import { directorySessionRecords, type AgentRecordEntry } from "../../src/agent/records.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orche-run-records-"));
  roots.push(root);
  return root;
}
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const classify = decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" });
const answer = tool("report_result", { kind: "answer", summary: "The value is 0.", data: { evidence: ["core.mjs"] } });
const jsonl = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
const assistantMessages = (list: Array<Record<string, any>>) => list.filter(entry => entry.type === "message" && entry.message.role === "assistant");
const mode = async (path: string) => (await stat(path)).mode & 0o777;

async function run(steps: FauxResponseStep[], extra: Partial<RunOptions> = {}) {
  const f = await fauxRuntime(steps);
  const cwd = await temp();
  const out = await temp();
  const records = directorySessionRecords(join(out, "sessions"));
  const report = await runOrchestrated({
    problem: "what is the value?", cwd, routes: { routes: {}, default: { model: f.route.model, thinking: "low" } },
    modelRuntime: f.runtime, limits: { overallMs: 10_000, decisionMs: 2000, assignmentMs: 2000 }, records, ...extra,
  });
  return { f, report, records, out, cwd };
}

describe("RunOptions.records", () => {
  it("persists the coordinator and the worker as JSONL with their assistant messages and reports one entry each", async () => {
    const { f, report, records, out } = await run([classify, answer, decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" })]);
    expect(report.status).toBe("done");
    expect((await readdir(join(out, "sessions"))).sort()).toEqual(["A1.jsonl", "coordinator.jsonl"]);
    const byId = Object.fromEntries(records.entries.map(entry => [entry.id, entry]));
    expect(Object.keys(byId).sort()).toEqual(["A1", "coordinator"]);
    expect(byId.coordinator).toMatchObject({ kind: "coordinator", role: "coordinator", model: f.route.model, thinking: "low", status: "completed", requests: 2, sessionFile: join(out, "sessions", "coordinator.jsonl") });
    expect(byId.A1).toMatchObject({ kind: "worker", model: f.route.model, status: "completed", requests: 1, assignments: 1, sessionFile: join(out, "sessions", "A1.jsonl") });
    expect(byId.coordinator!.models).toEqual({ [f.route.model]: 2 });
    for (const [id, expected] of [["coordinator", 2], ["A1", 1]] as const) {
      const list = await jsonl(join(out, "sessions", `${id}.jsonl`));
      expect(list[0]).toMatchObject({ type: "session" });
      expect(assistantMessages(list), id).toHaveLength(expected);
      expect(await mode(join(out, "sessions", `${id}.jsonl`))).toBe(0o600);
    }
    // The worker's transcript shows the tool call it made.
    const worker = assistantMessages(await jsonl(join(out, "sessions", "A1.jsonl")));
    expect(JSON.stringify(worker)).toContain("report_result");
  });

  it("a failed run still reports every agent, the coordinator as failed", async () => {
    const { report, records, out } = await run([classify, answer, decision({ type: "fail", reason: "could not cross-check" })]);
    expect(report).toMatchObject({ status: "failed", summary: "could not cross-check" });
    const coordinator = records.entries.find(entry => entry.id === "coordinator")!;
    expect(coordinator).toMatchObject({ status: "failed", error: "could not cross-check" });
    expect(records.entries.map(entry => entry.id).sort()).toEqual(["A1", "coordinator"]);
    expect(assistantMessages(await jsonl(join(out, "sessions", "coordinator.jsonl")))).toHaveLength(2);
  });

  it("a cancelled run reports the coordinator as cancelled and the worker as stopped, with their files on disk", async () => {
    const controller = new AbortController();
    const entered = deferred();
    const blocked: FauxResponseStep = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted") as AssistantMessage;
    };
    const pending = run([classify, blocked], { signal: controller.signal });
    await entered.promise;
    controller.abort();
    const { report, records, out } = await pending;
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    const byId = Object.fromEntries(records.entries.map(entry => [entry.id, entry]));
    expect(byId.coordinator).toMatchObject({ status: "cancelled" });
    expect(byId.A1).toMatchObject({ status: "stopped" });
    // Even a session that was cut off mid-request left a valid transcript, marked as disposed while streaming.
    const worker = await jsonl(join(out, "sessions", "A1.jsonl"));
    expect(worker[0]).toMatchObject({ type: "session" });
    expect(worker.some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
    expect(worker.some(entry => entry.type === "custom" && entry.customType === "orche:disposed")).toBe(true);
  });

  it("without a records hook nothing is persisted: no session target is ever passed and no session has a file", async () => {
    const targets: Array<{ sessionDir?: string; sessionFile?: string }> = [];
    const files: Array<string | undefined> = [];
    const create = factory.createSession;
    vi.spyOn(factory, "createSession").mockImplementation(async options => {
      targets.push({ sessionDir: options.sessionDir, sessionFile: options.sessionFile });
      const session = await create(options);
      files.push(session.sessionFile);
      return session;
    });
    const f = await fauxRuntime([classify, answer, decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" })]);
    const cwd = await temp();
    const report = await runOrchestrated({ problem: "q", cwd, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, limits: { overallMs: 10_000, decisionMs: 2000, assignmentMs: 2000 } });
    expect(report.status).toBe("done");
    expect(targets).toHaveLength(2);
    expect(targets.every(target => target.sessionDir === undefined && target.sessionFile === undefined)).toBe(true);
    expect(files.every(file => file === undefined)).toBe(true);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("a hook that declines (returns undefined) keeps that session in memory", async () => {
    const entries: AgentRecordEntry[] = [];
    const f = await fauxRuntime([classify, answer, decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" })]);
    const out = await temp();
    const cwd = await temp();
    const report = await runOrchestrated({
      problem: "q", cwd, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, limits: { overallMs: 10_000, decisionMs: 2000, assignmentMs: 2000 },
      records: { sessionTarget: actor => actor.kind === "worker" ? { sessionFile: join(out, `${actor.id}.jsonl`) } : undefined, onAgent: entry => { entries.push(entry); } },
    });
    expect(report.status).toBe("done");
    expect(await readdir(out)).toEqual(["A1.jsonl"]);
    expect(entries.find(entry => entry.id === "coordinator")!.sessionFile).toBeUndefined();
    expect(entries.find(entry => entry.id === "A1")!.sessionFile).toBe(join(out, "A1.jsonl"));
  });
});
