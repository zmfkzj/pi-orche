/**
 * Summarize a decision-memory A/B study: per-run table, per-pair differences (on - off) and aggregates per arm, from the runs'
 * meta.json. Writes <study>/summary.json and <study>/summary.md.
 *
 *   npx tsx experiments/decision-memory-ab/summarize.ts <study dir>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTranscript } from "./analyze.js";

interface Row {
  cell: string; task: string; arm: string; repeat: number; outcome: string; status?: string; success: boolean; score: number | null;
  hidden: string; visibleOk: boolean | null; lintOk: boolean | null; protectedUnchanged: boolean | null; wallS: number | null;
  requests: number; errorResponses: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  summaryInput: number; summaryOutput: number; costUsd: number; costMissing: number; compactions: number; cancelled: number;
  workLogKinds: string; workLogBytes: number; essentialsBytes: number; summaryBytes: number; transcriptBytes: number;
  unresolvedAtCut: number; unresolvedShown: number; unresolvedChecksAtCut: number; unresolvedChecksShown: number; unresolvedLaterResolved: number; citedAtCut: number; citedShown: number;
  laterCited: number; laterCitedShown: number; rereadsAfter: number; repeatedCommandsAfter: number; requestsAfterFirstCut: number;
  taskPlanCalls: number; checkpoints: number; error?: string;
  /** Per cut: each unresolved failure as kind (check/other), tool, short target and shown/hidden in the restored log. */
  unresolvedDetail: string[][];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const range = (values: number[]) => values.length ? [Math.min(...values), Math.max(...values)] : null;

export function rowOf(meta: any, cell: string): Row {
  const transcripts: any[] = meta.transcripts ?? [];
  const cuts = transcripts.flatMap(t => t.compactions ?? []);
  const pick = (key: string) => sum(cuts.map((cut: any) => cut[key] ?? 0));
  const usage = (key: string) => sum(transcripts.map(t => t.usage?.[key] ?? 0));
  const summary = (key: string) => sum(transcripts.map(t => t.summaryUsage?.[key] ?? 0));
  const events: any[] = meta.compactionEvents ?? [];
  return {
    cell, task: meta.task, arm: meta.arm, repeat: meta.repeat, outcome: meta.outcome, status: meta.assignment?.status,
    success: meta.grade?.success === true, score: meta.grade ? meta.grade.score : null, hidden: meta.grade ? `${meta.grade.hiddenPassed}/${meta.grade.hiddenTotal}` : "-",
    visibleOk: meta.grade?.visibleOk ?? null, lintOk: meta.grade?.lintOk ?? null, protectedUnchanged: meta.grade?.protectedUnchanged ?? null,
    wallS: meta.assignment?.wallMs ? Math.round(meta.assignment.wallMs / 1000) : null,
    requests: usage("requests"), errorResponses: sum(transcripts.map(t => t.errorResponses ?? 0)), input: usage("input"), output: usage("output"), cacheRead: usage("cacheRead"), cacheWrite: usage("cacheWrite"),
    summaryInput: summary("input"), summaryOutput: summary("output"), costUsd: sum(transcripts.map(t => t.costEstimate ?? 0)), costMissing: sum(transcripts.map(t => t.costMissingResponses ?? 0)),
    compactions: cuts.length, cancelled: events.filter(e => e.type === "compaction_cancelled").length,
    workLogKinds: [...new Set(cuts.map((cut: any) => cut.workLogKind))].join("+") || "-",
    workLogBytes: pick("workLogBytes"), essentialsBytes: pick("essentialsBytes"), summaryBytes: pick("summaryBytes"), transcriptBytes: sum(transcripts.map(t => t.transcriptBytes ?? 0)),
    unresolvedAtCut: pick("unresolvedAtCut"), unresolvedShown: pick("unresolvedShown"), unresolvedChecksAtCut: pick("unresolvedChecksAtCut"), unresolvedChecksShown: pick("unresolvedChecksShown"), unresolvedLaterResolved: pick("unresolvedLaterResolved"),
    citedAtCut: pick("citedAtCut"), citedShown: pick("citedShown"), laterCited: pick("laterCitedItems"), laterCitedShown: pick("laterCitedShown"),
    rereadsAfter: pick("rereadsAfter"), repeatedCommandsAfter: pick("repeatedCommandsAfter"), requestsAfterFirstCut: sum(cuts.map((cut: any) => cut.requestsAfter ?? 0)),
    unresolvedDetail: cuts.map((cut: any) => (cut.unresolvedDetail ?? []).map((d: any) => `${d.check ? "check" : "other"} ${d.tool} ${d.shown ? "SHOWN" : "hidden"}: ${String(d.target).slice(0, 70)}`)),
    taskPlanCalls: sum(transcripts.map(t => t.taskPlanCalls ?? 0)), checkpoints: sum(transcripts.map(t => t.checkpoints ?? 0)),
    ...(meta.infraError || meta.assignment?.error ? { error: String(meta.infraError ?? meta.assignment.error).split("\n")[0]!.slice(0, 200) } : {}),
  };
}

