import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const { stdout } = await execFileAsync("git", args, { cwd, signal, timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Content snapshots of a git working tree, taken through a private copy of the index so the
 * user's index, worktree, stash and HEAD are never touched. A snapshot covers tracked and
 * untracked, non-ignored files under `cwd`; changes made by any means (edit tools, bash,
 * generated files) show up in a diff between two snapshots. Ignored files are not covered.
 */
export class WorkspaceAudit {
  private constructor(readonly cwd: string, private readonly dir: string, private readonly index: string, private readonly signal?: AbortSignal) {}

  /** Undefined outside a git working tree or without git: the audit is then unavailable. */
  static async open(cwd: string, signal?: AbortSignal): Promise<WorkspaceAudit | undefined> {
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
    return new WorkspaceAudit(cwd, dir, own, signal);
  }

  /** Tree id of the current working tree contents (the private index persists between snapshots). */
  async snapshot(): Promise<string> {
    const env = { GIT_INDEX_FILE: this.index };
    // An excluded pathspec still makes git add reject .orche when it is ignored. Stage
    // normally, then remove spill artifacts from this private index (never the worktree).
    await git(this.cwd, ["add", "--all", "--", "."], env, this.signal);
    await git(this.cwd, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ".orche"], env, this.signal);
    return (await git(this.cwd, ["write-tree"], env, this.signal)).trim();
  }

  /** Remove the private index. */
  async close(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Files under `cwd` that differ between two snapshots. */
  async diff(from: string, to: string): Promise<WorkspaceChange[]> {
    if (from === to) return [];
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

  /**
   * Tree id of a commit, comparable with {@link snapshot} trees through {@link diff}: with the
   * baseline tree, the tree of the new HEAD and the current snapshot, a file whose snapshot
   * content equals the new HEAD but differs from the baseline was committed by someone else.
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
    const commit = (await git(this.cwd, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "pi-orche run baseline"], IDENTITY, this.signal)).trim();
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
 * Shell commands that put the run-attributed files back to their pre-run contents.
 *
 * Every command is built from an explicit path list (chunked when long); there is deliberately
 * no blanket `-- .` form, because the worktree may also hold work of other processes (other
 * sessions, the user, their commits). `external` files are never restored: they are dropped from
 * the lists even if a caller passes them in `changes` too.
 */
export function recoveryCommands(commit: string, changes: readonly WorkspaceChange[], external: readonly WorkspaceChange[] = []): string[] {
  const foreign = new Set(external.map(change => change.path));
  const own = changes.filter(change => !foreign.has(change.path));
  const restore = own.filter(change => change.status !== "added").map(change => quote(change.path));
  const remove = own.filter(change => change.status === "added").map(change => quote(change.path));
  return [
    ...chunked(restore).map(paths => `git restore --source=${commit} --worktree -- ${paths.join(" ")}`),
    ...chunked(remove).map(paths => `rm -- ${paths.join(" ")}`),
  ];
}

/**
 * Human summary of workspace changes with recovery commands, for failure reports.
 *
 * `changes` are the run-attributed files: only they get restore commands. `external` files
 * (committed or edited by someone else while the run was going) are listed separately and
 * explicitly marked not to be restored. Returns "" when there is nothing to report.
 */
export function describeWorkspaceChanges(
  commit: string,
  changes: readonly WorkspaceChange[],
  external: readonly (WorkspaceChange & { reason?: string })[] = [],
): string {
  const foreign = new Set(external.map(change => change.path));
  const own = changes.filter(change => !foreign.has(change.path));
  if (!own.length && !external.length) return "";
  const lines: string[] = [];
  if (own.length) {
    const tooMany = own.length > MAX_COMMAND_PATHS;
    lines.push(`Workspace changes made by this run (baseline ${commit.slice(0, 12)}, ref ${BASELINE_REF}):`);
    lines.push(...own.slice(0, MAX_LISTED).map(change => `- ${change.status}: ${change.path}`));
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
      lines.push("To restore the pre-run contents of these run files only:");
      lines.push(...recoveryCommands(commit, own).map(command => `  ${command}`));
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
