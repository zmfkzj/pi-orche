/**
 * Aggregation of an advisor/reviewer study directory (driver.ts output) into summary.json and summary.md.
 *
 *   npx tsx experiments/advisor-reviewer/analyze.ts --study <dir> [--regrade] [--calibration <calibration dir>]
 *
 * --regrade grades every run's workspace-final again, one run at a time on a quiet machine (LCB tests sequentially), into
 * grade-final.json; the final outcome uses that grade (the in-run grade ran next to other runs and is kept as `gradeInRun`).
 * --calibration adds each task's preliminary baseline label (stratum "calibration pass"/"calibration fail").
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ARMS, classify, type Arm, type Outcome } from "./protocol.js";

export interface RunRow {
  task: string; arm: Arm; repeat: number; outcome: Outcome; passed: boolean; gradeInRun?: boolean; tests?: string;
  wallMs: number; workerMs: number; helperMs: number; revisionMs: number;
  requests: Record<string, number>; tokens: Record<string, { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }>;
  cost: number; costByModel: Record<string, number>;
  revision: boolean; advisorMode?: string; advisorTrigger?: string; adviceLeadMs?: number; reviewerPassed?: boolean; reviewerFailed?: boolean; reviewerIssues?: number;
  infraAttempts: number; leakHits: number; providerErrors: number; workerStatus?: string; thinking: Record<string, string[]>; models: string[];
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const median = (values: number[]) => { if (!values.length) return NaN; const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const sd = (values: number[]) => { if (values.length < 2) return 0; const m = mean(values); return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1)); };

/** One run directory → row. `grade` overrides the in-run grade (regrade). */
export function rowOf(meta: any, grade?: { passed: boolean; tests?: { passed: number; total: number } }, infraAttempts = 0): RunRow {
  const finalGrade = grade ?? meta.grade;
  const outcome = classify({ grade: finalGrade, infraError: meta.infraError, workerTimedOut: meta.workerTimedOut });
  const assignments: any[] = meta.assignments ?? [];
  const span = (roles: string[]) => assignments.filter(a => roles.includes(a.role) && a.finishedAt).reduce((sum, a) => sum + (a.finishedAt - a.startedAt), 0);
  const requests: RunRow["requests"] = {}, tokens: RunRow["tokens"] = {}, costByModel: Record<string, number> = {};
  const models = new Set<string>();
  for (const [role, byModel] of Object.entries(meta.usage?.byRole ?? {}) as [string, Record<string, any>][]) {
    for (const [model, usage] of Object.entries(byModel)) {
      models.add(model);
      requests[role] = (requests[role] ?? 0) + usage.requests;
      const t = tokens[model] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      t.requests += usage.requests; t.input += usage.input; t.output += usage.output; t.cacheRead += usage.cacheRead; t.cacheWrite += usage.cacheWrite; t.reasoning += usage.reasoning;
      costByModel[model] = (costByModel[model] ?? 0) + usage.cost;
    }
  }
  const advisorAssignment = assignments.find(a => a.role === "advisor");
  return {
    task: meta.task, arm: meta.arm, repeat: meta.repeat, outcome, passed: outcome === "pass",
    ...(grade && meta.grade ? { gradeInRun: !!meta.grade.passed } : {}),
    ...(finalGrade?.tests ? { tests: typeof finalGrade.tests === "string" ? finalGrade.tests : `${finalGrade.tests.passed}/${finalGrade.tests.total}` } : {}),
    wallMs: meta.wallMs ?? 0, workerMs: span(["worker"]), helperMs: span(["advisor", "reviewer"]), revisionMs: span(["revision"]),
    requests, tokens, cost: meta.usage?.total?.cost ?? 0, costByModel,
    revision: assignments.some(a => a.role === "revision"),
    ...(meta.advisor ? { advisorMode: meta.advisor.mode, advisorTrigger: meta.advisor.trigger, ...(meta.advisor.readyAt && advisorAssignment ? { adviceLeadMs: meta.advisor.readyAt - meta.startedAt } : {}) } : {}),
    ...(meta.reviewer ? { reviewerPassed: meta.reviewer.passed, reviewerFailed: !!meta.reviewer.failed, reviewerIssues: Array.isArray(meta.reviewer.issues) ? meta.reviewer.issues.length : 0 } : {}),
    infraAttempts, leakHits: meta.leakAudit?.hits?.length ?? 0, providerErrors: meta.providerErrors ?? 0, workerStatus: meta.workerStatus,
    thinking: meta.thinkingLevels ?? {}, models: [...models].sort(),
  };
}

