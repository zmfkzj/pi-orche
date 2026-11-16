/**
 * Synergy benchmark of inconclusive orche features (README.md, PREREGISTRATION.md): two 2×2 factorial studies run through the
 * stage-eval harness (experiments/stage-eval: real `pi` CLI, main → orche_task → worker, logging proxy, independent hidden-test grader)
 * with arms that differ only in orche.config.json overrides (stage-eval protocol `Arm.config`).
 *
 * - S1 advisor × phase: `single.advisor` (plan advisor) × `thinkingPolicy: "phase"`.
 * - S2 decision memory × evidence linkage: `workerCompaction.decisionMemory` × `thinkingPolicy.evidence: "warn"`, both under the same
 *   forced early worker compaction (otherwise decision memory never acts on these tasks).
 *
 * Pure functions only (plans, arms, factorial analysis, decision rules), unit-tested without a model (test/experiments/synergy.test.ts).
 */
import type { Arm } from "../stage-eval/protocol.js";

export const RUNTIME = "syn";
export const SEED = "synergy-2026-11-15";

/** The eight stage-eval tasks (non-ceiling, previously run in docs/stage-eval.md) and the two new adverse suite tasks. */
export const STAGE_TASKS = ["d8-build-graph", "d1-transactional-outbox", "sqlfluff__sqlfluff-7615", "scientific-python__docstub-123", "tox-dev__tox-3904", "pypa__build-1027", "youssofal__mtplx-21", "stravalib__stravalib-709_interface"] as const;
export const ADVERSE_TASKS = ["e1-retracted-cap-ko", "e2-changed-default-ko"] as const;

/** Cells of a 2×2 factorial: neither factor, the first, the second, both. */
export type Cell = "base" | "x" | "y" | "xy";
export interface Factorial { study: "S1" | "S2"; x: string; y: string; arms: Record<Cell, Arm> }

/** S1: the plan advisor (x) and the phase thinking policy (y). Every other setting is the stage-eval single arm's. */
export const S1: Factorial = {
  study: "S1", x: "single.advisor", y: "thinkingPolicy phase",
  arms: {
    base: { name: "C", kind: "single", runtime: RUNTIME, config: { single: { advisor: false } } },
    x: { name: "A", kind: "single", runtime: RUNTIME, config: { single: { advisor: true } } },
    y: { name: "P", kind: "single", runtime: RUNTIME, config: { single: { advisor: false }, thinkingPolicy: "phase" } },
    xy: { name: "AP", kind: "single", runtime: RUNTIME, config: { single: { advisor: true }, thinkingPolicy: "phase" } },
  },
};

/** The forced early worker compaction of every S2 arm (decision memory acts only at a compaction; it requires essentials extended). */
export const S2_TRIGGER_TOKENS = 48_000;
export const S2_KEEP_RECENT_TOKENS = 3_000;
const compaction = (decisionMemory: boolean) => ({ policy: "absolute", triggerTokens: S2_TRIGGER_TOKENS, keepRecentTokens: S2_KEEP_RECENT_TOKENS, essentials: "extended", decisionMemory });

/** S2: decision memory (x) and evidence linkage (y), advisor off, fixed thinking policy. */
export const S2: Factorial = {
  study: "S2", x: "workerCompaction.decisionMemory", y: "thinkingPolicy.evidence warn",
  arms: {
    base: { name: "K", kind: "single", runtime: RUNTIME, config: { single: { advisor: false }, thinkingPolicy: "fixed", workerCompaction: compaction(false) } },
    x: { name: "M", kind: "single", runtime: RUNTIME, config: { single: { advisor: false }, thinkingPolicy: "fixed", workerCompaction: compaction(true) } },
    y: { name: "L", kind: "single", runtime: RUNTIME, config: { single: { advisor: false }, thinkingPolicy: { mode: "fixed", evidence: "warn" }, workerCompaction: compaction(false) } },
    xy: { name: "ML", kind: "single", runtime: RUNTIME, config: { single: { advisor: false }, thinkingPolicy: { mode: "fixed", evidence: "warn" }, workerCompaction: compaction(true) } },
  },
};

export const CELLS: readonly Cell[] = ["base", "x", "y", "xy"];
export const armsOf = (factorial: Factorial): Arm[] => CELLS.map(cell => factorial.arms[cell]);
export const cellOfArm = (factorial: Factorial, name: string): Cell | undefined => CELLS.find(cell => factorial.arms[cell].name === name);

// ---------------------------------------------------------------------------------------------------------------------------
// Analysis (PREREGISTRATION.md §4-§5)

/**
 * One scored run. `gradePass` = terminal done AND the independent grader passed (original tests restored, hidden tests added):
 * the primary outcome (amendment A1, README §6). `primaryPass` = stage-eval's strict primary, which also fails a run with any
 * test-integrity violation (sensitivity analysis).
 */
