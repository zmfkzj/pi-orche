/**
 * Model-free analysis of a stage-evaluation study directory (experiments/stage-eval).
 *
 *   npx tsx experiments/stage-eval/analyze.ts <study dir> [<study dir> ...] [--out summary.json] [--md summary.md] [--pairs A:B,C:D]
 *
 * Every run directory runs/<task>/<arm>/r<n> is a primary run; `<dir>.infra-<n>` / `<dir>.interrupted-<n>` attempts are not
 * outcomes but their wire cost IS counted (total cost of the arm). Cost per success = total cost of the arm (failed runs and
 * retried attempts included) / primary successes. Tokens: uncached input, cached input, output (reasoning is a part of output,
 * shown separately and never added). Costs are catalog-priced estimates, not the subscription bill.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addBucket, emptyBucket, pairedMeans, type Bucket, type Role, type Row } from "./protocol.js";

export interface RunRecord {
  study: string; task: string; arm: string; repeat: number; kept: boolean; label?: string;
  terminal: string; gradePassed: boolean; primary: boolean; violations: number; wallMs: number;
  total: Bucket; byRole: Partial<Record<Role, Bucket>>; missRequests: number; missUncached: number; unexpected: number;
  compactions: number; repeatReads: number; reads: number; artifactAccesses: number; reductions: Record<string, number>;
  orcheRereads: number; advisorStatus?: string; leaks: number; tasks: number; checks: Record<string, boolean>;
}

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };

export function loadRuns(study: string): RunRecord[] {
  const root = join(study, "runs");
  const out: RunRecord[] = [];
  if (!existsSync(root)) return out;
  for (const task of readdirSync(root)) {
    for (const arm of readdirSync(join(root, task))) {
      for (const name of readdirSync(join(root, task, arm))) {
        const dir = join(root, task, arm, name);
        if (!statSync(dir).isDirectory()) continue;
        const match = /^r(\d+)(?:\.(infra|interrupted)-\d+)?$/.exec(name);
        if (!match) continue;
        const meta = readJson(join(dir, "meta.json"));
        if (!meta) continue;
        const wire = meta.wire ?? { total: emptyBucket(), byRole: {} };
        const transcripts: any[] = meta.transcripts ?? [];
        out.push({
          study, task, arm, repeat: Number(match[1]), kept: !!match[2], label: match[2],
          terminal: meta.terminal ?? "unknown", gradePassed: meta.grade?.passed === true, primary: meta.primaryPass === true && !match[2],
          violations: meta.integrity?.violations?.length ?? 0, wallMs: meta.wallMs ?? 0,
          total: wire.total ?? emptyBucket(), byRole: wire.byRole ?? {}, missRequests: wire.missRequests ?? 0, missUncached: wire.missUncached ?? 0, unexpected: wire.unexpected?.length ?? 0,
          compactions: transcripts.reduce((sum, t) => sum + (t.stats?.compactions ?? 0), 0),
          repeatReads: transcripts.reduce((sum, t) => sum + (t.stats?.repeatReads ?? 0), 0),
          reads: transcripts.reduce((sum, t) => sum + (t.stats?.reads ?? 0), 0),
          artifactAccesses: meta.toolEvents?.artifactAccesses ?? 0, reductions: meta.toolEvents?.reductions ?? {},
          orcheRereads: (meta.tasks ?? []).reduce((sum: number, t: any) => sum + (t.rereads?.repeats ?? 0), 0),
          advisorStatus: (meta.tasks ?? []).map((t: any) => t.advisor?.status).filter(Boolean).join(",") || undefined,
          leaks: meta.leakAudit?.hits?.length ?? 0, tasks: (meta.tasks ?? []).length, checks: meta.grade?.checks ?? {},
        });
      }
    }
  }
  return out;
}

const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const median = (values: readonly number[]) => { if (!values.length) return NaN; const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export interface ArmSummary {
  arm: string; runs: number; keptAttempts: number; successes: number; gradePasses: number; terminals: Record<string, number>;
  costUsd: number; costPerSuccess: number; tokens: Bucket; tokensPerSuccess: { uncached: number; cached: number; output: number; reasoning: number };
  wallMeanS: number; wallMedianS: number; wallPerSuccessS: number; requestsPerRun: number; cacheHitRatio: number; missRequests: number; missUncachedShare: number;
  byRole: Partial<Record<Role, Bucket>>; compactions: number; repeatReads: number; reads: number; artifactAccesses: number; orcheRereads: number;
  reductions: Record<string, number>; leaks: number; unexpected: number; violations: number; passToPass: number; advisor: Record<string, number>;
}

export function summarizeArm(arm: string, runs: readonly RunRecord[]): ArmSummary {
  const primary = runs.filter(run => !run.kept);
  const tokens = emptyBucket();
  const byRole: Partial<Record<Role, Bucket>> = {};
  for (const run of runs) {
    addBucket(tokens, run.total);
    for (const [role, bucket] of Object.entries(run.byRole) as [Role, Bucket][]) addBucket(byRole[role] ??= emptyBucket(), bucket);
  }
  const successes = primary.filter(run => run.primary).length;
  const terminals: Record<string, number> = {};
  for (const run of primary) terminals[run.terminal] = (terminals[run.terminal] ?? 0) + 1;
  const reductions: Record<string, number> = {};
  for (const run of primary) for (const [key, value] of Object.entries(run.reductions)) reductions[key] = (reductions[key] ?? 0) + value;
  const advisor: Record<string, number> = {};
  for (const run of primary) if (run.advisorStatus) for (const status of run.advisorStatus.split(",")) advisor[status] = (advisor[status] ?? 0) + 1;
  const per = (value: number) => successes ? value / successes : NaN;
  const wallTotal = runs.reduce((sum, run) => sum + run.wallMs, 0) / 1000;
  return {
    arm, runs: primary.length, keptAttempts: runs.length - primary.length, successes, gradePasses: primary.filter(run => run.gradePassed).length, terminals,
    costUsd: tokens.costUsd, costPerSuccess: per(tokens.costUsd), tokens,
    tokensPerSuccess: { uncached: per(tokens.uncached), cached: per(tokens.cached), output: per(tokens.output), reasoning: per(tokens.reasoning) },
    wallMeanS: mean(primary.map(run => run.wallMs / 1000)), wallMedianS: median(primary.map(run => run.wallMs / 1000)), wallPerSuccessS: per(wallTotal),
    requestsPerRun: primary.length ? tokens.requests / primary.length : NaN,
    cacheHitRatio: tokens.cached / Math.max(1, tokens.cached + tokens.uncached),
    missRequests: runs.reduce((sum, run) => sum + run.missRequests, 0), missUncachedShare: runs.reduce((sum, run) => sum + run.missUncached, 0) / Math.max(1, tokens.uncached),
    byRole, compactions: primary.reduce((sum, run) => sum + run.compactions, 0), repeatReads: primary.reduce((sum, run) => sum + run.repeatReads, 0),
    reads: primary.reduce((sum, run) => sum + run.reads, 0), artifactAccesses: primary.reduce((sum, run) => sum + run.artifactAccesses, 0),
    orcheRereads: primary.reduce((sum, run) => sum + run.orcheRereads, 0), reductions,
    leaks: primary.reduce((sum, run) => sum + run.leaks, 0), unexpected: runs.reduce((sum, run) => sum + run.unexpected, 0), violations: primary.reduce((sum, run) => sum + (run.violations ? 1 : 0), 0), advisor,
    passToPass: primary.filter(run => run.checks.passToPass !== false).length,
  };
}

/** Per-task mean of a numeric metric for one arm (primary runs only). */
export function taskMeans(runs: readonly RunRecord[], arm: string, metric: (run: RunRecord) => number): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const run of runs) if (run.arm === arm && !run.kept) groups.set(run.task, [...(groups.get(run.task) ?? []), metric(run)]);
  return new Map([...groups].map(([task, values]) => [task, mean(values)]));
}

