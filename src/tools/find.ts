import { execFile, spawn } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import { basename, join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import { createFindToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SKIPPED_DIRS, walkFiles } from "./walk.js";

const DOT_SEGMENT = /(^|\/)\./g;
const execFileAsync = promisify(execFile);

// path.matchesGlob never lets `*` or `**` match dot-prefixed segments; fd --hidden (Pi's default) does.
const undot = (value: string) => value.replace(DOT_SEGMENT, "$1\u0001");

/** Returns false outside a Git work tree (or when Git is unavailable). */
async function walkGitFiles(root: string, visit: (path: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, signal });
    if (stdout.trim() !== "true") return false;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { code?: number }).code === 128) return false;
    throw error;
  }
  signal?.throwIfAborted();
  const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  let pending = "";
  let stderr = "";
  let stopped = false;
  let spawnError: Error | undefined;
  const abort = () => { child.kill(); };
  const closed = new Promise<number | null>(resolve => {
    child.on("error", error => { spawnError = error; });
    child.on("close", resolve);
  });
  signal?.addEventListener("abort", abort, { once: true });
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  if (signal?.aborted) abort();
  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\0")) !== -1) {
        const path = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!(await visit(path))) {
          stopped = true;
          child.kill();
          break;
        }
      }
      if (stopped) break;
    }
    const code = await closed;
    signal?.throwIfAborted();
    if (spawnError) throw spawnError;
    if (code !== 0 && !stopped) throw new Error(stderr.trim() || `git ls-files exited with code ${code}`);
  } finally {
    child.kill();
    signal?.removeEventListener("abort", abort);
  }
  return true;
}

/**
 * Pi's `find` without `fd`, which Pi would otherwise download at first use.
 * Git supplies ignore-aware candidates in work trees; elsewhere use the directory walker.
 * Patterns without `/` match basenames.
 */
export function createFindTool(cwd: string): ToolDefinition {
  // FindOperations has no signal parameter, so keep the cancellation signal local to each execution.
  const definition = (signal?: AbortSignal) => createFindToolDefinition(cwd, {
    operations: {
      exists: (path) => access(path).then(() => true, () => false),
      async glob(pattern, root, { limit }) {
        const fullPath = pattern.includes("/");
        const matcher = undot(fullPath ? pattern.replace(/^\.\//, "") : pattern);
        const found: string[] = [];
        const seen = new Set<string>();
        const walked = new Set<string>();
        let stopped = false;
        const visit = (path: string, name: string) => {
          signal?.throwIfAborted();
          if (!path.split("/").slice(0, -1).some(part => SKIPPED_DIRS.includes(part)) &&
              !seen.has(path) && matchesGlob(undot(fullPath ? path : name), matcher)) {
            seen.add(path);
            found.push(path);
          }
          stopped = found.length >= limit;
          return !stopped;
        };
        const walk = async (base: string, prefix = ""): Promise<void> => {
          if (walked.has(base) || stopped) return;
          walked.add(base);
          if (!(await walkGitFiles(base, async entry => {
            signal?.throwIfAborted();
            entry = entry.replace(/\/$/, "");
            const path = prefix ? `${prefix}/${entry}` : entry;
            if (path.split("/").slice(0, -1).some(part => SKIPPED_DIRS.includes(part))) return !stopped;
            // The index may list deleted files or nested repositories as directory entries.
            const info = await lstat(join(base, entry)).catch(() => undefined);
            if (info?.isDirectory()) {
              if (!SKIPPED_DIRS.includes(basename(path))) await walk(join(base, entry), path);
            } else if (info) {
              return visit(path, basename(path));
            }
            return !stopped;
          }, signal))) {
            await walkFiles(base, (path, name) => visit(prefix ? `${prefix}/${path}` : path, name));
          }
        };
        await walk(root);
        return found;
      },
    },
  }) as ToolDefinition;
  return {
    ...definition(),
    execute(id, params, signal, onUpdate, ctx) {
      return definition(signal).execute(id, params, signal, onUpdate, ctx);
    },
  };
}
