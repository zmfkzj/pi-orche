import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeOwnedPath, type TaskItem } from "./backlog.js";

/** Tools that write files through an explicit `path` argument; guarded before they run. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_rewrite", "generate_image"]);
/** Assignment kinds that may write at all, and then only to the worker's owned files. */
export const WRITING_KINDS: ReadonlySet<string> = new Set(["implement", "fix", "game-asset", "video"]);

const WRITE_BLOCK_ADVICE = 'If the task really needs it, stop and report_result with data.status "blocked" and the reason.';

/**
 * A directory outside the workspace a worker may write in. `scratch` is a private temporary directory and is writable for every
 * assignment kind (it is never the workspace); `root` is an extra root the user explicitly asked to change (orche.config.json
 * `writeRoots` or a re-assignment) and is writable only by {@link WRITING_KINDS}. Owned-file checks apply only to workspace paths.
 */
export interface WriteRoot {
  /** Absolute path. */
  readonly path: string;
  readonly kind: "scratch" | "root";
}

/** Whether `path` lies strictly inside `dir` or is `dir` itself (both absolute; lexical, no prefix tricks). */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !rel || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/** Whether `kind` may write into `root`: scratch always, an extra root only for writing assignments. */
export function rootAllowed(root: WriteRoot, assignmentKind: string | undefined): boolean {
  return root.kind === "scratch" || (assignmentKind !== undefined && WRITING_KINDS.has(assignmentKind));
}

/** The allowed alternatives for a write outside the workspace (shared by the file-tool guard and the bash check). */
export function outsideWorkspaceAdvice(target: string, roots: readonly WriteRoot[]): string {
  const scratch = roots.find(root => root.kind === "scratch");
  return `${scratch ? `Use your scratch directory ${scratch.path} for temporary files. ` : ""}If the user explicitly asked to change ${target}, stop and report_result with data.status "blocked" so main can re-assign the task with writeRoots including it.`;
}

/**
 * One short sentence for the worker prompt describing the scratch directory and the extra write roots; "" without roots.
 * With `assignmentKind` given, extra roots a read-only kind may not write are left out.
 */
export function formatWriteRoots(roots: readonly WriteRoot[], assignmentKind?: string): string {
  const scratch = roots.filter(root => root.kind === "scratch").map(root => root.path);
  const extra = roots.filter(root => root.kind === "root" && (assignmentKind === undefined || rootAllowed(root, assignmentKind))).map(root => root.path);
  const scratchText = scratch.length ? `Use your scratch directory ${scratch.join(", ")} for temporary files (not /tmp or the repository)` : "";
  const extraText = extra.length ? `${scratchText ? "; extra" : "Extra"} write roots outside the workspace: ${extra.join(", ")}` : "";
  return scratchText || extraText ? `${scratchText}${extraText}.` : "";
}

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
  /** Directories outside the workspace that may be written too (see {@link WriteRoot}). */
  readonly extraRoots?: readonly WriteRoot[];
}
export interface BlockedWrite {
  /** Workspace-relative target, or the raw argument when it resolves outside the workspace. */
  readonly file: string;
  readonly reason: string;
}

/**
 * Optional filesystem evidence keeps the classifier itself pure and synchronous. For a target outside the workspace,
 * `roots[i]` is the real path of `extraRoots[i]` (undefined when it is missing, unresolvable or itself a symlink) and
 * `altTarget` the real path of the raw, unnormalized argument when it differs (`..` after a symlink).
 */
export type RealWritePaths =
  | { readonly cwd: string; readonly target: string; readonly altTarget?: string; readonly roots?: readonly (string | undefined)[] }
  | { readonly error: string };

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
  const advice = WRITE_BLOCK_ADVICE;
  if (typeof raw !== "string" || !raw.trim()) {
    return { file: "(workspace)", reason: `Blocked: ${check.toolName} needs an explicit path inside your owned files (${ownedText}). ${advice}` };
  }
  const absolute = resolve(check.cwd, raw);
  const rel = relative(check.cwd, absolute);
  if (rel && (rel.split(sep)[0] === ".." || isAbsolute(rel))) return checkOutside(check, raw, absolute, real);
  if (!rel) {
    return { file: raw, reason: `Blocked: ${raw} is outside the workspace. ${advice}` };
  }
  const file = normalizeOwnedPath(rel);
  if (!check.assignmentKind || !WRITING_KINDS.has(check.assignmentKind)) {
    return { file, reason: `Blocked: assignment ${check.assignmentKind ?? "(none)"} is read-only; only implement/fix/game-asset/video assignments may write files.` };
  }
  if (!owned.some(path => ownsPath(path, file))) {
    return { file, reason: `Blocked: ${file} is outside your owned files (${ownedText}); other workers own their files. ${advice}` };
  }
  if (coveringTasks(check.tasks, file).some(task => task.owner && task.owner !== check.agentId)) {
    return { file, reason: `Blocked: ${file} is owned by another worker. ${advice}` };
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
  if (coveringTasks(check.tasks, realFile).some(task => task.owner && task.owner !== check.agentId)) {
    return { file, reason: `Blocked: ${file} is a symlink to ${realFile}, owned by another worker. ${advice}` };
  }
  return undefined;
}

