/**
 * Evaluation of the bottleneck-isolation study (results/bottleneck-isolation/protocol.md §7-§12). It only reads records and writes
 * evaluation files; it never calls a model.
 *   node --import tsx experiments/mdsd-ab/bottleneck-eval.ts provisional | packets <round> | check-verdicts <packet dir> <verdicts.json> |
 *     collect <round> <session.jsonl>... | score | estimate | e2b | e20 | identity | accounting <host...> -- <experimenter...> | preservation
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT, REPO, sha, write } from "./run.js";
import { numberLines, spanFound } from "./synthesis.js";
import { json, text } from "./qualification-inputs.js";
import { RETRY1, targetHashes } from "./delivery.js";
import { clusters, interruptedUnder, overlapping, referencesOf, reportData, resultsUnder, sumTurns } from "./delivery-eval.js";
import { APPROVED } from "./delivery-render.mjs";
import { ARMS_BI, BI, CAP, CELLS, EXP1, EXP1_TEXTS, FAMS, POOL_TEXTS, REPS_BI, SELECT_JOBS, UNITS, armLedger, caseOf, chars, claimsOfUnit, comparisons, instrumentFile, pairJobs, textInfo, textOf, unitOf, type BRef, type Comparison, type Fam, type LedgerBI } from "./bottleneck.js";

export const ADJ = join(BI, "adjudication");
export const WORKERS = 8, CAPACITY = 420, PACKET_CAP = 120;
export const TEXTS = [...EXP1_TEXTS, ...POOL_TEXTS];
const fileKey = (key: string) => key.replace(":", "_").replace("/", "_");
type Tri = boolean | undefined;
export interface Range { lo: number; hi: number }
const r0 = (): Range => ({ lo: 0, hi: 0 });
const addTri = (r: Range, t: Tri) => { if (t === true) { r.lo++; r.hi++; } else if (t === undefined) r.hi++; };

// ---- references and readings -------------------------------------------------------------------------------------------------------------
export interface RefOpts { contextIncluded: boolean; ambiguous: boolean; second: boolean }
export const MAIN_REF: RefOpts = { contextIncluded: true, ambiguous: false, second: false };
const refCache = new Map<string, Map<string, BRef>>();
export function refsFor(unit: string, o: RefOpts = MAIN_REF): Map<string, BRef> { const k = `${unit}:${o.second}`; if (!refCache.has(k)) refCache.set(k, referencesOf(unit, o.second) as Map<string, BRef>); return refCache.get(k)!; }
export const valid = (r: BRef | undefined, o: RefOpts = MAIN_REF) => !!r && r.support === "supported" && ["finding", "supporting", ...(o.contextIncluded ? ["requested_context"] : []), ...(o.ambiguous ? ["ambiguous"] : [])].includes(r.relevance);
export const essential = (r: BRef | undefined) => r?.salience === "essential";
export const unsupported = (r: BRef | undefined) => r?.support === "insufficient" || r?.support === "conflicting";
/** Equivalence clusters (union of labeller-b equivalentTo links) restricted to the ids accepted by `keep`. */
export function clustersOf(refs: Map<string, BRef>, keep: (id: string) => boolean): string[][] {
  const ids = [...refs.keys()].filter(keep), parent = new Map(ids.map(i => [i, i]));
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const id of ids) for (const t of refs.get(id)!.equivalentTo ?? []) if (parent.has(t)) { const a = find(id), b = find(t); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
  const groups = new Map<string, string[]>();
  for (const id of ids) { const r = find(id); groups.set(r, [...(groups.get(r) ?? []), id]); }
  return [...groups.values()];
}
export interface Reading { realization: string; stance: string; statusDrift?: string; quote?: string; counterQuote?: string; lines?: number[]; note?: string }
export const P = {
  covered: (r: Reading) => r.realization === "complete" && r.stance !== "rejected",
  asserted: (r: Reading) => r.stance === "asserted" || r.stance === "mixed",
  hedged: (r: Reading) => r.stance === "hedged",
  rejOpp: (r: Reading) => r.realization === "opposed" || r.stance === "rejected",
};
export type Pred = keyof typeof P;
export interface TextState { key: string; status: "judged" | "incomplete"; reason?: string; body?: string; readers?: Map<string, Reading>[]; neutral?: any[]; rubric?: any[] }
export function stateOf(key: string): TextState {
  const body = textOf(key);
  if (body === undefined) return { key, status: "incomplete", reason: "no frozen deliverable" };
  const neutral = FAMS.map(f => { const p = instrumentFile("neutral", `${fileKey(key)}.${f}`); return existsSync(p) ? json(p) : undefined; });
  const rubric = FAMS.map(f => { const p = instrumentFile("rubric", `${fileKey(key)}.${f}`); return existsSync(p) ? json(p) : undefined; });
  const bad = [...neutral.map((j, i) => !j ? `neutral ${FAMS[i]} missing` : !j.valid ? `neutral ${FAMS[i]} invalid` : j.textSha256 !== sha(body) ? `neutral ${FAMS[i]} of another text` : ""), ...rubric.map((j, i) => !j ? `rubric ${FAMS[i]} missing` : !j.valid ? `rubric ${FAMS[i]} invalid` : j.textSha256 !== sha(body) ? `rubric ${FAMS[i]} of another text` : "")].filter(Boolean);
  if (bad.length) return { key, status: "incomplete", reason: bad.join("; "), body };
  return { key, status: "judged", body, neutral, rubric, readers: neutral.map(j => new Map<string, Reading>(j.value.statements.map((s: any) => [s.id, s]))) };
}
/** Opaque text ids T01... (ordered by the sha256 of the text bytes) over all existing texts; once round-1 packets exist the frozen
 *  evaluator-only key adjudication/opaque.json is authoritative (item ids depend on it). */
export function opaqueIds(): Map<string, string> {
  const frozen = join(ADJ, "opaque.json");
  if (existsSync(frozen)) return new Map(Object.entries(json(frozen)) as [string, string][]);
  const rows = TEXTS.flatMap(k => { const b = textOf(k); return b === undefined ? [] : [{ k, h: sha(b) }]; }).sort((a, b) => a.h.localeCompare(b.h));
  return new Map(rows.map((r, i) => [r.k, `T${String(i + 1).padStart(2, "0")}`]));
}

// ---- adjudication items (protocol §11) ------------------------------------------------------------------------------------------------
export type Kind = "G" | "K" | "C" | "X" | "P" | "M" | "S" | "O" | "Q";
export interface Item { item: string; kind: "C" | "K" | "Q" | "O" | "X" | "P"; category: Kind; text?: string; unit: string; claim?: any; criterion?: string; readers?: any[]; alleged?: any[]; ledger?: string; evidence?: string[]; purpose?: "adjudicate" | "resolve" | "second"; priority: number }
const PRIORITY: Record<Kind, number> = { G: 0, Q: 0, O: 0, K: 1, C: 2, X: 3, P: 4, M: 5, S: 6 };
const WEIGHT = (i: Item) => i.kind === "O" || i.kind === "P" ? 3 : 1;
export const EVIDENCE: Record<string, string[]> = Object.fromEntries(UNITS.map(u => [u, [
  `results/qualification-validation-retry1/inputs/${u}/doc-A-evidence.jsonl and doc-B-evidence.jsonl (frozen tool evidence of the earlier analyses), evidence-index.json`,
  caseOf(u) === "dev" ? "code of the analysed commit, read-only: git -C /home/arthur/Code/oh-my-pi-extensions/orche show 2de1f04:<path> (and git ls-tree -r 2de1f04)" : "code snapshot, read-only: results/advisor-reviewer/cache/swe/pycqa__isort-2491/src; upstream test/fix: fixtures/advisor-bench/swe/pycqa__isort-2491/hidden/test.patch and reference/fix.patch",
]]));
const rank = (salt: string) => (a: string, b: string) => sha(`${salt}:${a}`).localeCompare(sha(`${salt}:${b}`));
const claimCache = new Map<string, Map<string, any>>();
const claimOf = (unit: string, id: string) => { if (!claimCache.has(unit)) claimCache.set(unit, new Map(claimsOfUnit(unit).map(c => [c.ref, c]))); return claimCache.get(unit)!.get(id)!; };
const claimView = (unit: string, id: string) => { const c = claimOf(unit, id); return { id, statement: c.claim, sourceStance: c.stance }; };
const readerView = (r: Reading | undefined) => r ? { realization: r.realization, stance: r.stance, quote: r.quote ?? "", counterQuote: r.counterQuote ?? "", lines: r.lines ?? [], note: r.note ?? "" } : { missing: true };
/** Content tokens for the lexical UA pre-filter. */
const STOP = new Set("the and for that this with from are was were has have had not but its into than then when where which while also only each such been being does done can may must any all one two per via use used uses using will would should could there their them they these those what who how why about over under after before more most less least other same both very just than".split(" "));
export const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_./:-]+/).filter(t => t.length >= 3 && !STOP.has(t)));
export function ledgerTraceable(claim: string, ledger: LedgerBI): boolean {
  const t = tokens(claim); if (!t.size) return true;
  return ledger.entries.some(e => { const fields = [e.statement, ...e.conditions, e.note, e.evidence, e.taskLink, e.quote]; return fields.some(f => { const ft = tokens(f ?? ""); let n = 0; for (const x of t) if (ft.has(x)) n++; return n / t.size >= 0.6; }); });
}
/** Tier-1 combination of one predicate: agreement, else a verdict, else unresolved. */
export function tri(rs: (Reading | undefined)[], pred: Pred, verdict?: any): Tri {
  if (verdict && verdict.resolved && verdict.realization) return P[pred](verdict);
  const v = rs.filter((r): r is Reading => !!r && !!r.realization);
  if (v.length < 2) return undefined;
  const [a, b] = v.map(r => P[pred](r));
  return a === b ? a : undefined;
}
export interface TextFacts { key: string; tid: string; unit: string; state: TextState }
/** UA candidates of one judged writer text (addendum 3: EVERY cluster is an adjudication item, as protocol v1 §11): judge "other"
 *  claims passing the lexical pre-filter, clustered (twins once); cluster index n is 1-based in clustering order. */
