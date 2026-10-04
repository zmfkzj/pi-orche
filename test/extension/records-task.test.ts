import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheControllerOptions, type OrcheRunArgs } from "../../src/extension/controller.js";
import type { ConcurrentSessionsResult, DetectConcurrentSessionsOptions } from "../../src/extension/concurrent-sessions.js";
import { resetPruneOnce } from "../../src/extension/records.js";
import { deferred } from "../helpers/faux.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * orche_task records (src/extension/records.ts): one record directory per task assignment (`<root>/<parent session>/<timestamp>_task-<id>/`
 * with its run.json), and one transcript per persistent worker, `<root>/<parent>/workers/<workerId>-<spawn time>.jsonl`, that stays the same
 * file for all of the worker's assignments and is referenced from each assignment's run.json.
 */
const open: Harness[] = [];
const pools = new Set<WorkerPool>();
afterEach(async () => {
  resetPruneOnce();
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
  cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
}).trim();
const implemented = (summary = "Done") => tool("report_result", { kind: "implement", summary, data: { status: "done" } });
const explored = (summary = "Found it") => tool("report_result", { kind: "explore", summary });
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};
const noReport = [reply("I will not report"), reply("Still no report")];

const PARENT = { id: "parent-A", file: "/sessions/parent-A.jsonl" };
const mode = (path: string) => statSync(path).mode & 0o777;
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const readJsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
const toolsCalled = (file: string): string[] => readJsonl(file)
  .filter(entry => entry.type === "message" && entry.message?.role === "assistant")
  .flatMap(entry => (entry.message.content as { type: string; name?: string }[]).filter(part => part.type === "toolCall").map(part => part.name!));
const rootOf = (h: Harness) => join(h.agentDir, "orche", "records");
const taskDirs = (h: Harness, parent = PARENT.id): string[] => {
  const dir = join(rootOf(h), parent);
  return existsSync(dir) ? readdirSync(dir).filter(name => /_task-[0-9a-f]{8}$/.test(name)).sort().map(name => join(dir, name)) : [];
};
const workerFiles = (h: Harness, parent = PARENT.id): string[] => {
  const dir = join(rootOf(h), parent, "workers");
  return existsSync(dir) ? readdirSync(dir).sort().map(name => join(dir, name)) : [];
};
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.name === ".git" ? [] : entry.isDirectory() ? [join(dir, entry.name), ...walk(join(dir, entry.name))] : [join(dir, entry.name)]);
}

