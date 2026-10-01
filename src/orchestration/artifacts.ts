import { normalizeOwnedPath } from "./backlog.js";

export interface AuditSettings { readonly artifacts?: readonly string[] }

/** Explicit generated-check/build directories, matched as whole segments at any depth. */
const ARTIFACT_DIRS: ReadonlySet<string> = new Set([
  "coverage", ".nyc_output", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache",
  ".cache", "node_modules", "dist", "build", "out", "target", ".turbo", ".next", ".vite", "__snapshots__",
]);
/** Basenames: .eslintcache, .DS_Store, *.tsbuildinfo/log/pyc/orig/rej/tmp/swp/lcov,
 * junit*.xml, coverage*.json, report.json and *-report.*. Everything else (including .txt)
 * is source; .env* and .npmrc remain config, not generated output. */
const ARTIFACT_FILE = /^(?:\.eslintcache|\.DS_Store|.*\.(?:tsbuildinfo|log|pyc|orig|rej|tmp|swp|lcov)|junit.*\.xml|coverage.*\.json|report\.json|.*-report\.[^/]+)$/;

export const CREATED_FILE_ADVICE = "Own the path in the backlog, or list it under audit.artifacts if it is generated output.";

/** Supported extra gitignore-style subset: relative concrete paths, dir/, dir/**, *.ext.
 * Paths/directories are cwd-relative; extension globs match basenames at any depth.
 * No negation, traversal, absolute paths or other wildcard syntax is accepted. */
export function isArtifactPattern(value: unknown): value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) return false;
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || /^[!#]/.test(path) || path.split("/").includes("..")) return false;
  if (/^\*\.[^/*?\[\]{}]+$/.test(path)) return true;
  const concrete = path.replace(/\/\*\*$/, "/");
  return !!normalizeOwnedPath(concrete).replace(/\/$/, "") && !/[*?\[\]{}]/.test(concrete);
}

function matchesExtra(path: string, pattern: string): boolean {
  if (!isArtifactPattern(pattern)) return false;
  const normalized = normalizeOwnedPath(pattern.replaceAll("\\", "/").replace(/\/\*\*$/, "/"));
  if (normalized.startsWith("*.")) return path.split("/").at(-1)!.endsWith(normalized.slice(1));
  return normalized.endsWith("/") ? path.startsWith(normalized) : path === normalized;
}

/** Pure policy for newly added workspace files, not permission to modify existing artifacts. */
export function classifyNewFile(path: string, extra: readonly string[] = []): "artifact" | "source" {
  const normalized = normalizeOwnedPath(path);
  const parts = normalized.split("/");
  if (extra.some(pattern => matchesExtra(normalized, pattern)) || parts.slice(0, -1).some(part => ARTIFACT_DIRS.has(part))) return "artifact";
  const name = parts.at(-1)!;
  if (name.startsWith(".env") || name === ".npmrc") return "source";
  return ARTIFACT_FILE.test(name) ? "artifact" : "source";
}