/** Paired on-off differences: mean, median, counts, exact two-sided Wilcoxon signed-rank p (n ≤ 16, zeros dropped), bootstrap 95% CI of the mean. */
export function pairedStats(values: number[]) {
  if (!values.length) return null;
  const nonzero = values.filter(value => value !== 0);
  const order = nonzero.map((value, index) => ({ value, index })).sort((a, b) => Math.abs(a.value) - Math.abs(b.value));
  const ranks = new Array<number>(nonzero.length);
  order.forEach((entry, rank) => { ranks[entry.index] = rank + 1; });
  const w = nonzero.reduce((total, value, index) => total + (value > 0 ? ranks[index]! : 0), 0);
  const center = nonzero.length * (nonzero.length + 1) / 4;
  let p: number | null = null;
  if (nonzero.length && nonzero.length <= 16) {
    let extreme = 0;
    const total = 2 ** nonzero.length;
    for (let mask = 0; mask < total; mask++) {
      let sumRanks = 0;
      for (let i = 0; i < nonzero.length; i++) if (mask & (1 << i)) sumRanks += ranks[i]!;
      if (Math.abs(sumRanks - center) >= Math.abs(w - center) - 1e-9) extreme++;
    }
    p = extreme / total;
  }
  let seed = 7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const means = Array.from({ length: 20000 }, () => values.reduce(total => total + values[Math.floor(random() * values.length)]!, 0) / values.length).sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { n: values.length, mean: round(values.reduce((a, b) => a + b, 0) / values.length), median: round(median(values)!), onLower: values.filter(v => v < 0).length, onHigher: values.filter(v => v > 0).length, wilcoxonP: p === null ? null : round(p), bootstrap95: [round(means[500]!), round(means[19499]!)] };
}

function transcriptsOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? transcriptsOf(join(dir, entry.name)) : /^W\d+-.*\.jsonl$/.test(entry.name) && dir.endsWith("workers") ? [join(dir, entry.name)] : []);
}

