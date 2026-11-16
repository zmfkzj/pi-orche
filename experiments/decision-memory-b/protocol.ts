/**
 * Protocol of the combination-B re-evaluation (README.md, PREREGISTRATION.md): decision memory × evidence linkage, a complete 2×2 at
 * worker level. Fixed before any scored run: model, window, compaction, limits, arms, schedule, budget, statistics and verdict rules.
 */
/**
 * Worker models (PREREGISTRATION.md §8): "opus" = the user's default worker route (pilots 1-3); "haiku" = a smaller model of the same
 * family through the same provider, the scored study's worker (on Opus the pilots were at the ceiling and cost about $5.4 per run).
 */
export const MODELS = {
  opus: { provider: "cliproxyapi", id: "claude-opus-5-5", thinking: "high" },
  haiku: { provider: "cliproxyapi", id: "claude-haiku-5-5", thinking: "high" },
} as const;
export type ModelKey = keyof typeof MODELS;
/** The default (pilot 1-3) model. */
export const MODEL = MODELS.opus;
/** The window the private provider config declares (as in experiments/decision-memory-ab): only the fallback of a refused early compaction depends on it. */
export const WINDOW_TOKENS = 128_000;
/** orche's `absolute` worker policy in every arm: compaction at 28k tokens, the last 3k kept (decision-memory-ab: several cuts per task). */
export const TRIGGER_TOKENS = 28_000;
export const KEEP_RECENT_TOKENS = 3_000;

export const LIMITS = {
  assignmentMs: 30 * 60_000,
  harnessMs: 35 * 60_000,
  assignmentRequests: 150,
} as const;

/** Admission budgets (estimated USD at catalog prices, from Pi's usage.cost of every worker request and summary). */
export const BUDGET = { pilot: 30, scored: 190 } as const;

export type Arm = "K" | "M" | "L" | "ML";
export const ARMS: readonly Arm[] = ["K", "M", "L", "ML"];
export const FACTORS: Record<Arm, { decisionMemory: boolean; linkage: boolean }> = {
  K: { decisionMemory: false, linkage: false },
  M: { decisionMemory: true, linkage: false },
  L: { decisionMemory: false, linkage: true },
  ML: { decisionMemory: true, linkage: true },
};

/** orche.config.json of an arm: identical except `workerCompaction.decisionMemory` and `thinkingPolicy.evidence`. */
export function ARM_CONFIG(arm: Arm, modelKey: ModelKey = "opus") {
  const { decisionMemory, linkage } = FACTORS[arm];
  const MODEL = MODELS[modelKey];
  return {
    mainMode: "single",
    default: { model: `${MODEL.provider}/${MODEL.id}`, thinking: MODEL.thinking },
    routes: {},
    limits: { overallMs: LIMITS.assignmentMs, assignmentMs: LIMITS.assignmentMs, maxExtensions: 0, assignmentRequests: LIMITS.assignmentRequests },
    single: { ledger: false, spawn: false, advisor: false },
    thinkingPolicy: linkage ? { mode: "fixed", evidence: "warn" } : "fixed",
    concurrentSessions: { enabled: false },
    workerCompaction: { policy: "absolute", triggerTokens: TRIGGER_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS, essentials: "extended", decisionMemory },
  };
}

export interface Cell { seed: number; arm: Arm; block: number; order: number }
export const cellId = (cell: Pick<Cell, "seed" | "arm">) => `p${cell.seed}/${cell.arm}`;

/** One block per instance (in the given order); inside a block the arms (default all four) in a seeded random order. */
export function schedule(seeds: readonly number[], seed: number, armSet: readonly Arm[] = ARMS): Cell[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const cells: Cell[] = [];
  seeds.forEach((instanceSeed, block) => {
    const arms = armSet.slice();
    for (let i = arms.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arms[i], arms[j]] = [arms[j]!, arms[i]!]; }
    for (const arm of arms) cells.push({ seed: instanceSeed, arm, block, order: cells.length + 1 });
  });
  return cells;
}

export const RETRY_RULE = "infra only (no successful model response, or a harness error before grading), once; the failed attempt is kept as <cell>-infra-1";

// ---------------------------------------------------------------------------------------------------------------------------------
// Statistics.

export interface Cells { base: number; x: number; y: number; xy: number }
export interface Interval { point: number; lower: number; upper: number }

/** Per-instance cell values (mean of the runs in each cell); instances without all four cells are left out. */
export function cellMeans<R extends { seed: number; arm: Arm }>(rows: readonly R[], value: (row: R) => number): Map<number, Cells> {
  const out = new Map<number, Cells>();
  const seeds = [...new Set(rows.map(row => row.seed))].sort((a, b) => a - b);
  for (const seed of seeds) {
    const mean = (arm: Arm) => { const own = rows.filter(row => row.seed === seed && row.arm === arm).map(value); return own.length ? own.reduce((a, b) => a + b, 0) / own.length : NaN; };
    const cells = { base: mean("K"), x: mean("M"), y: mean("L"), xy: mean("ML") };
    if (Object.values(cells).every(Number.isFinite)) out.set(seed, cells);
  }
  return out;
}