export function uaCandidates(t: TextFacts): { others: number; candidates: number; clusters: number; groups: [number, any[]][] } {
  const s = t.state, info = textInfo(t.key);
  if (s.status !== "judged" || !t.key.startsWith("exp1:")) return { others: 0, candidates: 0, clusters: 0, groups: [] };
  const l = armLedger(info.ledger!, info.arm as "A" | "R"), body = s.body!;
  const all = s.neutral!.flatMap(j => (j.value.other as any[]).map(o => ({ claim: String(o?.claim ?? ""), quote: String(o?.quote ?? ""), lines: Array.isArray(o?.lines) ? o.lines : [] })));
  const cands = all.filter(o => !ledgerTraceable(`${o.claim} ${o.quote}`, l)), groups = clusters(cands, (a, b) => overlapping(a, b, body));
  return { others: all.length, candidates: cands.length, clusters: groups.length, groups: groups.map((g, i) => [i + 1, g] as [number, any[]]) };
}
/** Round-1 candidate items of one judged text, every category (allocation and trimming happen afterwards). */
export function itemsOf(t: TextFacts): Item[] {
  const s = t.state; if (s.status !== "judged") return [];
  const refs = refsFor(t.unit), readers = s.readers!, body = s.body!, items: Item[] = [], unit = t.unit;
  const order = (k: string) => [0, 1].sort((a, b) => sha(`${t.tid}:${k}:${FAMS[a]}`).localeCompare(sha(`${t.tid}:${k}:${FAMS[b]}`)));
  const views = (k: string) => order(k).map((i, n) => ({ reader: n + 1, ...readerView(readers[i]!.get(k)) }));
  const agreedCovered: string[] = [];
  for (const [id, r] of refs) {
    const rs = readers.map(m => m.get(id)), any = (p: Pred) => rs.some(x => !!x && P[p](x)), dis = (p: Pred) => tri(rs, p) === undefined;
    const ess = essential(r), v = valid(r);
    let cat: Kind | undefined;
    if (ess && (r.support === "refuted" || unsupported(r)) && any("asserted")) cat = "G";
    else if (ess && v && any("rejOpp")) cat = "G";
    else if (ess && v && (dis("covered") || (claimView(unit, id).sourceStance !== "uncertain" && dis("hedged")))) cat = "C";
    else if (!ess && (r.support === "refuted" || unsupported(r) || r.relevance === "out") && dis("asserted")) cat = "M";
    if (cat) items.push({ item: `C-${t.tid}-${id}`, kind: "C", category: cat, text: t.tid, unit, claim: claimView(unit, id), readers: views(id), priority: PRIORITY[cat] });
    else if (ess && v && rs.every(x => !!x && P.covered(x))) agreedCovered.push(id);
  }
  for (const id of agreedCovered.sort(rank(`S:${t.key}`)).slice(0, 2)) items.push({ item: `C-${t.tid}-${id}`, kind: "C", category: "S", text: t.tid, unit, claim: claimView(unit, id), priority: PRIORITY.S });
  // rubric criteria the judges credit differently; alleged rubric contradictions (twins once)
  const credits = s.rubric!.map(j => new Map<string, any>(j.value.criteria.map((c: any) => [c.id, c])));
  for (const c of s.rubric![0].criteria as string[]) {
    const [a, b] = credits.map(m => m.get(c));
    if (a?.credit !== b?.credit) items.push({ item: `K-${t.tid}-${c}`, kind: "K", category: "K", text: t.tid, unit, criterion: c, readers: order(c).map((i, n) => ({ reader: n + 1, credit: credits[i]!.get(c)?.credit, quotes: credits[i]!.get(c)?.quotes ?? [], note: credits[i]!.get(c)?.note ?? "" })), priority: PRIORITY.K });
  }
  const rc = s.rubric!.flatMap(j => (j.value.contradictions as any[]).map(x => ({ criterion: String(x.criterion), quote: String(x.quote ?? ""), lines: Array.isArray(x.lines) ? x.lines : [], why: String(x.why ?? "") })));
  clusters(rc, (a, b) => overlapping(a, b, body)).forEach((g, n) => items.push({ item: `Q-${t.tid}-${n + 1}`, kind: "Q", category: "Q", text: t.tid, unit, alleged: g, priority: PRIORITY.Q }));
  const xs = s.neutral!.flatMap(j => (j.value.contradictions as any[]).map(c => ({ a: String(c?.a ?? ""), b: String(c?.b ?? ""), note: String(c?.note ?? "") })));
  const sameX = (x: any, y: any) => (overlapping({ quote: x.a }, { quote: y.a }, body) && overlapping({ quote: x.b }, { quote: y.b }, body)) || (overlapping({ quote: x.a }, { quote: y.b }, body) && overlapping({ quote: x.b }, { quote: y.a }, body));
  clusters(xs, sameX).forEach((g, n) => items.push({ item: `X-${t.tid}-${n + 1}`, kind: "X", category: "X", text: t.tid, unit, alleged: g, priority: PRIORITY.X }));
  if (t.key.startsWith("exp1:")) {
    // addendum 3: every UA candidate cluster is a gate item (protocol v1 §11); a cluster without a verdict stays open (unbounded in the gate)
    const u = uaCandidates(t);
    for (const [n, g] of u.groups) items.push({ item: `O-${t.tid}-${n}`, kind: "O", category: "O", text: t.tid, unit, alleged: g, ledger: t.tid, evidence: EVIDENCE[unit], priority: PRIORITY.O });
  }
  return items;
}

// ---- provisional assessments (Tier-1 only) and P0 sample ------------------------------------------------------------------------------
export function facts(): TextFacts[] { const ids = opaqueIds(); return TEXTS.map(key => ({ key, tid: ids.get(key) ?? "T??", unit: textInfo(key).unit, state: stateOf(key) })); }
/** P0 sets of one pool (essential-valid clusters covered in one stored text and not the other) under the given verdicts. */
export function p0Sets(unit: string, verdicts: Map<string, any>, ids = opaqueIds(), o: RefOpts = MAIN_REF): any {
  const S = stateOf(`pool:${unit}/S`), E = stateOf(`pool:${unit}/E`);
  if (S.status !== "judged" || E.status !== "judged") return { status: "incomplete" };
  const refs = refsFor(unit, o), tS = ids.get(`pool:${unit}/S`)!, tE = ids.get(`pool:${unit}/E`)!;
  const covered = (st: TextState, tid: string, id: string) => tri(st.readers!.map(m => m.get(id)), "covered", verdicts.get(`C-${tid}-${id}`));
  const sets = (keep: (id: string) => boolean) => {
    const out: any = { eOnly: [], sOnly: [], both: [], neither: [], unresolved: [] };
    for (const cl of clustersOf(refs, keep)) {
      const cs: Tri = cl.some(id => covered(S, tS, id) === true) ? true : cl.some(id => covered(S, tS, id) === undefined) ? undefined : false;
      const ce: Tri = cl.some(id => covered(E, tE, id) === true) ? true : cl.some(id => covered(E, tE, id) === undefined) ? undefined : false;
      const k = cs === undefined || ce === undefined ? "unresolved" : cs && ce ? "both" : ce ? "eOnly" : cs ? "sOnly" : "neither";
      out[k].push(cl);
    }
    return { counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as any[]).length])), ...out };
  };
  return { status: "judged", essential: sets(id => valid(refs.get(id), o) && essential(refs.get(id))), allValid: sets(id => valid(refs.get(id), o)) };
}
/** Deterministic P0 source-check sample: up to 6 E-only and 6 S-only essential claims per pool (one claim per cluster, sha256 rank). */
export function p0Sample(verdicts = new Map<string, any>()): Item[] {
  const items: Item[] = [];
  for (const u of UNITS) {
    const s = p0Sets(u, verdicts); if (s.status !== "judged") continue;
    for (const side of ["eOnly", "sOnly"] as const) {
      const picks = (s.essential[side] as string[][]).map(cl => [...cl].sort(rank(`P:${u}`))[0]!).sort(rank(`P:${u}:${side}`)).slice(0, 6);
      for (const id of picks) { const c = claimOf(u, id); items.push({ item: `P-${u}-${id}`, kind: "P", category: "P", unit: u, claim: { id, statement: c.claim, sourceStance: c.stance, locations: c.locations, quote: c.quote }, evidence: EVIDENCE[u], priority: PRIORITY.P }); }
    }
  }
  return items;
}
/** Allocation (protocol §11): weighted capacity, trimming in reverse priority by sha256 rank per text. */
export function allocate(items: Item[], capacity = CAPACITY): { kept: Item[]; trimmed: Item[] } {
  const weight = (xs: Item[]) => xs.reduce((n, i) => n + WEIGHT(i), 0);
  let kept = [...items];
  const trimmed: Item[] = [];
  for (const cat of ["S", "M", "P", "X", "C", "K"] as Kind[]) {
    if (weight(kept) <= capacity) break;
    const pool = kept.filter(i => i.category === cat).sort((a, b) => sha(`trim:${a.item}`).localeCompare(sha(`trim:${b.item}`)));
    while (weight(kept) > capacity && pool.length) { const x = pool.pop()!; kept = kept.filter(i => i !== x); trimmed.push(x); }
  }
  return { kept, trimmed };
}
/** Addendum 3/4: ceiling of the weighted load of one round = WORKERS packets of at most PACKET_CAP each (enforced by `pack`); v1's 420
 *  stays the trimming budget of the non-UA categories. */
export const ROUND_CAP = WORKERS * PACKET_CAP;
/** Round-robin over texts (each text's UA clusters in sha256 rank), so that a deferral spreads evenly over texts. */
export function uaOrder(items: Item[]): Item[] {
  const by = new Map<string, Item[]>();
  for (const i of items) by.set(i.text ?? "", [...(by.get(i.text ?? "") ?? []), i]);
  const lists = [...by.keys()].sort().map(k => by.get(k)!.sort((a, b) => sha(`UA:${a.item}`).localeCompare(sha(`UA:${b.item}`)))), out: Item[] = [];
  for (let n = 0; lists.some(l => n < l.length); n++) for (const l of lists) if (n < l.length) out.push(l[n]!);
  return out;
}
/** Round 1 (addendum 3): v1 allocation of the non-UA items (420; trimming S, M, P, X, C, K), then every UA cluster while the round load
 *  stays <= ROUND_CAP; the rest is deferred to round 2 as first readings, never dropped. */
export function planRoundOne(all: Item[]): { bins: Item[][]; items: Item[]; trimmed: Item[]; deferred: Item[] } {
  const { kept, trimmed } = allocate(all.filter(i => i.kind !== "O"));
  const ordered = [...kept].sort((a, b) => a.priority - b.priority || a.item.localeCompare(b.item));
  const { bins, overflow } = pack([...ordered, ...uaOrder(all.filter(i => i.kind === "O"))]);
  return { bins, items: bins.flat(), trimmed, deferred: overflow };
}
/** Round 2 (addendum 3, last round): unresolved gate items (G, Q, O), deferred UA clusters, other unresolved items (K, C, X, P), then the
 *  second-reading sample; beyond ROUND_CAP second readings are dropped first, then the remainder stays unassessed (open, never zero). */
export function planRoundTwo(resolve: Item[], deferred: Item[], second: Item[]): { bins: Item[][]; items: Item[]; unassessed: Item[]; trimmedSecond: Item[] } {
  const gate = (i: Item) => ["G", "Q", "O"].includes(i.category), isSecond = new Set(second);
  const { bins, overflow } = pack([...resolve.filter(gate), ...uaOrder(deferred), ...resolve.filter(i => !gate(i)), ...second]);
  return { bins, items: bins.flat(), unassessed: overflow.filter(i => !isSecond.has(i)), trimmedSecond: overflow.filter(i => isSecond.has(i)) };
}
export function roundOneItems(): { bins: Item[][]; items: Item[]; trimmed: Item[]; deferred: Item[]; all: number } {
  const all = [...facts().flatMap(itemsOf), ...p0Sample()];
  return { ...planRoundOne(all), all: all.length };
}

