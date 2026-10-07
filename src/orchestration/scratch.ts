import { chmod, lstat, mkdir, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Private per-worker scratch directories `<base>/<session>/<worker>` for temporary files, outside every workspace.
 * Every component orche creates (base, session, worker) must be a real directory (not a symlink) owned by the current
 * user and is kept at mode 0700, so another local user cannot pre-create or redirect it (e.g. in a shared /tmp).
 */
export const DEFAULT_SCRATCH_BASE = join(tmpdir(), "pi-orche");

/** One path component from an id: only [A-Za-z0-9._-], never empty, `.` or `..`, at most 100 characters. */
export function sanitizeScratchId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return !safe || /^\.+$/.test(safe) ? `_${safe}` : safe;
}

/** Create (or reuse) one directory with mode 0700, refusing a symlink, a non-directory or a directory owned by someone else. */
async function privateDir(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Scratch directory component ${path} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`Scratch directory component ${path} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Scratch directory component ${path} is not owned by the current user`);
  if ((stat.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

/**
 * Create `<base>/<session>/<worker>` (each 0700; ids sanitized to [A-Za-z0-9._-]) and return its real path.
 * Rejects when an existing component is a symlink, not a directory, or not owned by the current user.
 * Parents of `base` are created when missing but not checked: `base` defaults to `<os.tmpdir()>/pi-orche`.
 */
export async function ensureScratchDir(options: { base?: string; session: string; worker: string }): Promise<string> {
  const base = resolve(options.base ?? DEFAULT_SCRATCH_BASE);
  await mkdir(dirname(base), { recursive: true });
  const session = join(base, sanitizeScratchId(options.session));
  const worker = join(session, sanitizeScratchId(options.worker));
  for (const path of [base, session, worker]) await privateDir(path);
  return realpath(worker);
}

/** Whether `path` lies strictly inside `dir` (never `dir` itself). */
function strictlyInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

/**
 * Remove a scratch directory recursively, only when it is strictly inside `base` (default `<os.tmpdir()>/pi-orche`) both
 * lexically and by real path; never `base` itself or anything outside. Best effort: never throws.
 */
export async function removeScratchDir(dir: string, base: string = DEFAULT_SCRATCH_BASE): Promise<void> {
  try {
    const lexicalBase = resolve(base), lexicalDir = resolve(dir);
    let realBase: string;
    try { realBase = await realpath(lexicalBase); } catch { return; }
    if (!strictlyInside(lexicalBase, lexicalDir) && !strictlyInside(realBase, lexicalDir)) return;
    let realDir: string;
    try { realDir = await realpath(lexicalDir); } catch { return; }
    if (!strictlyInside(realBase, realDir)) return;
    await rm(realDir, { recursive: true, force: true });
    // The session directory goes too once its last worker's directory is gone (rmdir fails on a non-empty directory).
    const parent = dirname(realDir);
    if (strictlyInside(realBase, parent)) await rmdir(parent).catch(() => undefined);
  } catch {
    // Best effort: a scratch directory that cannot be removed is left for the OS temp cleanup.
  }
}
