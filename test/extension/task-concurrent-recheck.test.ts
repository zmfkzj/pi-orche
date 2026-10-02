import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheControllerOptions, type OrcheRunArgs } from "../../src/extension/controller.js";
import type { ConcurrentSession, ConcurrentSessionsResult, DetectConcurrentSessionsOptions } from "../../src/extension/concurrent-sessions.js";
import { deferred } from "../helpers/faux.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * orche_task and other pi sessions: the detection made when the task starts is repeated when it ends, before the "Changed files" note is
 * written, so a session that started while the worker ran is not missed. The re-check is answered from the start's detection while that
 * is recent (30 s by default; `concurrentRecheckMs` lowers it for tests), never fails the task, and is not made for a cancelled task.
 */
const open: Harness[] = [];
const pools = new Set<WorkerPool>();
afterEach(async () => {
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
  cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
}).trim();
const implemented = () => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done" } });
const writeAllowed = () => tool("write", { path: "allowed.txt", content: "mine\n" });
const noReport = [reply("I will not report"), reply("Still no report")];
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};

const other = (cwd: string, secondsAgo = 20): ConcurrentSession => ({ id: "other", cwd, file: "/sessions/other.jsonl", lastWriteMs: Date.now() - secondsAgo * 1000 });
/** A detector that answers `answers[n]` to its n-th call (the last one afterwards); a function answer may throw. */
const detector = (...answers: Array<ConcurrentSession[] | (() => never)>) => {
  let calls = 0;
  return vi.fn(async (_options: DetectConcurrentSessionsOptions): Promise<ConcurrentSessionsResult> => {
    const answer = answers[Math.min(calls++, answers.length - 1)]!;
    if (typeof answer === "function") answer();
    return { sessions: answer as ConcurrentSession[] };
  });
};
const WARNING = /^⚠ 1 other pi session active in this repository \(cwd [^)]*, last write (19|20|21)s ago\); their changes are classified as external where possible$/;

async function fixture(steps: FauxResponseStep[], options: { controller?: Partial<OrcheControllerOptions>; config?: object } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  open.push(h);
  git(h.cwd, "init", "-q", "-b", "main");
  git(h.cwd, "add", "greeting.txt");
  git(h.cwd, "commit", "-q", "-m", "initial");
  if (options.config) await writeFile(`${h.agentDir}/orche.config.json`, JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, ...options.config }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, ...options.controller });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  pools.add(pool);
  const execute = (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress" | "signal">> = {}) =>
    pool.execute({ role: "implement", request: "Make the change", cwd: h.cwd, projectTrusted: false, files: ["allowed.txt"], ...extra });
  return { h, controller, pool, execute };
}

describe("orche_task re-checks for other pi sessions when it ends", () => {
  it("notes a session that started during the task: warning first, note beside the changed files, details, and the check ran before the note", async () => {
    const detect = detector([], [other("/work/repo")]);
    const { h, execute } = await fixture([writeAllowed(), implemented()], { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 } });
    const updates: string[][] = [];
    const outcome = await execute({ onProgress: lines => updates.push([...lines]) });

    expect(detect).toHaveBeenCalledTimes(2); // at the start, and when the task ended
    expect(detect.mock.calls[1]![0]).toMatchObject({ cwd: h.cwd, windowMs: 10 * 60_000, sessionsDir: [`${h.agentDir}/sessions`] });
    const [warning, blank, head] = outcome.text.split("\n");
    expect(warning).toMatch(WARNING);
    expect([blank, head!.startsWith("orche task W1 (implement")]).toEqual(["", true]);
    expect(outcome.text).toContain("Changed files: allowed.txt (may include changes made by the other pi session(s); check before attributing them to this task)");
    expect(outcome.details.concurrentSessions).toMatchObject({ count: 1 });
    expect(outcome.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]);
    expect(updates.at(-1)).toEqual([]);
  });

  it("answers the end's re-check from the start's detection when that is recent (30 s by default): one detection, no warning", async () => {
    const detect = detector([], [other("/work/repo")]);
    const { execute } = await fixture([writeAllowed(), implemented()], { controller: { detectConcurrentSessions: detect } });
    const outcome = await execute();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(outcome.text).not.toContain("other pi session");
    expect(outcome.details.concurrentSessions).toBeUndefined();
    expect(outcome.text).toContain("Changed files: allowed.txt\n");
  });

  it("keeps the warning when the session found at the start has gone quiet by the end", async () => {
    const detect = detector([other("/work/repo")], []);
    const { execute } = await fixture([writeAllowed(), implemented()], { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 } });
    const outcome = await execute();
    expect(detect).toHaveBeenCalledTimes(2);
    expect(outcome.text.split("\n")[0]).toMatch(WARNING);
    expect(outcome.text).toContain("(may include changes made by the other pi session(s)");
    expect(outcome.details.concurrentSessions).toMatchObject({ count: 1 });
  });

  it("is fail-soft: a detector that throws or returns nonsense at the end changes nothing", async () => {
    for (const second of [(() => { throw new Error("detector exploded"); }) as () => never, undefined]) {
      const detect = second ? detector([], second) : vi.fn(async (): Promise<ConcurrentSessionsResult> => ({ sessions: "nope" as never }));
      const { execute } = await fixture([writeAllowed(), implemented()], { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 } });
      const outcome = await execute();
      expect(outcome.text).toContain("Changed files: allowed.txt\n");
      expect(outcome.text).not.toContain("other pi session");
      expect(outcome.details.concurrentSessions).toBeUndefined();
    }
  });

  it("is off with concurrentSessions.enabled: false", async () => {
    const detect = detector([other("/work/repo")]);
    const { execute } = await fixture([writeAllowed(), implemented()], { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 }, config: { concurrentSessions: { enabled: false } } });
    expect((await execute()).text).not.toContain("other pi session");
    expect(detect).not.toHaveBeenCalled();
  });

  it("a failed task's error and details carry what the end's re-check found", async () => {
    const detect = detector([], [other("/work/repo")]);
    const { execute } = await fixture(noReport, { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 } });
    const error = await execute().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskFailedError);
    const failed = error as TaskFailedError;
    const lines = failed.message.split("\n");
    expect(lines[0]).toMatch(WARNING);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Still no report");
    expect(failed.failure.reason).toBe("Still no report");
    expect(failed.details.concurrentSessions).toMatchObject({ count: 1 });
    expect(failed.toolResult().content[0]).toEqual({ type: "text", text: failed.message });
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("does not re-check a cancelled task", async () => {
    const detect = detector([], [other("/work/repo")]);
    const entered = deferred();
    const { controller, execute } = await fixture([blocked(entered)], { controller: { detectConcurrentSessions: detect, concurrentRecheckMs: 0 } });
    const running = execute().then(() => undefined, (caught: unknown) => caught);
    await entered.promise;
    expect(controller.cancel()).toBe(true);
    const error = await running;
    expect(error).toBeInstanceOf(TaskFailedError);
    expect((error as TaskFailedError).message).toBe("cancelled by user");
    expect((error as TaskFailedError).details.concurrentSessions).toBeUndefined();
    expect(detect).toHaveBeenCalledTimes(1); // the start only
  });
});