// ---- packets ------------------------------------------------------------------------------------------------------------------------------
/** Addendum 4: packs items, in the given (priority) order, into at most `workers` packets of weight <= `cap`. An item joins a packet that
 *  already holds its text (or pool) if it fits there, else the lightest packet it fits in; an item that fits nowhere overflows and is
 *  returned (deferred or unassessed by the caller, never dropped). */
export function pack(items: Item[], workers = WORKERS, cap = PACKET_CAP): { bins: Item[][]; overflow: Item[] } {
  const group = (i: Item) => i.text ?? `pool-${i.unit}`, overflow: Item[] = [];
  const bins = Array.from({ length: workers }, () => ({ items: [] as Item[], load: 0, groups: new Set<string>() }));
  for (const i of items) {
    const w = WEIGHT(i), fits = bins.filter(b => b.load + w <= cap);
    const b = fits.find(x => x.groups.has(group(i))) ?? fits.reduce<(typeof fits)[number] | undefined>((best, x) => !best || x.load < best.load ? x : best, undefined);
    if (!b) { overflow.push(i); continue; }
    b.items.push(i); b.load += w; b.groups.add(group(i));
  }
  return { bins: bins.filter(b => b.items.length).map(b => b.items), overflow };
}
const packetItem = (i: Item) => { const { purpose: _p, category: _c, priority: _r, ...rest } = i; return rest; };
export function instructions(packet: string, round: number, dir: string): string {
  const rel = dir.slice(REPO.length + 1);
  return `# Host verification packet ${packet} (bottleneck-isolation evaluation, round ${round})

You verify readings of complete answers for an evaluation. You are read-only: do not create, edit or delete files in the repository (scratch files only in your own /tmp scratch directory). Do not guess: every decision needs verbatim evidence; if you cannot decide, mark the item unresolved and say why. Packets can be long: work item by item, save your verdicts to your scratch file as you go, and search the ledger file (grep) instead of reading it whole.

Packet directory: ${rel}/
- texts/T<nn>.md: COMPLETE answers. Every line starts with "L<n>: " (not part of the text). Summary, body, appendix and notes count equally. Never decide that something is missing before reading the whole text (search for key terms and paraphrases).
- task/<unit>.task.md, task/<unit>.guide.md: the task the answers respond to and its interpretation.
- rubrics/<unit>.md (K and Q items only): an evaluator-only reference rubric established after the answers were written.
- ledgers/T<nn>.ledger.json (O items only): the decision ledger that text was written from (id, decision, statement, conditions, note, evidence, taskLink, quote), only to decide whether a claim of the text comes from it.
- items.json: your items (field "text" names the text file; P items have no text).

Masking: the origin of each text is hidden on purpose; do not try to find out which process or condition produced it. Do not open anything under results/bottleneck-isolation/ other than this packet directory, nothing under results/quality-validation/, results/synthesis-validation/, results/delivery-validation*/, results/qualification-validation/ or results/qualification-validation-retry1/ except the evidence files an item lists, and never results/qualification-validation-retry1/keys/ or any judgment, report, reference or score file of any study.

Item kinds:
- C: a registered statement (claim.statement, as worded, with its own negation, conditions and specifics) in one text. "readers" are two independent readings (pointers, not evidence). Decide yourself: realization complete | partial (core present but a substantive element missing or changed) | missing | opposed (the text says it is false or not accurate); stance asserted | hedged (unverified, uncertain, open) | rejected | absent | mixed (one occurrence asserts while another hedges or rejects; give both quotes). Repeating a denial such as "X is not a defect" ASSERTS that statement.
- K: one rubric criterion (rubrics/<unit>.md) in one text: credit 1 if the text states what the criterion requires correctly (any wording; hedged but correct counts; a contradicting statement does not), else 0.
- Q: passages alleged to contradict the rubric's reference facts: confirmed true|false (does the passage, read in context, assert something the rubric contradicts?) and the criterion.
- O: claims of the text a reader could not trace to the text's ledger (ledgers/T<nn>.ledger.json). Decide origin: ledger (expressed by an entry's statement, condition/limit or note; give ledgerIds), ledger_background (only from an entry's evidence, taskLink or quote; give ledgerIds), new (a substantive claim about the task's subject traceable to no ledger field), or not_a_claim (formatting, navigation, a restatement of the task). For EVERY distinct new claim give: claim (short), quote (verbatim), stance asserted|hedged, support supported|refuted|insufficient|conflicting judged against the evidence listed in the item (basis: path:line or command and result), relevance finding|supporting|requested_context|out|ambiguous judged against the task and guide, salience essential (the task's main question or conclusion depends on it) | context | detail.
- X: an alleged internal contradiction between passages of one text: confirmed true|false.
- P: a registered statement checked against the sources listed in "evidence" (independent source check; no text): support supported | refuted | insufficient (the sources do not settle it) with basis (path:line, record line or command and result).

Return everything in report_result: kind "verify", a short summary, and data exactly in this form (one verdict per item of items.json):
{"packet":"${packet}","round":${round},"items":[
 {"item":"C-...","realization":"complete","stance":"asserted","quotes":[{"line":12,"quote":"verbatim text without the L-prefix"}],"reason":"...","resolved":true},
 {"item":"K-...","credit":1,"quotes":[{"line":12,"quote":"..."}],"reason":"...","resolved":true},
 {"item":"Q-...","confirmed":false,"criterion":"K4","quotes":[...],"reason":"...","resolved":true},
 {"item":"O-...","origin":"new","ledgerIds":[],"claims":[{"claim":"...","quote":"verbatim","stance":"asserted","support":"supported","basis":"path:line ...","relevance":"supporting","salience":"context"}],"reason":"...","resolved":true},
 {"item":"X-...","confirmed":false,"quotes":[...],"reason":"...","resolved":true},
 {"item":"P-...","support":"supported","basis":"path:line ...","reason":"...","resolved":true},
 {"item":"...","resolved":false,"reason":"why it cannot be decided"}
]}
Quotes are copied exactly from the text (at least 3 words; without the "L<n>: " prefix). For realization "missing" or credit 0 quotes may be empty, but reason must say what you searched for. Before reporting, validate your JSON (write it to your scratch directory) with:
  node --import tsx experiments/mdsd-ab/bottleneck-eval.ts check-verdicts ${rel} <your verdicts.json>
(run from the repository root /home/arthur/Code/oh-my-pi-extensions/orche); fix every error it reports.
`;
}
const judgeLedgerView = (l: LedgerBI) => `${JSON.stringify({ entries: l.entries.map(e => ({ id: e.id, decision: e.decision, statement: e.statement, conditions: e.conditions, note: e.note, evidence: e.evidence, taskLink: e.taskLink, quote: e.quote })) }, null, 1)}\n`;
export async function writePackets(round: number, bins: Item[][], extra: Record<string, unknown> = {}): Promise<void> {
  const items = bins.flat();
  if (bins.length > WORKERS || bins.some(b => b.reduce((n, i) => n + WEIGHT(i), 0) > PACKET_CAP)) throw new Error("packet plan exceeds the worker or packet ceiling");
  const dir = join(ADJ, `round-${round}`);
  if (existsSync(join(dir, "items.json"))) throw new Error(`round ${round} packets exist; never overwrite`);
  const ids = opaqueIds(), byTid = new Map([...ids].map(([k, v]) => [v, k])), assignment: Record<string, string> = {};
  await mkdir(ADJ, { recursive: true });
  if (!existsSync(join(ADJ, "opaque.json"))) await write(join(ADJ, "opaque.json"), Object.fromEntries(ids));
  for (const [n, bin] of bins.entries()) {
    const name = `P${round}-${n + 1}`, p = join(dir, "packets", name);
    for (const sub of ["texts", "task", "rubrics", "ledgers"]) await mkdir(join(p, sub), { recursive: true });
    for (const tid of new Set(bin.flatMap(i => i.text ? [i.text] : []))) await writeFile(join(p, "texts", `${tid}.md`), numberLines(textOf(byTid.get(tid)!)!));
    for (const u of new Set(bin.map(i => i.unit))) { await writeFile(join(p, "task", `${u}.task.md`), text(join(RETRY1, "inputs", u, "task.md"))); await writeFile(join(p, "task", `${u}.guide.md`), text(join(RETRY1, "inputs", u, "guide.md"))); }
    for (const u of new Set(bin.filter(i => i.kind === "K" || i.kind === "Q").map(i => i.unit))) await writeFile(join(p, "rubrics", `${u}.md`), text(join(BI, "instruments/rubrics", `${u}.md`)));
    for (const tid of new Set(bin.filter(i => i.kind === "O").map(i => i.text!))) { const info = textInfo(byTid.get(tid)!); await writeFile(join(p, "ledgers", `${tid}.ledger.json`), judgeLedgerView(armLedger(info.ledger!, info.arm as "A" | "R"))); }
    await write(join(p, "items.json"), { packet: name, round, items: bin.map(packetItem) });
    await writeFile(join(p, "instructions.md"), instructions(name, round, p));
    for (const i of bin) assignment[i.item] = name;
  }
  const count = (xs: Item[]) => xs.reduce((acc: Record<string, number>, i) => { acc[`${i.kind}/${i.category}${i.purpose ? `/${i.purpose}` : ""}`] = (acc[`${i.kind}/${i.category}${i.purpose ? `/${i.purpose}` : ""}`] ?? 0) + 1; return acc; }, {});
  await write(join(dir, "items.json"), { round, createdAt: new Date().toISOString(), counts: count(items), items, assignment, packets: bins.map((b, n) => ({ packet: `P${round}-${n + 1}`, items: b.length, weight: b.reduce((k, i) => k + WEIGHT(i), 0), texts: [...new Set(b.flatMap(i => i.text ? [i.text] : []))], kinds: count(b) })), ...extra });
}

