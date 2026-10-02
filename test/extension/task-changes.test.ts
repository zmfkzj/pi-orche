import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { formatTaskChanges, WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheControllerOptions, type OrcheRunArgs } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * orche_task "Changed files": who changed what. Real temporary git repositories with a submodule (`sub`, holding
 * file.txt), a faux worker model whose scripted steps write files, run bash and, between tool calls, play "another
 * session" by writing files while no worker tool is in flight.
 */
const open: Harness[] = [];
const pools = new Set<WorkerPool>();
const scratch: string[] = [];
afterEach(async () => {
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const identity = { GIT_AUTHOR_NAME: "tester", GIT_AUTHOR_EMAIL: "tester@example.test", GIT_COMMITTER_NAME: "tester", GIT_COMMITTER_EMAIL: "tester@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();
/** The identity is explicit so a worker's bash commit needs no user git config. */
const GIT_ID = "-c user.name=worker -c user.email=worker@example.test -c commit.gpgsign=false";
const COMMIT = `git ${GIT_ID} commit -q`;
const SUB_COMMIT = `git -C sub ${GIT_ID} commit -q`;
const result = (role = "implement", summary = "Done", data?: ToolCall["arguments"][string]) =>
  tool("report_result", { kind: role, summary, ...(data !== undefined ? { data } : role === "implement" ? { data: { status: "done" } } : {}) });
const readOnlyResult = (role: "explore" | "answer" | "verify") =>
  role === "answer" ? result(role, "Answer", { evidence: ["x"] }) : role === "verify" ? result(role, "Checked", { passed: true }) : result(role, "Found");

async function fixture(steps: (cwd: () => string) => FauxResponseStep[], options: { submodule?: boolean; idleTtlMs?: number; controller?: Partial<OrcheControllerOptions> } = {}) {
  let cwd = "";
  const h = await createHarness({ mainSteps: [], orcheSteps: steps(() => cwd) });
  open.push(h);
  cwd = h.cwd;
  git(h.cwd, "init", "-q", "-b", "main");
  if (options.submodule !== false) {
    const lib = await mkdtemp(join(tmpdir(), "orche-lib-"));
    scratch.push(lib);
    git(lib, "init", "-q", "-b", "main");
    writeFileSync(join(lib, "file.txt"), "one\n");
    git(lib, "add", "file.txt");
    git(lib, "commit", "-q", "-m", "lib initial");
    git(h.cwd, "submodule", "add", "-q", lib, "sub");
  }
  git(h.cwd, "add", "-A");
  git(h.cwd, "commit", "-q", "-m", "initial");
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, ...options.controller });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, idleTtlMs: options.idleTtlMs });
  pools.add(pool);
  const execute = (args: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress" | "cwd">> = {}) => pool.execute({ role: "implement", request: "Make the change", cwd: h.cwd, projectTrusted: false, ...args });
  return { h, pool, execute };
}
/** A scripted step that first writes `files` (another process, no worker tool running), then answers with `next`. */
const externally = (cwd: () => string, files: Record<string, string>, next: FauxResponseStep): FauxResponseStep => (context, options, state, model) => {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd(), path), content);
  return typeof next === "function" ? next(context, options, state, model) : next;
};

