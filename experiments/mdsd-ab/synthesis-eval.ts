/**
 * Evaluation side of the synthesis-only validation (protocol: results/synthesis-validation/protocol.md): the fixed S reference labels
 * from the earlier evaluator reports, the origin-blind packets for the host's fresh verifiers (round 1: E labels; round 2:
 * adjudication), the scoring, the integrity check of the records and the usage accounting. Nothing here is visible to a measured session.
 *
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts slabels
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts epackets <evalDir>
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts t2packets <evalDir> <keysDir> [splitJSON]
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts t2ingest <evalDir> <keysDir> <group> <verdicts.json>
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts score
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts verify <study>
 *   node --import tsx experiments/mdsd-ab/synthesis-eval.ts accounting <study>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wireStats } from "./matrix.js";
import { REPO, readJsonl, sha, write } from "./run.js";
import { QV, RESULTS, UNITS, checkJudgment, promptHashes, spanFound, treeHashes, unitInput, unitStatements, unitTexts, type Statement } from "./synthesis.js";

export type VerdictClass = "K" | "C" | "V" | "S" | "F" | "U" | "D" | "?";
export const VALID = new Set<VerdictClass>(["K", "C", "V"]);
export function verdictClass(verdict: string): VerdictClass {
  const text = verdict.trim().replace(/^\*+/, "");
  if (/^K/.test(text)) return "K";
  if (/^C\d/.test(text)) return "C";
  const first = text[0];
  return first === "V" || first === "S" || first === "F" || first === "U" || first === "D" ? first : "?";
}
/** Claim numbers of an evaluator's claims field: "X1,X6,X29–X35", "Y15-16", "Y99–Y101,Y104–Y106" (ranges inclusive). */
export function claimNumbers(field: string, side: "X" | "Y"): number[] {
  const out: number[] = [];
  const pattern = new RegExp(`${side}(\\d+)(?:\\s*[–-]\\s*${side}?(\\d+))?`, "g");
  // Text after "except" or inside quotes names exclusions or quoted context, not members.
  const members = field.split(/\bexcept\b/)[0]!.replace(/"[^"]*"/g, " ").replace(/\bin the [XY]\d+ quote\b/g, " ");
  for (const match of members.matchAll(pattern)) {
    const from = Number(match[1]), to = match[2] ? Number(match[2]) : from;
    for (let n = from; n <= Math.max(from, to) && n - from < 500; n++) out.push(n);
  }
  return out;
}
export interface Finding { side: "X" | "Y"; id: string; claims: number[]; verdict: string; cls: VerdictClass }
/** The finding lines of an evaluator report: '<id> | claims | verdict | match | basis', with or without a leading dash. */
export function parseFindings(summary: string): Finding[] {
  const out: Finding[] = [];
  for (const raw of summary.split("\n")) {
    const match = /^\s*[-*]?\s*(?:\*\*)?([XY])-(\d+)\b[^|]*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\||$)/.exec(raw);
    if (!match) continue;
    const side = match[1] as "X" | "Y";
    const claims = claimNumbers(match[3]!, side);
    if (!claims.length) continue;
    out.push({ side, id: `${side}-${match[2]}`, claims, verdict: match[4]!, cls: verdictClass(match[4]!) });
  }
  return out;
}
/** Per claim of one side: the classes of every finding that lists it. */
export function classesBySide(findings: Finding[], side: "X" | "Y"): Map<number, VerdictClass[]> {
  const out = new Map<number, VerdictClass[]>();
  for (const finding of findings.filter(item => item.side === side)) for (const claim of finding.claims) out.set(claim, [...(out.get(claim) ?? []), finding.cls]);
  return out;
}
/** One evaluator's label of a claim: its class when every finding listing it agrees, "mixed:<classes>" otherwise, "unlabelled" when none does. */
export const labelOf = (classes: VerdictClass[] | undefined): string => !classes?.length ? "unlabelled" : new Set(classes).size === 1 ? classes[0]! : `mixed:${[...new Set(classes)].sort().join("")}`;
export const isValid = (label: string) => VALID.has(label as VerdictClass);

const PAIRS: Record<string, { pair: string; evaluators: [string, string] }> = { "isort-r1": { pair: "a", evaluators: ["eval-a1", "eval-a2"] }, "isort-r2": { pair: "b", evaluators: ["eval-b1", "eval-b2"] }, "dev-r1": { pair: "c", evaluators: ["eval-c1", "eval-c2"] } };
/** The fixed S reference: each S claim's label from both earlier evaluators, read from their reports through the packet key. */
export function sLabels(unit: string): { claims: Record<string, { a: string; b: string; primary: string }>; counts: Record<string, number>; side: "X" | "Y"; evaluators: string[] } {
  const key = JSON.parse(readFileSync(join(QV, "eval/keys", `${unit}.json`), "utf8"));
  const side: "X" | "Y" = key.X === "S" ? "X" : "Y";
  const config = PAIRS[unit]!;
  const [a, b] = config.evaluators.map(name => classesBySide(parseFindings(JSON.parse(readFileSync(join(QV, "eval/evaluators", `${name}.json`), "utf8")).report.summary), side));
  const xs = JSON.parse(readFileSync(join(QV, unit, "X-S/claims.json"), "utf8")).claims as { id: string }[];
  const claims: Record<string, { a: string; b: string; primary: string }> = {};
  const counts: Record<string, number> = {};
  for (const claim of xs) {
    const n = Number(claim.id.slice(1));
    const la = labelOf(a!.get(n)), lb = labelOf(b!.get(n));
    // primary: valid when both say valid; F/S/U/D when both say the same; otherwise disputed (sensitivities use either reading)
    const primary = isValid(la) && isValid(lb) ? "valid" : la === lb && !la.startsWith("mixed") && la !== "unlabelled" ? la : isValid(la) || isValid(lb) ? "valid-either" : (la === "F" || lb === "F") ? "F-either" : "disputed";
    claims[`S:${claim.id}`] = { a: la, b: lb, primary };
    counts[primary] = (counts[primary] ?? 0) + 1;
  }
  return { claims, counts, side, evaluators: config.evaluators };
}

/** Round-1 packets: each unit's E answer (full document and claim list, origin-blind as "the answer"), with the case's rubric and ground truth paths. */
async function ePackets(evalDir: string): Promise<void> {
  for (const unit of UNITS) {
    const dir = join(evalDir, unit);
    await mkdir(dir, { recursive: true });
    const xe = JSON.parse(readFileSync(join(QV, unit, "X-E/claims.json"), "utf8"));
    const lines = (xe.claims as any[]).map(claim => `- Q${claim.id.slice(1)} [${claim.stance}] ${claim.claim}${claim.locations?.length ? ` | locations: ${claim.locations.join("; ")}` : ""}\n  quote: "${claim.quote}"`);
    await writeFile(join(dir, "claims.md"), [`# Claims of the answer (${xe.claims.length})`, "", "Each claim was extracted from the answer by an extractor; the quote is verbatim from the answer (answer.md).", "", ...lines, ""].join("\n"));
    await copyFile(join(QV, unit, "X-E/answer.md"), join(dir, "answer.md"));
    await copyFile(join(QV, "eval/inputs", unit.startsWith("dev") ? "task-dev.md" : "task-isort.md"), join(dir, "task.md"));
    await write(join(dir, "packet.json"), { unit, claims: xe.claims.length, claimsSha256: sha(readFileSync(join(dir, "claims.md"))), answerSha256: sha(readFileSync(join(dir, "answer.md"))) });
    console.log(`${unit}: ${xe.claims.length} E claims → ${dir}`);
  }
}

// ---- E labels (round 1) -------------------------------------------------------------------------------------------------------------
/** One labeller's verdict class for an E claim ("K-I1", "C3", "V", "S, dup of Q42" …) and its duplicate link. */
export function eVerdict(entry: any): { cls: VerdictClass; dup?: string } {
  const verdict = String(entry?.verdict ?? "");
  const dup = typeof entry?.duplicateOf === "string" && /^Q\d+$/.test(entry.duplicateOf) ? `E:c${entry.duplicateOf.slice(1)}` : /dup(?:licate)? of (Q\d+)/i.exec(verdict)?.[1] ? `E:c${/dup(?:licate)? of Q(\d+)/i.exec(verdict)![1]}` : undefined;
  return { cls: verdictClass(verdict.split(/[\s,(]/)[0] ?? ""), ...(dup ? { dup } : {}) };
}
/** Two labels → the protocol's primary class: valid/F/S/U when both agree on it, valid-either / F-either when one says so, disputed otherwise. */
export function primaryOf(a: string, b: string): string {
  if (isValid(a) && isValid(b)) return "valid";
  if (a === b && a !== "?" && a !== "unlabelled" && !a.startsWith("mixed")) return a;
  if (isValid(a) || isValid(b)) return "valid-either";
  if (a === "F" || b === "F") return "F-either";
  if (a === "S" || b === "S") return "S-either";
  return "disputed";
}
export function eLabels(unit: string): Record<string, { a: string; b: string; primary: string; dups: string[] }> {
  const read = (which: string) => new Map<string, any>((JSON.parse(readFileSync(join(RESULTS, unit, "labels", `e-labels-${which}.json`), "utf8")).labels as any[]).map(entry => [`E:c${String(entry.id).slice(1)}`, entry]));
  const a = read("a"), b = read("b");
  const out: Record<string, { a: string; b: string; primary: string; dups: string[] }> = {};
  for (const origin of new Set([...a.keys(), ...b.keys()])) {
    const la = eVerdict(a.get(origin)), lb = eVerdict(b.get(origin));
    out[origin] = { a: la.cls, b: lb.cls, primary: primaryOf(la.cls, lb.cls), dups: [la.dup, lb.dup].filter((dup): dup is string => !!dup) };
  }
  return out;
}

// ---- scoring ----------------------------------------------------------------------------------------------------------------------
export type Realization = "complete" | "partial" | "missing" | "opposed";
const RANK: Record<string, number> = { complete: 3, partial: 2, missing: 1, opposed: 0 };
export interface JudgeEntry { id: string; realization: Realization; textStance?: string; lines?: number[]; quote?: string; note?: string }
export interface Combined { realization: Realization | "unjudged"; stance: string; source: "agree" | "tier2" | "lower" | "single" | "none"; disagreement: boolean; higher?: Realization; lines: number[] }
/** The protocol's combination: Tier 2 overrides; agreeing judges stand; otherwise the lower realization (the higher one is the sensitivity). */
export function combine(entries: (JudgeEntry | undefined)[], tier2?: { verdict: string; stance?: string }): Combined {
  const present = entries.filter((entry): entry is JudgeEntry => !!entry && entry.realization in RANK);
  const lines = [...new Set(present.flatMap(entry => Array.isArray(entry.lines) ? entry.lines.filter(line => typeof line === "number") : []))];
  const disagreement = present.length === 2 && present[0]!.realization !== present[1]!.realization;
  const stances = [...new Set(present.map(entry => entry.textStance ?? "none"))];
  if (tier2 && tier2.verdict in RANK) return { realization: tier2.verdict as Realization, stance: tier2.stance ?? (stances.length === 1 ? stances[0]! : "mixed"), source: "tier2", disagreement, lines };
  if (!present.length) return { realization: "unjudged", stance: "none", source: "none", disagreement: false, lines };
  if (present.length === 1) return { realization: present[0]!.realization, stance: present[0]!.textStance ?? "none", source: "single", disagreement: false, lines };
  const sorted = [...present].sort((x, y) => RANK[x.realization]! - RANK[y.realization]!);
  return { realization: sorted[0]!.realization, stance: stances.length === 1 ? stances[0]! : "mixed", source: disagreement ? "lower" : "agree", disagreement, ...(disagreement ? { higher: sorted[1]!.realization } : {}), lines };
}
/** Line numbers (1-based) inside fenced ```json blocks: realization there is metadata-only (a sensitivity). */
export function jsonFenceLines(text: string): Set<number> {
  const out = new Set<number>();
  let inJson = false, inFence = false;
  text.split("\n").forEach((line, index) => {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) { if (inFence) { inFence = false; inJson = false; } else { inFence = true; inJson = fence[1] === "json"; } return; }
    if (inJson) out.add(index + 1);
  });
  return out;
}
export const realized = (value: string) => value === "complete" || value === "partial";

