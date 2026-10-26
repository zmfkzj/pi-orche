/**
 * Evaluation of the delivery-only validation (results/delivery-validation/protocol.md §7-§10 and addendum-1.md): Tier-1 merges,
 * origin-masked host-verification packets (at most two rounds), adjudicated scoring, pair and study verdicts with the fixed sensitivity
 * readings, accounting and preservation. It only reads records and writes evaluation files; it never calls a model.
 *   node --import tsx experiments/mdsd-ab/delivery-eval.ts tier1 | packets 1 | packets 2 | collect <round> <session.jsonl>... |
 *     check-verdicts <packet dir> <verdicts.json> | score | accounting <host session.jsonl>... -- <experimenter session.jsonl>... | preservation
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVED, check, render, type LedgerEntry } from "./delivery-render.mjs";
import { ARMS, LEDGERS, REPS, RETRY1, ROOT, arrangementOf, finalTextOf, ledgerDir, ledgerOf, priorModules, targetHashes, type Arm, type LedgerId } from "./delivery.js";
import { INSTRUMENT_EFFORT, MEASURED_EFFORT, VARIANT } from "./delivery-runtime.js";
import { json, text } from "./qualification-inputs.js";
import { AGENT, REPO, sha, write } from "./run.js";
import { numberLines, spanFound, treeHashes } from "./synthesis.js";

export const ADJ = join(ROOT, "adjudication");
export type Fam = "claude" | "gpt";
export const FAMS: Fam[] = ["claude", "gpt"];
export interface Reading { realization: string; stance: string; status: string; conditions: string; quote?: string; counterQuote?: string; lines?: number[]; note?: string }
export interface TextRef { ledger: LedgerId; label: string; arm: Arm; rep: number }
export const MEASURED: TextRef[] = LEDGERS.flatMap(l => REPS.flatMap(rep => ARMS.map(arm => ({ ledger: l.id, label: `${arm}-r${rep}`, arm, rep }))));
export const S_SAMPLE = 8, SECOND_SAMPLE = 10, WORKERS = 8;
const unitOf = (ledger: string) => LEDGERS.find(l => l.id === ledger)!.unit;
const validRelevance = (contextIncluded: boolean) => ["finding", "supporting", ...(contextIncluded ? ["requested_context"] : [])];
const pipelineOf = (ledger: string, label: string) => { const f = join(ROOT, "runs", ledger, label, "pipeline.json"); return existsSync(f) ? json(f) : undefined; };
const judgmentOf = (ledger: string, label: string, fam: Fam) => { const f = join(ROOT, "judgments", ledger, `${label}.${fam}.json`); return existsSync(f) ? json(f) : undefined; };

// ---- delivery predicates (protocol §8) -------------------------------------------------------------------------------------------------
export const MISSING: Reading = { realization: "missing", stance: "absent", status: "downgraded", conditions: "not_applicable" };
/** include/uncertain: complete ∧ as_required ∧ conditions kept/n.a.; correct: said not accurate (not missing) ∧ as_required ∧ conditions kept/n.a. */
export function delivered(e: Pick<LedgerEntry, "decision">, r: Reading | undefined, withConditions = true): boolean {
  if (!r) return false;
  const cond = !withConditions || r.conditions === "kept" || r.conditions === "not_applicable";
  if (e.decision === "include" || e.decision === "uncertain") return r.realization === "complete" && r.status === "as_required" && cond;
  if (e.decision === "correct") return r.realization !== "missing" && r.status === "as_required" && cond;
  return false;
}
/** An exclude entry a reader reports in any way (not missing, or a status other than as required) goes to adjudication. */
export const flagged = (r: Reading | undefined) => !!r && (r.realization !== "missing" || !["as_required", "not_applicable"].includes(r.status));
/** One reader's Tier-1 reading that an exclude entry is presented as answer content. */
export const presentedBy = (r: Reading | undefined) => !!r && (["upgraded", "mixed"].includes(r.status) || (["complete", "partial"].includes(r.realization) && ["asserted", "hedged", "mixed"].includes(r.stance)));
export function failureKinds(e: Pick<LedgerEntry, "decision">, r: Reading, withConditions = true): string[] {
  const out: string[] = [];
  if (r.realization === "missing") out.push("missing");
  if (e.decision !== "correct" && (r.realization === "opposed" || r.stance === "rejected")) out.push("contradicted");
  if (e.decision !== "correct" && r.realization === "partial") out.push("partial");
  if (r.status !== "as_required") out.push("status");
  if (withConditions && (r.conditions === "partial" || r.conditions === "lost")) out.push("conditions");
  return out;
}
const ORDER = { realization: ["complete", "partial", "opposed", "missing"], stance: ["absent", "rejected", "hedged", "asserted", "mixed"], status: ["as_required", "not_applicable", "downgraded", "upgraded", "mixed"], conditions: ["kept", "not_applicable", "partial", "lost"] };
/** Two readers merged per field: agreement, else conservative (worse realization/status/conditions, more asserting stance) or optimistic. */
export function merged(rs: (Reading | undefined)[], optimistic = false): Reading | undefined {
  const v = rs.filter((r): r is Reading => !!r);
  if (v.length < 2) return v[0];
  const [a, b] = v as [Reading, Reading];
  const pick = (k: keyof typeof ORDER) => { const x = String(a[k]), y = String(b[k]), worse = ORDER[k].indexOf(x) >= ORDER[k].indexOf(y) ? x : y; return optimistic ? (worse === x ? y : x) : worse; };
  return { realization: pick("realization"), stance: pick("stance"), status: pick("status"), conditions: pick("conditions") };
}
export function requiredReading(e: Pick<LedgerEntry, "decision">): Reading {
  if (e.decision === "uncertain") return { realization: "complete", stance: "hedged", status: "as_required", conditions: "kept" };
  if (e.decision === "correct") return { realization: "opposed", stance: "rejected", status: "as_required", conditions: "kept" };
  return { realization: "complete", stance: "asserted", status: "as_required", conditions: "kept" };
}
const distorted = (e: Pick<LedgerEntry, "decision">): Reading => e.decision === "include" ? { realization: "complete", stance: "hedged", status: "downgraded", conditions: "kept" } : { realization: "complete", stance: "asserted", status: "upgraded", conditions: "kept" };

// ---- references (secondary; labeller b, retry1 round-2 disputes as the second reading) ---------------------------------------------------
export function referencesOf(unit: string, second = false): Map<string, any> {
  const refs = new Map<string, any>(json(join(RETRY1, "references", `${unit}-b.json`)).items.map((v: any) => [v.id, { ...v }]));
  if (!second) return refs;
  const dir = join(RETRY1, unit, "adjudication"), seen = new Map<string, string>();
  if (!existsSync(dir)) return refs;
  for (const file of readdirSync(dir).filter(n => n.startsWith("accepted-") && n.endsWith(".json")).sort()) {
    for (const [id, entry] of Object.entries<any>(json(join(dir, file)).items ?? {})) {
      const dispute = entry?.referenceDispute, k = /:(k\d+)$/.exec(id)?.[1];
      if (!dispute || !k || !refs.has(k)) continue;
      const reading = JSON.stringify({ support: dispute.support, relevance: dispute.relevance }), r = refs.get(k);
      if (seen.has(k) && seen.get(k) !== reading) { r.support = "conflicting"; continue; }
      seen.set(k, reading);
      if (dispute.support) r.support = dispute.support;
      if (dispute.relevance) r.relevance = dispute.relevance;
    }
  }
  return refs;
}

