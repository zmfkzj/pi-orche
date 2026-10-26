/**
 * Model-free summary of a frozen pool's calibration (experiments/headroom-pool/README.md "Analysis"): one row per attempt (validity,
 * terminal status, witness outcome, hidden-test and regression results, integrity, wire totals), per-case screening and confirmation
 * counts, the promotion and family rules of protocol.ts, and the request/token/cost ledger (invalid attempts included; unknown usage
 * counted, never priced as zero).
 * Wording (report fidelity): the protocol's raw outcome label `solved` means only that the case's PUBLIC WITNESS (the issue's
 * reproducer and stated expectation) passed on the final workspace; the summary reports it as `witness-pass` / `witnessPassed`, never
 * as full-task correctness. Hidden F2P, visible regressions, integrity and infrastructure validity stay separate fields.
 * Counts are descriptive. Sessions of one task are repeats and the tasks were selected by eligibility rules, so no pooled interval,
 * bound or accuracy estimate is computed; the only interval is a case's own confirmation sessions (scope stated with it).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, type StudyPaths } from "./cases.js";
import { attemptsOf, calibrationState, unitDir } from "./driver.js";
import type { FrozenCalibration } from "./freeze.js";
import { clopperPearson, families, promoted, unitsOf, type CaseCalibration } from "./protocol.js";

export interface AttemptRow {
  unit: string; case: string; phase: string; slot: number; n: number; completed: boolean; valid?: boolean; invalid?: string; invalidDetail?: string;
  terminal?: string; stop?: string; outcome?: string; witness?: string; witnessReason?: string; f2p?: string; hiddenResolved?: boolean; hiddenError?: boolean;
  regressions?: number; regressionError?: boolean; testFilesChanged?: number; changedFiles?: number; requests: number; completedRequests: number;
  tokens: { input: number; cached: number; output: number; reasoning: number }; costUSD: number; unknownUsage: number; byModel?: unknown; byEffort?: unknown; wallMs?: number;
}

const json = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);

export function attemptRows(paths: StudyPaths, plan: FrozenCalibration, confirmCases: readonly string[]): AttemptRow[] {
  const rows: AttemptRow[] = [];
  for (const c of plan.cases) {
    const units = [...unitsOf(c.id, "screen"), ...(confirmCases.includes(c.id) ? unitsOf(c.id, "confirm") : [])];
    for (const unit of units) {
      for (const attempt of attemptsOf(unitDir(paths, plan.pool, unit.name))) {
        const meta = json(join(attempt.dir, "meta.json")) ?? {};
        const score = json(join(attempt.dir, "score.json"));
        const wire = meta.wire ?? json(join(attempt.dir, "wire.jsonl.totals.json")) ?? {};
        rows.push({
          unit: unit.name, case: c.id, phase: unit.phase, slot: unit.slot, n: attempt.n, completed: attempt.completed, ...(attempt.interrupted ? { invalid: "interrupted" } : {}),
          ...(meta.status === "completed" ? { valid: meta.valid === true, ...(meta.invalid ? { invalid: meta.invalid, invalidDetail: String(meta.invalidDetail ?? "").slice(0, 300) } : {}), terminal: meta.terminal, stop: meta.stop } : {}),
          ...(score ? { outcome: reportLabel(score.outcome), witness: score.witness?.status, witnessReason: score.witness?.reason, f2p: score.hidden ? `${score.hidden.f2pPassed}/${score.hidden.f2pTotal}` : undefined, hiddenResolved: score.hidden?.resolved, hiddenError: Boolean(score.hidden?.error), regressions: score.regressions?.nowNotPassing?.length, regressionError: Boolean(score.regressions?.error), testFilesChanged: score.integrity?.testFilesChanged?.length } : {}),
          changedFiles: (meta.changedFiles ?? []).length, requests: wire.forwarded ?? 0, completedRequests: wire.completed ?? 0,
          tokens: { input: wire.input ?? 0, cached: wire.cached ?? 0, output: wire.output ?? 0, reasoning: wire.reasoning ?? 0 }, costUSD: wire.costUSD ?? 0, unknownUsage: wire.unknownUsage ?? 0,
          byModel: wire.byModel, byEffort: wire.byEffort, wallMs: meta.wallMs,
        });
      }
    }
  }
  return rows;
}

export function ledgerOf(rows: readonly AttemptRow[]) {
  const sum = (pick: (row: AttemptRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const models = new Set<string>(), efforts = new Set<string>();
  for (const row of rows) { for (const key of Object.keys((row.byModel as object) ?? {})) models.add(key); for (const key of Object.keys((row.byEffort as object) ?? {})) efforts.add(key); }
  return {
    attempts: rows.length, validAttempts: rows.filter(row => row.valid).length, invalidAttempts: rows.filter(row => row.valid === false || row.invalid === "interrupted").length,
    requests: sum(row => row.requests), completedRequests: sum(row => row.completedRequests), unknownUsage: sum(row => row.unknownUsage),
    tokens: { input: sum(row => row.tokens.input), cached: sum(row => row.tokens.cached), output: sum(row => row.tokens.output), reasoning: sum(row => row.tokens.reasoning) },
    costUSD: Math.round(sum(row => row.costUSD) * 1e4) / 1e4, models: [...models], efforts: [...efforts],
  };
}

/** Report label of a protocol outcome: a witness pass or failure is named as such (the raw label stays in score.json). */
export const reportLabel = (outcome: string): string => (outcome === "solved" ? "witness-pass" : outcome === "miss" ? "witness-fail" : outcome);

