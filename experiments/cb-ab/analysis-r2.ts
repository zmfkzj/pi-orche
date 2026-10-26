/**
 * Explicit-status analysis of the cb-ab study, round 2 (results/cb-ab/PROTOCOL-R2.md Part R / Part V "Rules", Amendment R2-A1 items 1-3).
 * Model-free; round-1 score.ts and protocol.ts are not changed: protocol.ts summarizeCase / stopAfterTwo / verdict are applied to the
 * ANALYSIS SET only, with R2-A1's explicit saturation.
 *
 *   node --import tsx experiments/cb-ab/analysis-r2.ts analyze <study> <casesDir> <scoresRoot> [--compare <round1ScoringDir>] [--out <dir>]
 *
 * <scoresRoot> holds <scorer>/<case>/scores.json (+ validation.json) as experiments/cb-ab/sol-score.ts writes them (S1 primary, S2
 * sensitivity). Writes analysis-S1.json, analysis-S2.json, disagreements-S1-S2.json and, with --compare, agreement-round1.json.
 *
 *  - Run status per unit (R2-A1 item 1): `completed` (a final report, every request route-compliant, not killed), `missing` (no final
 *    report: provider stop, guard kill, infrastructure, an unfinished unit), `non-compliant` (a route violation).
 *  - Packet status: `scored` only when every known defect has an M/L/S entry with a quote (and the schema's findings array); otherwise
 *    `unscored` (sol-score.ts already re-ran an incomplete session once). An absent entry is never a zero.
 *  - Analysis set = completed ∧ compliant ∧ scored. Per case and arm: n, the runs left out and why, found sets (FOUND = M=1 ∧ L=1),
 *    B-unique vs A, A-unique vs B, B-unique vs C, mean V/F/U (null without runs), saturation (both A repeats in the set, each found every
 *    known defect; fewer -> "unknown", not saturated for the gate), reproducibility (two scored repeats, else "n/a").
 *  - Gate: protocol.ts stopAfterTwo on the first two cases with the explicit saturation; verdict: protocol.ts verdict (a stop gives
 *    "not-supported", stopped by rule, as score.ts did). Fewer than two cases: no gate; no case: "unresolved".
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../mdsd-ab/run.js";
import { ARMS, found, stopAfterTwo, summarizeCase, verdict, type Arm, type CaseSummary, type KScore, type RunScore } from "./protocol.js";

const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const safeJson = (file: string): any => { try { return json(file); } catch { return undefined; } };
const round = (value: number) => Math.round(value * 1e6) / 1e6;

// ---- run status ------------------------------------------------------------------------------------------------------------------

export type RunStatus = "completed" | "missing" | "non-compliant";
export interface RunStatusResult { status: RunStatus; reasons: string[]; providerErrors: string[]; explorerCompliant?: boolean }

/**
 * Status of one unit from its evidence (run.ts meta.json, wire.jsonl): missing without a completed unit, with no successful model
 * request (infrastructure), when the guard killed it, or without a final report (the provider stop of c2/A/r1); non-compliant with a
 * route violation (or no route check); completed otherwise. Every reason that applies is listed.
 */
export function runStatus(meta: any, wire: readonly any[] = []): RunStatusResult {
  const reasons: string[] = [];
  const providerErrors = wire.filter(entry => entry?.method === "POST" && entry.providerError).map(entry => [entry.providerError.type, entry.providerError.code].filter(Boolean).join("/") || "provider error");
  const missing: string[] = [];
  if (!meta) missing.push("no unit evidence (meta.json)");
  else {
    if (meta.status !== "completed") missing.push(`unit ${meta.status ?? "unfinished"}`);
    if (meta.infra === true) missing.push("no successful model request (infrastructure)");
    if (meta.pi?.guardFired) missing.push("killed by the process guard");
    if (meta.final?.report !== true) missing.push(`no final report${providerErrors.length ? ` (provider stop: ${[...new Set(providerErrors)].join(", ")})` : ""}`);
  }
  const routeOk = meta?.route?.ok === true;
  const routeReason = meta?.route ? (routeOk ? undefined : `route violations: ${meta.route.violations ?? "?"} ${JSON.stringify(meta.route.byKind ?? {})}`) : "no route check";
  reasons.push(...missing);
  if (routeReason) reasons.push(routeReason);
  const explorer = meta?.compliance?.explorer;
  const base = { reasons, providerErrors, ...(explorer ? { explorerCompliant: explorer.compliant === true } : {}) };
  if (missing.length) return { status: "missing", ...base };
  if (!routeOk) return { status: "non-compliant", ...base };
  return { status: "completed", ...base };
}