// ---- text states and Tier-1 items ------------------------------------------------------------------------------------------------------
export interface TextState { ledger: LedgerId; label: string; status: "judged" | "no-deliverable" | "incomplete"; reason?: string; body?: string; judgments?: any[]; readers?: Map<string, Reading>[] }
export function stateOf(ledger: LedgerId, label: string): TextState {
  if (label !== "hist") {
    const p = pipelineOf(ledger, label);
    if (!p) return { ledger, label, status: "incomplete", reason: "cell not run" };
    if (p.status !== "complete") return { ledger, label, status: "incomplete", reason: `cell ${p.status}` };
    if (p.deliverable === false) return { ledger, label, status: "no-deliverable" };
  }
  const body = finalTextOf(ledger, label);
  if (body === undefined) return { ledger, label, status: "incomplete", reason: "no final text" };
  const js = FAMS.map(f => judgmentOf(ledger, label, f));
  const bad = js.flatMap((j, i) => !j ? [`${FAMS[i]} judgment missing`] : !j.valid ? [`${FAMS[i]} judgment invalid`] : j.textSha256 !== sha(body) ? [`${FAMS[i]} judgment is of another text`] : []);
  if (bad.length) return { ledger, label, status: "incomplete", reason: bad.join("; "), body };
  return { ledger, label, status: "judged", body, judgments: js, readers: js.map(j => new Map<string, Reading>(j.value.items.map((i: any) => [i.id, i]))) };
}
/** Origin-masked text ids: the measured texts ordered by the sha256 of their bytes (T01...). */
export function opaqueIds(): Map<string, string> {
  const rows = MEASURED.flatMap(t => { const body = finalTextOf(t.ledger, t.label); return body === undefined ? [] : [{ key: `${t.ledger}/${t.label}`, h: sha(body) }]; });
  rows.sort((a, b) => a.h.localeCompare(b.h));
  return new Map(rows.map((r, i) => [r.key, `T${String(i + 1).padStart(2, "0")}`]));
}
export interface Item { item: string; kind: "R" | "S" | "O" | "X"; text: string; ledger: LedgerId; entry?: any; exclude?: boolean; readers?: any[]; alleged?: any[]; evidence?: string[]; purpose?: "adjudicate" | "resolve" | "second" }
const entryView = (e: LedgerEntry) => ({ id: e.id, decision: e.decision, required: e.required, statement: e.statement, sourceStance: e.sourceStance, conditions: e.conditions, note: e.note, duplicateOf: e.duplicateOf });
const readerView = (r: Reading | undefined) => r ? { realization: r.realization, stance: r.stance, status: r.status, conditions: r.conditions, quote: r.quote ?? "", counterQuote: r.counterQuote ?? "", lines: r.lines ?? [], note: r.note ?? "" } : { missing: true };
function locate(q: unknown, body: string): [number, number] | undefined { if (typeof q !== "string" || !q.trim()) return undefined; const i = body.indexOf(q.trim()); return i < 0 ? undefined : [i, i + q.trim().length]; }
/** Twins: verbatim quote ranges overlapping by at least half of the shorter quote; without locatable quotes, a shared line. */
export function overlapping(a: { quote?: unknown; lines?: number[] }, b: { quote?: unknown; lines?: number[] }, body: string): boolean {
  const ra = locate(a.quote, body), rb = locate(b.quote, body);
  if (ra && rb) return Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]) >= 0.5 * Math.min(ra[1] - ra[0], rb[1] - rb[0]);
  const la = new Set(a.lines ?? []);
  return (b.lines ?? []).some(n => la.has(n));
}
export function clusters<T>(xs: T[], same: (a: T, b: T) => boolean): T[][] {
  const parent = xs.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (same(xs[i]!, xs[j]!)) parent[find(j)] = find(i);
  const groups = new Map<number, T[]>();
  xs.forEach((x, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), x]); });
  return [...groups.values()];
}
export const EVIDENCE: Record<string, string[]> = {
  "dev-r1": ["results/qualification-validation-retry1/inputs/dev-r1/doc-A-evidence.jsonl and doc-B-evidence.jsonl (frozen tool evidence of the earlier analyses)", "results/qualification-validation-retry1/inputs/dev-r1/evidence-index.json", "results/qualification-validation-retry1/inputs/dev-r1/doc-A.md and doc-B.md (the earlier analyses: claims, not proof)", "code of the analysed commit, read-only: git -C /home/arthur/Code/oh-my-pi-extensions/orche show 2de1f04:<path> (and git ls-tree -r 2de1f04)"],
  "isort-r1": ["results/qualification-validation-retry1/inputs/isort-r1/doc-A-evidence.jsonl and doc-B-evidence.jsonl (frozen tool evidence of the earlier analyses)", "results/qualification-validation-retry1/inputs/isort-r1/evidence-index.json", "results/qualification-validation-retry1/inputs/isort-r1/doc-A.md and doc-B.md (the earlier analyses: claims, not proof)", "code snapshot, read-only: results/advisor-reviewer/cache/swe/pycqa__isort-2491/src", "fixtures/advisor-bench/swe/pycqa__isort-2491/hidden/test.patch and reference/fix.patch (read-only)"],
};
const sampleRank = (salt: string) => (a: string, b: string) => sha(`${salt}:${a}`).localeCompare(sha(`${salt}:${b}`));
/** Round-1 items (protocol §7): R, S, O, X per judged measured text. `reader` fields are internal and stripped from packets. */
export function roundOneItems(): Item[] {
  const ids = opaqueIds(), items: Item[] = [];
  for (const t of MEASURED) {
    const s = stateOf(t.ledger, t.label);
    if (s.status !== "judged") continue;
    const tid = ids.get(`${t.ledger}/${t.label}`)!, body = s.body!, l = ledgerOf(t.ledger), readers = s.readers!;
    const order = (k: string) => [0, 1].sort((a, b) => sha(`${tid}:${k}:${FAMS[a]}`).localeCompare(sha(`${tid}:${k}:${FAMS[b]}`)));
    const views = (k: string) => order(k).map((i, n) => ({ reader: n + 1, ...readerView(readers[i]!.get(k)) }));
    const agreed: string[] = [];
    for (const e of l.entries) {
      const rs = readers.map(m => m.get(e.id));
      if (APPROVED.includes(e.decision)) {
        if (rs.every(r => delivered(e, r))) { agreed.push(e.id); continue; }
        items.push({ item: `R-${tid}-${e.id}`, kind: "R", text: tid, ledger: t.ledger, entry: entryView(e), readers: views(e.id) });
      } else if (e.decision === "exclude" && rs.some(flagged)) items.push({ item: `R-${tid}-${e.id}`, kind: "R", text: tid, ledger: t.ledger, exclude: true, entry: entryView(e), readers: views(e.id) });
    }
    const byId = new Map(l.entries.map(e => [e.id, e]));
    for (const id of [...agreed].sort(sampleRank(`S:${t.ledger}:${t.label}`)).slice(0, S_SAMPLE)) items.push({ item: `S-${tid}-${id}`, kind: "S", text: tid, ledger: t.ledger, entry: entryView(byId.get(id)!) });
    const others = s.judgments!.flatMap((j, r) => (j.value.other as any[]).filter(o => o?.source === "none" || o?.source === "unclear").map(o => ({ claim: String(o.claim ?? ""), quote: String(o.quote ?? ""), lines: Array.isArray(o.lines) ? o.lines : [], source: o.source, ids: Array.isArray(o.ids) ? o.ids : [], reader: FAMS[r] })));
    clusters(others, (a, b) => overlapping(a, b, body)).forEach((group, n) => items.push({ item: `O-${tid}-${n + 1}`, kind: "O", text: tid, ledger: t.ledger, alleged: group, evidence: EVIDENCE[unitOf(t.ledger)] }));
    const contradictions = s.judgments!.flatMap((j, r) => (j.value.contradictions as any[]).map(c => ({ a: String(c?.a ?? ""), b: String(c?.b ?? ""), note: String(c?.note ?? ""), reader: FAMS[r] })));
    const sameX = (x: any, y: any) => (overlapping({ quote: x.a }, { quote: y.a }, body) && overlapping({ quote: x.b }, { quote: y.b }, body)) || (overlapping({ quote: x.a }, { quote: y.b }, body) && overlapping({ quote: x.b }, { quote: y.a }, body));
    clusters(contradictions, sameX).forEach((group, n) => items.push({ item: `X-${tid}-${n + 1}`, kind: "X", text: tid, ledger: t.ledger, alleged: group }));
  }
  return items;
}

// ---- host-verification packets -----------------------------------------------------------------------------------------------------------
const WEIGHT: Record<Item["kind"], number> = { R: 1, S: 1, X: 1, O: 3 };
const weightOf = (xs: Item[]) => xs.reduce((n, i) => n + WEIGHT[i.kind], 0);
/** At most `workers` packets: each text's items split into chunks of about total/workers weight, then longest-processing-time binning. */
export function assign(items: Item[], workers = WORKERS): Item[][] {
  const byText = new Map<string, Item[]>();
  for (const i of items) byText.set(i.text, [...(byText.get(i.text) ?? []), i]);
  const cap = Math.max(1, Math.ceil(weightOf(items) / workers)), chunks: Item[][] = [];
  for (const xs of [...byText.values()]) { const n = Math.max(1, Math.ceil(weightOf(xs) / cap)), size = Math.ceil(xs.length / n); for (let i = 0; i < xs.length; i += size) chunks.push(xs.slice(i, i + size)); }
  chunks.sort((a, b) => weightOf(b) - weightOf(a) || a[0]!.item.localeCompare(b[0]!.item));
  const bins: Item[][] = Array.from({ length: Math.min(workers, chunks.length) }, () => []);
  for (const c of chunks) bins.reduce((best, b) => weightOf(b) < weightOf(best) ? b : best, bins[0]!).push(...c);
  return bins.filter(b => b.length);
}
const packetItem = (i: Item) => { const { purpose: _p, ...rest } = i; return { ...rest, ...(rest.alleged ? { alleged: rest.alleged.map(({ reader: _r, ...a }: any) => a) } : {}) }; };
export function instructions(packet: string, round: number, packetDir: string): string {
  const rel = packetDir.slice(REPO.length + 1), studyRel = ROOT.slice(REPO.length + 1), earlier = VARIANT.baseline ? `, nothing under ${VARIANT.baseline}/ (an earlier study)` : "";
  return `# Host verification packet ${packet} (delivery-only validation, round ${round})

You verify readings of delivered answers for an evaluation. You are read-only: do not create, edit or delete files in the repository (scratch files only in your own /tmp scratch directory). Do not guess: every decision needs verbatim evidence; if you cannot decide, mark the item unresolved and say why.

Packet directory: ${rel}/
- texts/T<nn>.md: COMPLETE delivered answers. Every line starts with "L<n>: " (not part of the text). Summary, body, appendix, notes and generated sections all count equally. Never decide that something is missing before searching the whole text (read it completely; search for key terms and paraphrases).
- ledgers/<ledger>.json: the frozen decision ledger each answer was built from (per entry: id, decision, required delivery, statement, sourceStance, conditions, note, duplicateOf). The decisions are fixed; you do not judge whether they were right, except where an O item asks for support/relevance of a NEW claim.
- ledgers/<ledger>.background.json: evidence, taskLink and cited locations of the same entries (only to decide whether a claim of the text comes from the ledger).
- task/<ledger>.task.md and task/<ledger>.guide.md: the task the answers respond to and its interpretation.
- items.json: your items (field "text" names the text file).

Masking: the origin of each text is hidden on purpose. Do not try to find out which process or condition produced a text. Do not open anything under ${studyRel} other than this packet directory (in particular not runs/, judgments/, pairwise/, judge-runs/, pairwise-runs/, preflight/, adjudication/ outside this packet, manifest or score files)${earlier}, and no earlier study's judgments, reports or references. For O items you may read the frozen evidence listed in the item's "evidence" field.

Item kinds:
- R: a ledger entry whose delivery two independent readers disagreed on or both reported as failed. Their readings are in "readers" (pointers only, not evidence of absence). Decide yourself, for the entry's statement AS WORDED (its own negation, conditions, specifics) anywhere in the text, in any wording:
  realization complete | partial (core present but a substantive element missing or changed) | missing | opposed (the text says it is false or not accurate);
  stance asserted | hedged (unverified, disputed, uncertain, open) | rejected | absent | mixed (one occurrence asserts while another hedges or rejects);
  status, compared with the entry's "required" delivery: as_required | upgraded (more accepted or certain than required: an uncertain entry asserted, a corrected entry restated as accurate, an excluded entry presented as answer content) | downgraded (less than required: an accepted entry hedged, rejected or only mentioned as uncertain) | mixed | not_applicable;
  conditions: kept (every listed condition/limit, and for uncertain and correct entries the note, is conveyed where the entry is delivered) | partial | lost | not_applicable (no conditions and no note required, or the entry is not delivered).
  For an entry with decision "exclude" (item field "exclude": true) also decide presented true|false: is this statement, or substance of it beyond what approved (include/uncertain/correct) ledger entries say, presented as answer content anywhere in the text?
- S: an entry both readers called delivered (a sample to check over-credit). Decide the same four fields independently.
- O: claims of the text that a reader could not trace to the ledger ("alleged"). Decide origin: ledger (expressed by a ledger entry's statement, condition/limit or note; give ledgerIds), ledger_background (only from an entry's evidence or taskLink; give ledgerIds), new (a substantive claim about the task's subject traceable to no ledger field), or not_a_claim (formatting, navigation, generated counts, a restatement of the task). Twin allegations of the same claim count once. For EVERY distinct new claim give: claim (short), quote (verbatim), stance asserted|hedged, support supported|refuted|insufficient|conflicting judged against the frozen evidence/code (basis: path:line or command and result), relevance finding|supporting|requested_context|out|ambiguous judged against task.md and guide.md.
- X: an alleged internal contradiction between passages ("alleged"). Decide confirmed true|false (do the passages, read in context, contradict each other?).

Return everything in report_result: kind "verify", a short summary, and data exactly in this form (one verdict per item of items.json):
{"packet":"${packet}","round":${round},"items":[
 {"item":"R-...","realization":"complete","stance":"asserted","status":"as_required","conditions":"kept","presented":null,"quotes":[{"line":12,"quote":"verbatim text without the L-prefix"}],"reason":"...","resolved":true},
 {"item":"S-...","realization":"...","stance":"...","status":"...","conditions":"...","quotes":[...],"reason":"...","resolved":true},
 {"item":"O-...","origin":"new","ledgerIds":[],"claims":[{"claim":"...","quote":"verbatim","stance":"asserted","support":"supported","basis":"path:line ...","relevance":"supporting"}],"reason":"...","resolved":true},
 {"item":"X-...","confirmed":false,"quotes":[...],"reason":"...","resolved":true},
 {"item":"...","resolved":false,"reason":"why it cannot be decided"}
]}
Quotes are copied exactly from the text (at least 3 words; without the "L<n>: " prefix). For realization "missing" quotes may be empty, but reason must say what you searched for. Before reporting, validate your JSON (write it to your scratch directory) with:
  node --import tsx experiments/mdsd-ab/delivery-eval.ts check-verdicts ${rel} <your verdicts.json>
(run from the repository root /home/arthur/Code/oh-my-pi-extensions/orche); fix every error it reports.
`;
}
export async function writePackets(round: number, items: Item[]): Promise<void> {
  const dir = join(ADJ, `round-${round}`);
  if (existsSync(join(dir, "items.json"))) throw new Error(`round ${round} packets exist; never overwrite`);
  const bins = assign(items), byTid = new Map([...opaqueIds().entries()].map(([k, v]) => [v, k])), assignment: Record<string, string> = {};
  for (const [n, bin] of bins.entries()) {
    const name = `P${round}-${n + 1}`, p = join(dir, "packets", name);
    for (const sub of ["texts", "ledgers", "task"]) await mkdir(join(p, sub), { recursive: true });
    for (const tid of new Set(bin.map(i => i.text))) { const [ledger, label] = byTid.get(tid)!.split("/") as [LedgerId, string]; await writeFile(join(p, "texts", `${tid}.md`), numberLines(finalTextOf(ledger, label)!)); }
    for (const ledger of new Set(bin.map(i => i.ledger))) {
      await writeFile(join(p, "ledgers", `${ledger}.json`), text(join(ledgerDir(ledger), "judge-ledger.json")));
      await writeFile(join(p, "ledgers", `${ledger}.background.json`), text(join(ledgerDir(ledger), "judge-background.json")));
      await writeFile(join(p, "task", `${ledger}.task.md`), text(join(ledgerDir(ledger), "task.md")));
      await writeFile(join(p, "task", `${ledger}.guide.md`), text(join(ledgerDir(ledger), "guide.md")));
    }
    await write(join(p, "items.json"), { packet: name, round, items: bin.map(packetItem) });
    await writeFile(join(p, "instructions.md"), instructions(name, round, p));
    for (const i of bin) assignment[i.item] = name;
  }
  await write(join(dir, "items.json"), { round, createdAt: new Date().toISOString(), counts: countKinds(items), items, assignment, packets: bins.map((b, n) => ({ packet: `P${round}-${n + 1}`, items: b.length, weight: weightOf(b), texts: [...new Set(b.map(i => i.text))], kinds: countKinds(b) })) });
}
const countKinds = (xs: Item[]) => xs.reduce((acc: Record<string, number>, i) => { acc[i.kind] = (acc[i.kind] ?? 0) + 1; return acc; }, {});