async function fixture(steps: FauxResponseStep[], options: { records?: Parameters<typeof createHarness>[0]["records"]; controller?: Partial<OrcheControllerOptions> } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, records: options.records ?? true });
  open.push(h);
  git(h.cwd, "init", "-q", "-b", "main");
  git(h.cwd, "add", "greeting.txt");
  git(h.cwd, "commit", "-q", "-m", "initial");
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, ...options.controller });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  pools.add(pool);
  const args = (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress" | "signal">> = {}) =>
    ({ role: "implement" as const, request: "Make the change", cwd: h.cwd, projectTrusted: false, files: ["allowed.txt"], currentSession: PARENT, ...extra });
  return {
    h, controller, pool,
    execute: (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress" | "signal">> = {}) => pool.execute(args(extra)),
    executeTool: (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress" | "signal">> = {}) => pool.executeTool(args(extra)),
  };
}

describe("orche_task records one directory per assignment", () => {
  it("creates run.json for the task: kind, request, context, worker, assignment, outcome, agent entry, workspace; no events file", async () => {
    const { h, execute } = await fixture([tool("write", { path: "allowed.txt", content: "mine\n" }), implemented("Made the change")]);
    const outcome = await execute({ request: "Add allowed.txt", context: "The user wants it." });
    const [dir, ...others] = taskDirs(h);
    expect(others).toEqual([]);
    expect(dir).toMatch(new RegExp(`^${rootOf(h)}/parent-A/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_task-[0-9a-f]{8}$`));
    expect(outcome.details.record).toBe(dir);
    expect(outcome.text.split("\n").at(-1)).toBe(`Record: ${dir}`);
    expect(outcome.text.match(/^Record: /gm)).toHaveLength(1);

    const workerFile = workerFiles(h)[0]!;
    expect(workerFile).toMatch(new RegExp(`^${rootOf(h)}/parent-A/workers/W1-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.jsonl$`));
    const run = readJson(join(dir!, "run.json"));
    expect(run).toMatchObject({
      version: 1, kind: "task", status: "done", cwd: h.cwd, request: "Add allowed.txt", context: "The user wants it.", parentSession: PARENT,
      config: expect.stringContaining("user config"), routes: { default: { model: h.orche.route.model } },
      worker: { id: "W1", role: "implement", sessionFile: workerFile },
      assignment: { role: "implement", reusedWorker: false, files: ["allowed.txt"] },
      summary: "Made the change", outcome: { status: "done", requests: expect.any(Number), durationMs: expect.any(Number) },
      workspace: { changes: [{ path: "allowed.txt", status: "added" }], otherChanges: [] },
      files: { sessions: "sessions" },
    });
    expect(run.outcome.requests).toBeGreaterThan(0);
    expect(Date.parse(run.end)).toBeGreaterThanOrEqual(Date.parse(run.start));
    expect(run).not.toHaveProperty("failure");
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0]).toMatchObject({ id: "W1", kind: "worker", role: "implementer", model: h.orche.route.model, status: "completed", assignments: 1, sessionFile: workerFile, requests: run.outcome.requests });
    expect(existsSync(join(dir!, "events.jsonl"))).toBe(false); // the event stream belongs to orche_run
    expect(toolsCalled(workerFile)).toEqual(["write", "report_result"]);
  });

  it("keeps one stable session file for a worker's assignments, referenced from each task's run.json", async () => {
    const { h, execute, pool } = await fixture([explored("First finding"), explored("Second finding")]);
    await execute({ role: "explore", request: "Look at greeting.txt", files: undefined });
    const second = await execute({ role: "explore", request: "Look again", worker: "W1", files: undefined });
    expect(second.details.worker).toBe("W1");

    const dirs = taskDirs(h);
    expect(dirs).toHaveLength(2);
    const files = workerFiles(h);
    expect(files).toHaveLength(1); // not one file per assignment
    const runs = dirs.map(dir => readJson(join(dir, "run.json")));
    expect(runs.map(run => run.worker.sessionFile)).toEqual([files[0], files[0]]);
    expect(runs.map(run => run.agents[0].sessionFile)).toEqual([files[0], files[0]]);
    expect(runs.map(run => run.assignment.reusedWorker)).toEqual([false, true]);
    expect(runs.map(run => run.summary)).toEqual(["First finding", "Second finding"]);
    // The agent entry is the worker's lifetime: assignments and requests add up.
    expect(runs.map(run => run.agents[0].assignments)).toEqual([1, 2]);
    expect(runs[1]!.agents[0].requests).toBeGreaterThan(runs[0]!.agents[0].requests);
    expect(runs[1]!.outcome.requests).toBeLessThan(runs[1]!.agents[0].requests); // this assignment's requests, not the worker's
    // Both assignments are in that one transcript, in order.
    expect(toolsCalled(files[0]!)).toEqual(["report_result", "report_result"]);
    expect(readFileSync(files[0]!, "utf8")).toContain("First finding");
    expect(readFileSync(files[0]!, "utf8")).toContain("Second finding");
    expect(readJsonl(files[0]!).filter(entry => entry.type === "session")).toHaveLength(1);
    expect(pool.session("W1").sessionFile).toBe(files[0]);
  });

  it("gives each worker its own file, and a worker spawned again a new one", async () => {
    const { h, execute, pool } = await fixture([explored("A"), explored("B"), explored("C")]);
    await execute({ role: "explore", files: undefined });
    await execute({ role: "explore", files: undefined });
    expect(workerFiles(h).map(file => file.split("/").at(-1)!.split("-")[0])).toEqual(["W1", "W2"]);
    await pool.stop("W1");
    await execute({ role: "explore", files: undefined });
    const files = workerFiles(h);
    expect(files.map(file => file.split("/").at(-1)!.split("-")[0])).toEqual(["W1", "W2", "W3"]);
    expect(new Set(files).size).toBe(3);
    // A retired worker's transcript stays what it was.
    expect(toolsCalled(files[0]!)).toEqual(["report_result"]);
    expect(taskDirs(h)).toHaveLength(3);
  });

  it("uses private permissions: directories 0700, files 0600", async () => {
    const { h, execute } = await fixture([explored()]);
    await execute({ role: "explore", files: undefined });
    const [dir] = taskDirs(h);
    for (const path of [join(h.agentDir, "orche"), rootOf(h), join(rootOf(h), PARENT.id), dir!, join(dir!, "sessions"), join(rootOf(h), PARENT.id, "workers")]) expect(mode(path), path).toBe(0o700);
    for (const file of [join(dir!, "run.json"), ...workerFiles(h)]) expect(mode(file), file).toBe(0o600);
  });

  it("writes nothing into the workspace", async () => {
    const { h, execute } = await fixture([tool("write", { path: "allowed.txt", content: "mine\n" }), implemented()]);
    await execute();
    // The only change in the work tree is the worker's own file.
    expect(git(h.cwd, "status", "--porcelain")).toBe("?? allowed.txt");
    expect(walk(h.cwd).map(path => path.slice(h.cwd.length + 1)).sort()).toEqual(["allowed.txt", "greeting.txt"]);
  });

  it("uses no-session as the parent when the calling session is unknown", async () => {
    const { h, pool } = await fixture([explored()]);
    const outcome = await pool.execute({ role: "explore", request: "Look", cwd: h.cwd, projectTrusted: false }); // no currentSession
    expect(outcome.details.record!.startsWith(join(rootOf(h), "no-session") + "/")).toBe(true);
    expect(readJson(join(outcome.details.record!, "run.json"))).not.toHaveProperty("parentSession");
    expect(workerFiles(h, "no-session")).toHaveLength(1);
  });
});