// ---- verdicts -------------------------------------------------------------------------------------------------------------------------------
const REALIZATION = ["complete", "partial", "missing", "opposed"], STANCE = ["asserted", "hedged", "rejected", "absent", "mixed"], ORIGINS = ["ledger", "ledger_background", "new", "not_a_claim"], SUPPORT = ["supported", "refuted", "insufficient", "conflicting"], RELEVANCE = ["finding", "supporting", "requested_context", "out", "ambiguous"];
const quoteOk = (q: unknown, body: string) => typeof q === "string" && q.trim().length > 0 && (body.includes(q.trim()) || spanFound(q, body, 3));
/** `ledgerIds`: ids of each text's own ledger (packet ledgers/); a ledger origin naming any other id is invalid (addendum 4). */
export function checkVerdicts(items: Item[], data: any, bodies: Map<string, string>, ledgerIds: Map<string, Set<string>> = new Map()): { errors: string[]; valid: Map<string, any> } {
  const errors: string[] = [], validV = new Map<string, any>();
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) return { errors: ["data.items must be an array"], valid: validV };
  const by = new Map<string, any[]>();
  for (const v of data.items) by.set(String(v?.item), [...(by.get(String(v?.item)) ?? []), v]);
  for (const id of by.keys()) if (!items.some(i => i.item === id)) errors.push(`${id}: not an item of this packet`);
  for (const i of items) {
    const vs = by.get(i.item) ?? [], body = i.text ? bodies.get(i.text) ?? "" : "", errs: string[] = [];
    if (vs.length !== 1) { errors.push(`${i.item}: ${vs.length} verdicts (exactly one required)`); continue; }
    const v = vs[0], quotes = Array.isArray(v.quotes) ? v.quotes : [];
    if (v.resolved === false) { if (!String(v.reason ?? "").trim()) errs.push("unresolved without reason"); }
    else if (v.resolved !== true) errs.push("resolved must be true or false");
    else if (!String(v.reason ?? "").trim()) errs.push("reason required");
    else if (i.kind === "C") {
      if (!REALIZATION.includes(v.realization)) errs.push("realization"); if (!STANCE.includes(v.stance)) errs.push("stance");
      if (v.realization !== "missing" && !quotes.length) errs.push("quotes required unless realization is missing");
      if (v.realization === "missing" && !String(v.reason ?? "").trim()) errs.push("missing needs a reason saying what was searched");
      quotes.forEach((q: any, n: number) => { if (!quoteOk(q?.quote, body)) errs.push(`quote ${n + 1} not found verbatim`); });
    } else if (i.kind === "K") {
      if (v.credit !== 0 && v.credit !== 1) errs.push("credit must be 0 or 1");
      if (v.credit === 1 && !quotes.length) errs.push("credit 1 needs a verbatim quote");
      if (!String(v.reason ?? "").trim()) errs.push("reason");
      quotes.forEach((q: any, n: number) => { if (!quoteOk(q?.quote, body)) errs.push(`quote ${n + 1} not found verbatim`); });
    } else if (i.kind === "Q" || i.kind === "X") {
      if (typeof v.confirmed !== "boolean") errs.push("confirmed must be true or false");
      if (v.confirmed === true && quotes.length < (i.kind === "X" ? 2 : 1)) errs.push(i.kind === "X" ? "a confirmed contradiction needs both passages quoted" : "a confirmed rubric contradiction needs the passage quoted");
      if (i.kind === "Q" && v.confirmed === true && !String(v.criterion ?? "").trim()) errs.push("criterion");
      quotes.forEach((q: any, n: number) => { if (!quoteOk(q?.quote, body)) errs.push(`quote ${n + 1} not found verbatim`); });
    } else if (i.kind === "O") {
      if (!ORIGINS.includes(v.origin)) errs.push("origin");
      if (v.origin === "new") { if (!Array.isArray(v.claims) || !v.claims.length) errs.push("new origin needs claims"); else v.claims.forEach((c: any, n: number) => { if (!String(c?.claim ?? "").trim()) errs.push(`claim ${n + 1}: claim`); if (!quoteOk(c?.quote, body)) errs.push(`claim ${n + 1}: quote not found verbatim`); if (!["asserted", "hedged"].includes(c?.stance)) errs.push(`claim ${n + 1}: stance`); if (!SUPPORT.includes(c?.support)) errs.push(`claim ${n + 1}: support`); if (!RELEVANCE.includes(c?.relevance)) errs.push(`claim ${n + 1}: relevance`); if (!["essential", "context", "detail"].includes(c?.salience)) errs.push(`claim ${n + 1}: salience`); if (!String(c?.basis ?? "").trim()) errs.push(`claim ${n + 1}: basis`); }); }
      else if ((v.origin === "ledger" || v.origin === "ledger_background") && (!Array.isArray(v.ledgerIds) || !v.ledgerIds.length)) errs.push("ledger origin needs ledgerIds");
      else if ((v.origin === "ledger" || v.origin === "ledger_background") && v.ledgerIds.some((x: unknown) => !ledgerIds.get(i.text ?? "")?.has(String(x)))) errs.push("ledgerIds must be ids of the text's own ledger");
    } else if (i.kind === "P") {
      if (!["supported", "refuted", "insufficient"].includes(v.support)) errs.push("support must be supported, refuted or insufficient");
      if (!String(v.basis ?? "").trim()) errs.push("basis");
    }
    if (errs.length) errors.push(`${i.item}: ${errs.join("; ")}`); else validV.set(i.item, v);
  }
  return { errors, valid: validV };
}
const packetBodies = (dir: string) => new Map(existsSync(join(dir, "texts")) ? readdirSync(join(dir, "texts")).map(f => [f.replace(/\.md$/, ""), text(join(dir, "texts", f)).split("\n").map(l => l.replace(/^L\d+: /, "")).join("\n")]) : []);
const packetLedgerIds = (dir: string) => new Map<string, Set<string>>(existsSync(join(dir, "ledgers")) ? readdirSync(join(dir, "ledgers")).map(f => [f.replace(/\.ledger\.json$/, ""), new Set<string>((json(join(dir, "ledgers", f)).entries as any[]).map(e => String(e.id)))]) : []);
export async function collect(round: number, files: string[]): Promise<void> {
  const dir = join(ADJ, `round-${round}`), meta = json(join(dir, "items.json")), all = meta.items as Item[];
  await mkdir(join(dir, "results"), { recursive: true });
  for (const file of files) {
    const data = reportData(file);
    if (!data) { console.error(`${file}: no report_result data with packet/items`); continue; }
    const out = join(dir, "results", `${data.packet}.json`);
    if (existsSync(out)) { console.error(`${out} exists; not overwritten`); continue; }
    const items = all.filter(i => meta.assignment[i.item] === data.packet), c = checkVerdicts(items, data, packetBodies(join(dir, "packets", data.packet)), packetLedgerIds(join(dir, "packets", data.packet)));
    await write(out, { packet: data.packet, round, session: file, sessionSha256: sha(readFileSync(file)), collectedAt: new Date().toISOString(), errors: c.errors, validVerdicts: c.valid.size, items: items.length, data });
    console.log(data.packet, `valid ${c.valid.size}/${items.length}`, c.errors.slice(0, 5));
  }
}
/** Round 1 is authoritative; round 2 fills its "resolve" items and records "second" readings separately (never replacing a valid first). */
export function acceptedVerdicts(): { verdicts: Map<string, any>; second: Map<string, { first: any; second: any }>; items: Map<string, Item>; rounds: number[] } {
  const verdicts = new Map<string, any>(), second = new Map<string, { first: any; second: any }>(), items = new Map<string, Item>(), rounds: number[] = [];
  for (const round of [1, 2]) {
    const dir = join(ADJ, `round-${round}`);
    if (!existsSync(join(dir, "items.json"))) continue;
    rounds.push(round);
    const meta = json(join(dir, "items.json")), list = meta.items as Item[];
    for (const i of list) if (round === 1 || i.purpose === "adjudicate") items.set(i.item, i);
    const results = existsSync(join(dir, "results")) ? readdirSync(join(dir, "results")).map(f => json(join(dir, "results", f))) : [];
    for (const r of results) {
      const packetItems = list.filter(i => meta.assignment[i.item] === r.packet), c = checkVerdicts(packetItems, r.data, packetBodies(join(dir, "packets", r.packet)), packetLedgerIds(join(dir, "packets", r.packet)));
      for (const i of packetItems) {
        const v = c.valid.get(i.item);
        if (round === 1) { if (v && v.resolved) verdicts.set(i.item, v); }
        else if (i.purpose === "second") second.set(i.item, { first: verdicts.get(i.item), second: v });
        else if (v && v.resolved && !verdicts.has(i.item)) verdicts.set(i.item, v);
      }
    }
  }
  return { verdicts, second, items, rounds };
}