/** Re-run the transcript analysis of every run from its records (so analysis fixes apply to finished runs); meta.json is not changed. */
export async function summarize(study: string) {
  const rows: Row[] = [];
  const runs = join(study, "runs");
  for (const task of existsSync(runs) ? readdirSync(runs) : []) for (const arm of readdirSync(join(runs, task))) for (const rep of readdirSync(join(runs, task, arm))) {
    const file = join(runs, task, arm, rep, "meta.json");
    if (!existsSync(file)) continue;
    const meta = JSON.parse(readFileSync(file, "utf8"));
    if (meta.status !== "completed") continue;
    const transcripts = transcriptsOf(join(runs, task, arm, rep, "records"));
    if (transcripts.length) meta.transcripts = await Promise.all(transcripts.map(path => analyzeTranscript(path)));
    rows.push(rowOf(meta, `${task}/${arm}/${rep}`));
  }
  rows.sort((a, b) => a.cell < b.cell ? -1 : 1);
  const main = rows.filter(row => !/-infra-/.test(row.cell));
  const arm = (name: string) => {
    const list = main.filter(row => row.arm === name);
    const withCut = list.filter(row => row.compactions > 0);
    return {
      runs: list.length, infra: list.filter(row => row.outcome === "infra").length, success: list.filter(row => row.success).length,
      runsWithCompaction: withCut.length, successWithCompaction: withCut.filter(row => row.success).length,
      scoreMedian: median(list.flatMap(row => row.score === null ? [] : [row.score])), scoreRange: range(list.flatMap(row => row.score === null ? [] : [row.score])),
      wallSMedian: median(list.flatMap(row => row.wallS ?? [])), wallSRange: range(list.flatMap(row => row.wallS ?? [])),
      requestsMedian: median(list.map(row => row.requests)), costUsdTotal: sum(list.map(row => row.costUsd)), costUsdMedian: median(list.map(row => row.costUsd)), costUsdRange: range(list.map(row => row.costUsd)),
      compactions: sum(list.map(row => row.compactions)), cancelled: sum(list.map(row => row.cancelled)),
      workLogBytesPerCut: withCut.length ? Math.round(sum(list.map(row => row.workLogBytes)) / Math.max(1, sum(list.map(row => row.compactions)))) : null,
      essentialsBytesPerCut: withCut.length ? Math.round(sum(list.map(row => row.essentialsBytes)) / Math.max(1, sum(list.map(row => row.compactions)))) : null,
      summaryBytesPerCut: withCut.length ? Math.round(sum(list.map(row => row.summaryBytes)) / Math.max(1, sum(list.map(row => row.compactions)))) : null,
      unresolvedShown: `${sum(list.map(row => row.unresolvedShown))}/${sum(list.map(row => row.unresolvedAtCut))}`,
      unresolvedChecksShown: `${sum(list.map(row => row.unresolvedChecksShown))}/${sum(list.map(row => row.unresolvedChecksAtCut))}`,
      unresolvedLaterResolved: `${sum(list.map(row => row.unresolvedLaterResolved))}/${sum(list.map(row => row.unresolvedAtCut))}`,
      citedShown: `${sum(list.map(row => row.citedShown))}/${sum(list.map(row => row.citedAtCut))}`,
      laterCitedShown: `${sum(list.map(row => row.laterCitedShown))}/${sum(list.map(row => row.laterCited))}`,
      rereadsAfter: sum(list.map(row => row.rereadsAfter)), repeatedCommandsAfter: sum(list.map(row => row.repeatedCommandsAfter)),
    };
  };
  const pairs = [...new Set(main.map(row => `${row.task}/${row.repeat}`))].sort().map(key => {
    const [task, repeat] = key.split("/");
    const off = main.find(row => row.task === task && String(row.repeat) === repeat && row.arm === "off");
    const on = main.find(row => row.task === task && String(row.repeat) === repeat && row.arm === "on");
    const d = (pickValue: (row: Row) => number | null) => off && on && pickValue(off) !== null && pickValue(on) !== null ? +(pickValue(on)! - pickValue(off)!).toFixed(4) : null;
    return { pair: key, off: off?.outcome, on: on?.outcome, bothCompacted: !!(off?.compactions && on?.compactions), scoreDiff: d(row => row.score), wallSDiff: d(row => row.wallS), requestsDiff: d(row => row.requests), costDiff: d(row => row.costUsd), compactionsDiff: d(row => row.compactions) };
  });
  const diffs = (key: "scoreDiff" | "wallSDiff" | "requestsDiff" | "costDiff" | "compactionsDiff") => pairedStats(pairs.flatMap(pair => pair[key] === null ? [] : [pair[key]!]));
  const paired = { cost: diffs("costDiff"), wallS: diffs("wallSDiff"), requests: diffs("requestsDiff"), compactions: diffs("compactionsDiff"), score: diffs("scoreDiff") };
  const result = { study, generatedAt: new Date().toISOString(), rows, arms: { off: arm("off"), on: arm("on") }, pairs, paired };
  writeFileSync(join(study, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  const cols: Array<[string, (row: Row) => unknown]> = [
    ["run", r => r.cell], ["outcome", r => r.outcome], ["hidden", r => r.hidden], ["visible", r => r.visibleOk], ["lint", r => r.lintOk ?? "-"], ["wall s", r => r.wallS],
    ["req", r => r.requests], ["in/out/cR/cW (k)", r => [r.input, r.output, r.cacheRead, r.cacheWrite].map(n => Math.round(n / 1000)).join("/")], ["est $", r => r.costUsd.toFixed(2)],
    ["cuts", r => r.compactions], ["log", r => r.workLogKinds], ["log B", r => r.workLogBytes], ["ess B", r => r.essentialsBytes], ["sum B", r => r.summaryBytes],
    ["unres shown/at", r => `${r.unresolvedShown}/${r.unresolvedAtCut}`], ["check fails shown/at", r => `${r.unresolvedChecksShown}/${r.unresolvedChecksAtCut}`], ["unres fixed", r => r.unresolvedLaterResolved], ["cited shown", r => `${r.citedShown}/${r.citedAtCut}`],
    ["later shown", r => `${r.laterCitedShown}/${r.laterCited}`], ["re-reads", r => r.rereadsAfter], ["rep cmds", r => r.repeatedCommandsAfter], ["DAG", r => r.taskPlanCalls],
  ];
  const md = [`# ${study}`, "", `| ${cols.map(c => c[0]).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map(row => `| ${cols.map(c => String(c[1](row))).join(" | ")} |`),
    "", "## Arms", "", "```json", JSON.stringify(result.arms, null, 2), "```", "", "## Pairs (on - off)", "", "```json", JSON.stringify(pairs, null, 2), "```", "", "## Paired statistics (on - off)", "", "```json", JSON.stringify(paired, null, 2), "```",
    ...rows.filter(row => row.error).map(row => `- ${row.cell}: ${row.error}`)].join("\n");
  writeFileSync(join(study, "summary.md"), `${md}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) console.log(JSON.stringify((await summarize(process.argv[2])).arms, null, 2));
