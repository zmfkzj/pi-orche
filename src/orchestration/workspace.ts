import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Ref that keeps the latest run's baseline commit reachable (overwritten by every run). */
export const BASELINE_REF = "refs/pi-orche/baseline";
/** pi-orche's own spill artifacts never count as workspace changes. */
const EXCLUDED = ":(exclude).orche";
const IDENTITY = {
  GIT_AUTHOR_NAME: "pi-orche", GIT_AUTHOR_EMAIL: "pi-orche@localhost",
  GIT_COMMITTER_NAME: "pi-orche", GIT_COMMITTER_EMAIL: "pi-orche@localhost",
};

export interface WorkspaceChange {
  /** Path relative to the run's cwd. */
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
}

/**
 * A change that this run's workers did not make (another process or session, or a commit made
 * elsewhere). `reason` says why it is not attributed to the run. Reported, never restored.
 */
export type ExternalWorkspaceChange = WorkspaceChange & { reason: string };

/** A submodule (or embedded repository) whose recorded HEAD commit differs between two snapshots. */
export interface GitlinkChange {
  /** Path relative to the audit's cwd. */
  readonly path: string;
  /** Full commit ids; absent when the submodule did not exist on that side. */
  readonly from?: string;
  readonly to?: string;
}

/** File changes and gitlink (submodule HEAD) changes between two snapshots, see {@link WorkspaceAudit.compare}. */
export interface WorkspaceComparison {
  readonly changes: WorkspaceChange[];
  readonly gitlinks: GitlinkChange[];
}

export interface WorkspaceAuditOptions {
  /**
   * Also snapshot initialized submodules (default false: a submodule is then only its gitlink, i.e. the
   * HEAD commit it points at, exactly as before). With it, uncommitted changes inside submodules are
   * reported as `sub/file`, and a moved submodule HEAD is reported as a {@link GitlinkChange} instead of a file.
   */
  submodules?: boolean;
}

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const { stdout } = await execFileAsync("git", args, { cwd, signal, timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Snapshot ids are the tree id of the work tree. With submodule recursion the id continues with
 * `+` and the base64url JSON of the submodule trees (`[path, tree][]`, paths relative to the cwd), so
 * it stays self-describing across audit instances (a reused worker keeps its last id between assignments).
 */
const SNAPSHOT_SEP = "+";
/** Submodules snapshotted per snapshot (nested ones included), nesting depth, and wall time spent on them. */
const MAX_SUBMODULES = 32;
const MAX_SUBMODULE_DEPTH = 3;
const SUBMODULE_BUDGET_MS = 20_000;
const GITLINK_MODE = "160000";

interface SubmoduleTree { path: string; tree: string }

function encodeSnapshot(root: string, subs: readonly SubmoduleTree[]): string {
  if (!subs.length) return root;
  return `${root}${SNAPSHOT_SEP}${Buffer.from(JSON.stringify(subs.map(sub => [sub.path, sub.tree]))).toString("base64url")}`;
}

function decodeSnapshot(id: string): { root: string; subs: Map<string, string> } {
  const at = id.indexOf(SNAPSHOT_SEP);
  const subs = new Map<string, string>();
  if (at < 0) return { root: id, subs };
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id.slice(at + 1), "base64url").toString("utf8"));
    if (Array.isArray(parsed)) for (const entry of parsed) if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") subs.set(entry[0], entry[1]);
  } catch {
    // A damaged id only loses the submodule part.
  }
  return { root: id.slice(0, at), subs };
}

interface RawEntry { oldMode: string; newMode: string; oldSha: string; newSha: string; status: string; path: string }

/** Parse `git diff --raw -z --no-abbrev` (no renames): `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0`. */
function parseRaw(output: string): RawEntry[] {
  const tokens = output.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i]!;
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = meta.slice(1).split(" ");
    const path = tokens[++i];
    if (path) entries.push({ oldMode, newMode, oldSha, newSha, status, path });
  }
  return entries;
}

const commitOf = (sha: string) => sha && /[^0]/.test(sha) ? sha : undefined;
const exists = (path: string) => stat(path).then(() => true, () => false);
const posix = (path: string) => sep === "/" ? path : path.split(sep).join("/");