// ---- measures (protocol §8) ---------------------------------------------------------------------------------------------------------------
export interface Measures { status: "judged" | "incomplete"; reason?: string; EC: Range; VC: Range; OC: Range; Fcore: Range; Fminor: Range; Ucore: Range; Uminor: Range; Dcore: Range; O: Range; Hcore: Range; corrections: Range; Rpts: Range; Rcontra: Range; X: Range; UAinvalid: Range; UAinvalidEssential: Range; uaOpen: number; UAvalid: Range; UAundetermined: Range; capViolation: number; artifactMissing: number; leak: number; chars?: number; unresolvedItems: string[] }
export const LEAK = /labeller|hidden\/test\.patch|reference\/fix\.patch|fixtures\/advisor-bench|failToPass|test_comment_on_opening_line_of_aliased_import_does_not_move|\be7a0891|\bdd98d5b/i;
export interface Readings { pred: (id: string, p: Pred) => Tri; credit: (c: string) => Tri; confirmed: (prefix: "Q" | "X") => Range; ua: Range[]; uaEssential: Range; uaOpen: number; unresolved: string[] }
const itemCache = new Map<string, Item[]>();
/** All Tier-1 candidate items of a text (kept or trimmed by the allocation): a trimmed allegation stays unresolved, never zero. */
export const textItems = (t: TextFacts): Item[] => { const k = `${t.key}|${t.tid}`; if (!itemCache.has(k)) itemCache.set(k, itemsOf(t)); return itemCache.get(k)!; };
/** Readings of one judged text: verdicts first, then Tier-1 agreement, else unresolved. `ideal` replaces readings with the packet-implied ones. */
export function readingsOf(t: TextFacts, verdicts: Map<string, any>, _items?: Map<string, Item>): Readings {
  const s = t.state, unresolved: string[] = [];
  const pred = (id: string, p: Pred): Tri => { const v = tri(s.readers!.map(m => m.get(id)), p, verdicts.get(`C-${t.tid}-${id}`)); return v; };
  const credits = s.rubric!.map(j => new Map<string, any>(j.value.criteria.map((c: any) => [c.id, c.credit])));
  const credit = (c: string): Tri => { const v = verdicts.get(`K-${t.tid}-${c}`); if (v?.resolved) return v.credit === 1; const [a, b] = credits.map(m => m.get(c)); if (a === b) return a === 1; unresolved.push(`K-${t.tid}-${c}`); return undefined; };
  const own = textItems(t).filter(i => i.kind === "Q" || i.kind === "X" || i.kind === "O");
  const confirmed = (prefix: "Q" | "X"): Range => { const r = r0(); for (const i of own.filter(x => x.kind === prefix)) { const v = verdicts.get(i.item); addTri(r, v ? v.confirmed === true : undefined); if (!v) unresolved.push(i.item); } return r; };
  const ua: Range[] = [r0(), r0(), r0()], uaEssential = r0();
  let uaOpen = 0;
  for (const i of own.filter(x => x.kind === "O")) {
    const v = verdicts.get(i.item);
    if (!v) { uaOpen++; unresolved.push(i.item); continue; }
    if (v.origin !== "new") continue;
    for (const c of v.claims ?? []) { const asserted = c.stance === "asserted", bad = asserted && (c.support === "refuted" || c.support === "insufficient" || c.support === "conflicting" || c.relevance === "out"), good = c.support === "supported" && ["finding", "supporting", "requested_context"].includes(c.relevance); const k = bad ? 0 : good ? 1 : 2; ua[k]!.lo++; ua[k]!.hi++; if (bad && c.salience === "essential") { uaEssential.lo++; uaEssential.hi++; } }
  }
  return { pred, credit, confirmed, ua, uaEssential, uaOpen, unresolved };
}
export function idealReadings(ledger: LedgerBI): (id: string, p: Pred) => Tri {
  const by = new Map(ledger.entries.map(e => [e.id, e]));
  const reading = (id: string): Reading => {
    const e = by.get(id)!;
    if (e.decision === "include") return { realization: "complete", stance: "asserted" };
    if (e.decision === "uncertain") return { realization: "complete", stance: "hedged" };
    if (e.decision === "correct") return { realization: "opposed", stance: "rejected" };
    if (e.decision === "duplicate") { const t = by.get(e.duplicateOf ?? ""); return t && APPROVED.includes(t.decision) ? reading(t.id) : { realization: "missing", stance: "absent" }; }
    return { realization: "missing", stance: "absent" };
  };
  return (id, p) => P[p](reading(id));
}
export function measuresOf(t: TextFacts, rd: Readings | undefined, o: RefOpts = MAIN_REF, ideal?: (id: string, p: Pred) => Tri): Measures {
  const empty = (): Measures => ({ status: "incomplete", reason: t.state.reason, EC: r0(), VC: r0(), OC: r0(), Fcore: r0(), Fminor: r0(), Ucore: r0(), Uminor: r0(), Dcore: r0(), O: r0(), Hcore: r0(), corrections: r0(), Rpts: r0(), Rcontra: r0(), X: r0(), UAinvalid: r0(), UAinvalidEssential: r0(), uaOpen: 0, UAvalid: r0(), UAundetermined: r0(), capViolation: 0, artifactMissing: 0, leak: 0, unresolvedItems: [] });
  if (t.state.status !== "judged" || !rd) return empty();
  const m = empty(); m.status = "judged"; delete m.reason;
  const refs = refsFor(t.unit, o), pred = ideal ?? rd.pred, claims = { get: (id: string) => claimOf(t.unit, id) };
  const clusterCount = (keep: (id: string) => boolean): Range => { const r = r0(); for (const cl of clustersOf(refs, keep)) addTri(r, cl.some(id => pred(id, "covered") === true) ? true : cl.some(id => pred(id, "covered") === undefined) ? undefined : false); return r; };
  m.EC = clusterCount(id => valid(refs.get(id), o) && essential(refs.get(id)));
  m.VC = clusterCount(id => valid(refs.get(id), o));
  m.OC = { lo: Math.max(0, m.VC.lo - m.EC.hi), hi: Math.max(0, m.VC.hi - m.EC.lo) };
  for (const [id, r] of refs) {
    const ess = essential(r);
    if (r.support === "refuted") { addTri(ess ? m.Fcore : m.Fminor, pred(id, "asserted")); addTri(m.corrections, pred(id, "rejOpp")); }
    if (unsupported(r)) addTri(ess ? m.Ucore : m.Uminor, pred(id, "asserted"));
    if (r.relevance === "out") addTri(m.O, pred(id, "asserted"));
    if (ess && valid(r, o)) { addTri(m.Dcore, pred(id, "rejOpp")); if (claims.get(id)?.stance !== "uncertain") addTri(m.Hcore, pred(id, "hedged")); }
  }
  const criteria: string[] = t.state.rubric![0].criteria;
  for (const c of criteria) addTri(m.Rpts, ideal ? false : rd.credit(c));
  if (!ideal) { m.Rcontra = rd.confirmed("Q"); m.X = rd.confirmed("X"); [m.UAinvalid, m.UAvalid, m.UAundetermined] = rd.ua as [Range, Range, Range]; m.UAinvalidEssential = rd.uaEssential; m.uaOpen = rd.uaOpen; m.unresolvedItems = [...new Set(rd.unresolved)]; }
  const body = t.state.body ?? "";
  m.chars = chars(body);
  if (t.key.startsWith("exp1:")) { m.capViolation = chars(body) > CAP[t.unit]! ? 1 : 0; m.leak = (body.match(/\bk\d{1,3}\b/g) ?? []).length + (LEAK.test(body) ? 1 : 0) > 0 ? 1 : 0; m.artifactMissing = body.trim() ? 0 : 1; }
  return m;
}

// ---- classification (protocol §9) ---------------------------------------------------------------------------------------------------------
/** Main gates G1 + G2 (protocol v1 §8; addendum 3 revokes the addendum-2 demotion of UAinvalid). */
export const GATES = ["Rcontra", "Fcore", "Ucore", "Dcore", "UAinvalid", "capViolation", "artifactMissing", "leak"] as const;
export const JOINT_UP = ["Rpts", "EC"] as const, JOINT_DOWN = ["Hcore", "X", "minor"] as const;
export type Usefulness = "P" | "Q" | "equal" | "unresolved";
type Point = Record<string, number>;
/** One extreme reading of a pair: unresolved items all in favor of `favor`. */
/** An open UA cluster (no verdict) may hold any number of invalid claims: unbounded at the unfavourable extreme unless `uaConditional`. */
function point(m: Measures, favorThis: boolean, extraJoint: boolean, uaConditional = false): Point {
  const up = (r: Range) => favorThis ? r.hi : r.lo, down = (r: Range) => favorThis ? r.lo : r.hi;
  const p: Point = { Rcontra: down(m.Rcontra), Fcore: down(m.Fcore), Ucore: down(m.Ucore), Dcore: down(m.Dcore), UAinvalid: favorThis || uaConditional ? m.UAinvalid.lo : m.uaOpen > 0 ? Infinity : m.UAinvalid.hi, capViolation: m.capViolation, artifactMissing: m.artifactMissing, leak: m.leak, Rpts: up(m.Rpts), EC: up(m.EC), Hcore: down(m.Hcore), X: down(m.X), minor: down(m.Fminor) + down(m.Uminor) + down(m.O) };
  if (extraJoint) p.OC = up(m.OC);
  return p;
}
export function classifyPoints(p: Point, q: Point, use: Usefulness, gates: readonly string[] = GATES): string {
  const gateDiff = gates.filter(k => p[k] !== q[k]);
  if (gateDiff.length) { const better = gateDiff.some(k => p[k]! < q[k]!), worse = gateDiff.some(k => p[k]! > q[k]!); return better && !worse ? "better" : worse && !better ? "worse" : "mixed"; }
  let better = false, worse = false;
  for (const k of [...JOINT_UP, ...(p.OC !== undefined ? ["OC"] : [])]) { if (p[k]! > q[k]!) better = true; if (p[k]! < q[k]!) worse = true; }
  for (const k of JOINT_DOWN) { if (p[k]! < q[k]!) better = true; if (p[k]! > q[k]!) worse = true; }
  if (use === "P") better = true; else if (use === "Q") worse = true;
  return better && worse ? "mixed" : better ? "better" : worse ? "worse" : "tie";
}
/** `uaConditional`: the labelled conditional reading that assumes open (unadjudicated) UA clusters hold no invalid claim (addendum 3). */
export function classify(mp: Measures, mq: Measures, use: Usefulness, extraJoint = false, uaConditional = false): { class: string; possible: string[] } {
  if (mp.status !== "judged" || mq.status !== "judged") return { class: "incomplete", possible: ["incomplete"] };
  const uses: Usefulness[] = use === "unresolved" ? ["P", "Q"] : [use];
  const a = classifyPoints(point(mp, true, extraJoint, uaConditional), point(mq, false, extraJoint, uaConditional), uses[0]!), b = classifyPoints(point(mp, false, extraJoint, uaConditional), point(mq, true, extraJoint, uaConditional), uses.at(-1)!);
  const possible = [...new Set([a, b])];
  return { class: possible.length === 1 ? a : `unresolved {${possible.join(", ")}}`, possible };
}
export function usefulnessOf(c: Comparison): { verdict: Usefulness; P: number; Q: number; tie: number; valid: number; byOrder: any } {
  const js = pairJobs().filter(j => j.comparison.id === c.id).map(j => { const f = instrumentFile("pairwise", j.key); return existsSync(f) ? { j, r: json(f) } : { j, r: undefined }; });
  let p = 0, q = 0, tie = 0, validN = 0; const byOrder: any = {};
  for (const { j, r } of js) {
    if (!r?.valid) continue;
    validN++;
    const o = r.value.overall, pick = o === "tie" ? "tie" : (o === "X" ? j.X : j.Y) === c.P ? "P" : "Q";
    if (pick === "P") p++; else if (pick === "Q") q++; else tie++;
    byOrder[`${j.fam}.o${j.order}`] = pick;
  }
  return { verdict: validN < 4 ? "unresolved" : p >= 3 ? "P" : q >= 3 ? "Q" : "equal", P: p, Q: q, tie, valid: validN, byOrder };
}

