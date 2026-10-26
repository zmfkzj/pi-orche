/**
 * Bottleneck isolation, ready stages 0-2 (results/bottleneck-isolation/protocol.md).
 *   Experiment 1: the SAME fixed claim pool of each frozen Q ledger is written by the frozen delivery-C writer protocol (gpt-6-astra,
 *     thinking max; compose → mechanical fix ≤1 → fresh audit → local revision → fresh recheck) from the automatic ledger (A) or the
 *     reference-aligned ledger (R, deterministic rules over labeller b), under the historical strong answer's length (one shortening
 *     opportunity, never truncated).
 *   Experiment 2: Tier-1 instruments on the stored complete candidates S and E of each pool; only if an E2-a estimate finds a candidate
 *     better than S does an id-only selector run, and code delivers the chosen candidate's stored bytes (sha256-verified).
 *   node --import tsx experiments/mdsd-ab/bottleneck.ts prepare|preflight|manifest|run|pool-instruments|exp1-instruments|select|status <scratch>
 * Experiment-local: it reuses the delivery runtime (max variant only: pins, provider copy, sandbox, identity guard) and earlier prompts
 * and validators by import, without changing them. Every record is written under results/bottleneck-isolation.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT, NODE, PI_CLI, REPO, sha, write } from "./run.js";
import { Gate, diffOf, numberLines, parseJson, spanFound, treeHashes } from "./synthesis.js";
import { json, text, type Claim } from "./qualification-inputs.js";
import { JUDGE as JUDGE_N, checkJudge } from "./qualification.js";
import { APPROVED, requiredOf, scanText, type Decision, type Ledger, type LedgerEntry } from "./delivery-render.mjs";
import { AUDIT_FIX, COMMON, CONTRACT, C_AUDIT, C_COMPOSE, C_FIX, C_RECHECK, C_REVISE, LEDGERS, PAIR_FIX, RETRY1, TOY, canonicalLedger, checkAudit, checkComposeC, checkPairwise, family, ledgerJson, ledgerOf, promptHashes as deliveryPromptHashes, targetHashes, type LedgerId } from "./delivery.js";
import { GUARDS, INPUT_ROOT, JUDGES, MODEL, PINS, PROVIDER, VARIANT, checkPins, freezePins, outputOf, providerHashes, retainSession, setStudy, setup, sourceHashes, studyDir, turn, type Turn } from "./delivery-runtime.js";

export const BI = join(REPO, "results/bottleneck-isolation");
/** Every model turn of this study (writer, auditor, judges, selector) runs at thinking max: the plan's configuration, not a variant. */
export const EFFORT = "max";
/** The study runner's own hash (drives every model turn; frozen in the manifest). The evaluation module is frozen separately (addendum). */
export const runnerSha256 = () => sha(readFileSync(fileURLToPath(import.meta.url)));
export const UNITS = ["dev-r1", "isort-r1", "isort-r2"] as const;
export type Unit = (typeof UNITS)[number];
export type ArmBI = "A" | "R";
export const ARMS_BI: ArmBI[] = ["A", "R"];
export const REPS_BI = [1, 2] as const;
export const EXP1 = LEDGERS.map(l => l.id);
export const unitOf = (ledger: string): Unit => LEDGERS.find(l => l.id === ledger)!.unit as Unit;
export const FAMS = ["claude", "gpt"] as const;
export type Fam = (typeof FAMS)[number];
export const modelOf = (f: Fam) => JUDGES.find(m => family(m) === f)!;
/** Length unit: Unicode code points (the historical strong answer's own count; identical to UTF-16 units for these texts). */
export const chars = (s: string) => [...s].length;
export const S_ANSWER = (unit: string) => join(REPO, "results/quality-validation", unit, "X-S/answer.md");
export const E_ANSWER = (unit: string) => join(REPO, "results/quality-validation", unit, "X-E/answer.md");
/** Caps = code points of the stored S answer of the ledger's pool (verified again at prepare). */
export const CAP: Record<string, number> = { "dev-r1": 43700, "isort-r1": 58768 };
export const DISPUTED: Record<string, string[]> = { "dev-r1": ["k120"], "isort-r1": ["k90", "k106"], "isort-r2": [] };

// ---- prompts (hashed in the manifest; the writer's are the frozen delivery-C prompts plus ONE length sentence and the shortening turn) ----
export const CAP_SENTENCE = "Length limit: final.md must be at most {CAP} characters long (Unicode characters, counting spaces, line breaks and Markdown syntax).";
export const SHORTEN = "/tmp/pi-orche/work/final.md has {N} characters, more than the length limit of {CAP} characters. Shorten it to at most {CAP} characters: tighten wording, remove repetition and merge overlapping passages. The delivery contract still applies. Reply with a short note when done.";
export const composePromptBI = (cap: number) => [COMMON, C_COMPOSE, CAP_SENTENCE.replace("{CAP}", String(cap)), CONTRACT].join("\n\n");
export const auditPromptBI = () => [COMMON, C_AUDIT, CONTRACT].join("\n\n");
export const recheckPromptBI = () => [COMMON, C_RECHECK, CONTRACT].join("\n\n");
export const shortenPrompt = (n: number, cap: number) => SHORTEN.replace("{N}", String(n)).replaceAll("{CAP}", String(cap));
export const JUDGE_N_FIX = "Fix only the JSON/schema/quote issues in judgment.json. Same semantic criteria.\n{ERRORS}";
export const PAIR_U = [
  "You compare two answers to the same task, for an evaluation. Files in /tmp/pi-orche/input: task.md (the task), guide.md (its interpretation), answer-X.md and answer-Y.md (two complete answers to it). Read both completely.",
  "Do not try to verify facts (no repository is available). Judge usefulness to the user who asked the task: does it answer the task directly; organization; readability; clarity of what is established, uncertain or corrected; concision and redundancy. Length alone is neither good nor bad.",
  "Write /tmp/pi-orche/work/pairwise.json: {\"overall\":\"X|Y|tie\",\"criteria\":{\"answersTask\":\"X|Y|tie\",\"organization\":\"X|Y|tie\",\"readability\":\"X|Y|tie\",\"statusClarity\":\"X|Y|tie\",\"concision\":\"X|Y|tie\"},\"reasons\":\"...\",\"problemsX\":[\"...\"],\"problemsY\":[\"...\"]}. Reply \"done\" when the file is written.",
].join("\n");
export const RUBRIC = [
  "You score one answer against an evaluator-only reference rubric, for an evaluation. Files in /tmp/pi-orche/input: task.md (the task), guide.md (its interpretation), rubric.md (reference items established after the answer was written, from later fixes and tests; the criteria to score are listed at its end) and text.md (the FULL answer; every line starts with \"L<n>: \", which is not part of the text).",
  "Read the whole text first (several reads with offset when long). Summary, body and appendix count equally; decide that a criterion is not met only after reading everything.",
  "For EVERY criterion listed at the end of rubric.md give one item: credit 1 if the text states what the criterion requires correctly, in any wording (a hedged but correct statement counts; a statement that contradicts the rubric does not), else 0; quotes: verbatim excerpts of the text (5 to 60 words, without the line prefix) with their line numbers (required for credit 1); note.",
  "Then list contradictions: every passage of the text that asserts something the rubric's reference facts contradict (criterion: the rubric item, e.g. K4 or C2; quote; lines; why).",
  "Judge only what the rubric covers; do not score other claims, style or length.",
  "Write /tmp/pi-orche/work/rubric.json: {\"criteria\":[{\"id\":\"K1.mechanism\",\"credit\":1,\"quotes\":[{\"line\":12,\"quote\":\"verbatim text\"}],\"note\":\"...\"}],\"contradictions\":[{\"criterion\":\"K4\",\"quote\":\"verbatim text\",\"lines\":[30],\"why\":\"...\"}]}. Exactly one item per listed criterion. Reply \"done\" when the file is written.",
].join("\n");
export const RUBRIC_FIX = "/tmp/pi-orche/work/rubric.json is not usable:\n{ERRORS}\nFix it (one item per listed criterion id, credit 0 or 1, quotes copied verbatim from the text without line prefixes). Same judgment. Reply \"done\" when the file is written.";
export const SELECT = [
  "You choose which of two complete answers to the task is delivered to the user. The chosen answer is delivered exactly as it is: you cannot edit, merge, shorten or annotate it.",
  "Files in /tmp/pi-orche/input (read-only): task.md (the task), guide.md (its interpretation), candidate-1.md and candidate-2.md (two complete answers written independently by earlier analyses), doc-A-evidence.jsonl, doc-B-evidence.jsonl and evidence-index.json (the frozen tool evidence of those analyses; each answer refers to its own evidence by its alias). The working directory holds a read-only copy of the analysed code snapshot: you may read it and run read-only checks, but do not modify it. Use /tmp/pi-orche/tmp for scratch files. Do not use the network.",
  "Choose the answer that serves the asking user better: first, avoid wrong or overstated claims about the code; then, cover what the task asks; then, usefulness (directness, organization, clarity of what is established or uncertain).",
  "Write /tmp/pi-orche/work/selection.json containing exactly {\"candidate_id\":\"candidate-1\"} or {\"candidate_id\":\"candidate-2\"} and nothing else. Reply \"done\" when the file is written.",
].join("\n");
export const SELECT_FIX = "/tmp/pi-orche/work/selection.json is not usable:\n{ERRORS}\nWrite exactly {\"candidate_id\":\"candidate-1\"} or {\"candidate_id\":\"candidate-2\"} (your choice, unchanged). Reply \"done\" when the file is written.";
export const prompts = { CAP_SENTENCE, SHORTEN, JUDGE_N, JUDGE_N_FIX, PAIR_U, PAIR_FIX, RUBRIC, RUBRIC_FIX, SELECT, SELECT_FIX };
export const promptHashes = (): Record<string, string> => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, sha(v)]));
/** The delivery-C prompts this study reuses verbatim (their hashes must equal the completed max study's manifest). */
export const WRITER_REUSED = ["COMMON", "CONTRACT", "C_COMPOSE", "C_AUDIT", "C_REVISE", "C_RECHECK", "C_FIX", "AUDIT_FIX", "PAIR_FIX"];