/** Paths of the submodules registered in `dir`'s .gitmodules (relative to `dir`); none when there is no usable file. */
async function registeredSubmodules(dir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const output = await git(dir, ["config", "--file", ".gitmodules", "-z", "--get-regexp", "^submodule\\..*\\.path$"], {}, signal);
    return output.split("\0").filter(Boolean).map(entry => entry.slice(entry.indexOf("\n") + 1)).filter(Boolean);
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}

/**
 * Content snapshots of a git working tree, taken through a private copy of the index so the
 * user's index, worktree, stash and HEAD are never touched. A snapshot covers tracked and
 * untracked, non-ignored files under `cwd`; changes made by any means (edit tools, bash,
 * generated files) show up in a diff between two snapshots. Ignored files are not covered.
 *
 * Submodules (opt-in, see {@link WorkspaceAuditOptions.submodules}): every initialized submodule under
 * `cwd` gets its own private index copy and tree, so edits inside it show up as `sub/file`. The cost is
 * bounded (at most 32 submodules, 3 levels, ~20 s per snapshot) and fail-soft: a submodule that cannot
 * be snapshotted is left out of that snapshot and never fails the audit.
 */
export class WorkspaceAudit {
  /** Work tree root of the audited repository (resolved on first use, only for submodule recursion). */
  private top: string | undefined;
  /** Private index per submodule work tree, seeded from the submodule's real index on first use. */
  private readonly subIndexes = new Map<string, string>();

  private constructor(readonly cwd: string, private readonly dir: string, private readonly index: string, private readonly signal?: AbortSignal, private readonly submodules = false) {}