/** Deterministic PRNG (mulberry32) for the bootstrap. */
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Paired comparison of `arm` with baseline over tasks: per-task pass-rate difference, its mean, a task-bootstrap 95% interval, and run-pair transitions. */
export function compare(rows: readonly RunRow[], arm: Arm, tasks: readonly string[]) {
  const rate = (task: string, which: Arm) => { const runs = rows.filter(r => r.task === task && r.arm === which && r.outcome !== "infra"); return runs.length ? runs.filter(r => r.passed).length / runs.length : NaN; };
  const perTask = tasks.map(task => ({ task, baseline: rate(task, "baseline"), arm: rate(task, arm) })).filter(item => !Number.isNaN(item.baseline) && !Number.isNaN(item.arm));
  const diffs = perTask.map(item => item.arm - item.baseline);
  const random = rng(20261008);
  const boots: number[] = [];
  for (let i = 0; i < 10_000 && diffs.length; i++) { let sum = 0; for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(random() * diffs.length)]!; boots.push(sum / diffs.length); }
  boots.sort((a, b) => a - b);
  // Every baseline run of a task against every arm run of the same task (repeats are independent, so no pairing by index).
  let failToPass = 0, passToFail = 0, bothPass = 0, bothFail = 0;
  for (const task of tasks) {
    const base = rows.filter(r => r.task === task && r.arm === "baseline" && r.outcome !== "infra");
    const other = rows.filter(r => r.task === task && r.arm === arm && r.outcome !== "infra");
    for (const b of base) for (const o of other) {
      const weight = 1 / (base.length * other.length);
      if (!b.passed && o.passed) failToPass += weight; else if (b.passed && !o.passed) passToFail += weight; else if (b.passed) bothPass += weight; else bothFail += weight;
    }
  }
  return {
    arm, tasks: perTask.length, perTask, meanDiff: mean(diffs),
    ci95: boots.length ? [boots[Math.floor(0.025 * boots.length)]!, boots[Math.floor(0.975 * boots.length) - 1]!] : [NaN, NaN],
    tasksBetter: diffs.filter(d => d > 0).length, tasksWorse: diffs.filter(d => d < 0).length, tasksSame: diffs.filter(d => d === 0).length,
    /** Expected task counts over all baseline×arm run pairings of each task. */
    transitions: { failToPass, passToFail, bothPass, bothFail },
  };
}

