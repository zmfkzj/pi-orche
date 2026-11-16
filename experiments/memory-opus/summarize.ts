/**
 * Analysis of the Opus decision-memory study (PREREGISTRATION.md §5-§6): decision memory ON (M) vs OFF (K), paired per instance.
 *
 *   npx tsx experiments/memory-opus/summarize.ts <study dir> [--reused <decision-memory-b scored-opus dir>] [--out summary.json]
 *
 * Every completed, non-infra run counts as randomized (timeouts, harness failures after model progress and blocked runs are
 * failures). Pairs need both arms; an instance with one arm only is reported and left out.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeEvidence } from "../decision-memory-b/evidence.js";
import { instance } from "../decision-memory-b/project.js";
import { rowOf } from "../decision-memory-b/summarize.js";
import { costAnalysis, costMet, futile, newcombePaired, overallVerdict, pairCounts, qualityVerdict, bootstrapPairs, signFlipP, STAGE1_SEEDS, STAGE2_SEEDS, type Pair } from "./protocol.js";

export interface Run {
  seed: number; arm: "K" | "M"; phase: string; outcome: string; harnessFailure: boolean;
  success: boolean; solverSuccess: boolean; score: number; itemsCorrect: number; itemsTotal: number; checks: boolean; e2eHonest: boolean;
  reported: boolean; reportStatus?: string; assignmentStatus?: string; timeout: boolean;
  falseSuccess: boolean; falseMetE2e: boolean; falseMetItems: number; staleItems: number;
  costUsd: number; summaryCostUsd: number; wallS: number; requests: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compactions: number; decisionLogCuts: number; basicLogCuts: number;
  exposedDecisions: boolean; exposedDecisionsBroad: boolean; exposedE2e: boolean;
  governingKept: number; governingTotal: number; withdrawnOnly: number;
  e2eCuts: number; e2eKept: number; e2eInWorkLog: number;
  unresolvedAtCut: number; unresolvedShown: number; checksAtCut: number; checksShown: number;
  feedFetches: number; emptyRefetches: number; notesWritten: number;
  transcriptLookupsStarted: number; unfinishedCalls: number; unfinishedTranscriptLookups: number; longCalls: number; longTranscriptLookups: number;
  resolvedConfig: unknown;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

export function runOf(stored: any): Run {
  // Recompute the evidence analysis from the worker transcripts with the current evidence.ts (older runs lack the newer fields).
  const texts = (stored.transcripts ?? []).map((t: any) => { try { return readFileSync(t.file, "utf8"); } catch { return undefined; } });
  const meta = texts.length && texts.every((text: string | undefined) => text !== undefined) ? { ...stored, evidence: texts.map((text: string) => analyzeEvidence(text, instance(stored.seed), { feedDeliveredAt: (stored.feed?.requests ?? []).find((request: any) => request.delivered)?.at })) } : stored;
  const row = rowOf(meta);
  const evidence: any[] = meta.evidence ?? [];
  const cuts = (meta.transcripts ?? []).flatMap((t: any) => t.compactions ?? []);
  const grade = meta.grade ?? {};
  const solverIds = Object.keys(grade.requirements ?? {}).filter(id => id !== "R9");
  return {
    seed: meta.seed, arm: meta.arm, phase: meta.phase, outcome: meta.outcome, harnessFailure: !!meta.harnessFailure,
    success: row.success, solverSuccess: solverIds.length > 0 && solverIds.every(id => grade.requirements[id] === true), score: row.score,
    itemsCorrect: row.itemsCorrect, itemsTotal: row.itemsTotal, checks: row.checks, e2eHonest: row.e2eHonest,
    reported: row.reported, reportStatus: row.reportStatus, assignmentStatus: row.assignmentStatus, timeout: row.assignmentStatus === "timeout",
    falseSuccess: row.falseSuccess, falseMetE2e: row.falseMetE2e, falseMetItems: (grade.falseMet ?? []).filter((id: string) => id !== "R9").length, staleItems: row.staleItems,
    costUsd: row.costUsd, summaryCostUsd: row.summaryCostUsd, wallS: row.wallS, requests: row.requests,
    tokens: { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens },
    compactions: row.compactions, decisionLogCuts: cuts.filter((cut: any) => cut.workLogKind === "decision").length, basicLogCuts: cuts.filter((cut: any) => cut.workLogKind === "basic").length,
    exposedDecisions: row.exposedDecisions, exposedDecisionsBroad: evidence.some(e => e.exposedDecisionsBroad), exposedE2e: row.exposedE2e,
    governingKept: row.governingKept, governingTotal: row.governingTotal, withdrawnOnly: row.withdrawnOnly,
    e2eCuts: row.e2eCuts, e2eKept: row.e2eKept, e2eInWorkLog: row.e2eInWorkLog,
    unresolvedAtCut: row.unresolvedAtCut, unresolvedShown: row.unresolvedShown, checksAtCut: row.checksAtCut, checksShown: row.checksShown,
    feedFetches: row.feedFetches, emptyRefetches: row.emptyRefetches, notesWritten: row.notesWritten,
    transcriptLookupsStarted: sum(evidence.map(e => e.transcriptLookupsStarted ?? 0)), unfinishedCalls: sum(evidence.map(e => e.unfinishedCalls ?? 0)),
    unfinishedTranscriptLookups: sum(evidence.map(e => e.unfinishedTranscriptLookups ?? 0)), longCalls: sum(evidence.map(e => e.longCalls ?? 0)), longTranscriptLookups: sum(evidence.map(e => e.longTranscriptLookups ?? 0)),
    resolvedConfig: meta.resolvedConfig,
  };
}

export function loadRuns(dir: string, seeds?: readonly number[]): { runs: Run[]; infra: { cell: string; error?: string; costUsd: number }[] } {
  const runs: Run[] = [], infra: { cell: string; error?: string; costUsd: number }[] = [];
  const root = join(dir, "runs");
  if (!existsSync(root)) return { runs, infra };
  for (const instanceDir of readdirSync(root)) for (const armDir of readdirSync(join(root, instanceDir))) {
    const file = join(root, instanceDir, armDir, "meta.json");
    if (!existsSync(file)) continue;
    const meta = JSON.parse(readFileSync(file, "utf8"));
    if (meta.status !== "completed" || (seeds && !seeds.includes(meta.seed)) || !["K", "M"].includes(meta.arm)) continue;
    if (armDir.includes("-infra-") || meta.outcome === "infra") infra.push({ cell: `${instanceDir}/${armDir}`, error: meta.infraError, costUsd: sum((meta.transcripts ?? []).map((t: any) => t.costEstimate ?? 0)) });
    else runs.push(runOf(meta));
  }
  return { runs, infra };
}

export function pairsOf(runs: readonly Run[]): { pairs: (Pair & { runs: { on: Run; off: Run } })[]; unpaired: number[] } {
  const seeds = [...new Set(runs.map(run => run.seed))].sort((a, b) => a - b);
  const pairs: (Pair & { runs: { on: Run; off: Run } })[] = [], unpaired: number[] = [];
  for (const seed of seeds) {
    const on = runs.find(run => run.seed === seed && run.arm === "M"), off = runs.find(run => run.seed === seed && run.arm === "K");
    if (!on || !off) { unpaired.push(seed); continue; }
    const view = (run: Run) => ({ success: run.success, score: run.score, costUsd: run.costUsd, wallS: run.wallS });
    pairs.push({ seed, on: view(on), off: view(off), runs: { on, off } });
  }
  return { pairs, unpaired };
}

const pct = (a: number, b: number) => b ? Math.round(1000 * a / b) / 10 : null;
const median = (values: number[]) => { const s = values.slice().sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };

export function armSummary(runs: readonly Run[]) {
  const n = runs.length;
  return {
    runs: n, success: runs.filter(r => r.success).length, solverSuccess: runs.filter(r => r.solverSuccess).length, meanScore: sum(runs.map(r => r.score)) / n,
    itemsCorrect: `${sum(runs.map(r => r.itemsCorrect))}/${sum(runs.map(r => r.itemsTotal))}`, checks: runs.filter(r => r.checks).length, e2eHonest: runs.filter(r => r.e2eHonest).length,
    timeouts: runs.filter(r => r.timeout).length, harnessFailures: runs.filter(r => r.harnessFailure).length, unreported: runs.filter(r => !r.reported).length, blocked: runs.filter(r => r.reportStatus === "blocked").length,
    falseSuccessRuns: runs.filter(r => r.falseSuccess).length, falseMetE2e: runs.filter(r => r.falseMetE2e).length, falseMetItems: sum(runs.map(r => r.falseMetItems)), staleItems: sum(runs.map(r => r.staleItems)),
    cost: { total: sum(runs.map(r => r.costUsd)), perRun: sum(runs.map(r => r.costUsd)) / n, median: median(runs.map(r => r.costUsd)), perSuccess: sum(runs.map(r => r.costUsd)) / Math.max(1, runs.filter(r => r.success).length), summary: sum(runs.map(r => r.summaryCostUsd)) },
    wallS: { mean: sum(runs.map(r => r.wallS)) / n, median: median(runs.map(r => r.wallS)) },
    requestsPerRun: sum(runs.map(r => r.requests)) / n,
    tokensPerRun: Object.fromEntries((["input", "output", "cacheRead", "cacheWrite"] as const).map(key => [key, Math.round(sum(runs.map(r => r.tokens[key])) / n)])),
    activation: {
      withCompaction: runs.filter(r => r.compactions > 0).length, compactionsPerRun: sum(runs.map(r => r.compactions)) / n, compactionsMedian: median(runs.map(r => r.compactions)),
      runsWithDecisionLog: runs.filter(r => r.decisionLogCuts > 0).length, runsWithBasicLog: runs.filter(r => r.basicLogCuts > 0).length,
      cutsDecisionLog: sum(runs.map(r => r.decisionLogCuts)), cutsBasicLog: sum(runs.map(r => r.basicLogCuts)),
      exposedDecisions: runs.filter(r => r.exposedDecisions).length, exposedDecisionsBroad: runs.filter(r => r.exposedDecisionsBroad).length, exposedE2e: runs.filter(r => r.exposedE2e).length,
    },
    retention: {
      governingKept: `${sum(runs.map(r => r.governingKept))}/${sum(runs.map(r => r.governingTotal))}`, governingKeptPct: pct(sum(runs.map(r => r.governingKept)), sum(runs.map(r => r.governingTotal))), withdrawnOnly: sum(runs.map(r => r.withdrawnOnly)),
      e2eInRestoredContext: `${sum(runs.map(r => r.e2eKept))}/${sum(runs.map(r => r.e2eCuts))}`, e2eInWorkLog: `${sum(runs.map(r => r.e2eInWorkLog))}/${sum(runs.map(r => r.e2eCuts))}`,
      unresolvedShownInWorkLog: `${sum(runs.map(r => r.unresolvedShown))}/${sum(runs.map(r => r.unresolvedAtCut))}`, failingChecksShownInWorkLog: `${sum(runs.map(r => r.checksShown))}/${sum(runs.map(r => r.checksAtCut))}`,
    },
    lookups: {
      feedFetchesPerRun: sum(runs.map(r => r.feedFetches)) / n, runsWithEmptyRefetch: runs.filter(r => r.emptyRefetches > 0).length, runsWithNotes: runs.filter(r => r.notesWritten > 0).length,
      runsWithTranscriptLookup: runs.filter(r => r.transcriptLookupsStarted > 0).length, transcriptLookupsStarted: sum(runs.map(r => r.transcriptLookupsStarted)),
      unfinishedTranscriptLookups: sum(runs.map(r => r.unfinishedTranscriptLookups)), unfinishedCalls: sum(runs.map(r => r.unfinishedCalls)), longCalls: sum(runs.map(r => r.longCalls)), longTranscriptLookups: sum(runs.map(r => r.longTranscriptLookups)), runsWithLongTranscriptLookup: runs.filter(r => r.longTranscriptLookups > 0).length,
    },
  };
}

/** The confirmatory analysis of a set of runs (the fresh seeds), or a descriptive one (reused seeds). */
export function analyse(runs: readonly Run[]) {
  const { pairs, unpaired } = pairsOf(runs);
  const counts = pairCounts(pairs.map(pair => ({ on: pair.on.success, off: pair.off.success })));
  const quality = newcombePaired(counts);
  const solverCounts = pairCounts(pairs.map(pair => ({ on: pair.runs.on.solverSuccess, off: pair.runs.off.solverSuccess })));
  const cost = costAnalysis(pairs);
  const verdict = qualityVerdict(quality);
  const scoreDiffs = pairs.map(pair => pair.on.score - pair.off.score);
  const wallDiffs = pairs.map(pair => pair.on.wallS - pair.off.wallS);
  const harm = (key: "falseSuccess" | "staleItems" | "timeout") => {
    const value = (run: Run) => key === "staleItems" ? run.staleItems : run[key] ? 1 : 0;
    return { ...bootstrapPairs(pairs, sample => sum(sample.map(pair => value(pair.runs.on) - value(pair.runs.off))) / sample.length), on: sum(pairs.map(pair => value(pair.runs.on))), off: sum(pairs.map(pair => value(pair.runs.off))) };
  };
  return {
    pairs: pairs.length, unpaired, counts,
    quality: { metric: "task success (all 9 requirements correct), p_ON - p_OFF", interval: quality, verdict },
    secondaryQuality: {
      solverSuccess: { counts: solverCounts, interval: newcombePaired(solverCounts), note: "R1-R8 (excludes the deliberately impossible R9)" },
      scoreDiff: { ...bootstrapPairs(scoreDiffs, sample => sum(sample) / sample.length), p: signFlipP(scoreDiffs), nonZeroPairs: scoreDiffs.filter(d => d !== 0).length },
    },
    cost: { ...cost, met: costMet(cost) },
    wall: { ...bootstrapPairs(wallDiffs, sample => sum(sample) / sample.length), p: signFlipP(wallDiffs) },
    harm: { falseSuccess: harm("falseSuccess"), staleItems: harm("staleItems"), timeouts: harm("timeout") },
    overall: overallVerdict(verdict, costMet(cost)),
    arms: { K: armSummary(runs.filter(run => run.arm === "K")), M: armSummary(runs.filter(run => run.arm === "M")) },
    perPair: pairs.map(pair => ({ seed: pair.seed, off: { success: pair.off.success, score: Math.round(pair.off.score * 9), cost: +pair.off.costUsd.toFixed(3), wallS: Math.round(pair.off.wallS) }, on: { success: pair.on.success, score: Math.round(pair.on.score * 9), cost: +pair.on.costUsd.toFixed(3), wallS: Math.round(pair.on.wallS) } })),
  };
}

