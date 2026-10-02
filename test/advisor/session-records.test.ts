import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { runAdvisorSession, type AdvisorRun } from "../../src/advisor/session.js";
import { resolveAdvisor } from "../../src/advisor/config.js";
import type { AgentRecordEntry } from "../../src/agent/records.js";
import { fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orche-advisor-records-"));
  roots.push(root);
  return root;
}
const verdict = reply([call("advisor_verdict", { verdict: "ok", notes: [] })], { stopReason: "toolUse" });
async function advise(steps: Parameters<typeof fauxRuntime>[0], records: AdvisorRun["records"], call?: number) {
  const f = await fauxRuntime(steps);
  const cwd = await temp();
  const run: AdvisorRun = {
    advisor: resolveAdvisor({ name: "sec", domains: ["tests"], targets: ["coordinator"], triggers: [] }),
    route: { role: "advisor", model: f.route.model, thinking: "low" }, runtime: f.runtime, cwd, prompt: "review this",
    timeoutMs: 5000, signal: new AbortController().signal, onUsage: () => {}, onContextWindow: () => {},
    ...(records ? { records } : {}), ...(call !== undefined ? { call } : {}),
  };
  return { f, run, result: await runAdvisorSession(run).then(value => ({ value }), error => ({ error })) };
}
const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);

describe("advisor session records", () => {
  it("persists each call as its own session and reports an entry with the call number in the id", async () => {
    const out = await temp();
    const entries: AgentRecordEntry[] = [];
    const asked: string[] = [];
    const records = { sessionTarget: (actor: { id: string }) => { asked.push(actor.id); return { sessionFile: join(out, `${actor.id.replace(/\W+/g, "-")}.jsonl`) }; }, onAgent: (entry: AgentRecordEntry) => { entries.push(entry); } };
    const { f, result } = await advise([verdict], records, 2);
    expect(result).toMatchObject({ value: { verdict: "ok" } });
    expect(asked).toEqual(["advisor:sec#2"]);
    expect(entries).toHaveLength(1);
    const file = join(out, "advisor-sec-2.jsonl");
    expect(entries[0]).toMatchObject({ id: "advisor:sec#2", role: "advisor", kind: "advisor", model: f.route.model, thinking: "low", requests: 1, status: "completed", sessionFile: file });
    expect(entries[0]!.models).toEqual({ [f.route.model]: 1 });
    const list = await lines(file);
    expect(list.filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(1);
    expect(((await stat(file)).mode & 0o777)).toBe(0o600);
  });

  it("a call that ends without a verdict is reported as failed and its transcript is still there", async () => {
    const out = await temp();
    const entries: AgentRecordEntry[] = [];
    const { result } = await advise([reply("I have no verdict")], { sessionTarget: actor => ({ sessionFile: join(out, `${actor.id.replace(/\W+/g, "-")}.jsonl`) }), onAgent: entry => { entries.push(entry); } });
    expect(result).toHaveProperty("error");
    expect(entries[0]).toMatchObject({ id: "advisor:sec#1", status: "failed", requests: 1 });
    expect(entries[0]!.error).toContain("advisor_verdict");
    expect((await lines(join(out, "advisor-sec-1.jsonl"))).some(entry => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
  });

  it("without records the advisor session is in memory and nothing is reported", async () => {
    const { result } = await advise([verdict], undefined);
    expect(result).toMatchObject({ value: { verdict: "ok" } });
  });
});
