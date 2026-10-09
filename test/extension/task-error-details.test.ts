import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool, type TaskDetails, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheControllerOptions, type OrcheRunArgs } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

/**
 * orche_task failures that keep their details. A task whose worker ran but did not complete (no result, failure, timeout,
 * cancellation) rejects with a TaskFailedError that carries the structured TaskDetails, and WorkerPool.executeTool() turns
 * it into an `isError: true` tool result that keeps them (a plain throw would be recorded with `details: {}`). Errors before
 * a worker ran stay plain errors.
 */
const open: Harness[] = [];
const pools = new Set<WorkerPool>();
afterEach(async () => {
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});

const identity = { GIT_AUTHOR_NAME: "tester", GIT_AUTHOR_EMAIL: "tester@example.test", GIT_COMMITTER_NAME: "tester", GIT_COMMITTER_EMAIL: "tester@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();
const COMMIT = "git -c user.name=worker -c user.email=worker@example.test -c commit.gpgsign=false commit -q";
const result = (role = "explore", summary = "Evidence found", data?: ToolCall["arguments"][string]) => tool("report_result", { kind: role, summary, ...(data === undefined ? {} : { data }) });
/** A worker that never calls report_result: it is nudged once, then the assignment ends without a result. */
const noReport = [reply("I will not report"), reply("Still no report")];
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};
/** A scripted step that first writes `files` (another process, no worker tool running), then answers with `next`. */
const externally = (cwd: () => string, files: Record<string, string>, next: FauxResponseStep): FauxResponseStep => (context, options, state, model) => {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd(), path), content);
  return typeof next === "function" ? next(context, options, state, model) : next;
};

async function fixture(steps: (cwd: () => string) => FauxResponseStep[], options: { controller?: Partial<OrcheControllerOptions>; limits?: Record<string, number> } = {}) {
  let cwd = "";
  const h = await createHarness({ mainSteps: [], orcheSteps: steps(() => cwd) });
  open.push(h);
  cwd = h.cwd;
  git(h.cwd, "init", "-q", "-b", "main");
  git(h.cwd, "add", "greeting.txt");
  git(h.cwd, "commit", "-q", "-m", "initial");
  if (options.limits) await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, limits: options.limits }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, ...options.controller });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  pools.add(pool);
  const args = (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress">> = {}, signal?: AbortSignal) => ({ role: "explore" as const, request: "Find the evidence", cwd: h.cwd, projectTrusted: false, ...extra, signal });
  const execute = (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress">> = {}, signal?: AbortSignal) => pool.execute(args(extra, signal));
  const executeTool = (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress">> = {}, signal?: AbortSignal) => pool.executeTool(args(extra, signal));
  return { h, pool, controller, execute, executeTool };
}
/** The rejection of `promise`, which must be a TaskFailedError. */
async function failure(promise: Promise<unknown>): Promise<TaskFailedError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TaskFailedError);
  return error as TaskFailedError;
}
const plain = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(TaskFailedError);
  return error as Error;
};

