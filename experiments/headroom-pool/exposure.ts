/**
 * Exposure inventory of the headroom-pool study (model-free): which pool records any earlier study of this repository already showed
 * to a model. The scan reads the ignored `results/` tree directly (directory names to a fixed depth, plus the iso-token run plans that
 * list the tasks actually run) and the fixture sets. Evidence is classified:
 *   modelRuns: a results path (completed, aborted, screening or calibration unit, record, report) that names the record or an alias
 *     of its upstream issue (`<repo>-<number>` with word boundaries, so `pytest-dev__pyfakefs-1286` ≡ `jmcgeheeiv__pyfakefs-1286`);
 *   setupOnly: environment caches, pool builds/listings and prepared-but-unrun task folders (NOT exposure);
 *   historicalFixtureSet: fixtures/advisor-bench/swe (the historical pool used across the earlier studies: always excluded).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NAMED_EXPOSED, upstreamKey, type ExposureFacts } from "./protocol.js";

/** Result roots that hold setup or pool-listing material only (no model session). */
export const SETUP_ONLY_ROOTS = ["results/advisor-reviewer/cache", "results/swe-pool", "results/iso-token/tasks", "results/iso-token/raw", "results/iso-token/repos", "results/iso-token/gold", "results/headroom-pool"] as const;
/** Directory names never descended into (dependency trees, copied workspaces, VCS data). */
const SKIP_DIRS = new Set(["node_modules", "site-packages", ".venv", "venv", ".git", "workspace-final", "__pycache__", "src", "rt", "provider"]);
export const SCAN_DEPTH = 9;

export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Alias patterns of a record: its full slug and `<repo>-<number>` of its upstream issue, bounded by non-alphanumerics. */
export function aliasPatterns(id: string): RegExp[] {
  const base = id.replace(/_interface$/, "");
  const key = upstreamKey(id);
  const [repo, number] = key.split("#");
  const out = [new RegExp(`(^|-)${slug(base)}(-|$)`)];
  if (repo && number) out.push(new RegExp(`(^|-)${slug(repo)}-${number}(-|$)`));
  return out;
}

/** Every directory path under `root` up to `depth`, skipping SKIP_DIRS (relative to `repo`). */
export function scanDirs(repo: string, root: string, depth = SCAN_DEPTH): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      out.push(relative(repo, path));
      if (level < depth) walk(path, level + 1);
    }
  };
  walk(join(repo, root), 1);
  return out;
}

/** Tasks actually run by the iso-token study (its run plans: domains[].tasks). */
export function isoTokenRunTasks(repo: string): { plan: string; task: string }[] {
  const dir = join(repo, "results/iso-token/runs");
  if (!existsSync(dir)) return [];
  const out: { plan: string; task: string }[] = [];
  for (const name of readdirSync(dir).filter(file => file.endsWith(".plan.json"))) {
    try {
      const plan = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const domain of plan.domains ?? []) for (const task of domain.tasks ?? []) out.push({ plan: `results/iso-token/runs/${name}`, task: String(task) });
    } catch { /* unreadable plan: ignored, listed by the caller */ }
  }
  return out;
}

export interface ExposureScan { dirs: string[]; isoRuns: { plan: string; task: string }[]; historical: Set<string>; r2Fixtures: Set<string> }

export function collect(repo: string): ExposureScan {
  const dirs = scanDirs(repo, "results");
  const list = (path: string) => new Set(existsSync(join(repo, path)) ? readdirSync(join(repo, path)).filter(name => statSync(join(repo, path, name)).isDirectory()) : []);
  return { dirs, isoRuns: isoTokenRunTasks(repo), historical: list("fixtures/advisor-bench/swe"), r2Fixtures: list("fixtures/advisor-bench/swe-r2") };
}

const isSetupOnly = (path: string): boolean => SETUP_ONLY_ROOTS.some(root => path === root || path.startsWith(`${root}/`));
/** The study directory of a results path (its first two components), for a readable evidence list. */
const studyOf = (path: string): string => path.split("/").slice(0, 3).join("/");

/** Exposure facts of one record from a scan (pure over the scan). `exposedKeys`: upstream keys already found exposed (aliases). */
export function factsOf(id: string, scan: ExposureScan, exposedKeys: ReadonlyMap<string, string> = new Map()): ExposureFacts {
  const patterns = aliasPatterns(id);
  const matches = (path: string) => { const s = slug(path); return patterns.some(pattern => pattern.test(s)); };
  const hits = scan.dirs.filter(matches);
  const modelRuns = [...new Set([...hits.filter(path => !isSetupOnly(path)).map(studyOf), ...scan.isoRuns.filter(run => matches(run.task)).map(run => run.plan)])].sort();
  const setupOnly = [...new Set([...hits.filter(isSetupOnly).map(studyOf), ...([...scan.r2Fixtures].some(name => matches(name)) ? ["fixtures/advisor-bench/swe-r2"] : [])])].sort();
  const historicalFixtureSet = [...scan.historical].some(name => matches(name));
  const key = upstreamKey(id);
  const duplicate = exposedKeys.get(key);
  return { modelRuns, historicalFixtureSet, setupOnly, named: (NAMED_EXPOSED as readonly string[]).includes(key), ...(duplicate && duplicate !== id ? { duplicateOf: duplicate } : {}) };
}
