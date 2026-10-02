/**
 * Detection of other pi sessions that are active on the same git repository (or on its superproject /
 * a submodule of it), so an orche run can say that changes it did not make may come from them.
 *
 * Source of truth is pi's own session store: `<sessions>/<encoded-cwd>/<timestamp>_<id>.jsonl`, whose first line is
 * `{"type":"session","id":...,"cwd":...}`. The directory name encoding is lossy, so the header's `cwd` is read.
 * Cost model: stat every file (capped, newest-named first), read the first line only of files whose mtime is inside
 * the window, compare paths, and spawn git only for the run's own cwd and the few remaining candidates that path
 * prefixes could not place. Nothing here throws or blocks for long: any failure means "no concurrent sessions".
 */
import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_WINDOW_MS = 10 * 60_000;
export const DEFAULT_MAX_FILES = 2000;
/** Wall-clock bound of one whole detection; on expiry the result is empty. */
export const DEFAULT_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 3000;
/** Candidates that path prefixes could not place and that are still resolved through git (aliased paths). */
const MAX_GIT_CANDIDATES = 4;
/** Superproject chain depth (submodule of a submodule of …). */
const MAX_ROOT_CHAIN = 6;
const MAX_DIRS = 5000;
const MAX_HEADER_READS = 256;
const HEADER_BYTES = 16 * 1024;
const STAT_BATCH = 64;

export interface ConcurrentSession {
  id?: string;
  /** The session's working directory exactly as recorded in its header. */
  cwd: string;
  file: string;
  lastWriteMs: number;
}

export interface DetectConcurrentSessionsOptions {
  /** The run's working directory. */
  cwd: string;
  /**
   * Session store root(s): directories holding `<encoded-cwd>/*.jsonl` (a flat `*.jsonl` directory is read too, which is what
   * a custom `--session-dir` produces). Default: `PI_CODING_AGENT_SESSION_DIR` when set, and `<agent dir>/sessions`
   * (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
   */
  sessionsDir?: string | readonly string[];
  /** The calling session's own file: never reported. */
  currentSessionFile?: string;
  /** The calling session's id: never reported (covers a session file reached through another path). */
  currentSessionId?: string;
  /** A session is active when its file was written within this many milliseconds. Default 10 minutes. */
  windowMs?: number;
  /** Maximum number of session files stat-ed; the newest-named files are inspected first. Default 2000. */
  maxFiles?: number;
  /** Epoch milliseconds treated as the present. Default `Date.now()`. */
  now?: number;
  /** Bound of the whole detection. Default 5 s. */
  timeoutMs?: number;
}

export interface ConcurrentSessionsResult {
  sessions: ConcurrentSession[];
}

/** The `concurrentActivity` shape that `RunOptions` takes. */
export interface ConcurrentActivitySummary {
  count: number;
  detail: string;
}

/** `SessionManager.getSessionDir()` is `<sessions>/--encoded-cwd--` by default (scan its parent); a custom session directory is flat (scan it). */
export function sessionsRootOf(sessionDir: string): string {
  const name = basename(sessionDir);
  return name.length > 4 && name.startsWith("--") && name.endsWith("--") ? dirname(sessionDir) : sessionDir;
}

/** Where pi stores sessions when nothing says otherwise for this process. */
export function defaultSessionsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  const override = env.PI_CODING_AGENT_SESSION_DIR;
  if (override) dirs.push(expandHome(override));
  try { dirs.push(join(getAgentDir(), "sessions")); }
  catch { /* the SDK could not resolve its agent directory: scan what is known */ }
  return [...new Set(dirs)];
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/") && process.env.HOME) return join(process.env.HOME, path.slice(2));
  return path;
}

export async function detectConcurrentSessions(options: DetectConcurrentSessionsOptions): Promise<ConcurrentSessionsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("concurrent session detection timed out")), { once: true });
    });
    return { sessions: await Promise.race([detect(options, controller.signal), expired]) };
  } catch {
    return { sessions: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function detect(options: DetectConcurrentSessionsOptions, signal: AbortSignal): Promise<ConcurrentSession[]> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  if (!(windowMs > 0) || maxFiles === 0 || !options.cwd) return [];
  const roots = typeof options.sessionsDir === "string" ? [options.sessionsDir] : options.sessionsDir ? [...options.sessionsDir] : defaultSessionsDirs();

  // 1. stat only, newest-named files first, bounded.
  const names = await collectSessionFiles(roots);
  names.sort((a, b) => (basename(a) < basename(b) ? 1 : basename(a) > basename(b) ? -1 : 0));
  const fresh: { file: string; lastWriteMs: number }[] = [];
  const inspected = names.slice(0, maxFiles);
  for (let index = 0; index < inspected.length; index += STAT_BATCH) {
    const batch = await Promise.all(inspected.slice(index, index + STAT_BATCH).map(async file => {
      try {
        const info = await stat(file);
        return info.isFile() && now - info.mtimeMs <= windowMs ? { file, lastWriteMs: info.mtimeMs } : undefined;
      } catch { return undefined; }
    }));
    for (const item of batch) if (item) fresh.push(item);
  }
  if (!fresh.length) return [];
  fresh.sort((a, b) => b.lastWriteMs - a.lastWriteMs);

  // 2. first line of the few fresh files; the current session is never reported.
  const current = await sameFileMatcher(options.currentSessionFile);
  const headers: ConcurrentSession[] = [];
  for (const { file, lastWriteMs } of fresh.slice(0, MAX_HEADER_READS)) {
    if (signal.aborted) return [];
    const header = await readSessionHeader(file);
    if (!header) continue;
    if (options.currentSessionId && header.id === options.currentSessionId) continue;
    if (await current(file)) continue;
    headers.push({ ...(header.id !== undefined ? { id: header.id } : {}), cwd: header.cwd, file, lastWriteMs });
  }
  if (!headers.length) return [];

  // 3. relation to the run's repository. Git is only needed from here on.
  const related = await relatedRoots(resolve(options.cwd), signal);
  if (!related.length) return [];
  const matched: ConcurrentSession[] = [];
  const unplaced: ConcurrentSession[] = [];
  for (const session of headers) (isInsideAny(related, resolve(session.cwd)) ? matched : unplaced).push(session);
  // Aliased paths (symlinks): resolve the physical path, and only then ask git about what is still unplaced.
  const aliased = await Promise.all(unplaced.slice(0, MAX_GIT_CANDIDATES).map(async session => {
    const real = await realpath(resolve(session.cwd)).catch(() => undefined);
    if (!real) return undefined;
    if (isInsideAny(related, real)) return session;
    const info = await gitInfo(real, signal);
    return info && (isInsideAny(related, info.toplevel) || (info.superproject !== undefined && isInsideAny(related, info.superproject))) ? session : undefined;
  }));
  for (const session of aliased) if (session) matched.push(session);
  return matched.sort((a, b) => b.lastWriteMs - a.lastWriteMs);
}

async function collectSessionFiles(roots: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  const dirs: string[] = [];
  for (const root of new Set(roots)) {
    let entries: Dirent[];
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(join(root, entry.name));
      else if (entry.isDirectory() && dirs.length < MAX_DIRS) dirs.push(join(root, entry.name));
    }
  }
  for (let index = 0; index < dirs.length; index += STAT_BATCH) {
    const lists = await Promise.all(dirs.slice(index, index + STAT_BATCH).map(async dir => {
      try { return (await readdir(dir)).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name)); }
      catch { return []; }
    }));
    for (const list of lists) for (const file of list) files.add(file);
  }
  return [...files];
}

