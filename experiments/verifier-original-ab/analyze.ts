/**
 * Analysis of the verifier original-evidence A/B (PREREGISTRATION.md §4-§6).
 *
 *   npx tsx experiments/verifier-original-ab/analyze.ts <study-dir> [--set s2] [--with2 <study2-dir>] [--labels overrides.json] [--phase main] [--out summary.json]
 *
 * Unit of analysis: the case (replicates are averaged within a case; a replicate counts only when both arms of its pair have a
 * scored run). Intervals: cluster bootstrap over scenarios (M3) or cases (M1, M2) at the preregistered level; p-values: Monte-Carlo
 * sign-flip test on case-level differences. Writes aggregates only (fixtures are synthetic; no private data).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, type Case, type Stratum } from "./cases.js";
import { CASES_2, VIOLATION_TYPES_2 } from "./cases-2.js";
import { DECISION, decide, type Interval, type Verdict } from "./protocol.js";

export interface RunRecord { caseId: string; arm: "off" | "on"; replicate: number; class: "verdict" | "no-verdict" | "infra"; correct: boolean | null; verdict: "pass" | "fail" | null; namesReason?: boolean; costUSD: number; durationMs: number; requests: number; promptChars: number; contaminated: boolean; attempts: number }

function metasBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? metasBelow(path) : entry.name === "meta.json" ? [path] : [];
  });
}

/** Every scored attempt of a phase; an infra attempt that was retried is kept for cost only. */
export function loadRuns(study: string, phase = "main"): { runs: RunRecord[]; infraAttemptCost: number; infraAttempts: number } {
  const runs: RunRecord[] = [];
  let infraAttemptCost = 0, infraAttempts = 0;
  for (const file of metasBelow(join(study, "runs", phase))) {
    const meta = JSON.parse(readFileSync(file, "utf8"));
    const retried = /-infra-1\/meta\.json$/.test(file);
    if (retried) { infraAttempts++; infraAttemptCost += meta.outcome?.costUSD ?? 0; continue; }
    if (meta.status !== "completed") continue;
    runs.push({
      caseId: meta.caseId, arm: meta.arm, replicate: meta.replicate, class: meta.class, correct: meta.correct ?? null, verdict: meta.verdict ?? null,
      namesReason: meta.namesReason, costUSD: meta.outcome?.costUSD ?? 0, durationMs: meta.outcome?.durationMs ?? 0, requests: meta.outcome?.requests ?? 0,
      promptChars: meta.prompt?.chars ?? 0, contaminated: (meta.contamination?.studyAccess?.length ?? 0) > 0, attempts: meta.attempt ?? 1,
    });
  }
  return { runs, infraAttemptCost, infraAttempts };
}

/** Seeded PRNG (mulberry32). */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
const quantile = (sorted: readonly number[], q: number) => { const at = (sorted.length - 1) * q; const low = Math.floor(at), high = Math.ceil(at); return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low); };

export interface CaseResult { id: string; scenario: string; stratum: Stratum; truth: "pass" | "fail"; evidenceGain: boolean; replicates: number; off: number; on: number; d: number }

/** Per-case mean correctness of each arm over the replicates where both arms were scored (verdict or no-verdict; not infra, not contaminated). */
export function perCase(runs: readonly RunRecord[], cases: readonly Case[] = CASES): CaseResult[] {
  const results: CaseResult[] = [];
  for (const item of cases) {
    const reps = new Map<number, { off?: RunRecord; on?: RunRecord }>();
    for (const run of runs) if (run.caseId === item.id) { const slot = reps.get(run.replicate) ?? {}; slot[run.arm] = run; reps.set(run.replicate, slot); }
    const usable = [...reps.values()].filter(pair => pair.off && pair.on && pair.off.class !== "infra" && pair.on.class !== "infra" && !pair.off.contaminated && !pair.on.contaminated);
    if (!usable.length) continue;
    const off = mean(usable.map(pair => pair.off!.correct ? 1 : 0)), on = mean(usable.map(pair => pair.on!.correct ? 1 : 0));
    results.push({ id: item.id, scenario: item.scenario, stratum: item.stratum, truth: item.truth, evidenceGain: item.evidenceGain, replicates: usable.length, off, on, d: on - off });
  }
  return results;
}

/** M1, M2, M3 as defined in protocol.ts decide(), from per-case results. */
export function metrics(results: readonly CaseResult[]) {
  const violations = results.filter(result => result.truth === "fail"), compliant = results.filter(result => result.truth === "pass");
  const gain = violations.filter(result => result.evidenceGain);
  const m1 = mean(gain.map(result => result.d));            // = OFF miss − ON miss
  const m2 = mean(compliant.map(result => -result.d));      // = ON false rejection − OFF false rejection
  const m3 = 0.5 * mean(violations.map(result => result.d)) + 0.5 * mean(compliant.map(result => result.d));
  return { m1, m2, m3 };
}

