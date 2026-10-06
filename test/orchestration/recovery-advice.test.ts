import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeWorkspaceChanges, recoveryCommands, WorkspaceAudit,
  type ExternalWorkspaceChange, type SubmoduleState, type WorkspaceChange,
} from "../../src/orchestration/workspace.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
/** The "-- ." pathspec that would touch the whole worktree (a dot-file path like `-- .gitignore` is fine). */
const BLANKET = /--\s+\.(\s|$)/;
const NOTE = "changed outside this run; not restored — do not restore";

const run = (count: number, prefix = "src/run"): WorkspaceChange[] =>
  Array.from({ length: count }, (_, i) => ({ path: `${prefix}-${i}.ts`, status: i % 4 === 3 ? "added" as const : "modified" as const }));
const outside = (count: number): ExternalWorkspaceChange[] =>
  Array.from({ length: count }, (_, i) => ({ path: `package-${i}.json`, status: "modified" as const, reason: "committed outside this run" }));
/** Lines of a description that are shell commands (indented), as opposed to listings. */
const commandLines = (text: string) => text.split("\n").filter(line => /^ {2}\S/.test(line));

describe("recovery advice", () => {
  it("keeps the 2-argument signature and restores/removes exactly the listed files", () => {
    const changes: WorkspaceChange[] = [{ path: "a.ts", status: "modified" }, { path: "new file.txt", status: "added" }, { path: "gone.ts", status: "deleted" }];
    expect(recoveryCommands(COMMIT, changes)).toEqual([
      `git restore --source=${COMMIT} --worktree -- a.ts gone.ts`,
      "rm -- 'new file.txt'",
    ]);
    const text = describeWorkspaceChanges(COMMIT, changes);
    expect(text).toContain("- modified: a.ts");
    expect(text).toContain("rm -- 'new file.txt'");
    expect(text).not.toContain(NOTE);
    expect(describeWorkspaceChanges(COMMIT, [])).toBe("");
  });

  it("never puts external paths into a command, even when they also appear among the run changes", () => {
    const external = outside(3);
    const changes = [...run(5), ...external.map(({ path, status }) => ({ path, status }))];
    const commands = recoveryCommands(COMMIT, changes, external);
    expect(commands.join("\n")).not.toMatch(BLANKET);
    for (const change of external) expect(commands.join("\n")).not.toContain(change.path);
    for (const change of run(5)) expect(commands.join("\n")).toContain(change.path);

    const text = describeWorkspaceChanges(COMMIT, changes, external);
    for (const line of commandLines(text)) for (const change of external) expect(line).not.toContain(change.path);
  });

  it("lists external files under the do-not-restore note, with their reason", () => {
    const text = describeWorkspaceChanges(COMMIT, run(2), outside(2));
    const section = text.slice(text.indexOf(NOTE));
    expect(text).toContain(NOTE);
    expect(section).toContain("- modified: package-0.json — committed outside this run");
    expect(section).toContain("- modified: package-1.json — committed outside this run");
    // The run's own files are not under the note.
    expect(section).not.toContain("src/run-0.ts");
    expect(text.slice(0, text.indexOf(NOTE))).not.toContain("package-0.json");
    expect(text).not.toMatch(BLANKET);
  });

  it("reports external changes even when the run itself changed nothing, without any command", () => {
    const text = describeWorkspaceChanges(COMMIT, [], outside(1));
    expect(text).toContain("No workspace change is attributed to this run");
    expect(text).toContain(NOTE);
    expect(text).toContain("package-0.json");
    expect(commandLines(text)).toEqual([]);
  });

  it("above 20 run files, emits commands from the explicit run path list and no blanket restore", () => {
    const changes = run(45);
    const external = outside(4);
    const text = describeWorkspaceChanges(COMMIT, changes, external);
    expect(text).not.toMatch(BLANKET);
    expect(text).not.toContain("-- .\n");
    expect(text).toContain("… 25 more run files");

    const commands = commandLines(text);
    expect(commands.length).toBeGreaterThan(1); // chunked
    for (const command of commands) {
      expect(command).toMatch(/^ {2}(git restore --source=[0-9a-f]+ --worktree|rm) -- \S/);
      expect(command).not.toMatch(BLANKET);
      expect(command.split(" ").length).toBeLessThanOrEqual(40);
      for (const change of external) expect(command).not.toContain(change.path);
    }
    // Every run path (including those beyond the first 20 listed) is in exactly one command.
    for (const change of changes) expect(commands.filter(command => command.split(" ").includes(change.path))).toHaveLength(1);
    // External files stay under the note.
    for (const change of external) expect(text.slice(text.indexOf(NOTE))).toContain(change.path);
  });

  it("above 20 run files and 20+ external files still never mixes them", () => {
    const changes = run(30);
    const external = outside(25);
    const commands = recoveryCommands(COMMIT, changes, external).join("\n");
    expect(commands).not.toMatch(BLANKET);
    for (const change of external) expect(commands).not.toContain(change.path);
    const text = describeWorkspaceChanges(COMMIT, changes, external);
    expect(text).toContain(NOTE);
    for (const line of commandLines(text)) for (const change of external) expect(line).not.toContain(change.path);
  });

  it("chunks by path length as well", () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ path: `${"d".repeat(900)}/${i}.ts`, status: "modified" as const }));
    const commands = recoveryCommands(COMMIT, long);
    expect(commands.length).toBeGreaterThan(1);
    expect(commands.join(" ").split(" ").filter(part => part.endsWith(".ts"))).toHaveLength(10);
  });

  it("falls back to an inspection hint (never a blanket restore) for very many run files", () => {
    const changes = run(260);
    const text = describeWorkspaceChanges(COMMIT, changes, outside(2));
    expect(text).not.toMatch(BLANKET);
    expect(commandLines(text)).toEqual([]);
    expect(text).toContain(`git diff --name-status ${COMMIT}`);
    expect(text).toContain(NOTE);
    expect(text).toContain("package-1.json");
  });

});