describe("orche_task failure keeps its details", () => {
  it("a worker that ends without a result is a TaskFailedError with the same message as before and structured details", async () => {
    const { h, execute } = await fixture(() => noReport);
    const error = await failure(execute());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Still no report"); // the text a plain throw had: the worker's last words
    expect(error.details).toMatchObject({
      worker: "W1", role: "explore", status: "no_result", model: h.orche.route.model, changes: [], otherChanges: [],
      durationMs: expect.any(Number), requests: expect.any(Number),
    });
    expect(error.details.requests).toBeGreaterThanOrEqual(1);
    expect(error.details.roster).toContain("W1");
    expect(error.failure).toEqual({ kind: "failed", status: "no_result", reason: "Still no report" });
    expect(Object.keys(error.details).length).toBeGreaterThan(5);
  });

  it("toolResult() is an isError result with that message as content and the details plus the failure summary", async () => {
    const { execute } = await fixture(() => noReport);
    const error = await failure(execute());
    const toolResult = error.toolResult();
    expect(toolResult).toEqual({
      content: [{ type: "text", text: "Still no report" }],
      details: { ...error.details, failure: { kind: "failed", status: "no_result", reason: "Still no report" } },
      isError: true,
    });
  });

  it("executeTool returns the failure as an error result with non-empty details, and a success as a plain result", async () => {
    const failing = await fixture(() => noReport);
    const errored = await failing.executeTool();
    expect(errored).toMatchObject({ isError: true, content: [{ type: "text", text: "Still no report" }], details: { worker: "W1", role: "explore", status: "no_result", failure: { kind: "failed", status: "no_result" } } });
    expect(Object.keys(errored.details!).length).toBeGreaterThan(5);

    const ok = await fixture(() => [result()]);
    const done = await ok.executeTool();
    expect(done).not.toHaveProperty("isError");
    expect(done.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Evidence found") });
    expect(done.details).toMatchObject({ worker: "W1", status: "completed", changes: [], otherChanges: [] });
    expect(done.details).not.toHaveProperty("failure");
  });

  it("the details of a failed task say what the worker did: files it wrote, other changes, and a commit", async () => {
    const { h, execute } = await fixture(cwd => [
      externally(cwd, { "external.txt": "someone else\n" }, tool("write", { path: "allowed.txt", content: "mine\n" })),
      tool("bash", { command: `git add allowed.txt && ${COMMIT} -m "Add allowed"` }),
      ...noReport,
    ]);
    const before = git(h.cwd, "rev-parse", "HEAD");
    const error = await failure(execute({ role: "implement", files: ["allowed.txt"] }));
    const after = git(h.cwd, "rev-parse", "HEAD");
    expect(error.message).toBe("Still no report");
    expect(error.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]);
    expect(error.details.otherChanges).toEqual([{ path: "external.txt", status: "added", reason: "changed while no worker tool was running" }]);
    expect(error.details.headMoved).toMatchObject({ from: before, to: after, commitCount: 1 });
    expect(error.details).not.toHaveProperty("git"); // no grant
  });

  it("with a git grant the failure details carry the git report too", async () => {
    const { execute } = await fixture(() => [tool("bash", { command: `${COMMIT} --allow-empty -m "granted"` }), ...noReport]);
    const error = await failure(execute({ role: "implement", git: { commit: true } }));
    expect(error.details.git).toMatchObject({ available: true, commitCount: 1, grant: { commit: true, push: false } });
    expect(error.details.headMoved).toMatchObject({ commitCount: 1 });
  });

  it("a failed worker assignment (schema failures exhaust the retries) keeps its details too", async () => {
    // game-asset needs outputs and evidence in data: three rejected reports fail the assignment.
    const bad = () => result("game-asset", "Malformed", { status: "done" });
    const { execute } = await fixture(() => [bad(), bad(), bad(), bad(), bad()]);
    const error = await failure(execute({ role: "game-asset", files: [] }));
    expect(error.failure).toMatchObject({ kind: "failed", status: "failed" });
    expect(error.details).toMatchObject({ role: "game-asset", status: "failed", worker: "W1" });
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("a timed-out assignment is a failure with the timeout status, and the worker is idle again", async () => {
    const entered = deferred();
    // A worker waiting for the model counts as active, so with the default extension budget this wait would be extended: this test is about the plain timeout (see task-extension.test.ts).
    const { pool, execute } = await fixture(() => [blocked(entered)], { limits: { assignmentMs: 150, maxExtensions: 0 } });
    const error = await failure(execute());
    const [headline, ...rest] = error.message.split("\n");
    expect(headline).toBe("Worker W1 timed out after 150ms");
    // The resume guidance follows: the same worker is retained with its context, and no Task DAG was recorded.
    expect(rest).toEqual([expect.stringMatching(/^Checkpoint at the timeout: no Task DAG was recorded in this assignment\./), expect.stringMatching(/^Resume: a timeout is not an unmet result .* W1 stays idle with its context until about .* \(idle expiry 30 min\).* Continue with orche_task worker "W1", handing over only the remaining work\. Once W1 is gone, pass worker "W1": a new worker is briefed from its transcript and last record; its unrecorded context is lost\.$/)]);
    expect(error.failure).toEqual({ kind: "failed", status: "timeout", reason: "Worker W1 timed out after 150ms" });
    expect(error.details.resume).toEqual({ worker: "W1", retainedUntil: expect.any(Number) });
    expect(error.details).toMatchObject({ worker: "W1", status: "timeout", changes: [], otherChanges: [] });
    expect(pool.list()[0]?.status).toBe("idle");
  });

  it("prefixes the concurrent-session warning to the message and the result text, not to the failure reason", async () => {
    const other = { id: "other", cwd: "/work/repo", file: "/sessions/other.jsonl", lastWriteMs: Date.now() - 20_000 };
    const { execute } = await fixture(() => noReport, { controller: { detectConcurrentSessions: async () => ({ sessions: [other] }) } });
    const error = await failure(execute());
    const lines = error.message.split("\n");
    expect(lines[0]).toMatch(/^⚠ 1 other pi session active in this repository/);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Still no report");
    expect(error.toolResult().content[0]).toEqual({ type: "text", text: error.message });
    expect(error.failure.reason).toBe("Still no report");
    expect(error.details.concurrentSessions).toMatchObject({ count: 1 });
  });
});

describe("orche_task cancellation keeps its details", () => {
  it("/orche cancel: the same 'cancelled by user' error, with the details of the worker that was running", async () => {
    const entered = deferred();
    const { controller, pool, execute, executeTool } = await fixture(() => [blocked(entered), result("explore", "Reused after cancellation")]);
    const running = execute().then(() => undefined, (caught: unknown) => caught);
    await entered.promise;
    expect(controller.cancel()).toBe(true);
    const error = await running;
    expect(error).toBeInstanceOf(TaskFailedError);
    const failed = error as TaskFailedError;
    expect(failed.message).toBe("cancelled by user");
    expect(failed.failure).toEqual({ kind: "cancelled", status: "cancelled", reason: "cancelled by user", cancelledByUser: true });
    expect(failed.details).toMatchObject({ worker: "W1", role: "explore", status: "cancelled", durationMs: expect.any(Number), requests: expect.any(Number), changes: [], otherChanges: [] });
    expect(pool.list()[0]?.status).toBe("idle");
    expect(failed.toolResult()).toMatchObject({ isError: true, content: [{ type: "text", text: "cancelled by user" }], details: { worker: "W1", failure: { kind: "cancelled", cancelledByUser: true } } });

    // The worker is reusable after the cancellation.
    const next = await executeTool({ worker: "W1" });
    expect(next).not.toHaveProperty("isError");
    expect(next.content[0]).toMatchObject({ text: expect.stringContaining("Reused after cancellation") });
  });

  it("the tool's abort signal: 'cancelled', not by the user", async () => {
    const entered = deferred();
    const { execute } = await fixture(() => [blocked(entered)]);
    const abort = new AbortController();
    const running = execute({}, abort.signal).then(() => undefined, (caught: unknown) => caught);
    await entered.promise;
    abort.abort();
    const error = await running;
    expect(error).toBeInstanceOf(TaskFailedError);
    const failed = error as TaskFailedError;
    expect(failed.message).toBe("cancelled");
    expect(failed.failure).toEqual({ kind: "cancelled", status: "cancelled", reason: "cancelled" });
    expect(failed.details).toMatchObject({ worker: "W1", status: "cancelled" });
  });

  it("a worker's files written before the cancellation are in the details", async () => {
    const entered = deferred();
    const { controller, execute } = await fixture(() => [tool("write", { path: "allowed.txt", content: "mine\n" }), blocked(entered)]);
    const running = execute({ role: "implement", files: ["allowed.txt"] }).then(() => undefined, (caught: unknown) => caught);
    await entered.promise;
    controller.cancel();
    const failed = (await running) as TaskFailedError;
    expect(failed).toBeInstanceOf(TaskFailedError);
    expect(failed.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]);
  });

  it("a task cancelled just after its worker completed is still the cancelled error, with the completed task's details", async () => {
    const { controller, execute } = await fixture(() => []);
    const details = { worker: "W1", role: "explore", status: "completed", durationMs: 5, requests: 2, changes: [], otherChanges: [], roster: "W1 idle" } as TaskDetails;
    vi.spyOn(WorkerPool.prototype as unknown as { executeAssignment(): Promise<unknown> }, "executeAssignment").mockImplementation(async () => {
      controller.cancel();
      return { text: "done", details };
    });
    const error = await failure(execute());
    expect(error.message).toBe("cancelled by user");
    expect(error.details).toMatchObject({ ...details, status: "cancelled" });
    expect(error.failure).toMatchObject({ kind: "cancelled", cancelledByUser: true });
  });
});

describe("orche_task errors that are not failures of a worker stay plain", () => {
  it("rejects invalid arguments and unknown workers with plain errors, from execute and executeTool", async () => {
    const { pool, execute, executeTool } = await fixture(() => [result()]);
    expect((await plain(execute({ role: "explore", git: { commit: true } }))).message).toContain("Unsupported git grant for role explore");
    expect((await plain(execute({ role: "implement", files: ["src/*.ts"] }))).message).toContain("Unsupported ownership path");
    expect((await plain(execute({ worker: "W9" }))).message).toContain("Unknown worker W9");
    expect((await plain(executeTool({ worker: "W9" }))).message).toContain("Unknown worker W9");
    expect((await plain(executeTool({ role: "explore", git: { commit: true } }))).message).toContain("Unsupported git grant");
    expect(pool.list()).toEqual([]); // nothing was spawned
  });

  it("a busy controller and a disposed pool are plain errors", async () => {
    const entered = deferred();
    const { controller, pool, execute } = await fixture(() => [blocked(entered)]);
    const running = execute().then(() => undefined, (caught: unknown) => caught);
    await entered.promise;
    expect((await plain(execute())).message).toContain("already active");
    controller.cancel();
    expect(await running).toBeInstanceOf(TaskFailedError);
    await pool.dispose();
    expect((await plain(execute())).message).toBe("Worker pool is disposed");
  });

  it("cancelling before any worker ran is a plain 'cancelled'", async () => {
    const { execute } = await fixture(() => [result()]);
    const abort = new AbortController();
    abort.abort();
    expect((await plain(execute({}, abort.signal))).message).toBe("cancelled");
  });

  it("a worker that completed and reported blocked or a failed verification still resolves, not an error", async () => {
    const blockedReport = await fixture(() => [result("implement", "Cannot proceed", { status: "blocked", reason: "dependency absent" })]);
    const outcome = await blockedReport.execute({ role: "implement" });
    expect(outcome.details).toMatchObject({ status: "blocked" });
    expect(outcome.text).toContain("Note: follow up with the same worker — the worker reported blocked");
    const asTool = await (await fixture(() => [result("verify", "Failed", { passed: false })])).executeTool({ role: "verify" });
    expect(asTool).not.toHaveProperty("isError");
  });
});

describe("orche_task through the registered tool", () => {
  interface ToolResultMessage { role: "toolResult"; toolName: string; isError: boolean; content: { type: string; text: string }[]; details?: Record<string, any> }
  const taskResults = (h: Harness) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === "orche_task") as unknown as ToolResultMessage[];
  const session = async (mainSteps: FauxResponseStep[], orcheSteps: FauxResponseStep[]) => {
    const h = await createHarness({ mainSteps, orcheSteps });
    open.push(h);
    git(h.cwd, "init", "-q");
    return h;
  };

  it("a failed task is an error to the model with its failure, fallback warning AND structured details", async () => {
    const h = await session([tool("orche_task", { role: "explore", request: "Find the evidence" }), reply("noted")], noReport);
    await h.session.prompt("investigate");
    const [taskResult] = taskResults(h);
    expect(taskResult).toMatchObject({ isError: true });
    const fallbackWarning = `Warning: main model ${h.main.route.model} is unresolvable in orche's runtime; falling back to configured route ${h.orche.route.model}.`;
    expect(taskResult!.content).toEqual([{ type: "text", text: `Still no report\n${fallbackWarning}` }]);
    expect(taskResult!.details!.warnings).toEqual([fallbackWarning]);
    expect(taskResult!.details).toMatchObject({
      worker: "W1", role: "explore", status: "no_result", model: h.orche.route.model, durationMs: expect.any(Number), requests: expect.any(Number),
      changes: [], otherChanges: [], roster: expect.stringContaining("W1"),
      failure: { kind: "failed", status: "no_result", reason: "Still no report" },
    });
    expect(Object.keys(taskResult!.details!).length).toBeGreaterThan(5);
  });

  it("a failed implement task keeps what the worker changed in the details the model gets", async () => {
    const h = await session([tool("orche_task", { role: "implement", request: "Add allowed.txt", files: ["allowed.txt"] }), reply("noted")], [tool("write", { path: "allowed.txt", content: "mine\n" }), ...noReport]);
    await h.session.prompt("implement");
    const [taskResult] = taskResults(h);
    expect(taskResult).toMatchObject({ isError: true, details: { worker: "W1", role: "implement", changes: [{ path: "allowed.txt", status: "added" }], failure: { kind: "failed", status: "no_result" } } });
  });

  it("a task that succeeds is a plain result with its details and no failure", async () => {
    const h = await session([tool("orche_task", { role: "explore", request: "Find the evidence" }), reply("noted")], [result()]);
    await h.session.prompt("investigate");
    const [taskResult] = taskResults(h);
    expect(taskResult).toMatchObject({ isError: false, details: { worker: "W1", status: "completed", changes: [], otherChanges: [] } });
    expect(taskResult!.details).not.toHaveProperty("failure");
    expect(taskResult!.content[0]!.text).toContain("Evidence found");
  });

  it("a cancelled task (/orche cancel) is an error with 'cancelled by user' and the cancellation details", async () => {
    const entered = deferred();
    const h = await session([tool("orche_task", { role: "explore", request: "long task" }), reply("cancel acknowledged")], [blocked(entered)]);
    const running = h.session.prompt("start task");
    await entered.promise;
    await h.session.prompt("/orche cancel");
    await running;
    const [taskResult] = taskResults(h);
    expect(taskResult).toMatchObject({ isError: true });
    expect(taskResult!.content).toEqual([{ type: "text", text: "cancelled by user" }]);
    expect(taskResult!.details).toMatchObject({
      worker: "W1", role: "explore", status: "cancelled", durationMs: expect.any(Number), requests: expect.any(Number),
      failure: { kind: "cancelled", status: "cancelled", reason: "cancelled by user", cancelledByUser: true },
    });
  });

  it("argument validation and pre-worker errors are still thrown: an error without details", async () => {
    const h = await session([
      tool("orche_task", { role: "explore", request: "look", git: { commit: true } }),
      tool("orche_task", { role: "explore", request: "look", worker: "W9" }),
      reply("noted"),
    ], []);
    await h.session.prompt("validate");
    const [grant, unknown] = taskResults(h);
    expect(grant).toMatchObject({ isError: true });
    expect(grant!.content[0]!.text).toContain("Unsupported git grant for role explore");
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown!.content[0]!.text).toContain("Unknown worker W9");
    for (const taskResult of [grant!, unknown!]) {
      expect(taskResult.details).toEqual({}); // no worker ran: nothing structured to keep
      expect(taskResult.details).not.toHaveProperty("failure");
    }
  });
});
