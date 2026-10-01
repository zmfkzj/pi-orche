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

const MAX_LISTED = 20;
const quote = (path: string) => /^[\w./@+-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** Shell commands that put the listed files back to their pre-run contents. */
export function recoveryCommands(commit: string, changes: readonly WorkspaceChange[]): string[] {
  const restore = changes.filter(change => change.status !== "added").map(change => quote(change.path));
  const remove = changes.filter(change => change.status === "added").map(change => quote(change.path));
  const commands: string[] = [];
  if (restore.length) commands.push(`git restore --source=${commit} --worktree -- ${restore.join(" ")}`);
  if (remove.length) commands.push(`rm -- ${remove.join(" ")}`);
  return commands;
}

/** Human summary of workspace changes with recovery commands, for failure reports. */
export function describeWorkspaceChanges(commit: string, changes: readonly WorkspaceChange[]): string {
  if (!changes.length) return "";
  const listed = changes.slice(0, MAX_LISTED).map(change => `- ${change.status}: ${change.path}`);
  if (changes.length > MAX_LISTED) listed.push(`- … ${changes.length - MAX_LISTED} more (git diff --name-status ${commit})`);
  return [
    `Workspace changes since the run started (baseline ${commit.slice(0, 12)}, ref ${BASELINE_REF}):`,
    ...listed,
    "To restore the pre-run contents:",
    ...recoveryCommands(commit, changes.length > MAX_LISTED ? [] : changes).map(command => `  ${command}`),
    ...(changes.length > MAX_LISTED ? [`  git restore --source=${commit} --worktree -- .   # then remove added files`] : []),
  ].join("\n");
}
