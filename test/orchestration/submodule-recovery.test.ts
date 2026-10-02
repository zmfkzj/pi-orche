import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeWorkspaceChanges, inspectSubmodules, recoveryCommands, WorkspaceAudit,
  type ExternalWorkspaceChange, type WorkspaceChange,
} from "../../src/orchestration/workspace.js";

/**
 * Recovery advice for submodules, against real repositories. Two forms are wrong and must never be
 * produced: `git restore --source=<superproject baseline> -- sub/file` (git refuses: the baseline holds
 * only the gitlink) and `git restore ... -- sub` (exits 0 and leaves the submodule HEAD where it is).
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ENV = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: ENV }).trim();
const sh = (cwd: string, command: string) => execFileSync("sh", ["-c", command], { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
/** Lines of a description that are shell commands (indented), as opposed to listings and notes. */
const commandLines = (text: string) => text.split("\n").filter(line => /^ {2}\S/.test(line)).map(line => line.trim());

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-subrec-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/** `libs/sub` (file.txt, keep.txt) inside a superproject (top.txt, src/a.ts), everything committed. */
async function withSubmodule() {
  const lib = await repo({ "file.txt": "one\n", "keep.txt": "keep\n" });
  const dir = await repo({ "top.txt": "top\n", "src/a.ts": "a\n" });
  git(dir, "submodule", "add", "-q", lib, "libs/sub");
  git(dir, "commit", "-qm", "add sub");
  return { dir, sub: join(dir, "libs/sub") };
}

/** Command lines of `text` that are the superproject-baseline restore form naming one of `subs` or a path inside one. */
function invalidRestores(text: string, subs: readonly string[]): string[] {
  return text.split("\n").filter(line => {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "git" || words[1] !== "restore") return false; // `git -C <sub> restore` is the right form
    const paths = words.slice(words.indexOf("--") + 1).map(word => word.replaceAll("'", ""));
    return subs.some(sub => paths.some(path => path === sub || path.startsWith(`${sub}/`)));
  });
}

describe("submodule recovery: why the superproject forms are wrong", () => {
  it("restoring from the baseline fails inside a submodule and silently does nothing for a moved gitlink", async () => {
    const { dir, sub } = await withSubmodule();
    const audit = (await WorkspaceAudit.open(dir))!;
    const commit = await audit.checkpoint(await audit.snapshot());
    const start = git(sub, "rev-parse", "HEAD");
    await writeFile(join(sub, "file.txt"), "two\n");
    expect(() => sh(dir, `git restore --source=${commit} --worktree -- libs/sub/file.txt 2>/dev/null`)).toThrow();
    git(sub, "checkout", "-q", "--", "file.txt");
    git(sub, "commit", "-q", "--allow-empty", "-m", "move");
    const moved = git(sub, "rev-parse", "HEAD");
    expect(moved).not.toBe(start);
    sh(dir, `git restore --source=${commit} --worktree -- libs/sub`); // exits 0 ...
    expect(git(sub, "rev-parse", "HEAD")).toBe(moved); // ... and changes nothing
    // Without submodule information the old (wrong) output is all that can be produced; the detector used
    // in the tests below does flag it, so "no invalid form" is not vacuous.
    const legacy = recoveryCommands(commit, [{ path: "libs/sub/file.txt", status: "modified" }, { path: "libs/sub", status: "modified" }]).join("\n");
    expect(invalidRestores(legacy, ["libs/sub"])).toHaveLength(1);
    await audit.close();
  });
});