export function armSummary(rows: readonly RunRow[], arm: Arm) {
  const mine = rows.filter(r => r.arm === arm);
  const counted = mine.filter(r => r.outcome !== "infra");
  const outcomes: Record<string, number> = {};
  for (const row of mine) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  const models: Record<string, { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number }> = {};
  for (const row of mine) for (const [model, t] of Object.entries(row.tokens)) {
    const m = models[model] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
    m.requests += t.requests; m.input += t.input; m.output += t.output; m.cacheRead += t.cacheRead; m.cacheWrite += t.cacheWrite; m.reasoning += t.reasoning; m.cost += row.costByModel[model] ?? 0;
  }
  const passes = counted.filter(r => r.passed).length;
  const totalCost = mine.reduce((s, r) => s + r.cost, 0);
  return {
    arm, runs: mine.length, counted: counted.length, passes, successRate: counted.length ? passes / counted.length : NaN, outcomes,
    wallMs: { mean: mean(mine.map(r => r.wallMs)), median: median(mine.map(r => r.wallMs)), sd: sd(mine.map(r => r.wallMs)), total: mine.reduce((s, r) => s + r.wallMs, 0) },
    workerMs: mean(mine.map(r => r.workerMs)), helperMs: mean(mine.map(r => r.helperMs)), revisionMs: mean(mine.map(r => r.revisionMs)),
    cost: { total: totalCost, mean: mean(mine.map(r => r.cost)), perPass: passes ? totalCost / passes : NaN },
    requests: { mean: mean(mine.map(r => Object.values(r.requests).reduce((a, b) => a + b, 0))) },
    models, revisions: mine.filter(r => r.revision).length,
    advisorModes: arm === "advisor" ? Object.fromEntries([...new Set(mine.map(r => r.advisorMode ?? "none"))].map(mode => [mode, mine.filter(r => (r.advisorMode ?? "none") === mode).length])) : undefined,
    reviewer: arm === "reviewer" ? { ran: mine.filter(r => r.reviewerPassed !== undefined || r.reviewerFailed).length, passedVerdicts: mine.filter(r => r.reviewerPassed === true).length, failedVerdicts: mine.filter(r => r.reviewerPassed === false).length, reviewerErrors: mine.filter(r => r.reviewerFailed).length,
      /** Verdict accuracy against the final hidden-test grade of the reviewed (pre-revision) work is not knowable after a revision; reported: verdict vs final grade. */
      verdictVsFinal: { passAndPassed: mine.filter(r => r.reviewerPassed === true && r.passed).length, passButFailed: mine.filter(r => r.reviewerPassed === true && !r.passed).length, failThenPassed: mine.filter(r => r.reviewerPassed === false && r.passed).length, failThenFailed: mine.filter(r => r.reviewerPassed === false && !r.passed).length } } : undefined,
    infraRetries: mine.reduce((s, r) => s + r.infraAttempts, 0), leakHits: mine.reduce((s, r) => s + r.leakHits, 0),
    discordantTasks: [...new Set(mine.map(r => r.task))].filter(task => { const runs = counted.filter(r => r.task === task); return runs.some(r => r.passed) && runs.some(r => !r.passed); }).length,
  };
}

const pct = (x: number) => Number.isNaN(x) ? "n/a" : `${(100 * x).toFixed(0)}%`;
const sec = (ms: number) => Number.isNaN(ms) ? "n/a" : `${(ms / 1000).toFixed(0)}s`;
const usd = (x: number) => Number.isNaN(x) ? "n/a" : `$${x.toFixed(2)}`;
const k = (x: number) => `${(x / 1000).toFixed(0)}k`;