export interface PairSummary { x: string; y: string; success: ReturnType<typeof pairedMeans>; costUsd: ReturnType<typeof pairedMeans>; wallS: ReturnType<typeof pairedMeans>; costRatio: number; wallRatio: number }

export function comparePair(runs: readonly RunRecord[], x: string, y: string): PairSummary {
  const success = pairedMeans(taskMeans(runs, x, run => Number(run.primary)), taskMeans(runs, y, run => Number(run.primary)), { seed: `${x}-${y}-success` });
  const costX = taskMeans(runs, x, run => run.total.costUsd), costY = taskMeans(runs, y, run => run.total.costUsd);
  const wallX = taskMeans(runs, x, run => run.wallMs / 1000), wallY = taskMeans(runs, y, run => run.wallMs / 1000);
  const shared = [...costX.keys()].filter(task => costY.has(task));
  const sum = (map: Map<string, number>) => shared.reduce((total, task) => total + map.get(task)!, 0);
  return {
    x, y, success, costUsd: pairedMeans(costX, costY, { seed: `${x}-${y}-cost` }), wallS: pairedMeans(wallX, wallY, { seed: `${x}-${y}-wall` }),
    costRatio: sum(costY) / sum(costX), wallRatio: sum(wallY) / sum(wallX),
  };
}

const f = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "-";
const k = (value: number) => Number.isFinite(value) ? `${(value / 1000).toFixed(0)}k` : "-";