// ---- verdicts ------------------------------------------------------------------------------------------------------------------------
const REALIZATION = ORDER.realization, STANCE = ORDER.stance, STATUS = ORDER.status, CONDITIONS = ORDER.conditions;
const ORIGINS = ["ledger", "ledger_background", "new", "not_a_claim"], SUPPORT = ["supported", "refuted", "insufficient", "conflicting"], RELEVANCE = ["finding", "supporting", "requested_context", "out", "ambiguous"];
const quoteOk = (q: unknown, body: string) => typeof q === "string" && q.trim().length > 0 && (body.includes(q.trim()) || spanFound(q, body, 3));
/** Schema and verbatim-evidence check of one packet's verdicts; an invalid verdict is recorded and treated as unresolved. */
export function checkVerdicts(items: Item[], data: any, bodies: Map<string, string>): { errors: string[]; valid: Map<string, any> } {
  const errors: string[] = [], valid = new Map<string, any>();
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) return { errors: ["data.items must be an array"], valid };
  const byItem = new Map<string, any[]>();
  for (const v of data.items) byItem.set(String(v?.item), [...(byItem.get(String(v?.item)) ?? []), v]);
  for (const id of byItem.keys()) if (!items.some(i => i.item === id)) errors.push(`${id}: not an item of this packet`);
  for (const i of items) {
    const vs = byItem.get(i.item) ?? [], body = bodies.get(i.text) ?? "", errs: string[] = [];
    if (vs.length !== 1) { errors.push(`${i.item}: ${vs.length} verdicts (exactly one required)`); continue; }
    const v = vs[0];
    if (v.resolved === false) { if (!String(v.reason ?? "").trim()) errs.push("unresolved without reason"); }
    else if (v.resolved !== true) errs.push("resolved must be true or false");
    else if (i.kind === "R" || i.kind === "S") {
      if (!REALIZATION.includes(v.realization)) errs.push("realization"); if (!STANCE.includes(v.stance)) errs.push("stance"); if (!STATUS.includes(v.status)) errs.push("status"); if (!CONDITIONS.includes(v.conditions)) errs.push("conditions");
      if (i.exclude && typeof v.presented !== "boolean") errs.push("presented must be true or false for an exclude entry");
      const quotes = Array.isArray(v.quotes) ? v.quotes : [];
      if (v.realization !== "missing" && !quotes.length) errs.push("quotes required unless realization is missing");
      if (v.realization === "missing" && !String(v.reason ?? "").trim()) errs.push("missing needs a reason saying what was searched");
      quotes.forEach((q: any, n: number) => { if (!quoteOk(q?.quote, body)) errs.push(`quote ${n + 1} not found verbatim`); });
    } else if (i.kind === "O") {
      if (!ORIGINS.includes(v.origin)) errs.push("origin");
      if (v.origin === "new") {
        if (!Array.isArray(v.claims) || !v.claims.length) errs.push("new origin needs claims");
        else v.claims.forEach((c: any, n: number) => { if (!String(c?.claim ?? "").trim()) errs.push(`claim ${n + 1}: claim`); if (!quoteOk(c?.quote, body)) errs.push(`claim ${n + 1}: quote not found verbatim`); if (!["asserted", "hedged"].includes(c?.stance)) errs.push(`claim ${n + 1}: stance`); if (!SUPPORT.includes(c?.support)) errs.push(`claim ${n + 1}: support`); if (!RELEVANCE.includes(c?.relevance)) errs.push(`claim ${n + 1}: relevance`); if (!String(c?.basis ?? "").trim()) errs.push(`claim ${n + 1}: basis`); });
      } else if ((v.origin === "ledger" || v.origin === "ledger_background") && (!Array.isArray(v.ledgerIds) || !v.ledgerIds.length)) errs.push("ledger origin needs ledgerIds");
    } else if (i.kind === "X") {
      if (typeof v.confirmed !== "boolean") errs.push("confirmed must be true or false");
      (Array.isArray(v.quotes) ? v.quotes : []).forEach((q: any, n: number) => { if (!quoteOk(q?.quote, body)) errs.push(`quote ${n + 1} not found verbatim`); });
    }
    if (errs.length) errors.push(`${i.item}: ${errs.join("; ")}`); else valid.set(i.item, v);
  }
  return { errors, valid };
}
const packetBodies = (dir: string) => new Map(readdirSync(join(dir, "texts")).map(f => [f.replace(/\.md$/, ""), text(join(dir, "texts", f)).split("\n").map(l => l.replace(/^L\d+: /, "")).join("\n")]));
/** The last report_result data of a worker session file (orche records). */
export function reportData(sessionFile: string): any {
  let data: any;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    for (const c of o?.message?.role === "assistant" ? o.message.content ?? [] : []) if ((c.type === "toolCall" || c.type === "tool_use") && /report_result$/.test(String(c.name))) data = (c.arguments ?? c.input)?.data;
  }
  const find = (x: any): any => !x || typeof x !== "object" ? undefined : Array.isArray(x.items) && typeof x.packet === "string" ? x : Object.values(x).map(find).find(Boolean);
  return find(data);
}
export async function collect(round: number, files: string[]): Promise<void> {
  const dir = join(ADJ, `round-${round}`), meta = json(join(dir, "items.json")), all = meta.items as Item[];
  await mkdir(join(dir, "results"), { recursive: true });
  for (const file of files) {
    const data = reportData(file);
    if (!data) { console.error(`${file}: no report_result data with packet/items`); continue; }
    const out = join(dir, "results", `${data.packet}.json`);
    if (existsSync(out)) { console.error(`${out} exists; not overwritten`); continue; }
    const packetDir = join(dir, "packets", data.packet), items = all.filter(i => meta.assignment[i.item] === data.packet);
    const c = checkVerdicts(items, data, packetBodies(packetDir));
    await write(out, { packet: data.packet, round, session: file, sessionSha256: sha(readFileSync(file)), collectedAt: new Date().toISOString(), errors: c.errors, validVerdicts: c.valid.size, items: items.length, data });
    console.log(data.packet, `valid ${c.valid.size}/${items.length}`, c.errors.slice(0, 5));
  }
}
/** Accepted verdicts: round 1 for every round-1 item; round 2 resolves its "resolve" items and records "second" readings separately. */
export function acceptedVerdicts(): { verdicts: Map<string, any>; second: Map<string, { first: any; second: any }>; items: Map<string, Item>; rounds: number[] } {
  const verdicts = new Map<string, any>(), second = new Map<string, { first: any; second: any }>(), items = new Map<string, Item>(), rounds: number[] = [];
  for (const round of [1, 2]) {
    const dir = join(ADJ, `round-${round}`);
    if (!existsSync(join(dir, "items.json"))) continue;
    rounds.push(round);
    const meta = json(join(dir, "items.json")), list = meta.items as Item[];
    const results = existsSync(join(dir, "results")) ? readdirSync(join(dir, "results")).map(f => json(join(dir, "results", f))) : [];
    for (const r of results) {
      const packetItems = list.filter(i => meta.assignment[i.item] === r.packet), c = checkVerdicts(packetItems, r.data, packetBodies(join(dir, "packets", r.packet)));
      for (const i of packetItems) {
        const v = c.valid.get(i.item);
        if (round === 1) { items.set(i.item, i); if (v) verdicts.set(i.item, v); }
        else if (i.purpose === "second") second.set(i.item, { first: verdicts.get(i.item), second: v });
        else if (v && v.resolved) verdicts.set(i.item, v);
      }
    }
    if (round === 1) for (const i of list) items.set(i.item, i);
  }
  return { verdicts, second, items, rounds };
}