describe("orche_task failures and cancellation are recorded and carry the Record", () => {
  it("a worker that ends without a result: run.json failed with the failure; the error result and its details point to the record", async () => {
    const { h, executeTool, execute } = await fixture(noReport);
    const result = await executeTool({ role: "explore", files: undefined });
    const [dir] = taskDirs(h);
    expect(result).toMatchObject({ isError: true, details: { worker: "W1", status: "no_result", record: dir, failure: { kind: "failed", status: "no_result", reason: "Still no report" } } });
    expect(result.content).toEqual([{ type: "text", text: `Still no report\n\nRecord: ${dir}` }]);
    const run = readJson(join(dir!, "run.json"));
    expect(run).toMatchObject({ kind: "task", status: "failed", failure: "Still no report", outcome: { status: "no_result" } });
    expect(Date.parse(run.end)).toBeGreaterThanOrEqual(Date.parse(run.start));
    expect(run.agents[0]).toMatchObject({ id: "W1", sessionFile: workerFiles(h)[0], requests: expect.any(Number) });
    expect(run.agents[0].requests).toBeGreaterThanOrEqual(1); // the cost of the failed task is in the record

    // execute() rejects with the message a plain error had: the line is part of the tool result only.
    h.orche.faux.setResponses(noReport);
    const error = await execute({ role: "explore", files: undefined, worker: "W1" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskFailedError);
    expect((error as TaskFailedError).message).toBe("Still no report");
    expect((error as TaskFailedError).details.record).toBe(taskDirs(h)[1]);
  });

  it("a cancelled task: run.json cancelled; the worker's transcript exists", async () => {
    const entered = deferred();
    const { h, controller, execute } = await fixture([blocked(entered)]);
    const running = execute({ role: "explore", files: undefined }).then(() => undefined, (caught: unknown) => caught);
    await entered.promise;
    expect(controller.cancel()).toBe(true);
    const error = await running as TaskFailedError;
    expect(error).toBeInstanceOf(TaskFailedError);
    const [dir] = taskDirs(h);
    expect(error.details.record).toBe(dir);
    expect(error.toolResult().content).toEqual([{ type: "text", text: `cancelled by user\n\nRecord: ${dir}` }]);
    expect(readJson(join(dir!, "run.json"))).toMatchObject({ kind: "task", status: "cancelled", failure: "cancelled", cancelledByUser: true, outcome: { status: "cancelled" } });
    expect(readJsonl(workerFiles(h)[0]!)[0]).toMatchObject({ type: "session" });
  });

  it("errors before a worker ran stay plain errors and leave no record", async () => {
    const { h, execute } = await fixture([]);
    await expect(execute({ role: "explore", files: undefined, worker: "W9" })).rejects.toThrow(/Unknown worker W9/);
    await expect(execute({ role: "explore", files: undefined, git: { commit: true } })).rejects.toThrow(/Unsupported git grant for role explore/);
    expect(taskDirs(h)).toEqual([]);
    expect(workerFiles(h)).toEqual([]);
  });
});

describe("orche_task with records off or refused", () => {
  it("records.enabled: false: workers stay in memory, nothing is written, results carry no Record", async () => {
    const { h, execute, executeTool, pool } = await fixture([explored(), tool("report_result", { kind: "explore", summary: "x" })], { records: false });
    const outcome = await execute({ role: "explore", files: undefined });
    expect(outcome.details).not.toHaveProperty("record");
    expect(outcome.text).not.toContain("Record:");
    expect(pool.session("W1").sessionFile).toBeUndefined(); // an in-memory session
    expect(existsSync(join(h.agentDir, "orche"))).toBe(false);
    h.orche.faux.setResponses(noReport);
    const failed = await executeTool({ role: "explore", files: undefined, worker: "W1" });
    expect(failed).toMatchObject({ isError: true, content: [{ type: "text", text: "Still no report" }] });
    expect(failed.details).not.toHaveProperty("record");
  });

  it("a records directory inside the workspace is refused: nothing is written", async () => {
    const { h, execute, pool } = await fixture([explored()], { records: false });
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { dir: join(h.cwd, "records") } }));
    const outcome = await execute({ role: "explore", files: undefined });
    expect(outcome.details).not.toHaveProperty("record");
    expect(pool.session("W1").sessionFile).toBeUndefined();
    expect(existsSync(join(h.cwd, "records"))).toBe(false);
    expect(git(h.cwd, "status", "--porcelain")).toBe("");
  });
});

