import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Owner-only file helpers for transcripts and records: tool output in a session can contain secrets, so
 * everything orche persists is created `0700` (directories) / `0600` (files), independent of the umask
 * (a umask can only remove bits, never add them, so the modes below are the upper bound).
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create `dir` and every missing ancestor with mode 0700 (each directory created here is chmod'ed explicitly).
 * Directories that already exist are left alone, except `dir` itself when `enforce` is set.
 */
export function ensurePrivateDir(dir: string, options: { enforce?: boolean } = {}): void {
  const target = resolve(dir);
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing.reverse()) {
    try { mkdirSync(path, { mode: PRIVATE_DIR_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(path, PRIVATE_DIR_MODE);
  }
  if (options.enforce && !missing.includes(target)) chmodSync(target, PRIVATE_DIR_MODE);
}

/** Create `file` empty with mode 0600 when it does not exist (parent directories 0700); an existing file is chmod'ed to 0600, never truncated. */
export function ensurePrivateFile(file: string): void {
  const path = resolve(file);
  ensurePrivateDir(dirname(path));
  try { closeSync(openSync(path, "wx", PRIVATE_FILE_MODE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  chmodSync(path, PRIVATE_FILE_MODE);
}

/** Append to `file`, creating it with mode 0600. The parent directory must exist. */
export function appendPrivate(file: string, data: string): void {
  appendFileSync(file, data, { mode: PRIVATE_FILE_MODE });
}

/** Write `file` atomically (temporary sibling + rename) with mode 0600. The parent directory must exist. */
export function writePrivateAtomic(file: string, data: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}