// ---- measures (protocol §8) -------------------------------------------------------------------------------------------------------------
export type Vec = Record<string, number>;
export interface Options { withConditions: boolean; contextIncluded: boolean; secondReference: boolean; tier1?: "conservative" | "optimistic"; applySample: boolean; k62?: "delivered" | "failed" }
/** The ledger entry whose cross-entry conflict was adjudicated inconsistently in the max study (replication protocol §7.1). */
export const K62 = { ledger: "isort-r1.Q-r2", id: "k62" } as const;
/**
 * Uniform k62 readings (replication protocol §7.1), the same rule for both arms; only k62's status changes. delivered: as_required where
 * the accepted reading is complete with conditions kept/n.a.; failed: mixed where any Tier-1 reader or the accepted reading says mixed.
 */
export function k62Reading(mode: "delivered" | "failed", accepted: Reading, readers: (Reading | undefined)[]): Reading {
  if (mode === "delivered") return accepted.realization === "complete" && (accepted.conditions === "kept" || accepted.conditions === "not_applicable") ? { ...accepted, status: "as_required" } : accepted;
  return accepted.status === "mixed" || readers.some(r => r?.status === "mixed") ? { ...accepted, status: "mixed" } : accepted;
}
export const MAIN: Options = { withConditions: true, contextIncluded: true, secondReference: false, applySample: true };
const add = (a: Vec, b: Vec) => { for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v; return a; };
/** Contribution of one registered entry under one reading. `presented` decides exclude entries; duplicates follow their target. */
export function entryVec(e: LedgerEntry, reading: Reading | undefined, ref: any, opts: Options, presented = false, targetDelivered = true): Vec {
  const v: Vec = {};
  if (APPROVED.includes(e.decision) && !delivered(e, reading, opts.withConditions)) { v.DL = 1; for (const k of failureKinds(e, reading ?? MISSING, opts.withConditions)) v[`DL${k}`] = 1; }
  if (e.decision === "exclude" && presented) v.EL = 1;
  const s = e.decision === "exclude" && !presented ? MISSING : reading ?? MISSING;
  const realized = s.realization === "complete" && ["asserted", "hedged"].includes(s.stance);
  const asserted = ["complete", "partial"].includes(s.realization) && ["asserted", "mixed"].includes(s.stance);
  const hedged = ["complete", "partial"].includes(s.realization) && s.stance === "hedged";
  const valid = ref?.support === "supported" && validRelevance(opts.contextIncluded).includes(ref?.relevance);
  if (valid) { if (realized) v.VD = 1; else { v.VL = 1; v[e.decision === "correct" || e.decision === "exclude" || (e.decision === "duplicate" && targetDelivered) ? "VLledger" : "VLdelivery"] = 1; } }
  const f = ref?.support === "refuted", o = ref?.relevance === "out", u = ["insufficient", "conflicting"].includes(ref?.support);
  if (asserted && (f || o || u)) { if (f) v.F = 1; if (o) v.O = 1; if (u) v.U = 1; v.FOU = 1; v[e.decision === "include" || e.decision === "duplicate" ? "FOUledger" : "FOUdelivery"] = 1; }
  if (valid && e.sourceStance === "asserted" && hedged) { v.H = 1; v[e.decision === "uncertain" ? "Hledger" : "Hdelivery"] = 1; }
  return v;
}
export function newClaimVec(claims: any[]): Vec {
  const v: Vec = {};
  for (const c of claims) {
    const valid = c.support === "supported" && validRelevance(true).includes(c.relevance), f = c.support === "refuted", o = c.relevance === "out", u = ["insufficient", "conflicting"].includes(c.support) && c.stance === "asserted";
    add(v, { UA: 1, ...(valid ? { UAvalid: 1 } : f || o || u ? { UAinvalid: 1 } : { UAundetermined: 1 }), ...(f ? { newF: 1 } : {}), ...(o ? { newO: 1 } : {}), ...(u ? { newU: 1 } : {}), ...(f || o || u ? { newFOU: 1 } : {}) });
  }
  return v;
}
const minVec = (vs: Vec[]) => { const keys = new Set(vs.flatMap(v => Object.keys(v))), out: Vec = {}; for (const k of keys) out[k] = Math.min(...vs.map(v => v[k] ?? 0)); return out; };
const maxVec = (vs: Vec[]) => { const keys = new Set(vs.flatMap(v => Object.keys(v))), out: Vec = {}; for (const k of keys) out[k] = Math.max(...vs.map(v => v[k] ?? 0)); return out; };
export interface TextMeasures { status: string; reason?: string; base: Vec; lo: Vec; hi: Vec; unresolved: string[]; detail: any }
/** All measures of one text: base (unresolved items at the conservative Tier-1 reading), lo/hi (each unresolved item at its extremes). */
export function measure(ledger: LedgerId, label: string, opts: Options, adj = acceptedVerdicts(), tid?: string): TextMeasures {
  const s = stateOf(ledger, label), l = ledgerOf(ledger), refs = referencesOf(unitOf(ledger), opts.secondReference), base: Vec = {}, lo: Vec = {}, hi: Vec = {}, unresolved: string[] = [], detail: any = { DL: [], EL: [], UA: [], X: [] };
  const both = (v: Vec) => { add(base, v); add(lo, v); add(hi, v); };
  if (s.status === "incomplete") return { status: "incomplete", reason: s.reason, base, lo, hi, unresolved, detail };
  if (s.status === "no-deliverable") { for (const e of l.entries) both(entryVec(e, undefined, refs.get(e.id), opts)); detail.DL = l.entries.filter(e => APPROVED.includes(e.decision)).map(e => e.id); return { status: "no-deliverable", base, lo, hi, unresolved, detail }; }
  const readers = s.readers!, key = (kind: string, k: string) => `${kind}-${tid}-${k}`;
  const verdictOf = (kind: string, k: string) => tid && !opts.tier1 ? adj.verdicts.get(key(kind, k)) : undefined;
  const itemOf = (kind: string, k: string) => tid && !opts.tier1 ? adj.items.get(key(kind, k)) : undefined;
  // approved entries first (duplicates need their target's delivery)
  const deliveredMap = new Map<string, boolean>();
  const readingOf = (e: LedgerEntry): { reading?: Reading; open?: Reading[] ; presented?: boolean; openPresented?: boolean } => {
    const rs = readers.map(m => m.get(e.id));
    if (opts.tier1) {
      if (e.decision === "exclude") return { reading: merged(rs, opts.tier1 === "optimistic"), presented: opts.tier1 === "optimistic" ? rs.every(presentedBy) : rs.some(presentedBy) };
      return { reading: merged(rs, opts.tier1 === "optimistic") };
    }
    const r = itemOf("R", e.id), v = verdictOf("R", e.id);
    if (r) {
      if (v?.resolved) return { reading: v as Reading, presented: e.decision === "exclude" ? v.presented === true : undefined };
      return e.decision === "exclude" ? { reading: merged(rs), presented: rs.some(presentedBy), openPresented: true } : { reading: merged(rs), open: [requiredReading(e), MISSING, distorted(e)] };
    }
    const sv = verdictOf("S", e.id);
    if (sv?.resolved && opts.applySample) return { reading: sv as Reading };
    return { reading: merged(rs), presented: false };
  };
  const rows = new Map(l.entries.map(e => [e.id, readingOf(e)]));
  const k62Row = opts.k62 && !opts.tier1 && ledger === K62.ledger ? rows.get(K62.id) : undefined;
  if (k62Row?.reading && !k62Row.open) k62Row.reading = k62Reading(opts.k62!, k62Row.reading, readers.map(m => m.get(K62.id)));
  for (const e of l.entries) deliveredMap.set(e.id, delivered(e, rows.get(e.id)!.reading, opts.withConditions));
  for (const e of l.entries) {
    const row = rows.get(e.id)!, ref = refs.get(e.id), targetDelivered = e.duplicateOf ? deliveredMap.get(e.duplicateOf) ?? false : true;
    const v = entryVec(e, row.reading, ref, opts, row.presented ?? false, targetDelivered);
    if (row.open || row.openPresented) {
      const options = row.open ? row.open.map(r => entryVec(e, r, ref, opts, false, targetDelivered)) : [entryVec(e, MISSING, ref, opts, false, targetDelivered), entryVec(e, { realization: "complete", stance: "asserted", status: "upgraded", conditions: "not_applicable" }, ref, opts, true, targetDelivered)];
      add(base, v); add(lo, minVec([v, ...options])); add(hi, maxVec([v, ...options])); unresolved.push(`R-${tid}-${e.id}`);
    } else both(v);
    if (v.DL) detail.DL.push({ id: e.id, decision: e.decision, kinds: failureKinds(e, row.reading ?? MISSING, opts.withConditions) });
    if (v.EL) detail.EL.push(e.id);
  }
  // other claims and contradictions
  const items = tid && !opts.tier1 ? [...adj.items.values()].filter(i => i.text === tid) : [];
  if (opts.tier1) {
    const t1 = roundOneItemsFor(ledger, label, s);
    const keep = (group: any[]) => opts.tier1 === "optimistic" ? new Set(group.map((g: any) => g.reader)).size === 2 : true;
    both({ UA: t1.O.filter(keep).length, UAundetermined: t1.O.filter(keep).length, X: t1.X.filter(keep).length });
  } else {
    for (const i of items.filter(i => i.kind === "O")) {
      const v = adj.verdicts.get(i.item);
      if (v?.resolved) { if (v.origin === "new") { const vec = newClaimVec(v.claims); both(vec); detail.UA.push({ item: i.item, claims: v.claims.length }); } }
      else { const open = { UA: 1, UAundetermined: 1 }; add(base, open); add(hi, { UA: 1, UAinvalid: 1, newFOU: 1 }); unresolved.push(i.item); }
    }
    for (const i of items.filter(i => i.kind === "X")) {
      const v = adj.verdicts.get(i.item);
      if (v?.resolved) { if (v.confirmed) { both({ X: 1 }); detail.X.push(i.item); } }
      else { add(base, { X: 1 }); add(hi, { X: 1 }); unresolved.push(i.item); }
    }
  }
  for (const vec of [base, lo, hi]) { vec.FOUd = (vec.FOUdelivery ?? 0) + (vec.newFOU ?? 0); vec.UAinvalid = vec.UAinvalid ?? 0; }
  return { status: s.status, base, lo, hi, unresolved, detail };
}
/** Tier-1 O/X clusters of one judged text (for the instrument-sensitivity merges). */
function roundOneItemsFor(ledger: LedgerId, label: string, s: TextState): { O: any[][]; X: any[][] } {
  const body = s.body!, others = s.judgments!.flatMap((j, r) => (j.value.other as any[]).filter(o => o?.source === "none" || o?.source === "unclear").map(o => ({ quote: o.quote, lines: o.lines ?? [], reader: FAMS[r] })));
  const contradictions = s.judgments!.flatMap((j, r) => (j.value.contradictions as any[]).map(c => ({ a: c?.a, b: c?.b, reader: FAMS[r] })));
  const sameX = (x: any, y: any) => (overlapping({ quote: x.a }, { quote: y.a }, body) && overlapping({ quote: x.b }, { quote: y.b }, body)) || (overlapping({ quote: x.a }, { quote: y.b }, body) && overlapping({ quote: x.b }, { quote: y.a }, body));
  void ledger; void label; // the state already identifies the text
  return { O: clusters(others, (a, b) => overlapping(a, b, body)), X: clusters(contradictions, sameX) };
}