/** Percentile bootstrap intervals: M3 resamples scenarios (cluster), M1 and M2 resample their own cases. */
export function intervals(results: readonly CaseResult[], level: number = DECISION.level, draws: number = DECISION.bootstrap, seed = 1): { m1: Interval; m2: Interval; m3: Interval } {
  const random = prng(seed);
  const point = metrics(results);
  const scenarios = [...new Set(results.map(result => result.scenario))];
  const byScenario = new Map(scenarios.map(scenario => [scenario, results.filter(result => result.scenario === scenario)]));
  const gain = results.filter(result => result.truth === "fail" && result.evidenceGain), compliant = results.filter(result => result.truth === "pass");
  const sample = <T>(items: readonly T[]) => items.map(() => items[Math.floor(random() * items.length)]!);
  const m1s: number[] = [], m2s: number[] = [], m3s: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    m1s.push(mean(sample(gain).map(result => result.d)));
    m2s.push(mean(sample(compliant).map(result => -result.d)));
    const cluster = sample(scenarios).flatMap(scenario => byScenario.get(scenario)!);
    const v = cluster.filter(result => result.truth === "fail"), c = cluster.filter(result => result.truth === "pass");
    m3s.push(v.length && c.length ? 0.5 * mean(v.map(result => result.d)) + 0.5 * mean(c.map(result => result.d)) : NaN);
  }
  const tail = (1 - level) / 2;
  const interval = (value: number, draws: number[]): Interval => { const sorted = draws.filter(Number.isFinite).sort((a, b) => a - b); return { point: value, lower: quantile(sorted, tail), upper: quantile(sorted, 1 - tail) }; };
  return { m1: interval(point.m1, m1s), m2: interval(point.m2, m2s), m3: interval(point.m3, m3s) };
}

