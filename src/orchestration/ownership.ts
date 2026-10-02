import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeOwnedPath, type TaskItem } from "./backlog.js";

/** Tools that write files through an explicit `path` argument; guarded before they run. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_rewrite", "generate_image"]);
/** Assignment kinds that may write at all, and then only to the worker's owned files. */
export const WRITING_KINDS: ReadonlySet<string> = new Set(["implement", "fix", "game-asset", "video"]);

/** Whether `file` (repository-relative, normalized) lies inside one owned path. */
export function ownsPath(owned: string, file: string): boolean {
  const path = normalizeOwnedPath(owned);
  if (path.endsWith("/")) return file === path.slice(0, -1) || `${file}/`.startsWith(path);
  return file === path;
}

/** Tasks whose ownership covers `file`. */
export function coveringTasks(tasks: readonly TaskItem[], file: string): readonly TaskItem[] {
  return tasks.filter(task => task.files.some(owned => ownsPath(owned, file)));
}

export interface WriteCheck {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly cwd: string;
  readonly agentId: string;
  readonly assignmentKind: string | undefined;
  readonly tasks: readonly TaskItem[];
}
export interface BlockedWrite {
  /** Workspace-relative target, or the raw argument when it resolves outside the workspace. */
  readonly file: string;
  readonly reason: string;
}

/** Optional filesystem evidence keeps the classifier itself pure and synchronous. */
export type RealWritePaths = { readonly cwd: string; readonly target: string } | { readonly error: string };

/**
 * Pre-execution ownership decision for one write-tool call: undefined allows it.
 * Only implement/fix/game-asset/video assignments may write, and only inside files their worker owns in the
 * canonical backlog. `ast_rewrite` needs an explicit owned `path` (its default is the whole
 * workspace) unless it is a dry run.
 */
export function checkWrite(check: WriteCheck, real?: RealWritePaths): BlockedWrite | undefined {
  if (!WRITE_TOOLS.has(check.toolName)) return undefined;
  if (check.toolName === "ast_rewrite" && check.input.dryRun === true) return undefined;
  const raw = check.input.path;
  const owned = [...new Set(check.tasks.filter(task => task.owner === check.agentId).flatMap(task => task.files))];
  const ownedText = owned.length ? owned.join(", ") : "none";
  const advice = "If the task really needs it, stop and report_result with data.status \"blocked\" and the reason.";
  if (typeof raw !== "string" || !raw.trim()) {
    return { file: "(workspace)", reason: `Blocked: ${check.toolName} needs an explicit path inside your owned files (${ownedText}). ${advice}` };
  }
  const absolute = resolve(check.cwd, raw);
  const rel = relative(check.cwd, absolute);
  if (!rel || rel.split(sep)[0] === ".." || isAbsolute(rel)) {
    return { file: raw, reason: `Blocked: ${raw} is outside the workspace. ${advice}` };
  }
  const file = normalizeOwnedPath(rel);
  if (!check.assignmentKind || !WRITING_KINDS.has(check.assignmentKind)) {
    return { file, reason: `Blocked: assignment ${check.assignmentKind ?? "(none)"} is read-only; only implement/fix/game-asset/video assignments may write files.` };
  }
  if (!owned.some(path => ownsPath(path, file))) {
    return { file, reason: `Blocked: ${file} is outside your owned files (${ownedText}); other workers own their files. ${advice}` };
  }
  if (!real) return undefined;
  if ("error" in real) {
    return { file, reason: `Blocked: cannot resolve ${file} (possible dangling symlink or symlink loop): ${real.error}. ${advice}` };
  }
  const realRel = relative(real.cwd, real.target);
  if (!realRel || realRel.split(sep)[0] === ".." || isAbsolute(realRel)) {
    return { file, reason: `Blocked: ${file} is outside the workspace via a symlink to ${real.target}. ${advice}` };
  }
  const realFile = normalizeOwnedPath(realRel);
  // Never canonicalize owned entries into wider authority: allowed.txt -> other.txt is unowned.
  if (!owned.some(path => ownsPath(path, realFile))) {
    return { file, reason: `Blocked: ${file} is outside your owned files (${ownedText}); path is a symlink to ${realFile}. ${advice}` };
  }
  return undefined;
}

/** Resolve a new target via its nearest existing ancestor, but never skip a broken link. */
async function realWriteTarget(target: string): Promise<string> {
  let ancestor = target;
  const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // realpath ENOENT may mean a dangling link, not a new file. lstat distinguishes them;
      // ascending also detects dangling directory links above a not-yet-existing target.
      let exists = true;
      try { await lstat(ancestor); }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        exists = false;
      }
      if (exists || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

/**
 * Execution guard: Pi awaits Promise-returning tool_call handlers, so filesystem I/O need
 * not block the event loop. Directory ast_rewrite checks only its target, not its tree.
 * Like any pre-execution check, this does not prevent a concurrent symlink swap afterward.
 */
export async function checkWriteRealPath(check: WriteCheck): Promise<BlockedWrite | undefined> {
  const lexical = checkWrite(check);
  if (lexical || !WRITE_TOOLS.has(check.toolName) || (check.toolName === "ast_rewrite" && check.input.dryRun === true)) return lexical;
  let real: RealWritePaths;
  try {
    const [cwd, target] = await Promise.all([
      realpath(check.cwd), realWriteTarget(resolve(check.cwd, check.input.path as string)),
    ]);
    real = { cwd, target };
  } catch (error) {
    real = { error: error instanceof Error ? error.message : String(error) };
  }
  return checkWrite(check, real);
}