export interface RunRow { task: string; arm: string; repeat: number; terminal: string; gradePass: boolean; primaryPass: boolean; costUsd: number; wallMs: number; infra: boolean }

/** Per task, per cell: the mean of a value over the task's scored runs (infra runs excluded; no other exclusion). */
export function cellMeans(rows: readonly RunRow[], factorial: Factorial, value: (row: RunRow) => number): Map<string, Record<Cell, number>> {
  const out = new Map<string, Record<Cell, number>>();
  const tasks = [...new Set(rows.map(row => row.task))].sort();
  for (const task of tasks) {
    const means: Partial<Record<Cell, number>> = {};
    for (const cell of CELLS) {
      const own = rows.filter(row => row.task === task && row.arm === factorial.arms[cell].name && !row.infra);
      if (!own.length) break;
      means[cell] = own.reduce((sum, row) => sum + value(row), 0) / own.length;
    }
    if (CELLS.every(cell => means[cell] !== undefined)) out.set(task, means as Record<Cell, number>);
  }
  return out;
}

export interface Contrasts { base: number; x: number; y: number; xy: number; mainX: number; mainY: number; interaction: number; xyMinusBase: number; xyMinusBestSingle: number }

/** The factorial contrasts of task-level cell means, averaged over tasks. interaction = xy − x − y + base. */
export function contrasts(means: ReadonlyMap<string, Record<Cell, number>>): Contrasts {
  const list = [...means.values()];
  const avg = (pick: (cell: Record<Cell, number>) => number) => list.length ? list.reduce((sum, cell) => sum + pick(cell), 0) / list.length : NaN;
  const base = avg(cell => cell.base), x = avg(cell => cell.x), y = avg(cell => cell.y), xy = avg(cell => cell.xy);
  return {
    base, x, y, xy,
    mainX: avg(cell => (cell.x + cell.xy - cell.base - cell.y) / 2),
    mainY: avg(cell => (cell.y + cell.xy - cell.base - cell.x) / 2),
    interaction: avg(cell => cell.xy - cell.x - cell.y + cell.base),
    xyMinusBase: xy - base,
    xyMinusBestSingle: xy - Math.max(base, x, y),
  };
}

function prng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const quantile = (sorted: readonly number[], q: number) => { const at = (sorted.length - 1) * q; const low = Math.floor(at), high = Math.ceil(at); return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low); };

export interface Interval { point: number; lower: number; upper: number }
/** Percentile bootstrap over tasks (the cluster: a task's replicates and cells move together). */
export function bootstrap(means: ReadonlyMap<string, Record<Cell, number>>, pick: (c: Contrasts) => number, level = 0.95, draws = 20_000, seed = 7): Interval {
  const entries = [...means.entries()];
  const random = prng(seed);
  const values: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    const sample = new Map(entries.map((_, index) => { const [task, cell] = entries[Math.floor(random() * entries.length)]!; return [`${task}#${index}`, cell] as const; }));
    values.push(pick(contrasts(sample)));
  }
  values.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { point: pick(contrasts(means)), lower: quantile(values, tail), upper: quantile(values, 1 - tail) };
}

/** Exact two-sided sign-flip p-value of a per-task statistic's mean (null: symmetric around 0 per task); exact up to 20 tasks. */
export function signFlipP(perTask: readonly number[]): number {
  const n = perTask.length;
  if (!n) return NaN;
  const observed = Math.abs(perTask.reduce((sum, value) => sum + value, 0));
  let extreme = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let total = 0;
    for (let index = 0; index < n; index++) total += mask & (1 << index) ? -perTask[index]! : perTask[index]!;
    if (Math.abs(total) >= observed - 1e-12) extreme++;
  }
  return extreme / (1 << n);
}

export type InteractionVerdict = "SYNERGY" | "ANTAGONISM" | "NO MATERIAL INTERACTION" | "INCONCLUSIVE";
/** Preregistered: synergy iff the 95% interval of the success interaction is above 0; no material interaction iff it lies in ±margin. */
export function interactionVerdict(interval: Interval, margin = 0.15): InteractionVerdict {
  if (interval.lower > 0) return "SYNERGY";
  if (interval.upper < 0) return "ANTAGONISM";
  if (interval.lower >= -margin && interval.upper <= margin) return "NO MATERIAL INTERACTION";
  return "INCONCLUSIVE";
}

/**
 * Preregistered practical usefulness of the combination: it beats the baseline (95% interval of xy − base above 0), is at least
 * 10 points above the best single cell at the point estimate, and costs at most 1.5× the baseline per run.
 */
export function practicallyUseful(success: { xyMinusBase: Interval; xyMinusBestSingle: number }, costRatioXyToBase: number): boolean {
  return success.xyMinusBase.lower > 0 && success.xyMinusBestSingle >= 0.10 && costRatioXyToBase <= 1.5;
}