export function markdown(summary: any): string {
  const lines: string[] = [];
  const arms: Arm[] = summary.arms;
  lines.push(`# ${summary.study}`, "", `source revision ${summary.revisions.join(", ")}; runs ${summary.rows.length}; tasks ${summary.tasks.length}`, "");
  lines.push("## 조건별 요약", "", "| 조건 | 성공 | 성공률 | pass/fail/timeout/infra | 평균 wall | 중앙 wall | wall SD | worker 평균 | helper 평균 | revision 평균 | 비용 합계 | 평균 비용 | 성공당 비용 | revision 횟수 | 반복 불일치 과제 |", "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of summary.armSummaries) lines.push(`| ${s.arm} | ${s.passes}/${s.counted} | ${pct(s.successRate)} | ${["pass", "fail", "timeout", "infra"].map(o => s.outcomes[o] ?? 0).join("/")} | ${sec(s.wallMs.mean)} | ${sec(s.wallMs.median)} | ${sec(s.wallMs.sd)} | ${sec(s.workerMs)} | ${sec(s.helperMs)} | ${sec(s.revisionMs)} | ${usd(s.cost.total)} | ${usd(s.cost.mean)} | ${usd(s.cost.perPass)} | ${s.revisions} | ${s.discordantTasks} |`);
  lines.push("", "## 모델별 토큰 (조건 합계)", "", "| 조건 | 모델 | 요청 | input | output | cache read | cache write | reasoning(보고분) | 비용(카탈로그 단가) |", "|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of summary.armSummaries) for (const [model, m] of Object.entries(s.models) as [string, any][]) lines.push(`| ${s.arm} | ${model} | ${m.requests} | ${k(m.input)} | ${k(m.output)} | ${k(m.cacheRead)} | ${k(m.cacheWrite)} | ${k(m.reasoning)} | ${usd(m.cost)} |`);
  if (summary.comparisons?.length) {
    lines.push("", "## baseline 대비 (과제 단위 paired)", "", "| 조건 | 과제 수 | 평균 성공률 차 | 95% bootstrap 구간 | 나아진/나빠진/같은 과제 | fail→pass (기대 과제 수) | pass→fail | 둘 다 pass | 둘 다 fail |", "|---|---:|---:|---|---|---:|---:|---:|---:|");
    for (const c of summary.comparisons) lines.push(`| ${c.arm} | ${c.tasks} | ${(100 * c.meanDiff).toFixed(1)}pp | [${(100 * c.ci95[0]).toFixed(1)}, ${(100 * c.ci95[1]).toFixed(1)}]pp | ${c.tasksBetter}/${c.tasksWorse}/${c.tasksSame} | ${c.transitions.failToPass.toFixed(2)} | ${c.transitions.passToFail.toFixed(2)} | ${c.transitions.bothPass.toFixed(2)} | ${c.transitions.bothFail.toFixed(2)} |`);
  }
  lines.push("", "## 과제 × 조건 (반복별 결과; P=pass F=fail T=timeout I=infra)", "", `| 과제 | 보정 라벨 | ${arms.join(" | ")} |`, `|---|---|${arms.map(() => "---").join("|")}|`);
  const letter: Record<string, string> = { pass: "P", fail: "F", timeout: "T", infra: "I" };
  for (const task of summary.tasks) {
    const cells = arms.map(arm => summary.rows.filter((r: RunRow) => r.task === task && r.arm === arm).sort((a: RunRow, b: RunRow) => a.repeat - b.repeat).map((r: RunRow) => `${letter[r.outcome]}${r.tests ? `(${r.tests})` : ""}`).join(" ") || "-");
    lines.push(`| ${task} | ${summary.calibration?.[task]?.label ?? "-"} | ${cells.join(" | ")} |`);
  }
  if (summary.strata) {
    lines.push("", "## 보정 라벨별 성공률", "", `| 보정 라벨 | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---:").join("|")}|`);
    for (const [label, byArm] of Object.entries(summary.strata) as [string, any][]) lines.push(`| ${label} | ${arms.map(arm => `${byArm[arm].passes}/${byArm[arm].counted}`).join(" | ")} |`);
  }
  lines.push("", "## 실행별", "", "| 과제 | 조건 | 반복 | 결과 | 테스트 | wall | worker | helper | revision | 요청(역할별) | 비용 | advisor 전달 | reviewer 판정 | 누출 의심 | provider 오류 |", "|---|---|---:|---|---|---:|---:|---:|---:|---|---:|---|---|---:|---:|");
  for (const r of summary.rows as RunRow[]) lines.push(`| ${r.task} | ${r.arm} | ${r.repeat} | ${r.outcome}${r.gradeInRun !== undefined && r.gradeInRun !== r.passed ? " (in-run grade differed)" : ""} | ${r.tests ?? ""} | ${sec(r.wallMs)} | ${sec(r.workerMs)} | ${sec(r.helperMs)} | ${sec(r.revisionMs)} | ${Object.entries(r.requests).map(([role, n]) => `${role} ${n}`).join(", ")} | ${usd(r.cost)} | ${r.advisorMode ? `${r.advisorMode}/${r.advisorTrigger}` : ""} | ${r.reviewerPassed === undefined ? (r.reviewerFailed ? "error" : "") : r.reviewerPassed ? "passed" : `failed (${r.reviewerIssues} issues)`} | ${r.leakHits} | ${r.providerErrors} |`);
  return `${lines.join("\n")}\n`;
}

export async function analyze(study: string, options: { regrade?: boolean; calibration?: string } = {}) {
  study = resolve(study);
  const runsDir = join(study, "runs");
  const rows: RunRow[] = [];
  const tasks: string[] = [];
  let suite: any;
  const revisions = new Set<string>();
  for (const task of readdirSync(runsDir).sort()) {
    tasks.push(task);
    for (const armDir of readdirSync(join(runsDir, task))) {
      if (!ARMS.includes(armDir as Arm)) continue;
      const entries = readdirSync(join(runsDir, task, armDir));
      for (const repeat of entries.filter(name => /^r\d+$/.test(name))) {
        const dir = join(runsDir, task, armDir, repeat);
        if (!existsSync(join(dir, "meta.json"))) continue;
        const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        if (meta.status !== "completed") continue;
        if (meta.sourceRevision) revisions.add(meta.sourceRevision);
        let grade: any;
        if (options.regrade && existsSync(join(dir, "workspace-final"))) {
          const { loadCandidate, gradeLcb, gradeSuite, gradeSwe } = await import("./tasks.js");
          const candidate = await loadCandidate(task);
          suite ??= await import(pathToFileURL(join(study, "rt/src/eval/suite.ts")).href);
          grade = candidate.kind === "lcb" ? await gradeLcb(candidate, join(dir, "workspace-final"), { parallel: 1 }) : candidate.kind === "swe" ? await gradeSwe(candidate, join(dir, "workspace-final")) : await gradeSuite(suite, candidate, join(dir, "workspace-final"));
          await writeFile(join(dir, "grade-final.json"), `${JSON.stringify(grade, null, 2)}\n`);
        } else if (existsSync(join(dir, "grade-final.json"))) grade = JSON.parse(readFileSync(join(dir, "grade-final.json"), "utf8"));
        const infraAttempts = entries.filter(name => name.startsWith(`${repeat}-infra-`)).length;
        rows.push(rowOf(meta, grade, infraAttempts));
      }
    }
  }
  const arms = ARMS.filter(arm => rows.some(r => r.arm === arm));
  let calibration: Record<string, { passes: number; runs: number; label: string }> | undefined;
  if (options.calibration) {
    const calibrationSummary = JSON.parse(readFileSync(join(resolve(options.calibration), "summary.json"), "utf8"));
    calibration = {};
    for (const task of tasks) {
      const runs = (calibrationSummary.rows as RunRow[]).filter(r => r.task === task && r.outcome !== "infra");
      const passes = runs.filter(r => r.passed).length;
      calibration[task] = { passes, runs: runs.length, label: passes === runs.length ? "calibration pass" : passes === 0 ? "calibration fail" : "calibration mixed" };
    }
  }
  const summary: any = {
    study, generatedAt: new Date().toISOString(), regraded: !!options.regrade, revisions: [...revisions], arms, tasks, rows,
    armSummaries: arms.map(arm => armSummary(rows, arm)),
    comparisons: arms.includes("baseline") ? arms.filter(arm => arm !== "baseline").map(arm => compare(rows, arm, tasks)) : [],
    ...(calibration ? { calibration } : {}),
  };
  if (calibration) {
    summary.strata = {};
    for (const label of ["calibration pass", "calibration mixed", "calibration fail"]) {
      const inLabel = tasks.filter(task => calibration![task]?.label === label);
      if (!inLabel.length) continue;
      summary.strata[label] = Object.fromEntries(arms.map(arm => { const runs = rows.filter(r => r.arm === arm && inLabel.includes(r.task) && r.outcome !== "infra"); return [arm, { passes: runs.filter(r => r.passed).length, counted: runs.length }]; }));
    }
  }
  await writeFile(join(study, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(study, "summary.md"), markdown({ ...summary, study: study.split("/").slice(-2).join("/") }));
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
  const study = value("--study");
  if (!study) throw new Error("--study <dir> is required");
  const summary = await analyze(study, { regrade: argv.includes("--regrade"), ...(value("--calibration") ? { calibration: value("--calibration")! } : {}) });
  console.log(markdown({ ...summary, study }).split("\n## 실행별")[0]);
}