describe("submodule recovery: files inside a submodule", () => {
  it("restores them inside the submodule, removes new ones by path, and the superproject files from the baseline", async () => {
    const { dir, sub } = await withSubmodule();
    const audit = (await WorkspaceAudit.open(dir, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    const head = git(sub, "rev-parse", "HEAD");
    await writeFile(join(sub, "file.txt"), "two\n");
    await rm(join(sub, "keep.txt"));
    await writeFile(join(sub, "new.txt"), "new\n");
    await writeFile(join(dir, "src/a.ts"), "run edit\n");
    const { changes, gitlinks } = await audit.compare(before, await audit.snapshot());
    expect(gitlinks).toEqual([]);
    expect(changes.map(change => change.path)).toEqual(["libs/sub/file.txt", "libs/sub/keep.txt", "libs/sub/new.txt", "src/a.ts"]);

    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(states).toEqual([{ path: "libs/sub", from: head, to: head, indexed: head, tracked: ["file.txt", "keep.txt"] }]);

    const advice = describeWorkspaceChanges(commit, changes, [], states);
    expect(invalidRestores(advice, ["libs/sub"])).toEqual([]);
    expect(commandLines(advice)).toEqual([
      `git restore --source=${commit} --worktree -- src/a.ts`,
      "rm -- libs/sub/new.txt",
      "git -C libs/sub diff -- file.txt keep.txt",
      "git -C libs/sub restore -- file.txt keep.txt",
    ]);
    expect(advice).toContain("- modified: libs/sub/file.txt (inside submodule libs/sub)");
    // The warning says what the restore throws away.
    expect(advice).toContain("DISCARDS their uncommitted changes in submodule libs/sub");
    expect(advice).toContain("including any made before this run");
    expect(recoveryCommands(commit, changes, [], states)).toEqual([
      `git restore --source=${commit} --worktree -- src/a.ts`,
      "rm -- libs/sub/new.txt",
      "git -C libs/sub restore -- file.txt keep.txt",
    ]);

    // Every command works, and the result is the starting state in both repositories.
    for (const command of commandLines(advice)) sh(dir, command);
    expect(await readFile(join(sub, "file.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(sub, "keep.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(sub, "new.txt"))).toBe(false);
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toBe("a\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(sub, "status", "--porcelain")).toBe("");
    await audit.close();
  });

  it("never advises a file that someone else changed, inside a submodule or not", async () => {
    const { dir, sub } = await withSubmodule();
    const audit = (await WorkspaceAudit.open(dir, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    await writeFile(join(sub, "file.txt"), "two\n");
    await writeFile(join(sub, "keep.txt"), "someone else\n");
    const { changes } = await audit.compare(before, await audit.snapshot());
    const external: ExternalWorkspaceChange[] = [{ path: "libs/sub/keep.txt", status: "modified", reason: "concurrent session active; ambiguous" }];
    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    const advice = describeWorkspaceChanges(commit, changes, external, states);
    expect(commandLines(advice)).toEqual([
      "git -C libs/sub diff -- file.txt",
      "git -C libs/sub restore -- file.txt",
    ]);
    expect(recoveryCommands(commit, changes, external, states).join("\n")).not.toContain("keep.txt");
    expect(advice).toContain("- modified: libs/sub/keep.txt — concurrent session active; ambiguous");
    for (const command of commandLines(advice)) sh(dir, command);
    expect(await readFile(join(sub, "keep.txt"), "utf8")).toBe("someone else\n");
    await audit.close();
  });

  it("gives no restore command for a file the submodule's own index does not know, nor for an unreadable submodule", async () => {
    const { dir, sub } = await withSubmodule();
    await writeFile(join(sub, "scratch.txt"), "untracked before the run\n");
    const audit = (await WorkspaceAudit.open(dir, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    await writeFile(join(sub, "scratch.txt"), "changed by the run\n");
    await writeFile(join(sub, "file.txt"), "two\n");
    const { changes } = await audit.compare(before, await audit.snapshot());
    expect(changes.map(change => change.path)).toEqual(["libs/sub/file.txt", "libs/sub/scratch.txt"]);
    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(states[0]?.tracked).toEqual(["file.txt"]);
    const advice = describeWorkspaceChanges(commit, changes, [], states);
    expect(commandLines(advice)).toEqual(["git -C libs/sub diff -- file.txt", "git -C libs/sub restore -- file.txt"]);
    expect(advice).toContain("No restore command for libs/sub/scratch.txt");
    expect(advice).toContain("git -C libs/sub status");

    // The submodule's repository is gone: nothing can be restored there.
    await rm(join(sub, ".git"), { force: true });
    const gone = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(gone).toEqual([{ path: "libs/sub", from: git(dir, "rev-parse", "HEAD:libs/sub"), indexed: git(dir, "rev-parse", "HEAD:libs/sub") }]);
    const noCommands = describeWorkspaceChanges(commit, changes, [], gone);
    expect(commandLines(noCommands)).toEqual([]);
    expect(noCommands).toContain("No restore command for libs/sub/file.txt, libs/sub/scratch.txt");
    expect(recoveryCommands(commit, changes, [], gone)).toEqual([]);
    await audit.close();
  });

  it("finds a nested submodule and restores inside the innermost one", async () => {
    const inner = await repo({ "deep.txt": "deep\n" });
    const lib = await repo({ "file.txt": "one\n" });
    git(lib, "submodule", "add", "-q", inner, "inner");
    git(lib, "commit", "-qm", "add inner");
    const dir = await repo({ "top.txt": "top\n" });
    git(dir, "submodule", "add", "-q", lib, "libs/sub");
    git(dir, "submodule", "update", "--init", "--recursive", "-q");
    git(dir, "commit", "-qm", "add sub");
    const audit = (await WorkspaceAudit.open(dir, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    await writeFile(join(dir, "libs/sub/inner/deep.txt"), "deeper\n");
    await writeFile(join(dir, "libs/sub/file.txt"), "two\n");
    const { changes } = await audit.compare(before, await audit.snapshot());
    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(states.map(state => state.path)).toEqual(["libs/sub", "libs/sub/inner"]);
    expect(states[1]).toMatchObject({ parent: "libs/sub", tracked: ["deep.txt"] });
    const advice = describeWorkspaceChanges(commit, changes, [], states);
    expect(commandLines(advice)).toEqual([
      "git -C libs/sub diff -- file.txt",
      "git -C libs/sub restore -- file.txt",
      "git -C libs/sub/inner diff -- deep.txt",
      "git -C libs/sub/inner restore -- deep.txt",
    ]);
    expect(invalidRestores(advice, ["libs/sub"])).toEqual([]);
    for (const command of commandLines(advice)) sh(dir, command);
    expect(await readFile(join(dir, "libs/sub/inner/deep.txt"), "utf8")).toBe("deep\n");
    expect(await readFile(join(dir, "libs/sub/file.txt"), "utf8")).toBe("one\n");
    await audit.close();
  });

  it("works from a subdirectory cwd, with paths relative to it", async () => {
    const lib = await repo({ "file.txt": "one\n" });
    const dir = await repo({ "pkg/own.txt": "own\n" });
    git(dir, "submodule", "add", "-q", lib, "pkg/lib");
    git(dir, "commit", "-qm", "add sub");
    const cwd = join(dir, "pkg");
    const audit = (await WorkspaceAudit.open(cwd, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    await writeFile(join(cwd, "lib/file.txt"), "two\n");
    await writeFile(join(cwd, "own.txt"), "run edit\n");
    const { changes } = await audit.compare(before, await audit.snapshot());
    expect(changes.map(change => change.path)).toEqual(["lib/file.txt", "own.txt"]);
    const states = await inspectSubmodules(cwd, commit, changes.map(change => change.path));
    expect(states).toMatchObject([{ path: "lib", from: git(lib, "rev-parse", "HEAD"), tracked: ["file.txt"] }]);
    const advice = describeWorkspaceChanges(commit, changes, [], states);
    expect(invalidRestores(advice, ["lib"])).toEqual([]);
    for (const command of commandLines(advice)) sh(cwd, command);
    expect(await readFile(join(cwd, "lib/file.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(cwd, "own.txt"), "utf8")).toBe("own\n");
    await audit.close();
  });
});

describe("submodule recovery: a moved submodule HEAD (gitlink)", () => {
  /** A plain audit, as orche_run runs it: the moved HEAD is a modified file named after the submodule. */
  async function moved(stage = false) {
    const { dir, sub } = await withSubmodule();
    const audit = (await WorkspaceAudit.open(dir))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    const start = git(sub, "rev-parse", "HEAD");
    git(sub, "commit", "-q", "--allow-empty", "-m", "run commit");
    const end = git(sub, "rev-parse", "HEAD");
    if (stage) git(dir, "add", "libs/sub");
    const changes = await audit.diff(before, await audit.snapshot());
    await audit.close();
    return { dir, sub, commit, start, end, changes };
  }

  it("names the old commit and the way back, and never emits a git restore for the submodule path", async () => {
    const { dir, sub, commit, start, end, changes } = await moved();
    expect(changes).toEqual([{ path: "libs/sub", status: "modified" }]);
    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(states).toEqual([{ path: "libs/sub", from: start, to: end, indexed: start }]);

    const advice = describeWorkspaceChanges(commit, changes, [], states);
    expect(invalidRestores(advice, ["libs/sub"])).toEqual([]);
    expect(advice).not.toMatch(/git restore/);
    expect(advice).toContain("- modified: libs/sub (submodule HEAD)");
    expect(advice).toContain(`submodule libs/sub HEAD moved ${start.slice(0, 12)}→${end.slice(0, 12)}; to go back: git -C libs/sub checkout ${start}`);
    expect(advice).toContain("detached HEAD");
    // The superproject index still records the old commit, so `git submodule update` is the other way back.
    expect(advice).toContain("git submodule update -- libs/sub");
    expect(recoveryCommands(commit, changes, [], states)).toEqual([`git -C libs/sub checkout ${start}`]);
    expect(commandLines(advice)).toEqual([]);

    // Both ways really go back.
    sh(dir, `git -C libs/sub checkout ${start}`);
    expect(git(sub, "rev-parse", "HEAD")).toBe(start);
    git(sub, "checkout", "-q", end);
    sh(dir, "git submodule update -- libs/sub");
    expect(git(sub, "rev-parse", "HEAD")).toBe(start);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("does not offer `git submodule update` once the index records the new commit, only the checkout", async () => {
    const { dir, sub, commit, start, end, changes } = await moved(true);
    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(states).toEqual([{ path: "libs/sub", from: start, to: end, indexed: end }]);
    const advice = describeWorkspaceChanges(commit, changes, [], states);
    expect(advice).toContain(`to go back: git -C libs/sub checkout ${start}`);
    expect(advice).not.toContain("submodule update");
    expect(advice).not.toMatch(/git restore/);
    sh(dir, recoveryCommands(commit, changes, [], states)[0]!);
    expect(git(sub, "rev-parse", "HEAD")).toBe(start);
  });

  it("takes a gitlink from a recursive audit when the caller passes it as a change at the submodule path", async () => {
    const { dir, sub } = await withSubmodule();
    const audit = (await WorkspaceAudit.open(dir, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    const start = git(sub, "rev-parse", "HEAD");
    git(sub, "commit", "-q", "--allow-empty", "-m", "run commit");
    await writeFile(join(sub, "file.txt"), "two\n");
    const { changes, gitlinks } = await audit.compare(before, await audit.snapshot());
    expect(gitlinks).toHaveLength(1);
    const all: WorkspaceChange[] = [...changes, ...gitlinks.map(link => ({ path: link.path, status: "modified" as const }))];
    const states = await inspectSubmodules(dir, commit, all.map(change => change.path));
    const advice = describeWorkspaceChanges(commit, all, [], states);
    expect(invalidRestores(advice, ["libs/sub"])).toEqual([]);
    expect(advice).toContain(`to go back: git -C libs/sub checkout ${start}`);
    expect(advice).toContain("git -C libs/sub restore -- file.txt");
    await audit.close();
  });

  it("nested: the way back runs in the repository that records the inner submodule", async () => {
    const inner = await repo({ "deep.txt": "deep\n" });
    const lib = await repo({ "file.txt": "one\n" });
    git(lib, "submodule", "add", "-q", inner, "inner");
    git(lib, "commit", "-qm", "add inner");
    const dir = await repo({ "top.txt": "top\n" });
    git(dir, "submodule", "add", "-q", lib, "libs/sub");
    git(dir, "submodule", "update", "--init", "--recursive", "-q");
    git(dir, "commit", "-qm", "add sub");
    const audit = (await WorkspaceAudit.open(dir, undefined, { submodules: true }))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    const start = git(join(dir, "libs/sub/inner"), "rev-parse", "HEAD");
    git(join(dir, "libs/sub/inner"), "commit", "-q", "--allow-empty", "-m", "inner move");
    const { changes, gitlinks } = await audit.compare(before, await audit.snapshot());
    expect(changes).toEqual([]);
    expect(gitlinks.map(link => link.path)).toEqual(["libs/sub/inner"]);
    const asChanges = gitlinks.map(link => ({ path: link.path, status: "modified" as const }));
    const states = await inspectSubmodules(dir, commit, asChanges.map(change => change.path));
    const advice = describeWorkspaceChanges(commit, asChanges, [], states);
    expect(advice).toContain(`to go back: git -C libs/sub/inner checkout ${start}`);
    expect(advice).toContain("git -C libs/sub submodule update -- inner");
    expect(advice).not.toMatch(/git restore/);
    sh(dir, "git -C libs/sub submodule update -- inner");
    expect(git(join(dir, "libs/sub/inner"), "rev-parse", "HEAD")).toBe(start);
    await audit.close();
  });

  it("says nothing to move when the HEAD is back at the baseline, and suggests no command when a commit is unknown", () => {
    const change: WorkspaceChange[] = [{ path: "libs/sub", status: "modified" }];
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const back = describeWorkspaceChanges("c".repeat(40), change, [], [{ path: "libs/sub", from: A, to: A }]);
    expect(back).toContain("HEAD is back at the baseline commit");
    expect(recoveryCommands("c".repeat(40), change, [], [{ path: "libs/sub", from: A, to: A }])).toEqual([]);
    for (const state of [{ path: "libs/sub", to: B }, { path: "libs/sub", from: A }]) {
      expect(recoveryCommands("c".repeat(40), change, [], [state])).toEqual([]);
      const text = describeWorkspaceChanges("c".repeat(40), change, [], [state]);
      expect(text).toContain("no command is suggested");
      expect(text).not.toMatch(/git restore/);
    }
  });

  it("an added submodule gets no command (`rm` cannot remove it), a removed one is re-created from the index", async () => {
    const { dir, sub } = await withSubmodule();
    const other = await repo({ "o.txt": "o\n" });
    const audit = (await WorkspaceAudit.open(dir))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    git(dir, "submodule", "add", "-q", other, "libs/other");
    const added = await audit.diff(before, await audit.snapshot());
    expect(added).toEqual(expect.arrayContaining([{ path: "libs/other", status: "added" }]));
    const addedStates = await inspectSubmodules(dir, commit, added.map(change => change.path));
    const addedAdvice = describeWorkspaceChanges(commit, added, [], addedStates);
    expect(addedAdvice).toContain("submodule libs/other was added by this run; no command is suggested");
    expect(recoveryCommands(commit, added, [], addedStates).join("\n")).not.toContain("libs/other");
    expect(invalidRestores(addedAdvice, ["libs/other"])).toEqual([]);
    await audit.close();

    // The work tree directory of a submodule disappears while the index still records it.
    const second = await WorkspaceAudit.open(dir);
    const start = await second!.snapshot();
    const base = await second!.checkpoint(start);
    await rm(sub, { recursive: true, force: true });
    const removed = await second!.diff(start, await second!.snapshot());
    expect(removed).toEqual([{ path: "libs/sub", status: "deleted" }]);
    const states = await inspectSubmodules(dir, base, removed.map(change => change.path));
    expect(states).toMatchObject([{ path: "libs/sub", indexed: git(dir, "rev-parse", "HEAD:libs/sub") }]);
    expect(states[0]?.to).toBeUndefined();
    expect(recoveryCommands(base, removed, [], states)).toEqual(["git submodule update --init -- libs/sub"]);
    expect(describeWorkspaceChanges(base, removed, [], states)).toContain("to bring it back: git submodule update --init -- libs/sub");
    sh(dir, "git submodule update --init -- libs/sub");
    expect(await readFile(join(sub, "file.txt"), "utf8")).toBe("one\n");
    await second!.close();
  });
});

describe("inspectSubmodules", () => {
  it("is fail-soft: no paths, no repository, an unknown commit and an aborted signal never throw", async () => {
    const { dir } = await withSubmodule();
    expect(await inspectSubmodules(dir, "x".repeat(40), [])).toEqual([]);
    const plain = await mkdtemp(join(tmpdir(), "orche-subrec-plain-"));
    dirs.push(plain);
    expect(await inspectSubmodules(plain, "", ["libs/sub/file.txt"])).toEqual([]);
    expect(await inspectSubmodules(join(plain, "missing"), "", ["libs/sub/file.txt"])).toEqual([]);
    // An unknown baseline only loses `from`.
    expect(await inspectSubmodules(dir, "f".repeat(40), ["libs/sub/file.txt"])).toMatchObject([{ path: "libs/sub", tracked: ["file.txt"] }]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await inspectSubmodules(dir, "", ["libs/sub/file.txt"], aborted.signal)).toEqual([]);
  });

  it("ignores paths that are plain files, and does not touch the repositories", async () => {
    const { dir, sub } = await withSubmodule();
    const state = () => [git(dir, "status", "--porcelain=v2"), git(sub, "status", "--porcelain=v2"), git(dir, "ls-files", "-s"), git(dir, "rev-parse", "HEAD"), git(sub, "rev-parse", "HEAD")];
    await writeFile(join(sub, "file.txt"), "dirty\n");
    const before = state();
    expect(await inspectSubmodules(dir, "", ["top.txt", "src/a.ts", "libs/not-a-submodule.txt"])).toEqual([]);
    expect(await inspectSubmodules(dir, git(dir, "rev-parse", "HEAD"), ["libs/sub/file.txt"])).toHaveLength(1);
    expect(state()).toEqual(before);
  });

  it("does not misread paths of a plain repository: the advice stays the one-form-for-everything advice", async () => {
    const dir = await repo({ "a.ts": "a\n", "src/b.ts": "b\n" });
    const audit = (await WorkspaceAudit.open(dir))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    await writeFile(join(dir, "a.ts"), "x\n");
    await writeFile(join(dir, "src/new.ts"), "n\n");
    const changes = await audit.diff(before, await audit.snapshot());
    const states = await inspectSubmodules(dir, commit, changes.map(change => change.path));
    expect(states).toEqual([]);
    expect(describeWorkspaceChanges(commit, changes, [], states)).toBe(describeWorkspaceChanges(commit, changes));
    expect(recoveryCommands(commit, changes, [], states)).toEqual([`git restore --source=${commit} --worktree -- a.ts`, "rm -- src/new.ts"]);
    await audit.close();
  });
});