// ---- verdicts (protocol §9) -----------------------------------------------------------------------------------------------------------
export const PRIMARY_KEYS = ["DL", "UA", "EL", "UAinvalid", "X", "FOUd", "VD"] as const;
export type Usefulness = "cost" | "gain" | "none" | "unmeasured";
export function classify(b: Vec, c: Vec, usefulness: Usefulness): { class: string; primary: boolean; gates: boolean } {
  const g = (k: string) => b[k] ?? 0, h = (k: string) => c[k] ?? 0;
  const gates = g("EL") <= h("EL") && g("UAinvalid") <= h("UAinvalid") && g("X") <= h("X") && g("FOUd") <= h("FOUd") && g("VD") >= h("VD");
  const primary = (g("DL") < h("DL") && g("UA") <= h("UA")) || (g("UA") < h("UA") && g("DL") <= h("DL"));
  if (primary && gates) return { class: usefulness === "cost" ? "improved-with-usefulness-cost" : usefulness === "unmeasured" ? "improved (usefulness unmeasured)" : "improved", primary, gates };
  if (["DL", "UA", "EL", "X", "FOUd", "VD"].every(k => g(k) === h(k))) return { class: "tie", primary, gates };
  const worse = ["DL", "UA", "EL", "UAinvalid", "X", "FOUd"].some(k => g(k) > h(k)) || g("VD") < h("VD");
  const better = ["DL", "UA", "EL", "UAinvalid", "X", "FOUd"].some(k => g(k) < h(k)) || g("VD") > h("VD");
  return { class: worse && !better ? "regression" : "mixed", primary, gates };
}
/** Pair class with unresolved items: B best (B lo, C hi) and B worst (B hi, C lo); one class if both agree, else unresolved. */
export function pairClass(b: TextMeasures, c: TextMeasures, usefulness: Usefulness): any {
  if (b.status === "incomplete" || c.status === "incomplete") return { class: "incomplete", reason: [b.reason, c.reason].filter(Boolean).join("; ") };
  const best = classify(lowBad(b), highBad(c), usefulness), worst = classify(highBad(b), lowBad(c), usefulness), point = classify(b.base, c.base, usefulness);
  return best.class === worst.class ? { class: best.class, primary: best.primary, gates: best.gates, base: point.class } : { class: "unresolved", possible: [...new Set([best.class, point.class, worst.class])], best: best.class, worst: worst.class, base: point.class, primary: point.primary };
}
/** lo/hi vectors are per-key bounds; "bad" measures are minimal and VD maximal in lowBad. */
const lowBad = (m: TextMeasures): Vec => ({ ...m.lo, VD: m.hi.VD ?? 0 });
const highBad = (m: TextMeasures): Vec => ({ ...m.hi, VD: m.lo.VD ?? 0 });
export function conclusion(pairs: { class: string; primary?: boolean }[], total = 6): string {
  const cls = pairs.map(p => p.class);
  if (cls.length === total && cls.every(c => c === "improved")) return "supported (exposed ledgers only)";
  if (cls.length === total && cls.every(c => c === "improved" || c === "improved-with-usefulness-cost") && cls.includes("improved-with-usefulness-cost")) return "fidelity improvement with usefulness trade-off";
  if (cls.includes("regression") || !pairs.some(p => p.primary)) return "not supported";
  return "inconclusive";
}
/** Study conclusion over pair results that may be unresolved: evaluated at both extremes. */
export function studyConclusion(pairs: any[]): { conclusion: string; best: string; worst: string } {
  const at = (side: "best" | "worst") => conclusion(pairs.map(p => p.class === "unresolved" ? { class: p[side], primary: p.primary } : p));
  const best = at("best"), worst = at("worst");
  return { conclusion: best === worst ? best : "inconclusive (reading-dependent)", best, worst };
}
export function usefulnessOf(ledger: LedgerId, rep: number): { status: Usefulness; families: Record<string, string>; criteria: Record<string, Record<string, string>> } {
  const families: Record<string, string> = {}, criteria: Record<string, Record<string, string>> = {};
  for (const fam of FAMS) {
    const f = join(ROOT, "pairwise", ledger, `r${rep}.${fam}.json`);
    if (!existsSync(f) || !json(f).valid) { families[fam] = "missing"; continue; }
    const p = json(f), arm = (x: string) => x === "tie" ? "tie" : String(p.order[x]).slice(0, 1);
    families[fam] = arm(p.value.overall);
    criteria[fam] = Object.fromEntries(Object.entries<string>(p.value.criteria).map(([k, v]) => [k, arm(v)]));
  }
  const vals = Object.values(families);
  return { status: vals.includes("missing") ? "unmeasured" : vals.every(v => v === "C") ? "cost" : vals.every(v => v === "B") ? "gain" : "none", families, criteria };
}