// ---- validators ---------------------------------------------------------------------------------------------------------------------------
const quoteIn = (q: unknown, body: string) => typeof q === "string" && q.trim().length > 0 && (body.includes(q.trim()) || spanFound(q, body, 3));
export function checkRubric(ids: string[], value: any, body: string): string[] {
  if (!value || typeof value !== "object" || !Array.isArray(value.criteria) || !Array.isArray(value.contradictions)) return ["rubric.json needs criteria and contradictions arrays"];
  const errors: string[] = [], seen = new Set<string>(), bases = new Set(ids.map(i => i.split(".")[0]!));
  for (const c of value.criteria) {
    if (!ids.includes(c?.id) || seen.has(c?.id)) { errors.push(`unknown or repeated criterion ${String(c?.id)}`); continue; }
    seen.add(c.id);
    if (c.credit !== 0 && c.credit !== 1) errors.push(`${c.id}: credit must be 0 or 1`);
    const quotes = Array.isArray(c.quotes) ? c.quotes : [];
    if (c.credit === 1 && !quotes.length) errors.push(`${c.id}: credit 1 needs at least one verbatim quote`);
    quotes.forEach((q: any, n: number) => { if (!quoteIn(q?.quote, body)) errors.push(`${c.id}: quote ${n + 1} not found verbatim`); });
  }
  const missing = ids.filter(i => !seen.has(i));
  if (missing.length) errors.push(`criteria without an item: ${missing.join(", ")}`);
  value.contradictions.forEach((x: any, n: number) => { if (!bases.has(String(x?.criterion).split(".")[0]!)) errors.push(`contradiction ${n + 1}: criterion must name a rubric item (${[...bases].join(", ")})`); if (!quoteIn(x?.quote, body)) errors.push(`contradiction ${n + 1}: quote not found verbatim`); });
  return errors;
}
export const CANDIDATE_IDS = ["candidate-1", "candidate-2"];
export function checkSelection(raw: string): string[] {
  let v: any;
  try { v = JSON.parse(raw); } catch { return ["selection.json is missing or not valid JSON"]; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["selection.json must be a JSON object"];
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "candidate_id") return ["selection.json must contain exactly one key, candidate_id"];
  return CANDIDATE_IDS.includes(v.candidate_id) ? [] : ["candidate_id must be candidate-1 or candidate-2"];
}