/** Two-sided Monte-Carlo sign-flip p-value of a statistic over case-level differences (null: the arms are exchangeable in each case). */
export function signFlipP(results: readonly CaseResult[], statistic: (flipped: CaseResult[]) => number, flips: number = DECISION.signFlips, seed = 2): number {
  const random = prng(seed);
  const observed = Math.abs(statistic([...results]));
  let extreme = 0;
  for (let flip = 0; flip < flips; flip++) {
    const permuted = results.map(result => random() < 0.5 ? result : { ...result, d: -result.d });
    if (Math.abs(statistic(permuted)) >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (flips + 1);
}

/** A label override of the ground-truth audit (DEVIATIONS.md D1): a corrected label, or `exclude` for a case without a defensible one. */
export interface LabelOverride { label: "pass" | "fail" | "exclude"; evidenceGain?: boolean }

/** The cases with `overrides` applied (excluded cases dropped). */
export function relabel(cases: readonly Case[], overrides: Record<string, LabelOverride> = {}): Case[] {
  return cases.flatMap(item => {
    const override = overrides[item.id];
    if (!override) return [item];
    if (override.label === "exclude") return [];
    return [{ ...item, truth: override.label, evidenceGain: override.evidenceGain ?? item.evidenceGain }];
  });
}

/** Correctness recomputed against `cases` (a no-verdict run stays incorrect; runs of dropped cases are removed). */
export function rescore(runs: readonly RunRecord[], cases: readonly Case[]): RunRecord[] {
  const truth = new Map(cases.map(item => [item.id, item.truth]));
  return runs.flatMap(run => {
    const label = truth.get(run.caseId);
    if (!label) return [];
    return [{ ...run, correct: run.class === "verdict" ? run.verdict === label : run.class === "no-verdict" ? false : null }];
  });
}

export interface Source { study: string; phase?: string; cases: readonly Case[] }

export function summarize(sources: readonly Source[], overrides: Record<string, LabelOverride> = {}) {
  const cases = sources.flatMap(source => relabel(source.cases, overrides));
  let infraAttemptCost = 0, infraAttempts = 0;
  const runs = rescore(sources.flatMap(source => { const loaded = loadRuns(source.study, source.phase ?? "main"); infraAttemptCost += loaded.infraAttemptCost; infraAttempts += loaded.infraAttempts; return loaded.runs; }), cases);
  const results = perCase(runs, cases);
  const phase = sources.map(source => `${source.study}:${source.phase ?? "main"}`).join("+");
  const ci = intervals(results);
  const verdict: Verdict = decide(ci.m1, ci.m2, ci.m3);
  const p = {
    m1: signFlipP(results.filter(result => result.truth === "fail" && result.evidenceGain), items => metrics(items).m1 || 0),
    m2: signFlipP(results.filter(result => result.truth === "pass"), items => metrics(items).m2 || 0),
    m3: signFlipP(results, items => metrics(items).m3),
  };
  const arm = (name: "off" | "on") => {
    const own = runs.filter(run => run.arm === name);
    const scored = own.filter(run => run.class !== "infra");
    const violations = scored.filter(run => cases.find(item => item.id === run.caseId)!.truth === "fail");
    const compliant = scored.filter(run => cases.find(item => item.id === run.caseId)!.truth === "pass");
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    return {
      runs: own.length, scored: scored.length, correct: scored.filter(run => run.correct).length,
      noVerdict: own.filter(run => run.class === "no-verdict").length, infra: own.filter(run => run.class === "infra").length, contaminated: own.filter(run => run.contaminated).length,
      missedViolations: violations.filter(run => run.verdict !== "fail").length, violationRuns: violations.length,
      falseRejections: compliant.filter(run => run.verdict !== "pass").length, compliantRuns: compliant.length,
      violationsCaughtNamingReason: violations.filter(run => run.verdict === "fail" && run.namesReason).length,
      costUSD: own.reduce((sum, run) => sum + run.costUSD, 0), medianCostUSD: quantile(sorted(own.map(run => run.costUSD)), 0.5),
      medianDurationS: quantile(sorted(own.map(run => run.durationMs / 1000)), 0.5), medianRequests: quantile(sorted(own.map(run => run.requests)), 0.5),
      medianPromptChars: quantile(sorted(own.map(run => run.promptChars)), 0.5),
    };
  };
  const strata = [...new Set(cases.map(item => item.stratum))].map(stratum => {
    const own = results.filter(result => result.stratum === stratum);
    const byTruth = (truth: "pass" | "fail") => { const set = own.filter(result => result.truth === truth); return set.length ? { cases: set.length, offCorrect: mean(set.map(result => result.off)), onCorrect: mean(set.map(result => result.on)), improved: set.filter(result => result.d > 0).length, worsened: set.filter(result => result.d < 0).length } : undefined; };
    return { stratum, violation: byTruth("fail"), compliant: byTruth("pass") };
  });
  // Paired run-level counts (replicate pairs where both arms were scored).
  const pairs: { better: number; worse: number; same: number } = { better: 0, worse: 0, same: 0 };
  for (const off of runs.filter(run => run.arm === "off" && run.class !== "infra" && !run.contaminated)) {
    const on = runs.find(run => run.arm === "on" && run.caseId === off.caseId && run.replicate === off.replicate && run.class !== "infra" && !run.contaminated);
    if (!on) continue;
    if (on.correct && !off.correct) pairs.better++; else if (!on.correct && off.correct) pairs.worse++; else pairs.same++;
  }
  const replicates = [...new Set(runs.map(run => run.replicate))].sort();
  // Study 2's violation types (PREREGISTRATION-2.md §4): regression against the base commit, or a choice in new code.
  const types = (["regression", "new-code"] as const).map(type => {
    const set = results.filter(result => result.truth === "fail" && VIOLATION_TYPES_2[result.scenario] === type);
    return { type, cases: set.length, offCorrect: mean(set.map(result => result.off)), onCorrect: mean(set.map(result => result.on)), improved: set.filter(result => result.d > 0).length, worsened: set.filter(result => result.d < 0).length };
  }).filter(entry => entry.cases);
  return {
    phase, overrides, replicates, cases: results.length, scenarios: new Set(results.map(result => result.scenario)).size, level: DECISION.level, margin: DECISION.margin,
    verdict, metrics: ci, signFlipP: p, arms: { off: arm("off"), on: arm("on") }, pairs, strata, violationTypes: types,
    infraRetries: { attempts: infraAttempts, costUSD: infraAttemptCost },
    totalCostUSD: runs.reduce((sum, run) => sum + run.costUSD, 0) + infraAttemptCost,
    perCase: results,
  };
}

if (process.argv[1]?.endsWith("analyze.ts")) {
  const study = process.argv[2]!;
  const flag = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  const overrides = flag("--labels") ? JSON.parse(readFileSync(flag("--labels")!, "utf8")) as Record<string, LabelOverride> : {};
  // --set s2: the positional study is study 2; --with2 <dir>: pool study 2 (study-2 cases) with the positional study 1.
  const first = { study, phase: flag("--phase") ?? "main", cases: flag("--set") === "s2" ? CASES_2 : CASES };
  const sources = flag("--with2") ? [first, { study: flag("--with2")!, cases: CASES_2 }] : [first];
  const summary = summarize(sources, overrides);
  const json = JSON.stringify(summary, null, 2);
  if (flag("--out")) writeFileSync(flag("--out")!, `${json}\n`);
  console.log(json);
}