  /** Undefined outside a git working tree or without git: the audit is then unavailable. */
  static async open(cwd: string, signal?: AbortSignal, options: WorkspaceAuditOptions = {}): Promise<WorkspaceAudit | undefined> {
    let index: string;
    try {
      if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"], {}, signal)).trim() !== "true") return undefined;
      index = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {}, signal)).trim();
    } catch {
      return undefined;
    }
    const dir = await mkdtemp(join(tmpdir(), "pi-orche-index-"));
    const own = join(dir, "index");
    try {
      // Seed the private index from the real one to reuse its stat cache. Its mtime must be kept:
      // git's racy-clean check compares file mtimes with the index's own mtime, and a fresh mtime
      // would let a same-size edit within the same second pass as unchanged.
      const info = await stat(index);
      await copyFile(index, own);
      await utimes(own, info.atime, info.mtime);
    } catch {
      // No index yet (fresh repository): start empty.
    }
    if (signal?.aborted) { await rm(dir, { recursive: true, force: true }); signal.throwIfAborted(); }
    return new WorkspaceAudit(cwd, dir, own, signal, options.submodules === true);
  }

  /**
   * Id of the current working tree contents (the private index persists between snapshots): the tree id,
   * extended with the submodule trees when submodule recursion is on and submodules are initialized.
   */
  async snapshot(): Promise<string> {
    const env = { GIT_INDEX_FILE: this.index };
    // An excluded pathspec still makes git add reject .orche when it is ignored. Stage
    // normally, then remove spill artifacts from this private index (never the worktree).
    await git(this.cwd, ["add", "--all", "--", "."], env, this.signal);
    await git(this.cwd, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ".orche"], env, this.signal);
    const root = (await git(this.cwd, ["write-tree"], env, this.signal)).trim();
    return this.submodules ? encodeSnapshot(root, await this.snapshotSubmodules()) : root;
  }

  /** Breadth-first over initialized submodules under `cwd`; optionally read HEAD trees instead of work trees. */
  private async snapshotSubmodules(heads?: Map<string, string>): Promise<SubmoduleTree[]> {
    const found: SubmoduleTree[] = [];
    try {
      this.top ??= (await git(this.cwd, ["rev-parse", "--show-toplevel"], {}, this.signal)).trim();
    } catch {
      this.signal?.throwIfAborted();
      return found;
    }
    if (!this.top) return found;
    const started = Date.now();
    const queue = [{ dir: this.top, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift()!;
      for (const registered of await registeredSubmodules(dir, this.signal)) {
        if (found.length >= MAX_SUBMODULES || Date.now() - started > SUBMODULE_BUDGET_MS) return found;
        const abs = join(dir, registered);
        const rel = relative(this.cwd, abs);
        if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue; // outside the audited directory
        if (!await exists(join(abs, ".git"))) continue; // not initialized
        try {
          if (heads) {
            const head = (await git(abs, ["rev-parse", "--verify", "-q", "HEAD"], {}, this.signal)).trim();
            const tree = (await git(abs, ["rev-parse", "--verify", "-q", `${head}^{tree}`], {}, this.signal)).trim();
            heads.set(posix(rel), head);
            found.push({ path: posix(rel), tree });
          } else found.push({ path: posix(rel), tree: await this.snapshotRepo(abs) });
          if (depth + 1 < MAX_SUBMODULE_DEPTH) queue.push({ dir: abs, depth: depth + 1 });
        } catch {
          this.signal?.throwIfAborted(); // cancellation is not "this submodule failed"
        }
      }
    }
    return found;
  }

  /** Tree of a submodule work tree through its private index (the submodule's own index is never written). */
  private async snapshotRepo(dir: string): Promise<string> {
    let index = this.subIndexes.get(dir);
    if (!index) {
      index = join(this.dir, `submodule-${this.subIndexes.size}.index`);
      try {
        // Same seeding as the root index, mtime included (racy-clean check).
        const real = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {}, this.signal)).trim();
        const info = await stat(real);
        await copyFile(real, index);
        await utimes(index, info.atime, info.mtime);
      } catch {
        this.signal?.throwIfAborted(); // no index yet: start empty
      }
      this.subIndexes.set(dir, index);
    }
    const env = { GIT_INDEX_FILE: index };
    await git(dir, ["add", "--all", "--", "."], env, this.signal);
    return (await git(dir, ["write-tree"], env, this.signal)).trim();
  }

  /** Remove the private index. */
  async close(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  /**
   * Files under `cwd` that differ between two snapshots. With submodule recursion a submodule's changed
   * files appear as `sub/file`, and a moved submodule HEAD is not a file: see {@link compare}.
   */
  async diff(from: string, to: string): Promise<WorkspaceChange[]> {
    if (from === to) return [];
    if (this.submodules) return (await this.compareRecursive(from, to)).changes;
    const fields = (await git(this.cwd, ["diff", "--relative", "--no-renames", "--name-status", "-z", from, to, "--", ".", EXCLUDED], {}, this.signal)).split("\0");
    const changes: WorkspaceChange[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const code = fields[i]!;
      const path = fields[i + 1]!;
      if (!code || !path) continue;
      changes.push({ path, status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified" });
    }
    return changes;
  }

  /**
   * File changes plus gitlink changes between two snapshots. Without submodule recursion this is
   * {@link diff} and no gitlinks (a moved submodule HEAD is then a modified file named after the submodule).
   */
  async compare(from: string, to: string): Promise<WorkspaceComparison> {
    if (from === to) return { changes: [], gitlinks: [] };
    if (!this.submodules) return { changes: await this.diff(from, to), gitlinks: [] };
    return this.compareRecursive(from, to);
  }

  private async compareRecursive(from: string, to: string): Promise<WorkspaceComparison> {
    const a = decodeSnapshot(from);
    const b = decodeSnapshot(to);
    const changes: WorkspaceChange[] = [];
    const gitlinks: GitlinkChange[] = [];
    const collect = async (dir: string, prefix: string, x: string, y: string, exclude: readonly string[]) => {
      if (x === y) return;
      const output = await git(dir, ["diff", "--relative", "--no-renames", "--no-abbrev", "--raw", "-z", x, y, "--", ".", ...exclude], {}, this.signal);
      for (const entry of parseRaw(output)) {
        if (entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) {
          const before = entry.oldMode === GITLINK_MODE ? commitOf(entry.oldSha) : undefined;
          const after = entry.newMode === GITLINK_MODE ? commitOf(entry.newSha) : undefined;
          gitlinks.push({ path: prefix + entry.path, ...(before ? { from: before } : {}), ...(after ? { to: after } : {}) });
        } else {
          changes.push({ path: prefix + entry.path, status: entry.status.startsWith("A") ? "added" : entry.status.startsWith("D") ? "deleted" : "modified" });
        }
      }
    };
    await collect(this.cwd, "", a.root, b.root, [EXCLUDED]);
    // A submodule present on one side only is just a gitlink that appeared or went away (reported above).
    for (const [path, tree] of b.subs) {
      const old = a.subs.get(path);
      if (old !== undefined) await collect(join(this.cwd, path), `${path}/`, old, tree, []);
    }
    const byPath = (x: { path: string }, y: { path: string }) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);
    return { changes: changes.sort(byPath), gitlinks: gitlinks.sort(byPath) };
  }

  /**
   * The commit HEAD points at right now (undefined on an unborn branch or if git fails). Reads
   * refs only: the user's index, worktree and HEAD are untouched. A HEAD that differs from the
   * one recorded at the start means someone committed, switched branch or reset during the run.
   */
  async head(): Promise<string | undefined> {
    try {
      return (await git(this.cwd, ["rev-parse", "--verify", "-q", "HEAD"], {}, this.signal)).trim() || undefined;
    } catch {
      this.signal?.throwIfAborted(); // cancellation must not look like "no HEAD"
      return undefined;
    }
  }

  /** Current HEAD content and commit per repository, comparable with recursive work-tree snapshots. Reads only. */
  async headSnapshot(): Promise<{ tree: string; heads: Map<string, string> } | undefined> {
    const head = await this.head();
    if (!head) return undefined;
    const heads = new Map([["", head]]);
    const root = await this.treeOf(head);
    const subs = this.submodules ? await this.snapshotSubmodules(heads) : [];
    return { tree: encodeSnapshot(root, subs), heads };
  }

  /**
   * Tree id of a commit in the audited repository (submodule contents are not included). Comparable
   * with plain snapshots through {@link diff}; use {@link headSnapshot} to compare current HEAD
   * content with recursive work-tree snapshots.
   */
  async treeOf(commit: string): Promise<string> {
    return (await git(this.cwd, ["rev-parse", "--verify", "-q", `${commit}^{tree}`], {}, this.signal)).trim();
  }

  /** Alias of {@link treeOf}, named for the common use on the result of {@link head}. */
  headTree(commit: string): Promise<string> {
    return this.treeOf(commit);
  }

  /**
   * Record `tree` as a commit (parented on HEAD when there is one) and point {@link BASELINE_REF}
   * at it, so the pre-run contents stay restorable with `git restore --source=<commit>`.
   * A failed ref update (e.g. a concurrent run holding the lock) keeps the unreferenced commit.
   */
  async checkpoint(tree: string): Promise<string> {
    const head = (await git(this.cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {}, this.signal).catch(() => "")).trim();
    const commit = (await git(this.cwd, ["commit-tree", decodeSnapshot(tree).root, ...(head ? ["-p", head] : []), "-m", "pi-orche run baseline"], IDENTITY, this.signal)).trim();
    await git(this.cwd, ["update-ref", "-m", "pi-orche run baseline", BASELINE_REF, commit], {}, this.signal).catch(() => undefined);
    return commit;
  }
}

/** Run-attributed changes listed one per line in a report; the rest is summarised. */
const MAX_LISTED = 20;
/** External files listed in a report (informational only: no command is ever built from them). */
const MAX_EXTERNAL_LISTED = 50;
/** Above this many run-attributed files the report stops spelling out one command per chunk. */
const MAX_COMMAND_PATHS = 200;
/** One shell command carries at most this many paths / characters of paths. */
const CHUNK_PATHS = 25;
const CHUNK_CHARS = 4_000;
const quote = (path: string) => /^[\w./@+-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** Split quoted paths into groups that keep every generated command line short. */
function chunked(paths: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const path of paths) {
    if (current.length && (current.length >= CHUNK_PATHS || size + path.length + 1 > CHUNK_CHARS)) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += path.length + 1;
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * What the recovery advice needs to know about one submodule (a gitlink: a path that the superproject
 * records as a commit id, not as files). Gathered live by {@link inspectSubmodules}; the advice functions
 * stay pure and take it as an argument. Without it they treat every path as a plain file of the audited
 * repository, which is wrong for `sub/file` (inside a submodule) and for `sub` itself (its HEAD).
 */
export interface SubmoduleState {
  /** Path relative to the audit's cwd. */
  readonly path: string;
  /** Path of the submodule that records this one (nested submodules); absent when the audited repository records it. */
  readonly parent?: string;
  /** Commit the baseline recorded for it (absent: unknown, or it did not exist then). */
  readonly from?: string;
  /** Commit its checked-out HEAD points at now (absent: not checked out, or unreadable). */
  readonly to?: string;
  /** Commit the index of the repository that records it holds now (absent: not in that index). */
  readonly indexed?: string;
  /** Of the reported files inside it, those its own index knows (absent: not looked up). */
  readonly tracked?: readonly string[];
}

/** Where a changed path lives: inside a submodule, at a submodule's own (gitlink) path, or neither. Longest submodule wins. */
function locate<T extends SubmoduleState>(path: string, states: readonly T[]): { inside?: T; gitlink?: T } {
  let best: T | undefined;
  for (const state of states) {
    if ((path === state.path || path.startsWith(`${state.path}/`)) && (!best || state.path.length > best.path.length)) best = state;
  }
  if (!best) return {};
  return best.path === path ? { gitlink: best } : { inside: best };
}

/** Advice for a submodule whose gitlink (its HEAD commit) is among the changes. `command` is set only when one actually works. */
interface GitlinkAdvice { line: string; command?: string }
/** Run files inside one submodule: `restore` can be restored there, `skipped` cannot (nothing in the submodule knows them). */
interface SubmoduleGroup { state: SubmoduleState; restore: string[]; skipped: string[] }
interface RecoveryPlan { restore: string[]; remove: string[]; groups: SubmoduleGroup[]; gitlinks: GitlinkAdvice[] }

const short = (commit: string) => commit.slice(0, 12);

function gitlinkAdvice(change: WorkspaceChange, state: SubmoduleState): GitlinkAdvice {
  /** `git submodule update` runs in the repository that records the submodule, with the path relative to it. */
  const update = (init: boolean) => {
    const here = state.parent ? state.path.slice(state.parent.length + 1) : state.path;
    return `${state.parent ? `git -C ${quote(state.parent)}` : "git"} submodule update${init ? " --init" : ""} -- ${quote(here)}`;
  };
  if (change.status === "added") {
    return { line: `submodule ${state.path} was added by this run; no command is suggested (removing a submodule is a deliberate git submodule deinit / git rm)` };
  }
  if (change.status === "deleted") {
    if (state.indexed) {
      const command = update(true);
      return { line: `submodule ${state.path} was removed from the work tree; to bring it back: ${command}`, command };
    }
    return { line: `submodule ${state.path} was removed from the work tree and its index entry is gone too; no command is suggested${state.from ? ` (baseline commit ${short(state.from)})` : ""}` };
  }
  const { from, to } = state;
  if (!from || !to) {
    return { line: `submodule ${state.path} HEAD changed (baseline ${from ? short(from) : "unknown"}, now ${to ? short(to) : "unreadable"}); no command is suggested` };
  }
  if (from === to) return { line: `submodule ${state.path} HEAD is back at the baseline commit ${short(from)}; nothing to move` };
  const command = `git -C ${quote(state.path)} checkout ${from}`;
  const alternative = state.indexed === from ? ` (or: ${update(false)}, the index still records ${short(from)})` : "";
  return { line: `submodule ${state.path} HEAD moved ${short(from)}→${short(to)}; to go back: ${command}${alternative}`, command };
}

/**
 * Sort the run's files into what a command can really restore. Plain files: `git restore --source=<baseline>`
 * (added ones: `rm`). A file inside a submodule is not in the superproject's baseline commit (that holds
 * only the gitlink), so `git restore --source=<baseline> -- sub/file` is invalid; such files are restored
 * inside the submodule instead. The gitlink itself is not a file: `git restore -- sub` leaves its HEAD alone.
 */
function planRecovery(own: readonly WorkspaceChange[], states: readonly SubmoduleState[]): RecoveryPlan {
  const plan: RecoveryPlan = { restore: [], remove: [], groups: [], gitlinks: [] };
  const groups = new Map<SubmoduleState, SubmoduleGroup>();
  for (const change of own) {
    const { inside, gitlink } = locate(change.path, states);
    if (gitlink) { plan.gitlinks.push(gitlinkAdvice(change, gitlink)); continue; }
    // A file the run created is removed by path wherever it lives.
    if (change.status === "added") { plan.remove.push(change.path); continue; }
    if (!inside) { plan.restore.push(change.path); continue; }
    let group = groups.get(inside);
    if (!group) {
      group = { state: inside, restore: [], skipped: [] };
      groups.set(inside, group);
      plan.groups.push(group);
    }
    const rel = change.path.slice(inside.path.length + 1);
    (inside.to === undefined || (inside.tracked && !inside.tracked.includes(rel)) ? group.skipped : group.restore).push(rel);
  }
  return plan;
}

const baselineCommands = (commit: string, plan: RecoveryPlan): string[] => [
  ...chunked(plan.restore.map(quote)).map(paths => `git restore --source=${commit} --worktree -- ${paths.join(" ")}`),
  ...chunked(plan.remove.map(quote)).map(paths => `rm -- ${paths.join(" ")}`),
];

/** Per chunk: the read-only preview and the restore, both for exactly the same files. */
const submoduleCommands = (group: SubmoduleGroup) => chunked(group.restore.map(quote)).map(paths => ({
  inspect: `git -C ${quote(group.state.path)} diff -- ${paths.join(" ")}`,
  restore: `git -C ${quote(group.state.path)} restore -- ${paths.join(" ")}`,
}));

/**
 * Shell commands that put the run-attributed files back to their pre-run contents.
 *
 * Every command is built from an explicit path list (chunked when long); there is deliberately
 * no blanket `-- .` form, because the worktree may also hold work of other processes (other
 * sessions, the user, their commits). `external` files are never restored: they are dropped from
 * the lists even if a caller passes them in `changes` too.
 *
 * `submodules` (see {@link inspectSubmodules}) makes the advice submodule-aware. A path inside a submodule
 * is restored with `git -C <sub> restore -- <file>` (never from the superproject baseline, which cannot
 * name it); a gitlink path gets `git -C <sub> checkout <old commit>` when its HEAD moved and no
 * `git restore` at all. Pass a gitlink move as a change at the submodule's path (what a plain audit
 * reports for it; for {@link WorkspaceAudit.compare} results add `{ path, status: "modified" }`).
 */
export function recoveryCommands(
  commit: string,
  changes: readonly WorkspaceChange[],
  external: readonly WorkspaceChange[] = [],
  submodules: readonly SubmoduleState[] = [],
): string[] {
  const foreign = new Set(external.map(change => change.path));
  const plan = planRecovery(changes.filter(change => !foreign.has(change.path)), submodules);
  return [
    ...baselineCommands(commit, plan),
    ...plan.groups.flatMap(group => submoduleCommands(group).map(command => command.restore)),
    ...plan.gitlinks.flatMap(advice => advice.command ? [advice.command] : []),
  ];
}

/**
 * Human summary of workspace changes with recovery commands, for failure reports.
 *
 * `changes` are the run-attributed files: only they get restore commands. `external` files
 * (committed or edited by someone else while the run was going) are listed separately and
 * explicitly marked not to be restored. Returns "" when there is nothing to report.
 *
 * `submodules` is optional (see {@link recoveryCommands}); without it every path is treated as a plain file.
 */
export function describeWorkspaceChanges(
  commit: string,
  changes: readonly WorkspaceChange[],
  external: readonly (WorkspaceChange & { reason?: string })[] = [],
  submodules: readonly SubmoduleState[] = [],
): string {
  const foreign = new Set(external.map(change => change.path));
  const own = changes.filter(change => !foreign.has(change.path));
  if (!own.length && !external.length) return "";
  const lines: string[] = [];
  if (own.length) {
    const tooMany = own.length > MAX_COMMAND_PATHS;
    const where = (path: string) => {
      const { inside, gitlink } = locate(path, submodules);
      return inside ? ` (inside submodule ${inside.path})` : gitlink ? " (submodule HEAD)" : "";
    };
    lines.push(`Workspace changes made by this run (baseline ${commit.slice(0, 12)}, ref ${BASELINE_REF}):`);
    lines.push(...own.slice(0, MAX_LISTED).map(change => `- ${change.status}: ${change.path}${where(change.path)}`));
    if (own.length > MAX_LISTED) {
      lines.push(`- … ${own.length - MAX_LISTED} more run files (${tooMany ? "not listed here" : "all are covered by the commands below"})`);
    }
    if (tooMany) {
      // Too many paths for reviewable commands: inspection only. Never a blanket restore.
      lines.push(
        `Too many run files (${own.length}) to spell out restore commands. Inspect with: git diff --name-status ${commit}`,
        "(that also lists files changed outside this run, if any); restore only files that belong to this run.",
      );
    } else {
      const plan = planRecovery(own, submodules);
      const plain = baselineCommands(commit, plan);
      if (plain.length) {
        lines.push("To restore the pre-run contents of these run files only:");
        lines.push(...plain.map(command => `  ${command}`));
      }
      for (const group of plan.groups) {
        const path = group.state.path;
        if (group.restore.length) {
          lines.push(
            `Inside submodule ${path}: the baseline commit holds only its gitlink, so these files cannot be restored from it.`,
            `Inspect first, then restore: this takes the files back to the state of the submodule's own index (its HEAD content unless something is staged there) and DISCARDS their uncommitted changes in submodule ${path}, including any made before this run (an empty diff means the change was committed inside the submodule):`,
          );
          for (const command of submoduleCommands(group)) lines.push(`  ${command.inspect}`, `  ${command.restore}`);
        }
        if (group.skipped.length) {
          const listed = group.skipped.slice(0, MAX_LISTED).map(rel => `${path}/${rel}`).join(", ");
          lines.push(`No restore command for ${listed}${group.skipped.length > MAX_LISTED ? `, … ${group.skipped.length - MAX_LISTED} more` : ""}: the submodule's own index does not know them (untracked or staged for deletion) or it is not checked out; inspect with: git -C ${quote(path)} status`);
        }
      }
      if (plan.gitlinks.length) {
        lines.push(
          "Submodule HEAD changes (a submodule is a gitlink, not files: restoring its path as a file would leave its HEAD where it is, so no such command is suggested; checking out the old commit leaves the submodule on a detached HEAD, switch back to your branch afterwards):",
          ...plan.gitlinks.map(advice => `- ${advice.line}`),
        );
      }
    }
  } else {
    lines.push("No workspace change is attributed to this run.");
  }
  if (external.length) {
    lines.push(
      "",
      "Files changed outside this run; not restored — do not restore (another process, session or commit made these changes):",
      ...external.slice(0, MAX_EXTERNAL_LISTED).map(change => `- ${change.status}: ${change.path}${change.reason ? ` — ${change.reason}` : ""}`),
    );
    if (external.length > MAX_EXTERNAL_LISTED) lines.push(`- … ${external.length - MAX_EXTERNAL_LISTED} more changed outside this run`);
  }
  return lines.join("\n");
}

/**
 * Look up, live, the submodules the advice needs for `paths` (the changed paths, relative to `cwd`): every
 * gitlink that is one of the paths or contains one, found in the index (`git ls-files -s`, mode 160000, so
 * embedded repositories count too) and, for a path that went away, in the baseline commit (`git ls-tree`).
 * For each: the commit the baseline recorded, the commit its HEAD is at now, the commit the index records,
 * and which of the paths its own index knows. Nested submodules are followed under the same bounds as
 * {@link WorkspaceAudit} (32 submodules, 3 levels, ~20 s).
 *
 * Read-only and fail-soft: it never throws and never touches an index, HEAD or work tree; anything it cannot
 * read is simply absent from the result. `signal` is optional on purpose: a report written after a cancel
 * should not pass the already-aborted signal (an aborted lookup returns what it has so far).
 * Pass the result to {@link describeWorkspaceChanges} / {@link recoveryCommands}.
 */
export async function inspectSubmodules(cwd: string, commit: string, paths: readonly string[], signal?: AbortSignal): Promise<SubmoduleState[]> {
  type Draft = { -readonly [K in keyof SubmoduleState]: SubmoduleState[K] };
  const wanted = [...new Set(paths)].slice(0, MAX_COMMAND_PATHS); // beyond that the report spells out no commands
  const found: Draft[] = [];
  if (!wanted.length) return found;
  const started = Date.now();
  const read = (dir: string, args: readonly string[]) => git(dir, ["--literal-pathspecs", ...args], {}, signal);
  const queue: { path: string; baseline: string | undefined; depth: number }[] = [{ path: "", baseline: commit || undefined, depth: 0 }];
  while (queue.length && found.length < MAX_SUBMODULES && Date.now() - started <= SUBMODULE_BUDGET_MS) {
    const repo = queue.shift()!;
    const dir = repo.path ? join(cwd, repo.path) : cwd;
    const prefix = repo.path ? `${repo.path}/` : "";
    // Paths relative to this repository.
    const inside = wanted.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
    const touches = (link: string) => inside.some(path => path === link || path.startsWith(`${link}/`));
    try {
      const indexed = new Map<string, string>();
      for (const entry of (await read(dir, ["ls-files", "-s", "-z"])).split("\0")) {
        const match = /^160000 ([0-9a-f]+) \d\t([\s\S]+)$/.exec(entry);
        if (match && touches(match[2]!)) indexed.set(match[2]!, match[1]!);
      }
      // The baseline's gitlinks among the same paths: also finds a submodule that went away from the index.
      const baseline = new Map<string, string>();
      if (repo.baseline) {
        try {
          for (const entry of (await read(dir, ["ls-tree", "-z", repo.baseline, "--", ...new Set([...inside, ...indexed.keys()])])).split("\0")) {
            const match = /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
            if (match) baseline.set(match[2]!, match[1]!);
          }
        } catch {
          if (signal?.aborted) break; // otherwise: the baseline commit is unknown here, `from` stays absent
        }
      }
      for (const link of new Set([...indexed.keys(), ...baseline.keys()])) {
        if (found.length >= MAX_SUBMODULES) break;
        const full = prefix + link;
        const abs = join(dir, link);
        let to: string | undefined;
        if (await exists(join(abs, ".git"))) {
          try {
            to = (await git(abs, ["rev-parse", "--verify", "-q", "HEAD"], {}, signal)).trim() || undefined;
          } catch {
            if (signal?.aborted) break;
          }
        }
        const from = baseline.get(link);
        const recorded = indexed.get(link);
        found.push({ path: full, ...(repo.path ? { parent: repo.path } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(recorded ? { indexed: recorded } : {}) });
        // Only a submodule that holds more of the changed paths is worth descending into.
        if (to && repo.depth + 1 < MAX_SUBMODULE_DEPTH && inside.some(path => path.startsWith(`${link}/`))) queue.push({ path: full, baseline: from, depth: repo.depth + 1 });
      }
    } catch {
      if (signal?.aborted) break; // this repository could not be read: its submodules are left out
    }
  }
  // Which of the files inside each submodule does its own index know (restorable there)?
  const inner = new Map<Draft, string[]>();
  for (const path of wanted) {
    const { inside } = locate(path, found);
    if (inside) inner.set(inside, [...(inner.get(inside) ?? []), path.slice(inside.path.length + 1)]);
  }
  for (const [state, files] of inner) {
    if (!state.to) continue;
    try {
      state.tracked = (await read(join(cwd, state.path), ["ls-files", "-z", "--", ...files])).split("\0").filter(Boolean);
    } catch {
      if (signal?.aborted) break;
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