// ---- reference-aligned ledger R (protocol §3; deterministic, frozen before any output) ------------------------------------------------
export interface BRef { id: string; support: string; relevance: string; salience: string; equivalentTo: string[] }
export type Rule = "disputed-reference" | "refuted-kept-correct" | "refuted" | "insufficient" | "out" | "ambiguous" | "duplicate-kept" | "relevant";
export type Priority = "essential" | "context" | "detail" | "unassessed";
export type EntryBI = LedgerEntry & { priority: Priority };
export interface LedgerBI { ledger: string; entries: EntryBI[] }
/** Precedence: disputed reference → refuted (kept only if Q already corrected it) → insufficient/conflicting → out → ambiguous → relevant (duplicate kept only if b lists an equivalent AND Q marked it duplicate). */
export function rDecision(e: Pick<LedgerEntry, "id" | "decision">, r: BRef, disputed: string[]): { decision: Decision; rule: Rule } {
  if (disputed.includes(e.id)) return { decision: "uncertain", rule: "disputed-reference" };
  if (r.support === "refuted") return e.decision === "correct" ? { decision: "correct", rule: "refuted-kept-correct" } : { decision: "exclude", rule: "refuted" };
  if (r.support === "insufficient" || r.support === "conflicting") return { decision: "uncertain", rule: "insufficient" };
  if (r.relevance === "out") return { decision: "exclude", rule: "out" };
  if (r.relevance === "ambiguous") return { decision: "uncertain", rule: "ambiguous" };
  if (e.decision === "duplicate" && (r.equivalentTo ?? []).length > 0) return { decision: "duplicate", rule: "duplicate-kept" };
  return { decision: "include", rule: "relevant" };
}
/** Fixed neutral replacements of Q's rationale for entries whose decision changes (no labeller-b basis text, no hidden-test paths). */
export const NOTE_TEMPLATE: Record<string, string> = {
  "disputed-reference": "Decision record: readings of this statement conflict; it is not established as worded.",
  insufficient: "Decision record: support for this statement is {support}; it is not established as worded.",
  ambiguous: "Decision record: whether this statement is within the task's scope is open.",
  refuted: "Decision record: the statement is not accurate as worded; excluded from the answer.",
  out: "Decision record: outside the task's scope; excluded from the answer.",
};
export const EVIDENCE_TEMPLATE = "Support label: {support} (no further rationale recorded).";
export const TASKLINK_TEMPLATE = "Relevance label: {relevance} (no further rationale recorded).";
/** Fields that must be byte-identical between A and R (and in the same order): the claim pool itself. */
export const PROTECTED = ["id", "statement", "sourceStance", "conditions", "locations", "quote"] as const;
export function buildArms(base: Ledger, refs: Map<string, BRef>, disputed: string[]): { A: LedgerBI; R: LedgerBI; rows: any[] } {
  const ids = base.entries.map(e => e.id);
  if (ids.length !== refs.size || ids.some(id => !refs.has(id))) throw new Error(`${base.ledger}: reference ids do not match the ledger ids`);
  const rows: any[] = [];
  const A: LedgerBI = { ledger: base.ledger, entries: base.entries.map(e => ({ ...e, priority: "unassessed" as Priority })) };
  const R: LedgerBI = { ledger: base.ledger, entries: base.entries.map(e => {
    const r = refs.get(e.id)!, d = rDecision(e, r, disputed), changed = d.decision !== e.decision;
    const support = d.rule === "disputed-reference" ? "conflicting" : r.support;
    const note = !changed ? e.note : d.decision === "include" || d.decision === "duplicate" ? "" : NOTE_TEMPLATE[d.rule]!.replace("{support}", support);
    const evidence = changed && e.support !== support ? EVIDENCE_TEMPLATE.replace("{support}", support) : e.evidence;
    const taskLink = changed && e.relevance !== r.relevance ? TASKLINK_TEMPLATE.replace("{relevance}", r.relevance) : e.taskLink;
    const out: EntryBI = { ...e, decision: d.decision, support, relevance: r.relevance, note, duplicateOf: d.decision === "duplicate" ? e.duplicateOf : null, evidence, taskLink, priority: (r.salience as Priority) };
    out.required = requiredOf(out);
    rows.push({ id: e.id, rule: d.rule, from: e.decision, to: d.decision, changed, salience: r.salience, support: { q: e.support, r: support }, relevance: { q: e.relevance, r: r.relevance }, noteReplaced: out.note !== e.note, evidenceReplaced: out.evidence !== e.evidence, taskLinkReplaced: out.taskLink !== e.taskLink, requiredChanged: out.required !== e.required });
    return out;
  }) };
  return { A, R, rows };
}
export function ledgerMarkdownBI(l: LedgerBI): string {
  const out = [`# Frozen decision ledger \`${l.ledger}\`: ${l.entries.length} entries`, "", "Every entry has exactly one decision: include, uncertain, correct, duplicate or exclude. \"Required\" is the delivery every answer must give the entry. \"Priority\" is the entry's importance for the answer (essential, context or detail), or unassessed. ledger.json holds the same entries plus background fields (evidence, taskLink, quote).", ""];
  for (const e of l.entries) {
    out.push(`## ${e.id} — ${e.decision}`, `- Required: ${e.required}`, `- Statement: ${e.statement}`, `- Source stance: ${e.sourceStance} · Support: ${e.support} · Relevance: ${e.relevance} · Priority: ${e.priority}`);
    for (const c of e.conditions) out.push(`- Condition/limit: ${c}`);
    if (e.note) out.push(`- Note: ${e.note}`);
    if (e.duplicateOf) out.push(`- Duplicate of: ${e.duplicateOf}`);
    if (e.locations.length) out.push(`- Cited: ${e.locations.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}
/** Machine-readable difference between the A and R packets of one ledger (decisions, derived fields, templates, priorities, bytes). */
export function packetDiff(A: LedgerBI, R: LedgerBI, rows: any[], files: { A: Record<string, string>; R: Record<string, string>; original: Record<string, string> }): any {
  const count = (f: (r: any) => boolean) => rows.filter(f).length;
  const tally = (xs: string[]) => xs.reduce((acc: Record<string, number>, x) => { acc[x] = (acc[x] ?? 0) + 1; return acc; }, {});
  const protectedSame = A.entries.length === R.entries.length && A.entries.every((a, i) => PROTECTED.every(k => JSON.stringify(a[k]) === JSON.stringify(R.entries[i]![k])));
  const keyOrderSame = A.entries.every((a, i) => JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(R.entries[i]!)));
  const byId = new Map(R.entries.map(e => [e.id, e]));
  return {
    ledger: A.ledger, entries: A.entries.length, protectedFieldsIdentical: protectedSame, protectedFields: PROTECTED, keyOrderIdentical: keyOrderSame,
    decisions: { A: tally(A.entries.map(e => e.decision)), R: tally(R.entries.map(e => e.decision)) },
    changed: count(r => r.changed), changedEssential: count(r => r.changed && r.salience === "essential"), transitions: tally(rows.filter(r => r.changed).map(r => `${r.from}->${r.to}`)), rules: tally(rows.map(r => r.rule)),
    changedIds: Object.fromEntries(Object.entries(rows.filter(r => r.changed).reduce((acc: Record<string, string[]>, r) => { (acc[`${r.from}->${r.to}`] ??= []).push(r.id); return acc; }, {}))),
    derived: { requiredChanged: count(r => r.requiredChanged), noteTemplates: count(r => r.noteReplaced), evidenceTemplates: count(r => r.evidenceReplaced), taskLinkTemplates: count(r => r.taskLinkReplaced), supportLabelDiffers: count(r => r.support.q !== r.support.r), relevanceLabelDiffers: count(r => r.relevance.q !== r.relevance.r) },
    priority: { A: tally(A.entries.map(e => e.priority)), R: tally(R.entries.map(e => e.priority)) },
    duplicatesToNonApproved: R.entries.filter(e => e.decision === "duplicate" && !APPROVED.includes(byId.get(e.duplicateOf!)?.decision as Decision)).map(e => e.id),
    bytes: Object.fromEntries(["ledger.json", "ledger.md"].map(n => [n, { original: Buffer.byteLength(files.original[n] ?? ""), A: Buffer.byteLength(files.A[n]!), R: Buffer.byteLength(files.R[n]!) }])),
    sha256: { A: Object.fromEntries(Object.entries(files.A).map(([n, b]) => [n, sha(b)])), R: Object.fromEntries(Object.entries(files.R).map(([n, b]) => [n, sha(b)])), original: Object.fromEntries(Object.entries(files.original).map(([n, b]) => [n, sha(b)])) },
    package: "decision changes + b support/relevance labels on every entry + b salience as priority + neutral templates replacing Q's rationale (note always; evidence/taskLink when the support/relevance label differs) on changed entries + recomputed required delivery; the effect is attributed to this package, not to decisions alone",
    rows,
  };
}
export const refsOf = (unit: string): Map<string, BRef> => new Map<string, BRef>(json(join(RETRY1, "references", `${unit}-b.json`)).items.map((v: any) => [v.id, v]));
export const armPacketDir = (ledger: string, arm: ArmBI) => join(BI, "exp1/packets", ledger, arm);
export const packetFiles = (ledger: string, arm: ArmBI): Record<string, string> => Object.fromEntries(["task.md", "guide.md", "ledger.json", "ledger.md"].map(n => [n, text(join(armPacketDir(ledger, arm), n))]));
export const armLedger = (ledger: string, arm: ArmBI): LedgerBI => json(join(armPacketDir(ledger, arm), "ledger.json"));

// ---- texts, rubrics, comparisons, candidates ---------------------------------------------------------------------------------------------
export const retry1Input = (unit: string, file: string) => join(RETRY1, "inputs", unit, file);
export const sDoc = (unit: string): "doc-A" | "doc-B" => json(join(RETRY1, "keys", `${unit}.json`)).base;
export const eDoc = (unit: string): "doc-A" | "doc-B" => sDoc(unit) === "doc-A" ? "doc-B" : "doc-A";
export const claimsOfUnit = (unit: string): Claim[] => json(retry1Input(unit, "claims.json")).claims;
export const statementsJson = (unit: string) => JSON.stringify({ statements: claimsOfUnit(unit).map(x => ({ id: x.ref, statement: x.claim, stance: x.stance })) });
/** Text keys: exp1:<ledger>/<arm>-r<k> (a writer final) and pool:<unit>/<S|E> (the source-neutral copy of a stored candidate). */
export const EXP1_TEXTS = EXP1.flatMap(l => REPS_BI.flatMap(rep => ARMS_BI.map(arm => `exp1:${l}/${arm}-r${rep}`)));
export const POOL_TEXTS = UNITS.flatMap(u => [`pool:${u}/S`, `pool:${u}/E`]);
export function textInfo(key: string): { unit: Unit; ledger?: string; arm?: ArmBI | "S" | "E"; rep?: number; path: string } {
  const [kind, rest] = key.split(":") as [string, string];
  if (kind === "pool") { const [unit, which] = rest.split("/") as [Unit, "S" | "E"]; return { unit, arm: which, path: retry1Input(unit, `${which === "S" ? sDoc(unit) : eDoc(unit)}.md`) }; }
  const [ledger, label] = rest.split("/") as [string, string];
  return { unit: unitOf(ledger), ledger, arm: label[0] as ArmBI, rep: Number(label.slice(3)), path: join(BI, "exp1/runs", ledger, label, "final/final.md") };
}
/** The text an instrument sees; a writer final only once its cell is complete with a deliverable (otherwise undefined: never judged). */
export function textOf(key: string): string | undefined {
  const t = textInfo(key);
  if (key.startsWith("pool:")) return text(t.path);
  const p = join(BI, "exp1/runs", t.ledger!, `${t.arm}-r${t.rep}`, "pipeline.json");
  if (!existsSync(p)) return undefined;
  const pipe = json(p);
  return pipe.status === "complete" && pipe.deliverable !== false && existsSync(t.path) ? text(t.path) : undefined;
}
export const RUBRIC_SOURCES: Record<"dev" | "isort", { file: string; from: string; to: string; criteria: string[] }> = {
  dev: { file: "results/mdsd-ab/r1/rubric.md", from: "## Known references K1–K4", to: "## Additional findings", criteria: ["K1", "K2", "K3", "K4"].flatMap(k => ["mechanism", "location", "scenario"].map(c => `${k}.${c}`)) },
  isort: { file: "results/quality-validation/rubric-isort.md", from: "# Rubric for the held-out isort case", to: "## Other claims", criteria: [...["mechanism", "location", "scenario"].map(c => `K-I1.${c}`), "C1", "C2", "C3", "C4", "C5"] },
};
export const caseOf = (unit: string): "dev" | "isort" => unit.startsWith("dev") ? "dev" : "isort";
export function rubricPacket(unit: string): { body: string; criteria: string[] } {
  const src = RUBRIC_SOURCES[caseOf(unit)], all = text(join(REPO, src.file)), start = all.indexOf(src.from), end = all.indexOf(src.to);
  if (start < 0 || end <= start) throw new Error(`${src.file}: rubric section markers not found`);
  const excerpt = all.slice(start, end).trimEnd();
  const scoring = caseOf(unit) === "dev"
    ? "Each reference K has three criteria: <K>.mechanism (the causal explanation, not just the area), <K>.location (the right file and function, or a line within ±25 lines at the snapshot) and <K>.scenario (a concrete sequence that produces the wrong outcome; reproduction not required)."
    : "K-I1 has three criteria: K-I1.mechanism, K-I1.location (within ±25 lines of base output.py:428–453, in _with_from_imports' as-import handling) and K-I1.scenario (the reported input or an equivalent failing scenario). C1–C5 score 1 each when the answer states the condition correctly, as something a complete fix must handle or as a correct boundary.";
  return { body: `# Evaluator-only reference rubric (verbatim excerpt of ${src.file})\n\n${excerpt}\n\n## Criteria to score (one item each)\n\n${scoring}\n\n${src.criteria.map(c => `- ${c}`).join("\n")}\n`, criteria: src.criteria };
}
export interface Comparison { id: string; kind: "A-R" | "repeat-A" | "repeat-R" | "vs-S" | "S-E"; context: string; P: string; Q: string }
export function comparisons(): Comparison[] {
  const out: Comparison[] = [];
  for (const l of EXP1) {
    const t = (arm: string, rep: number) => `exp1:${l}/${arm}-r${rep}`, s = `pool:${unitOf(l)}/S`;
    for (const rep of REPS_BI) out.push({ id: `AR.${l}.r${rep}`, kind: "A-R", context: l, P: t("A", rep), Q: t("R", rep) });
    for (const arm of ARMS_BI) out.push({ id: `RP${arm}.${l}`, kind: arm === "A" ? "repeat-A" : "repeat-R", context: l, P: t(arm, 1), Q: t(arm, 2) });
    for (const rep of REPS_BI) for (const arm of ARMS_BI) out.push({ id: `S.${l}.${arm}-r${rep}`, kind: "vs-S", context: l, P: t(arm, rep), Q: s });
  }
  for (const u of UNITS) out.push({ id: `SE.${u}`, kind: "S-E", context: u, P: `pool:${u}/S`, Q: `pool:${u}/E` });
  return out;
}
/** Every comparison is judged by BOTH families in BOTH orders (o1: X = P; o2: X = Q). */
export const pairJobs = () => comparisons().flatMap(c => FAMS.flatMap(f => [1, 2].map(o => ({ key: `${c.id}.${f}.o${o}`, comparison: c, fam: f, order: o, X: o === 1 ? c.P : c.Q, Y: o === 1 ? c.Q : c.P }))));
/** Selector orders: o1 shows S first, o2 shows E first; two repetitions each. */
export const SELECT_JOBS = UNITS.flatMap(u => [1, 2].flatMap(o => REPS_BI.map(rep => ({ key: `${u}.o${o}.r${rep}`, unit: u, order: o, rep, candidates: (o === 1 ? ["S", "E"] : ["E", "S"]) as ("S" | "E")[] }))));

// ---- runner utilities --------------------------------------------------------------------------------------------------------------------
class TechnicalFailure extends Error { constructor(readonly stage: string, readonly detail: string) { super(`${stage}: ${detail}`); } }
const summary = (stage: string, t: Turn) => ({ stage, label: t.label, number: t.number, ok: t.ok, technical: t.technical, finalStop: t.finalStop, ms: t.ms, wireUSD: t.wire?.costUSD, requests: t.wire?.requests, unknownUsage: t.wire?.unknownUsage, interrupted: t.interrupted ?? false, record: t.record?.slice(BI.length + 1) });
async function freezeDir(dir: string, files: Record<string, string>, extra: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  await write(join(dir, "frozen.json"), { at: new Date().toISOString(), ...extra, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)])) });
}
/** A frozen directory is reused only when every file still has its frozen hash. */
export function verifyFrozen(dir: string): void {
  const f = json(join(dir, "frozen.json"));
  for (const [name, hash] of Object.entries<string>(f.files)) if (!existsSync(join(dir, name)) || sha(readFileSync(join(dir, name))) !== hash) throw new Error(`frozen file changed: ${dir}/${name}`);
}
/** Error signature of a technical failure (stage + message with numbers and paths blanked) for the identical-error stop rule. */
export const signatureOf = (failure: string) => failure.replace(/\/[^\s:;]+/g, "<path>").replace(/\d+/g, "#").slice(0, 120);
/** Stop rule (protocol §6): three identical error signatures, or more than 25% of started attempts failed technically (≥ 4 started). */
export function stopReason(attempts: { outcome?: string; signature?: string }[]): string | undefined {
  const failed = attempts.filter(a => a.outcome === "technical"), started = attempts.length;
  const bySig = failed.reduce((acc: Record<string, number>, a) => { acc[a.signature!] = (acc[a.signature!] ?? 0) + 1; return acc; }, {});
  const repeated = Object.entries(bySig).find(([, n]) => n >= 3);
  if (repeated) return `identical technical error signature ${repeated[1]} times: ${repeated[0]}`;
  if (started >= 4 && failed.length / started > 0.25) return `technical failures ${failed.length}/${started} started attempts exceed 25%`;
  return undefined;
}
/** Persistent dispatch state of one stage (exp1/dispatch.json): every attempt start/end, the first-cell gate and a stop. */
export class Dispatch {
  private chain = Promise.resolve();
  constructor(readonly file: string, public state: any = existsSync(file) ? json(file) : { attempts: [], gate: undefined, stopped: undefined }) {}
  save(): Promise<void> { this.chain = this.chain.then(() => write(this.file, this.state)); return this.chain; }
  stop(): string | undefined { return this.state.stopped ?? stopReason(this.state.attempts); }
  async started(cell: string, attempt: number): Promise<void> { const prior = this.state.attempts.find((a: any) => a.cell === cell && a.attempt === attempt); if (prior) { prior.resumedAt = [...(prior.resumedAt ?? []), new Date().toISOString()]; } else this.state.attempts.push({ cell, attempt, startedAt: new Date().toISOString() }); await this.save(); }
  async ended(cell: string, attempt: number, outcome: "complete" | "technical", failure?: string): Promise<void> { const a = this.state.attempts.find((x: any) => x.cell === cell && x.attempt === attempt); Object.assign(a, { endedAt: new Date().toISOString(), outcome, ...(failure ? { failure, signature: signatureOf(failure) } : {}) }); await this.save(); }
}