/**
 * A target outside the workspace: allowed only inside an extra write root whose kind the assignment may write, lexically AND
 * (with `real`) by real path. The real target must stay inside the real path of a matching root (a symlink inside a root that
 * points elsewhere, or a root that is itself a symlink, is blocked) and must not lead back into the workspace, whose
 * ownership rules a detour through a root must not bypass.
 */
function checkOutside(check: WriteCheck, raw: string, absolute: string, real: RealWritePaths | undefined): BlockedWrite | undefined {
  const roots = check.extraRoots ?? [];
  const outside = `${raw} is outside the workspace`;
  const advice = outsideWorkspaceAdvice(absolute, roots);
  const matching = roots.map((root, index) => ({ root, index })).filter(({ root }) => isAbsolute(root.path) && within(resolve(root.path), absolute));
  if (!matching.length) return { file: raw, reason: `Blocked: ${outside}. ${advice}` };
  const allowed = matching.filter(({ root }) => rootAllowed(root, check.assignmentKind));
  if (!allowed.length) {
    return { file: raw, reason: `Blocked: ${raw} is in the extra write root ${matching[0]!.root.path}, but assignment ${check.assignmentKind ?? "(none)"} is read-only; only implement/fix/game-asset/video assignments may write there. ${advice}` };
  }
  if (!real) return undefined;
  if ("error" in real) {
    return { file: raw, reason: `Blocked: cannot resolve ${raw} (possible dangling symlink or symlink loop): ${real.error}. ${advice}` };
  }
  const realRoots = allowed.map(({ index }) => real.roots?.[index]).filter((path): path is string => path !== undefined);
  if (!realRoots.length) {
    return { file: raw, reason: `Blocked: write root ${allowed[0]!.root.path} cannot be used (missing, unresolvable or itself a symlink). ${advice}` };
  }
  for (const target of real.altTarget !== undefined ? [real.target, real.altTarget] : [real.target]) {
    if (within(real.cwd, target)) {
      return { file: raw, reason: `Blocked: ${raw} resolves into the workspace via a symlink to ${target}; write workspace files through their workspace path. ${WRITE_BLOCK_ADVICE}` };
    }
    if (!realRoots.some(root => within(root, target))) {
      return { file: raw, reason: `Blocked: ${outside} and leaves its write root via a symlink to ${target}. ${advice}` };
    }
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
 * not block the event loop. Directory ast_rewrite checks only the target here; its pure
 * per-file guard checks ownership at write time, skipping and reporting blocked files.
 */
export async function checkWriteRealPath(check: WriteCheck): Promise<BlockedWrite | undefined> {
  const lexical = checkWrite(check);
  if (lexical || !WRITE_TOOLS.has(check.toolName) || (check.toolName === "ast_rewrite" && check.input.dryRun === true)) return lexical;
  const raw = check.input.path as string;
  const absolute = resolve(check.cwd, raw);
  const rel = relative(check.cwd, absolute);
  const outside = rel.split(sep)[0] === ".." || isAbsolute(rel);
  let real: RealWritePaths;
  try {
    const [cwd, target] = await Promise.all([realpath(check.cwd), realWriteTarget(absolute)]);
    if (!outside) real = { cwd, target };
    else {
      // The kernel applies `..` after following symlinks, path.resolve before: check both readings of the argument.
      const unnormalized = isAbsolute(raw) ? raw : `${check.cwd}${sep}${raw}`;
      const altTarget = unnormalized === absolute ? target : await realWriteTarget(unnormalized);
      const roots = await Promise.all((check.extraRoots ?? []).map(root => realRoot(root.path)));
      real = { cwd, target, ...(altTarget !== target ? { altTarget } : {}), roots };
    }
  } catch (error) {
    real = { error: error instanceof Error ? error.message : String(error) };
  }
  return checkWrite(check, real);
}

/** Real path of an existing write root; undefined when it is missing, not absolute, not a directory or itself a symlink. */
async function realRoot(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    return await realpath(path);
  } catch {
    return undefined;
  }
}