// ---- score ------------------------------------------------------------------------------------------------------------------------------
const rubricOf = (ledger: LedgerId, label: string) => { const out: Record<string, any> = {}; for (const fam of FAMS) { const j = judgmentOf(ledger, label, fam); if (j?.valid) out[fam] = j.value.usefulness; } return out; };
function mechanical(ledger: LedgerId, label: string, arm: Arm): any {
  const dir = join(ROOT, "runs", ledger, label, "final"), final = existsSync(join(dir, "final.md")) ? text(join(dir, "final.md")) : undefined;
  if (final === undefined) return { available: false };
  const scan = existsSync(join(dir, "scan.json")) ? json(join(dir, "scan.json")) : undefined;
  if (arm === "C") return { scan, notes: existsSync(join(dir, "notes.md")) ? text(join(dir, "notes.md")).length : 0 };
  const l = ledgerOf(ledger), arrangement = arrangementOf(text(join(dir, "arrangement.json"))).value, again = render(l, arrangement), c = check(l, arrangement, final);
  const placed = l.entries.filter(e => APPROVED.includes(e.decision)), fieldChars = placed.reduce((n, e) => n + e.statement.length + e.conditions.join("").length + e.note.length + e.locations.join("").length, 0);
  return { scan, check: { errors: c.errors, arrangementErrors: c.arrangementErrors, fallbacks: c.fallbacks, stats: c.stats }, storedCheckErrors: json(join(dir, "check.json")).errors, rerenderIdentical: again.text === final, proposals: json(join(dir, "proposals.json")), mainEntries: Array.isArray(arrangement?.main) ? arrangement.main.length : 0, templateShare: Math.round((1 - fieldChars / final.length) * 1e4) / 1e4 };
}
function reviewStats(ledger: LedgerId, label: string): any {
  const dir = join(ROOT, "runs", ledger, label, "final"), parse = (f: string) => { try { return JSON.parse(text(join(dir, f))); } catch { return undefined; } };
  const kinds = (a: any) => (Array.isArray(a?.defects) ? a.defects : []).reduce((acc: Record<string, number>, d: any) => { acc[d.kind] = (acc[d.kind] ?? 0) + 1; return acc; }, {});
  const p = pipelineOf(ledger, label);
  return { reviewAvailable: p?.reviewAvailable, finalAttempt: p?.finalAttempt, attempts: p?.attempts?.length, audit: kinds(parse("audit-1.json")), recheck: kinds(parse("recheck.json")), diffLines: existsSync(join(dir, "revision.diff")) ? text(join(dir, "revision.diff")).split("\n").filter(l => /^[+-][^+-]/.test(l)).length : 0 };
}
export function score(): any {
  const adj = acceptedVerdicts(), ids = opaqueIds(), readings: Record<string, Options> = { main: MAIN, conditionsExcluded: { ...MAIN, withConditions: false }, contextExcluded: { ...MAIN, contextIncluded: false }, secondReference: { ...MAIN, secondReference: true }, sampleNotApplied: { ...MAIN, applySample: false }, tier1Conservative: { ...MAIN, tier1: "conservative" }, tier1Optimistic: { ...MAIN, tier1: "optimistic" }, k62Delivered: { ...MAIN, k62: "delivered" }, k62Failed: { ...MAIN, k62: "failed" } };
  const texts: Record<string, any> = {};
  const m = (t: TextRef, name: string) => measure(t.ledger, t.label, readings[name]!, adj, ids.get(`${t.ledger}/${t.label}`));
  for (const t of MEASURED) {
    const key = `${t.ledger}/${t.label}`, all = Object.fromEntries(Object.keys(readings).map(name => [name, m(t, name)]));
    texts[key] = { ledger: t.ledger, label: t.label, arm: t.arm, rep: t.rep, opaque: ids.get(key), measures: all, rubric: rubricOf(t.ledger, t.label), mechanical: mechanical(t.ledger, t.label, t.arm), review: reviewStats(t.ledger, t.label) };
  }
  const pairsFor = (name: string, cross: boolean) => LEDGERS.flatMap(l => REPS.map(rep => {
    const bRep = cross ? (rep === 1 ? 2 : 1) : rep, b = texts[`${l.id}/B-r${bRep}`].measures[name] as TextMeasures, c = texts[`${l.id}/C-r${rep}`].measures[name] as TextMeasures;
    const u = cross ? crossUsefulness(l.id, rep, bRep) : usefulnessOf(l.id, rep).status;
    return { ledger: l.id, C: `C-r${rep}`, B: `B-r${bRep}`, usefulness: u, ...pairClass(b, c, u), b: { base: b.base, lo: b.lo, hi: b.hi }, c: { base: c.base, lo: c.lo, hi: c.hi } };
  }));
  const pairs = pairsFor("main", false), study = studyConclusion(pairs);
  const sensitivities: Record<string, any> = {};
  for (const [name, reading, cross] of [["crossRepetition", "main", true], ["conditionsExcluded", "conditionsExcluded", false], ["contextExcluded", "contextExcluded", false]] as const) { const p = pairsFor(reading, cross); sensitivities[name] = { pairs: p.map(x => ({ ledger: x.ledger, C: x.C, B: x.B, class: x.class, possible: x.possible })), ...studyConclusion(p) }; }
  const descriptive: Record<string, any> = {};
  for (const name of ["secondReference", "sampleNotApplied", "tier1Conservative", "tier1Optimistic"]) { const p = pairsFor(name, false); descriptive[name] = { pairs: p.map(x => ({ ledger: x.ledger, C: x.C, B: x.B, class: x.class, possible: x.possible })), ...studyConclusion(p) }; }
  // Replication protocol §7.1: reported next to the main reading; never one of the original conclusion-changing sensitivities.
  const k62: Record<string, any> = {};
  for (const name of ["k62Delivered", "k62Failed"]) { const p = pairsFor(name, false); k62[name] = { pairs: p.map(x => ({ ledger: x.ledger, C: x.C, B: x.B, class: x.class, possible: x.possible })), ...studyConclusion(p) }; }
  k62.dependent = Object.values(k62).some((s: any) => s.conclusion !== study.conclusion) || ["k62Delivered", "k62Failed"].some(n => k62[n].pairs.some((x: any, i: number) => x.class !== pairs[i]!.class));
  const changing = Object.entries(sensitivities).filter(([, s]) => s.conclusion !== study.conclusion).map(([k]) => k);
  const final = changing.length ? "inconclusive (reading-dependent)" : study.conclusion;
  // The replication does not judge the three historical Q finals again: their max-study Tier-1 values (same instrument) are reused.
  const historical = VARIANT.baseline ? { reusedFrom: `${VARIANT.baseline}/scores.json`, note: "descriptive context only; not judged again in this study", values: json(join(REPO, VARIANT.baseline, "scores.json")).historical }
    : Object.fromEntries(LEDGERS.map(l => { const s = stateOf(l.id, "hist"); return [l.id, s.status !== "judged" ? { status: s.status, reason: s.reason } : { conservative: measure(l.id, "hist", readings.tier1Conservative!, adj).base, optimistic: measure(l.id, "hist", readings.tier1Optimistic!, adj).base, rubric: rubricOf(l.id, "hist"), chars: s.body!.length }]; }));
  return { scoredAt: new Date().toISOString(), variant: VARIANT.name, rounds: adj.rounds, origin: Object.fromEntries(ids), texts, pairs, study: { ...study, final, conclusionChangingReadings: changing }, sensitivities, descriptive, k62, instrument: instrumentStats(adj, ids), historical };
}
function crossUsefulness(ledger: LedgerId, cRep: number, bRep: number): Usefulness {
  const a = usefulnessOf(ledger, cRep).status, b = usefulnessOf(ledger, bRep).status;
  return a === "unmeasured" || b === "unmeasured" ? "unmeasured" : a === b && (a === "cost" || a === "gain") ? a : "none";
}
function instrumentStats(adj: ReturnType<typeof acceptedVerdicts>, ids: Map<string, string>): any {
  const perText: Record<string, any> = {};
  for (const t of MEASURED) {
    const s = stateOf(t.ledger, t.label), tid = ids.get(`${t.ledger}/${t.label}`);
    if (s.status !== "judged") { perText[`${t.ledger}/${t.label}`] = { status: s.status }; continue; }
    const l = ledgerOf(t.ledger), approved = l.entries.filter(e => APPROVED.includes(e.decision));
    const d = approved.map(e => s.readers!.map(m => delivered(e, m.get(e.id))));
    const items = [...adj.items.values()].filter(i => i.text === tid), sample = items.filter(i => i.kind === "S"), sv = sample.map(i => adj.verdicts.get(i.item)).filter(v => v?.resolved);
    const overCredit = sv.filter(v => !delivered(l.entries.find(e => e.id === v.item.split("-").pop())!, v as Reading)).length;
    const r = items.filter(i => i.kind === "R" && !i.exclude), rv = r.map(i => adj.verdicts.get(i.item));
    perText[`${t.ledger}/${t.label}`] = {
      approved: approved.length, bothDelivered: d.filter(x => x[0] && x[1]).length, disagree: d.filter(x => x[0] !== x[1]).length, bothFailed: d.filter(x => !x[0] && !x[1]).length,
      deliveredBy: Object.fromEntries(FAMS.map((f, i) => [f, d.filter(x => x[i]).length])),
      items: countKinds(items), unresolved: items.filter(i => !adj.verdicts.get(i.item)?.resolved).map(i => i.item),
      sample: { resolved: sv.length, notDelivered: overCredit, rate: sv.length ? Math.round(overCredit / sv.length * 1e3) / 1e3 : null, unsampledAgreed: d.filter(x => x[0] && x[1]).length - sample.length },
      rItems: { approved: r.length, adjudicatedDelivered: rv.filter((v, n) => v?.resolved && delivered(l.entries.find(e => e.id === r[n]!.entry.id)!, v as Reading)).length },
    };
  }
  const second = [...adj.second.entries()].map(([item, { first, second: s2 }]) => {
    const i = adj.items.get(item)!, e = i.entry ? ledgerOf(i.ledger).entries.find(x => x.id === i.entry.id) : undefined;
    const reading = (v: any) => !v?.resolved ? "unresolved" : i.kind === "O" ? `${v.origin}${v.origin === "new" ? `:${v.claims.map((c: any) => `${c.support}/${c.relevance}`).join(",")}` : ""}` : i.exclude ? `presented=${v.presented}` : `delivered=${delivered(e!, v)}`;
    return { item, kind: i.kind, first: reading(first), second: reading(s2), agree: reading(first) === reading(s2) };
  });
  return { perText, secondReading: { items: second.length, agree: second.filter(x => x.agree).length, list: second } };
}

// ---- round 2 ----------------------------------------------------------------------------------------------------------------------------
/** Round 2 (protocol §7): unresolved round-1 items of pairs whose class they can change, plus a second-reading sample of R/O items. */
export function roundTwoItems(): Item[] {
  const adj = acceptedVerdicts(), ids = opaqueIds(), out: Item[] = [];
  const s = score();
  const open = new Set<string>();
  for (const p of s.pairs.filter((x: any) => x.class === "unresolved")) for (const label of [p.B, p.C]) for (const item of texts(s, p.ledger, label).measures.main.unresolved as string[]) open.add(item);
  for (const item of [...open].sort()) out.push({ ...adj.items.get(item)!, purpose: "resolve" });
  for (const t of MEASURED) {
    const tid = ids.get(`${t.ledger}/${t.label}`);
    const resolved = [...adj.items.values()].filter(i => i.text === tid && (i.kind === "R" || i.kind === "O") && adj.verdicts.get(i.item)?.resolved && !open.has(i.item));
    for (const i of resolved.sort((a, b) => sampleRank("second")(a.item, b.item)).slice(0, SECOND_SAMPLE)) out.push({ ...i, purpose: "second" });
  }
  return out;
}
const texts = (s: any, ledger: string, label: string) => s.texts[`${ledger}/${label}`];

