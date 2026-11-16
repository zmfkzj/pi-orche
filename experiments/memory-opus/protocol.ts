/**
 * Protocol and statistics of the Opus decision-memory study (README.md, PREREGISTRATION.md): decision memory OFF (K) vs ON (M), both
 * with evidence linkage off, run through experiments/decision-memory-b (same generator, grader, feed, runtime path), paired per instance.
 */
export const MARGIN = -0.10;
export const MIN_RELATIVE_SAVING = 0.10;
export const Z = 1.959963984540054;
export const STAGE1_SEEDS = Array.from({ length: 24 }, (_, index) => 201 + index);
export const STAGE2_SEEDS = Array.from({ length: 16 }, (_, index) => 225 + index);
export const PILOT_SEEDS = [299];
/** Inspected Opus K/M pairs from experiments/decision-memory-b (secondary study): reported apart, never pooled. */
export const REUSED_SEEDS = [1, 2, 3, 4, 5, 6];

export interface Interval { point: number; lower: number; upper: number }

/** Wilson score interval of a proportion x/n. */
export function wilson(x: number, n: number, z = Z): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = x / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Paired 2×2 of task success: a = both succeed, b = ON only, c = OFF only, d = neither. */
export interface PairCounts { a: number; b: number; c: number; d: number }

export function pairCounts(pairs: readonly { on: boolean; off: boolean }[]): PairCounts {
  const counts = { a: 0, b: 0, c: 0, d: 0 };
  for (const pair of pairs) {
    if (pair.on && pair.off) counts.a++;
    else if (pair.on) counts.b++;
    else if (pair.off) counts.c++;
    else counts.d++;
  }
  return counts;
}

/**
 * Newcombe's hybrid score interval (method 10, Stat Med 1998;17:2635) for the difference of paired proportions
 * p_ON − p_OFF, with the continuity-free φ and its correction (φ* = max(ad − bc − n/2, 0)/√(efgh) when ad > bc).
 */
export function newcombePaired({ a, b, c, d }: PairCounts, z = Z): Interval {
  const n = a + b + c + d;
  if (!n) return { point: NaN, lower: NaN, upper: NaN };
  const p1 = (a + b) / n, p2 = (a + c) / n, theta = p1 - p2;
  const w1 = wilson(a + b, n, z), w2 = wilson(a + c, n, z);
  const e = a + b, f = c + d, g = a + c, h = b + d;
  const denom = Math.sqrt(e * f * g * h);
  let phi = 0;
  if (denom > 0) phi = a * d > b * c ? Math.max(a * d - b * c - n / 2, 0) / denom : (a * d - b * c) / denom;
  const dl1 = p1 - w1.lower, du1 = w1.upper - p1, dl2 = p2 - w2.lower, du2 = w2.upper - p2;
  const lower = theta - Math.sqrt(Math.max(0, dl1 * dl1 - 2 * phi * dl1 * du2 + du2 * du2));
  const upper = theta + Math.sqrt(Math.max(0, du1 * du1 - 2 * phi * du1 * dl2 + dl2 * dl2));
  return { point: theta, lower: Math.max(-1, lower), upper: Math.min(1, upper) };
}

export type QualityVerdict = "NON-INFERIOR" | "NON-INFERIORITY NOT ESTABLISHED" | "INFERIOR";
/** Quality co-primary: ON is non-inferior when the 95% lower bound of p_ON − p_OFF exceeds MARGIN; inferior when the upper bound is below 0. */
export function qualityVerdict(interval: Interval, margin = MARGIN): QualityVerdict {
  if (interval.upper < 0) return "INFERIOR";
  return interval.lower > margin ? "NON-INFERIOR" : "NON-INFERIORITY NOT ESTABLISHED";
}

/**
 * Futility at the interim (after stage 1): even if every remaining pair succeeds in both arms (concordant), the final lower bound
 * stays at or below MARGIN, so non-inferiority is unreachable and stage 2 is not run.
 */
export function futile(counts: PairCounts, remaining: number, margin = MARGIN): boolean {
  return newcombePaired({ ...counts, a: counts.a + remaining }).lower <= margin;
}