// ---- Experiment 1 cells (protocol §4-§6) -------------------------------------------------------------------------------------------------
export interface CellPaths { id: string; scratch: string; record: string }
/** promptCap exists only for the toy preflight: the compose prompt states it while the length step enforces `cap` (forces the shortening turn). */
export interface CellSpec { ledger: string; arm: ArmBI; rep: number; cap: number; packet: Record<string, string>; ledgerObj: LedgerBI; label: string; scratchRoot: string; recordRoot: string; promptCap?: number }
export const cellSpec = (ledger: string, arm: ArmBI, rep: number): CellSpec => ({ ledger, arm, rep, cap: CAP[unitOf(ledger)]!, packet: packetFiles(ledger, arm), ledgerObj: armLedger(ledger, arm), label: `bi-${ledger}-${arm}-r${rep}`, scratchRoot: join(studyDir(), "exp1", ledger, `${arm}-r${rep}`), recordRoot: join(BI, "exp1/runs", ledger, `${arm}-r${rep}`) });
export interface GateResult { ok: boolean; reason: string; chars?: number; routeOk?: boolean; inputsUnchanged?: boolean }
/**
 * One attempt: compose (+≤1 fix) → audit (+≤1 schema fix) → local revision (+≤1 fix) → ONE shortening opportunity if the final is over
 * the cap (+≤1 fix; every branch, including an unusable audit) → recheck of the delivered bytes (+≤1 schema fix). Never truncates.
 */
export async function attemptCell(c: CellSpec, n: number, onComposed?: (g: GateResult) => void): Promise<any> {
  const id = `${c.label}-a${n}`, scratch = join(c.scratchRoot, `a${n}`), record = join(c.recordRoot, `a${n}`);
  const out: any = { attempt: n, startedAt: new Date().toISOString(), cap: c.cap, stages: [] };
  let composer = 0, gateReported = false;
  const gate = (g: GateResult) => { if (!gateReported) { gateReported = true; onComposed?.(g); } };
  const call = async (stage: string, session: "compose" | "audit" | "recheck", number: number, prompt: string, inputs: Record<string, string>, guard: number) => {
    const t = await turn({ session: join(scratch, session), record: join(record, session), label: `${id}-${session}`, number, model: MODEL, effort: EFFORT, prompt, inputs, guard });
    out.stages.push(summary(stage, t));
    if (!t.ok) throw new TechnicalFailure(stage, t.technical.join("; "));
    return t;
  };
  const fix = (errors: string[]) => C_FIX.replace("{ERRORS}", errors.join("\n"));
  try {
    let t = await call("compose", "compose", ++composer, composePromptBI(c.promptCap ?? c.cap), c.packet, GUARDS.compose);
    let errors = checkComposeC(outputOf(t, "final.md"));
    if (errors.length) { t = await call("compose-fix", "compose", ++composer, fix(errors), {}, GUARDS.fix); errors = checkComposeC(outputOf(t, "final.md")); }
    const draft = outputOf(t, "final.md"), notes = outputOf(t, "notes.md");
    gate({ ok: !!draft.trim() && t.routeOk && t.inputsAfter?.unchanged !== false, reason: draft.trim() ? "compose ok" : "no final.md after the fix", chars: chars(draft), routeOk: t.routeOk, inputsUnchanged: t.inputsAfter?.unchanged });
    out.composeErrors = errors; out.draftChars = chars(draft); out.deliverable = !!draft.trim();
    await freezeDir(join(record, "draft"), { "final.md": draft, ...(notes ? { "notes.md": notes } : {}) }, { errors, chars: chars(draft) });
    if (!out.deliverable) { out.outcome = "no deliverable after the fix continuation (measured failure)"; out.files = { "final.md": "" }; return out; }
    let final = draft, auditBody = "", reviseNote = "";
    let a = await call("audit", "audit", 1, auditPromptBI(), { ...c.packet, "final.md": draft }, GUARDS.audit);
    auditBody = outputOf(a, "audit.json");
    let auditErrors = checkAudit(parseJson(auditBody));
    if (auditErrors.length) { a = await call("audit-fix", "audit", 2, AUDIT_FIX.replace("{ERRORS}", auditErrors.join("\n")), {}, GUARDS.fix); auditBody = outputOf(a, "audit.json"); auditErrors = checkAudit(parseJson(auditBody)); }
    out.auditErrors = auditErrors; out.reviewAvailable = auditErrors.length === 0;
    if (out.reviewAvailable) {
      t = await call("revise", "compose", ++composer, C_REVISE, { "audit-1.json": auditBody }, GUARDS.revise);
      reviseNote = t.reply; errors = checkComposeC(outputOf(t, "final.md"));
      if (errors.length) { t = await call("revise-fix", "compose", ++composer, fix(errors), {}, GUARDS.fix); errors = checkComposeC(outputOf(t, "final.md")); }
      const revised = outputOf(t, "final.md");
      if (revised.trim()) final = revised; else out.revisionEmpty = true;
      out.reviseErrors = errors;
    }
    out.preShortenChars = chars(final); out.shortened = false;
    let shortenNote = "";
    if (chars(final) > c.cap) {
      out.shortened = true;
      t = await call("shorten", "compose", ++composer, shortenPrompt(chars(final), c.cap), {}, GUARDS.revise);
      shortenNote = t.reply; errors = checkComposeC(outputOf(t, "final.md"));
      if (errors.length) { t = await call("shorten-fix", "compose", ++composer, fix(errors), {}, GUARDS.fix); errors = checkComposeC(outputOf(t, "final.md")); }
      const shortened = outputOf(t, "final.md");
      if (shortened.trim()) final = shortened; else out.shortenEmpty = true;
      out.shortenErrors = errors;
    }
    out.finalChars = chars(final); out.overCap = out.finalChars > c.cap;
    const finalNotes = outputOf(t, "notes.md");
    const files: Record<string, string> = { "final.md": final, ...(finalNotes ? { "notes.md": finalNotes } : {}), "scan.json": `${JSON.stringify(scanText(c.ledgerObj, final), null, 1)}\n`, "length.json": `${JSON.stringify({ unit: "unicode code points", cap: c.cap, draftChars: out.draftChars, preShortenChars: out.preShortenChars, shortened: out.shortened, finalChars: out.finalChars, overCap: out.overCap }, null, 1)}\n` };
    if (out.reviewAvailable) {
      const diff = diffOf(draft, final, scratch), note = shortenNote ? `${reviseNote}\n\n[Length-limit shortening]\n${shortenNote}` : reviseNote;
      const r = await call("recheck", "recheck", 1, recheckPromptBI(), { ...c.packet, "final.md": final, "audit-1.json": auditBody, "revision.diff": diff, "revision-note.md": note }, GUARDS.recheck);
      let recheck = outputOf(r, "audit.json"), recheckErrors = checkAudit(parseJson(recheck));
      if (recheckErrors.length) { const r2 = await call("recheck-fix", "recheck", 2, AUDIT_FIX.replace("{ERRORS}", recheckErrors.join("\n")), {}, GUARDS.fix); recheck = outputOf(r2, "audit.json"); recheckErrors = checkAudit(parseJson(recheck)); }
      out.recheckErrors = recheckErrors;
      Object.assign(files, { "audit-1.json": auditBody, "recheck.json": recheck, "revision.diff": diff, "revision-note.md": note });
      out.outcome = "complete";
    } else {
      Object.assign(files, { "audit-1.json": auditBody });
      out.outcome = "review unavailable (unusable audit after its fix): final = draft (after the length step)";
    }
    out.files = files;
    return out;
  } catch (e) {
    out.technicalFailure = e instanceof TechnicalFailure ? e.message : `harness: ${String(e).slice(0, 400)}`;
    return out;
  } finally {
    out.endedAt = new Date().toISOString();
    for (const s of ["compose", "audit", "recheck"]) await retainSession(join(scratch, s), join(record, s));
  }
}
/** One cell: attempt 1, and ONE re-execution from the start after a technical failure if the stop rule allows it. */
export async function cell(c: CellSpec, d: Dispatch, onComposed?: (g: GateResult) => void): Promise<void> {
  const cellId = `${c.ledger}/${c.arm}-r${c.rep}`;
  if (existsSync(join(c.recordRoot, "pipeline.json"))) { const p = json(join(c.recordRoot, "pipeline.json")); if (p.status === "complete") verifyFrozen(join(c.recordRoot, "final")); onComposed?.({ ok: p.status === "complete", reason: `already ${p.status}` }); return; }
  const attempts: any[] = [];
  for (const n of [1, 2]) {
    const prior = d.state.attempts.find((a: any) => a.cell === cellId && a.attempt === n);
    if (prior?.outcome === "technical") { attempts.push({ attempt: n, technicalFailure: prior.failure, fromDispatchRecord: true }); continue; }
    // Stop rule before every NEW dispatch: the cell stays pending (no pipeline.json) and resumable only after a dated diagnosis.
    if (!prior) { const stop = d.stop(); if (stop) { if (!d.state.stopped) { d.state.stopped = stop; await d.save(); } console.error(`${cellId}: not dispatched (${stop})`); onComposed?.({ ok: false, reason: `stopped: ${stop}` }); return; } }
    await d.started(cellId, n);
    const r = await attemptCell(c, n, onComposed);
    const { files, ...rest } = r;
    attempts.push(rest);
    if (!r.technicalFailure) {
      await freezeDir(join(c.recordRoot, "final"), files, { attempt: n, outcome: r.outcome, reviewAvailable: r.reviewAvailable ?? false, cap: c.cap, finalChars: r.finalChars, overCap: r.overCap });
      await write(join(c.recordRoot, "pipeline.json"), { id: cellId, ledger: c.ledger, arm: c.arm, rep: c.rep, model: MODEL, thinking: EFFORT, status: "complete", deliverable: r.deliverable, reviewAvailable: r.reviewAvailable ?? false, overCap: r.overCap ?? false, finalAttempt: n, packetSha256: Object.fromEntries(Object.entries(c.packet).map(([k, v]) => [k, sha(v)])), runnerSha256: runnerSha256(), attempts });
      await d.ended(cellId, n, "complete");
      return;
    }
    await d.ended(cellId, n, "technical", r.technicalFailure);
    console.error(`${cellId} attempt ${n}: ${r.technicalFailure}`);
  }
  await write(join(c.recordRoot, "pipeline.json"), { id: cellId, ledger: c.ledger, arm: c.arm, rep: c.rep, model: MODEL, thinking: EFFORT, status: "technically-incomplete", attempts });
}
export const CELLS = EXP1.flatMap(l => REPS_BI.flatMap(rep => ARMS_BI.map(arm => ({ ledger: l, arm, rep }))));
/** First-cell validity gate, then dispatch one cell at a time while the stop rule allows it (no launch-all). */
export async function runExp1(): Promise<void> {
  checkManifest();
  await withLock("exp1-run", async () => {
    const d = new Dispatch(join(BI, "exp1/dispatch.json"));
    const [first, ...rest] = CELLS;
    let resolveGate!: (g: GateResult) => void;
    const gate = new Promise<GateResult>(r => { resolveGate = r; });
    const jobs: Promise<void>[] = [settled(`cell ${first!.ledger}/${first!.arm}-r${first!.rep}`, cell(cellSpec(first!.ledger, first!.arm, first!.rep), d, g => resolveGate(g)).finally(() => resolveGate({ ok: false, reason: "first cell ended without a gate report" })))];
    const g = d.state.gate?.ok ? d.state.gate : await gate;
    if (!d.state.gate?.ok) { d.state.gate = { ...g, at: new Date().toISOString(), cell: `${first!.ledger}/${first!.arm}-r${first!.rep}` }; await d.save(); }
    if (!g.ok) { d.state.stopped = `first-cell gate failed: ${g.reason}`; await d.save(); console.error(d.state.stopped); await Promise.all(jobs); return; }
    const stagger = Number(process.env.BI_STAGGER_MS ?? 30_000);
    for (const c of rest) {
      if (!existsSync(join(BI, "exp1/runs", c.ledger, `${c.arm}-r${c.rep}`, "pipeline.json"))) await new Promise(r => setTimeout(r, stagger));
      const stop = d.stop();
      if (stop && !existsSync(join(BI, "exp1/runs", c.ledger, `${c.arm}-r${c.rep}`, "pipeline.json"))) { console.error(`not dispatched ${c.ledger}/${c.arm}-r${c.rep}: ${stop}`); continue; }
      jobs.push(settled(`cell ${c.ledger}/${c.arm}-r${c.rep}`, cell(cellSpec(c.ledger, c.arm, c.rep), d)));
    }
    await Promise.all(jobs);
  });
}

