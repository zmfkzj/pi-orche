/**
 * Ultra mode's runtime contract (src/orchestrator/ultra.ts, candidate-workspace.ts, the ultra rules of planSpawn): stage order, caps,
 * candidate isolation in real git workspace copies (private dependency copies, fail-closed link checks), content fingerprints, adoption
 * (conflicts, rollback, binary/symlink/mode/deletions, untouched dirty files), the orchestrator's write guard and the report gate against
 * a real tool-call ledger, with every tool call driven through the probe hooks the worker pool uses (beginCall at the guard, endCall at the
 * end of the call) and real shell commands. The wiring through WorkerPool and real faux-model sessions is in
 * test/extension/strong-ultra.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSpawn, type PlannedWorker, type SubWorkerOutcome } from "../../src/orchestrator/spawn.js";
import { CandidateWorkspaces, manifestDigest, UnsafeLinksError } from "../../src/orchestrator/candidate-workspace.js";
import { MAX_CANDIDATE_ROUNDS, MAX_EXPLORATION_ROUNDS, UltraRun, ultraSection } from "../../src/orchestrator/ultra.js";
import { evidenceLedgerOf, recordToolCall } from "../../src/pi/tool-evidence.js";
import { subWorkerGuard } from "../../src/orchestrator/sub-worker.js";

const dirs: string[] = [];
const lockedDirs: string[] = [];
afterEach(async () => {
  for (const dir of lockedDirs.splice(0)) execSync(`chmod -R u+w '${dir}'`);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const root = process.getuid?.() === 0;

async function temp(prefix = "orche-ultra-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function repo(): Promise<{ cwd: string; scratch: string }> {
  const base = await temp();
  const cwd = join(base, "repo");
  await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n.venv/\nignored.log\n");
  await writeFile(join(cwd, "greeting.txt"), "hello\n");
  await writeFile(join(cwd, "ignored.log"), "noise\n");
  await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  return { cwd, scratch: join(base, "scratch") };
}

const ids = () => { let n = 0; return () => `W1.${++n}`; };
const worker = (name: string, role: string, request = `do ${name}`, files?: string[]): { name: string; role: never; request: string; files?: string[]; from?: string } => ({ name, role: role as never, request, ...(files ? { files } : {}) });
const outcome = (planned: PlannedWorker, status: string, changes: string[] = []): SubWorkerOutcome => ({
  id: planned.id, name: planned.name, role: planned.role, reason: planned.reason, status, summary: `${planned.name} ${status}`, model: "p/m", modelSource: "orchestrator",
  requests: 1, models: {}, startedAt: Date.now(), durationMs: 1, costUSD: 0, changes, ...(planned.files ? { files: planned.files } : {}), ...(planned.workspace ? { workspace: planned.workspace } : {}),
});

describe("ultra: planSpawn rules", () => {
  const plan = (reason: string, workers: ReturnType<typeof worker>[], options: { ultra?: boolean; readOnly?: boolean } = { ultra: true }) => planSpawn({ reason: reason as never, workers }, { ...options, nextId: ids() });

  it("exploration and candidates exist only in ultra mode; ultra has no parallelism and isolates specialists only", () => {
    expect(() => plan("exploration", [worker("a", "answer"), worker("b", "answer")], {})).toThrow('reason "exploration" belongs to ultra mode');
    expect(() => plan("candidates", [worker("a", "answer"), worker("b", "answer")], {})).toThrow('reason "candidates" belongs to ultra mode');
    expect(() => plan("parallelism", [worker("a", "implement", "x", ["a.txt"]), worker("b", "implement", "y", ["b.txt"])])).toThrow('ultra mode has no reason "parallelism"');
    expect(() => plan("isolation", [worker("a", "implement", "x", ["a.txt"])])).toThrow("isolation\" is for game-asset and video specialists only");
    expect(plan("isolation", [worker("art", "game-asset", "x", ["art/"])]).workers).toHaveLength(1);
  });

  it("exploration takes 2+ basis builders (implement) and analysts (answer); candidates take 2-4 distinct, uniform requests and may share files", () => {
    expect(() => plan("exploration", [worker("a", "answer")])).toThrow("two or more independent workers");
    expect(() => plan("exploration", [worker("a", "answer"), worker("v", "verify")])).toThrow();
    expect(plan("exploration", [worker("basis", "implement", "tests", ["test/basis.sh"]), worker("cause", "answer")]).workers.map(item => item.id)).toEqual(["W1.1", "W1.2"]);
    expect(() => plan("candidates", [worker("a", "implement", "x", ["src/"])])).toThrow("2 to 4 independent candidates");
    expect(() => plan("candidates", [worker("a", "implement", "x", ["src/"]), worker("b", "answer", "y")])).toThrow("all role implement");
    expect(() => plan("candidates", [worker("a", "implement", "same  approach", ["src/"]), worker("b", "implement", "same approach", ["src/"])])).toThrow("candidate requests must differ");
    expect(plan("candidates", [worker("a", "implement", "approach A", ["src/"]), worker("b", "implement", "approach B", ["src/"])]).workers).toHaveLength(2);
    expect(() => plan("exploration", [{ ...worker("a", "answer"), from: "W1.3" }, worker("b", "answer")])).toThrow("from (start from an earlier candidate)");
    expect(() => plan("exploration", [worker("basis", "implement", "t", ["t.sh"]), worker("b", "answer")], { ultra: true, readOnly: true })).toThrow("this assignment is read-only");
  });
});

describe("ultra: candidate workspaces (real git)", () => {
  it("content manifests: text, binary, mode, links, additions, deletions; no index flag or end-of-line rule hides a byte change", async () => {
    const { cwd, scratch } = await repo();
    await writeFile(join(cwd, ".gitattributes"), "* text=auto\n");
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(cwd, "run.sh"), "echo hi\n");
    await chmod(join(cwd, "run.sh"), 0o755);
    await symlink("greeting.txt", join(cwd, "link"));
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd });
    // The user's own index hides changes of greeting.txt from git (assume-unchanged): the private index clears that.
    execFileSync("git", ["update-index", "--assume-unchanged", "greeting.txt"], { cwd });
    const spaces = (await CandidateWorkspaces.open(cwd, join(scratch, "ultra")))!;
    const before = manifestDigest(await spaces.workspaceManifest());
    await writeFile(join(cwd, "greeting.txt"), "hello\r\n"); // an end-of-line-only change, which text=auto would normalize away
    expect(manifestDigest(await spaces.workspaceManifest())).not.toBe(before);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe(""); // git itself sees nothing
    const tree = await spaces.snapshot();
    const report = await spaces.materialize("W1.3", tree);
    const ws = spaces.path("W1.3");
    expect(report.dependencies).toEqual(["node_modules"]);
    expect(await readlink(join(ws, "link"))).toBe("greeting.txt");
    expect((await stat(join(ws, "run.sh"))).mode & 0o111).not.toBe(0);
    await expect(stat(join(ws, "ignored.log"))).rejects.toThrow();
    const print = await spaces.fingerprint("W1.3");
    await writeFile(join(ws, "bin.dat"), Buffer.from([9, 9, 0, 1]));
    await writeFile(join(ws, "new.txt"), "new\n");
    await rm(join(ws, "run.sh"));
    await writeFile(join(ws, "ignored.log"), "still ignored\n");
    await writeFile(join(ws, "node_modules", "pkg", "index.js"), "module.exports = 2;\n"); // dependency directories are out of scope
    expect(await spaces.changes("W1.3")).toEqual([{ path: "bin.dat", status: "M" }, { path: "new.txt", status: "A" }, { path: "run.sh", status: "D" }]);
    expect(await spaces.fingerprint("W1.3")).not.toBe(print);
    await writeFile(join(ws, ".gitattributes"), "* text=auto\n"); // same bytes again: unchanged
    await chmod(join(ws, "bin.dat"), 0o600); // a mode-only change counts
    expect((await spaces.changes("W1.3")).find(change => change.path === "bin.dat")).toEqual({ path: "bin.dat", status: "M" });
    await spaces.close();
  });

  it("adoption copies the candidate's bytes, keeps the workspace's other dirty files, refuses a moved base, rolls back failed writes", async () => {
    const { cwd, scratch } = await repo();
    await mkdir(join(cwd, "locked"));
    await writeFile(join(cwd, "locked", "f.txt"), "locked\n");
    const spaces = (await CandidateWorkspaces.open(cwd, join(scratch, "ultra")))!;
    const base = await spaces.workspaceManifest();
    await spaces.materialize("W1.3", await spaces.snapshot());
    const ws = spaces.path("W1.3");
    await writeFile(join(ws, "greeting.txt"), "fixed\n");
    await writeFile(join(cwd, "notes.txt"), "user's own work\n"); // dirty, untouched by the candidate
    const changed = (await spaces.changes("W1.3")).map(change => change.path);
    expect(await spaces.adopt("W1.3", changed, base)).toEqual({ applied: ["greeting.txt"] });
    expect(await readFile(join(cwd, "greeting.txt"), "utf8")).toBe("fixed\n");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("user's own work\n");
    // The workspace moved under a second candidate's path: refused, nothing written.
    const base2 = await spaces.workspaceManifest();
    await spaces.materialize("W1.4", await spaces.snapshot());
    await writeFile(join(spaces.path("W1.4"), "greeting.txt"), "candidate\n");
    await writeFile(join(cwd, "greeting.txt"), "someone else\n");
    await expect(spaces.adopt("W1.4", ["greeting.txt"], base2)).rejects.toThrow("the workspace changed since the candidate's base in greeting.txt");
    expect(await readFile(join(cwd, "greeting.txt"), "utf8")).toBe("someone else\n");
    // A verify that finds the candidate changed while it was copied rolls the copy back.
    const base3 = await spaces.workspaceManifest();
    await spaces.materialize("W1.5", await spaces.snapshot());
    await writeFile(join(spaces.path("W1.5"), "notes.txt"), "candidate notes\n");
    await expect(spaces.adopt("W1.5", ["notes.txt"], base3, undefined, async () => "the copy changed")).rejects.toThrow("adoption rolled back: the copy changed");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("user's own work\n");
    if (root) return; // root ignores directory permissions
    const base4 = await spaces.workspaceManifest();
    await spaces.materialize("W1.6", await spaces.snapshot());
    await writeFile(join(spaces.path("W1.6"), "a-first.txt"), "first\n");
    await writeFile(join(spaces.path("W1.6"), "locked", "f.txt"), "changed\n");
    await chmod(join(cwd, "locked"), 0o555);
    lockedDirs.push(join(cwd, "locked"));
    await expect(spaces.adopt("W1.6", ["a-first.txt", "locked/f.txt"], base4)).rejects.toThrow("adoption failed and was rolled back");
    await expect(stat(join(cwd, "a-first.txt"))).rejects.toThrow();
    expect(await readFile(join(cwd, "locked", "f.txt"), "utf8")).toBe("locked\n");
  });

  it("dependency directories are private copies: candidate writes there leave the workspace, siblings and the earlier candidate unchanged", async () => {
    const { cwd, scratch } = await repo();
    await mkdir(join(cwd, "node_modules", ".bin"), { recursive: true });
    await symlink("../pkg/index.js", join(cwd, "node_modules", ".bin", "tool"));
    await symlink(join(cwd, "greeting.txt"), join(cwd, "node_modules", "self")); // absolute, into the workspace
    await mkdir(join(cwd, ".venv", "bin"), { recursive: true });
    await mkdir(join(cwd, ".venv", "lib", "python3.12", "site-packages"), { recursive: true });
    await writeFile(join(cwd, ".venv", "pyvenv.cfg"), `home = /usr/bin\ncommand = /usr/bin/python3 -m venv ${cwd}/.venv\n`);
    await writeFile(join(cwd, ".venv", "bin", "pip"), `#!${cwd}/.venv/bin/python\nimport pip\n`);
    await chmod(join(cwd, ".venv", "bin", "pip"), 0o755);
    await writeFile(join(cwd, ".venv", "lib", "python3.12", "site-packages", "_editable.pth"), `${cwd}/src\n${cwd}-other/src\n`);
    const spaces = (await CandidateWorkspaces.open(cwd, join(scratch, "ultra")))!;
    const tree = await spaces.snapshot();
    const report = await spaces.materialize("W1.3", tree);
    await spaces.materialize("W1.4", tree);
    const a = spaces.path("W1.3"), b = spaces.path("W1.4");
    expect(report.dependencies).toEqual(["node_modules", ".venv"]);
    expect(report.rewritten).toBe(3);
    for (const dir of ["node_modules", ".venv"]) expect((await lstat(join(a, dir))).isDirectory()).toBe(true);
    expect(await readlink(join(a, "node_modules", ".bin", "tool"))).toBe("../pkg/index.js");
    expect(await realpath(join(a, "node_modules", "self"))).toBe(join(a, "greeting.txt"));
    expect(await readFile(join(a, ".venv", "bin", "pip"), "utf8")).toBe(`#!${a}/.venv/bin/python\nimport pip\n`);
    expect(await readFile(join(a, ".venv", "lib", "python3.12", "site-packages", "_editable.pth"), "utf8")).toBe(`${a}/src\n${cwd}-other/src\n`);
    expect((await stat(join(a, ".venv", "bin", "pip"))).mode & 0o111).not.toBe(0);
    // A candidate writes into its dependency directories, through the relocated link too.
    await writeFile(join(a, "node_modules", "pkg", "index.js"), "module.exports = 'A';\n");
    await writeFile(join(a, ".venv", "bin", "pip"), "#!/bin/sh\necho A\n");
    await writeFile(join(a, "node_modules", "self"), "via link\n");
    expect(await readFile(join(cwd, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(await readFile(join(cwd, ".venv", "bin", "pip"), "utf8")).toBe(`#!${cwd}/.venv/bin/python\nimport pip\n`);
    expect(await readFile(join(cwd, "greeting.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(b, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    // A fix candidate starts from W1.3's copy; its own writes leave W1.3 as it was.
    await spaces.materialize("W1.5", tree, "W1.3");
    const fix = spaces.path("W1.5");
    expect(await readFile(join(fix, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 'A';\n");
    expect(await realpath(join(fix, "node_modules", "self"))).toBe(join(fix, "greeting.txt"));
    await writeFile(join(fix, "node_modules", "pkg", "index.js"), "module.exports = 'fix';\n");
    expect(await readFile(join(a, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 'A';\n");
    // The escape check sees a write into the workspace's own dependency directories, but not into tool caches.
    const deps = await spaces.dependencyFingerprint();
    await mkdir(join(cwd, "node_modules", ".cache"), { recursive: true });
    await writeFile(join(cwd, "node_modules", ".cache", "x"), "cache\n");
    expect(await spaces.dependencyFingerprint()).toBe(deps);
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = 'escaped';\n");
    expect(await spaces.dependencyFingerprint()).not.toBe(deps);
  });

  it("links are verified fail-closed: a chain through a tracked link to a writable place refuses the copy before anything runs", async () => {
    const outside = await temp("orche-outside-");
    await mkdir(join(outside, "pkgdir"));
    await writeFile(join(outside, "file.txt"), "shared\n");
    const { cwd, scratch } = await repo();
    await symlink(outside, join(cwd, "bridge")); // a tracked-area link to a writable directory outside
    await symlink(join(cwd, "bridge", "file.txt"), join(cwd, "node_modules", "chained"));
    const spaces = (await CandidateWorkspaces.open(cwd, join(scratch, "ultra")))!;
    const error = await spaces.materialize("W1.3", await spaces.snapshot()).catch(caught => caught);
    expect(error).toBeInstanceOf(UnsafeLinksError);
    expect((error as UnsafeLinksError).links.map(link => link.path)).toContain("bridge");
    await expect(stat(spaces.path("W1.3"))).rejects.toThrow(); // nothing left behind
    // Dependency links only: a writable outside file becomes a private copy; a writable outside directory and a dangling link refuse.
    await rm(join(cwd, "bridge"));
    await rm(join(cwd, "node_modules", "chained"));
    await symlink(join(outside, "file.txt"), join(cwd, "node_modules", "ext"));
    const report = await spaces.materialize("W1.4", await spaces.snapshot());
    expect(report.privatized).toEqual(["node_modules/ext"]);
    await writeFile(join(spaces.path("W1.4"), "node_modules", "ext"), "candidate\n");
    expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("shared\n");
    await symlink(join(outside, "pkgdir"), join(cwd, "node_modules", "linked"));
    await expect(spaces.materialize("W1.5", await spaces.snapshot())).rejects.toThrow("node_modules/linked");
    await rm(join(cwd, "node_modules", "linked"));
    await symlink(join(outside, "missing.txt"), join(cwd, "node_modules", "dangling"));
    await expect(spaces.materialize("W1.6", await spaces.snapshot())).rejects.toThrow("dangling, would create a file in a writable place");
    await rm(join(cwd, "node_modules", "dangling"));
    if (root) return;
    // A directory verified read-only in its whole tree may stay shared.
    await mkdir(join(outside, "ro", "lib"), { recursive: true });
    await writeFile(join(outside, "ro", "lib", "a.js"), "ro\n");
    execSync(`chmod -R a-w '${join(outside, "ro")}'`);
    lockedDirs.push(join(outside, "ro"));
    await symlink(join(outside, "ro"), join(cwd, "node_modules", "ro"));
    const shared = await spaces.materialize("W1.7", await spaces.snapshot());
    expect(shared.readOnly).toEqual([{ path: "node_modules/ro", target: join(outside, "ro") }]);
  });

  it("submodules are named, empty in the copies and passed to the candidates' guard; other ignored files are not copied", async () => {
    const run = await orchestrator();
    const nested = join(run.cwd, "vendor", "lib");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: nested });
    await writeFile(join(nested, "lib.c"), "int x;\n");
    execFileSync("git", ["add", "-A"], { cwd: nested });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "lib"], { cwd: nested });
    execFileSync("git", ["-c", "advice.addEmbeddedRepo=false", "add", "vendor/lib"], { cwd: run.cwd });
    await run.spawn("exploration", [worker("basis", "implement", "tests", ["test/"]), worker("cause", "answer", "hypotheses")]);
    const { prepared, lines } = await run.spawn("candidates", [worker("a", "implement", "approach A", ["greeting.txt"]), worker("b", "implement", "approach B", ["greeting.txt"])]);
    expect(prepared.map(item => item.outsidePaths)).toEqual([["vendor/lib"], ["vendor/lib"]]);
    expect(lines.join("\n")).toContain("Submodules vendor/lib are empty in the copies (not copied)");
    expect(lines.join("\n")).toContain("Git-ignored files other than those dependency directories");
    await expect(stat(join(prepared[0]!.workspace!, "vendor", "lib", "lib.c"))).rejects.toThrow();
    await expect(stat(join(prepared[0]!.workspace!, "ignored.log"))).rejects.toThrow();
  });

  it("is unavailable outside a git work tree", async () => {
    const dir = await temp("orche-ultra-nogit-");
    expect(await CandidateWorkspaces.open(dir, join(dir, "scratch"))).toBeUndefined();
  });

  it("a candidate's guard: its own copy only, the protected basis and submodules refused, literal shell writes outside the copy blocked", async () => {
    const { cwd } = await repo();
    const candidate: PlannedWorker = { id: "W1.3", name: "a", role: "implement", request: "x", reason: "candidates", files: ["greeting.txt", "test/", "vendor/"], workspace: join(cwd, "..", "copy"), protectedPaths: ["test/basis.sh"], outsidePaths: ["vendor/lib"] };
    const sibling: PlannedWorker = { ...candidate, id: "W1.4", name: "b", workspace: join(cwd, "..", "copy2") };
    await mkdir(candidate.workspace!, { recursive: true });
    const guard = subWorkerGuard(candidate, [candidate, sibling], cwd);
    expect(await guard("write", { path: "greeting.txt", content: "x" })).toBeUndefined();
    expect(await guard("write", { path: "test/basis.sh", content: "x" })).toContain("protected verification basis");
    expect(await guard("write", { path: "vendor/lib/a.c", content: "x" })).toContain("inside a submodule");
    expect(await guard("bash", { command: `echo x > ${join(cwd, "greeting.txt")}` })).toContain("writes only inside its workspace copy");
    expect(await guard("orche_spawn", {})).toContain("depth is 1");
  });
});

/** An ultra orchestrator's tool calls through the same hooks the worker pool uses: beginCall (guard), the call, the ledger, endCall. */
async function orchestrator(options: { readOnly?: boolean; cwd?: string; scratch?: string } = {}) {
  const made = options.cwd ? { cwd: options.cwd, scratch: options.scratch! } : await repo();
  const { cwd, scratch } = made;
  const session = {};
  const ledger = evidenceLedgerOf(session);
  ledger.tag = true;
  let n = 0;
  const events: Record<string, unknown>[] = [];
  const ultra = new UltraRun({ orchestrator: "W1", cwd, readOnly: !!options.readOnly, scratch, ledger: () => ledger, verifyCommands: ["sh test/basis.sh"], onEvent: event => events.push(event) });
  const record = (id: string, name: string, input: Record<string, unknown>, isError: boolean) => recordToolCall(session, { toolCallId: id, toolName: name, input, isError }, { request: n, atBaseline: true }).ref;
  /** One call: its effect runs between the guard and the end, as the tool does. */
  const act = async (name: string, input: Record<string, unknown>, effect?: () => unknown) => {
    const id = `c${++n}`;
    await ultra.beginCall(id, name);
    let failed = false;
    try { await effect?.(); } catch { failed = true; }
    const ref = record(id, name, input, failed);
    await ultra.endCall(id);
    return ref;
  };
  /** A real shell command of the orchestrator (in the workspace unless it cds elsewhere). */
  const shell = (command: string) => act("bash", { command }, () => execSync(command, { cwd, stdio: "pipe", shell: "/bin/sh" }));
  const next = ids();
  /** One orche_spawn call: `during` is what the sub-workers do while it runs. */
  const spawn = async (reason: string, workers: ReturnType<typeof worker>[], status: (planned: PlannedWorker) => string = () => "done", during?: (prepared: PlannedWorker[]) => Promise<void>) => {
    const id = `c${++n}`;
    await ultra.beginCall(id, "orche_spawn");
    try {
      ultra.validate(reason as never, workers);
      const planned = planSpawn({ reason: reason as never, workers }, { ultra: true, readOnly: !!options.readOnly, nextId: next }).workers;
      const prepared = await ultra.prepare(reason as never, planned, new AbortController().signal);
      await during?.(prepared);
      const outcomes = prepared.map(item => outcome(item, status(item), item.role === "implement" && !item.workspace ? [...(item.files ?? [])] : []));
      const lines = await ultra.finish(reason as never, prepared, outcomes);
      record(id, "orche_spawn", { reason }, false);
      return { prepared, outcomes, lines };
    } catch (error) {
      record(id, "orche_spawn", { reason }, true);
      throw error;
    } finally { await ultra.endCall(id); }
  };
  /** A report_result call: the gate's verdict. */
  const report = async (kind: string, data: unknown) => {
    const id = `c${++n}`;
    await ultra.beginCall(id, "report_result");
    const error = ultra.gateError(kind, data);
    record(id, "report_result", {}, !!error);
    await ultra.endCall(id);
    return error;
  };
  return { cwd, scratch, ultra, act, shell, spawn, report, events, begin: (id: string, name: string) => ultra.beginCall(id, name), end: (id: string, name: string, input: Record<string, unknown> = {}) => { record(id, name, input, false); return ultra.endCall(id); } };
}