describe("the records root is kept out of concurrent-session detection", () => {
  const none = () => vi.fn(async (_options: DetectConcurrentSessionsOptions): Promise<ConcurrentSessionsResult> => ({ sessions: [] }));

  it("orche_task hands the root to the detector as an ignored path (at the start and at the end)", async () => {
    const detect = none();
    const { h, execute } = await fixture([explored()], { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 } });
    await execute({ role: "explore", files: undefined });
    expect(detect).toHaveBeenCalledTimes(2);
    for (const [options] of detect.mock.calls) expect(options.ignorePaths).toEqual([rootOf(h)]);
  });

  it("orche_run hands it over too, and the detector is not asked to ignore anything when records are off", async () => {
    const root = vi.fn();
    const detect = none();
    const { h, controller } = await fixture([], { controller: { detectConcurrentSessions: detect, run: async options => { root(options.detectConcurrentActivity ? "callback" : "none"); await options.detectConcurrentActivity?.(); return { status: "done", summary: "s", tasks: [], startedAt: 0, finishedAt: 1, taskClass: "answer", answer: "a" }; }, concurrentRecheckMs: 0 } });
    const outcome = await controller.run({ request: "x", cwd: h.cwd, projectTrusted: false, currentSession: PARENT });
    expect(root).toHaveBeenCalledWith("callback");
    expect(detect).toHaveBeenCalledTimes(2); // the start, and the callback's re-check
    for (const [options] of detect.mock.calls) expect(options.ignorePaths).toEqual([rootOf(h)]);
    expect(outcome.details.record!.startsWith(join(rootOf(h), PARENT.id) + "/")).toBe(true);

    const off = none();
    const quiet = await fixture([explored()], { records: false, controller: { detectConcurrentSessions: off } });
    await quiet.execute({ role: "explore", files: undefined });
    expect(off.mock.calls[0]![0]).not.toHaveProperty("ignorePaths");
  });
});

describe("through the registered orche_task tool", () => {
  it("a success and a failure both end with the Record line and carry details.record", async () => {
    const h = await createHarness({
      records: true,
      mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt" }), reply("first ok"), tool("orche_task", { role: "explore", request: "Inspect again", worker: "W1" }), reply("second ok")],
      orcheSteps: [explored("Evidence found"), ...noReport],
    });
    open.push(h);
    await h.session.prompt("investigate");
    await h.session.prompt("again");
    const results = h.session.messages.flatMap(message => message.role === "toolResult" && message.toolName === "orche_task" ? [message as unknown as { isError: boolean; content: { text: string }[]; details: Record<string, any> }] : []);
    expect(results).toHaveLength(2);
    const parent = h.session.sessionManager.getSessionId();
    const dirs = readdirSync(join(rootOf(h), parent)).filter(name => name.includes("_task-")).sort().map(name => join(rootOf(h), parent, name));
    expect(dirs).toHaveLength(2);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.content[0]!.text.split("\n").at(-1)).toBe(`Record: ${dirs[0]}`);
    expect(results[0]!.details).toMatchObject({ worker: "W1", record: dirs[0] });
    expect(results[1]!.isError).toBe(true);
    const fallbackWarning = `Warning: main model ${h.main.route.model} is unresolvable in orche's runtime; falling back to configured route ${h.orche.route.model}.`;
    expect(results[1]!.content[0]!.text).toBe(`Still no report\n${fallbackWarning}\n\nRecord: ${dirs[1]}`);
    expect(results[1]!.details.warnings).toEqual([fallbackWarning]);
    expect(results[1]!.details).toMatchObject({ status: "no_result", record: dirs[1], failure: { kind: "failed" } });
    expect(readJson(join(dirs[0]!, "run.json")).worker.sessionFile).toBe(readJson(join(dirs[1]!, "run.json")).worker.sessionFile);
    expect(readJson(join(dirs[0]!, "run.json")).parentSession).toEqual({ id: parent });
  });
});