/** What each reported label means (written into every summary). */
export const DEFINITIONS = {
  "witness-pass": "the case's frozen public witness (the issue's own reproducer and stated expectation) passed on the session's final workspace (raw protocol label `solved`); it is not full-task correctness: hidden F2P tests, visible regressions, integrity and infrastructure validity are reported separately",
  "witness-fail": "the public witness failed on the final workspace of a valid session (raw label `miss`); the only promotion input",
  unscored: "valid session whose witness run was untrusted or errored (neither pass nor fail)",
  missing: "slot whose attempt and single rerun were both invalid (infrastructure, capacity, off-route or refusal); never a correctness result",
  hidden: "hidden F2P tests applied offline after the session, descriptive only: a failure may reflect behaviour the issue implies or a requirement it does not state; this summary does not decide which",
  counts: "descriptive counts over the frozen calibrated tasks (each run in repeated sessions); tasks were selected by exposure, prescreen, environment and eligibility rules, so no pooled interval, bound or accuracy estimate is computed",
} as const;

/** The summary of a frozen pool; `mechanisms`: the public behaviour class of each promoted case's witness failure (family rule). */
export function summarize(paths: StudyPaths, plan: FrozenCalibration, mechanisms: Record<string, string> = {}) {
  const state = calibrationState(paths, plan);
  const rows = attemptRows(paths, plan, state.confirmCases);
  const cases = plan.cases.map(c => {
    const screen = state.screen.filter(slot => slot.case === c.id).map(slot => slot.outcome);
    const confirm = state.confirm.filter(slot => slot.case === c.id).map(slot => slot.outcome);
    const calibration: CaseCalibration = { case: c.id, repo: c.repo, screen: screen as CaseCalibration["screen"], confirm: confirm as CaseCalibration["confirm"], ...(mechanisms[c.id] ? { mechanism: mechanisms[c.id] } : {}) };
    const scored = (list: string[]) => list.filter(outcome => outcome === "miss" || outcome === "solved").length;
    const failed = (list: string[]) => list.filter(outcome => outcome === "miss").length;
    const passed = (list: string[]) => list.filter(outcome => outcome === "solved").length;
    return {
      case: c.id, repo: c.repo, order: c.order, screen: screen.map(reportLabel), confirm: confirm.map(reportLabel), promoted: promoted(calibration), mechanism: mechanisms[c.id],
      screening: { witnessFailed: failed(screen), witnessPassed: passed(screen), scored: scored(screen), note: "a witness failure here selects the case for confirmation (selection event)" },
      confirmation: { witnessFailed: failed(confirm), witnessPassed: passed(confirm), scored: scored(confirm), ci95: scored(confirm) ? clopperPearson(failed(confirm), scored(confirm)) : null, ci95Scope: "exact interval for this case's own confirmation sessions only, assuming they are independent repeats of this one task with a fixed witness-failure rate; not a bound over tasks, pools or model accuracy; null when the case had no confirmation session" },
      hidden: rows.filter(row => row.case === c.id && row.valid && row.f2p).map(row => `${row.unit}:${row.f2p}${row.hiddenResolved ? " resolved" : ""}`),
    };
  });
  const promotedCases: CaseCalibration[] = plan.cases.filter((_, index) => cases[index]!.promoted).map(c => ({ case: c.id, repo: c.repo, screen: state.screen.filter(slot => slot.case === c.id).map(slot => slot.outcome) as CaseCalibration["screen"], confirm: state.confirm.filter(slot => slot.case === c.id).map(slot => slot.outcome) as CaseCalibration["confirm"], ...(mechanisms[c.id] ? { mechanism: mechanisms[c.id] } : {}) }));
  const screenAll = state.screen.map(slot => slot.outcome), confirmAll = state.confirm.map(slot => slot.outcome);
  const count = (list: string[], value: string) => list.filter(outcome => outcome === value).length;
  return {
    pool: plan.pool, planDigest: plan.planDigest, at: new Date().toISOString(), definitions: DEFINITIONS,
    screening: { tasks: plan.cases.length, slots: screenAll.length, witnessFailed: count(screenAll, "miss"), witnessPassed: count(screenAll, "solved"), unscored: count(screenAll, "unscored"), missing: count(screenAll, "missing"), pending: count(screenAll, "pending"), note: "per-slot public-witness outcomes of the two screening sessions of every calibrated task (descriptive)" },
    confirmation: { cases: state.confirmCases.length, slots: confirmAll.length, witnessFailed: count(confirmAll, "miss"), witnessPassed: count(confirmAll, "solved"), unscored: count(confirmAll, "unscored"), missing: count(confirmAll, "missing"), pending: count(confirmAll, "pending"), note: "only tasks with a screening witness failure (selected on failure)" },
    promoted: cases.filter(c => c.promoted).map(c => c.case), families: families(promotedCases), cases, ledger: ledgerOf(rows), attempts: rows,
  };
}

export const readMechanisms = (paths: StudyPaths, pool: string): Record<string, string> => json(join(paths.out, "calibration", pool, "mechanisms.json")) ?? {};
export const readPlan = (paths: StudyPaths, pool: string): FrozenCalibration => readJsonFile<FrozenCalibration>(join(paths.out, "frozen", pool, "calibration.json"));