describe("orche_task changes: attribution", () => {
  it("(i) lists a worker's edit inside a submodule as sub/file among the changes made by the worker", async () => {
    const { execute } = await fixture(() => [tool("write", { path: "sub/file.txt", content: "two\n" }), tool("write", { path: "sub/created.txt", content: "new\n" }), result()]);
    const outcome = await execute({ files: ["sub/file.txt", "sub/created.txt"] });
    expect(outcome.details.changes).toEqual([{ path: "sub/created.txt", status: "added" }, { path: "sub/file.txt", status: "modified" }]);
    expect(outcome.details.otherChanges).toEqual([]);
    expect(outcome.details).not.toHaveProperty("submodules"); // no submodule HEAD moved
    expect(outcome.details).not.toHaveProperty("headMoved");
    expect(outcome.text).toContain("Changed files: sub/created.txt, sub/file.txt");
    expect(outcome.text).not.toContain("Other workspace changes");
    expect(outcome.text).not.toContain("No files changed");
  });

  it("(i) a submodule edit made through bash is the worker's too (its tool call was in flight)", async () => {
    const { execute } = await fixture(() => [tool("bash", { command: "echo more >> sub/file.txt && echo x > top-level.txt" }), result()]);
    const outcome = await execute({ files: ["sub/", "top-level.txt"] });
    expect(outcome.details.changes).toEqual([{ path: "sub/file.txt", status: "modified" }, { path: "top-level.txt", status: "added" }]);
    expect(outcome.details.otherChanges).toEqual([]);
  });

  it("(ii) a file written while no worker tool is in flight is listed under other changes, not as the worker's", async () => {
    const { execute } = await fixture(cwd => [
      externally(cwd, { "external.txt": "someone else\n", "sub/file.txt": "edited by someone else\n" }, tool("write", { path: "allowed.txt", content: "mine\n" })),
      result(),
    ]);
    const outcome = await execute({ files: ["allowed.txt"] });
    expect(outcome.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]);
    expect(outcome.details.otherChanges).toEqual([
      { path: "external.txt", status: "added", reason: "changed while no worker tool was running" },
      { path: "sub/file.txt", status: "modified", reason: "changed while no worker tool was running" },
    ]);
    const lines = outcome.text.split("\n");
    expect(lines).toContain("Changed files: allowed.txt");
    expect(lines).toContain("Other workspace changes observed during the task (not attributed to this worker; they may come from other sessions or processes): external.txt, sub/file.txt");
    expect(outcome.text).not.toContain("No files changed");
  });

  it("(ii) a late external write after the last tool call is not the worker's either", async () => {
    const { execute } = await fixture(cwd => [
      tool("write", { path: "allowed.txt", content: "mine\n" }),
      externally(cwd, { "late.txt": "after the last tool call\n" }, result()),
    ]);
    const outcome = await execute({ files: ["allowed.txt"] });
    expect(outcome.details.changes.map(change => change.path)).toEqual(["allowed.txt"]);
    expect(outcome.details.otherChanges.map(change => change.path)).toEqual(["late.txt"]);
  });

  it("(ii) with only external changes the worker has none and 'No files changed' is not said", async () => {
    const { execute } = await fixture(cwd => [externally(cwd, { "external.txt": "x\n" }, tool("write", { path: "blocked.txt", content: "mine\n" })), result()]);
    const outcome = await execute({ files: ["nothing-written.txt"] }); // the write above is blocked: outside the scope
    expect(outcome.details.changes).toEqual([]);
    expect(outcome.details.otherChanges.map(change => change.path)).toEqual(["external.txt"]);
    expect(outcome.text).toContain("Changed files: none attributed to this worker");
    expect(outcome.text).toContain("external.txt");
    expect(outcome.text).not.toContain("No files changed");
  });

  it.each(["explore", "answer", "verify"] as const)("(iii) a read-only %s worker never lists files as its own changes", async role => {
    const { execute } = await fixture(cwd => [
      externally(cwd, { "external.txt": "someone else\n", "sub/file.txt": "someone else in sub\n" }, tool("bash", { command: "echo hi > from-shell.txt" })),
      readOnlyResult(role),
    ]);
    const outcome = await execute({ role });
    expect(outcome.details.changes).toEqual([]);
    expect(outcome.details.otherChanges.map(change => change.path)).toEqual(["external.txt", "from-shell.txt", "sub/file.txt"]);
    expect(outcome.details.otherChanges.every(change => change.reason.startsWith("read-only role"))).toBe(true);
    expect(outcome.text).toContain("Changed files: none attributed to this worker");
    expect(outcome.text).toContain("Other workspace changes observed during the task");
    expect(outcome.text).toContain("external.txt, from-shell.txt, sub/file.txt");
    expect(outcome.text).not.toContain("No files changed");
  });

  it("(iii) a read-only role with nothing changed says 'No files changed' and reports empty lists", async () => {
    const { execute } = await fixture(() => [result("explore", "Evidence found")]);
    const outcome = await execute({ role: "explore" });
    expect(outcome.text).toContain("No files changed");
    expect(outcome.details).toMatchObject({ changes: [], otherChanges: [] });
    expect(outcome.details).not.toHaveProperty("headMoved");
  });

  it("keeps the concurrent-session note beside the worker's own list", async () => {
    const other = { id: "other", cwd: "/work/repo", file: "/sessions/other.jsonl", lastWriteMs: Date.now() - 20_000 };
    const { execute } = await fixture(() => [tool("write", { path: "allowed.txt", content: "x\n" }), result()], { controller: { detectConcurrentSessions: async () => ({ sessions: [other] }) } });
    const outcome = await execute({ files: ["allowed.txt"] });
    expect(outcome.text).toContain("Changed files: allowed.txt (may include changes made by the other pi session(s); check before attributing them to this task)");
  });

  it("works without a submodule and outside git (no audit): nothing is invented", async () => {
    const plain = await fixture(() => [tool("write", { path: "allowed.txt", content: "x\n" }), result()], { submodule: false });
    const outcome = await plain.execute({ files: ["allowed.txt"] });
    expect(outcome.details).toMatchObject({ changes: [{ path: "allowed.txt", status: "added" }], otherChanges: [] });
    const dir = await mkdtemp(join(tmpdir(), "orche-nogit-"));
    scratch.push(dir);
    const outside = await fixture(() => [result()]);
    const report = await outside.execute({ cwd: dir });
    expect(report.text).toContain("Workspace audit unavailable (not a git work tree)");
    expect(report.details).toMatchObject({ changes: [], otherChanges: [] });
  });
});