// ---- scores (protocol §8-§10) -------------------------------------------------------------------------------------------------------------
export interface Ctx { facts: Map<string, TextFacts>; verdicts: Map<string, any>; items: Map<string, Item> }
export function context(verdicts?: Map<string, any>): Ctx { const a = acceptedVerdicts(); return { facts: new Map(facts().map(f => [f.key, f])), verdicts: verdicts ?? a.verdicts, items: a.items }; }
export function measuresFor(ctx: Ctx, key: string, o: RefOpts = MAIN_REF): Measures { const t = ctx.facts.get(key)!; return measuresOf(t, t.state.status === "judged" ? readingsOf(t, ctx.verdicts, ctx.items) : undefined, o); }
export function packetImplied(ctx: Ctx, key: string, o: RefOpts = MAIN_REF): Measures | undefined {
  if (!key.startsWith("exp1:")) return undefined;
  const t = ctx.facts.get(key)!, info = textInfo(key);
  if (t.state.status !== "judged") return undefined;
  return measuresOf(t, readingsOf(t, ctx.verdicts, ctx.items), o, idealReadings(armLedger(info.ledger!, info.arm as "A" | "R")));
}
const B_MEASURES = ["EC", "VC", "OC", "Fcore", "Fminor", "Ucore", "Uminor", "Dcore", "O", "Hcore", "corrections"] as const;
/** Writing-attributed part of every labeller-b measure: actual − packet-implied (a range). */
export function writingAttributed(actual: Measures, implied: Measures): Record<string, Range> { return Object.fromEntries(B_MEASURES.map(k => [k, { lo: actual[k].lo - implied[k].hi, hi: actual[k].hi - implied[k].lo }])); }
function writingOnly(actual: Measures, implied: Measures | undefined): Measures {
  if (!implied || actual.status !== "judged") return actual;
  const w = writingAttributed(actual, implied), out: any = { ...actual };
  for (const k of B_MEASURES) out[k] = w[k];
  return out;
}
export function compareAll(ctx: Ctx, o: RefOpts = MAIN_REF, opts: { extraJoint?: boolean; writingOnly?: boolean; uaConditional?: boolean } = {}): any[] {
  return comparisons().map(c => {
    let mp = measuresFor(ctx, c.P, o), mq = measuresFor(ctx, c.Q, o);
    if (opts.writingOnly && c.kind !== "vs-S" && c.kind !== "S-E") { mp = writingOnly(mp, packetImplied(ctx, c.P, o)); mq = writingOnly(mq, packetImplied(ctx, c.Q, o)); }
    const u = usefulnessOf(c), k = classify(mp, mq, u.verdict, !!opts.extraJoint, !!opts.uaConditional);
    return { id: c.id, kind: c.kind, context: c.context, P: c.P, Q: c.Q, class: k.class, possible: k.possible, usefulness: u };
  });
}
/** G1 total; an open UA cluster makes it unbounded (addendum 4: UA = detected claims + open clusters, no finite upper bound). */
const value = (m: Measures, k: string): Range => { if (k !== "G1") return (m as any)[k]; const r = ["Rcontra", "Fcore", "Ucore", "Dcore", "UAinvalid"].reduce((acc, g) => ({ lo: acc.lo + (m as any)[g].lo, hi: acc.hi + (m as any)[g].hi }), r0()); return m.uaOpen > 0 ? { lo: r.lo, hi: Infinity } : r; };
/** Repeat-noise check (protocol §10): Δk = m(R-rk) − m(A-rk); beyond noise iff same sign and min|Δ| > max(|A1−A2|, |R1−R2|) (resolved values only). */
export function noiseCheck(ctx: Ctx, ledger: string): any {
  return Object.fromEntries(["EC", "Rpts", "G1"].map(k => {
    const v = (arm: string, rep: number) => { const m = measuresFor(ctx, `exp1:${ledger}/${arm}-r${rep}`); return m.status === "judged" ? value(m, k) : undefined; };
    const a1 = v("A", 1), a2 = v("A", 2), r1 = v("R", 1), r2 = v("R", 2);
    if (![a1, a2, r1, r2].every(x => x && x.lo === x.hi)) return [k, { status: "unresolved or incomplete", values: { a1, a2, r1, r2 } }];
    const d1 = r1!.lo - a1!.lo, d2 = r2!.lo - a2!.lo, noise = Math.max(Math.abs(a1!.lo - a2!.lo), Math.abs(r1!.lo - r2!.lo));
    const beyond = Math.sign(d1) === Math.sign(d2) && d1 !== 0 && Math.min(Math.abs(d1), Math.abs(d2)) > noise;
    return [k, { A: [a1!.lo, a2!.lo], R: [r1!.lo, r2!.lo], delta: [d1, d2], noise, beyondNoise: beyond, direction: beyond ? (d1 > 0 ? "R higher" : "R lower") : "within repeat noise" }];
  }));
}
export function exp1Interpretation(rows: any[]): any {
  const cls = (id: string) => rows.find(r => r.id === id)?.class;
  const per = Object.fromEntries(EXP1.map(l => {
    const ar = REPS_BI.map(rep => cls(`AR.${l}.r${rep}`)), rVsS = REPS_BI.map(rep => cls(`S.${l}.R-r${rep}`)), aVsS = REPS_BI.map(rep => cls(`S.${l}.A-r${rep}`));
    // AR.* compares P = A with Q = R: "worse" for A means R better
    const RgtA = ar.every(c => c === "worse"), AgeR = ar.every(c => c === "better" || c === "tie");
    return [l, { AvsR: ar, RgtA, AgeR, RvsS: rVsS, AvsS: aVsS, RgeS: rVsS.every(c => c === "better" || c === "tie"), RltS: rVsS.every(c => c === "worse"), AltS: aVsS.every(c => c === "worse") }];
  }));
  return per;
}
export function score(): any {
  const a = acceptedVerdicts(), ctx = context(a.verdicts);
  const texts = Object.fromEntries(TEXTS.map(k => { const m = measuresFor(ctx, k), pi = packetImplied(ctx, k), f = ctx.facts.get(k)!, ua = k.startsWith("exp1:") ? uaCandidates(f) : undefined; return [k, { tid: f.tid, chars: f.state.body ? chars(f.state.body) : undefined, measures: m, ...(ua ? { uaCandidates: { judgeOtherClaims: ua.others, afterLexicalFilter: ua.candidates, clusters: ua.clusters, adjudicated: ua.groups.filter(([n]) => a.verdicts.has(`O-${f.tid}-${n}`)).length, open: ua.groups.filter(([n]) => !a.verdicts.has(`O-${f.tid}-${n}`)).map(([n]) => `O-${f.tid}-${n}`) } } : {}), ...(pi ? { packetImplied: pi, writingAttributed: m.status === "judged" ? writingAttributed(m, pi) : undefined } : {}) }]; }));
  const main = compareAll(ctx), conditional = compareAll(ctx, MAIN_REF, { uaConditional: true });
  const condOut = { note: "conditional reading (addendum 3): open UA clusters assumed to hold no invalid claim; never the main result", changed: conditional.filter((r, i) => r.class !== main[i].class).map(r => ({ id: r.id, main: main.find(x => x.id === r.id).class, conditional: r.class })), interpretation: exp1Interpretation(conditional) };
  const sens: Record<string, any[]> = {
    contextExcluded: compareAll(ctx, { ...MAIN_REF, contextIncluded: false }), ambiguousIncluded: compareAll(ctx, { ...MAIN_REF, ambiguous: true }), optionalInJoint: compareAll(ctx, MAIN_REF, { extraJoint: true }),
    secondReference: compareAll(ctx, { ...MAIN_REF, second: true }), writingOnly: compareAll(ctx, MAIN_REF, { writingOnly: true }),
    secondHostReading: compareAll(context(new Map([...a.verdicts, ...[...a.second].filter(([, v]) => v.second?.resolved).map(([k, v]) => [k, v.second] as [string, any])]))),
  };
  const changed = Object.fromEntries(Object.entries(sens).map(([k, rows]) => [k, rows.filter((r, i) => r.class !== main[i].class).map(r => ({ id: r.id, main: main.find(x => x.id === r.id).class, reading: r.class }))]));
  const interp = exp1Interpretation(main), interpBy = Object.fromEntries(Object.entries(sens).map(([k, rows]) => [k, exp1Interpretation(rows)]));
  const noise = Object.fromEntries(EXP1.map(l => [l, noiseCheck(ctx, l)]));
  const p0 = p0Report(ctx);
  const e2a = estimate(ctx, main, sens);
  const items = [...a.items.values()], neverSent = [...ctx.facts.values()].flatMap(f => uaCandidates(f).groups.map(([n]) => `O-${f.tid}-${n}`)).filter(id => !a.items.has(id));
  const unresolvedShare = items.length + neverSent.length ? (items.filter(i => !a.verdicts.has(i.item)).length + neverSent.length) / (items.length + neverSent.length) : 0;
  const second = [...a.second.entries()].map(([item, v]) => ({ item, agree: !!v.first && !!v.second?.resolved && agreeOf(item, v.first, v.second), first: !!v.first, second: !!v.second?.resolved }));
  return { at: new Date().toISOString(), rounds: a.rounds, texts, comparisons: main, sensitivities: { changed }, conditionalOnOpenUA: condOut, exp1: { interpretation: interp, interpretationUnderSensitivities: interpBy, noise }, p0, e2a, adjudication: { items: items.length, accepted: a.verdicts.size, neverSentUA: neverSent.length, unresolvedShare, secondReading: { items: second.length, agree: second.filter(s => s.agree).length, rows: second } } };
}
const agreeOf = (item: string, a: any, b: any) => item.startsWith("C-") ? a.realization === b.realization && a.stance === b.stance : item.startsWith("K-") ? a.credit === b.credit : item.startsWith("P-") ? a.support === b.support : item.startsWith("O-") ? a.origin === b.origin : a.confirmed === b.confirmed;
export function p0Report(ctx: Ctx): any {
  const histS: Record<string, number> = { "dev-r1": 3, "isort-r1": 8, "isort-r2": 8 };
  const sample = p0Sample(), r1 = existsSync(join(ADJ, "round-1/items.json")) ? json(join(ADJ, "round-1/items.json")) : undefined, r2 = existsSync(join(ADJ, "round-2/items.json")) ? json(join(ADJ, "round-2/items.json")) : undefined;
  const trimmedIds = new Set<string>(r1?.trimmed ?? []), unassessedIds = new Set<string>(r2?.unassessed ?? []);
  const stated = (u: string, cls: string[][]) => cls.map(cl => ({ ids: cl, statement: claimOf(u, [...cl].sort()[0]!).claim }));
  return Object.fromEntries(UNITS.map(u => {
    const sets = p0Sets(u, ctx.verdicts), S = ctx.facts.get(`pool:${u}/S`)!, E = ctx.facts.get(`pool:${u}/E`)!;
    const crit = S.state.status === "judged" && E.state.status === "judged" ? (S.state.rubric![0].criteria as string[]).map(c => ({ criterion: c, S: readingsOf(S, ctx.verdicts, ctx.items).credit(c), E: readingsOf(E, ctx.verdicts, ctx.items).credit(c) })) : [];
    const cat = (x: any) => x.S === undefined || x.E === undefined ? "unresolved" : x.S && x.E ? "both" : x.E ? "eOnly" : x.S ? "sOnly" : "neither";
    const rgrade = crit.reduce((acc: Record<string, string[]>, x) => { (acc[cat(x)] ??= []).push(x.criterion); return acc; }, {});
    const prov = p0Sets(u, new Map()), sideIn = (s: any, id: string) => (s.essential?.eOnly ?? []).some((cl: string[]) => cl.includes(id)) ? "eOnly" : (s.essential?.sOnly ?? []).some((cl: string[]) => cl.includes(id)) ? "sOnly" : "moved";
    const checks = sample.filter(i => i.unit === u).map(i => { const v = ctx.verdicts.get(i.item), id = i.claim.id; return { item: i.item, id, statement: i.claim.statement, sampledAs: sideIn(prov, id), nowSide: sideIn(sets, id), support: v?.support ?? (trimmedIds.has(i.item) ? "trimmed (unassessed)" : unassessedIds.has(i.item) ? "unassessed" : ctx.items.has(i.item) ? "unresolved" : "not allocated"), basis: v?.basis }; });
    const sCredits = crit.filter(x => x.S === true).length;
    return [u, { lGrade: sets.status === "judged" ? { essential: sets.essential.counts, allValid: sets.allValid.counts, eOnlyEssential: stated(u, sets.essential.eOnly), sOnlyEssential: stated(u, sets.essential.sOnly), unresolvedEssential: sets.essential.unresolved } : sets, rGrade: { byCriterion: crit, categories: rgrade, sFresh: sCredits, sHistorical: histS[u], devK1InPool: caseOf(u) === "dev" ? crit.filter(x => x.criterion.startsWith("K1.")).map(x => ({ criterion: x.criterion, S: x.S, E: x.E })) : undefined }, sourceChecks: checks, grades: "lGrade = labeller-b-derived coverage (LLM; the isort labeller read the upstream fix/tests); rGrade = evaluator-only rubric (isort: upstream fix + hidden test; dev: fix commits + LLM review) credited by the rubric judges and host verifiers; sourceChecks = independent host checks of sampled claims against code/evidence", laterDiscoveries: caseOf(u) === "dev" ? "dev K1 was established after S/E (fix/parent review); it counts only where the stored text itself states it" : undefined }];
  }));
}
/** E2-b prerequisite (protocol §10): pools where E is DETERMINATELY better than S; an unresolved or reading-free "possible better" never qualifies. */
/** Addendum 4: a pool also needs all four pairwise usefulness judgments valid (technically complete) to qualify. */
export const prerequisiteOf = (evsS: Record<string, string>, usefulValid: Record<string, number> = {}): string[] => Object.entries(evsS).filter(([u, c]) => c === "better" && (usefulValid[u] ?? 4) >= 4).map(([u]) => u);
export function estimate(ctx: Ctx, main: any[], sens: Record<string, any[]>): any {
  const pools = Object.fromEntries(UNITS.map(u => {
    const row = main.find(r => r.id === `SE.${u}`), flip = (c: string) => c === "better" ? "worse" : c === "worse" ? "better" : c.replace(/\b(better|worse)\b/g, x => x === "better" ? "worse" : "better");
    const sensE = Object.fromEntries(Object.entries(sens).map(([k, rows]) => [k, flip(rows.find(r => r.id === `SE.${u}`).class)]));
    const s = ctx.facts.get(`pool:${u}/S`)!.state, e = ctx.facts.get(`pool:${u}/E`)!.state;
    const ratio = s.body && e.body ? chars(e.body) / chars(s.body) : undefined;
    return [u, { EvsS: flip(row.class), usefulness: row.usefulness, lengthRatioEtoS: ratio && Math.round(ratio * 1000) / 1000, lengthStratum: ratio === undefined ? undefined : ratio <= 1.25 ? "<=1.25xS" : ratio <= 2 ? "1.25-2xS" : ">2xS", underSensitivities: sensE }];
  }));
  const better = prerequisiteOf(Object.fromEntries(Object.entries(pools).map(([u, p]: any) => [u, p.EvsS])), Object.fromEntries(Object.entries(pools).map(([u, p]: any) => [u, p.usefulness.valid])));
  const usefulnessIncomplete = Object.entries(pools).filter(([, p]: any) => p.usefulness.valid < 4).map(([u]) => u);
  const readingDependent = Object.entries(pools).filter(([, p]: any) => Object.values(p.underSensitivities).some(c => (c === "better") !== (p.EvsS === "better"))).map(([u]) => u);
  return { pools, prerequisiteMet: better.length > 0, betterPools: better, usefulnessIncomplete, readingDependentPools: readingDependent, reason: better.length ? `E determinately better than S in ${better.join(", ")}` : "no pool where E is determinately better than S" };
}

