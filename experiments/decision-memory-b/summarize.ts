/**
 * Study summary of the combination-B re-evaluation (PREREGISTRATION.md §4-§6).
 *
 *   npx tsx experiments/decision-memory-b/summarize.ts <study dir> [--out summary.json]
 *
 * Rows: every completed run that is not infra (infra attempts are listed separately with their cost). Unit of analysis: the instance
 * (one run per arm per instance); contrasts over instances with a percentile bootstrap and a sign-flip p-value.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_REQ, E2E_REQ, TEMPLATES, instance } from "./project.js";
import { ARMS, CONTRASTS, bootstrap, cellMeans, informative, interactionVerdict, means, practicallyUseful, signFlipP, type Arm, type Cells } from "./protocol.js";

export interface Row {
  seed: number; arm: Arm; score: number; success: boolean; itemsCorrect: number; itemsTotal: number; checks: boolean; e2eHonest: boolean;
  falseSuccess: boolean; falseMetE2e: boolean; staleItems: number; reported: boolean; reportStatus?: string; assignmentStatus?: string;
  costUsd: number; summaryCostUsd: number; wallS: number; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  compactions: number; workLogKinds: string[]; linkedResults: number; citedCheckpoints: number;
  exposedDecisions: boolean; exposedE2e: boolean;
  governingKept: number; governingTotal: number; withdrawnOnly: number; e2eKept: number; e2eInWorkLog: number; e2eCuts: number; decisionsRereads: number;
  feedFetches: number; emptyRefetches: number; notesWritten: number; transcriptLookups: number;
  itemFailures: Record<"changed" | "retracted" | "rejected", number>;
  unresolvedAtCut: number; unresolvedShown: number; checksAtCut: number; checksShown: number; laterCitedItems: number; laterCitedShown: number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function rowOf(meta: any): Row {
  const transcripts: any[] = meta.transcripts ?? [];
  const evidence: any[] = meta.evidence ?? [];
  const cuts = transcripts.flatMap(t => t.compactions ?? []);
  const eCuts = evidence.flatMap(e => e.cuts ?? []);
  const decisionCuts = eCuts.filter(cut => cut.afterDecisionsRead);
  const e2eCuts = eCuts.filter(cut => cut.afterE2eFailure);
  const grade = meta.grade ?? {};
  return {
    seed: meta.seed, arm: meta.arm, score: grade.score ?? 0, success: grade.success === true,
    itemsCorrect: Object.values(grade.items ?? {}).filter((item: any) => item.correct).length, itemsTotal: Object.keys(grade.items ?? {}).length,
    checks: grade.requirements?.[CHECK_REQ] === true, e2eHonest: grade.requirements?.[E2E_REQ] === true,
    falseSuccess: (grade.falseMet ?? []).length > 0, falseMetE2e: grade.falseMetE2e === true, staleItems: (grade.staleItems ?? []).length,
    reported: !!meta.report, reportStatus: meta.report?.status, assignmentStatus: meta.assignment?.status,
    costUsd: sum(transcripts.map(t => t.costEstimate ?? 0)), summaryCostUsd: sum(transcripts.map(t => t.summaryUsage?.cost ?? 0)),
    wallS: (meta.assignment?.wallMs ?? 0) / 1000, requests: sum(transcripts.map(t => t.requests ?? 0)),
    inputTokens: sum(transcripts.map(t => t.usage?.input ?? 0)), outputTokens: sum(transcripts.map(t => t.usage?.output ?? 0)),
    cacheReadTokens: sum(transcripts.map(t => t.usage?.cacheRead ?? 0)), cacheWriteTokens: sum(transcripts.map(t => t.usage?.cacheWrite ?? 0)),
    compactions: cuts.length, workLogKinds: [...new Set(cuts.map((cut: any) => cut.workLogKind))].sort(),
    linkedResults: sum(evidence.map(e => e.linkedResults ?? 0)), citedCheckpoints: sum(evidence.map(e => e.citedCheckpoints ?? 0)),
    exposedDecisions: evidence.some(e => e.exposedDecisions), exposedE2e: evidence.some(e => e.exposedE2e),
    governingKept: sum(decisionCuts.map(cut => cut.governingKept)), governingTotal: sum(decisionCuts.map(cut => cut.governingTotal)), withdrawnOnly: sum(decisionCuts.map(cut => cut.withdrawnOnly)),
    e2eKept: e2eCuts.filter(cut => cut.e2eKept).length, e2eInWorkLog: e2eCuts.filter(cut => cut.e2eInWorkLog).length, e2eCuts: e2eCuts.length,
    decisionsRereads: sum(eCuts.map(cut => cut.decisionsRereadAfter > 0 ? 1 : 0)),
    itemFailures: (() => { const out = { changed: 0, retracted: 0, rejected: 0 }; for (const item of Object.values(grade.items ?? {}) as any[]) if (!item.correct) out[item.kind as keyof typeof out]++; return out; })(),
    feedFetches: (meta.feed?.requests ?? []).length, emptyRefetches: sum(evidence.map(e => e.emptyRefetches ?? 0)), notesWritten: sum(evidence.map(e => e.notesWritten ?? 0)), transcriptLookups: sum(evidence.map(e => e.transcriptLookups ?? 0)),
    unresolvedAtCut: sum(cuts.map((cut: any) => cut.unresolvedAtCut)), unresolvedShown: sum(cuts.map((cut: any) => cut.unresolvedShown)),
    checksAtCut: sum(cuts.map((cut: any) => cut.unresolvedChecksAtCut)), checksShown: sum(cuts.map((cut: any) => cut.unresolvedChecksShown)),
    laterCitedItems: sum(cuts.map((cut: any) => cut.laterCitedItems)), laterCitedShown: sum(cuts.map((cut: any) => cut.laterCitedShown)),
  };
}

export function loadStudy(dir: string): { rows: Row[]; infra: any[] } {
  const rows: Row[] = [], infra: any[] = [];
  const root = join(dir, "runs");
  if (!existsSync(root)) return { rows, infra };
  for (const instanceDir of readdirSync(root)) for (const armDir of readdirSync(join(root, instanceDir))) {
    const file = join(root, instanceDir, armDir, "meta.json");
    if (!existsSync(file)) continue;
    const meta = JSON.parse(readFileSync(file, "utf8"));
    if (meta.status !== "completed") continue;
    const attempt = { cell: `${instanceDir}/${armDir}`, outcome: meta.outcome, error: meta.infraError ?? meta.assignment?.error?.slice(0, 300), costUsd: sum((meta.transcripts ?? []).map((t: any) => t.costEstimate ?? 0)) };
    if (armDir.includes("-infra-") || meta.outcome === "infra") infra.push(attempt);
    else rows.push(rowOf(meta));
  }
  return { rows, infra };
}

const pct = (a: number, b: number) => b ? Math.round(1000 * a / b) / 10 : null;

export function summarize(rows: Row[]) {
  const arms = Object.fromEntries(ARMS.map(arm => {
    const own = rows.filter(row => row.arm === arm);
    const med = (values: number[]) => { const sorted = values.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : NaN; };
    return [arm, {
      runs: own.length, meanScore: sum(own.map(r => r.score)) / own.length, success: own.filter(r => r.success).length, itemsCorrect: sum(own.map(r => r.itemsCorrect)), itemsTotal: sum(own.map(r => r.itemsTotal)),
      checks: own.filter(r => r.checks).length, e2eHonest: own.filter(r => r.e2eHonest).length, falseSuccessRuns: own.filter(r => r.falseSuccess).length, falseMetE2e: own.filter(r => r.falseMetE2e).length, staleItems: sum(own.map(r => r.staleItems)),
      unreported: own.filter(r => !r.reported).length, blocked: own.filter(r => r.reportStatus === "blocked").length, timeouts: own.filter(r => r.assignmentStatus === "timeout").length,
      itemFailuresByKind: { changed: sum(own.map(r => r.itemFailures.changed)), retracted: sum(own.map(r => r.itemFailures.retracted)), rejected: sum(own.map(r => r.itemFailures.rejected)) },
      compactionsPerRun: { mean: sum(own.map(r => r.compactions)) / own.length, median: med(own.map(r => r.compactions)), max: Math.max(...own.map(r => r.compactions)) },
      costUsd: sum(own.map(r => r.costUsd)), costPerRun: sum(own.map(r => r.costUsd)) / own.length, summaryCostUsd: sum(own.map(r => r.summaryCostUsd)),
      medianWallS: med(own.map(r => r.wallS)), meanRequests: sum(own.map(r => r.requests)) / own.length,
      tokens: { input: sum(own.map(r => r.inputTokens)), output: sum(own.map(r => r.outputTokens)), cacheRead: sum(own.map(r => r.cacheReadTokens)), cacheWrite: sum(own.map(r => r.cacheWriteTokens)) },
      activation: {
        withCompaction: own.filter(r => r.compactions > 0).length, compactions: sum(own.map(r => r.compactions)),
        decisionLogRuns: own.filter(r => r.workLogKinds.includes("decision")).length, basicLogRuns: own.filter(r => r.workLogKinds.includes("basic")).length,
        linkedRuns: own.filter(r => r.linkedResults > 0).length, citedRuns: own.filter(r => r.citedCheckpoints > 0).length,
        exposedDecisions: own.filter(r => r.exposedDecisions).length, exposedE2e: own.filter(r => r.exposedE2e).length,
      },
      retention: {
        governingKeptPct: pct(sum(own.map(r => r.governingKept)), sum(own.map(r => r.governingTotal))), governing: `${sum(own.map(r => r.governingKept))}/${sum(own.map(r => r.governingTotal))}`,
        withdrawnOnly: sum(own.map(r => r.withdrawnOnly)),
        e2eKept: `${sum(own.map(r => r.e2eKept))}/${sum(own.map(r => r.e2eCuts))}`, e2eInWorkLog: `${sum(own.map(r => r.e2eInWorkLog))}/${sum(own.map(r => r.e2eCuts))}`,
        unresolvedShown: `${sum(own.map(r => r.unresolvedShown))}/${sum(own.map(r => r.unresolvedAtCut))}`, checksShown: `${sum(own.map(r => r.checksShown))}/${sum(own.map(r => r.checksAtCut))}`,
        laterCitedShown: `${sum(own.map(r => r.laterCitedShown))}/${sum(own.map(r => r.laterCitedItems))}`, cutsFollowedByEmptyRefetch: sum(own.map(r => r.decisionsRereads)),
        runsWithEmptyRefetch: own.filter(r => r.emptyRefetches > 0).length, runsWithNotes: own.filter(r => r.notesWritten > 0).length, runsWithTranscriptLookup: own.filter(r => r.transcriptLookups > 0).length,
      },
      exposedMeanScore: (() => { const e = own.filter(r => r.exposedDecisions); return e.length ? sum(e.map(r => r.score)) / e.length : null; })(),
    }];
  }));
  const contrastsOf = (cells: Map<number, Cells>) => Object.fromEntries(Object.entries(CONTRASTS).map(([name, contrast]) => {
    const interval = bootstrap(cells, contrast);
    return [name, { ...interval, p: signFlipP([...cells.values()].map(contrast)) }];
  }));
  const score = cellMeans(rows, row => row.score);
  const success = cellMeans(rows, row => row.success ? 1 : 0);
  const cost = cellMeans(rows, row => row.costUsd);
  const wall = cellMeans(rows, row => row.wallS);
  const falseSuccess = cellMeans(rows, row => row.falseSuccess ? 1 : 0);
  const stale = cellMeans(rows, row => row.staleItems);
  const items = cellMeans(rows, row => row.itemsTotal ? row.itemsCorrect / row.itemsTotal : 0);
  const scoreContrasts = contrastsOf(score);
  const m = means(score), c = means(cost), fs = means(falseSuccess), st = means(stale);
  const verdict = interactionVerdict(scoreContrasts.interaction!, informative(score));
  const useful = practicallyUseful({ mlMinusK: scoreContrasts.mlMinusK!, mlMinusBestSingle: m.xy - Math.max(m.x, m.y), costRatio: c.xy / c.base, harmDelta: { falseSuccessRuns: fs.xy - fs.base, staleItems: st.xy - st.base } });
  return {
    instances: score.size, informativeInstances: informative(score), arms,
    primary: { metric: "requirement score (0-1)", cells: m, contrasts: scoreContrasts, mlMinusBestSingle: m.xy - Math.max(m.x, m.y), verdict, practicallyUseful: useful },
    secondary: {
      success: { cells: means(success), contrasts: contrastsOf(success), informative: informative(success), verdict: interactionVerdict(bootstrap(success, CONTRASTS.interaction), informative(success)) },
      itemsCorrect: { cells: means(items), contrasts: contrastsOf(items) },
      falseSuccess: { cells: fs, contrasts: contrastsOf(falseSuccess) },
      staleItems: { cells: st, contrasts: contrastsOf(stale) },
      cost: { cells: c, ratioMLtoK: c.xy / c.base, contrasts: contrastsOf(cost) },
      wallS: { cells: means(wall), contrasts: contrastsOf(wall) },
    },
    templateSensitivity: Object.fromEntries(TEMPLATES.map(template => {
      const kept = new Map([...score.entries()].filter(([seed]) => !instance(seed).items.some(item => item.template === template.id)));
      return [template.id, { instances: kept.size, interaction: kept.size ? [...kept.values()].reduce((total, cells) => total + CONTRASTS.interaction(cells), 0) / kept.size : null }];
    })),
    perInstance: Object.fromEntries([...score.entries()].map(([seed, cells]) => [`p${seed}`, { score: cells, cost: cost.get(seed) }])),
  };
}

if (process.argv[1]?.endsWith("summarize.ts")) {
  const dir = process.argv[2]!;
  const outIndex = process.argv.indexOf("--out");
  const { rows, infra } = loadStudy(dir);
  const result = { study: dir, at: new Date().toISOString(), runs: rows.length, infraAttempts: infra, totalCostUsd: sum(rows.map(r => r.costUsd)) + sum(infra.map(a => a.costUsd)), ...summarize(rows), rows };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outIndex > 0) writeFileSync(process.argv[outIndex + 1]!, text);
  else process.stdout.write(text);
}