describe("orche_task changes: commits and submodule HEADs", () => {
  it("(iv) a commit without a git grant shows the HEAD movement instead of 'No files changed'", async () => {
    const { h, execute } = await fixture(() => [
      tool("write", { path: "allowed.txt", content: "mine\n" }),
      tool("bash", { command: `git add allowed.txt && ${COMMIT} -m "Add allowed"` }),
      result(),
    ]);
    const before = git(h.cwd, "rev-parse", "HEAD");
    const outcome = await execute({ files: ["allowed.txt"] });
    const after = git(h.cwd, "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    const lines = outcome.text.split("\n");
    const at = lines.findIndex(line => line.startsWith("HEAD moved "));
    expect(lines[at]).toBe(`HEAD moved ${before.slice(0, 7)}..${after.slice(0, 7)} (1 commit); commits were not authorized for this assignment, so they may come from another session or process`);
    expect(lines[at + 1]).toBe(`  ${after.slice(0, 7)} Add allowed`);
    expect(outcome.text).not.toContain("Git:"); // no grant: no git report
    expect(outcome.details).not.toHaveProperty("git");
    expect(outcome.details.headMoved).toEqual({ from: before, to: after, branch: "main", commitCount: 1, commits: [`${after.slice(0, 7)} Add allowed`] });
    expect(outcome.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]); // committing does not hide the file change
  });

  it("(iv) a commit that changes no file never says 'No files changed' (read-only role included)", async () => {
    const { h, execute } = await fixture(() => [tool("bash", { command: `${COMMIT} --allow-empty -m "empty one" && ${COMMIT} --allow-empty -m "empty two"` }), readOnlyResult("explore")]);
    const before = git(h.cwd, "rev-parse", "HEAD");
    const outcome = await execute({ role: "explore" });
    expect(outcome.text).toMatch(new RegExp(`^HEAD moved ${before.slice(0, 7)}\\.\\.[0-9a-f]{7} \\(2 commits\\)`, "m"));
    expect(outcome.text).toMatch(/^ {2}[0-9a-f]{7} empty two$/m);
    expect(outcome.text).toContain("Changed files: none");
    expect(outcome.text).not.toContain("No files changed");
    expect(outcome.details.headMoved).toMatchObject({ from: before, commitCount: 2 });
  });

  it("(iv) with a git grant the Git: report describes the commits, and details.headMoved is still set", async () => {
    const { execute } = await fixture(() => [tool("bash", { command: `${COMMIT} --allow-empty -m "granted"` }), result()]);
    const outcome = await execute({ git: { commit: true } });
    expect(outcome.text).toContain("Git: 1 commit created on main");
    expect(outcome.text).not.toContain("HEAD moved"); // not repeated
    expect(outcome.text).not.toContain("No files changed");
    expect(outcome.details.headMoved).toMatchObject({ commitCount: 1 });
    expect(outcome.details.git).toMatchObject({ commitCount: 1 });
  });

  it("(iv) a commit inside a submodule is reported as that submodule's HEAD movement", async () => {
    const { h, execute } = await fixture(() => [tool("bash", { command: `${SUB_COMMIT} --allow-empty -m "sub change"` }), result()]);
    const before = git(join(h.cwd, "sub"), "rev-parse", "HEAD");
    const outcome = await execute();
    const after = git(join(h.cwd, "sub"), "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(outcome.text).toContain(`Submodule sub: HEAD moved ${before.slice(0, 7)}..${after.slice(0, 7)} (1 commit)`);
    expect(outcome.text).toContain(`  ${after.slice(0, 7)} sub change`);
    expect(outcome.text).not.toContain("No files changed");
    expect(outcome.details.submodules).toEqual([{ path: "sub", from: before, to: after, commitCount: 1, commits: [`${after.slice(0, 7)} sub change`] }]);
    expect(outcome.details).not.toHaveProperty("headMoved"); // the superproject HEAD did not move
    expect(outcome.details.changes).toEqual([]);
  });

  it("(iv) a submodule edit that is committed inside the submodule is both a file change and a HEAD movement", async () => {
    const { execute } = await fixture(() => [
      tool("write", { path: "sub/file.txt", content: "two\n" }),
      tool("bash", { command: `${SUB_COMMIT} -am "edit file"` }),
      result(),
    ]);
    const outcome = await execute({ files: ["sub/file.txt"] });
    expect(outcome.details.changes).toEqual([{ path: "sub/file.txt", status: "modified" }]);
    expect(outcome.details.submodules).toHaveLength(1);
    expect(outcome.text).toContain("Changed files: sub/file.txt");
    expect(outcome.text).toMatch(/^Submodule sub: HEAD moved [0-9a-f]{7}\.\.[0-9a-f]{7} \(1 commit\)$/m);
  });

  it("an unchanged repository neither reports HEAD movement nor submodules", async () => {
    const { execute } = await fixture(() => [result("explore", "Nothing to see")]);
    const outcome = await execute({ role: "explore" });
    expect(outcome.text).toContain("No files changed");
    expect(outcome.text).not.toContain("HEAD moved");
    expect(outcome.text).not.toContain("Submodule");
  });
});

describe("orche_task changes: stale context of a reused worker", () => {
  const prompts = (pool: WorkerPool) => JSON.stringify(pool.session("W1").messages.filter(message => message.role === "user"));

  it("lists what changed between assignments as not made by the worker, including submodule files and HEAD", async () => {
    const { h, pool, execute } = await fixture(() => [result("explore", "First"), tool("write", { path: "allowed.txt", content: "second\n" }), result()]);
    await execute({ role: "explore", request: "FIRST" });
    await writeFile(join(h.cwd, "sub/file.txt"), "changed between assignments\n");
    await writeFile(join(h.cwd, "other.txt"), "someone else\n");
    git(h.cwd, "add", "other.txt");
    git(h.cwd, "commit", "-q", "-m", "someone else committed");
    const second = await execute({ worker: "W1", role: "implement", request: "SECOND", files: ["allowed.txt"] });
    const text = prompts(pool);
    expect(text).toContain("## Stale context: workspace changes since your previous assignment");
    expect(text).toContain("Changed while none of your assignments was running (not attributed to this worker; they may come from other sessions or processes):");
    expect(text).toContain("sub/file.txt (modified)");
    expect(text).toContain("other.txt (added)");
    expect(text).toMatch(/HEAD moved [0-9a-f]{7}\.\.[0-9a-f]{7} \(1 commit\)/);
    expect(text).not.toContain("No files changed.");
    // What was changed before the second assignment began is not this assignment's change.
    expect(second.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]);
    expect(second.details.otherChanges).toEqual([]);
    expect(second.text).not.toContain("HEAD moved");
  });

  it("says 'No files changed.' only when nothing happened since the previous assignment", async () => {
    const { pool, execute } = await fixture(() => [result("explore", "First"), result("explore", "Second")]);
    await execute({ role: "explore", request: "FIRST" });
    await execute({ worker: "W1", role: "explore", request: "SECOND" });
    expect(prompts(pool)).toContain("## Stale context: workspace changes since your previous assignment\\nNo files changed.\\nRe-read changed evidence");
  });
});