/** How a text stands toward a statement as worded: asserted, hedged (presented as uncertain) or not (absent, corrected or rejected). */
export type Rel = "asserted" | "hedged" | "not";
const REL_RANK: Record<Rel, number> = { not: 0, hedged: 1, asserted: 2 };
/**
 * One judge's entry read relative to the statement as worded (protocol, Tier 2 item 3: "realized as asserted, hedged, or
 * corrected/rejected"; Valid additions: "a stance other than rejected"; False baseline handling: "corrected (opposed, or rejected
 * stance)"). A realized statement the text presents as uncertain is hedged. One the text says is false or not a defect is not asserted,
 * except when the statement itself is such a rejection ("X is not a defect", stance rejected): a text that also says X is not a defect
 * expresses and asserts it (the judge prompt's own example), whether the judge recorded that as textStance "rejected" or "asserted".
 * `absolute` is the reading as first coded (textStance taken literally), kept as a disclosed sensitivity: it never counts a realized
 * rejection statement whose text stance reads "rejected" as invalid content, as an addition or as a repeated false claim.
 */
export function relativeStance(realization: string | undefined, textStance: string | undefined, sourceStance: string | undefined, absolute = false): Rel {
  if (!realization || !realized(realization)) return "not";
  if (textStance === "uncertain") return "hedged";
  if (textStance === "rejected") return !absolute && sourceStance === "rejected" ? "asserted" : "not";
  return "asserted";
}
/** Two judges' relative stances, combined like realizations (protocol): agreement stands; otherwise the lower counts, the higher is the sensitivity. */
export function combineStance(values: Rel[], mode: "lower" | "higher" = "lower"): { value: Rel; disagreement: boolean } {
  if (!values.length) return { value: "not", disagreement: false };
  const sorted = [...values].sort((a, b) => REL_RANK[a] - REL_RANK[b]);
  return { value: mode === "lower" ? sorted[0]! : sorted.at(-1)!, disagreement: new Set(values).size > 1 };
}

export interface UnitContext { unit: string; statements: Statement[]; key: Record<string, string>; byOrigin: Map<string, string>; s: Record<string, { a: string; b: string; primary: string }>; e: Record<string, { a: string; b: string; primary: string; dups: string[] }>; sourceStance: Map<string, string>; inS: Set<string>; inSEither: Set<string>; notInS: Set<string>; map: Record<string, string> }
export type Judgments = Partial<Record<"claude" | "gpt", { byId: Map<string, JudgeEntry>; other: any[]; contradictions: any[]; valid: boolean }>>;
export function readJudgments(unit: string, label: string): Judgments {
  const out: Judgments = {};
  for (const model of ["claude", "gpt"] as const) {
    const file = join(RESULTS, unit, "judgments", `${label}.${model}.json`);
    if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, "utf8"));
    const statements: any[] = Array.isArray(record.judgment?.statements) ? record.judgment.statements : [];
    out[model] = { byId: new Map(statements.filter(entry => typeof entry?.id === "string").map(entry => [entry.id, entry])), other: Array.isArray(record.judgment?.other) ? record.judgment.other : [], contradictions: Array.isArray(record.judgment?.contradictions) ? record.judgment.contradictions : [], valid: !!record.valid };
  }
  return out;
}
export function unitContext(unit: string): UnitContext {
  const { statements, key } = unitStatements(unit);
  const s = JSON.parse(readFileSync(join(RESULTS, unit, "labels", "s-labels.json"), "utf8")).claims;
  const e = eLabels(unit);
  const byOrigin = new Map(Object.entries(key).map(([q, origin]) => [origin, q]));
  const sourceStance = new Map(statements.map(item => [item.id, item.stance]));
  const hist = readJudgments(unit, "hist-S");
  const inS = new Set<string>(), inSEither = new Set<string>(), notInS = new Set<string>();
  for (const item of statements) {
    if (!item.origin.startsWith("E:")) continue;
    const values = (["claude", "gpt"] as const).map(model => hist[model]?.byId.get(item.id)?.realization).filter(Boolean);
    if (values.length && values.every(value => value === "complete")) inS.add(item.id);
    if (values.some(value => value === "complete")) inSEither.add(item.id);
    // Post-hoc stricter reading (not preregistered): content no judge finds in S at all, not even partially.
    if (values.length && values.every(value => value === "missing" || value === "opposed")) notInS.add(item.id);
  }
  const map = JSON.parse(readFileSync(join(QV, unit, "seed.json"), "utf8")).map as Record<string, string>;
  return { unit, statements, key, byOrigin, s, e, sourceStance, inS, inSEither, notInS, map };
}
/** The label class of a statement (S's fixed reference or E's round-1 labels), without its origin. */
export const labelOfStatement = (ctx: UnitContext, q: string): string => { const origin = ctx.key[q]!; return origin.startsWith("S:") ? ctx.s[origin]?.primary ?? "unlabelled" : ctx.e[origin]?.primary ?? "unlabelled"; };

export interface Tier2Entry { verdict: string; stance?: string; quote?: string; note?: string; sameAs?: string }
export type Tier2 = Map<string, Tier2Entry>;
/**
 * The adjudicated O (other claim) or X (contradiction) verdicts of one text, one per distinct claim: the two judges can list the same
 * claim, and the verifier links such an item to its twin with `sameAs`. Linked items count once (the verdict of the item without a
 * link, else of the first id); `conflicts` counts linked groups whose verdicts differ.
 */