const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** Percentile bootstrap over pairs of a statistic of the resampled pairs (seeded). */
export function bootstrapPairs<T>(pairs: readonly T[], statistic: (sample: readonly T[]) => number, draws = 20_000, seed = 7): Interval {
  if (!pairs.length) return { point: NaN, lower: NaN, upper: NaN };
  const next = lcg(seed);
  const stats: number[] = [];
  for (let d = 0; d < draws; d++) {
    const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(next() * pairs.length)]!);
    const value = statistic(sample);
    if (Number.isFinite(value)) stats.push(value);
  }
  stats.sort((x, y) => x - y);
  return { point: statistic(pairs), lower: stats[Math.floor(0.025 * stats.length)]!, upper: stats[Math.ceil(0.975 * stats.length) - 1]! };
}

/** Two-sided sign-flip p-value of a mean difference: exact up to 20 pairs, else 200,000 seeded flips. */
export function signFlipP(values: readonly number[], seed = 11): number {
  const n = values.length;
  if (!n) return NaN;
  const observed = Math.abs(mean(values)) - 1e-12;
  if (n <= 20) {
    let extreme = 0;
    for (let mask = 0; mask < 2 ** n; mask++) { let total = 0; for (let i = 0; i < n; i++) total += mask & (1 << i) ? -values[i]! : values[i]!; if (Math.abs(total / n) >= observed) extreme++; }
    return extreme / 2 ** n;
  }
  const next = lcg(seed);
  let extreme = 0;
  const draws = 200_000;
  for (let d = 0; d < draws; d++) { let total = 0; for (let i = 0; i < n; i++) total += next() < 0.5 ? -values[i]! : values[i]!; if (Math.abs(total / n) >= observed) extreme++; }
  return (extreme + 1) / (draws + 1);
}

export interface Pair { seed: number; on: { success: boolean; score: number; costUsd: number; wallS: number }; off: { success: boolean; score: number; costUsd: number; wallS: number } }

export interface CostResult {
  perRunDiff: Interval & { p: number };
  relativeSaving: Interval;
  bothSuccessDiff: Interval & { pairs: number; p: number };
  costPerSuccess: { on: number; off: number; ratio: Interval };
}

export function costAnalysis(pairs: readonly Pair[]): CostResult {
  const diffs = pairs.map(pair => pair.on.costUsd - pair.off.costUsd);
  const both = pairs.filter(pair => pair.on.success && pair.off.success);
  const perSuccess = (sample: readonly Pair[], arm: "on" | "off") => { const wins = sample.filter(pair => pair[arm].success).length; return wins ? sample.reduce((total, pair) => total + pair[arm].costUsd, 0) / wins : NaN; };
  return {
    perRunDiff: { ...bootstrapPairs(pairs, sample => mean(sample.map(pair => pair.on.costUsd - pair.off.costUsd))), p: signFlipP(diffs) },
    relativeSaving: bootstrapPairs(pairs, sample => 1 - mean(sample.map(pair => pair.on.costUsd)) / mean(sample.map(pair => pair.off.costUsd))),
    bothSuccessDiff: { ...bootstrapPairs(both, sample => mean(sample.map(pair => pair.on.costUsd - pair.off.costUsd))), pairs: both.length, p: signFlipP(both.map(pair => pair.on.costUsd - pair.off.costUsd)) },
    costPerSuccess: { on: perSuccess(pairs, "on"), off: perSuccess(pairs, "off"), ratio: bootstrapPairs(pairs, sample => perSuccess(sample, "on") / perSuccess(sample, "off")) },
  };
}

/** Cost co-primary: per-run saving with the 95% upper bound below 0, a point saving of at least MIN_RELATIVE_SAVING, and the
 * comparable-outcome (both arms succeed) difference also below 0 at the 95% upper bound (savings from failures do not count). */
export function costMet(cost: CostResult): boolean {
  return cost.perRunDiff.upper < 0 && cost.relativeSaving.point >= MIN_RELATIVE_SAVING && cost.bothSuccessDiff.upper < 0;
}

export function overallVerdict(quality: QualityVerdict, cost: boolean): string {
  if (quality === "NON-INFERIOR" && cost) return "COST REDUCTION WITH NON-INFERIOR QUALITY";
  if (quality === "INFERIOR") return cost ? "CHEAPER BUT INFERIOR QUALITY" : "INFERIOR QUALITY, NO COST CLAIM";
  if (quality === "NON-INFERIOR") return "NON-INFERIOR QUALITY, COST CRITERION NOT MET";
  return cost ? "COST REDUCED; QUALITY NON-INFERIORITY NOT ESTABLISHED" : "NEITHER CRITERION MET";
}
