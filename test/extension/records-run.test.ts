import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { formatOutcome, OrcheController, withRecordLine, type OrcheOutcome } from "../../src/extension/controller.js";
import { parseOrcheCommand } from "../../src/extension/index.js";
import { resetPruneOnce } from "../../src/extension/records.js";
import { errorToolResult, runErrorResult } from "../../src/extension/tool-result.js";
import { runOrchestrated, type RunOptions } from "../../src/orchestration/coordinator.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

/**
 * orche_run leaves a record (src/extension/records.ts): run.json written at the start and finished at the end, the RunEvent stream, and the
 * transcript of every sub-session, under `<agentDir>/orche/records/<parent session id>/<timestamp>_run-<id>/`, outside the workspace and with
 * private permissions. Real extension session, faux models, temp agent dir (`records: true` in the harness; its default is off).
 */
const open: Harness[] = [];
const scratch: string[] = [];
afterEach(async () => {
  resetPruneOnce();
  for (const harness of open.splice(0)) await harness.dispose();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function harness(options: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const created = await createHarness({ records: true, ...options });
  open.push(created);
  return created;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** The harness project as a committed git work tree: the run audits it, and `git status` shows anything that lands in it. */
function initRepo(h: Harness): void {
  git(h.cwd, "init", "-q");
  git(h.cwd, "add", "-A");
  git(h.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
}

interface ToolResultMessage { role: "toolResult"; toolName: string; isError: boolean; content: { type: string; text: string }[]; details?: Record<string, any> }
const runResults = (h: Harness): ToolResultMessage[] =>
  h.session.messages.flatMap(message => message.role === "toolResult" && message.toolName === "orche_run" ? [message as unknown as ToolResultMessage] : []);
const textOf = (message: ToolResultMessage) => message.content.map(part => part.text).join("\n");
const blockedUntilAbort = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
  return reply("aborted") as AssistantMessage;
};

const rootOf = (h: Harness) => join(h.agentDir, "orche", "records");
const sessionIdOf = (h: Harness) => h.session.sessionManager.getSessionId();
const mode = (path: string) => statSync(path).mode & 0o777;
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const readJsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
/** Record directories of the harness's session, oldest first (synchronous: usable inside a scripted model step). */
const recordDirs = (h: Harness, kind = "run"): string[] => {
  const parent = join(rootOf(h), sessionIdOf(h));
  return existsSync(parent) ? readdirSync(parent).filter(name => new RegExp(`_${kind}-[0-9a-f]{8}$`).test(name)).sort().map(name => join(parent, name)) : [];
};
/** The names of the tools an assistant called in a pi session JSONL. */
const toolsCalled = (file: string): string[] => readJsonl(file)
  .filter(entry => entry.type === "message" && entry.message?.role === "assistant")
  .flatMap(entry => (entry.message.content as { type: string; name?: string }[]).filter(part => part.type === "toolCall").map(part => part.name!));
const assistantMessages = (file: string) => readJsonl(file).filter(entry => entry.type === "message" && entry.message?.role === "assistant");
/** Every file and directory below `dir` (not following links), `.git` left out. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.name === ".git" ? [] : entry.isDirectory() ? [join(dir, entry.name), ...walk(join(dir, entry.name))] : [join(dir, entry.name)]);
}

describe("an orche_run that finishes", () => {
  async function finishedRun() {
    const midRun: Array<{ run: Record<string, any>; events: string; hasSessionsDir: boolean }> = [];
    let h!: Harness;
    const [classify, ...rest] = answerScript("RECORDED_ANSWER");
    const observed: FauxResponseStep = (context, options, state, model) => {
      // The coordinator's first request: the record exists already, and its run.json says the run is still going.
      const [dir] = recordDirs(h);
      midRun.push({ run: readJson(join(dir!, "run.json")), events: readFileSync(join(dir!, "events.jsonl"), "utf8"), hasSessionsDir: existsSync(join(dir!, "sessions")) });
      return typeof classify === "function" ? classify(context, options, state, model) : classify!;
    };
    h = await harness({ mainSteps: [tool("orche_run", { request: "explain greeting.txt", context: "The user reads greeting.txt." }), reply("relayed")], orcheSteps: [observed, ...rest] });
    initRepo(h);
    await h.session.prompt("go");
    const [result] = runResults(h);
    const [dir, ...others] = recordDirs(h);
    expect(others).toEqual([]);
    return { h, result: result!, dir: dir!, midRun };
  }

  it("writes run.json at the start (running) and finishes it: status, end, summary, routes, one entry per agent, workspace and cleanup", async () => {
    const { h, result, dir, midRun } = await finishedRun();
    expect(result.isError).toBe(false);

    expect(midRun).toHaveLength(1);
    expect(midRun[0]!.run).toMatchObject({
      version: 1, kind: "run", status: "running", cwd: h.cwd, request: "explain greeting.txt", context: "The user reads greeting.txt.",
      parentSession: { id: sessionIdOf(h) }, config: expect.stringContaining("user config"), routes: { default: { model: h.orche.route.model } }, agents: [],
    });
    expect(midRun[0]!.run.end).toBeUndefined();
    expect(midRun[0]!.hasSessionsDir).toBe(true);
    expect(midRun[0]!.events.split("\n")[0]).toMatch(/^\{"type":"run_started"/);

    const run = readJson(join(dir, "run.json"));
    expect(run).toMatchObject({
      kind: "run", status: "done", cwd: h.cwd, taskClass: "answer", request: "explain greeting.txt", context: "The user reads greeting.txt.",
      parentSession: { id: sessionIdOf(h) }, files: { events: "events.jsonl", sessions: "sessions" },
      cleanup: { incomplete: false, pending: [] }, workspace: { baseline: expect.stringMatching(/^[0-9a-f]{40}$/), changes: [], external: [], violations: [] },
      usage: { requests: expect.any(Number), inputTokens: expect.any(Number), models: { coordinator: expect.any(Object) } },
    });
    expect(run.summary).toBeTruthy();
    expect(run).not.toHaveProperty("failure");
    expect(Date.parse(run.end)).toBeGreaterThanOrEqual(Date.parse(run.start));
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.id).toBe(dir.slice(-8));
    expect(dir).toMatch(new RegExp(`^${rootOf(h)}/${sessionIdOf(h)}/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_run-[0-9a-f]{8}$`));

    // Which model each role used, how many requests, where the transcript is.
    const agents: Record<string, Record<string, any>> = Object.fromEntries((run.agents as Array<Record<string, any>>).map(agent => [agent.id, agent]));
    expect(Object.keys(agents).sort()).toEqual(["A1", "coordinator"]);
    expect(agents.coordinator).toMatchObject({ kind: "coordinator", role: "coordinator", model: h.orche.route.model, status: "completed", sessionFile: join(dir, "sessions", "coordinator.jsonl") });
    expect(agents.A1).toMatchObject({ kind: "worker", model: h.orche.route.model, status: "completed", sessionFile: join(dir, "sessions", "A1.jsonl"), models: { [h.orche.route.model]: expect.any(Number) } });
    for (const agent of Object.values(agents)) {
      expect(agent.requests).toBeGreaterThan(0);
      expect(agent.durationMs).toBeGreaterThanOrEqual(0);
      expect(agent.startedAt).toBeGreaterThan(0);
    }
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("appends the RunEvent stream to events.jsonl, one JSON per line", async () => {
    const { dir } = await finishedRun();
    const events = readJsonl(join(dir, "events.jsonl"));
    expect(events.length).toBeGreaterThan(5);
    for (const event of events) expect(event).toMatchObject({ type: expect.any(String), timestamp: expect.any(Number) });
    expect(events[0]).toMatchObject({ type: "run_started", mode: "orchestrated" });
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "done" });
    const types = new Set(events.map(event => event.type));
    for (const type of ["phase_changed", "request_classified", "coordinator_usage", "usage", "workspace_baseline"]) expect(types, type).toContain(type);
  });

  it("records a compact liveness sample per session state change (never per delta), coordinator and worker, before run_finished", async () => {
    const { dir } = await finishedRun();
    const events = readJsonl(join(dir, "events.jsonl"));
    const samples = events.filter(event => event.type === "liveness");
    expect(new Set(samples.map(sample => sample.agentId))).toEqual(new Set(["coordinator", "A1"]));
    for (const sample of samples) {
      expect(Object.keys(sample).sort()).toEqual(expect.arrayContaining(["agentId", "role", "state", "timestamp", "type"]));
      expect(Object.keys(sample).length).toBeLessThanOrEqual(6); // type, timestamp, agentId, role, state and at most a short detail
      expect(["streaming", "tool", "request-wait", "idle"]).toContain(sample.state);
      expect(JSON.stringify(sample).length).toBeLessThan(300);
      expect(events.indexOf(sample)).toBeLessThan(events.length - 1); // run_finished is still the last line
    }
    for (const id of ["coordinator", "A1"]) {
      const states = samples.filter(sample => sample.agentId === id).map(sample => sample.state);
      expect(states[0]).toBe("request-wait");
      expect(states.at(-1)).toBe("idle");
      for (let i = 1; i < states.length; i++) expect(states[i]).not.toBe(states[i - 1]);
    }
  });

  it("persists the coordinator's and the worker's session as pi session JSONL with their assistant messages", async () => {
    const { dir, h } = await finishedRun();
    expect((await readdir(join(dir, "sessions"))).sort()).toEqual(["A1.jsonl", "coordinator.jsonl"]);
    for (const name of ["coordinator", "A1"]) {
      const lines = readJsonl(join(dir, "sessions", `${name}.jsonl`));
      expect(lines[0], name).toMatchObject({ type: "session", version: expect.any(Number), id: expect.any(String), cwd: h.cwd });
      expect(assistantMessages(join(dir, "sessions", `${name}.jsonl`)).length, name).toBeGreaterThan(0);
    }
    expect(toolsCalled(join(dir, "sessions", "coordinator.jsonl"))).toEqual(["coordinator_decision", "coordinator_decision"]);
    expect(toolsCalled(join(dir, "sessions", "A1.jsonl"))).toEqual(["report_result"]);
    expect(readFileSync(join(dir, "sessions", "A1.jsonl"), "utf8")).toContain("RECORDED_ANSWER");
    // Not in pi's own session store, so it never shows up in /resume or in concurrent-session detection.
    expect(existsSync(join(h.agentDir, "sessions"))).toBe(false);
  });

  it("puts one `Record: <dir>` line last in the result text and the directory in details.record", async () => {
    const { result, dir } = await finishedRun();
    const text = textOf(result);
    expect(text.split("\n").at(-1)).toBe(`Record: ${dir}`);
    expect(text.match(/^Record: /gm)).toHaveLength(1);
    expect(text).toContain("RECORDED_ANSWER");
    expect(result.details).toMatchObject({ status: "done", record: dir });
  });

  it("uses private permissions: directories 0700, files 0600", async () => {
    const { dir, h } = await finishedRun();
    for (const path of [join(h.agentDir, "orche"), rootOf(h), join(rootOf(h), sessionIdOf(h)), dir, join(dir, "sessions")]) expect(mode(path), path).toBe(0o700);
    const files = walk(dir).filter(path => statSync(path).isFile());
    expect(files.map(path => path.slice(dir.length + 1)).sort()).toEqual(["events.jsonl", "run.json", "sessions/A1.jsonl", "sessions/coordinator.jsonl"]);
    for (const file of files) expect(mode(file), file).toBe(0o600);
  });

  it("writes nothing into the workspace", async () => {
    const { h } = await finishedRun();
    expect(git(h.cwd, "status", "--porcelain")).toBe("");
    expect(walk(h.cwd).map(path => path.slice(h.cwd.length + 1))).toEqual(["greeting.txt"]);
  });

  it("a change run records the verifier as well, with the change in the workspace section", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "set the value" }), reply("noted")],
      orcheSteps: [
        decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
        tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
        tool("report_result", { kind: "implement", summary: "set value to 1", data: { status: "done" } }),
        tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
      ],
    });
    await writeFile(join(h.cwd, "core.mjs"), "export const value = 0;\n");
    initRepo(h);
    await h.session.prompt("go");
    expect(runResults(h)[0]!.isError).toBe(false);
    const [dir] = recordDirs(h);
    const run = readJson(join(dir!, "run.json"));
    expect(run).toMatchObject({ status: "done", taskClass: "change", workspace: { changes: [{ path: "core.mjs", status: "modified" }], external: [], violations: [] } });
    expect((run.agents as Array<Record<string, any>>).map(agent => agent.id).sort()).toEqual(["A1", "V1", "coordinator"]);
    const verifier = (run.agents as Array<Record<string, any>>).find(agent => agent.id === "V1")!;
    expect(verifier).toMatchObject({ kind: "worker", role: "verifier", model: h.orche.route.model, sessionFile: join(dir!, "sessions", "V1.jsonl") });
    expect(toolsCalled(verifier.sessionFile)).toEqual(["report_result"]);
    expect(toolsCalled(join(dir!, "sessions", "A1.jsonl"))).toEqual(["write", "report_result"]);
  });
});

describe("an orche_run that does not finish still leaves its final run.json", () => {
  it("a failed run: status failed, the failure, the agents' totals; the error result and its details carry the Record", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "do the impossible" }), reply("noted")],
      orcheSteps: [
        decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" }),
        tool("report_result", { kind: "answer", summary: "PRESERVED_ANALYSIS", data: { evidence: ["greeting.txt"] } }),
        decision({ type: "fail", reason: "coordinator gave up" }),
      ],
    });
    initRepo(h);
    await h.session.prompt("go");
    const [result] = runResults(h);
    const [dir] = recordDirs(h);
    expect(result!.isError).toBe(true);
    expect(textOf(result!).split("\n").at(-1)).toBe(`Record: ${dir}`);
    expect(result!.details).toMatchObject({ status: "failed", record: dir, failure: { kind: "failed", reason: "coordinator gave up" } });

    const run = readJson(join(dir!, "run.json"));
    expect(run).toMatchObject({ kind: "run", status: "failed", failure: expect.stringContaining("coordinator gave up"), summary: expect.stringContaining("coordinator gave up"), taskClass: "answer" });
    expect(Date.parse(run.end)).toBeGreaterThanOrEqual(Date.parse(run.start));
    const agents = Object.fromEntries((run.agents as Array<Record<string, any>>).map(agent => [agent.id, agent]));
    expect(agents.coordinator).toMatchObject({ status: "failed", model: h.orche.route.model });
    expect(agents.A1.requests).toBeGreaterThan(0);
    expect(readJsonl(join(dir!, "events.jsonl")).at(-1)).toMatchObject({ type: "run_finished", status: "failed" });
    expect(toolsCalled(join(dir!, "sessions", "coordinator.jsonl"))).toEqual(["coordinator_decision", "coordinator_decision"]);
  });

  it("a run cancelled with /orche cancel: status cancelled, the cancellation diagnostics, the cost so far", async () => {
    const entered = deferred();
    const h = await harness({ mainSteps: [tool("orche_run", { request: "long job" }), reply("understood")], orcheSteps: [blockedUntilAbort(entered)] });
    initRepo(h);
    const turn = h.session.prompt("delegate");
    await entered.promise;
    await h.session.prompt("/orche cancel");
    await turn;
    const [result] = runResults(h);
    const [dir] = recordDirs(h);
    expect(result!.isError).toBe(true);
    expect(textOf(result!)).toMatch(/^cancelled by user\n\norche CANCELLED by user /);
    expect(textOf(result!).split("\n").at(-1)).toBe(`Record: ${dir}`);
    expect(result!.details).toMatchObject({ cancelled: true, record: dir, failure: { kind: "cancelled", cancelledByUser: true } });

    const run = readJson(join(dir!, "run.json"));
    expect(run).toMatchObject({ kind: "run", status: "cancelled", summary: "cancelled", failure: "cancelled", cancelledByUser: true, cancellation: { phase: "EXPLORE" } });
    expect(run.cleanup).toEqual(result!.details!.cleanup); // what the run reported, whatever it was (a cancelled git audit leaves work pending)
    expect(run.end).toBeDefined();
    const coordinator = (run.agents as Array<Record<string, any>>).find(agent => agent.id === "coordinator")!;
    expect(coordinator).toMatchObject({ status: "cancelled", model: h.orche.route.model, sessionFile: join(dir!, "sessions", "coordinator.jsonl") });
    expect(readJsonl(coordinator.sessionFile)[0]).toMatchObject({ type: "session" }); // the file exists although the first request never answered
    expect(readJsonl(join(dir!, "events.jsonl")).at(-1)).toMatchObject({ type: "run_finished", status: "failed", summary: "cancelled" });
  });

  it("a run cancelled by aborting the main turn is recorded as cancelled too", async () => {
    const entered = deferred();
    const h = await harness({ mainSteps: [tool("orche_run", { request: "long job" })], orcheSteps: [blockedUntilAbort(entered)] });
    initRepo(h);
    const turn = h.session.prompt("delegate");
    await entered.promise;
    await h.session.abort();
    await turn;
    const [dir] = recordDirs(h);
    const run = readJson(join(dir!, "run.json"));
    expect(run).toMatchObject({ status: "cancelled", summary: "cancelled" });
    expect(run).not.toHaveProperty("cancelledByUser"); // the tool's abort signal, not /orche cancel
    expect(textOf(runResults(h)[0]!).split("\n").at(-1)).toBe(`Record: ${dir}`);
  });

  it("a run that throws without a report is finished as failed, and the error is not touched", async () => {
    const root = await import("node:fs/promises").then(fs => fs.mkdtemp(join(process.env.TMPDIR ?? "/tmp", "orche-records-throw-")));
    try {
      const f = await fauxRuntime();
      await writeFile(join(root, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: f.route.model } }));
      const cwd = join(root, "work");
      await mkdir(cwd);
      const controller = new OrcheController({ agentDir: root, createRuntime: async () => f.runtime, run: async () => { throw new Error("boom"); } });
      await expect(controller.run({ request: "x", cwd, projectTrusted: false })).rejects.toThrow(/^boom$/);
      const parent = join(root, "orche", "records", "no-session");
      const [name] = await readdir(parent);
      expect(await readFile(join(parent, name!, "run.json"), "utf8").then(JSON.parse)).toMatchObject({ status: "failed", failure: "boom" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("records that are off or refused", () => {
  it("records.enabled: false (the harness default): nothing is written, the result has no Record line, no records hook reaches the run", async () => {
    const h = await harness({ records: false, mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")], orcheSteps: answerScript("QUIET_ANSWER") });
    initRepo(h);
    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result!.isError).toBe(false);
    expect(textOf(result!)).toContain("QUIET_ANSWER");
    expect(textOf(result!)).not.toContain("Record:");
    expect(result!.details).not.toHaveProperty("record");
    expect(existsSync(join(h.agentDir, "orche"))).toBe(false);
    expect(git(h.cwd, "status", "--porcelain")).toBe("");

    // The run options carry no records hook, so every sub-session stays in memory.
    const seen: RunOptions[] = [];
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, run: async options => { seen.push(options); return runOrchestrated({ ...options, createRuntime: async () => h.orche.runtime, routes: { routes: {}, default: { model: h.orche.route.model } } }); } });
    h.orche.faux.setResponses(answerScript("AGAIN"));
    const outcome = await controller.run({ request: "x", cwd: h.cwd, projectTrusted: false });
    expect(outcome.report.status).toBe("done");
    expect(seen[0]).not.toHaveProperty("records");
    expect(outcome.details).not.toHaveProperty("record");
    expect(existsSync(join(h.agentDir, "orche"))).toBe(false);
  });

  it("a records directory inside the workspace is refused: nothing is written there or anywhere else", async () => {
    const dir = (cwd: string) => join(cwd, ".orche-records");
    // The config is rewritten below with the directory inside the workspace, which the harness only knows once it exists.
    const h = await harness({ mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")], orcheSteps: answerScript("REFUSED_ANSWER") });
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { dir: dir(h.cwd) } }));
    initRepo(h);
    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result!.isError).toBe(false);
    expect(textOf(result!)).not.toContain("Record:");
    expect(existsSync(dir(h.cwd))).toBe(false);
    expect(existsSync(join(h.agentDir, "orche"))).toBe(false);
    expect(git(h.cwd, "status", "--porcelain")).toBe("");
  });

  it("records.dir moves the root; the record and the Record line follow it", async () => {
    let h!: Harness;
    h = await harness({ mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")], orcheSteps: answerScript("MOVED_ANSWER") });
    const custom = join(h.agentDir, "..", "custom-records");
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { dir: custom } }));
    initRepo(h);
    await h.session.prompt("go");
    const [result] = runResults(h);
    const record = result!.details!.record as string;
    expect(record.startsWith(`${join(h.agentDir, "..", "custom-records")}/${sessionIdOf(h)}/`)).toBe(true);
    expect(textOf(result!).split("\n").at(-1)).toBe(`Record: ${record}`);
    expect(readJson(join(record, "run.json")).status).toBe("done");
    expect(existsSync(join(h.agentDir, "orche"))).toBe(false);
    await rm(custom, { recursive: true, force: true });
  });
});

describe("retention and /orche records", () => {
  it("the first run of the process prunes records older than retentionDays under the root, and nothing else", async () => {
    resetPruneOnce();
    let h!: Harness;
    h = await harness({ records: { retentionDays: 30 }, mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")], orcheSteps: answerScript("PRUNING_RUN") });
    const old = join(rootOf(h), "old-session", "2020-01-01T00-00-00-000Z_run-deadbeef");
    const recent = join(rootOf(h), "other-session", `${new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/[:.]/g, "-")}_run-cafebabe`);
    const outside = join(h.agentDir, "orche", "not-a-record", "2020-01-01T00-00-00-000Z_run-deadbeef");
    for (const path of [old, recent, outside]) { await mkdir(join(path, "sessions"), { recursive: true }); await writeFile(join(path, "run.json"), "{}\n"); }
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    for (const path of [join(old, "run.json"), join(old, "sessions"), old, outside, join(outside, "run.json"), join(outside, "sessions")]) await utimes(path, longAgo, longAgo);
    initRepo(h);
    await h.session.prompt("go");
    // Fire and forget: it finishes shortly after the run started.
    for (let attempt = 0; attempt < 100 && existsSync(old); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(outside)).toBe(true); // not a name the records layout creates: never touched
    expect(recordDirs(h)).toHaveLength(1); // this run's own record
  });

  it("/orche records lists this session's recent records, newest first, with time, kind, status, summary head and path", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("first done"), tool("orche_run", { request: "explain it again" }), reply("second done")],
      orcheSteps: [...answerScript("FIRST_ANSWER"), ...answerScript("SECOND_ANSWER")],
    });
    initRepo(h);
    expect(parseOrcheCommand(" records ")).toEqual({ mode: "records" });
    for (const bad of ["records now", "records 5", "record"]) expect(parseOrcheCommand(bad)).toBeUndefined();
    await h.session.prompt("/orche records");
    expect(h.notifications.at(-1)).toEqual({ message: "No orche records for this session.", type: "info" });

    await h.session.prompt("one");
    await h.session.prompt("two");
    // Another session's record is never listed.
    const foreign = join(rootOf(h), "another-session", "2026-10-01T00-00-00-000Z_run-0badf00d");
    await mkdir(join(foreign, "sessions"), { recursive: true });
    await writeFile(join(foreign, "run.json"), JSON.stringify({ kind: "run", status: "done", start: "2026-10-01T00:00:00.000Z", request: "FOREIGN" }));
    await h.session.prompt("/orche records");
    const message = h.notifications.at(-1)!.message;
    const dirs = recordDirs(h);
    expect(dirs).toHaveLength(2);
    expect(message.startsWith(`orche records (${rootOf(h)}):\n`)).toBe(true);
    expect(message).not.toContain("FOREIGN");
    expect(message).not.toContain("another-session");
    const lines = message.split("\n").slice(1);
    expect(lines).toHaveLength(4); // two records: the summary line and the path line each
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z {2}run {2}done/);
    expect(lines[1]).toBe(`  ${dirs[1]}`); // newest first
    expect(lines[3]).toBe(`  ${dirs[0]}`);
  });
});

describe("the Record line and details.record plumbing", () => {
  const failure = { kind: "failed" as const, status: "failed", reason: "r" };
  it("errorToolResult appends the line once for details with a record, and leaves other details alone", () => {
    expect(errorToolResult("boom", { record: "/r/1" }, failure).content).toEqual([{ type: "text", text: "boom\n\nRecord: /r/1" }]);
    expect(errorToolResult("boom\n\nRecord: /r/1", { record: "/r/1" }, failure).content).toEqual([{ type: "text", text: "boom\n\nRecord: /r/1" }]);
    expect(errorToolResult("boom", { model: "p/m" }, failure).content).toEqual([{ type: "text", text: "boom" }]);
    expect(errorToolResult("boom", { record: "/r/1" }, failure).details).toEqual({ record: "/r/1", failure });
    expect(withRecordLine("text", undefined)).toBe("text");
  });

  it("runErrorResult and formatOutcome end with the line, for failed and cancelled outcomes", () => {
    const outcome = (cancelled: boolean): OrcheOutcome => ({
      report: { status: "failed", summary: cancelled ? "cancelled" : "gave up", tasks: [], startedAt: 0, finishedAt: 2000, taskClass: "change", answer: "gave up" },
      text: cancelled ? "cancelled" : "gave up", source: { kind: "user", path: "/a/orche.config.json" }, cancelledByUser: cancelled,
      details: { status: "failed", taskClass: "change", durationMs: 2000, config: "c", ignoredConfigs: [], tasks: 0, requests: 1, inputTokens: 1, outputTokens: 1, advisorRequests: 0, models: {}, contextWindows: {}, cancelled, progress: [], record: "/r/2" },
    });
    for (const cancelled of [false, true]) {
      const result = runErrorResult(outcome(cancelled));
      const text = (result.content[0] as { text: string }).text;
      expect(text.split("\n").at(-1)).toBe("Record: /r/2");
      expect(text.match(/Record: /g)).toHaveLength(1);
      expect(result.details).toMatchObject({ record: "/r/2", failure: { kind: cancelled ? "cancelled" : "failed" } });
      expect(formatOutcome(outcome(cancelled)).endsWith("\n\nRecord: /r/2")).toBe(true);
    }
  });
});

/**
 * The recovery advice of a failed run (controller → `describeWorkspaceChanges`) knows which changed paths are submodules: a moved submodule HEAD
 * is a gitlink, which `git restore -- sub` would leave where it is, so the advice names the commit to check out inside the submodule instead.
 */
describe("a failed run's recovery advice is submodule-aware", () => {
  const GIT = ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const run = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" }).trim();

  it("a submodule whose HEAD the failed run moved gets 'git -C sub checkout <old commit>', never a restore of the gitlink path", async () => {
    const lib = await mkdtemp(join(tmpdir(), "orche-lib-"));
    scratch.push(lib);
    run(lib, "init", "-q", "-b", "main");
    await writeFile(join(lib, "file.txt"), "one\n");
    run(lib, "add", "file.txt");
    run(lib, "commit", "-qm", "lib initial");
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "set the value" }), reply("noted")],
      orcheSteps: [
        decision({ type: "classify", taskClass: "change", workerCount: 2, language: "en", reason: "explicit ownership" }),
        decision({ type: "assign", tasks: [{ id: "change", description: "set value", owner: "A1", files: ["core.mjs"], status: "pending" }] }),
        tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
        // The submodule's HEAD moves: a gitlink change in the superproject, outside the worker's ownership.
        tool("bash", { command: "echo more > sub/more.txt && git -C sub add more.txt && git -C sub -c user.name=w -c user.email=w@example.test -c commit.gpgsign=false commit -qm moved" }),
        tool("report_result", { kind: "implement", summary: "set value to 1", data: { status: "done" } }),
        tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
        decision({ type: "complete", summary: "Value changed from 0 to 1." }),
      ],
    });
    await writeFile(join(h.cwd, "core.mjs"), "export const value = 0;\n");
    run(h.cwd, "init", "-q", "-b", "main");
    run(h.cwd, "submodule", "add", "-q", lib, "sub");
    run(h.cwd, "add", "-A");
    run(h.cwd, "commit", "-qm", "init");
    const before = run(join(h.cwd, "sub"), "rev-parse", "HEAD");

    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result!.isError).toBe(true);
    const text = textOf(result!);
    const after = run(join(h.cwd, "sub"), "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(text).toContain(`submodule sub HEAD moved ${before.slice(0, 12)}\u2192${after.slice(0, 12)}; to go back: git -C sub checkout ${before}`);
    // The ineffective form is never offered: no restore command lists the gitlink path.
    const restoreLines = text.split("\n").filter(line => /^\s+git restore\b/.test(line));
    expect(restoreLines.join("\n")).toContain("core.mjs");
    expect(restoreLines.join("\n")).not.toMatch(/\bsub\b/);
  });
});