/** True for the same file reached through another path (symlinked sessions directory). */
async function sameFileMatcher(currentFile: string | undefined): Promise<(file: string) => Promise<boolean>> {
  if (!currentFile) return async () => false;
  const direct = resolve(currentFile);
  const real = await realpath(direct).catch(() => undefined);
  return async file => {
    if (resolve(file) === direct) return true;
    if (!real) return false;
    return (await realpath(file).catch(() => undefined)) === real;
  };
}

async function readSessionHeader(file: string): Promise<{ id?: string; cwd: string } | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === HEADER_BYTES) return undefined;
    const value: unknown = JSON.parse(newline < 0 ? text : text.slice(0, newline));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const header = value as Record<string, unknown>;
    if (header.type !== "session" || typeof header.cwd !== "string" || !header.cwd.trim()) return undefined;
    return { ...(typeof header.id === "string" ? { id: header.id } : {}), cwd: header.cwd };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The run's toplevel followed by its superproject chain: the roots whose working trees a concurrent session may touch. */
async function relatedRoots(cwd: string, signal: AbortSignal): Promise<string[]> {
  const chain: string[] = [];
  let dir = cwd;
  for (let depth = 0; depth < MAX_ROOT_CHAIN; depth++) {
    const info = await gitInfo(dir, signal);
    if (!info || chain.includes(info.toplevel)) break;
    chain.push(info.toplevel);
    if (!info.superproject) break;
    dir = info.superproject;
  }
  return chain;
}

interface GitInfo { toplevel: string; superproject?: string }

async function gitInfo(dir: string, signal: AbortSignal): Promise<GitInfo | undefined> {
  const out = await runGit(dir, ["rev-parse", "--show-toplevel", "--show-superproject-working-tree"], signal);
  if (out === undefined) return undefined;
  const [toplevel, superproject] = out.split("\n").map(line => line.replace(/\r$/, "")).filter(line => line.length > 0);
  if (!toplevel) return undefined;
  return { toplevel: resolve(toplevel), ...(superproject ? { superproject: resolve(superproject) } : {}) };
}

const INHERITED_GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];

function runGit(dir: string, args: string[], signal: AbortSignal): Promise<string | undefined> {
  return new Promise(settle => {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
      for (const name of INHERITED_GIT_VARIABLES) delete env[name];
      execFile("git", ["-C", dir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true, signal, env },
        (error, stdout) => settle(error ? undefined : stdout));
    } catch {
      settle(undefined);
    }
  });
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function isInsideAny(roots: readonly string[], path: string): boolean {
  return roots.some(root => isInside(root, path));
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/** One-line warning for the tool result and progress; empty when there is nothing to warn about. */
export function formatConcurrentWarning(sessions: readonly ConcurrentSession[], now: number = Date.now()): string {
  if (!sessions.length) return "";
  const cwds = [...new Set(sessions.map(session => session.cwd))];
  const shown = cwds.slice(0, 3).join(", ") + (cwds.length > 3 ? `, +${cwds.length - 3} more` : "");
  const newest = Math.max(...sessions.map(session => session.lastWriteMs));
  const noun = sessions.length === 1 ? "session" : "sessions";
  return `⚠ ${sessions.length} other pi ${noun} active in this repository (cwd ${shown}, last write ${formatAge(now - newest)} ago); their changes are classified as external where possible`;
}

/** `RunOptions.concurrentActivity` for a non-empty detection result: the count plus a short description of the sessions. */
export function concurrentActivityOf(sessions: readonly ConcurrentSession[], now: number = Date.now()): ConcurrentActivitySummary {
  const shown = sessions.slice(0, 5).map(session => `${session.cwd} (last write ${formatAge(now - session.lastWriteMs)} ago)`);
  if (sessions.length > shown.length) shown.push(`+${sessions.length - shown.length} more`);
  return { count: sessions.length, detail: `other pi sessions: ${shown.join("; ")}` };
}