// ---- accounting and preservation (protocol §10) ------------------------------------------------------------------------------------
export function resultsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) { const p = join(dir, name), st = statSync(p); if (st.isDirectory()) out.push(...resultsUnder(p)); else if (name === "result.json") out.push(p); }
  return out;
}
/** Turn records that started but never wrote a result (interrupted): their usage is unknown unless a wire log was salvaged. */
export function interruptedUnder(dir: string): any[] {
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (/^turn-\d+$/.test(name) && existsSync(join(p, "meta.json")) && !existsSync(join(p, "result.json"))) { const m = json(join(p, "meta.json")); if (m.startedAt) out.push({ record: p.slice(REPO.length + 1), label: m.label, number: m.number, startedAt: m.startedAt, thinking: m.thinking, wireSalvaged: existsSync(join(p, "wire.jsonl")) }); }
    else out.push(...interruptedUnder(p));
  }
  return out;
}
/** Requests that reported usage but have no catalogue price (unknown cost, never zero); requests without usage are counted separately. */
const unpricedOf = (resultFile: string) => { const w = join(resultFile, "..", "wire.jsonl"); return existsSync(w) ? readFileSync(w, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(e => e?.method === "POST" && e.model && e.usage && e.costUSD === undefined).length : 0; };
export function sumTurns(files: string[]): any {
  const rows = files.map(f => json(f));
  const sum = (k: (r: any) => number) => rows.reduce((n, r) => n + (k(r) || 0), 0);
  const starts = rows.map(r => Date.parse(r.startedAt)).filter(Number.isFinite), ends = rows.map(r => Date.parse(r.endedAt)).filter(Number.isFinite);
  return { turns: rows.length, requests: sum(r => r.wire?.requests), wireUSD: Math.round(sum(r => r.wire?.costUSD) * 1e4) / 1e4, eventUSD: Math.round(sum(r => r.eventCostUSD) * 1e4) / 1e4, unknownUsageRequests: sum(r => r.wire?.unknownUsage), unpricedRequests: files.reduce((n, f) => n + unpricedOf(f), 0), input: sum(r => r.wire?.input), cached: sum(r => r.wire?.cached), output: sum(r => r.wire?.output), reasoning: sum(r => r.wire?.reasoning), sessionSeconds: Math.round(sum(r => r.ms) / 1000), wallSeconds: starts.length ? Math.round((Math.max(...ends) - Math.min(...starts)) / 1000) : 0, routes: rows.reduce((acc: Record<string, number>, r) => { for (const [k, v] of Object.entries<number>(r.wire?.routes ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}), technicalFailures: rows.filter(r => !r.ok).length };
}
/**
 * Identity audit (replication protocol §3): per role, every wire route (model@effort), update effort and transcript thinking level of
 * every kept turn, against the turn's assigned effort. A turn is off-assignment when any of them differs or no thinking level was recorded.
 */
export function identityAudit(root = ROOT): any {
  const roles: Record<string, string[]> = { measured: resultsUnder(join(root, "runs")), instrument: [...resultsUnder(join(root, "judge-runs")), ...resultsUnder(join(root, "pairwise-runs"))], preflight: resultsUnder(join(root, "preflight")) };
  const out: Record<string, any> = {};
  for (const [role, files] of Object.entries(roles)) {
    const count = (acc: Record<string, number>, k: string, n = 1) => { acc[k] = (acc[k] ?? 0) + n; };
    const assigned: Record<string, number> = {}, routes: Record<string, number> = {}, updates: Record<string, number> = {}, thinking: Record<string, number> = {}, off: any[] = [];
    let aliasUsed = 0, noThinking = 0, ok = 0;
    for (const f of files) {
      const r = json(f), effort = String(r.thinking), levels: string[] = r.identity?.thinking ?? [], rts = Object.keys(r.wire?.routes ?? {}), ups = Object.keys(r.wire?.updateEfforts ?? {});
      count(assigned, effort); if (r.ok) ok++; if (r.identity?.aliasUsed) aliasUsed++;
      for (const [k, v] of Object.entries<number>(r.wire?.routes ?? {})) count(routes, k, v);
      for (const [k, v] of Object.entries<number>(r.wire?.updateEfforts ?? {})) count(updates, k, v);
      for (const t of levels) count(thinking, t);
      if (!levels.length) noThinking++;
      const bad = [...rts.filter(k => !k.endsWith(`@${effort}`)).map(k => `route ${k}`), ...ups.filter(k => k !== effort).map(k => `update ${k}`), ...levels.filter(t => t !== effort).map(t => `thinking ${t}`), ...(levels.length ? [] : ["no thinking level recorded"])];
      if (bad.length && (r.wire?.requests ?? 0) > 0) off.push({ record: f.slice(REPO.length + 1, -"/result.json".length), assigned: effort, problems: bad });
    }
    out[role] = { turns: files.length, ok, assignedEfforts: assigned, routes, updateEfforts: updates, transcriptThinking: thinking, turnsWithoutThinkingLevel: noThinking, aliasUsedTurns: aliasUsed, offAssignment: off };
  }
  out.interrupted = ["runs", "judge-runs", "pairwise-runs", "preflight"].flatMap(d => interruptedUnder(join(root, d)));
  out.expected = { measured: MEASURED_EFFORT, instrument: INSTRUMENT_EFFORT };
  return out;
}
function sessionUsage(files: string[]): any {
  let usd = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, messages = 0, withoutUsage = 0, first = Infinity, last = 0;
  const models: Record<string, number> = {};
  for (const f of files) for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp ?? ""); if (Number.isFinite(t)) { first = Math.min(first, t); last = Math.max(last, t); }
    const m = o?.message;
    if (m?.role !== "assistant") continue;
    messages++;
    if (!m.usage) { withoutUsage++; continue; }
    usd += m.usage.cost?.total ?? 0; input += m.usage.input ?? 0; output += m.usage.output ?? 0; cacheRead += m.usage.cacheRead ?? 0; cacheWrite += m.usage.cacheWrite ?? 0;
    models[`${m.provider ?? "?"}/${m.model ?? "?"}`] = (models[`${m.provider ?? "?"}/${m.model ?? "?"}`] ?? 0) + 1;
  }
  return { files: files.map(f => basename(f)), assistantMessages: messages, messagesWithoutUsage: withoutUsage, catalogueUSD: Math.round(usd * 1e4) / 1e4, input, output, cacheRead, cacheWrite, models, wallSeconds: Number.isFinite(first) ? Math.round((last - first) / 1000) : 0 };
}
export function accounting(host: string[], experimenter: string[]): any {
  const stageOf = new Map<string, string>();
  for (const t of MEASURED) { const p = pipelineOf(t.ledger, t.label); for (const a of p?.attempts ?? []) for (const s of a.stages ?? []) if (s.record) stageOf.set(join(ROOT, s.record, "result.json"), `${t.arm}:${s.stage}`); }
  const runs = resultsUnder(join(ROOT, "runs")), byStage: Record<string, string[]> = {};
  for (const f of runs) { const k = stageOf.get(f) ?? "unmapped"; (byStage[k] ??= []).push(f); }
  const byArm = Object.fromEntries(ARMS.map(arm => [arm, sumTurns(runs.filter(f => (stageOf.get(f) ?? "").startsWith(`${arm}:`)))]));
  const judges = resultsUnder(join(ROOT, "judge-runs")), pairwise = resultsUnder(join(ROOT, "pairwise-runs"));
  const measured = sumTurns(runs), preflight = sumTurns(resultsUnder(join(ROOT, "preflight"))), judging = sumTurns(judges), pair = sumTurns(pairwise);
  const knownUSD = [measured, preflight, judging, pair].reduce((n, x) => n + x.wireUSD, 0);
  return {
    at: new Date().toISOString(), pricing: "frozen pinned catalogue list prices (pins/cliproxyapi-models.json); provider invoices are not available", measured, byArm, byStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, sumTurns(v)])),
    preflight, judges: { all: judging, historical: sumTurns(judges.filter(f => f.includes("/hist."))), measured: sumTurns(judges.filter(f => !f.includes("/hist."))) }, pairwise: pair,
    hostRounds: host.length ? sessionUsage(host) : { note: "no host-round session files given" }, experimenter: experimenter.length ? { ...sessionUsage(experimenter), note: "descriptive lower bound: this orchestration session (and its advisor), including work before this study" } : undefined,
    knownSandboxUSD: Math.round(knownUSD * 1e4) / 1e4, unknown: { requestsWithoutUsage: [measured, preflight, judging, pair].reduce((n, x) => n + x.unknownUsageRequests, 0), unpricedRequests: [measured, preflight, judging, pair].reduce((n, x) => n + x.unpricedRequests, 0), note: "requests without final usage, and requests with usage but without a catalogue price, are unknown, never zero" },
    interrupted: ["runs", "judge-runs", "pairwise-runs", "preflight"].flatMap(d => interruptedUnder(join(ROOT, d))), variant: VARIANT.name, efforts: { measured: MEASURED_EFFORT, instrument: INSTRUMENT_EFFORT },
  };
}
export async function preservation(): Promise<any> {
  const before = json(join(ROOT, "prior-hashes.json")), now: Record<string, unknown> = { modules: priorModules() };
  for (const name of Object.keys(before).filter(k => k !== "modules")) now[name] = treeHashes(join(REPO, "results", name));
  const diff = (a: Record<string, string>, b: Record<string, string>) => ({ changed: Object.keys(a).filter(k => k in b && a[k] !== b[k]), removed: Object.keys(a).filter(k => !(k in b)), added: Object.keys(b).filter(k => !(k in a)) });
  const prior = Object.fromEntries(Object.keys(before).map(k => [k, diff(before[k], now[k] as Record<string, string>)]));
  const targetsBefore = json(join(ROOT, "target-hashes-before.json")), targetsNow = targetHashes();
  // The replication's code delta: the delivery modules now against the byte copies taken from the max study before any edit.
  const snapshot = existsSync(join(ROOT, "baseline-sources", "hashes.json")) ? json(join(ROOT, "baseline-sources", "hashes.json")) : undefined;
  const codeDelta = snapshot ? Object.entries<string>(snapshot.files).map(([rel, hash]) => { const now = existsSync(join(REPO, rel)) ? sha(readFileSync(join(REPO, rel))) : null; return { file: rel, maxStudy: hash, now, changed: hash !== now }; }) : undefined;
  const manifest = json(join(ROOT, "manifest.json")), dirtyNow = execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO }).toString();
  const lines = (s: string) => new Set(s.split("\n").filter(Boolean));
  const was = lines(manifest.dirty), is = lines(dirtyNow);
  return {
    at: new Date().toISOString(), priorStudiesAndModules: prior, priorUnchanged: Object.values(prior).every((d: any) => !d.changed.length && !d.removed.length && !d.added.length),
    targets: { before: targetsBefore, now: targetsNow, unchanged: ["devCommitTree", "isortSnapshot", "isortFixture", "retry1Inputs", "retry1References"].every(k => JSON.stringify(targetsBefore[k]) === JSON.stringify((targetsNow as any)[k])) },
    gitStatusSinceManifest: { added: [...is].filter(l => !was.has(l)), removed: [...was].filter(l => !is.has(l)) }, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim(),
    liveConfig: { orcheConfigUnchanged: sha(readFileSync(join(AGENT, "orche.config.json"))) === manifest.liveConfigSha256 },
    ...(codeDelta ? { codeDelta } : {}),
  };
}