export function canonicalVerdicts(tier2: Tier2, prefix: "O" | "X", label: string): { verdicts: string[]; merged: number; conflicts: number } {
  const entries = [...tier2.entries()].filter(([id]) => id.startsWith(`${prefix}:${label}:`)).sort((a, b) => a[0].localeCompare(b[0]));
  const ids = new Set(entries.map(([id]) => id));
  const parent = new Map(entries.map(([id]) => [id, id]));
  const find = (id: string): string => { let root = id; while (parent.get(root) !== root) root = parent.get(root)!; return root; };
  for (const [id, value] of entries) if (value.sameAs && value.sameAs !== id && ids.has(value.sameAs)) { const a = find(id), b = find(value.sameAs); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
  const groups = new Map<string, [string, Tier2Entry][]>();
  for (const entry of entries) { const root = find(entry[0]); groups.set(root, [...(groups.get(root) ?? []), entry]); }
  const verdicts = [...groups.values()].map(members => (members.find(([, value]) => !value.sameAs || !ids.has(value.sameAs)) ?? members[0]!)[1].verdict);
  return { verdicts, merged: entries.length - groups.size, conflicts: [...groups.values()].filter(members => new Set(members.map(([, value]) => value.verdict)).size > 1).length };
}

export interface MetricsOptions { tier2?: Tier2; kept?: Set<string>; judgments?: Judgments; baseline?: Set<string> }
type StanceMode = "lower" | "higher" | "absolute";
/**
 * Metrics of one text (protocol "Metrics per text"). `tier2` holds adjudicated verdicts by item id (R:/I:/O:/X:/D: + text label);
 * `baseline` is the set of statements hist-S itself asserts as invalid content (for the descriptive inherited/new breakdown).
 */
export function textMetrics(ctx: UnitContext, label: string, text: string, options: MetricsOptions = {}): any {
  const tier2 = options.tier2 ?? new Map(), kept = options.kept, judgments = options.judgments ?? readJudgments(ctx.unit, label);
  const fence = jsonFenceLines(text);
  const entriesOf = (q: string) => [judgments.claude?.byId.get(q), judgments.gpt?.byId.get(q)];
  const per = new Map<string, Combined>();
  for (const item of ctx.statements) per.set(item.id, combine(entriesOf(item.id), tier2.get(`R:${label}:${item.id}`)));
  const count = (pred: (q: string, c: Combined) => boolean) => [...per.entries()].filter(([q, c]) => pred(q, c)).length;
  const sClass = (q: string) => ctx.key[q]!.startsWith("S:") ? ctx.s[ctx.key[q]!]?.primary : undefined;
  const eClass = (q: string) => ctx.key[q]!.startsWith("E:") ? ctx.e[ctx.key[q]!]?.primary : undefined;
  const metaOnly = (c: Combined) => realized(c.realization) && c.lines.length > 0 && c.lines.every(line => fence.has(line));
  const lossOf = (pred: (q: string) => boolean, higher = false) => { const out = { partial: 0, missing: 0, opposed: 0, unjudged: 0 }; for (const [q, c] of per) { if (!pred(q)) continue; const value = higher && c.higher ? c.higher : c.realization; if (value !== "complete") out[value as keyof typeof out]++; } return { ...out, L: out.partial + out.missing + out.opposed + out.unjudged }; };
  const sValid = (q: string) => sClass(q) === "valid";
  const loss = lossOf(sValid);
  // The text's stance toward each statement as worded, per judge, combined with the protocol's lower rule (higher = sensitivity).
  const stanceOf = (q: string, mode: StanceMode = "lower") => combineStance(entriesOf(q).filter((entry): entry is JudgeEntry => !!entry && entry.realization in RANK).map(entry => relativeStance(entry.realization, entry.textStance, ctx.sourceStance.get(q), mode === "absolute")), mode === "higher" ? "higher" : "lower");
  const invalidStance = (q: string, mode: StanceMode = "lower"): Rel => { const t2 = tier2.get(`I:${label}:${q}`); if (t2) return t2.verdict === "asserted" ? "asserted" : t2.verdict === "hedged" ? "hedged" : "not"; return stanceOf(q, mode).value; };
  const invalidKind = (q: string, rule: "primary" | "either") => { const cls = sClass(q) ?? eClass(q) ?? ""; return rule === "primary" ? (cls === "F" || cls === "S" ? cls : undefined) : cls === "F" || cls === "F-either" ? "F" : cls === "S" || cls === "S-either" ? "S" : undefined; };
  const invalidOf = (mode: StanceMode, rule: "primary" | "either" = "primary") => {
    const out = { F: 0, S: 0, hedgedF: 0, hedgedS: 0, U: 0, asserted: [] as string[] };
    for (const item of ctx.statements) {
      const q = item.id, kind = invalidKind(q, rule), how = invalidStance(q, mode);
      if (kind && how === "asserted") { out[kind]++; out.asserted.push(q); }
      if (kind && how === "hedged") out[kind === "F" ? "hedgedF" : "hedgedS"]++;
      if (rule === "primary" && (sClass(q) ?? eClass(q)) === "U" && how !== "not") out.U++;
    }
    return out;
  };
  const primary = invalidOf("lower"), higher = invalidOf("higher"), absolute = invalidOf("absolute"), either = invalidOf("lower", "either");
  // Other claims and contradictions (judge-listed, Tier-2 adjudicated; twins linked by the verifier count once).
  const others = canonicalVerdicts(tier2, "O", label), contradictionsOf = canonicalVerdicts(tier2, "X", label);
  const otherCounts = others.verdicts.reduce((acc: Record<string, number>, verdict) => { acc[verdict] = (acc[verdict] ?? 0) + 1; return acc; }, {});
  const otherInvalid = (otherCounts.F ?? 0) + (otherCounts.S ?? 0);
  const addition = (q: string, rule: "primary" | "either", mode: StanceMode = "lower") => { const cls = eClass(q); const okCls = rule === "primary" ? cls === "valid" : cls === "valid" || cls === "valid-either"; const fresh = rule === "primary" ? !ctx.inS.has(q) : !ctx.inSEither.has(q); return okCls && fresh && stanceOf(q, mode).value !== "not"; };
  // Stance disagreements that Tier 2 did not settle and that change a count (both readings are reported).
  const stanceOpen = {
    invalid: ctx.statements.map(item => item.id).filter(q => invalidKind(q, "primary") && !tier2.has(`I:${label}:${q}`) && invalidStance(q, "lower") !== invalidStance(q, "higher")),
    additions: ctx.statements.map(item => item.id).filter(q => addition(q, "primary", "lower") !== addition(q, "primary", "higher")),
  };
  const falseBaseline = ctx.statements.filter(item => sClass(item.id) === "F").map(item => {
    const q = item.id, c = per.get(q)!, t2 = tier2.get(`I:${label}:${q}`);
    const handling = t2 ? (t2.verdict === "asserted" || t2.verdict === "hedged" ? "repeated" : t2.verdict === "rejected" ? "corrected" : "silently removed")
      : c.realization === "opposed" ? "corrected" : c.realization === "missing" ? "silently removed" : !realized(c.realization) ? c.realization : stanceOf(q).value === "not" ? "corrected" : "repeated";
    return { q, handling, by: t2 ? "tier2" : "judges" };
  });
  const drift = { upgrade: 0, downgrade: 0 };
  for (const [q, c] of per) { if (!sValid(q) || !realized(c.realization)) continue; const t2 = tier2.get(`D:${label}:${q}`); if (t2 && t2.verdict !== "confirmed") continue; const source = ctx.sourceStance.get(q); const stance = t2?.stance ?? c.stance; if (source === "uncertain" && stance === "asserted") drift.upgrade++; if (source === "asserted" && stance === "uncertain") drift.downgrade++; }
  const keptNotRealized = kept ? [...per.entries()].filter(([q, c]) => sValid(q) && kept.has(ctx.key[q]!) && c.realization !== "complete").length : undefined;
  const keptValid = kept ? [...per.keys()].filter(q => sValid(q) && kept.has(ctx.key[q]!)).length : undefined;
  // Descriptive (not a gate): asserted invalid statements the strong answer itself asserts (inherited) or not (new), and new other claims.
  const inherited = options.baseline ? primary.asserted.filter(q => options.baseline!.has(q)) : undefined;
  const fresh = options.baseline ? primary.asserted.filter(q => !options.baseline!.has(q)) : undefined;
  return {
    label, chars: text.length, judges: Object.fromEntries(Object.entries(judgments).map(([model, value]) => [model, value!.valid])),
    sValid: count(q => sValid(q)), loss, lossHigher: lossOf(sValid, true).L, lossMO: loss.missing + loss.opposed, lossWeighted: loss.missing + loss.opposed + 0.5 * loss.partial, lossEither: lossOf(q => sValid(q) || sClass(q) === "valid-either").L,
    lossMeta: loss.L + count((q, c) => sValid(q) && c.realization === "complete" && metaOnly(c)), metaOnly: count((q, c) => sValid(q) && metaOnly(c)),
    additions: count(q => addition(q, "primary")), additionsEither: count(q => addition(q, "either")), additionsHigher: count(q => addition(q, "primary", "higher")), additionsAbsolute: count(q => addition(q, "primary", "absolute")), newObservations: otherCounts.V ?? 0,
    additionsStrict: count(q => eClass(q) === "valid" && ctx.notInS.has(q) && stanceOf(q).value !== "not"), additionsComplete: count((q, c) => addition(q, "primary") && c.realization === "complete"),
    invalid: { F: primary.F, S: primary.S, hedgedF: primary.hedgedF, hedgedS: primary.hedgedS, U: primary.U, other: { F: otherCounts.F ?? 0, S: otherCounts.S ?? 0, U: otherCounts.U ?? 0 }, total: primary.F + primary.S + otherInvalid },
    invalidEither: { F: either.F, S: either.S, total: either.F + either.S + otherInvalid }, invalidHigher: higher.F + higher.S + otherInvalid, invalidAbsolute: absolute.F + absolute.S + otherInvalid,
    invalidWithHedged: primary.F + primary.S + primary.hedgedF + primary.hedgedS + otherInvalid,
    // Post-hoc (not preregistered): an E statement whose content S already states completely is not counted again as invalid.
    invalidNoDuplicates: primary.asserted.filter(q => !(ctx.key[q]!.startsWith("E:") && ctx.inS.has(q))).length + otherInvalid,
    invalidAsserted: primary.asserted,
    invalidOrigin: inherited && fresh ? { inherited: inherited.length, newStatements: fresh.length, newFromE: fresh.filter(q => ctx.key[q]!.startsWith("E:")).length, newFromS: fresh.filter(q => ctx.key[q]!.startsWith("S:")).length, newOther: otherInvalid } : undefined,
    stanceOpen: { invalid: stanceOpen.invalid.length, additions: stanceOpen.additions.length, ids: stanceOpen },
    otherMerged: others.merged, otherConflicts: others.conflicts, contradictionsMerged: contradictionsOf.merged,
    falseBaseline, drift, contradictions: contradictionsOf.verdicts.filter(verdict => verdict === "confirmed").length, keptValid, keptNotRealized, disagreements: count((q, c) => sValid(q) && c.disagreement), tier2Applied: count((q, c) => c.source === "tier2"),
  };
}
/** The protocol's pair verdict of T against a control on (loss, invalid, additions). */
export function pairVerdict(t: { L: number; I: number; A: number }, c: { L: number; I: number; A: number }): string {
  const dl = Math.sign(c.L - t.L), di = Math.sign(c.I - t.I), da = Math.sign(t.A - c.A);
  if (dl > 0 && di >= 0 && da >= 0) return "improvement";
  if (dl === 0 && di === 0 && da === 0) return "tie";
  if (dl === 0 && di >= 0 && da >= 0) return "secondary gain";
  if (dl <= 0 && di <= 0 && da <= 0) return "regression";
  return "mixed";
}

// ---- Tier 2 (round 2): adjudication packets and verdicts --------------------------------------------------------------------------
/** Tier-2 groups (protocol): the pipeline texts of one repetition; the r1 group also carries hist-S and hist-A. */
export const GROUP_TEXTS = (rep: number) => [...(rep === 1 ? ["hist-S", "hist-A"] : []), `C0-r${rep}`, `C1-r${rep}`, `Tpre-r${rep}`, `T-r${rep}`];
export const textFile = (unit: string, label: string) => label.startsWith("hist-") ? join(QV, unit, `X-${label.slice(5)}`, "answer.md") : join(RESULTS, unit, `${/^C/.test(label) ? "C" : "T"}-r${label.slice(-1)}`, label.replace(/-r\d$/, ""), "final.md");
const textId = (unit: string, label: string) => `t-${sha(`${unit}:${label}:tier2`).slice(0, 6)}`;
const neutral = (label: string) => label === "valid" ? "valid" : label === "valid-either" ? "valid (one evaluator)" : label.startsWith("F") ? "false" : label.startsWith("S") ? "out of scope" : label === "U" ? "undecidable" : label;
/**
 * The items Tier 2 decides for one text, with both judges' entries; ids use the text's label (mapped to random ids in packets).
 * Feasibility reduction (a disclosed deviation from protocol item 3, fixed before any Tier-2 verdict): an out-of-scope statement
 * that both judges find realized with the same stance is not re-checked one by one (the agreed value stands, per the combination
 * rule); a hash-seeded sample of 5 such statements per text is re-checked to estimate the error of that shortcut. False statements,
 * judge disagreements, every alleged loss, the over-credit samples, other claims, contradictions and stance drift are all items.
 * For hist-A (calibration only, never compared) the items are the earlier evaluation's known losses and the over-credit sample.
 */
export function tier2Items(ctx: UnitContext, label: string): any[] {
  if (label === "hist-A") {
    const all = tier2ItemsAll(ctx, label);
    const known = (KNOWN_LOSSES[ctx.unit] ?? []).map(origin => ctx.byOrigin.get(origin)!).filter(Boolean);
    const judgments = readJudgments(ctx.unit, label);
    const show = (q: string) => (["claude", "gpt"] as const).map((model, index) => { const entry = judgments[model]?.byId.get(q); return entry ? { judge: index + 1, realization: entry.realization, stance: entry.textStance, lines: entry.lines, quote: entry.quote, note: entry.note } : { judge: index + 1, missingEntry: true }; });
    return [...known.map(q => ({ id: `R:${label}:${q}`, kind: "realization", statement: q, judges: show(q) })), ...all.filter(item => item.sample && !known.includes(item.statement))];
  }
  const all = tier2ItemsAll(ctx, label);
  const order = (q: string) => sha(`${ctx.unit}:${label}:scope:${q}`);
  const sampled = new Set(all.filter(item => item.reason === "agreed scope").map(item => item.statement as string).sort((a, b) => order(a).localeCompare(order(b))).slice(0, 5));
  return all.filter(item => item.reason !== "agreed scope" || sampled.has(item.statement)).map(item => item.reason === "agreed scope" ? { ...item, sample: true } : item);
}
export function tier2ItemsAll(ctx: UnitContext, label: string): any[] {
  const judgments = readJudgments(ctx.unit, label);
  const both = (q: string) => (["claude", "gpt"] as const).map(model => judgments[model]?.byId.get(q));
  const show = (q: string) => both(q).map((entry, index) => entry ? { judge: index + 1, realization: entry.realization, stance: entry.textStance, lines: entry.lines, quote: entry.quote, note: entry.note } : { judge: index + 1, missingEntry: true });
  const items: any[] = [];
  const completeByBoth: string[] = [];
  for (const item of ctx.statements) {
    const q = item.id, cls = labelOfStatement(ctx, q), entries = both(q).filter(Boolean) as JudgeEntry[];
    const sValidish = ctx.key[q]!.startsWith("S:") && (cls === "valid" || cls === "valid-either");
    if (sValidish) {
      const values = entries.map(entry => entry.realization);
      if (values.length < 2 || new Set(values).size > 1 || values.some(value => value !== "complete")) items.push({ id: `R:${label}:${q}`, kind: "realization", statement: q, judges: show(q) });
      else if (cls === "valid") completeByBoth.push(q);
      const source = ctx.sourceStance.get(q);
      if (entries.some(entry => realized(entry.realization) && ((source === "uncertain" && entry.textStance === "asserted") || (source === "asserted" && entry.textStance === "uncertain")))) items.push({ id: `D:${label}:${q}`, kind: "stance", statement: q, sourceStance: source, judges: show(q) });
    }
    if ((cls.startsWith("F") || cls.startsWith("S")) && entries.some(entry => realized(entry.realization))) {
      const agreed = entries.length === 2 && entries.every(entry => realized(entry.realization)) && entries[0]!.textStance === entries[1]!.textStance;
      items.push({ id: `I:${label}:${q}`, kind: "invalid", statement: q, judges: show(q), ...(cls.startsWith("S") && agreed ? { reason: "agreed scope" } : {}) });
    }
  }
  // The over-credit sample: 5 S-valid statements both judges rate complete, in an order fixed by hash.
  for (const q of completeByBoth.sort((a, b) => sha(`${ctx.unit}:${label}:${a}`).localeCompare(sha(`${ctx.unit}:${label}:${b}`))).slice(0, 5)) items.push({ id: `R:${label}:${q}`, kind: "realization", sample: true, statement: q, judges: show(q) });
  (["claude", "gpt"] as const).forEach((model, index) => {
    (judgments[model]?.other ?? []).forEach((other: any, n: number) => items.push({ id: `O:${label}:${index + 1}.${n + 1}`, kind: "other", claim: other?.claim, lines: other?.lines, quote: other?.quote }));
    (judgments[model]?.contradictions ?? []).forEach((pair: any, n: number) => items.push({ id: `X:${label}:${index + 1}.${n + 1}`, kind: "contradiction", a: pair?.a, b: pair?.b, note: pair?.note }));
  });
  return items;
}
async function t2Packets(evalDir: string, keysDir: string, split: Record<string, number>): Promise<void> {
  await mkdir(keysDir, { recursive: true });
  for (const unit of UNITS) {
    const ctx = unitContext(unit);
    for (const rep of [1, 2]) {
      const labels = GROUP_TEXTS(rep).filter(label => existsSync(textFile(unit, label)));
      const parts = split[`${unit}-r${rep}`] ?? 1;
      for (let part = 0; part < parts; part++) {
        const group = `${unit}-r${rep}${parts > 1 ? `-p${part + 1}` : ""}`;
        const mine = labels.filter((_, index) => index % parts === part);
        const dir = join(evalDir, "t2", group);
        await mkdir(join(dir, "texts"), { recursive: true });
        const key: Record<string, string> = {};
        const allItems: any[] = [];
        for (const label of mine.sort((a, b) => textId(unit, a).localeCompare(textId(unit, b)))) {
          const id = textId(unit, label);
          key[id] = label;
          const text = readFileSync(textFile(unit, label), "utf8");
          await writeFile(join(dir, "texts", `${id}.md`), text.split("\n").map((line, index) => `L${index + 1}: ${line}`).join("\n"));
          // The verifier sees the judges' entries but not why an item was chosen (no sample or shortcut flags).
          for (const { reason: _reason, sample: _sample, ...item } of tier2Items(ctx, label)) allItems.push({ ...item, id: item.id.replace(`:${label}:`, `:${id}:`), text: id });
        }
        const statements = ctx.statements.map(item => `- ${item.id} [${item.stance}] (reference: ${neutral(labelOfStatement(ctx, item.id))}) ${item.statement}${item.locations.length ? ` (locations: ${item.locations.join("; ")})` : ""}`);
        await writeFile(join(dir, "statements.md"), [`# Statements of earlier analyses (${ctx.statements.length})`, "", "Stance: what the earlier analysis did (asserted, uncertain, rejected = said false or not a defect). Reference: the earlier evaluation's validity label of the statement.", "", ...statements, ""].join("\n"));
        await write(join(dir, "items.json"), { group, texts: Object.keys(key), items: allItems });
        await copyFile(join(QV, "eval/inputs", unit.startsWith("dev") ? "task-dev.md" : "task-isort.md"), join(dir, "task.md"));
        await write(join(keysDir, `${group}.json`), { group, key, itemsSha256: sha(readFileSync(join(dir, "items.json"))) });
        const kinds = allItems.reduce((acc: Record<string, number>, item) => { acc[item.kind] = (acc[item.kind] ?? 0) + 1; return acc; }, {});
        console.log(`${group}: ${mine.length} texts, ${allItems.length} items ${JSON.stringify(kinds)}`);
      }
    }
  }
}
/** The values a Tier-2 verdict may take per item kind (packet ids start with the kind letter), and the stances of R and D items. */
export const T2_VERDICTS: Record<string, readonly string[]> = { R: ["complete", "partial", "missing", "opposed"], I: ["asserted", "hedged", "rejected", "absent"], O: ["V", "S", "F", "U", "not new"], X: ["confirmed", "not"], D: ["confirmed", "not"] };
export const T2_STANCES: readonly string[] = ["asserted", "uncertain", "rejected", "none"];
/** Whether a verifier's quote occurs in the text: word-normalized like the judges' quotes; line prefixes dropped; parts joined by an ellipsis checked one by one. */
export function quoteFound(quote: unknown, text: string): boolean {
  if (typeof quote !== "string") return false;
  const parts = quote.replace(/\bL\d+:\s?/g, " ").split(/\.\.\.|…/).map(part => part.trim()).filter(part => part.split(/\s+/).length >= 3);
  return parts.length > 0 && parts.every(part => spanFound(part, text, 3));
}
export interface Tier2Check { items: number; entries: number; accepted: number; missing: string[]; unknown: string[]; duplicates: string[]; invalid: { id: string; problem: string }[]; notes: { id: string; problem: string }[]; quoteMisses: string[] }
/**
 * One group's verdict file checked against its packet: every packet item needs exactly one entry (duplicates with different values are
 * rejected), verdict and stance values per kind, quotes for realized R and non-absent I verdicts, and sameAs links to a twin item of
 * the same kind and text. Rejected or missing entries stay unresolved (reported with both judges' readings), never silently zero.
 */
export function validateTier2(items: any[], entries: any[], texts: Record<string, string>): { accepted: Map<string, Tier2Entry>; check: Tier2Check } {
  const byId = new Map(items.map(item => [String(item.id), item]));
  const seen = new Map<string, any[]>(), unknown: string[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) { const id = String(entry?.id ?? ""); if (!byId.has(id)) { unknown.push(id); continue; } seen.set(id, [...(seen.get(id) ?? []), entry]); }
  const accepted = new Map<string, Tier2Entry>(), invalid: { id: string; problem: string }[] = [], notes: { id: string; problem: string }[] = [], duplicates: string[] = [], quoteMisses: string[] = [];
  // Spelling variants with one meaning are read as the listed value ("not confirmed" as "not") and noted; the raw file stays as submitted.
  const normalize = (kind: string, value: unknown) => { const text = String(value ?? "").trim(); return kind === "O" ? (/^not[ _-]?new$/i.test(text) ? "not new" : text.toUpperCase()) : (kind === "X" || kind === "D") && /^not[ _-]?confirmed$/i.test(text) ? "not" : text.toLowerCase(); };
  for (const [id, list] of seen) {
    const kind = id[0]!, item = byId.get(id);
    if (list.length > 1) { duplicates.push(id); if (new Set(list.map(entry => `${normalize(kind, entry?.verdict)}|${String(entry?.stance ?? "").toLowerCase()}`)).size > 1) { invalid.push({ id, problem: "conflicting duplicate entries" }); continue; } }
    const entry = list[0], verdict = normalize(kind, entry?.verdict);
    if (verdict !== String(entry?.verdict ?? "").trim()) notes.push({ id, problem: `verdict "${String(entry?.verdict)}" read as "${verdict}"` });
    if (!(T2_VERDICTS[kind] ?? []).includes(verdict)) { invalid.push({ id, problem: `verdict "${String(entry?.verdict)}" is not one of ${(T2_VERDICTS[kind] ?? []).join("|")}` }); continue; }
    const stance = entry?.stance === undefined || entry?.stance === null || entry?.stance === "" ? undefined : String(entry.stance).trim().toLowerCase();
    if (stance && (kind === "R" || kind === "D") && !T2_STANCES.includes(stance)) { invalid.push({ id, problem: `stance "${stance}" is not one of ${T2_STANCES.join("|")}` }); continue; }
    let sameAs: string | undefined;
    if ((kind === "O" || kind === "X") && entry?.sameAs) { const target = String(entry.sameAs), twin = byId.get(target); if (twin && target !== id && target[0] === kind && twin.text === item.text) sameAs = target; else notes.push({ id, problem: `sameAs ${target} is not another ${kind} item of the same text: link ignored, verdict kept` }); }
    if (((kind === "R" && realized(verdict)) || (kind === "I" && verdict !== "absent")) && !quoteFound(entry?.quote, texts[item.text] ?? "")) quoteMisses.push(id);
    accepted.set(id, { verdict, ...(stance && (kind === "R" || kind === "D") ? { stance } : {}), ...(entry?.quote ? { quote: String(entry.quote) } : {}), ...(entry?.note ? { note: String(entry.note) } : {}), ...(sameAs ? { sameAs } : {}) });
  }
  const rejected = new Set(invalid.map(problem => problem.id));
  return { accepted, check: { items: byId.size, entries: Array.isArray(entries) ? entries.length : 0, accepted: accepted.size, missing: [...byId.keys()].filter(id => !seen.has(id)), unknown, duplicates, invalid: invalid.filter((problem, index) => invalid.findIndex(other => other.id === problem.id) === index && rejected.has(problem.id)), notes, quoteMisses } };
}
/**
 * Every Tier-2 group of a unit (results/<unit>/tier2: items-, key- and verdicts-<group>.json, byte copies of the packet, its key and
 * the verifier's raw file), validated, with item ids mapped from random text ids back to labels.
 */
export function loadTier2(unit: string): { map: Tier2; checks: (Tier2Check & { group: string; itemsSha256Ok: boolean; verdictsFile: boolean; unmapped: string[] })[]; items: any[] } {
  const map: Tier2 = new Map(), checks: any[] = [], items: any[] = [];
  const dir = join(RESULTS, unit, "tier2");
  if (!existsSync(dir)) return { map, checks, items };
  for (const name of readdirSync(dir).filter(name => /^items-.*\.json$/.test(name)).sort()) {
    const group = name.slice("items-".length, -".json".length);
    const packet = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const keyRecord = JSON.parse(readFileSync(join(dir, `key-${group}.json`), "utf8"));
    const key = keyRecord.key as Record<string, string>;
    const relabel = (id: string) => { const match = /^([RIOXD]):(t-[0-9a-f]+):(.+)$/.exec(id); return match && key[match[2]!] ? `${match[1]}:${key[match[2]!]}:${match[3]}` : undefined; };
    const texts = Object.fromEntries(Object.entries(key).map(([id, label]) => [id, readFileSync(textFile(unit, label), "utf8")]));
    const verdictsFile = join(dir, `verdicts-${group}.json`);
    const raw = existsSync(verdictsFile) ? JSON.parse(readFileSync(verdictsFile, "utf8")) : undefined;
    const { accepted, check } = validateTier2(packet.items, raw?.items ?? [], texts);
    checks.push({ group, ...check, itemsSha256Ok: sha(readFileSync(join(dir, name))) === keyRecord.itemsSha256, verdictsFile: !!raw, unmapped: (packet.items as any[]).filter(item => !relabel(item.id)).map(item => item.id) });
    for (const item of packet.items as any[]) { const id = relabel(item.id); if (id) items.push({ ...item, id, label: key[item.text], group }); }
    for (const [id, entry] of accepted) { const mapped = relabel(id); if (mapped) map.set(mapped, { ...entry, ...(entry.sameAs ? { sameAs: relabel(entry.sameAs) } : {}) }); }
  }
  return { map, checks, items };
}
export const readTier2 = (unit: string): Tier2 => loadTier2(unit).map;
/** Files one group's round-2 result into results/<unit>/tier2 as byte copies (packet items, key, raw verdicts); never replaces a record. */
async function t2Ingest(evalDir: string, keysDir: string, group: string, verdicts: string): Promise<void> {
  const unit = /^(.*)-r\d(?:-p\d+)?$/.exec(group)?.[1];
  if (!unit || !(UNITS as readonly string[]).includes(unit)) throw new Error(`unknown group ${group}`);
  const dir = join(RESULTS, unit, "tier2");
  await mkdir(dir, { recursive: true });
  const copies = [[join(evalDir, "t2", group, "items.json"), `items-${group}.json`], [join(keysDir, `${group}.json`), `key-${group}.json`], [verdicts, `verdicts-${group}.json`]] as const;
  for (const [, to] of copies) if (existsSync(join(dir, to))) throw new Error(`${to} exists: a Tier-2 record is never replaced`);
  for (const [from, to] of copies) await copyFile(from, join(dir, to));
  const check = loadTier2(unit).checks.find(item => item.group === group)!;
  console.log(JSON.stringify({ ...check, missing: check.missing.length, quoteMisses: check.quoteMisses.length, rawSha256: sha(readFileSync(verdicts)) }));
}
/** What an arm's own metadata keeps (C: refs in a finding's provenance; T: realized or duplicate dispositions), as S:/E: origins. */
export function keptOf(ctx: UnitContext, label: string): Set<string> | undefined {
  if (label.startsWith("hist-")) return undefined;
  const dir = join(RESULTS, ctx.unit, `${/^C/.test(label) ? "C" : "T"}-r${label.slice(-1)}`, label.replace(/-r\d$/, ""));
  const safe = (file: string) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; } catch { return undefined; } };
  const ledger = safe(join(dir, "ledger.json")), plan = safe(join(dir, "plan.json"));
  const refs = new Set<string>();
  for (const finding of ledger?.findings ?? []) for (const ref of finding?.provenance ?? []) refs.add(String(ref));
  for (const entry of plan?.entries ?? []) if (["retained", "corrected", "added", "uncertain", "duplicate"].includes(entry?.disposition)) refs.add(String(entry.ref));
  return new Set([...refs].map(ref => ctx.map[ref]).filter((origin): origin is string => !!origin));
}