describe("recovery advice on a real worktree", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orche-advice-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    return dir;
  }

  it("restores the run's 30 files and leaves a concurrent session's edits and commit alone", async () => {
    const files: Record<string, string> = { "package.json": "{}\n", "lock.json": "{}\n" };
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = `export const v = ${i};\n`;
    const dir = await repo(files);
    const audit = (await WorkspaceAudit.open(dir))!;
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    const startHead = await audit.head();
    expect(startHead).toBe(git(dir, "rev-parse", "HEAD"));
    expect(await audit.treeOf(startHead!)).toBe(git(dir, "rev-parse", "HEAD^{tree}"));
    expect(await audit.headTree(startHead!)).toBe(await audit.treeOf(startHead!));

    // The run edits 30 files and adds one.
    for (let i = 0; i < 30; i++) await writeFile(join(dir, `src/f${i}.ts`), `export const v = "run ${i}";\n`);
    await writeFile(join(dir, "src/created.ts"), "created by the run\n");
    const afterRun = await audit.snapshot();
    const runChanges = await audit.diff(before, afterRun);
    expect(runChanges).toHaveLength(31);

    // Meanwhile another session edits and commits package.json and edits lock.json.
    await writeFile(join(dir, "package.json"), '{"changed":"elsewhere"}\n');
    git(dir, "add", "package.json");
    git(dir, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "other session");
    await writeFile(join(dir, "lock.json"), '{"edited":"elsewhere"}\n');
    const after = await audit.snapshot();

    // New HEAD + diffs: package.json equals the new HEAD (external), lock.json is only uncommitted.
    const newHead = (await audit.head())!;
    expect(newHead).not.toBe(startHead);
    const sinceBaseline = await audit.diff(before, after);
    const differsFromHead = await audit.diff(await audit.treeOf(newHead), after);
    expect(sinceBaseline.map(change => change.path)).toEqual(expect.arrayContaining(["package.json", "lock.json"]));
    expect(differsFromHead.map(change => change.path)).not.toContain("package.json");
    expect(differsFromHead.map(change => change.path)).toContain("lock.json");

    const external: ExternalWorkspaceChange[] = [
      { path: "package.json", status: "modified", reason: "committed outside this run" },
      { path: "lock.json", status: "modified", reason: "changed while no worker tool was running" },
    ];
    const advice = describeWorkspaceChanges(commit, runChanges, external);
    expect(advice).not.toMatch(BLANKET);
    for (const command of commandLines(advice)) execFileSync("sh", ["-c", command], { cwd: dir });

    // The run's files are back to the baseline ...
    for (let i = 0; i < 30; i++) expect(await readFile(join(dir, `src/f${i}.ts`), "utf8")).toBe(`export const v = ${i};\n`);
    expect(existsSync(join(dir, "src/created.ts"))).toBe(false);
    // ... and the other session's work is untouched.
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe('{"changed":"elsewhere"}\n');
    expect(await readFile(join(dir, "lock.json"), "utf8")).toBe('{"edited":"elsewhere"}\n');
    expect(git(dir, "rev-parse", "HEAD")).toBe(newHead);
    await audit.close();
  });

  it("head() is undefined on an unborn branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-unborn-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    const audit = (await WorkspaceAudit.open(dir))!;
    expect(await audit.head()).toBeUndefined();
    await audit.close();
  });
});