// ---- provisional (Tier-1 only) and round packets ---------------------------------------------------------------------------------------
export async function provisional(): Promise<any> {
  const ctx = context(new Map());
  const out = { at: new Date().toISOString(), note: "Tier-1 only (no host verdicts): planning of the adjudication allocation; not a result", texts: Object.fromEntries(TEXTS.map(k => [k, ctx.facts.get(k)!.state.status === "judged" ? measuresFor(ctx, k) : { status: "incomplete", reason: ctx.facts.get(k)!.state.reason }])), comparisons: compareAll(ctx), p0: p0Report(ctx), round1: (() => { const r = roundOneItems(); return { candidates: r.all, kept: r.items.length, trimmed: r.trimmed.length, deferred: r.deferred.length, packets: r.bins.map(b => b.reduce((n, i) => n + WEIGHT(i), 0)), weight: r.items.reduce((n, i) => n + WEIGHT(i), 0), byCategory: r.items.reduce((acc: Record<string, number>, i) => { acc[`${i.kind}/${i.category}`] = (acc[`${i.kind}/${i.category}`] ?? 0) + 1; return acc; }, {}) }; })() };
  out.comparisons.forEach((c: any) => { delete c.usefulness?.byOrder; });
  await write(join(BI, "provisional.json"), out);
  return out;
}
export async function packets(round: number): Promise<void> {
  if (round === 1) { const r = roundOneItems(); await writePackets(1, r.bins.map(b => b.map(i => ({ ...i, purpose: "adjudicate" as const }))), { trimmed: r.trimmed.map(i => i.item), deferred: r.deferred, candidates: r.all }); return; }
  const a = acceptedVerdicts(), list = [...a.items.values()], r1 = json(join(ADJ, "round-1", "items.json"));
  const deferred = ((r1.deferred ?? []) as Item[]).map(i => ({ ...i, purpose: "adjudicate" as const }));
  const resolve = list.filter(i => ["G", "Q", "O", "K", "C", "X", "P"].includes(i.category) && !a.verdicts.has(i.item)).map(i => ({ ...i, purpose: "resolve" as const }));
  const second: Item[] = [];
  for (const tid of new Set(list.flatMap(i => i.text ? [i.text] : []))) second.push(...list.filter(i => i.text === tid && ["G", "Q", "K", "C", "X"].includes(i.category) && a.verdicts.has(i.item)).sort((x, y) => sha(`R2:${x.item}`).localeCompare(sha(`R2:${y.item}`))).slice(0, 3).map(i => ({ ...i, purpose: "second" as const })));
  for (const u of UNITS) second.push(...list.filter(i => i.kind === "P" && i.unit === u && a.verdicts.has(i.item)).sort((x, y) => sha(`R2:${x.item}`).localeCompare(sha(`R2:${y.item}`))).slice(0, 2).map(i => ({ ...i, purpose: "second" as const })));
  const plan = planRoundTwo(resolve, deferred, second);
  await writePackets(2, plan.bins, { unassessed: plan.unassessed.map(i => i.item), trimmedSecond: plan.trimmedSecond.map(i => i.item) });
}

// ---- Experiment 2 analyses -----------------------------------------------------------------------------------------------------------------
export function e2b(): any {
  const est = json(join(BI, "exp2/estimate.json"));
  if (!est.prerequisiteMet) return { run: false, reason: est.reason };
  const rows = SELECT_JOBS.map(j => { const f = instrumentFile("select", j.key); const r = existsSync(f) ? json(f) : undefined; return { key: j.key, unit: j.unit, order: j.order, rep: j.rep, valid: r?.valid ?? false, chosen: r?.chosen, delivered: r?.delivered }; });
  const pools = Object.fromEntries(UNITS.map(u => {
    const ev = est.pools[u].EvsS, mine = rows.filter(r => r.unit === u), chosenE = mine.filter(r => r.chosen === "E").length, validN = mine.filter(r => r.valid).length;
    const recovered = ev === "better" ? chosenE : 0, harm = ev === "worse" ? chosenE : 0;
    const orders = [1, 2].map(o => mine.filter(r => r.order === o).map(r => r.chosen));
    return [u, { eligible: ev === "better", EvsS: ev, valid: validN, chosenE, chosenS: mine.filter(r => r.chosen === "S").length, recovered, harm, regretRuns: ev === "better" ? mine.filter(r => r.chosen === "S").length : 0, orderConsistent: orders[0]!.every(c => c === orders[0]![0]) && orders[1]!.every(c => c === orders[1]![0]) && orders[0]![0] === orders[1]![0], positionPreference: { candidate1: mine.filter(r => r.chosen === (r.order === 1 ? "S" : "E")).length, candidate2: mine.filter(r => r.chosen === (r.order === 1 ? "E" : "S")).length }, decision: harm >= 1 ? "unsafe" : ev === "better" && recovered >= 3 ? "candidate for an adoption test on new tasks" : ev === "better" ? "not recovered" : "no attainable improvement in this pool", deliveredHashesVerified: mine.every(r => !r.valid || r.delivered?.matches === true) }];
  }));
  return { run: true, at: new Date().toISOString(), note: "selector run on every pool once any pool qualified (declared harm-measurement extension, protocol §10); improvement was expected only in eligible pools", eligiblePools: est.betterPools ?? [], rows, pools };
}
/** E2-0: ultra-ab main C-condition selection records `runs/<task>/C/r<k>/select/meta.json` (descriptive; user-stopped study; hidden-test
 *  grades of candidate patches, a different selector model and task type than this study). */
export function e20(): any {
  const root = join(REPO, "results/ultra-ab/main/runs"), rows: any[] = [];
  for (const task of existsSync(root) ? readdirSync(root).sort() : []) {
    const c = join(root, task, "C");
    for (const rep of existsSync(c) ? readdirSync(c).sort() : []) {
      const f = join(c, rep, "select", "meta.json");
      if (!existsSync(f)) continue;
      const m = json(f), graded = Array.isArray(m.attempts) ? m.attempts.filter((a: any) => a && typeof a === "object") : [];
      rows.push({ record: f.slice(REPO.length + 1), task: m.task ?? task, repeat: m.repeat ?? rep, status: m.status, selectorRoutes: Object.keys(m.wire?.byRoute ?? {}), choice: m.selection?.choice, source: m.selection?.source, candidates: m.selection?.candidates?.length ?? 0, candidatePass: graded.map((a: any) => a.primaryPass), primaryPass: m.primaryPass, oraclePass: m.oraclePass });
    }
  }
  const done = rows.filter(r => r.oraclePass !== undefined), passes = (r: any) => r.candidatePass.filter((p: any) => p === true).length;
  const mixed = done.filter(r => passes(r) > 0 && passes(r) < r.candidatePass.length), label = (r: any) => `${r.task} r${r.repeat}`;
  return { at: new Date().toISOString(), source: "results/ultra-ab/main/runs/*/C/*/select/meta.json", note: "descriptive only: the study was stopped by the user (STOPPED.md; summary not updated), completed cases dominate, grades are hidden-test passes of code patches chosen by another model; not used for any decision of this study", rows, counts: { records: rows.length, graded: done.length, notGraded: rows.filter(r => r.oraclePass === undefined).map(r => `${label(r)} (${r.status})`), allCandidatesPass: done.filter(r => r.candidatePass.length > 0 && passes(r) === r.candidatePass.length).length, noCandidatePasses: done.filter(r => passes(r) === 0).map(label), mixedPools: mixed.map(r => ({ record: label(r), passing: `${passes(r)}/${r.candidatePass.length}`, chosePassing: r.primaryPass === true })), chosePassingInMixed: mixed.filter(r => r.primaryPass === true).length } };
}