// ---- the score --------------------------------------------------------------------------------------------------------------------
export const TEXTS = ["hist-S", "hist-E", "hist-A", ...[1, 2].flatMap(rep => [`C0-r${rep}`, `C1-r${rep}`, `Tpre-r${rep}`, `T-r${rep}`])];
/** The earlier evaluation's agreed losses of A, as S claim ids: a calibration of the instrument (it never saw them). */
export const KNOWN_LOSSES: Record<string, string[]> = { "isort-r1": ["S:c91"], "isort-r2": ["S:c41", "S:c42"], "dev-r1": ["S:c102", "S:c103"] };
const frozenOk = (unit: string, label: string) => { if (label.startsWith("hist-")) return true; const file = join(dirname(textFile(unit, label)), "frozen.json"); return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).ok === true; };
export function scoreUnit(unit: string): any {
  const ctx = unitContext(unit), t2 = loadTier2(unit), tier2 = t2.map;
  const read = (label: string) => readFileSync(textFile(unit, label), "utf8");
  // What the strong answer itself asserts as invalid content: the baseline of the descriptive inherited/new breakdown.
  const baseline = new Set<string>(existsSync(textFile(unit, "hist-S")) ? textMetrics(ctx, "hist-S", read("hist-S"), { tier2 }).invalidAsserted : []);
  const texts: Record<string, any> = {};
  for (const label of TEXTS) {
    if (!existsSync(textFile(unit, label))) { texts[label] = { label, incomplete: "no text" }; continue; }
    const judgments = readJudgments(unit, label);
    const metrics = textMetrics(ctx, label, read(label), { tier2, kept: keptOf(ctx, label), judgments, baseline });
    const judgesOk = !!judgments.claude?.valid && !!judgments.gpt?.valid;
    const packetItems = t2.items.filter(item => item.label === label);
    const unresolved = packetItems.filter(item => !tier2.has(item.id)).map(item => ({ id: item.id, kind: item.kind, statement: item.statement, label: item.statement ? labelOfStatement(ctx, item.statement) : undefined, judges: item.judges, claim: item.claim, a: item.a, b: item.b }));
    const byKind = (list: any[]) => list.reduce((acc: Record<string, number>, item) => { acc[item.kind] = (acc[item.kind] ?? 0) + 1; return acc; }, {});
    texts[label] = { ...metrics, frozenOk: frozenOk(unit, label), judgesOk, tier2: { items: packetItems.length, decided: packetItems.length - unresolved.length, itemsByKind: byKind(packetItems), unresolvedByKind: byKind(unresolved), unresolved }, ...(frozenOk(unit, label) && judgesOk ? {} : { incomplete: !frozenOk(unit, label) ? "pipeline stage not ok" : "a judge is missing or invalid" }) };
  }
  // Preservation against the strong answer (protocol: reported per text, not a gate).
  const s = texts["hist-S"];
  for (const label of TEXTS) { const m = texts[label]; if (m.incomplete || !s || s.incomplete) continue; m.vsS = { retention: m.sValid ? Math.round(((m.sValid - m.loss.L) / m.sValid) * 1000) / 1000 : null, dL: m.loss.L - s.loss.L, dI: m.invalid.total - s.invalid.total, dA: m.additions - s.additions }; }
  const VARIANT: Record<string, (m: any) => { L: number; I: number; A: number }> = {
    primary: m => ({ L: m.loss.L, I: m.invalid.total, A: m.additions }),
    "missing+opposed": m => ({ L: m.lossMO, I: m.invalid.total, A: m.additions }),
    "partial 0.5": m => ({ L: m.lossWeighted, I: m.invalid.total, A: m.additions }),
    "S-valid-either": m => ({ L: m.lossEither, I: m.invalid.total, A: m.additions }),
    "metadata-only as missing": m => ({ L: m.lossMeta, I: m.invalid.total, A: m.additions }),
    // The higher of two disagreeing judges, for realization and for stance (protocol: "The higher realization is a sensitivity").
    "higher judge": m => ({ L: m.lossHigher, I: m.invalidHigher, A: m.additionsHigher }),
    "labels either": m => ({ L: m.loss.L, I: m.invalidEither.total, A: m.additionsEither }),
    "hedged invalid counted": m => ({ L: m.loss.L, I: m.invalidWithHedged, A: m.additions }),
    // The stance reading as first coded (textStance literal): a realized rejection statement read "rejected" never counts.
    "absolute text stance (as first coded)": m => ({ L: m.loss.L, I: m.invalidAbsolute, A: m.additionsAbsolute }),
    // Post-hoc (not preregistered) readings, labelled as such wherever they are reported.
    "strict additions (post-hoc)": m => ({ L: m.loss.L, I: m.invalid.total, A: m.additionsStrict }),
    "complete additions (post-hoc)": m => ({ L: m.loss.L, I: m.invalid.total, A: m.additionsComplete }),
    "invalid without E-in-S duplicates (post-hoc)": m => ({ L: m.loss.L, I: m.invalidNoDuplicates, A: m.additions }),
    "F only (post-hoc)": m => ({ L: m.loss.L, I: m.invalid.F + m.invalid.other.F, A: m.additions }),
    "new invalid only, inherited excluded (post-hoc)": m => ({ L: m.loss.L, I: m.invalidOrigin.newStatements + m.invalidOrigin.newOther, A: m.additions }),
  };
  const score = (m: any, variant = "primary") => VARIANT[variant]!(m);
  const VARIANTS = Object.keys(VARIANT);
  const pairs: any[] = [];
  for (const rep of [1, 2]) for (const [t, c] of [[`T-r${rep}`, `C1-r${rep}`], [`T-r${rep}`, `C0-r${rep}`], [`Tpre-r${rep}`, `C0-r${rep}`]] as const) {
    const mt = texts[t], mc = texts[c];
    if (mt.incomplete || mc.incomplete) { pairs.push({ rep, t, c, verdict: "incomplete", reason: mt.incomplete ?? mc.incomplete }); continue; }
    pairs.push({ rep, t, c, T: score(mt), C: score(mc), verdict: pairVerdict(score(mt), score(mc)), sensitivity: Object.fromEntries(VARIANTS.slice(1).map(variant => [variant, pairVerdict(score(mt, variant), score(mc, variant))])), variants: Object.fromEntries(VARIANTS.slice(1).map(variant => [variant, { T: score(mt, variant), C: score(mc, variant), verdict: pairVerdict(score(mt, variant), score(mc, variant)) }])) });
  }
  const calibration = {
    histS: s && !s.incomplete ? { sValid: s.sValid, loss: s.loss, perJudge: Object.fromEntries((["claude", "gpt"] as const).map(model => { const j = readJudgments(unit, "hist-S")[model]; return [model, j ? ctx.statements.filter(item => labelOfStatement(ctx, item.id) === "valid" && item.origin.startsWith("S:")).filter(item => j.byId.get(item.id)?.realization !== "complete").length : null]; })) } : undefined,
    knownLossesInHistA: (KNOWN_LOSSES[unit] ?? []).map(origin => { const q = ctx.byOrigin.get(origin)!; const j = readJudgments(unit, "hist-A"); return { origin, q, claude: j.claude?.byId.get(q)?.realization, gpt: j.gpt?.byId.get(q)?.realization, tier2: tier2.get(`R:hist-A:${q}`)?.verdict, label: labelOfStatement(ctx, q) }; }),
    // The over-credit sample: S-valid statements both judges rated complete that Tier 2 rated otherwise.
    overCredit: Object.fromEntries(TEXTS.map(label => { const sampled = t2.items.filter(item => item.label === label && item.kind === "realization" && (item.judges ?? []).length === 2 && item.judges.every((judge: any) => judge.realization === "complete")); return [label, { sampled: sampled.length, decided: sampled.filter(item => tier2.has(item.id)).length, notComplete: sampled.filter(item => tier2.has(item.id) && tier2.get(item.id)!.verdict !== "complete").length }]; }).filter(([, value]) => (value as any).sampled)),
  };
  const eCounts = Object.values(ctx.e).reduce((acc: Record<string, number>, value) => { acc[value.primary] = (acc[value.primary] ?? 0) + 1; return acc; }, {});
  const eValidNew = ctx.statements.filter(item => item.origin.startsWith("E:") && labelOfStatement(ctx, item.id) === "valid" && !ctx.inS.has(item.id)).length;
  return { unit, statements: ctx.statements.length, sCounts: Object.values(ctx.s).reduce((acc: Record<string, number>, value) => { acc[value.primary] = (acc[value.primary] ?? 0) + 1; return acc; }, {}), eCounts, eValidNew, tier2Verdicts: tier2.size, tier2Checks: t2.checks.map(check => ({ ...check, missing: check.missing.length, quoteMisses: check.quoteMisses.length, quoteMissIds: check.quoteMisses })), texts, pairs, calibration };
}
/** The study rule applied to one sensitivity reading: every complete pair's scores and verdict replaced by that reading's. */
export function studyVerdictUnder(units: any[], variant: string): { verdict: string; reasons: string[] } {
  return studyVerdict(units.map(unit => ({ ...unit, pairs: unit.pairs.map((pair: any) => pair.variants?.[variant] ? { ...pair, ...pair.variants[variant] } : pair) })));
}
export function studyVerdict(units: any[]): { verdict: string; reasons: string[] } {
  const reasons: string[] = [];
  const primary = units.flatMap(unit => unit.pairs.map((pair: any) => ({ ...pair, unit: unit.unit })));
  const vsC1 = primary.filter(pair => pair.c.startsWith("C1")), vsC0 = primary.filter(pair => pair.t.startsWith("T-") && pair.c.startsWith("C0"));
  const complete = (list: any[]) => list.filter(pair => pair.verdict !== "incomplete");
  const okVerdict = (pair: any) => pair.verdict === "improvement" || pair.verdict === "tie";
  const regressionsC1 = complete(vsC1).filter(pair => pair.verdict === "regression");
  const notLowerC1 = complete(vsC1).filter(pair => pair.T.L >= pair.C.L);
  const unitsWithImprovement = new Set(complete([...vsC1, ...vsC0]).filter(pair => pair.verdict === "improvement").map(pair => pair.unit));
  const unitsBothReps = units.filter(unit => [1, 2].every(rep => !unit.texts[`T-r${rep}`].incomplete && !unit.texts[`C1-r${rep}`].incomplete && !unit.texts[`C0-r${rep}`].incomplete)).length;
  if (regressionsC1.length) reasons.push(`T-vs-C1 regression in ${regressionsC1.map(pair => `${pair.unit} r${pair.rep}`).join(", ")}`);
  if (notLowerC1.length * 2 > complete(vsC1).length) reasons.push(`T's loss not lower than C1's in ${notLowerC1.length} of ${complete(vsC1).length} complete pairs`);
  if (!unitsWithImprovement.size) reasons.push("no improvement in any unit");
  if (reasons.length) return { verdict: "not supported", reasons };
  const supported = complete(vsC1).every(okVerdict) && complete(vsC0).every(okVerdict) && units.every(unit => complete([...vsC1, ...vsC0]).some(pair => pair.unit === unit.unit && pair.verdict === "improvement")) && unitsBothReps >= 2;
  if (supported) return { verdict: "supported", reasons: ["every complete T-vs-C1 and T-vs-C0 pair is an improvement or a tie, each unit has an improvement, and at least two units have both repetitions"] };
  return { verdict: "inconclusive", reasons: [...complete([...vsC1, ...vsC0]).filter(pair => !okVerdict(pair)).map(pair => `${pair.unit} r${pair.rep} ${pair.t} vs ${pair.c}: ${pair.verdict}`), ...(unitsBothReps < 2 ? ["fewer than two units with both repetitions complete"] : []), ...units.filter(unit => !complete([...vsC1, ...vsC0]).some(pair => pair.unit === unit.unit && pair.verdict === "improvement")).map(unit => `${unit.unit}: no improvement`)] };
}