export function markdown(arms: ArmSummary[], pairs: PairSummary[], matrix: Map<string, Map<string, string>>): string {
  const lines: string[] = [];
  lines.push("| arm | runs | success | grade pass | terminals | cost $ | $/success | uncached/succ | cached/succ | output/succ | reasoning/succ | wall mean s | wall/succ s | req/run | cache hit | miss req | compactions | repeat reads | artifact reads | integrity viol. | p2p pass | leaks | unexpected |");
  lines.push("|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of arms) lines.push(`| ${a.arm} | ${a.runs}${a.keptAttempts ? ` (+${a.keptAttempts} kept)` : ""} | ${a.successes} | ${a.gradePasses} | ${Object.entries(a.terminals).map(([key, value]) => `${key} ${value}`).join(", ")} | ${f(a.costUsd)} | ${f(a.costPerSuccess, 3)} | ${k(a.tokensPerSuccess.uncached)} | ${k(a.tokensPerSuccess.cached)} | ${k(a.tokensPerSuccess.output)} | ${k(a.tokensPerSuccess.reasoning)} | ${f(a.wallMeanS, 0)} | ${f(a.wallPerSuccessS, 0)} | ${f(a.requestsPerRun, 1)} | ${f(a.cacheHitRatio, 3)} | ${a.missRequests} | ${a.compactions} | ${a.repeatReads} | ${a.artifactAccesses} | ${a.violations} | ${a.passToPass} | ${a.leaks} | ${a.unexpected} |`);
  lines.push("", "Cost by role ($, requests):", "");
  lines.push("| arm | main | worker | sub-worker | advisor | other |", "|---|---|---|---|---|---|");
  for (const a of arms) lines.push(`| ${a.arm} | ${(["main", "worker", "sub-worker", "advisor", "other"] as Role[]).map(role => a.byRole[role] ? `${f(a.byRole[role]!.costUsd)} (${a.byRole[role]!.requests})` : "-").join(" | ")} |`);
  if (pairs.length) {
    lines.push("", "Paired task-level comparisons (Y − X; 95% percentile bootstrap over tasks, 10,000 draws; sign test over tasks):", "");
    lines.push("| X → Y | tasks | Δ success [CI] | better/worse | sign p | Δ cost $/run [CI] | cost ratio | Δ wall s/run [CI] | wall ratio |", "|---|---:|---|---|---:|---|---:|---|---:|");
    for (const p of pairs) lines.push(`| ${p.x} → ${p.y} | ${p.success.tasks} | ${f(p.success.meanDiff * 100, 1)}pp [${f(p.success.ci95[0] * 100, 1)}, ${f(p.success.ci95[1] * 100, 1)}] | ${p.success.better}/${p.success.worse} | ${f(p.success.signTestP, 3)} | ${f(p.costUsd.meanDiff, 3)} [${f(p.costUsd.ci95[0], 3)}, ${f(p.costUsd.ci95[1], 3)}] | ${f(p.costRatio)} | ${f(p.wallS.meanDiff, 0)} [${f(p.wallS.ci95[0], 0)}, ${f(p.wallS.ci95[1], 0)}] | ${f(p.wallRatio)} |`);
  }
  const armNames = arms.map(a => a.arm);
  lines.push("", "Per task (primary success per repeat, `P` pass / `f` fail; `g` = graded pass but not primary: terminal not done or a test-integrity violation):", "");
  lines.push(`| task | ${armNames.join(" | ")} |`, `|---|${armNames.map(() => "---").join("|")}|`);
  for (const [task, row] of [...matrix].sort()) lines.push(`| ${task} | ${armNames.map(arm => row.get(arm) ?? "").join(" | ")} |`);
  return lines.join("\n");
}

export function analyze(studies: readonly string[], pairs: readonly [string, string][], keep: (run: RunRecord) => boolean = () => true): { runs: RunRecord[]; arms: ArmSummary[]; pairs: PairSummary[]; markdown: string } {
  const runs = studies.flatMap(loadRuns).filter(keep);
  const armNames = [...new Set(runs.map(run => run.arm))].sort();
  const arms = armNames.map(arm => summarizeArm(arm, runs.filter(run => run.arm === arm)));
  const comparisons = pairs.filter(([x, y]) => armNames.includes(x) && armNames.includes(y)).map(([x, y]) => comparePair(runs, x, y));
  const matrix = new Map<string, Map<string, string>>();
  for (const run of [...runs].filter(run => !run.kept).sort((a, b) => a.repeat - b.repeat)) {
    const row = matrix.get(run.task) ?? new Map<string, string>();
    row.set(run.arm, `${row.get(run.arm) ?? ""}${run.primary ? "P" : run.gradePassed ? "g" : "f"}`);
    matrix.set(run.task, row);
  }
  return { runs, arms, pairs: comparisons, markdown: markdown(arms, comparisons, matrix) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const out = option("--out"), md = option("--md");
  const pairs = (option("--pairs") ?? "A:B,A:C,A:D,C:D,B:C").split(",").map(pair => pair.split(":") as [string, string]);
  const exclude = new Set((option("--exclude-tasks") ?? "").split(",").filter(Boolean));
  const only = new Set((option("--tasks") ?? "").split(",").filter(Boolean));
  const result = analyze(args, pairs, run => !exclude.has(run.task) && (!only.size || only.has(run.task)));
  if (out) await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), studies: args, arms: result.arms, pairs: result.pairs, runs: result.runs }, null, 2)}\n`);
  if (md) await writeFile(md, `${result.markdown}\n`);
  console.log(result.markdown);
}