/** exploration (a basis builder that writes test/basis.sh, an analyst), then two candidates; returns the copies. */
async function throughCandidates(run: Awaited<ReturnType<typeof orchestrator>>) {
  await run.spawn("exploration", [worker("basis", "implement", "acceptance tests", ["test/"]), worker("cause", "answer", "hypotheses")], () => "done", async () => {
    await mkdir(join(run.cwd, "test"), { recursive: true });
    await writeFile(join(run.cwd, "test", "basis.sh"), "grep -q fixed greeting.txt\n");
  });
  const round = await run.spawn("candidates", [worker("a", "implement", "approach A", ["greeting.txt"]), worker("b", "implement", "approach B", ["greeting.txt"])], () => "done", async prepared => {
    await writeFile(join(prepared[0]!.workspace!, "greeting.txt"), "fixed\n");
    await writeFile(join(prepared[1]!.workspace!, "greeting.txt"), "broken\n");
  });
  return { a: round.prepared[0]!.workspace!, b: round.prepared[1]!.workspace!, lines: round.lines };
}

describe("ultra: UltraRun stages, adoption, guard and report gate", () => {
  it("enforces the stage order and caps, protects the basis, and adopts only a checked, untampered candidate", async () => {
    const run = await orchestrator();
    const { ultra } = run;
    await expect(run.spawn("candidates", [worker("a", "implement", "A", ["greeting.txt"]), worker("b", "implement", "B", ["greeting.txt"])])).rejects.toThrow("candidates come after an exploration round");
    await expect(run.spawn("exploration", [worker("x", "answer", "x"), worker("y", "answer", "y")])).rejects.toThrow("needs at least one verification-basis builder");
    expect(ultra.guardWrite("write", { path: "greeting.txt" })).toContain("you edit the workspace only to integrate after orche_adopt");
    const { a, b, lines } = await throughCandidates(run);
    expect(lines.join("\n")).toContain("Candidate copies: private copies of node_modules");
    expect(ultra.guardWrite("edit", { path: "test/basis.sh" })).toContain("protected verification basis");
    expect(ultra.guardWrite("write", { path: join(a, "greeting.txt") })).toContain("candidate workspaces are written only by their candidates");
    expect(await readFile(join(a, "test", "basis.sh"), "utf8")).toBe("grep -q fixed greeting.txt\n");
    await writeFile(join(b, "test", "basis.sh"), "true\n"); // tampering by shell: never adoptable
    await expect(run.act("orche_adopt", { candidate: "W1.4" }, () => ultra.adopt("W1.4"))).resolves.toMatch(/^T\d+$/);
    await expect(ultra.adopt("W1.4")).rejects.toThrow("changed the protected verification basis");
    await expect(ultra.adopt("W1.3")).rejects.toThrow("Run the checks in W1.3's workspace first");
    await run.shell(`cd '${a}' && sh test/basis.sh`);
    await expect(ultra.adopt("W1.3")).resolves.toContain("Adopted W1.3 into the workspace: 1 file(s): greeting.txt");
    expect(await readFile(join(run.cwd, "greeting.txt"), "utf8")).toBe("fixed\n");
    expect(ultra.guardWrite("write", { path: "greeting.txt" })).toBeUndefined();
    await run.spawn("exploration", [worker("basis2", "implement", "more tests", ["test2/"]), worker("cause2", "answer", "more")]);
    await expect(run.spawn("exploration", [worker("basis3", "implement", "t", ["t3/"]), worker("c3", "answer", "c")])).rejects.toThrow(`exploration rounds ran (cap ${MAX_EXPLORATION_ROUNDS})`);
    await run.spawn("candidates", [{ ...worker("fix", "implement", "fix W1.3", ["greeting.txt"]), from: "W1.3" }, worker("c", "implement", "approach C", ["greeting.txt"])]);
    await expect(run.spawn("candidates", [worker("d", "implement", "D", ["greeting.txt"]), worker("e", "implement", "E", ["greeting.txt"])])).rejects.toThrow(`candidate rounds ran (cap ${MAX_CANDIDATE_ROUNDS})`);
    expect(run.events.map(event => event.stage)).toEqual(expect.arrayContaining(["exploration", "candidates", "selection"]));
  });

  it("a candidate changed after its check (content, a new file), or checked while another call ran, is not adopted until checked again", async () => {
    const run = await orchestrator();
    const { ultra } = run;
    const { a } = await throughCandidates(run);
    // A check that overlapped another call that can change files proves nothing.
    await run.begin("p1", "bash");
    await run.begin("p2", "write");
    execSync("sh test/basis.sh", { cwd: a });
    await run.end("p1", "bash", { command: `cd '${a}' && sh test/basis.sh` });
    await run.end("p2", "write", { path: "x" });
    await expect(ultra.adopt("W1.3")).rejects.toThrow("is not what your checks in it");
    // A check that changed the copy itself proves nothing either.
    await run.shell(`cd '${a}' && sh test/basis.sh && printf more >> greeting.txt`);
    await expect(ultra.adopt("W1.3")).rejects.toThrow("is not what your checks in it");
    await run.shell(`cd '${a}' && printf 'fixed\\n' > greeting.txt`);
    await run.shell(`cd '${a}' && sh test/basis.sh`);
    await writeFile(join(a, "greeting.txt"), "fixed, but changed after the check\n");
    await expect(ultra.adopt("W1.3")).rejects.toThrow("W1.3's copy is not what your checks in it");
    await run.shell(`cd '${a}' && sh test/basis.sh`);
    await writeFile(join(a, "extra.txt"), "a new file after the check\n");
    await expect(ultra.adopt("W1.3")).rejects.toThrow("is not what your checks in it");
    await rm(join(a, "extra.txt")); // the same bytes as checked again
    await expect(ultra.adopt("W1.3")).resolves.toContain("Adopted W1.3");
    expect(await readFile(join(run.cwd, "greeting.txt"), "utf8")).toBe("fixed, but changed after the check\n");
  });

  it("an escape during a candidates round (the workspace's own dependencies or files changed) makes the round unadoptable", async () => {
    const run = await orchestrator();
    await run.spawn("exploration", [worker("basis", "implement", "acceptance tests", ["test/"]), worker("cause", "answer", "hypotheses")], () => "done", async () => {
      await mkdir(join(run.cwd, "test"), { recursive: true });
      await writeFile(join(run.cwd, "test", "basis.sh"), "grep -q fixed greeting.txt\n");
    });
    const { lines, prepared } = await run.spawn("candidates", [worker("a", "implement", "approach A", ["greeting.txt"]), worker("b", "implement", "approach B", ["greeting.txt"])], () => "done", async copies => {
      await writeFile(join(copies[0]!.workspace!, "greeting.txt"), "fixed\n");
      await writeFile(join(run.cwd, "node_modules", "pkg", "index.js"), "escaped\n"); // e.g. a shell write by absolute path
    });
    expect(lines.join("\n")).toContain("Isolation breach: the workspace's own dependency directories (node_modules, .venv, venv) changed during the round");
    await run.shell(`cd '${prepared[0]!.workspace}' && sh test/basis.sh`);
    await expect(run.ultra.adopt("W1.3")).rejects.toThrow("round broke isolation");
  });

  it("the report gate: integration checks must have seen the workspace as it is at the report; shell and outside changes need new checks", async () => {
    const run = await orchestrator();
    const { ultra } = run;
    const { a, b } = await throughCandidates(run);
    const checkA = await run.shell(`cd '${a}' && sh test/basis.sh`);
    const failB = await run.shell(`cd '${b}' && sh test/basis.sh`);
    await run.act("orche_adopt", { candidate: "W1.3" }, () => ultra.adopt("W1.3"));
    await run.spawn("verification", [worker("red", "verify", "find counterexamples")], () => "passed");
    const data = (integration: string[], selection = [`${checkA} sh test/basis.sh -> exit 0`], extra: Record<string, unknown> = {}) => ({
      status: "done", ultra: {
        stage: "complete", criteria: ["greeting.txt says fixed"], candidates: [{ id: "W1.3", verdict: "chosen", reason: "passes the basis", evidence: [checkA] }, { id: "W1.4", verdict: "rejected", reason: "fails the basis", evidence: [failB] }],
        selection: { chosen: "W1.3", reason: "the only candidate passing the protected basis", evidence: selection }, review: [], integration: { evidence: integration }, ...extra,
      },
    });
    const first = await run.shell("sh test/basis.sh");
    expect(await run.report("implement", data([first]))).toBeUndefined();
    // A shell write after the check (no edit tool involved): refused until the checks run again.
    await run.shell("printf 'more\\n' >> greeting.txt");
    expect(await run.report("implement", data([first]))).toContain(`the workspace now differs from what your integration checks (${first}) evaluated`);
    // A check that changes the workspace itself does not count.
    const changing = await run.shell("sh test/basis.sh && printf x >> notes.txt");
    expect(await run.report("implement", data([changing]))).toContain("the workspace now differs");
    const second = await run.shell("sh test/basis.sh");
    expect(await run.report("implement", data([second]))).toBeUndefined();
    // Another process changes the workspace without any tool call: refused as well; the same bytes again are fine.
    await writeFile(join(run.cwd, "greeting.txt"), "fixed\nmore\nby someone else\n");
    expect(await run.report("implement", data([second]))).toContain("the workspace now differs");
    await writeFile(join(run.cwd, "greeting.txt"), "fixed\nmore\n");
    expect(await run.report("implement", data([second]))).toBeUndefined();
    // A report sent while another call is in flight; a selection that cites a failed check; votes.
    await run.begin("q1", "bash");
    expect(await run.report("implement", data([second]))).toContain("report_result ran together with another call");
    await run.end("q1", "bash", { command: "true" });
    expect(await run.report("implement", data([second], [failB]))).toContain("successful checks you ran in W1.3's workspace");
    expect(await run.report("implement", data([second], ["2 of 3 reviewers liked it"]))).toContain("a vote or a candidate's own report is no evidence");
    // An edit after the checks: refused (fingerprint and edit order).
    await run.act("edit", { path: "greeting.txt" }, () => writeFile(join(run.cwd, "greeting.txt"), "fixed\nmore\nedited\n"));
    expect(await run.report("implement", data([second]))).toContain("after the last adoption or edit");
    const third = await run.shell("sh test/basis.sh");
    expect(await run.report("implement", data([third]))).toBeUndefined();
    expect(ultra.summary()).toMatchObject({ stage: "complete", adoptions: ["W1.3"], gate: "passed" });
    // A report that did not go through the guard (no fingerprint taken for it) is refused, not judged on an earlier report's state.
    expect(ultra.gateError("implement", data([third]))).toContain("could not be fingerprinted for this report (not taken for this report)");
    // The protected basis changed in the workspace (by shell): refused until restored.
    await run.shell("printf 'true\\n' > test/basis.sh");
    const after = await run.shell("sh test/basis.sh");
    expect(await run.report("implement", data([after]))).toContain("the protected verification basis changed in the workspace: test/basis.sh");
    // A fingerprint that cannot be taken refuses, it is never skipped.
    (ultra as unknown as { workspaces: CandidateWorkspaces }).workspaces.workspaceManifest = () => Promise.reject(new Error("disk gone"));
    expect(await run.report("implement", data([after]))).toContain("could not be fingerprinted for this report (disk gone)");
    // The failure path stays open.
    expect(await run.report("implement", { status: "blocked", reason: "the basis was changed by someone", ultra: { stage: "integration" } })).toBeUndefined();
    expect(await run.report("implement", { status: "done", ultra: { stage: "candidates" } })).toContain('status "done" needs stage "complete"');
  });

  it("the selection must cite a check that saw the adopted content of the chosen copy", async () => {
    const run = await orchestrator();
    const { ultra } = run;
    const { a, b } = await throughCandidates(run);
    const stale = await run.shell(`cd '${a}' && sh test/basis.sh`);
    await writeFile(join(a, "greeting.txt"), "fixed better\n");
    const fresh = await run.shell(`cd '${a}' && sh test/basis.sh`);
    const failB = await run.shell(`cd '${b}' && sh test/basis.sh`);
    await run.act("orche_adopt", { candidate: "W1.3" }, () => ultra.adopt("W1.3"));
    await run.spawn("verification", [worker("red", "verify", "find counterexamples")], () => "passed");
    const integration = await run.shell("sh test/basis.sh");
    const data = (selection: string[]) => ({ status: "done", ultra: { stage: "complete", criteria: ["fixed"], candidates: [{ id: "W1.3", verdict: "chosen", reason: "passes" }, { id: "W1.4", verdict: "rejected", reason: "fails", evidence: [failB] }], selection: { chosen: "W1.3", reason: "passes", evidence: selection }, review: [], integration: { evidence: [integration] } } });
    expect(await run.report("implement", data([stale]))).toContain(`the selection evidence (${stale}) did not evaluate the content of W1.3 that was adopted`);
    expect(await run.report("implement", data([fresh]))).toBeUndefined();
  });

  it("the end of an assignment: unfinished runs keep their copies (a late call end cannot reopen and clear them); completed runs free them", async () => {
    const kept = await orchestrator();
    const { a } = await throughCandidates(kept);
    await kept.begin("late", "bash"); // a call still running when the assignment ends (timeout)
    await kept.ultra.end(false);
    await kept.ultra.endCall("late");
    expect(await readFile(join(a, "greeting.txt"), "utf8")).toBe("fixed\n");
    const freed = await orchestrator();
    const copies = await throughCandidates(freed);
    await freed.ultra.end(true);
    await expect(stat(copies.a)).rejects.toThrow();
  });

  it("outside a git work tree implementation candidates are refused (blocked path)", async () => {
    const dir = await temp("orche-ultra-nogit-");
    const run = await orchestrator({ cwd: dir, scratch: join(dir, "..", `${dir.split("/").at(-1)}-scratch`) });
    await run.spawn("exploration", [worker("basis", "implement", "tests", ["test/"]), worker("cause", "answer", "hypotheses")]);
    await expect(run.spawn("candidates", [worker("a", "implement", "A", ["x"]), worker("b", "implement", "B", ["x"])])).rejects.toThrow("need a git work tree");
    expect(await run.report("implement", { status: "blocked", reason: "no git work tree for candidate copies", ultra: { stage: "candidates" } })).toBeUndefined();
  });

  it("read-only answers: answer workers only, no adoption, claims with checked sources, data.unresolved when incomplete", async () => {
    const run = await orchestrator({ readOnly: true });
    const { ultra } = run;
    await expect(ultra.adopt("W1.1")).rejects.toThrow("refused in a read-only (answer) assignment");
    expect(ultra.guardWrite("write", { path: "x.txt" })).toBeUndefined(); // the role's own read-only guard refuses it
    await run.spawn("exploration", [worker("sources", "answer", "find sources"), worker("cause", "answer", "hypotheses")]);
    const { prepared } = await run.spawn("candidates", [worker("a", "answer", "angle A"), worker("b", "answer", "angle B")]);
    expect(prepared.every(item => !item.workspace)).toBe(true);
    const read = await run.act("read", { path: "greeting.txt" });
    const failed = await run.act("read", { path: "missing.ts" }, () => { throw new Error("missing"); });
    await run.spawn("verification", [worker("red", "verify", "refute the claims")], () => "passed");
    const answer = (claims: unknown[]) => ({ ultra: { stage: "complete", criteria: ["names the cause"], candidates: [{ id: "W1.3", verdict: "chosen", reason: "best supported" }, { id: "W1.4", verdict: "rejected", reason: "unsupported claim" }], selection: { chosen: "W1.3", reason: "checked", evidence: [read] }, review: [], claims } });
    expect(await run.report("answer", answer([{ claim: "the cause is X", sources: [failed], status: "supported" }]))).toContain(`cites ${failed}, not a successful call of yours`);
    expect(await run.report("answer", answer([{ claim: "the cause is X", sources: [read, "greeting.txt:1"], status: "supported" }]))).toBeUndefined();
    expect(await run.report("answer", { ultra: { stage: "candidates" } })).toContain("data.unresolved");
    expect(await run.report("answer", { ultra: { stage: "candidates" }, unresolved: ["no second source"] })).toBeUndefined();
    expect(ultraSection(true)).toContain("no code tests are required for a question");
  });
});