// ---- integrity of the records and usage accounting --------------------------------------------------------------------------------
/** Turn directories (turn-<n> with meta.json) below `dir`, skipping copies of targets, agent dirs, work files and `skip`. */
export function turnDirs(dir: string, skip: string[] = [], depth = 8): string[] {
  const SKIP = new Set(["target", "agent", "pi-orche", "node_modules", "runtime", "provider", "work", "out", ...skip]);
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (/^turn-\d+$/.test(entry.name)) { if (existsSync(join(path, "meta.json"))) out.push(path); continue; }
    out.push(...turnDirs(path, skip, depth - 1));
  }
  return out.sort();
}
const metaOf = (dir: string) => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
/** Integrity of the study's records: manifest hashes, frozen texts and pipeline records, every judgment re-checked, the earlier results. */
export function verifyRecords(study: string): any {
  const manifest = JSON.parse(readFileSync(join(RESULTS, "manifest.json"), "utf8"));
  const problems: string[] = [];
  const check = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); return ok; };
  const out: any = { at: new Date().toISOString() };
  out.manifest = {
    protocol: check(manifest.protocolSha256 === sha(readFileSync(join(RESULTS, "protocol.md"))), "protocol.md changed after the manifest"),
    runner: check(manifest.runnerSha256 === sha(readFileSync(join(REPO, "experiments/mdsd-ab/synthesis.ts"))), "the runner changed after the manifest"),
    prompts: check(JSON.stringify(manifest.prompts) === JSON.stringify(promptHashes()), "prompt hashes differ from the manifest"),
    sources: Object.fromEntries(Object.entries(manifest.sources as Record<string, string>).map(([name, hash]) => [name, check(hash === sha(readFileSync(join(REPO, "experiments/mdsd-ab", name))), `${name} changed after the manifest`)])),
    units: Object.fromEntries(UNITS.map(unit => { const input = unitInput(unit), frozen = manifest.units[unit]; return [unit, { inputs: check((["task", "P1", "P2", "seed"] as const).every(name => (input.hashes as Record<string, string>)[name] === frozen[name]), `${unit}: frozen inputs differ from the manifest`), statements: check(sha(JSON.stringify(unitStatements(unit))) === frozen.statementsSha256, `${unit}: statements differ from the manifest`) }]; })),
  };
  const before = JSON.parse(readFileSync(join(study, "qv-before.json"), "utf8")) as Record<string, string>, now = treeHashes(QV);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(file => before[file] !== now[file]);
  const afterFile = join(study, "qv-after.json");
  check(!changed.length, `${changed.length} files of results/quality-validation differ from qv-before.json`);
  out.qualityValidation = { before: Object.keys(before).length, now: Object.keys(now).length, changed, sameAsManifestDigest: sha(JSON.stringify(now)) === manifest.qualityValidation.digest, qvAfter: existsSync(afterFile) ? JSON.stringify(JSON.parse(readFileSync(afterFile, "utf8"))) === JSON.stringify(now) ? "matches" : "differs" : "not written" };
  out.pipelines = [];
  for (const unit of UNITS) for (const rep of [1, 2]) for (const arm of ["C", "T"] as const) {
    const dir = join(RESULTS, unit, `${arm}-r${rep}`), record = JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8"));
    const texts = (arm === "C" ? ["C0", "C1"] : ["Tpre", "T"]).map(label => {
      const frozen = JSON.parse(readFileSync(join(dir, label, "frozen.json"), "utf8"));
      const differs = Object.entries(frozen.files as Record<string, string>).filter(([name, hash]) => !existsSync(join(dir, label, name)) || sha(readFileSync(join(dir, label, name), "utf8")) !== hash).map(([name]) => name);
      check(frozen.ok === true, `${unit} ${arm}-r${rep} ${label}: frozen.json ok is not true`);
      check(!differs.length, `${unit} ${arm}-r${rep} ${label}: ${differs.join(", ")} differ from frozen.json`);
      return { label, ok: frozen.ok === true, files: Object.keys(frozen.files).length, differs, finalSha256: frozen.files["final.md"] };
    });
    const metas = turnDirs(join(dir, "sessions")).map(metaOf);
    check(!record.error && record.totals.allOk && record.totals.routeOk && record.totals.targetUnchanged, `${unit} ${arm}-r${rep}: pipeline record is not clean`);
    check(metas.length === record.totals.turns && metas.every(meta => meta.runnerSha256 === manifest.runnerSha256), `${unit} ${arm}-r${rep}: turn records missing or from another runner`);
    out.pipelines.push({ unit, arm, rep, error: record.error ?? null, allOk: record.totals.allOk, routeOk: record.totals.routeOk, targetUnchanged: record.totals.targetUnchanged, turns: record.totals.turns, turnRecords: metas.length, runnerOk: metas.every(meta => meta.runnerSha256 === manifest.runnerSha256), texts });
  }
  out.judgments = [];
  for (const unit of UNITS) {
    const ids = unitStatements(unit).statements.map(item => item.id);
    for (const { label, file } of unitTexts(unit)) for (const model of ["claude", "gpt"] as const) {
      const path = join(RESULTS, unit, "judgments", `${label}.${model}.json`);
      if (!check(existsSync(path), `${unit} ${label}.${model}: no judgment record`)) { out.judgments.push({ unit, label, model, exists: false }); continue; }
      const record = JSON.parse(readFileSync(path, "utf8")), text = readFileSync(file, "utf8"), recheck = checkJudgment(ids, record.judgment, text);
      const turns: any[] = record.turns ?? [], metas = turnDirs(join(RESULTS, unit, "judge-sessions", `${label}.${model}`)).map(metaOf);
      const row = { unit, label, model, valid: record.valid === true, errors: (record.errors ?? []).length, recheckErrors: recheck.errors.length, quotes: `${recheck.quotesFound}/${recheck.quotesNeeded}`, textHashOk: record.textSha256 === sha(text), statementsOk: record.statements === ids.length, turns: turns.length, routeOk: turns.length > 0 && turns.every(t => t.route?.requests && t.route?.transcript), responseModels: turns.reduce((acc: Record<string, number>, t) => { for (const [name, n] of Object.entries(t.route?.responseModels ?? {})) acc[name] = (acc[name] ?? 0) + (n as number); return acc; }, {}), runnerOk: metas.length === turns.length && metas.every(meta => meta.runnerSha256 === manifest.runnerSha256) };
      check(row.valid && !row.recheckErrors && row.textHashOk && row.statementsOk, `${unit} ${label}.${model}: judgment not valid on recheck`);
      check(row.routeOk && row.runnerOk, `${unit} ${label}.${model}: route or runner check failed`);
      out.judgments.push(row);
    }
  }
  out.problems = problems;
  return out;
}
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
/**
 * Usage and time of every physical model session of the study, each attempt counted once from the scratch session directories (results
 * and preflight-results hold copies): complete and interrupted attempts from their own records and wire logs, and attempts whose directory
 * was deleted from their progress-log line (tokens unknown). Host verification rounds and the experimenter's own session are added apart.
 */