describe("formatTaskChanges", () => {
  const added = (path: string) => ({ path, status: "added" as const });
  it("says 'No files changed' only for an empty report", () => {
    expect(formatTaskChanges({ changes: [], otherChanges: [] })).toEqual(["No files changed"]);
    for (const report of [
      { changes: [added("a")], otherChanges: [] },
      { changes: [], otherChanges: [{ ...added("a"), reason: "r" }] },
      { changes: [], otherChanges: [], submodules: [{ path: "sub", from: "a".repeat(40), to: "b".repeat(40), commitCount: 0, commits: [] }] },
      { changes: [], otherChanges: [], headMoved: { from: "a".repeat(40), to: "b".repeat(40), commitCount: 1, commits: ["bbbbbbb x"] } },
    ]) expect(formatTaskChanges(report).join("\n")).not.toContain("No files changed");
  });

  it("caps long lists in the text, and words resets and added or removed submodules", () => {
    const many = Array.from({ length: 53 }, (_, i) => added(`f${i}`));
    const [line] = formatTaskChanges({ changes: many, otherChanges: [] });
    expect(line!.endsWith(", … 3 more")).toBe(true);
    const lines = formatTaskChanges({
      changes: [], otherChanges: [],
      headMoved: { from: "a".repeat(40), to: "b".repeat(40), commitCount: 0, commits: [] },
      submodules: [{ path: "gone", from: "c".repeat(40), commitCount: 0, commits: [] }, { path: "fresh", to: "d".repeat(40), commitCount: 0, commits: [] }],
    }, { grant: false });
    expect(lines).toContain("HEAD moved aaaaaaa..bbbbbbb (no new commits; reset or checkout?); commits were not authorized for this assignment, so they may come from another session or process");
    expect(lines).toContain("Submodule gone: removed (was ccccccc)");
    expect(lines).toContain("Submodule fresh: added (HEAD ddddddd)");
  });
});