/** The status of runs/<case>/<arm>/r<n> of a study (a unit directory absent = missing). */
export function unitStatus(study: string, unit: string): RunStatusResult & { unit: string; dir: string } {
  const dir = join(resolve(study), "runs", unit);
  const meta = safeJson(join(dir, "meta.json"));
  return { unit, dir, ...runStatus(meta, existsSync(join(dir, "wire.jsonl")) ? readJsonl(join(dir, "wire.jsonl")) : []) };
}

// ---- scores and packet status ----------------------------------------------------------------------------------------------------

export interface KEntry { k: string; m: number; l: number; s: number; quote: string }
export interface Finding { id?: string; claim?: string; location?: string; class: string; reason?: string; evidence?: string }
export interface PacketScore { k: KEntry[]; findings: Finding[]; notes?: string }
export interface PacketValidation { label: string; status: "scored" | "incomplete"; problems: string[]; warnings: string[]; counts?: { V: number; F: number; U: number } }
export interface ScoresValidation { parsed: boolean; problems: string[]; packets: Record<string, PacketValidation>; unknownLabels: string[]; incomplete: string[] }

const bit = (value: unknown) => value === 0 || value === 1;

/** One packet entry: scored only with exactly one complete entry (m, l, s in {0,1}, a non-empty quote) per known defect and a findings array. */
export function validatePacket(label: string, entry: any, kItems: readonly string[]): PacketValidation {
  const problems: string[] = [], warnings: string[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { label, status: "incomplete", problems: ["no entry for this packet"], warnings };
  const k = Array.isArray(entry.k) ? entry.k : undefined;
  if (!k) problems.push("no k array");
  for (const id of kItems) {
    const items = (k ?? []).filter((item: any) => item?.k === id);
    if (!items.length) { problems.push(`${id}: no entry`); continue; }
    if (items.length > 1) { problems.push(`${id}: ${items.length} entries`); continue; }
    const item = items[0];
    for (const key of ["m", "l", "s"] as const) if (!bit(item[key])) problems.push(`${id}: ${key} is ${JSON.stringify(item[key])}, not 0 or 1`);
    if (typeof item.quote !== "string" || !item.quote.trim()) problems.push(`${id}: no quote`);
  }
  for (const item of k ?? []) if (!kItems.includes(item?.k)) warnings.push(`entry for unknown known defect ${JSON.stringify(item?.k)}`);
  let counts: PacketValidation["counts"];
  if (!Array.isArray(entry.findings)) problems.push("no findings array");
  else {
    counts = { V: 0, F: 0, U: 0 };
    entry.findings.forEach((finding: any, index: number) => {
      const cls = finding?.class;
      if (cls === "V" || cls === "F" || cls === "U") counts![cls as "V" | "F" | "U"]++;
      else problems.push(`finding ${finding?.id ?? index + 1}: class ${JSON.stringify(cls)} is not V, F or U`);
      if ((cls === "V" || cls === "F") && !(typeof finding?.evidence === "string" && finding.evidence.trim())) warnings.push(`finding ${finding?.id ?? index + 1} (${cls}): no evidence recorded`);
      if (!(typeof finding?.claim === "string" && finding.claim.trim())) warnings.push(`finding ${finding?.id ?? index + 1}: no claim text`);
    });
  }
  return { label, status: problems.length ? "incomplete" : "scored", problems, warnings, ...(counts ? { counts } : {}) };
}

/** A scores.json (any parsed value) against the expected packet labels and known defects. */
export function validateScores(raw: unknown, expectedLabels: readonly string[], kItems: readonly string[]): ScoresValidation {
  const data = raw as any;
  const parsed = !!data && typeof data === "object" && !Array.isArray(data);
  const problems: string[] = [];
  if (!parsed) problems.push("not a JSON object");
  const packets = parsed && data.packets && typeof data.packets === "object" && !Array.isArray(data.packets) ? data.packets : undefined;
  if (parsed && !packets) problems.push("no packets object");
  const out: Record<string, PacketValidation> = {};
  for (const label of expectedLabels) out[label] = validatePacket(label, packets?.[label], kItems);
  const unknownLabels = packets ? Object.keys(packets).filter(label => !expectedLabels.includes(label)) : [];
  return { parsed, problems, packets: out, unknownLabels, incomplete: expectedLabels.filter(label => out[label]!.status !== "scored") };
}

// ---- inputs of an analysis -------------------------------------------------------------------------------------------------------

export interface CaseInfo { id: string; order: number; dir: string; kItems: string[] }
/** Case directories (c<n>-*) of a cases dir with their known defects (rubric.json), in case order. */
export function loadCases(casesDir: string): CaseInfo[] {
  return readdirSync(casesDir).filter(name => /^c\d+-/.test(name) && existsSync(join(casesDir, name, "case.json")) && existsSync(join(casesDir, name, "rubric.json")))
    .map(name => { const spec = json(join(casesDir, name, "case.json")); return { id: String(spec.id), order: Number(spec.order), dir: join(casesDir, name), kItems: json(join(casesDir, name, "rubric.json")).knownDefects.map((item: any) => String(item.id)) }; })
    .sort((a, b) => a.order - b.order);
}

export interface KeyEntry { unit: string; arm: Arm; repeat: number; finalSha256?: string }
export const loadKey = (study: string): Record<string, KeyEntry> => json(join(resolve(study), "scoring/key.json"));
export const loadPacketIndex = (study: string): Record<string, { label: string; packetSha256: string }[]> => json(join(resolve(study), "scoring/packets.json")).index;

/** One scorer's outputs per case: the scores.json and sol-score.ts's validation.json (session compliance); absent = never scored. */
export interface ScorerCase { scores?: any; validation?: any; file?: string }
export function loadScorer(scoresRoot: string, scorer: string, caseIds: readonly string[]): Record<string, ScorerCase> {
  return Object.fromEntries(caseIds.map(id => {
    const file = join(resolve(scoresRoot), scorer, id, "scores.json");
    return [id, existsSync(file) ? { scores: json(file), validation: safeJson(join(resolve(scoresRoot), scorer, id, "validation.json")), file } : {}];
  }));
}

// ---- the analysis ----------------------------------------------------------------------------------------------------------------

export interface RunRow {
  unit: string; caseId: string; arm: Arm; repeat: number; label?: string;
  runStatus: RunStatus; runReasons: string[]; explorerCompliant?: boolean;
  packetStatus: "scored" | "unscored" | "not scored (run missing)" | "no packet";
  packetProblems: string[]; inSet: boolean; why?: string;
  k?: Record<string, { m: number; l: number; s: number; found: boolean }>;
  counts?: { V: number; F: number; U: number };
}
export type Saturation = true | false | "unknown";
export interface CaseResult {
  caseId: string; order: number; kItems: string[];
  n: Record<Arm, number>;
  leftOut: { unit: string; why: string }[];
  foundBy: Record<Arm, string[]>;
  bUniqueVsA: string[]; aUniqueVsB: string[]; bUniqueVsC: string[];
  meanV: Record<Arm, number | null>; meanF: Record<Arm, number | null>; meanU: Record<Arm, number | null>; meanKPoints: Record<Arm, number | null>;
  saturation: Saturation; saturationNote: string;
  reproducibility: Record<Arm, string[] | "n/a">;
  runs: RunRow[];
}

/** RunScore of protocol.ts from a scored packet (no default for an absent entry: callers pass scored packets only). */
export function runScoreOf(row: RunRow, kItems: readonly string[]): RunScore {
  const k: KScore[] = kItems.map(id => { const item = row.k![id]!; return { k: id, m: item.m ? 1 : 0, l: item.l ? 1 : 0, s: item.s ? 1 : 0 }; });
  return { unit: row.unit, caseId: row.caseId, arm: row.arm, repeat: row.repeat, k, v: row.counts!.V, f: row.counts!.F, u: row.counts!.U };
}

/** Rows of one case: every expected unit (arms × repeats), its run status, its packet and that packet's status in `scorer`. */
export function caseRows(study: string, info: CaseInfo, key: Record<string, KeyEntry>, scorer: ScorerCase, arms: readonly Arm[] = ARMS, repeats = 2): RunRow[] {
  const byUnit = new Map(Object.entries(key).map(([label, entry]) => [entry.unit, label]));
  const compliantScorer = scorer.validation ? scorer.validation.compliant !== false : true;
  const rows: RunRow[] = [];
  for (const arm of arms) for (let repeat = 1; repeat <= repeats; repeat++) {
    const unit = `${info.id}/${arm}/r${repeat}`;
    const status = unitStatus(study, unit);
    const label = byUnit.get(unit);
    const row: RunRow = { unit, caseId: info.id, arm, repeat, ...(label ? { label } : {}), runStatus: status.status, runReasons: status.reasons, ...(status.explorerCompliant === undefined ? {} : { explorerCompliant: status.explorerCompliant }), packetStatus: "no packet", packetProblems: [], inSet: false };
    if (status.status === "missing") row.packetStatus = "not scored (run missing)";
    else if (label) {
      const check = validatePacket(label, scorer.scores?.packets?.[label], info.kItems);
      row.packetStatus = check.status === "scored" && compliantScorer ? "scored" : "unscored";
      row.packetProblems = [...check.problems, ...(compliantScorer ? [] : ["the scorer session was not route-compliant"])];
      if (check.status === "scored") {
        const entry = scorer.scores.packets[label];
        row.k = Object.fromEntries(info.kItems.map(id => { const item = entry.k.find((x: any) => x.k === id); return [id, { m: item.m, l: item.l, s: item.s, found: item.m === 1 && item.l === 1 }]; }));
        row.counts = check.counts!;
      }
    }
    row.inSet = row.runStatus === "completed" && row.packetStatus === "scored";
    if (!row.inSet) row.why = row.runStatus !== "completed" ? `run ${row.runStatus}: ${row.runReasons.join("; ")}` : row.packetStatus === "no packet" ? "no packet for this run" : `packet ${row.packetStatus}: ${row.packetProblems.slice(0, 6).join("; ")}`;
    rows.push(row);
  }
  return rows;
}

export function summarizeRows(info: CaseInfo, rows: readonly RunRow[]): CaseResult {
  const set = rows.filter(row => row.inSet);
  const runs = set.map(row => runScoreOf(row, info.kItems));
  const summary = summarizeCase(info.id, info.kItems, runs);
  const of = (arm: Arm) => set.filter(row => row.arm === arm);
  const mean = (arm: Arm, pick: (run: RunScore) => number) => { const list = runs.filter(run => run.arm === arm); return list.length ? round(list.reduce((sum, run) => sum + pick(run), 0) / list.length) : null; };
  const per = (pick: (run: RunScore) => number) => ({ A: mean("A", pick), B: mean("B", pick), C: mean("C", pick) });
  const aRows = of("A");
  const bothA = [1, 2].every(repeat => aRows.some(row => row.repeat === repeat));
  const allFound = (row: RunRow) => info.kItems.every(id => row.k![id]!.found);
  const saturation: Saturation = bothA ? aRows.every(allFound) : "unknown";
  const saturationNote = bothA ? (saturation ? "both A repeats in the analysis set found every known defect" : "both A repeats in the analysis set; at least one missed a known defect")
    : `saturation unknown: ${aRows.length} of 2 A repeats in the analysis set (flagged; not saturated for the gate)`;
  const reproducibility = Object.fromEntries(ARMS.map(arm => {
    const list = of(arm);
    return [arm, list.length === 2 && new Set(list.map(row => row.repeat)).size === 2 ? info.kItems.filter(id => list.every(row => row.k![id]!.found)) : "n/a"];
  })) as Record<Arm, string[] | "n/a">;
  return {
    caseId: info.id, order: info.order, kItems: [...info.kItems],
    n: { A: of("A").length, B: of("B").length, C: of("C").length },
    leftOut: rows.filter(row => !row.inSet).map(row => ({ unit: row.unit, why: row.why ?? "" })),
    foundBy: summary.foundBy, bUniqueVsA: summary.bUniqueVsA, aUniqueVsB: summary.aUniqueVsB, bUniqueVsC: summary.bUniqueVsC,
    meanV: per(run => run.v), meanF: per(run => run.f), meanU: per(run => run.u), meanKPoints: per(run => run.k.reduce((sum, item) => sum + item.m + item.l + item.s, 0)),
    saturation, saturationNote, reproducibility, runs: [...rows],
  };
}

/** protocol.ts CaseSummary with R2-A1's saturation (true only when both A repeats are in the set and found everything). */
export const gateSummary = (result: CaseResult): CaseSummary => ({
  caseId: result.caseId, kItems: result.kItems, foundBy: result.foundBy, bUniqueVsA: result.bUniqueVsA, aUniqueVsB: result.aUniqueVsB, bUniqueVsC: result.bUniqueVsC,
  saturated: result.saturation === true,
  meanF: { A: result.meanF.A ?? NaN, B: result.meanF.B ?? NaN, C: result.meanF.C ?? NaN }, meanV: { A: result.meanV.A ?? NaN, B: result.meanV.B ?? NaN, C: result.meanV.C ?? NaN },
  meanKPoints: { A: result.meanKPoints.A ?? NaN, B: result.meanKPoints.B ?? NaN, C: result.meanKPoints.C ?? NaN },
});

export interface GateResult { applicable: boolean; cases?: string[]; stop?: boolean; saturatedForGate?: Record<string, boolean>; saturation?: Record<string, Saturation>; bUnique?: Record<string, string[]>; reason: string }
export function gateOf(results: readonly CaseResult[]): GateResult {
  if (results.length < 2) return { applicable: false, reason: `fewer than two cases (${results.length}): no stop gate` };
  const [first, second] = [results[0]!, results[1]!];
  const stop = stopAfterTwo(gateSummary(first), gateSummary(second));
  return {
    applicable: true, cases: [first.caseId, second.caseId], stop,
    saturatedForGate: { [first.caseId]: first.saturation === true, [second.caseId]: second.saturation === true },
    saturation: { [first.caseId]: first.saturation, [second.caseId]: second.saturation },
    bUnique: { [first.caseId]: first.bUniqueVsA, [second.caseId]: second.bUniqueVsA },
    reason: stop ? "B-unique is empty in both gate cases and not both are saturated: stop (not supported, by rule)" : (gateSummary(first).saturated && gateSummary(second).saturated ? "both gate cases are saturated: the gate does not stop" : "B-unique is non-empty in a gate case: the gate does not stop"),
  };
}

export interface VerdictResult { verdict: string; stoppedByRule: boolean; details: Record<string, number>; descriptive?: { verdict: string; details: Record<string, number> }; note?: string }
/** protocol.ts verdict over the analysis set; a stop by the gate gives "not-supported" (stopped by rule) as round-1 score.ts did. */
export function verdictOf(results: readonly CaseResult[], gate: GateResult): VerdictResult {
  if (!results.length) return { verdict: "unresolved", stoppedByRule: false, details: {}, note: "no case: stage-1 efficacy is UNRESOLVED (PROTOCOL-R2 'Fewer than three after T2')" };
  const runsOf = (list: readonly CaseResult[]) => list.flatMap(result => result.runs.filter(row => row.inSet).map(row => runScoreOf(row, result.kItems)));
  const summaries = results.map(gateSummary);
  if (gate.applicable && gate.stop) {
    const two = results.slice(0, 2);
    return { verdict: "not-supported", stoppedByRule: true, details: verdict(summaries.slice(0, 2), runsOf(two)).details, descriptive: verdict(summaries, runsOf(results)) };
  }
  const out: VerdictResult = { ...verdict(summaries, runsOf(results)), stoppedByRule: false };
  if (results.length === 1) out.note = "one case: validated descriptively; the verdict cannot be supported (protocol.ts verdict needs B-unique in two cases)";
  return out;
}

export interface Analysis {
  scorer: string; generatedAt: string; study: string; casesDir: string; scoresRoot: string;
  rules: string[]; runs: RunRow[]; cases: CaseResult[]; gate: GateResult; result: VerdictResult;
  scorerSessions: Record<string, unknown>; differencesFromRound1: { rules: string[]; onTheseScores: string[]; round1SemanticsOnTheseScores: { gateStop?: boolean; verdict: string } };
}

/** The whole analysis for one scorer. */
export function analyze(study: string, casesDir: string, scoresRoot: string, scorer: string): Analysis {
  const cases = loadCases(casesDir);
  const key = loadKey(study);
  const scores = loadScorer(scoresRoot, scorer, cases.map(item => item.id));
  const results = cases.map(info => summarizeRows(info, caseRows(study, info, key, scores[info.id]!)));
  const gate = gateOf(results);
  return {
    scorer, generatedAt: new Date().toISOString(), study: resolve(study), casesDir: resolve(casesDir), scoresRoot: resolve(scoresRoot),
    rules: [
      "run status (R2-A1 1): completed = final report + route-compliant + not killed; missing = no final report (provider stop, guard kill, infrastructure, unfinished); non-compliant = route violation",
      "packet status: scored only with one complete M/L/S entry (0/1 + quote) per known defect and a findings array; otherwise unscored (never a zero)",
      "analysis set (R2-A1 2) = completed and compliant and scored",
      "FOUND = M=1 and L=1; an arm found K in a case when at least one of its repeats in the set found it (protocol.ts summarizeCase)",
      "saturation (R2-A1 2): both A repeats in the set, each found every K; fewer -> unknown (flagged, not saturated for the gate)",
      "reproducibility: K found by both repeats, only with two repeats in the set, else n/a",
      "gate: protocol.ts stopAfterTwo on the first two cases with the explicit saturation; verdict: protocol.ts verdict over the set; a stop gives not-supported (stopped by rule)",
    ],
    runs: results.flatMap(result => result.runs), cases: results.map(result => ({ ...result, runs: result.runs })), gate, result: verdictOf(results, gate),
    scorerSessions: Object.fromEntries(cases.map(info => [info.id, scores[info.id]!.validation ? { compliant: scores[info.id]!.validation.compliant, finalRun: scores[info.id]!.validation.finalRun, packets: scores[info.id]!.validation.packets } : "no scores"])),
    differencesFromRound1: { rules: ROUND1_RULE_DIFFERENCES, ...round1Differences(study, cases, key, scores, results) },
  };
}

/** How these rules differ from round-1 score.ts analyze / protocol.ts summarizeCase, whatever the scores. */
export const ROUND1_RULE_DIFFERENCES = [
  "absent known-defect entry: score.ts:82 counts m=l=s=0; here the packet is unscored and left out (an absent entry is never a zero)",
  "run status: score.ts analyze counts every packet of scores.json whatever its run (round 1 scored the provider-stopped c2/A/r1 report with zeros); here only completed and route-compliant runs count, and a missing run is listed, never scored",
  "saturation: protocol.ts summarizeCase calls a case saturated when every A run PRESENT found every known defect (one A run suffices); here both A repeats must be in the analysis set, else 'unknown' (flagged, not saturated for the gate)",
  "reproducibility: score.ts uses every() over the arm's runs (vacuously true with no run, equal to 'found' with one run); here it is defined only with two scored repeats, else 'n/a'",
  "labels: score.ts analyze throws on a label missing from key.json; here such labels are listed and ignored",
  "compliance: score.ts analyze checks neither run route compliance nor the scorer session; here a non-compliant run or a non-compliant scorer session leaves its packets out",
  "mean V/F/U: protocol.ts summarizeCase gives NaN for an arm without runs and score.ts verdict's meanF uses every scored packet; here means are over the analysis set and null without runs",
];

/**
 * Where these results differ from round-1 score.ts analyze applied to the same scores: absent K entries defaulted to 0 (score.ts:82),
 * every scored packet counted whatever its run status, saturation over whatever A runs exist (summarizeCase: any A run present and all
 * found), reproducibility via every() (vacuously true without runs, = found with one run), and unknown labels as fatal.
 */
export function round1Differences(study: string, cases: readonly CaseInfo[], key: Record<string, KeyEntry>, scores: Record<string, ScorerCase>, results: readonly CaseResult[]): { onTheseScores: string[]; round1SemanticsOnTheseScores: { gateStop?: boolean; verdict: string } } {
  const out: string[] = [];
  const runs: RunScore[] = [];
  for (const info of cases) {
    const entries = scores[info.id]?.scores?.packets ?? {};
    for (const [label, entry] of Object.entries<any>(entries)) {
      const meta = key[label];
      if (!meta) { out.push(`${info.id}: label ${label} is not in key.json (score.ts analyze throws "unknown label"; here it is ignored and listed)`); continue; }
      const k: KScore[] = info.kItems.map(id => { const s = (entry?.k ?? []).find((x: any) => x?.k === id); if (!s) out.push(`${info.id} ${meta.unit} (${label}): no ${id} entry -> score.ts:82 would count m=l=s=0; here the packet is unscored`); return { k: id, m: s?.m ? 1 : 0, l: s?.l ? 1 : 0, s: s?.s ? 1 : 0 } as KScore; });
      const count = (cls: string) => (entry?.findings ?? []).filter((f: any) => f?.class === cls).length;
      runs.push({ unit: meta.unit, caseId: info.id, arm: meta.arm, repeat: meta.repeat, k, v: count("V"), f: count("F"), u: count("U") });
      const status = unitStatus(study, meta.unit);
      if (status.status !== "completed") out.push(`${info.id} ${meta.unit} (${label}): run ${status.status} (${status.reasons.join("; ")}) -> score.ts analyze would count its scores; here it is left out`);
    }
    const expected = (key ? Object.entries(key).filter(([, entry]) => entry.unit.startsWith(`${info.id}/`)) : []).map(([label]) => label);
    for (const label of expected) if (!(label in entries)) out.push(`${info.id} ${key[label]!.unit} (${label}): no scores entry -> score.ts analyze would drop the run silently; here it is listed as left out`);
  }
  const old = cases.map(info => summarizeCase(info.id, info.kItems, runs));
  for (const [index, result] of results.entries()) {
    const before = old[index]!;
    if (before.saturated !== (result.saturation === true)) out.push(`${result.caseId}: saturation — score.ts semantics ${before.saturated} (A runs present: ${runs.filter(run => run.caseId === result.caseId && run.arm === "A").length}), R2-A1 ${result.saturation} (${result.saturationNote})`);
    for (const arm of ARMS) {
      const list = runs.filter(run => run.caseId === result.caseId && run.arm === arm);
      const vacuous = result.kItems.filter(k => list.every(run => run.k.some(item => item.k === k && found(item))));
      const now = result.reproducibility[arm];
      if (JSON.stringify(now) !== JSON.stringify(vacuous)) out.push(`${result.caseId}/${arm}: reproducibility — score.ts every() gives ${JSON.stringify(vacuous)} over ${list.length} run(s); here ${JSON.stringify(now)}`);
    }
    for (const field of ["bUniqueVsA", "aUniqueVsB", "bUniqueVsC"] as const) if (JSON.stringify(before[field]) !== JSON.stringify(result[field])) out.push(`${result.caseId}: ${field} — score.ts semantics ${JSON.stringify(before[field])}, analysis set ${JSON.stringify(result[field])}`);
  }
  const oldGate = old.length >= 2 ? stopAfterTwo(old[0]!, old[1]!) : undefined;
  const newGate = gateOf(results);
  if (oldGate !== undefined && newGate.applicable && oldGate !== newGate.stop) out.push(`gate — score.ts semantics stop=${oldGate}, R2-A1 stop=${newGate.stop}`);
  const oldVerdict = oldGate ? "not-supported" : verdict(old, runs).verdict;
  const newVerdict = verdictOf(results, newGate).verdict;
  if (oldVerdict !== newVerdict) out.push(`verdict — score.ts semantics ${oldVerdict}, here ${newVerdict}`);
  if (!out.length) out.push("none on these scores");
  return { onTheseScores: out, round1SemanticsOnTheseScores: { ...(oldGate === undefined ? {} : { gateStop: oldGate }), verdict: oldVerdict } };
}

// ---- scorer comparisons ----------------------------------------------------------------------------------------------------------

export interface PacketComparison { caseId: string; label: string; unit: string; a: string; b: string; note?: string; foundDisagreements: { k: string; a: boolean; b: boolean }[]; countDisagreement?: { a: { V: number; F: number; U: number }; b: { V: number; F: number; U: number } } }
/**
 * Per packet: FOUND per known defect and V/F/U counts of two score sets (only where both scored the packet; a packet scored by one
 * only is listed with its statuses). `runNotes` marks the packets of runs that are not completed (e.g. the provider-stopped c2/A/r1).
 * Returns every packet compared and the disagreements.
 */
export function compareScorers(cases: readonly CaseInfo[], key: Record<string, KeyEntry>, a: Record<string, ScorerCase>, b: Record<string, ScorerCase>, packetLabels: Record<string, string[]>, runNotes: Record<string, string> = {}) {
  const packets: PacketComparison[] = [];
  let kCompared = 0, kAgree = 0, countCompared = 0, countAgree = 0;
  for (const info of cases) for (const label of packetLabels[info.id] ?? []) {
    const va = validatePacket(label, a[info.id]?.scores?.packets?.[label], info.kItems), vb = validatePacket(label, b[info.id]?.scores?.packets?.[label], info.kItems);
    const row: PacketComparison = { caseId: info.id, label, unit: key[label]?.unit ?? "?", a: va.status === "scored" ? "scored" : "unscored", b: vb.status === "scored" ? "scored" : "unscored", ...(runNotes[label] ? { note: runNotes[label] } : {}), foundDisagreements: [] };
    if (va.status === "scored" && vb.status === "scored") {
      const ea = a[info.id]!.scores.packets[label], eb = b[info.id]!.scores.packets[label];
      for (const id of info.kItems) {
        const fa = ea.k.find((x: any) => x.k === id), fb = eb.k.find((x: any) => x.k === id);
        const foundA = fa.m === 1 && fa.l === 1, foundB = fb.m === 1 && fb.l === 1;
        kCompared++; if (foundA === foundB) kAgree++; else row.foundDisagreements.push({ k: id, a: foundA, b: foundB });
      }
      countCompared++;
      if (JSON.stringify(va.counts) === JSON.stringify(vb.counts)) countAgree++; else row.countDisagreement = { a: va.counts!, b: vb.counts! };
    }
    packets.push(row);
  }
  return { packets, disagreements: packets.filter(row => row.foundDisagreements.length || row.countDisagreement || row.a !== row.b), totals: { foundCompared: kCompared, foundAgree: kAgree, countsCompared: countCompared, countsAgree: countAgree } };
}

// ---- CLI -------------------------------------------------------------------------------------------------------------------------

const option = (argv: readonly string[], name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const write = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Round-1 scores as score sets (scoring/<case>/scores.json of the round-1 study; scorer was a string there). */
export function loadRound1(dir: string, caseIds: readonly string[]): Record<string, ScorerCase> {
  return Object.fromEntries(caseIds.map(id => { const file = join(resolve(dir), id, "scores.json"); return [id, existsSync(file) ? { scores: json(file), file } : {}]; }));
}

export function main(argv: readonly string[]): number {
  const [command, study, casesDir, scoresRoot] = argv;
  if (command !== "analyze" || !study || !casesDir || !scoresRoot) { console.error("usage: analysis-r2.ts analyze <study> <casesDir> <scoresRoot> [--compare <round1ScoringDir>] [--out <dir>] [--scorers S1,S2]"); return 2; }
  const out = resolve(option(argv, "--out") ?? scoresRoot);
  mkdirSync(out, { recursive: true });
  const scorers = (option(argv, "--scorers") ?? "S1,S2").split(",").filter(Boolean);
  const cases = loadCases(casesDir);
  const key = loadKey(study);
  const index = loadPacketIndex(study);
  const labels = Object.fromEntries(cases.map(info => [info.id, (index[info.id] ?? []).map(item => item.label)]));
  const runNotes = Object.fromEntries(Object.entries(key).flatMap(([label, entry]) => { const status = unitStatus(study, entry.unit); return status.status === "completed" ? [] : [[label, `run ${status.status}: ${status.reasons.join("; ")}`]]; }));
  const analyses: Record<string, Analysis> = {};
  for (const scorer of scorers) {
    analyses[scorer] = analyze(study, casesDir, scoresRoot, scorer);
    write(join(out, `analysis-${scorer}.json`), analyses[scorer]);
    console.log(`${scorer}: verdict ${analyses[scorer]!.result.verdict}${analyses[scorer]!.result.stoppedByRule ? " (stopped by rule)" : ""}; gate ${analyses[scorer]!.gate.applicable ? `stop=${analyses[scorer]!.gate.stop}` : "n/a"}`);
  }
  if (scorers.length >= 2) {
    const [first, second] = [scorers[0]!, scorers[1]!];
    const comparison = compareScorers(cases, key, loadScorer(scoresRoot, first, cases.map(info => info.id)), loadScorer(scoresRoot, second, cases.map(info => info.id)), labels, runNotes);
    const verdicts = { [first]: analyses[first]!.result.verdict, [second]: analyses[second]!.result.verdict };
    write(join(out, `disagreements-${first}-${second}.json`), { generatedAt: new Date().toISOString(), a: first, b: second, verdicts, scorerSensitive: verdicts[first] !== verdicts[second], ...comparison });
    console.log(`${first} vs ${second}: ${comparison.disagreements.length} packet(s) with a disagreement; FOUND agree ${comparison.totals.foundAgree}/${comparison.totals.foundCompared}, V/F/U counts agree ${comparison.totals.countsAgree}/${comparison.totals.countsCompared}; scorer-sensitive ${verdicts[first] !== verdicts[second]}`);
  }
  const compare = option(argv, "--compare");
  if (compare) {
    const round1 = loadRound1(compare, cases.map(info => info.id));
    const agreement = Object.fromEntries(scorers.map(scorer => [scorer, compareScorers(cases, key, loadScorer(scoresRoot, scorer, cases.map(info => info.id)), round1, labels, runNotes)]));
    // The round-1 analysis (score.ts analyze on the round-1 scores) next to these analyses, case by case (descriptive).
    const previous = safeJson(join(resolve(compare), "analysis.json"));
    const caseView = (list: any[]) => Object.fromEntries((list ?? []).map((item: any) => [item.caseId, { foundBy: item.foundBy, bUniqueVsA: item.bUniqueVsA, aUniqueVsB: item.aUniqueVsB, bUniqueVsC: item.bUniqueVsC, saturated: item.saturated ?? item.saturation }]));
    const analyses_ = previous ? {
      round1: { verdict: previous.result?.verdict, stoppedByRule: previous.result?.stoppedByRule, gateStop: previous.gate, cases: caseView(previous.cases) },
      ...Object.fromEntries(scorers.map(scorer => [scorer, { verdict: analyses[scorer]!.result.verdict, stoppedByRule: analyses[scorer]!.result.stoppedByRule, gateStop: analyses[scorer]!.gate.stop, cases: caseView(analyses[scorer]!.cases) }])),
    } : undefined;
    write(join(out, "agreement-round1.json"), { generatedAt: new Date().toISOString(), note: "descriptive only: round-1 scores (claude-opus-5-5 task-manager sub-workers; non-compliant with the model rule) vs the Sol/high scorers; b = round 1", round1: resolve(compare), agreement, ...(analyses_ ? { analyses: analyses_ } : {}) });
    for (const scorer of scorers) console.log(`${scorer} vs round 1: FOUND agree ${agreement[scorer]!.totals.foundAgree}/${agreement[scorer]!.totals.foundCompared}, V/F/U counts agree ${agreement[scorer]!.totals.countsAgree}/${agreement[scorer]!.totals.countsCompared}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