// ---- identity, accounting, preservation (protocol §12) ---------------------------------------------------------------------------------
export function identityAudit(): any {
  const roles: Record<string, string[]> = { measured: resultsUnder(join(BI, "exp1/runs")), instrument: ["neutral", "rubric", "pairwise"].flatMap(k => resultsUnder(join(BI, "instrument-runs", k))), selector: resultsUnder(join(BI, "instrument-runs", "select")), preflight: resultsUnder(join(BI, "preflight")) };
  const out: Record<string, any> = {};
  for (const [role, files] of Object.entries(roles)) {
    const count = (acc: Record<string, number>, k: string, n = 1) => { acc[k] = (acc[k] ?? 0) + n; };
    const routes: Record<string, number> = {}, thinking: Record<string, number> = {}, models: Record<string, number> = {}, off: any[] = [];
    let aliasUsed = 0;
    for (const f of files) {
      const r = json(f), levels: string[] = r.identity?.thinking ?? [];
      count(models, String(r.model)); if (r.identity?.aliasUsed) aliasUsed++;
      for (const [k, v] of Object.entries<number>(r.wire?.routes ?? {})) count(routes, k, v);
      for (const t of levels) count(thinking, t);
      const bad = [...Object.keys(r.wire?.routes ?? {}).filter(k => !k.endsWith("@max")).map(k => `route ${k}`), ...Object.keys(r.wire?.updateEfforts ?? {}).filter(k => k !== "max").map(k => `update ${k}`), ...levels.filter(t => t !== "max").map(t => `thinking ${t}`), ...(levels.length ? [] : ["no thinking level"]), ...(r.thinking !== "max" ? [`assigned ${r.thinking}`] : [])];
      if (bad.length && (r.wire?.requests ?? 0) > 0) off.push({ record: f.slice(REPO.length + 1, -"/result.json".length), problems: bad });
    }
    out[role] = { turns: files.length, ok: files.filter(f => json(f).ok).length, models, routes, transcriptThinking: thinking, aliasUsedTurns: aliasUsed, offMax: off };
  }
  out.interrupted = ["exp1/runs", "instrument-runs", "preflight"].flatMap(d => interruptedUnder(join(BI, d)));
  return out;
}
function sessionUsage(files: string[]): any {
  let usd = 0, input = 0, output = 0, messages = 0, withoutUsage = 0, first = Infinity, last = 0; const models: Record<string, number> = {};
  for (const f of files) for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue; let o: any; try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp ?? ""); if (Number.isFinite(t)) { first = Math.min(first, t); last = Math.max(last, t); }
    const m = o?.message; if (m?.role !== "assistant") continue; messages++;
    if (!m.usage) { withoutUsage++; continue; }
    usd += m.usage.cost?.total ?? 0; input += m.usage.input ?? 0; output += m.usage.output ?? 0;
    models[`${m.provider ?? "?"}/${m.model ?? "?"}`] = (models[`${m.provider ?? "?"}/${m.model ?? "?"}`] ?? 0) + 1;
  }
  return { files: files.map(f => basename(f)), assistantMessages: messages, messagesWithoutUsage: withoutUsage, catalogueUSD: Math.round(usd * 1e4) / 1e4, input, output, models, wallSeconds: Number.isFinite(first) ? Math.round((last - first) / 1000) : 0 };
}
export function accounting(host: string[], experimenter: string[]): any {
  const runs = resultsUnder(join(BI, "exp1/runs")), stage = (f: string) => /\/(compose|audit|recheck)\/turn-(\d+)\//.exec(f)?.[1] ?? "?";
  const byArm = Object.fromEntries(ARMS_BI.map(arm => [arm, sumTurns(runs.filter(f => new RegExp(`/${arm}-r\\d/`).test(f)))]));
  const kinds = Object.fromEntries(["neutral", "rubric", "pairwise", "select"].map(k => [k, sumTurns(resultsUnder(join(BI, "instrument-runs", k)))]));
  const exp1Instr = Object.fromEntries(["neutral", "rubric", "pairwise"].map(k => [k, sumTurns(resultsUnder(join(BI, "instrument-runs", k)).filter(f => /exp1_|AR\.|RP[AR]\.|\/S\./.test(f)))]));
  const poolInstr = Object.fromEntries(["neutral", "rubric", "pairwise"].map(k => [k, sumTurns(resultsUnder(join(BI, "instrument-runs", k)).filter(f => /pool_|\/SE\./.test(f)))]));
  const measured = sumTurns(runs), preflight = sumTurns(resultsUnder(join(BI, "preflight")));
  const all = [measured, preflight, ...Object.values(kinds)];
  return { at: new Date().toISOString(), pricing: "frozen pinned catalogue list prices (results/delivery-validation/pins); alias routes are not tariff identity; provider invoices unavailable", measured, byArm, byStage: Object.fromEntries(["compose", "audit", "recheck"].map(s => [s, sumTurns(runs.filter(f => stage(f) === s))])), preflight, instruments: kinds, exp1Instruments: exp1Instr, poolInstruments: poolInstr,
    hostRounds: host.length ? sessionUsage(host) : { note: "no host-round session files given" }, experimenter: experimenter.length ? { ...sessionUsage(experimenter), note: "descriptive lower bound: the orchestrating session including work before this study" } : undefined,
    knownSandboxUSD: Math.round(all.reduce((n, x) => n + x.wireUSD, 0) * 1e4) / 1e4, unknown: { requestsWithoutUsage: all.reduce((n, x) => n + x.unknownUsageRequests, 0), unpricedRequests: all.reduce((n, x) => n + x.unpricedRequests, 0), note: "unknown usage and unknown price are reported apart, never as zero" }, interrupted: ["exp1/runs", "instrument-runs", "preflight"].flatMap(d => interruptedUnder(join(BI, d))) };
}
export function preservation(): any {
  const before = json(join(BI, "baseline/preservation-before.json"));
  const tree = (p: string) => { const out: Record<string, string> = {}; const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const f = join(d, n), st = lstatSync(f, { throwIfNoEntry: false } as any); if (!st || st.isSymbolicLink()) continue; if (st.isDirectory()) walk(f); else out[f.slice(join(REPO, p).length + 1)] = sha(readFileSync(f)); } }; if (existsSync(join(REPO, p))) walk(join(REPO, p)); return out; };
  const trees = Object.fromEntries(Object.entries<any>(before.trees).map(([p, v]) => { const now = tree(p), b = v.hashes as Record<string, string>; return [p, { changed: Object.keys(b).filter(k => k in now && now[k] !== b[k]), removed: Object.keys(b).filter(k => !(k in now)), added: Object.keys(now).filter(k => !(k in b)) }]; }));
  const dirtyNow = execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO }).toString(), lines = (s: string) => new Set(s.split("\n").filter(Boolean));
  const dirtyPaths = Object.fromEntries(Object.entries<any>(before.dirtyPaths).filter(([, v]) => typeof v === "string").map(([p, h]) => [p, existsSync(join(REPO, p)) ? (sha(readFileSync(join(REPO, p))) === h ? "unchanged" : "changed") : "removed"]));
  const targetsBefore = json(join(BI, "target-hashes-before.json")), targetsNow = targetHashes();
  return { at: new Date().toISOString(), trees, head: { before: before.head, now: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim() }, gitStatus: { added: [...lines(dirtyNow)].filter(l => !lines(before.gitStatus).has(l)), removed: [...lines(before.gitStatus)].filter(l => !lines(dirtyNow).has(l)) }, dirtyPaths, targets: { unchanged: ["devCommitTree", "isortSnapshot", "isortFixture", "retry1Inputs", "retry1References"].every(k => JSON.stringify(targetsBefore[k]) === JSON.stringify((targetsNow as any)[k])) }, liveConfigUnchanged: sha(readFileSync(join(AGENT, "orche.config.json"))) === before.liveConfigSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "provisional") { const p = await provisional(); console.log(JSON.stringify({ round1: p.round1, comparisons: p.comparisons.map((c: any) => `${c.id}:${c.class}`) }, null, 1)); }
  else if (cmd === "packets") await packets(Number(args[0]));
  else if (cmd === "check-verdicts") { const dir = args[0]!, meta = json(join(dir, "items.json")), r = checkVerdicts(meta.items, json(args[1]!), packetBodies(dir), packetLedgerIds(dir)); console.log(JSON.stringify({ valid: r.valid.size, items: meta.items.length, errors: r.errors }, null, 1)); }
  else if (cmd === "collect") await collect(Number(args[0]), args.slice(1));
  else if (cmd === "score") { const s = score(); await write(join(BI, "scores.json"), s); console.log(JSON.stringify({ comparisons: s.comparisons.map((c: any) => `${c.id}:${c.class}`), e2a: s.e2a.reason, changed: s.sensitivities.changed }, null, 1)); }
  else if (cmd === "estimate") { const s = score(); if (existsSync(join(BI, "exp2/estimate.json"))) throw new Error("estimate already frozen"); const undetermined = Object.entries<any>(s.e2a.pools).filter(([, p]) => /^(unresolved|incomplete)/.test(p.EvsS)).map(([u]) => u); if (!s.rounds.includes(2) && undetermined.length) throw new Error(`E2-a not determinate after round 1 (${undetermined.join(", ")}): freeze after round 2`); await write(join(BI, "exp2/estimate.json"), { at: new Date().toISOString(), rounds: s.rounds, ...s.e2a }); console.log(JSON.stringify(s.e2a, null, 1)); }
  else if (cmd === "e2b") { const r = e2b(); await write(join(BI, "exp2/selector-analysis.json"), r); console.log(JSON.stringify(r.pools ?? r, null, 1)); }
  else if (cmd === "e20") { const r = e20(); await write(join(BI, "exp2/ultra-ab-reanalysis.json"), r); console.log(JSON.stringify(r.counts, null, 1)); }
  else if (cmd === "identity") { const r = identityAudit(); await write(join(BI, "identity-audit.json"), r); console.log(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]: any) => [k, Array.isArray(v) ? v.length : { turns: v.turns, ok: v.ok, routes: v.routes, offMax: v.offMax?.length }])), null, 1)); }
  else if (cmd === "accounting") { const i = args.indexOf("--"), r = accounting(i < 0 ? args : args.slice(0, i), i < 0 ? [] : args.slice(i + 1)); await write(join(BI, "accounting.json"), r); console.log(JSON.stringify({ measured: r.measured.wireUSD, preflight: r.preflight.wireUSD, instruments: Object.fromEntries(Object.entries<any>(r.instruments).map(([k, v]) => [k, v.wireUSD])), host: r.hostRounds.catalogueUSD, known: r.knownSandboxUSD, unknown: r.unknown }, null, 1)); }
  else if (cmd === "preservation") { const r = preservation(); await write(join(BI, "preservation.json"), r); console.log(JSON.stringify({ trees: Object.fromEntries(Object.entries<any>(r.trees).map(([k, v]) => [k, { changed: v.changed.length, removed: v.removed.length, added: v.added.length }])), head: r.head, gitStatus: r.gitStatus, targets: r.targets, liveConfigUnchanged: r.liveConfigUnchanged }, null, 1)); }
  else throw new Error("provisional | packets <round> | check-verdicts <dir> <file> | collect <round> <files...> | score | estimate | e2b | e20 | identity | accounting <host...> -- <exp...> | preservation");
}