// ---- effort comparison (replication protocol §7.2; descriptive) -------------------------------------------------------------------------
export const COMPARE_MEASURES = ["DL", "DLmissing", "DLpartial", "DLcontradicted", "DLstatus", "DLconditions", "X", "UA", "UAinvalid", "EL", "FOUd", "VD", "VLdelivery", "Hdelivery"] as const;
export type Direction = "high lower" | "high higher" | "overlap" | "unavailable";
/** high lower / high higher only when both high values lie strictly beyond both max values; ties and interleaving are overlap. */
export function direction(max: (number | null | undefined)[], high: (number | null | undefined)[]): Direction {
  const all = [...max, ...high];
  if (!max.length || !high.length || all.some(v => typeof v !== "number" || !Number.isFinite(v))) return "unavailable";
  const m = max as number[], h = high as number[];
  if (Math.max(...h) < Math.min(...m)) return "high lower";
  if (Math.min(...h) > Math.max(...m)) return "high higher";
  return "overlap";
}
/** An effect on (arm, measure) is consistent only when every ledger shows the same non-overlap direction. */
export const consistency = (dirs: Direction[]): string => dirs.length > 0 && dirs.every(d => d === dirs[0]) && (dirs[0] === "high lower" || dirs[0] === "high higher") ? `consistent (${dirs[0]})` : "not consistent";
const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 100) / 100 : null;
/** One text's comparison values from a study's scores and turn records (any study root; nothing is written). */
export function textValues(scores: any, root: string, ledger: string, label: string): Record<string, number | null> {
  const t = scores.texts?.[`${ledger}/${label}`], out: Record<string, number | null> = {};
  const judged = !!t && t.measures?.main?.status !== "incomplete";
  for (const k of COMPARE_MEASURES) out[k] = judged ? t.measures.main.base[k] ?? 0 : null;
  out.tier1DL = judged ? t.measures.tier1Conservative?.base?.DL ?? 0 : null;
  out.tier1X = judged ? t.measures.tier1Conservative?.base?.X ?? 0 : null;
  out.unresolvedItems = judged ? (t.measures.main.unresolved ?? []).length : null;
  for (const fam of FAMS) { const u = t?.rubric?.[fam]; out[`usefulness.${fam}`] = u ? mean(["answersTask", "organization", "readability", "statusClarity", "concision"].map(k => Number(u[k]))) : null; }
  out.chars = t?.mechanical?.scan?.chars ?? null;
  out.repeated8gramShare = t?.mechanical?.scan?.repeated8gramShare ?? null;
  const defects = (x: any) => x ? Object.values<number>(x).reduce((a, b) => a + b, 0) : null;
  out.auditDefects = defects(t?.review?.audit); out.recheckDefects = defects(t?.review?.recheck);
  const files = resultsUnder(join(root, "runs", ledger, label));
  if (files.length) { const u = sumTurns(files); Object.assign(out, { requests: u.requests, outputTokens: u.output, reasoningTokens: u.reasoning, sessionMinutes: Math.round(u.sessionSeconds / 6) / 10, wallMinutes: Math.round(u.wallSeconds / 6) / 10, wireUSD: u.wireUSD, technicalFailures: u.technicalFailures }); }
  return out;
}
const familiesAt = (root: string, ledger: string, rep: number) => Object.fromEntries(FAMS.map(fam => { const f = join(root, "pairwise", ledger, `r${rep}.${fam}.json`); if (!existsSync(f) || !json(f).valid) return [fam, "missing"]; const p = json(f); return [fam, p.value.overall === "tie" ? "tie" : String(p.order[p.value.overall]).slice(0, 1)]; }));
/** High (this study) against the max study's records, per (ledger, arm, repetition); `k62Max` is the max study's k62 block computed separately. */
export function effortComparison(k62Max?: any): any {
  if (!VARIANT.baseline) throw new Error("the effort comparison runs in the replication variant");
  const base = join(REPO, VARIANT.baseline), maxScores = json(join(base, "scores.json")), highScores = json(join(ROOT, "scores.json"));
  const units = LEDGERS.flatMap(l => ARMS.map(arm => {
    const mx = REPS.map(rep => textValues(maxScores, base, l.id, `${arm}-r${rep}`)), hi = REPS.map(rep => textValues(highScores, ROOT, l.id, `${arm}-r${rep}`));
    const keys = [...new Set([...Object.keys(mx[0]!), ...Object.keys(hi[0]!)])];
    const spread = (xs: (number | null)[]) => xs.every(x => typeof x === "number") ? Math.round(Math.abs((xs[0] as number) - (xs[1] as number)) * 100) / 100 : null;
    return { ledger: l.id, arm, measures: Object.fromEntries(keys.map(k => { const a = mx.map(x => x[k] ?? null), b = hi.map(x => x[k] ?? null); return [k, { max: a, high: b, direction: direction(a, b), spreadMax: spread(a), spreadHigh: spread(b) }]; })) };
  }));
  const byArm = Object.fromEntries(ARMS.map(arm => {
    const us = units.filter(u => u.arm === arm), keys = Object.keys(us[0]!.measures);
    return [arm, Object.fromEntries(keys.map(k => { const dirs = us.map(u => (u.measures as any)[k].direction as Direction); return [k, { directions: Object.fromEntries(us.map((u, i) => [u.ledger, dirs[i]])), effect: consistency(dirs) }]; }))];
  }));
  const pairAt = (s: any, ledger: string, rep: number) => { const p = s.pairs.find((x: any) => x.ledger === ledger && x.C === `C-r${rep}` && x.B === `B-r${rep}`); return p ? { class: p.class, possible: p.possible, usefulness: p.usefulness } : { class: "missing" }; };
  const pairs = LEDGERS.flatMap(l => REPS.map(rep => ({ ledger: l.id, rep, max: { ...pairAt(maxScores, l.id, rep), families: familiesAt(base, l.id, rep) }, high: { ...pairAt(highScores, l.id, rep), families: familiesAt(ROOT, l.id, rep) }, same: pairAt(maxScores, l.id, rep).class === pairAt(highScores, l.id, rep).class })));
  return {
    at: new Date().toISOString(), rule: "replication protocol §7.2: per (ledger, arm, measure) 'high lower'/'high higher' only when both high values lie strictly beyond both max values, else overlap; consistent only when all three ledgers agree",
    caveats: ["three ledgers from two tasks; two repetitions per condition", "max values were adjudicated by the max study's verifiers, high values by this study's: effort is confounded with evaluation batch", "the replication ran about one day later: effort is confounded with time/provider variation", "descriptive only; the original C/B rule is unchanged and is not an effort-effect test"],
    units, byArm, pairs, conclusions: { max: maxScores.study, high: highScores.study }, k62: { max: k62Max ?? "not computed", high: highScores.k62 },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "tier1") { const items = roundOneItems(); console.log(JSON.stringify({ items: items.length, kinds: countKinds(items), perText: Object.fromEntries([...new Set(items.map(i => i.text))].map(t => [t, countKinds(items.filter(i => i.text === t))])) }, null, 1)); }
  else if (cmd === "packets") { const round = Number(args[0]); if (round === 1) await writePackets(1, roundOneItems().map(i => ({ ...i, purpose: "adjudicate" }))); else if (round === 2) { if (!existsSync(join(ADJ, "round-1", "items.json"))) throw new Error("round 1 first"); await writePackets(2, roundTwoItems()); } else throw new Error("round 1 or 2"); }
  else if (cmd === "collect") await collect(Number(args[0]), args.slice(1));
  else if (cmd === "check-verdicts") { const [dir, file] = args as [string, string]; const meta = json(join(dir, "items.json")), r = checkVerdicts(meta.items, json(file), packetBodies(dir)); console.log(JSON.stringify({ items: meta.items.length, valid: r.valid.size, errors: r.errors }, null, 1)); }
  else if (cmd === "score") { const s = score(); await write(join(ROOT, "scores.json"), s); console.log(JSON.stringify({ study: s.study, pairs: s.pairs.map((p: any) => ({ ledger: p.ledger, C: p.C, B: p.B, class: p.class, possible: p.possible, usefulness: p.usefulness })), sensitivities: Object.fromEntries(Object.entries<any>(s.sensitivities).map(([k, v]) => [k, v.conclusion])) }, null, 1)); }
  else if (cmd === "accounting") { const sep = args.indexOf("--"), host = sep < 0 ? args : args.slice(0, sep), exp = sep < 0 ? [] : args.slice(sep + 1); const a = accounting(host, exp); await write(join(ROOT, "accounting.json"), a); console.log(JSON.stringify({ measured: a.measured, byArm: a.byArm, judges: a.judges.all, pairwise: a.pairwise, preflight: a.preflight, knownSandboxUSD: a.knownSandboxUSD }, null, 1)); }
  else if (cmd === "preservation") { const p = await preservation(); await write(join(ROOT, "preservation.json"), p); console.log(JSON.stringify({ priorUnchanged: p.priorUnchanged, targetsUnchanged: p.targets.unchanged, git: p.gitStatusSinceManifest, liveConfig: p.liveConfig, codeChanged: p.codeDelta?.filter((d: any) => d.changed).map((d: any) => d.file) }, null, 1)); }
  else if (cmd === "identity") { const a = identityAudit(); await write(join(ROOT, "identity-audit.json"), a); console.log(JSON.stringify({ measured: { ...a.measured, offAssignment: a.measured.offAssignment.length }, instrument: { ...a.instrument, offAssignment: a.instrument.offAssignment.length }, interrupted: a.interrupted.length }, null, 1)); }
  // k62 readings of the CURRENT variant's study, written to an explicit path (for the max study: into the replication's namespace).
  else if (cmd === "k62") { const out = args[0]; if (!out) throw new Error("k62 <output.json>"); const s = score(), stored = existsSync(join(ROOT, "scores.json")) ? json(join(ROOT, "scores.json")) : undefined; const classes = (x: any) => x?.pairs?.map((p: any) => `${p.ledger}/${p.C}/${p.B}:${p.class}`); await write(out, { variant: VARIANT.name, study: ROOT.slice(REPO.length + 1), computedAt: new Date().toISOString(), k62: s.k62, main: { pairs: s.pairs.map((p: any) => ({ ledger: p.ledger, C: p.C, B: p.B, class: p.class, possible: p.possible })), study: s.study }, recomputedMainMatchesStoredScores: stored ? JSON.stringify(classes(stored)) === JSON.stringify(classes(s)) && JSON.stringify(stored.study) === JSON.stringify(s.study) : null }); console.log(JSON.stringify({ k62: Object.fromEntries(Object.entries<any>(s.k62).map(([k, v]) => [k, typeof v === "object" ? v.conclusion : v])), main: s.study.conclusion }, null, 1)); }
  else if (cmd === "compare") { const k62Max = args[0] ? json(args[0]) : undefined; const c = effortComparison(k62Max); await write(join(ROOT, "effort-comparison.json"), c); console.log(JSON.stringify({ conclusions: { max: c.conclusions.max.final, high: c.conclusions.high.final }, pairs: c.pairs.map((p: any) => `${p.ledger} r${p.rep}: max ${p.max.class} -> high ${p.high.class}`), effects: Object.fromEntries(Object.entries<any>(c.byArm).map(([arm, ms]) => [arm, Object.fromEntries(Object.entries<any>(ms).filter(([, v]) => v.effect !== "not consistent").map(([k, v]) => [k, v.effect]))])) }, null, 1)); }
  else throw new Error("tier1 | packets <1|2> | collect <round> <session.jsonl>... | check-verdicts <packet dir> <verdicts.json> | score | accounting <host sessions> -- <experimenter sessions> | preservation | identity | k62 <out.json> | compare [k62-max.json]");
}