// ---- instruments (protocol §7) ------------------------------------------------------------------------------------------------------------
const outer = new Gate(Number(process.env.BI_OUTER ?? 12));
export interface InstrumentSpec { kind: "neutral" | "rubric" | "pairwise" | "select"; key: string; model: string; prompt: string; fix: string; inputs: Record<string, string>; validate: (raw: string) => string[]; output: string; guard: number; extra: Record<string, unknown>; target?: (dir: string) => Promise<void>; onValid?: (raw: string) => Promise<Record<string, unknown>>; root?: string }
export const instrumentFile = (kind: string, key: string, root = BI) => join(root, "instruments", kind, `${key}.json`);
const targetSummary = (t: Turn) => t?.target ? { unchanged: t.target.unchanged, changed: t.target.changed, removed: t.target.removed, added: t.target.added } : undefined;
/** One instrument job: a fresh session, ≤1 schema-fix continuation, ONE fresh re-execution after a technical failure; never more. */
export async function instrumentBI(s: InstrumentSpec): Promise<void> {
  const root = s.root ?? BI, out = instrumentFile(s.kind, s.key, root);
  if (existsSync(out)) return;
  await mkdir(dirname(out), { recursive: true });
  const attempts: any[] = [];
  for (const n of [1, 2]) {
    const session = join(studyDir(), root === BI ? "instruments" : `preflight-instruments`, s.kind, s.key, `a${n}`), record = join(root, "instrument-runs", s.kind, s.key, `a${n}`), turns: Turn[] = [];
    try {
      await outer.run(async () => {
        if (s.target && !existsSync(join(session, "target-before.json"))) await s.target(join(session, "target"));
        turns.push(await turn({ session, record, label: `bi-${s.kind}-${s.key}-a${n}`, number: 1, model: s.model, effort: EFFORT, prompt: s.prompt, inputs: s.inputs, guard: s.guard }));
        if (!turns[0]!.ok) return;
        let raw = outputOf(turns[0]!, s.output), errors = s.validate(raw);
        if (errors.length) {
          turns.push(await turn({ session, record, label: `bi-${s.kind}-${s.key}-a${n}`, number: 2, model: s.model, effort: EFFORT, prompt: s.fix.replace("{ERRORS}", errors.slice(0, 60).join("\n")), inputs: {}, guard: GUARDS.fix }));
          if (!turns[1]!.ok) return;
          raw = outputOf(turns[1]!, s.output); errors = s.validate(raw);
        }
        const extra = errors.length === 0 && s.onValid ? await s.onValid(raw) : {};
        await write(out, { kind: s.kind, key: s.key, model: s.model, effort: EFFORT, ...s.extra, valid: errors.length === 0, errors, value: parseJson(raw), raw: errors.length ? raw.slice(0, 4000) : undefined, ...extra, attempts: [...attempts, { attempt: n, turns: turns.map(t => summary(s.kind, t)) }], targetAfter: turns.map(targetSummary) });
      });
      if (existsSync(out)) return;
      attempts.push({ attempt: n, technical: turns.at(-1)?.technical, turns: turns.map(t => summary(s.kind, t)) });
    } catch (e) { attempts.push({ attempt: n, harness: String(e).slice(0, 400), turns: turns.map(t => summary(s.kind, t)) }); }
    finally { await retainSession(session, record); }
  }
  await write(out, { kind: s.kind, key: s.key, model: s.model, effort: EFFORT, ...s.extra, valid: false, technicalFailure: true, attempts });
}
const unitTask = (unit: string) => ({ "task.md": text(retry1Input(unit, "task.md")), "guide.md": text(retry1Input(unit, "guide.md")) });
export function neutralJob(key: string, f: Fam): InstrumentSpec | undefined {
  const body = textOf(key); if (body === undefined) return undefined;
  const unit = textInfo(key).unit, ids = claimsOfUnit(unit).map(c => c.ref);
  return { kind: "neutral", key: `${key.replace(":", "_").replace("/", "_")}.${f}`, model: modelOf(f), prompt: JUDGE_N, fix: JUDGE_N_FIX, inputs: { ...unitTask(unit), "text.md": numberLines(body), "statements.json": statementsJson(unit) }, validate: raw => checkJudge(ids, parseJson(raw), body), output: "judgment.json", guard: GUARDS.judge, extra: { text: key, fam: f, textSha256: sha(body) } };
}
export function rubricJob(key: string, f: Fam): InstrumentSpec | undefined {
  const body = textOf(key); if (body === undefined) return undefined;
  const unit = textInfo(key).unit, rubric = text(join(BI, "instruments/rubrics", `${unit}.md`)), criteria = RUBRIC_SOURCES[caseOf(unit)].criteria;
  return { kind: "rubric", key: `${key.replace(":", "_").replace("/", "_")}.${f}`, model: modelOf(f), prompt: RUBRIC, fix: RUBRIC_FIX, inputs: { ...unitTask(unit), "rubric.md": rubric, "text.md": numberLines(body) }, validate: raw => checkRubric(criteria, parseJson(raw), body), output: "rubric.json", guard: GUARDS.pairwise, extra: { text: key, fam: f, textSha256: sha(body), criteria, rubricSha256: sha(rubric) } };
}
export function pairJob(j: ReturnType<typeof pairJobs>[number]): InstrumentSpec | undefined {
  const x = textOf(j.X), y = textOf(j.Y); if (x === undefined || y === undefined) return undefined;
  const unit = textInfo(j.X).unit;
  return { kind: "pairwise", key: j.key, model: modelOf(j.fam), prompt: PAIR_U, fix: PAIR_FIX, inputs: { ...unitTask(unit), "answer-X.md": x, "answer-Y.md": y }, validate: raw => checkPairwise(parseJson(raw)), output: "pairwise.json", guard: GUARDS.pairwise, extra: { comparison: j.comparison, fam: j.fam, order: j.order, X: j.X, Y: j.Y, textSha256: { X: sha(x), Y: sha(y) } } };
}
const settled = (name: string, job: Promise<void>) => job.catch(async e => { console.error(`${name}: harness error ${String(e)}`); await mkdir(join(BI, "harness-errors"), { recursive: true }); await write(join(BI, "harness-errors", `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}-${Date.now()}.json`), { name, error: String(e), at: new Date().toISOString() }); });
async function runJobs(specs: (InstrumentSpec | undefined)[]): Promise<void> { await Promise.all(specs.filter((s): s is InstrumentSpec => !!s).map(s => settled(`${s.kind} ${s.key}`, instrumentBI(s)))); }
export async function poolInstruments(): Promise<void> {
  checkManifest();
  await withLock("pool-instruments", () => runJobs([...POOL_TEXTS.flatMap(k => FAMS.flatMap(f => [neutralJob(k, f), rubricJob(k, f)])), ...pairJobs().filter(j => j.comparison.kind === "S-E").map(pairJob)]));
}
export function exp1Ready(root = BI): { ready: boolean; pending: string[] } {
  const pending = CELLS.map(c => `${c.ledger}/${c.arm}-r${c.rep}`).filter(id => !existsSync(join(root, "exp1/runs", id, "pipeline.json")));
  return { ready: pending.length === 0, pending };
}
export async function exp1Instruments(): Promise<void> {
  checkManifest();
  const r = exp1Ready();
  if (!r.ready) throw new Error(`Experiment-1 finals not all frozen; pending: ${r.pending.join(", ")}`);
  for (const c of CELLS) { const dir = join(BI, "exp1/runs", c.ledger, `${c.arm}-r${c.rep}`); if (json(join(dir, "pipeline.json")).status === "complete") verifyFrozen(join(dir, "final")); }
  const kinds = (process.env.BI_KINDS ?? "neutral,rubric,pairwise").split(",").sort();
  await withLock(`exp1-instruments-${kinds.join("+")}`, () => runJobs([...EXP1_TEXTS.flatMap(k => FAMS.flatMap(f => [kinds.includes("neutral") ? neutralJob(k, f) : undefined, kinds.includes("rubric") ? rubricJob(k, f) : undefined])), ...(kinds.includes("pairwise") ? pairJobs().filter(j => j.comparison.kind !== "S-E").map(pairJob) : [])]));
}