const avg = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
export type Contrast = (c: Cells) => number;
export const CONTRASTS = {
  interaction: (c: Cells) => c.xy - c.x - c.y + c.base,
  mainMemory: (c: Cells) => (c.x + c.xy - c.base - c.y) / 2,
  mainLinkage: (c: Cells) => (c.y + c.xy - c.base - c.x) / 2,
  mlMinusK: (c: Cells) => c.xy - c.base,
  mlMinusM: (c: Cells) => c.xy - c.x,
  mlMinusL: (c: Cells) => c.xy - c.y,
  mMinusK: (c: Cells) => c.x - c.base,
  lMinusK: (c: Cells) => c.y - c.base,
} satisfies Record<string, Contrast>;

export function means(cells: Map<number, Cells>): Cells {
  const list = [...cells.values()];
  return { base: avg(list.map(c => c.base)), x: avg(list.map(c => c.x)), y: avg(list.map(c => c.y)), xy: avg(list.map(c => c.xy)) };
}

/** Percentile bootstrap over instances (seeded, 20,000 draws by default). */
export function bootstrap(cells: Map<number, Cells>, contrast: Contrast, draws = 20_000, seed = 7): Interval {
  const values = [...cells.values()].map(contrast);
  if (!values.length) return { point: NaN, lower: NaN, upper: NaN };
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const stats: number[] = [];
  for (let d = 0; d < draws; d++) { let sum = 0; for (let i = 0; i < values.length; i++) sum += values[Math.floor(next() * values.length)]!; stats.push(sum / values.length); }
  stats.sort((a, b) => a - b);
  return { point: avg(values), lower: stats[Math.floor(0.025 * draws)]!, upper: stats[Math.ceil(0.975 * draws) - 1]! };
}

/** Two-sided sign-flip p-value of the mean: exact up to 20 instances, otherwise 200,000 seeded random flips. */
export function signFlipP(values: readonly number[], seed = 11): number {
  const n = values.length;
  if (!n) return NaN;
  const observed = Math.abs(avg(values)) - 1e-12;
  if (n <= 20) {
    let extreme = 0;
    for (let mask = 0; mask < 2 ** n; mask++) { let sum = 0; for (let i = 0; i < n; i++) sum += mask & (1 << i) ? -values[i]! : values[i]!; if (Math.abs(sum / n) >= observed) extreme++; }
    return extreme / 2 ** n;
  }
  let state = seed >>> 0, extreme = 0;
  const draws = 200_000;
  for (let d = 0; d < draws; d++) { let sum = 0; for (let i = 0; i < n; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; sum += state & 0x80000000 ? -values[i]! : values[i]!; } if (Math.abs(sum / n) >= observed) extreme++; }
  return (extreme + 1) / (draws + 1);
}

/** Instances whose four cells are not all equal (the only ones that carry information about any contrast). */
export const informative = (cells: Map<number, Cells>) => [...cells.values()].filter(c => !(c.base === c.x && c.x === c.y && c.y === c.xy)).length;

export const MARGIN = 0.10;
export const MIN_INFORMATIVE = 8;
export type InteractionVerdict = "SYNERGY" | "ANTAGONISM" | "NO MATERIAL INTERACTION" | "INCONCLUSIVE" | "INCONCLUSIVE (insufficient information)";

/**
 * Preregistered verdict on the interaction interval (requirement score, 0-1). An equivalence claim needs at least MIN_INFORMATIVE
 * informative instances and a non-degenerate interval; with fewer, or with an interval of width 0, only INCONCLUSIVE
 * (insufficient information) is reported, whatever the point estimate.
 */
export function interactionVerdict(interval: Interval, informativeCount: number): InteractionVerdict {
  if (!Number.isFinite(interval.lower)) return "INCONCLUSIVE (insufficient information)";
  if (interval.lower > 0) return "SYNERGY";
  if (interval.upper < 0) return "ANTAGONISM";
  if (informativeCount < MIN_INFORMATIVE || interval.upper - interval.lower < 1e-9) return "INCONCLUSIVE (insufficient information)";
  if (interval.lower >= -MARGIN && interval.upper <= MARGIN) return "NO MATERIAL INTERACTION";
  return "INCONCLUSIVE";
}

/**
 * Practically useful combination: ML above K (95% interval above 0), at least 0.05 above the better single feature (point), at most
 * 1.2× K's cost per run, and no more harm than K (false-success runs and stale items, point estimates).
 */
export function practicallyUseful(input: { mlMinusK: Interval; mlMinusBestSingle: number; costRatio: number; harmDelta: { falseSuccessRuns: number; staleItems: number } }): boolean {
  return input.mlMinusK.lower > 0 && input.mlMinusBestSingle >= 0.05 && input.costRatio <= 1.2 && input.harmDelta.falseSuccessRuns <= 0 && input.harmDelta.staleItems <= 0;
}