/** Submodule information is optional and explicit: the advice functions stay pure (real repositories: submodule-recovery.test.ts). */
describe("recovery advice with submodule information", () => {
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const sub: SubmoduleState = { path: "libs/sub", from: OLD, to: NEW, indexed: OLD, tracked: ["file.txt", "dir/a b.txt", "gone.txt"] };
  const change = (path: string, status: WorkspaceChange["status"] = "modified"): WorkspaceChange => ({ path, status });

  it("puts a path inside a submodule on `git -C <sub>` and never on the superproject baseline form", () => {
    const changes = [change("src/a.ts"), change("libs/sub/file.txt"), change("libs/sub/dir/a b.txt"), change("libs/sub/gone.txt", "deleted"), change("libs/sub/new.txt", "added")];
    const commands = recoveryCommands(COMMIT, changes, [], [sub]);
    expect(commands).toEqual([
      `git restore --source=${COMMIT} --worktree -- src/a.ts`,
      "rm -- libs/sub/new.txt",
      "git -C libs/sub restore -- file.txt 'dir/a b.txt' gone.txt",
    ]);
    for (const command of commands.filter(command => command.startsWith("git restore"))) expect(command).not.toContain("libs/sub");
    const text = describeWorkspaceChanges(COMMIT, changes, [], [sub]);
    expect(commandLines(text).map(line => line.trim())).toEqual([
      ...commands.slice(0, 2),
      "git -C libs/sub diff -- file.txt 'dir/a b.txt' gone.txt",
      commands[2],
    ]);
    expect(text).toContain("DISCARDS");
  });

  it("quotes the submodule path and chunks long file lists like any other command", () => {
    const spaced: SubmoduleState = { path: "my libs/sub", to: NEW };
    const files = Array.from({ length: 60 }, (_, i) => change(`my libs/sub/f${i}.ts`));
    const commands = recoveryCommands(COMMIT, files, [], [spaced]);
    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) {
      expect(command).toMatch(/^git -C 'my libs\/sub' restore -- f\d+\.ts/);
      expect(command.split(" ").length).toBeLessThanOrEqual(40);
    }
    expect(commands.join(" ").match(/f\d+\.ts/g)).toHaveLength(60);
  });

  it("never emits `git restore` for a gitlink, whatever is known about it", () => {
    const states: SubmoduleState[] = [
      sub, { path: "libs/sub", from: OLD, to: OLD }, { path: "libs/sub", to: NEW }, { path: "libs/sub", from: OLD },
      { path: "libs/sub", from: OLD, to: NEW, indexed: NEW }, { path: "libs/sub" },
    ];
    for (const status of ["modified", "added", "deleted"] as const) {
      for (const state of states) {
        const changes = [change("libs/sub", status)];
        const text = describeWorkspaceChanges(COMMIT, changes, [], [state]);
        expect(text).not.toMatch(/git restore/);
        expect(text).not.toMatch(/\brm --/);
        expect(recoveryCommands(COMMIT, changes, [], [state]).every(command => !command.startsWith("git restore") && !command.startsWith("rm"))).toBe(true);
        expect(text).not.toMatch(BLANKET);
      }
    }
    // The one command a moved HEAD gets, and its caveat.
    const text = describeWorkspaceChanges(COMMIT, [change("libs/sub")], [], [sub]);
    expect(text).toContain(`submodule libs/sub HEAD moved ${OLD.slice(0, 12)}→${NEW.slice(0, 12)}; to go back: git -C libs/sub checkout ${OLD}`);
    expect(text).toContain("detached HEAD");
    expect(text).toContain("(or: git submodule update -- libs/sub, the index still records");
    expect(describeWorkspaceChanges(COMMIT, [change("libs/sub")], [], [{ ...sub, indexed: NEW }])).not.toContain("submodule update");
  });

  it("never advises external paths, inside a submodule or at its gitlink", () => {
    const external: ExternalWorkspaceChange[] = [
      { path: "libs/sub/file.txt", status: "modified", reason: "concurrent session active; ambiguous" },
      { path: "libs/sub", status: "modified", reason: "committed outside this run" },
    ];
    const changes = [...external.map(({ path, status }) => ({ path, status })), change("libs/sub/gone.txt", "deleted"), change("src/a.ts")];
    const commands = recoveryCommands(COMMIT, changes, external, [sub]);
    expect(commands).toEqual([`git restore --source=${COMMIT} --worktree -- src/a.ts`, "git -C libs/sub restore -- gone.txt"]);
    const text = describeWorkspaceChanges(COMMIT, changes, external, [sub]);
    expect(text).not.toMatch(/checkout|submodule update/);
    expect(text.slice(text.indexOf(NOTE))).toContain("- modified: libs/sub/file.txt — concurrent session active; ambiguous");
    for (const line of commandLines(text)) expect(line).not.toContain("file.txt");
  });

  it("picks the innermost submodule and leaves similarly named plain paths alone", () => {
    const outer: SubmoduleState = { path: "libs/sub", to: NEW };
    const inner: SubmoduleState = { path: "libs/sub/inner", parent: "libs/sub", to: NEW };
    const changes = [change("libs/sub/inner/deep.txt"), change("libs/sub/x.txt"), change("libs/subway/y.txt"), change("libs/sub-x.txt")];
    expect(recoveryCommands(COMMIT, changes, [], [outer, inner])).toEqual([
      `git restore --source=${COMMIT} --worktree -- libs/subway/y.txt libs/sub-x.txt`,
      "git -C libs/sub/inner restore -- deep.txt",
      "git -C libs/sub restore -- x.txt",
    ]);
  });

  it("above 200 run files it is still inspection only, with or without submodule information", () => {
    const many = [...run(260), change("libs/sub/file.txt")];
    const text = describeWorkspaceChanges(COMMIT, many, [], [sub]);
    expect(commandLines(text)).toEqual([]);
    expect(text).toContain(`git diff --name-status ${COMMIT}`);
  });
});