// ---- Experiment 2-b selector (protocol §9; runs only when the frozen E2-a estimate says the prerequisite is met) ----------------------------
export const candidateManifest = (unit: string) => json(join(BI, "exp2/candidates", unit, "manifest.json"));
/** The snapshot copy a selector may read (made read-only by file mode; any change is recorded by the turn's target hashes). */
export async function snapshotInto(unit: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (caseOf(unit) === "dev") execFileSync("bash", ["-c", `git -C '${REPO}' archive 2de1f04 | tar -x -C '${dir}'`]);
  else await cp(join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491/src"), dir, { recursive: true });
  execFileSync("chmod", ["-R", "a-w", dir]);
}
/** Code delivers the stored candidate bytes and verifies their sha256 against the frozen candidate manifest. */
export async function deliverChoice(unit: string, candidate: "S" | "E", dest: string, manifest = candidateManifest(unit)): Promise<{ path: string; sha256: string; matches: boolean }> {
  const c = manifest.candidates[candidate], body = readFileSync(join(REPO, c.stored));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
  const delivered = sha(readFileSync(dest));
  if (delivered !== c.storedSha256 || sha(body) !== c.storedSha256) throw new Error(`delivered bytes of ${unit}/${candidate} do not match the frozen candidate hash`);
  return { path: dest.slice(REPO.length + 1), sha256: delivered, matches: true };
}
export function selectJob(j: (typeof SELECT_JOBS)[number]): InstrumentSpec {
  const m = candidateManifest(j.unit), unit = j.unit;
  const inputs: Record<string, string> = { ...unitTask(unit), "evidence-index.json": text(retry1Input(unit, "evidence-index.json")), "doc-A-evidence.jsonl": text(retry1Input(unit, "doc-A-evidence.jsonl")), "doc-B-evidence.jsonl": text(retry1Input(unit, "doc-B-evidence.jsonl")) };
  j.candidates.forEach((cand, i) => { inputs[`candidate-${i + 1}.md`] = text(join(REPO, m.candidates[cand].masked)); });
  return { kind: "select", key: j.key, model: MODEL, prompt: SELECT, fix: SELECT_FIX, inputs, validate: checkSelection, output: "selection.json", guard: GUARDS.pairwise, extra: { unit, order: j.order, rep: j.rep, shown: Object.fromEntries(j.candidates.map((cand, i) => [`candidate-${i + 1}`, cand])) }, target: dir => snapshotInto(unit, dir),
    onValid: async raw => { const id = JSON.parse(raw).candidate_id as string, cand = j.candidates[CANDIDATE_IDS.indexOf(id)]!; return { chosen: cand, delivered: await deliverChoice(unit, cand, join(BI, "exp2/selector", unit, `o${j.order}-r${j.rep}`, "delivered.md"), m) }; } };
}
export async function select(): Promise<void> {
  checkManifest();
  const est = join(BI, "exp2/estimate.json");
  if (!existsSync(est)) throw new Error("no frozen E2-a estimate (exp2/estimate.json)");
  const e = json(est);
  if (e.prerequisiteMet !== true) throw new Error(`E2-b not run: prerequisite not met (${e.reason ?? "see estimate.json"})`);
  await withLock("select", () => runJobs(SELECT_JOBS.map(selectJob)));
}

// ---- stage 0: inventory, packets, freeze (protocol §2-§3, §10) --------------------------------------------------------------------------
const rel = (p: string) => p.slice(REPO.length + 1);
const fileHash = (p: string) => existsSync(p) ? sha(readFileSync(p)) : null;
export async function prepare(): Promise<void> {
  if (VARIANT.name !== "max") throw new Error("the bottleneck study runs on the delivery runtime's max variant only (unset DELIVERY_VARIANT)");
  if (existsSync(join(BI, "inputs-frozen.json"))) throw new Error("inputs already frozen; never overwrite");
  if (!existsSync(join(BI, "protocol.md"))) throw new Error("protocol.md must exist before the inputs are frozen");
  // 1. frozen sources verified in place
  const dv = json(join(INPUT_ROOT, "inputs-frozen.json")), dm = json(join(INPUT_ROOT, "manifest.json")), r1 = json(join(RETRY1, "inputs-frozen.json")), rf = json(join(RETRY1, "references-frozen.json")), rm = json(join(RETRY1, "manifest.json"));
  for (const l of EXP1) for (const [name, hash] of Object.entries<string>(dv.ledgers[l].files)) if (sha(text(join(INPUT_ROOT, "inputs", l, name))) !== hash) throw new Error(`delivery input changed: ${l}/${name}`);
  for (const u of UNITS) {
    for (const [name, hash] of Object.entries<string>(r1.units[u].files)) if (sha(readFileSync(retry1Input(u, name))) !== hash) throw new Error(`retry1 input changed: ${u}/${name}`);
    if (sha(readFileSync(join(RETRY1, "references", `${u}-b.json`))) !== rf.references[u].b.sha256) throw new Error(`labeller-b reference changed: ${u}`);
  }
  const reused = deliveryPromptHashes();
  for (const k of WRITER_REUSED) if (reused[k] !== dm.prompts[k]) throw new Error(`delivery prompt ${k} differs from the completed delivery study`);
  if (sha(JUDGE_N) !== rm.prompts.JUDGE) throw new Error("neutral judge prompt differs from the qualification retry");
  for (const [u, cap] of Object.entries(CAP)) if (chars(text(S_ANSWER(u))) !== cap) throw new Error(`${u}: cap ${cap} is not the stored S answer's code-point length ${chars(text(S_ANSWER(u)))}`);
  // 2. packets A/R and their difference
  const diffs: any = {}, packets: any = {};
  for (const l of EXP1) {
    const unit = unitOf(l), base = ledgerOf(l), { A, R, rows } = buildArms(base, refsOf(unit), DISPUTED[unit]!);
    const task = text(join(INPUT_ROOT, "inputs", l, "task.md")), guide = text(join(INPUT_ROOT, "inputs", l, "guide.md"));
    const files = { A: { "task.md": task, "guide.md": guide, "ledger.json": ledgerJson(A as Ledger), "ledger.md": ledgerMarkdownBI(A) }, R: { "task.md": task, "guide.md": guide, "ledger.json": ledgerJson(R as Ledger), "ledger.md": ledgerMarkdownBI(R) }, original: { "ledger.json": text(join(INPUT_ROOT, "inputs", l, "ledger.json")), "ledger.md": text(join(INPUT_ROOT, "inputs", l, "ledger.md")) } };
    for (const arm of ARMS_BI) { await mkdir(armPacketDir(l, arm), { recursive: true }); for (const [n, b] of Object.entries(files[arm])) await writeFile(join(armPacketDir(l, arm), n), b); }
    diffs[l] = packetDiff(A, R, rows, files);
    packets[l] = { A: diffs[l].sha256.A, R: diffs[l].sha256.R, cap: CAP[unit] };
  }
  await write(join(BI, "exp1/packet-diff.json"), { at: new Date().toISOString(), referenceSource: "results/qualification-validation-retry1/references/<unit>-b.json (labeller b; LLM-derived, isort labeller read the upstream fix/tests; single reading)", disputed: DISPUTED, templates: { note: NOTE_TEMPLATE, evidence: EVIDENCE_TEMPLATE, taskLink: TASKLINK_TEMPLATE }, ledgers: diffs });
  // 3. rubric packets, comparison manifest, candidate manifests
  const rubrics: any = {};
  for (const u of UNITS) { const rp = rubricPacket(u); await mkdir(join(BI, "instruments/rubrics"), { recursive: true }); await writeFile(join(BI, "instruments/rubrics", `${u}.md`), rp.body); rubrics[u] = { sha256: sha(rp.body), criteria: rp.criteria }; }
  await write(join(BI, "comparisons.json"), { at: new Date().toISOString(), design: "every comparison judged by both families (Claude Opus 5.5, GPT-6-astra; thinking max) in both orders (o1: X = P, o2: X = Q)", comparisons: comparisons(), jobs: pairJobs().map(j => ({ key: j.key, comparison: j.comparison.id, fam: j.fam, order: j.order, X: j.X, Y: j.Y })), neutral: [...EXP1_TEXTS, ...POOL_TEXTS], rubric: [...EXP1_TEXTS, ...POOL_TEXTS], select: SELECT_JOBS });
  const candidates: any = {};
  for (const u of UNITS) {
    const m = { unit: u, candidates: Object.fromEntries((["S", "E"] as const).map(c => { const stored = c === "S" ? S_ANSWER(u) : E_ANSWER(u), masked = retry1Input(u, `${c === "S" ? sDoc(u) : eDoc(u)}.md`); return [c, { stored: rel(stored), storedSha256: sha(readFileSync(stored)), storedChars: chars(text(stored)), masked: rel(masked), maskedSha256: sha(readFileSync(masked)), maskedAlias: c === "S" ? sDoc(u) : eDoc(u) }]; })), maskingList: r1.units[u].substitutions, lengthRatioEtoS: Math.round(chars(text(E_ANSWER(u))) / chars(text(S_ANSWER(u))) * 1000) / 1000 };
    await mkdir(join(BI, "exp2/candidates", u), { recursive: true }); await write(join(BI, "exp2/candidates", u, "manifest.json"), m); candidates[u] = sha(readFileSync(join(BI, "exp2/candidates", u, "manifest.json")));
  }
  // 4. inventory (everything the stages read, hashed; missing/incomplete cases stay excluded)
  const inventory = {
    at: new Date().toISOString(), tasks: { "dev (orche 2de1f04)": ["dev-r1"], "isort-2491": ["isort-r1", "isort-r2"] }, note: "three Q ledgers / three pools come from TWO exposed diagnostic tasks; no holdout",
    units: Object.fromEntries(UNITS.map(u => [u, { retry1Inputs: Object.fromEntries(readdirSync(join(RETRY1, "inputs", u)).map(f => [f, fileHash(retry1Input(u, f))])), labellerB: { file: `results/qualification-validation-retry1/references/${u}-b.json`, sha256: fileHash(join(RETRY1, "references", `${u}-b.json`)), items: refsOf(u).size }, key: { file: `results/qualification-validation-retry1/keys/${u}.json`, sha256: fileHash(join(RETRY1, "keys", `${u}.json`)), evaluatorOnly: true }, storedAnswers: Object.fromEntries(["X-S", "X-E", "X-A"].map(s => [s, { file: `results/quality-validation/${u}/${s}/answer.md`, sha256: fileHash(join(REPO, "results/quality-validation", u, s, "answer.md")), chars: chars(text(join(REPO, "results/quality-validation", u, s, "answer.md"))) }])), rubric: rubrics[u] }])),
    ledgers: Object.fromEntries(EXP1.map(l => [l, { deliveryInputs: dv.ledgers[l].files, finalPlan: dv.ledgers[l].source, decisions: dv.ledgers[l].decisions }])),
    rubricsSource: Object.fromEntries(Object.values(RUBRIC_SOURCES).map(s => [s.file, fileHash(join(REPO, s.file))])),
    historicalEvaluation: Object.fromEntries(["results/quality-validation/evaluation.md", "results/quality-validation/report.md"].map(f => [f, fileHash(join(REPO, f))])),
    evaluatorOnlyGold: { isortHiddenTest: fileHash(join(REPO, "fixtures/advisor-bench/swe/pycqa__isort-2491/hidden/test.patch")), isortReferenceFix: fileHash(join(REPO, "fixtures/advisor-bench/swe/pycqa__isort-2491/reference/fix.patch")), devFixCommits: ["e7a0891", "dd98d5b"] },
    secondaryCandidates: { descriptiveOnly: true, files: Object.fromEntries(execFileSync("bash", ["-c", `cd '${REPO}' && ls results/quality-validation/*/X-A/answer.md results/synthesis-validation/*/*/C1/final.md results/synthesis-validation/*/*/T/final.md results/qualification-validation-retry1/*/*/final/final.md results/delivery-validation/runs/*/*/final/final.md 2>/dev/null`]).toString().split("\n").filter(Boolean).map(f => [f, fileHash(join(REPO, f))])) },
    e20Records: { root: "results/ultra-ab/main", summary: fileHash(join(REPO, "results/ultra-ab/main/summary-main.json")), stopped: fileHash(join(REPO, "results/ultra-ab/main/STOPPED.md")) },
    excluded: { "isort-r2 Q ledgers": "compose ended with upstream 503; only initial decisions (no A ledger): excluded from Experiment 1, not substituted", "dev-r1 Q-r1": "draft plan only", "docstub-123, hermes-webui-2056": "no diagnostic answers, claims or labels (patch candidates only): not ready", "holdout": "none (all four cases exposed)" },
  };
  await write(join(BI, "inventory.json"), inventory);
  await write(join(BI, "target-hashes-before.json"), { at: new Date().toISOString(), ...targetHashes() });
  await write(join(BI, "inputs-frozen.json"), { frozenAt: new Date().toISOString(), protocolSha256: sha(text(join(BI, "protocol.md"))), builderSha256: sha(readFileSync(fileURLToPath(import.meta.url))), packets, packetDiffSha256: fileHash(join(BI, "exp1/packet-diff.json")), comparisonsSha256: fileHash(join(BI, "comparisons.json")), candidates, rubrics, inventorySha256: fileHash(join(BI, "inventory.json")), caps: CAP, lengthUnit: "unicode code points of the stored S answer (results/quality-validation/<unit>/X-S/answer.md)", prompts: promptHashes(), reusedDeliveryPrompts: Object.fromEntries(WRITER_REUSED.map(k => [k, reused[k]])), sources: { deliveryInputsFrozen: fileHash(join(INPUT_ROOT, "inputs-frozen.json")), retry1InputsFrozen: fileHash(join(RETRY1, "inputs-frozen.json")), referencesFrozen: fileHash(join(RETRY1, "references-frozen.json")) } });
}
export function checkInputs(): void {
  const f = json(join(BI, "inputs-frozen.json"));
  if (sha(text(join(BI, "protocol.md"))) !== f.protocolSha256) throw new Error("protocol.md changed after the input freeze");
  for (const l of EXP1) for (const arm of ARMS_BI) for (const [n, h] of Object.entries<string>(f.packets[l][arm])) if (sha(text(join(armPacketDir(l, arm), n))) !== h) throw new Error(`packet changed: ${l}/${arm}/${n}`);
  for (const [k, h] of Object.entries<string>({ "comparisons.json": f.comparisonsSha256, "exp1/packet-diff.json": f.packetDiffSha256, ...Object.fromEntries(Object.entries<string>(f.candidates).map(([u, x]) => [`exp2/candidates/${u}/manifest.json`, x])) })) if (fileHash(join(BI, k)) !== h) throw new Error(`frozen ${k} changed`);
  for (const [u, r] of Object.entries<any>(f.rubrics)) if (fileHash(join(BI, "instruments/rubrics", `${u}.md`)) !== r.sha256) throw new Error(`rubric packet ${u} changed`);
  if (JSON.stringify(f.prompts) !== JSON.stringify(promptHashes())) throw new Error("prompts changed after the input freeze");
}

// ---- preflight (protocol §6): toy writer path with forced shortening, continuations, resume, all instrument kinds, selector, refusal -------
export const TOY_REFS: BRef[] = [
  { id: "k1", support: "supported", relevance: "finding", salience: "essential", equivalentTo: ["k5"] },
  { id: "k2", support: "insufficient", relevance: "finding", salience: "essential", equivalentTo: [] },
  { id: "k3", support: "supported", relevance: "supporting", salience: "detail", equivalentTo: [] },
  { id: "k4", support: "refuted", relevance: "supporting", salience: "detail", equivalentTo: [] },
  { id: "k5", support: "supported", relevance: "finding", salience: "essential", equivalentTo: ["k1"] },
  { id: "k6", support: "supported", relevance: "out", salience: "context", equivalentTo: [] },
];
export const TOY_SNAPSHOT = { "calc.js": "export const sum = xs => xs.reduce((a, b) => a + b, 0);\n\nexport function mean(xs) {\n  return sum(xs) / xs.length;\n}\n" };
export const TOY_RUBRIC = "# Evaluator-only reference rubric (toy)\n\nT1: mean in calc.js:3-5 divides sum(xs) by xs.length without a guard, so mean([]) is 0/0 = NaN.\n\n## Criteria to score (one item each)\n\n- T1.mechanism\n- T1.scenario\n";
export const TOY_CANDIDATES = { S: "# Answer\n\nmean (calc.js:3-5) computes the average. mean([]) returns NaN: it divides sum([]) = 0 by xs.length = 0 without a guard.\n", E: "# Answer\n\nThe average is computed by avg() in utils.js. An empty list throws a TypeError.\n" };
export async function preflight(): Promise<void> {
  checkInputs();
  const prior = existsSync(join(BI, "preflight.json")) ? json(join(BI, "preflight.json")) : undefined;
  if (prior?.passed) throw new Error("preflight already passed");
  const n = (prior?.attempts?.length ?? 0) + 1, scratch = join(studyDir(), "preflight", `attempt-${n}`), record = join(BI, "preflight", `attempt-${n}`), failures: string[] = [], results: any[] = [];
  const { ledger } = canonicalLedger("toy", TOY.claims, TOY.plan, {});
  const { A, R } = buildArms(ledger, new Map(TOY_REFS.map(r => [r.id, r])), []);
  const packet = { "task.md": TOY.task, "guide.md": TOY.guide, "ledger.json": ledgerJson(R as Ledger), "ledger.md": ledgerMarkdownBI(R) };
  const note = (name: string, t: Turn | undefined, extra: Record<string, unknown> = {}) => results.push({ name, ok: t?.ok, technical: t?.technical, routeOk: t?.routeOk, effort: t?.thinking, thinkingLevels: t?.identity?.thinking, routes: t?.identity?.routes, wire: { requests: t?.wire?.requests, costUSD: t?.wire?.costUSD, routes: t?.wire?.routes, updateEfforts: t?.wire?.updateEfforts }, ms: t?.ms, ...extra });
  const atMax = (t: Turn | undefined) => !!t && t.ok && Object.keys(t.wire?.routes ?? {}).length > 0 && Object.keys(t.wire?.routes ?? {}).every(r => r.endsWith(`@${EFFORT}`)) && (t.identity?.thinking ?? []).length > 0 && t.identity.thinking.every((x: string) => x === EFFORT);
  // writer path on the real control flow: the compose prompt states 400 characters while the length step enforces 60, which forces the
  // one shortening opportunity (attempt 1 showed a compliant toy writer never reaches it); resume re-enters the same records from cache
  const spec: CellSpec = { ledger: "toy", arm: "R", rep: 1, cap: 60, promptCap: 400, packet, ledgerObj: R, label: `bi-preflight-${n}-cell`, scratchRoot: join(scratch, "cell"), recordRoot: join(record, "cell") };
  const [cellRun, neg] = await Promise.all([attemptCell(spec, 1), turn({ session: join(scratch, "negative"), record: join(record, "negative"), label: `bi-preflight-${n}-negative`, number: 1, model: MODEL, effort: EFFORT, prompt: "Reply with the single word OK.", inputs: { "note.md": "identity preflight\n" }, guard: 20 * 60_000, pinModel: JUDGES[0] })]);
  const stagesTurns = (cellRun.stages ?? []) as any[];
  results.push({ name: `writer cell (real flow, prompt cap ${spec.promptCap}, enforced cap ${spec.cap})`, outcome: cellRun.outcome, technicalFailure: cellRun.technicalFailure, stages: stagesTurns.map(s => `${s.stage}:${s.ok}`), draftChars: cellRun.draftChars, preShortenChars: cellRun.preShortenChars, shortened: cellRun.shortened, finalChars: cellRun.finalChars, overCap: cellRun.overCap });
  if (cellRun.technicalFailure) failures.push(`writer cell: ${cellRun.technicalFailure}`);
  if (!cellRun.shortened || !stagesTurns.some(s => s.stage === "shorten")) failures.push("the shortening opportunity was not exercised");
  if (stagesTurns.filter(s => s.stage === "shorten").length > 1) failures.push("more than one shortening turn");
  if (!stagesTurns.some(s => s.stage === "recheck") && cellRun.reviewAvailable) failures.push("recheck missing");
  note("negative identity (pinned to another model)", neg, { expected: "refused before dispatch" });
  if (!(neg.identity?.guard?.refused > 0 && neg.identity?.guard?.forwarded === 0 && (neg.wire?.requests ?? 0) === 0 && !neg.ok)) failures.push("negative identity turn was not refused before dispatch");
  // resume: the same attempt again must reuse every completed turn from its record (no new model call)
  const before = readdirSync(join(record, "cell", "a1", "compose")).filter(f => f.startsWith("turn-")).length;
  const again = await attemptCell(spec, 1);
  const afterTurns = readdirSync(join(record, "cell", "a1", "compose")).filter(f => f.startsWith("turn-")).length;
  results.push({ name: "resume of the completed attempt (cache)", sameFinal: again.finalChars === cellRun.finalChars, composeTurnsBefore: before, composeTurnsAfter: afterTurns, technicalFailure: again.technicalFailure });
  if (again.technicalFailure || afterTurns !== before || again.finalChars !== cellRun.finalChars) failures.push("resume did not reuse the completed turns unchanged");
  const cellTurns: Turn[] = stagesTurns.map(s => json(join(BI, s.record, "result.json")));
  const offMax = cellTurns.filter(t => !atMax(t)).map(t => `${t.label}#${t.number}`);
  if (offMax.length) failures.push(`writer turns not entirely at ${EFFORT}: ${offMax.join(", ")}`);
  // forced continuations of the composer (mechanical fix) and of the auditor (schema fix), on the same sessions
  const last = Math.max(...stagesTurns.filter(s => s.label.endsWith("-compose")).map(s => s.number));
  const cfix = await turn({ session: join(spec.scratchRoot, "a1", "compose"), record: join(spec.recordRoot, "a1", "compose"), label: `${spec.label}-a1-compose`, number: last + 1, model: MODEL, effort: EFFORT, prompt: C_FIX.replace("{ERRORS}", "preflight check of the fix continuation: confirm that final.md exists, is the complete answer and mentions no ledger ids; change nothing else"), inputs: {}, guard: 20 * 60_000 });
  note("composer fix continuation (forced)", cfix, { composeErrors: checkComposeC(outputOf(cfix, "final.md")) });
  const auditLast = Math.max(...stagesTurns.filter(s => s.label.endsWith("-audit")).map(s => s.number));
  const afix = await turn({ session: join(spec.scratchRoot, "a1", "audit"), record: join(spec.recordRoot, "a1", "audit"), label: `${spec.label}-a1-audit`, number: auditLast + 1, model: MODEL, effort: EFFORT, prompt: AUDIT_FIX.replace("{ERRORS}", "preflight check of the fix continuation: re-validate audit.json (valid JSON with a defects array); keep the same review content"), inputs: {}, guard: 20 * 60_000 });
  note("audit schema-fix continuation (forced)", afix, { auditErrors: checkAudit(parseJson(outputOf(afix, "audit.json"))) });
  for (const [name, t] of [["composer fix", cfix], ["audit fix", afix]] as const) if (!atMax(t)) failures.push(`${name} continuation failed or not at ${EFFORT}`);
  // instruments on the toy text: neutral judges (both families), rubric judge, neutral pairwise, selector with the read-only snapshot
  const toyText = existsSync(join(spec.recordRoot, "a1")) ? (cellRun.files?.["final.md"] ?? "") : "";
  const ids = TOY.claims.map(c => c.ref), statements = JSON.stringify({ statements: TOY.claims.map(x => ({ id: x.ref, statement: x.claim, stance: x.stance })) });
  const pre = (_kind: string, key: string) => ({ key: `p${n}-${key}` });
  const jobs: InstrumentSpec[] = [
    ...FAMS.map(f => ({ kind: "neutral" as const, key: pre("neutral", `toy.${f}`).key, model: modelOf(f), prompt: JUDGE_N, fix: JUDGE_N_FIX, inputs: { "task.md": TOY.task, "guide.md": TOY.guide, "text.md": numberLines(toyText), "statements.json": statements }, validate: (raw: string) => checkJudge(ids, parseJson(raw), toyText), output: "judgment.json", guard: 30 * 60_000, extra: { preflight: n } })),
    { kind: "rubric", key: pre("rubric", "toy.gpt").key, model: modelOf("gpt"), prompt: RUBRIC, fix: RUBRIC_FIX, inputs: { "task.md": TOY.task, "guide.md": TOY.guide, "rubric.md": TOY_RUBRIC, "text.md": numberLines(toyText) }, validate: raw => checkRubric(["T1.mechanism", "T1.scenario"], parseJson(raw), toyText), output: "rubric.json", guard: 30 * 60_000, extra: { preflight: n } },
    { kind: "pairwise", key: pre("pairwise", "toy.claude.o1").key, model: modelOf("claude"), prompt: PAIR_U, fix: PAIR_FIX, inputs: { "task.md": TOY.task, "guide.md": TOY.guide, "answer-X.md": toyText, "answer-Y.md": TOY_CANDIDATES.E }, validate: raw => checkPairwise(parseJson(raw)), output: "pairwise.json", guard: 30 * 60_000, extra: { preflight: n } },
    { kind: "select", key: pre("select", "toy.o2").key, model: MODEL, prompt: SELECT, fix: SELECT_FIX, inputs: { "task.md": TOY.task, "guide.md": TOY.guide, "candidate-1.md": TOY_CANDIDATES.E, "candidate-2.md": TOY_CANDIDATES.S, "doc-A-evidence.jsonl": "", "doc-B-evidence.jsonl": "", "evidence-index.json": "{}\n" }, validate: checkSelection, output: "selection.json", guard: 30 * 60_000, extra: { preflight: n, shown: { "candidate-1": "E", "candidate-2": "S" } },
      target: async dir => { await mkdir(dir, { recursive: true }); for (const [f, b] of Object.entries(TOY_SNAPSHOT)) await writeFile(join(dir, f), b); execFileSync("chmod", ["-R", "a-w", dir]); },
      onValid: async raw => { const id = JSON.parse(raw).candidate_id, cand = id === "candidate-1" ? "E" : "S", dest = join(record, "toy-delivered.md"); await mkdir(record, { recursive: true }); await writeFile(dest, TOY_CANDIDATES[cand]); return { chosen: cand, delivered: { sha256: sha(readFileSync(dest)), matches: sha(readFileSync(dest)) === sha(TOY_CANDIDATES[cand]) } }; } },
  ];
  for (const j of jobs) j.root = record;
  await Promise.all(jobs.map(j => instrumentBI(j)));
  for (const j of jobs) {
    const r = json(instrumentFile(j.kind, j.key, record));
    const ts: Turn[] = (r.attempts ?? []).flatMap((a: any) => (a.turns ?? []).map((s: any) => json(join(BI, s.record, "result.json"))));
    const allMax = ts.length > 0 && ts.every(atMax);
    results.push({ name: `${j.kind} ${j.key}`, valid: r.valid, errors: (r.errors ?? []).slice(0, 5), chosen: r.chosen, delivered: r.delivered, allAtMax: allMax, targetChanged: (r.targetAfter ?? []).some((x: any) => x && x.unchanged === false) });
    if (!r.valid || !allMax) failures.push(`${j.kind}: ${r.valid ? `not at ${EFFORT}` : (r.errors ?? ["technical"]).slice(0, 3).join("; ")}`);
    if (j.kind === "select" && (r.chosen === undefined || r.delivered?.matches !== true)) failures.push("selector delivery not verified");
  }
  for (const s of ["negative"]) await retainSession(join(scratch, s), join(record, s));
  const attempt = { attempt: n, at: new Date().toISOString(), effort: EFFORT, passed: failures.length === 0, failures, turns: results };
  await write(join(BI, "preflight.json"), { passed: attempt.passed, at: attempt.at, sourceHashes: sourceHashes(), runnerSha256: runnerSha256(), pins: json(join(PINS, "pins.json")).hashes, attempts: [...(prior?.attempts ?? []), attempt] });
  console.log(JSON.stringify({ passed: attempt.passed, failures }, null, 1));
}

// ---- manifest, locks, status ------------------------------------------------------------------------------------------------------------
export async function freezeManifest(): Promise<void> {
  if (existsSync(join(BI, "manifest.json"))) throw new Error("manifest already frozen");
  checkInputs(); checkPins();
  const pre = json(join(BI, "preflight.json"));
  if (pre.passed !== true || JSON.stringify(pre.sourceHashes) !== JSON.stringify(sourceHashes()) || pre.runnerSha256 !== runnerSha256()) throw new Error("preflight did not pass on the current runtime and study runner");
  const hashOf = (file: string) => sha(text(join(BI, file)));
  await write(join(BI, "manifest.json"), {
    frozenAt: new Date().toISOString(), protocolSha256: hashOf("protocol.md"), inputsFrozenSha256: hashOf("inputs-frozen.json"), preflightSha256: hashOf("preflight.json"),
    sources: sourceHashes(), runnerSha256: runnerSha256(), prompts: promptHashes(), reusedDeliveryPrompts: json(join(BI, "inputs-frozen.json")).reusedDeliveryPrompts, pins: json(join(PINS, "pins.json")).hashes, provider: providerHashes(), pinsAndProviderReadFrom: `${VARIANT.inputs} (in place; never rewritten)`,
    runtimeNodeModules: treeHashes(join(REPO, "node_modules/@earendil-works/pi-ai")), piVersion: execFileSync(NODE, [PI_CLI, "--version"]).toString().trim(), piCliSha256: sha(readFileSync(PI_CLI)),
    models: JSON.parse(text(join(PINS, "cliproxyapi-models.json"))), liveConfigSha256: sha(readFileSync(join(AGENT, "orche.config.json"))), dirty: execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO }).toString(),
    guards: GUARDS, model: MODEL, judges: JUDGES, effort: EFFORT, sessionIdPrefix: `${VARIANT.sessionPrefix}-bi-`, design: { ledgers: EXP1, arms: ARMS_BI, reps: REPS_BI, caps: CAP, units: UNITS, comparisons: pairJobs().length, select: SELECT_JOBS.length },
  });
}
export function checkManifest(): void {
  if (VARIANT.name !== "max") throw new Error("the bottleneck study runs on the delivery runtime's max variant only (unset DELIVERY_VARIANT)");
  const m = json(join(BI, "manifest.json"));
  if (JSON.stringify(m.sources) !== JSON.stringify(sourceHashes())) throw new Error("runtime source changed after the manifest");
  if (m.runnerSha256 !== runnerSha256()) throw new Error("bottleneck.ts changed after the manifest");
  if (JSON.stringify(m.prompts) !== JSON.stringify(promptHashes())) throw new Error("prompts changed after the manifest");
  checkInputs(); checkPins();
}
async function withLock(name: string, job: () => Promise<void>): Promise<void> {
  const lock = join(studyDir(), `${name}-lock.json`);
  if (existsSync(lock)) { const l = json(lock); let alive = false; try { process.kill(l.pid, 0); alive = true; } catch { /* gone */ } if (alive) throw new Error(`runner alive pid=${l.pid}`); }
  await mkdir(studyDir(), { recursive: true });
  await write(lock, { pid: process.pid, startedAt: new Date().toISOString(), command: process.argv });
  await job();
  await write(join(studyDir(), `${name}-finished.json`), { at: new Date().toISOString(), pid: process.pid });
}
export function status(): void {
  for (const c of CELLS) { const f = join(BI, "exp1/runs", c.ledger, `${c.arm}-r${c.rep}`, "pipeline.json"); console.log(`${c.ledger} ${c.arm}-r${c.rep}: ${existsSync(f) ? `${json(f).status}${json(f).overCap ? " overCap" : ""}` : "pending"}`); }
  for (const kind of ["neutral", "rubric", "pairwise", "select"]) { const d = join(BI, "instruments", kind); const files = existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".json")) : []; console.log(kind, files.length, "valid", files.filter(f => json(join(d, f)).valid).length); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, scratch] = process.argv.slice(2);
  if (!scratch) throw new Error("study scratch path required");
  if (VARIANT.name !== "max") throw new Error("unset DELIVERY_VARIANT: the bottleneck study uses the max variant's pins and provider");
  setStudy(scratch);
  if (cmd === "prepare") { await prepare(); await setup(scratch); await freezePins(); }
  else if (cmd === "preflight") { await setup(scratch); await preflight(); }
  else if (cmd === "manifest") await freezeManifest();
  else if (cmd === "run") { await setup(scratch); await runExp1(); }
  else if (cmd === "pool-instruments") { await setup(scratch); await poolInstruments(); }
  else if (cmd === "exp1-instruments") { await setup(scratch); await exp1Instruments(); }
  else if (cmd === "select") { await setup(scratch); await select(); }
  else if (cmd === "status") status();
  else throw new Error("prepare | preflight | manifest | run | pool-instruments | exp1-instruments | select | status");
}