export function accounting(study: string, experimenter?: { log: string; since: string }): any {
  const records = turnDirs(study, ["preflight-results"]).map(dir => {
    const meta = metaOf(dir), relative = dir.slice(study.length + 1);
    const wire = wireStats(readJsonl(join(dir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model));
    const category = relative.startsWith("preflight/") ? "preflight" : relative.includes("/judge/") ? "judge" : "measured";
    const state = meta.endedAt ? "complete" : meta.startedAt ? "interrupted" : "never started";
    const endedAt = meta.endedAt ?? wire.lastEndAt;
    return { dir: relative, label: meta.label, turn: meta.turn, model: meta.model, category, state, startedAt: meta.startedAt, endedAt, ms: typeof meta.ms === "number" ? meta.ms : meta.startedAt && endedAt ? Date.parse(endedAt) - Date.parse(meta.startedAt) : 0, eventCostUSD: typeof meta.costUSD === "number" ? meta.costUSD : null, wire: { requests: wire.requests, costUSD: wire.costUSD, input: wire.input, cached: wire.cached, cacheWrite: wire.cacheWrite, output: wire.output, reasoning: wire.reasoning, unknownUsage: wire.unknownUsage, providerErrors: wire.providerErrors.length } };
  });
  const lost: any[] = [];
  const logFile = join(study, "progress.log");
  for (const line of existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []) {
    const match = /^(\S+) (\S+) turn (\d+) done ok=(\S+) exit=\S+ (\d+)s (\d+) responses \$([0-9.]+) wire=(\d+)req\/\$([0-9.]+)/.exec(line);
    if (!match) continue;
    const [, at, label, turn, ok, seconds, , eventCost, requests, wireCost] = match;
    if (records.some(record => record.label === label && record.turn === Number(turn) && record.endedAt && Math.abs(Date.parse(record.endedAt) - Date.parse(at!)) < 15_000)) continue;
    lost.push({ label, turn: Number(turn), category: label!.startsWith("toy") ? "preflight" : label!.includes("-judge-") ? "judge" : "measured", state: "directory deleted", ok: ok === "true", startedAt: new Date(Date.parse(at!) - Number(seconds) * 1000).toISOString(), endedAt: at, ms: Number(seconds) * 1000, eventCostUSD: Number(eventCost), wire: { requests: Number(requests), costUSD: Number(wireCost) }, lostEvidence: "session directory, transcript, wire log, token counts and the judgment file of this attempt" });
  }
  const all = [...records, ...lost];
  const totals = (list: any[]) => {
    const sum = (pick: (item: any) => number | null | undefined) => round6(list.reduce((total, item) => total + (pick(item) ?? 0), 0));
    const starts = list.map(item => Date.parse(item.startedAt)).filter(Number.isFinite), ends = list.map(item => Date.parse(item.endedAt)).filter(Number.isFinite);
    return { attempts: list.length, byState: list.reduce((acc: Record<string, number>, item) => { acc[item.state] = (acc[item.state] ?? 0) + 1; return acc; }, {}), requests: sum(item => item.wire.requests), wireCostUSD: sum(item => item.wire.costUSD), eventCostUSD: sum(item => item.eventCostUSD), tokens: { input: sum(item => item.wire.input), cached: sum(item => item.wire.cached), cacheWrite: sum(item => item.wire.cacheWrite), output: sum(item => item.wire.output), reasoning: sum(item => item.wire.reasoning) }, tokensUnknownAttempts: list.filter(item => item.wire.input === undefined).length, unknownUsageRequests: sum(item => item.wire.unknownUsage), providerErrors: sum(item => item.wire.providerErrors), sessionHours: Math.round(sum(item => item.ms) / 36e3) / 100, elapsedHours: starts.length && ends.length ? Math.round((Math.max(...ends) - Math.min(...starts)) / 36e3) / 100 : 0, firstStart: starts.length ? new Date(Math.min(...starts)).toISOString() : undefined, lastEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : undefined };
  };
  const pipelines = UNITS.flatMap(unit => [1, 2].flatMap(rep => (["C", "T"] as const).map(arm => {
    const id = `${unit}-${arm}-r${rep}`, mine = records.filter(record => record.category === "measured" && record.label.startsWith(`${id}-`));
    const recorded = JSON.parse(readFileSync(join(RESULTS, unit, `${arm}-r${rep}`, "pipeline.json"), "utf8")).totals;
    return { id, ...totals(mine), byStage: Object.fromEntries([...new Set(mine.map(record => record.label.slice(id.length + 1)))].map(stage => [stage, totals(mine.filter(record => record.label === `${id}-${stage}`))])), pipelineJsonWireCostUSD: recorded.wireCostUSD, matchesPipelineJson: Math.abs(recorded.wireCostUSD - totals(mine).wireCostUSD) < 1e-6 && recorded.requests === totals(mine).requests };
  })));
  const judgeAttempts = all.filter(item => item.category === "judge");
  const hostFile = join(RESULTS, "host-rounds.json");
  let experimenterUsage: any = { metered: false, reason: "no session log given" };
  if (experimenter && existsSync(experimenter.log)) {
    const ends = readJsonl(experimenter.log).filter(entry => entry?.type === "message" && entry.message?.role === "assistant" && String(entry.timestamp ?? "") >= experimenter.since);
    const usage = (pick: (u: any) => number | undefined) => round6(ends.reduce((total, entry) => total + (pick(entry.message?.usage ?? {}) ?? 0), 0));
    experimenterUsage = { metered: true, source: "the experimenter's own Pi session log (assistant messages since the study's assignment began)", since: experimenter.since, requests: ends.length, costUSD: usage(u => u.cost?.total), input: usage(u => u.input), output: usage(u => u.output), cacheRead: usage(u => u.cacheRead), cacheWrite: usage(u => u.cacheWrite), unknownCost: ends.filter(entry => typeof entry.message?.usage?.cost?.total !== "number").length };
  }
  return {
    at: new Date().toISOString(), study,
    rule: "each physical attempt once, from the scratch session directories; results/ and preflight-results/ hold copies and are not counted",
    categories: { measured: totals(all.filter(item => item.category === "measured")), judge: totals(judgeAttempts), preflight: totals(all.filter(item => item.category === "preflight")) },
    judges: { used: totals(judgeAttempts.filter(item => item.state === "complete" && !item.dir?.includes(".interrupted-"))), interrupted: totals(judgeAttempts.filter(item => item.dir?.includes(".interrupted-") || item.state === "interrupted")), deleted: totals(judgeAttempts.filter(item => item.state === "directory deleted")), byModel: Object.fromEntries(["claude", "gpt"].map(model => [model, totals(judgeAttempts.filter(item => String(item.label).endsWith(`.${model}`)))])) },
    pipelines, lost, hostRounds: existsSync(hostFile) ? JSON.parse(readFileSync(hostFile, "utf8")) : "not recorded", experimenter: experimenterUsage,
    unmetered: ["local compute (bubblewrap sandboxes, target copies, tests, type checks)", "tokens of the deleted judge attempts (only their progress-log totals survive)", "requests in flight when the six judge attempts were interrupted (no usage was returned)", "host verifier token counts (the orche spawn reports give cost, requests and time only)"],
    attempts: all.map(({ wire, ...rest }) => ({ ...rest, requests: wire.requests, wireCostUSD: wire.costUSD })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, a] = process.argv.slice(2);
  if (command === "slabels") {
    for (const unit of UNITS) {
      const labels = sLabels(unit);
      const out = join(RESULTS, unit, "labels", "s-labels.json");
      if (existsSync(out)) { const old = JSON.parse(readFileSync(out, "utf8")); if (sha(JSON.stringify(old.claims)) !== sha(JSON.stringify(labels.claims))) throw new Error(`${unit}: the S reference changed after it was frozen`); console.log(`${unit}: unchanged`); continue; }
      await mkdir(join(RESULTS, unit, "labels"), { recursive: true });
      await write(out, { unit, ...labels, rule: "valid = K/C/V in both earlier evaluator reports (protocol.md)", frozenAt: new Date().toISOString() });
      console.log(`${unit}: side ${labels.side} ${JSON.stringify(labels.counts)}`);
    }
  } else if (command === "epackets") await ePackets(a!);
  else if (command === "t2packets") await t2Packets(a!, process.argv[4]!, process.argv[5] ? JSON.parse(process.argv[5]) : {});
  else if (command === "t2ingest") await t2Ingest(a!, process.argv[4]!, process.argv[5]!, process.argv[6]!);
  else if (command === "score") {
    const units = UNITS.map(scoreUnit);
    const variants = Object.keys(units[0]?.pairs.find((pair: any) => pair.variants)?.variants ?? {});
    const study = { ...studyVerdict(units), sensitivity: Object.fromEntries(variants.map(variant => [variant, studyVerdictUnder(units, variant)])) };
    await write(join(RESULTS, "scores.json"), { at: new Date().toISOString(), study, units });
    await write(join(RESULTS, "unresolved.json"), { at: new Date().toISOString(), rule: "Tier-2 packet items without an accepted verdict: the combination rule (lower of the two judges) applies to R/I/D; O/X items are not counted; both judges' readings are listed", units: units.map(unit => ({ unit: unit.unit, texts: Object.fromEntries(Object.entries(unit.texts).filter(([, m]: [string, any]) => m.tier2?.unresolved?.length).map(([label, m]: [string, any]) => [label, m.tier2.unresolved])) })) });
    for (const unit of units) {
      console.log(`== ${unit.unit} S ${JSON.stringify(unit.sCounts)} E ${JSON.stringify(unit.eCounts)} E-valid-new ${unit.eValidNew} tier2 ${unit.tier2Verdicts} checks ${JSON.stringify(unit.tier2Checks.map((check: any) => ({ group: check.group, items: check.items, accepted: check.accepted, missing: check.missing, invalid: check.invalid.length, unknown: check.unknown.length, quoteMisses: check.quoteMisses, sha: check.itemsSha256Ok })))}`);
      for (const label of TEXTS) { const m = unit.texts[label]; console.log(`${label.padEnd(8)} ${m.incomplete ? `INCOMPLETE (${m.incomplete})` : `L=${m.loss.L} (p${m.loss.partial}/m${m.loss.missing}/o${m.loss.opposed}) of ${m.sValid} I=${m.invalid.total} (F${m.invalid.F}/S${m.invalid.S}/oF${m.invalid.other.F}/oS${m.invalid.other.S}; inh ${m.invalidOrigin?.inherited}/new ${m.invalidOrigin?.newStatements}+${m.invalidOrigin?.newOther}) A=${m.additions} new=${m.newObservations} drift=${JSON.stringify(m.drift)} contra=${m.contradictions} kept-not-realized=${m.keptNotRealized ?? "-"}/${m.keptValid ?? "-"} stanceOpen=${m.stanceOpen.invalid}/${m.stanceOpen.additions} t2=${m.tier2.decided}/${m.tier2.items} chars=${m.chars}`}`); }
      for (const pair of unit.pairs) console.log(`  r${pair.rep} ${pair.t} vs ${pair.c}: ${pair.verdict}${pair.T ? ` T${JSON.stringify(pair.T)} C${JSON.stringify(pair.C)}` : ""}`);
      console.log(`  calibration ${JSON.stringify(unit.calibration)}`);
    }
    console.log(`STUDY: ${study.verdict} — ${study.reasons.join("; ")}`);
    for (const [variant, result] of Object.entries(study.sensitivity)) console.log(`  under ${variant}: ${result.verdict}`);
  } else if (command === "verify") {
    const result = verifyRecords(a!);
    await write(join(RESULTS, "verification.json"), result);
    console.log(JSON.stringify({ manifest: result.manifest, qualityValidation: { ...result.qualityValidation, changed: result.qualityValidation.changed.length }, pipelines: result.pipelines.length, judgments: result.judgments.length, problems: result.problems }, null, 1));
  } else if (command === "accounting") {
    const result = accounting(a!, process.argv[4] && process.argv[5] ? { log: process.argv[4], since: process.argv[5] } : undefined);
    await write(join(RESULTS, "accounting.json"), result);
    console.log(JSON.stringify({ categories: result.categories, judges: result.judges, lost: result.lost.length, pipelinesMatch: result.pipelines.every((pipeline: any) => pipeline.matchesPipelineJson), experimenter: result.experimenter }, null, 1));
  } else throw new Error("usage: synthesis-eval.ts slabels | epackets <evalDir> | t2packets <evalDir> <keysDir> [split] | t2ingest <evalDir> <keysDir> <group> <verdicts.json> | score | verify <study> | accounting <study> [sessionLog since]");
  process.exit(0);
}
