import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizeOwnedPath, type TaskItem } from "../backlog.js";
import { checkWriteRealPath, coveringTasks as scopedTasks, WRITE_TOOLS, type BlockedWrite, type WriteCheck } from "../ownership.js";

const ownsRoot = (task: TaskItem) => task.files.some(file => normalizeOwnedPath(file) === "/");
function inWorkspace(file: string): boolean {
  const path = file.replaceAll("\\", "/");
  const normalized = normalizeOwnedPath(path);
  return Boolean(normalized && normalized !== "/" && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && normalized.split("/")[0] !== "..");
}

/** Run-only root sentinel: audits still delegate ordinary file/directory ownership unchanged. */
export function coveringTasks(tasks: readonly TaskItem[], file: string): readonly TaskItem[] {
  return tasks.filter(task => ownsRoot(task) ? inWorkspace(file) : scopedTasks([task], file).length > 0);
}

/** Expand root authority without bypassing lexical, read-only, real-path or symlink checks. */
export async function checkRootWrite(check: WriteCheck): Promise<BlockedWrite | undefined> {
  const raw = check.input.path;
  if (!WRITE_TOOLS.has(check.toolName) || !check.tasks.some(ownsRoot) || typeof raw !== "string" ||
      (check.toolName === "ast_rewrite" && check.input.dryRun === true)) return checkWriteRealPath(check);
  const target = relative(check.cwd, resolve(check.cwd, raw));
  let entries: string[];
  try { entries = await readdir(check.cwd); }
  catch { return { file: raw, reason: "Blocked: cannot read workspace ownership scopes" }; }
  if (inWorkspace(target)) entries.push(normalizeOwnedPath(target).split("/")[0]!);
  const scopes = [...new Set(entries)].flatMap(name => [name, `${name}/`]);
  // A native root branch in ownership.ts ownsPath would be cleaner long-term; that file
  // is owned by another session. Concrete scopes preserve its existing safety checks.
  return checkWriteRealPath({ ...check, tasks: check.tasks.map(task => ownsRoot(task)
    ? { ...task, files: [...task.files.filter(file => normalizeOwnedPath(file) !== "/"), ...scopes] }
    : task) });
}