/** Interim futility after stage 1 (PREREGISTRATION.md §6). */
export function interim(runs: readonly Run[]) {
  const stage1 = runs.filter(run => STAGE1_SEEDS.includes(run.seed));
  const { pairs } = pairsOf(stage1);
  const counts = pairCounts(pairs.map(pair => ({ on: pair.on.success, off: pair.off.success })));
  return { stage1Pairs: pairs.length, counts, futile: futile(counts, STAGE2_SEEDS.length + (STAGE1_SEEDS.length - pairs.length)), bestCaseFinal: newcombePaired({ ...counts, a: counts.a + STAGE2_SEEDS.length + (STAGE1_SEEDS.length - pairs.length) }) };
}

/** The two arms' resolved configurations differ only in workerCompaction.decisionMemory. */
export function configsDifferOnlyInMemory(runs: readonly Run[]): boolean {
  const strip = (config: any) => JSON.stringify({ ...config, workerCompaction: { ...config?.workerCompaction, decisionMemory: undefined } });
  const configs = runs.filter(run => run.resolvedConfig).map(run => ({ arm: run.arm, key: strip(run.resolvedConfig), memory: (run.resolvedConfig as any)?.workerCompaction?.decisionMemory === true }));
  return configs.length > 0 && new Set(configs.map(c => c.key)).size === 1 && configs.every(c => c.memory === (c.arm === "M"));
}

if (process.argv[1]?.endsWith("summarize.ts")) {
  const dir = process.argv[2]!;
  const flag = (name: string) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  const { runs, infra } = loadRuns(dir, [...STAGE1_SEEDS, ...STAGE2_SEEDS]);
  const reusedDir = flag("--reused");
  const reused = reusedDir ? loadRuns(reusedDir, [1, 2, 3, 4, 5, 6]) : undefined;
  const result = {
    study: dir, at: new Date().toISOString(), runs: runs.length, infraAttempts: infra,
    totalCostUsd: sum(runs.map(r => r.costUsd)) + sum(infra.map(a => a.costUsd)),
    configsDifferOnlyInMemory: configsDifferOnlyInMemory(runs),
    interim: interim(runs),
    confirmatory: analyse(runs),
    reusedInspected: reused ? { note: "experiments/decision-memory-b scored-opus seeds 1-6, arms K/M: inspected earlier, NOT confirmatory, not pooled", ...analyse(reused.runs) } : undefined,
    runsDetail: runs,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const out = flag("--out");
  if (out) writeFileSync(out, text); else process.stdout.write(text);
}
