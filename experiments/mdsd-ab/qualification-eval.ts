/** Evaluation/selection scoring for qualification validation. Never imported by measured sessions. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, DOCS, SUPPORT, RELEVANCE, packet, claimsOf, keyOf, json, text, type Claim } from "./qualification-inputs.js";
import { sha, write, REPO, readJsonl, PI_CLI, AGENT, filesUnder } from "./run.js";
import { UNITS, numberLines, spanFound, treeHashes } from "./synthesis.js";
import { checkJudge, decisionAction, prompts } from "./qualification.js";
import { sourceHashes, retainSession, setStudy, checkPins, canonicalModel } from "./qualification-runtime.js";
import { wireStats, redact, contentHashes, hashDiff } from "./matrix.js";
export const LABELS = ["baseline", "T-r1", "Q-r1", "T-r2", "Q-r2"];
export const rank: Record<string, number> = { opposed: 0, missing: 1, partial: 2, complete: 3 };
export const asserted = (s: string) => s === "asserted" || s === "mixed";
export interface Judged { realization: string; stance: string; statusDrift: string; quote?: string; counterQuote?: string; note?: string }
export type Adjudication = Record<string, any>;
export function mergeJudges(entries: (Judged | undefined)[], override?: any, optimistic = false): Judged & { disagreement: boolean } {
  const valid = entries.filter((e): e is Judged => !!e && e.realization in rank);
  if (override?.realization && override?.stance) return { ...override, statusDrift: override.statusDrift ?? "none", disagreement: false };
  if (!valid.length) return { realization: "unjudged", stance: "unknown", statusDrift: "unknown", disagreement: true };
  const sorted = [...valid].sort((a, b) => rank[a.realization]! - rank[b.realization]!);
  const stanceRanks: Record<string, number> = { absent: 0, rejected: 1, hedged: 2, asserted: 3, mixed: 4 };
  const stances = [...valid].sort((a, b) => stanceRanks[a.stance]! - stanceRanks[b.stance]!);
  return { realization: (optimistic ? sorted.at(-1) : sorted[0])!.realization, stance: (optimistic ? stances[0] : stances.at(-1))!.stance, statusDrift: valid.some(v => v.statusDrift !== "none") ? valid.find(v => v.statusDrift !== "none")!.statusDrift : "none", disagreement: valid.length !== 2 || new Set(valid.map(v => `${v.realization}/${v.stance}/${v.statusDrift}`)).size > 1 };
}
export function references(unit: string, mode = "b"): Map<string, any> {
  const file = join(ROOT, "references", `${unit}-${mode}.json`);
  return new Map(existsSync(file) ? json(file).items.map((v: any) => [v.id, v]) : []);
}
export function judgments(unit: string, label: string): any[] {
  return ["claude", "gpt"].map(m => { const f = join(ROOT, unit, "judgments", `${label}.${m}.json`); return existsSync(f) ? json(f) : undefined; });
}
export function finalText(unit: string, label: string): string { return label === "baseline" ? packet(unit)[`${keyOf(unit).base}.md`]! : text(join(ROOT, unit, label, "final/final.md")); }
export function planOf(unit: string, label: string): any[] { const f = join(ROOT, unit, label, "final/plan.json"); return existsSync(f) ? json(f).entries : []; }
export function initialOf(unit: string, label: string): any[] { const f = join(ROOT, unit, label, "prepared/decisions.json"); return existsSync(f) ? json(f).entries : []; }
export function loadAdjudication(unit: string): Adjudication {
  const d = join(ROOT, unit, "adjudication"), out: Adjudication = {};
  if (!existsSync(d)) return out;
  for (const file of readdirSync(d).filter(n => n.startsWith("accepted-") && n.endsWith(".json"))) Object.assign(out, json(join(d, file)).items);
  return out;
}
export function context(unit: string) {
  const claims = claimsOf(unit), key = keyOf(unit), refs = references(unit), base = key.base;
  const all = Object.fromEntries(LABELS.map(label => [label, judgments(unit, label)]));
  const maps = Object.fromEntries(LABELS.map(label => [label, all[label]!.map(j => new Map((j?.judgment?.statements ?? []).map((e: any) => [e.id, e])))]));
  const adj = loadAdjudication(unit);
  const entries = (label: string, id: string): (Judged | undefined)[] => maps[label]!.map(m => m.get(id) as Judged | undefined);
  const get = (label: string, id: string, optimistic = false) => mergeJudges(entries(label, id), adj[`R:${label}:${id}`], optimistic);
  return { unit, claims, key, refs, base, all, entries, get, adj };
}
export type Context = ReturnType<typeof context>;
const relevant = (r: any, ambiguous = false, contextIncluded = true) => ["finding", "supporting", ...(contextIncluded ? ["requested_context"] : []), ...(ambiguous ? ["ambiguous"] : [])].includes(r?.relevance);
export function singleSource(ctx: Context, c: Claim): boolean {
  const r = ctx.refs.get(c.ref), byId = new Map(ctx.claims.map(x => [x.ref, x]));
  return !(r?.equivalentTo ?? []).some((id: string) => byId.get(id)?.source !== c.source);
}
/**
 * Selection decisions against the frozen references. Round-2 S items assess FINAL-plan decisions only (`S:<label>:<k>`), so the
 * adjudication fields are filled only for `adjudicated` (the final plan); initial Q decisions are counted, never credited with a
 * final-plan adjudication (W8 fix, evaluation-deviations.md 2026-10-18T18:35Z).
 */
export function selectionMetrics(ctx: Context, label: string, entries = planOf(ctx.unit, label), adjudicated = true): any {
  const out: any = { decisions: 0, validRejected: 0, falseAccepted: 0, outAccepted: 0, unsupportedAccepted: 0, uncertain: 0, correction: 0, exclusion: 0, duplicate: 0, ...(adjudicated ? { justified: 0, unjustified: 0, unresolvedAssessment: 0, assessed: 0 } : { adjudicationScope: "not adjudicated (round-2 S items assess final-plan decisions only)" }) };
  for (const e of entries) {
    const ref = ctx.refs.get(e.ref); if (!ref) continue;
    out.decisions++;
    const action = e.action ?? decisionAction(e.disposition);
    const include = action === "include" || action === "duplicate";
    if (ref.support === "supported" && relevant(ref) && action === "exclude") out.validRejected++;
    if (ref.support === "refuted" && include) out.falseAccepted++;
    if (ref.relevance === "out" && include) out.outAccepted++;
    if (["insufficient", "conflicting"].includes(ref.support) && include) out.unsupportedAccepted++;
    if (action === "uncertain") out.uncertain++;
    if (action === "correct") out.correction++;
    if (action === "exclude") out.exclusion++;
    if (action === "duplicate") out.duplicate++;
    if (!adjudicated) continue;
    const a = ctx.adj[`S:${label}:${e.ref}`];
    if (a) { out.assessed++; if (a.verdict === "justified") out.justified++; else if (a.verdict === "unjustified") out.unjustified++; else out.unresolvedAssessment++; }
  }
  return out;
}
/** Initial (pre-reveal) Q decisions: counts without adjudication credit, plus how many differ from the final-plan action. */
export function initialSelection(ctx: Context, label: string, initial = initialOf(ctx.unit, label), final = planOf(ctx.unit, label)): any {
  if (!initial.length) return undefined;
  const finalAction = new Map(final.map((e: any) => [e.ref, e.action ?? decisionAction(e.disposition)]));
  const differs = initial.filter((e: any) => finalAction.has(e.ref) && (e.action ?? decisionAction(e.disposition)) !== finalAction.get(e.ref)).map((e: any) => e.ref);
  return { ...selectionMetrics(ctx, label, initial, false), differsFromFinal: differs.length, differsFromFinalIds: differs };
}
/**
 * Twin classes of accepted O or X entries of one text (`prefix` = `O:<label>:`): entries joined by `sameAs` in either direction,
 * including chains and cycles. A `sameAs` target without an accepted entry joins nothing, so it can never hide the pointing entry.
 */
export function twinClasses(adj: Adjudication, prefix: string): string[][] {
  const ids = Object.keys(adj).filter(id => id.startsWith(prefix)).sort();
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const id of ids) {
    const target = adj[id]?.sameAs;
    if (typeof target !== "string" || !parent.has(target)) continue;
    const a = find(id), b = find(target);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const classes = new Map<string, string[]>();
  for (const id of ids) { const root = find(id); classes.set(root, [...(classes.get(root) ?? []), id]); }
  return [...classes.values()];
}
/**
 * New-claim (O) and contradiction (X) counts of one text from round-2 entries, one per twin class (order-independent). `not_new`
 * entries contribute nothing; F/O/U need an asserted claim (`asserted !== false`); within a class any member's error counts
 * (conservative), and classes whose members disagree are reported.
 */
export function newClaimCounts(adj: Adjudication, label: string): { newV: number; newF: number; newO: number; newU: number; X: number; inconsistentTwins: number; notNew: number; hedgedErrors: number } {
  const out = { newV: 0, newF: 0, newO: 0, newU: 0, X: 0, inconsistentTwins: 0, notNew: 0, hedgedErrors: 0 };
  for (const members of twinClasses(adj, `O:${label}:`)) {
    const entries = members.map(id => adj[id]).filter(a => a.support !== "not_new");
    if (!entries.length) { out.notNew++; continue; }
    const assertedEntries = entries.filter(a => a.asserted !== false);
    if (entries.some(a => a.support === "supported" && relevant(a))) out.newV++;
    if (assertedEntries.some(a => a.support === "refuted")) out.newF++;
    if (assertedEntries.some(a => a.relevance === "out")) out.newO++;
    if (assertedEntries.some(a => ["insufficient", "conflicting"].includes(a.support))) out.newU++;
    if (!assertedEntries.length && entries.some(a => a.support !== "supported" || a.relevance === "out")) out.hedgedErrors++;
    if (new Set(members.map(id => `${adj[id].support}/${adj[id].relevance}/${adj[id].asserted !== false}`)).size > 1) out.inconsistentTwins++;
  }
  for (const members of twinClasses(adj, `X:${label}:`)) if (members.some(id => adj[id].verdict === "confirmed")) out.X++;
  return out;
}
export function metrics(ctx: Context, label: string, opts: { optimistic?: boolean; ambiguous?: boolean; contextIncluded?: boolean; partialLoss?: boolean; partialAddition?: boolean; dedup?: boolean } = {}): any {
  const counts: any = { L: 0, A: 0, F: 0, O: 0, U: 0, H: 0, D: 0, X: 0, supportedBase: 0, complete: 0, partial: 0, missing: 0, opposed: 0, additionsPartial: 0, singleSourceAdditions: 0, newV: 0, newF: 0, newO: 0, newU: 0, falseRepeated: 0, falseCorrected: 0, falseHedged: 0, falseRemoved: 0, ambiguousAsserted: 0, selection: selectionMetrics(ctx, label), initialSelection: initialSelection(ctx, label) };
  const ids: Record<string, string[]> = Object.fromEntries(["loss", "addition", "F", "O", "U", "H", "D"].map(n => [n, []]));
  const seen = new Set<string>();
  for (const c of ctx.claims) {
    const r = ctx.refs.get(c.ref); if (!r) continue;
    if (opts.dedup && (r.equivalentTo ?? []).some((id: string) => seen.has(id))) continue;
    seen.add(c.ref);
    const j = ctx.get(label, c.ref, opts.optimistic), b = ctx.get("baseline", c.ref, opts.optimistic);
    const valid = r.support === "supported" && relevant(r, opts.ambiguous, opts.contextIncluded !== false), base = c.source === ctx.base;
    if (valid && base) {
      counts.supportedBase++; if (j.realization in counts) counts[j.realization]++;
      if (j.realization !== "complete") { counts.L += opts.partialLoss && j.realization === "partial" ? 0.5 : 1; ids.loss!.push(c.ref); }
    }
    if (valid && !base && b.realization !== "complete") {
      if (j.realization === "complete" || opts.partialAddition && j.realization === "partial") { counts.A++; ids.addition!.push(c.ref); if (singleSource(ctx, c)) counts.singleSourceAdditions++; }
      if (j.realization === "partial") counts.additionsPartial++;
    }
    if (asserted(j.stance)) {
      if (r.support === "refuted") { counts.F++; ids.F!.push(c.ref); }
      if (r.relevance === "out") { counts.O++; ids.O!.push(c.ref); }
      if (["insufficient", "conflicting"].includes(r.support)) { counts.U++; ids.U!.push(c.ref); }
      if (r.relevance === "ambiguous") counts.ambiguousAsserted++;
    }
    if (valid && c.stance !== "uncertain" && j.stance === "hedged") { counts.H++; ids.H!.push(c.ref); }
    // A justified refutation/correction is not harmful status drift. Preserve the reference's support axis.
    const harmfulDrift = valid || ["insufficient", "conflicting"].includes(r.support) && ["upgrade", "mixed"].includes(j.statusDrift);
    if (harmfulDrift && j.statusDrift !== "none") { counts.D++; ids.D!.push(c.ref); }
    if (base && r.support === "refuted") {
      if (asserted(j.stance)) counts.falseRepeated++;
      else if (j.stance === "rejected" || j.realization === "opposed") counts.falseCorrected++;
      else if (j.stance === "hedged") counts.falseHedged++;
      else counts.falseRemoved++;
    }
  }
  const fresh = newClaimCounts(ctx.adj, label);
  counts.newV = fresh.newV; counts.newF = fresh.newF; counts.newO = fresh.newO; counts.newU = fresh.newU; counts.newInconsistentTwins = fresh.inconsistentTwins; counts.newNotNew = fresh.notNew; counts.newHedgedErrors = fresh.hedgedErrors;
  counts.F += fresh.newF; counts.O += fresh.newO; counts.U += fresh.newU; counts.X += fresh.X;
  return { ...counts, ids };
}
export interface GateScore { L: number; A: number; F: number; O: number; U: number; H: number; D: number; X: number }
export function pairVerdict(q: GateScore, t: GateScore): string {
  const lower = ["L", "F", "O", "U", "H", "D", "X"] as const;
  const worse = lower.some(k => q[k] > t[k]) || q.A < t.A;
  const better = lower.some(k => q[k] < t[k]) || q.A > t.A;
  if (!worse && q.F + q.O < t.F + t.O) return "improvement";
  if (!worse && !better) return "tie";
  if (!worse) return "secondary gain";
  return better ? "mixed" : "regression";
}
export function studyVerdict(pairs: any[], replicated: boolean): any {
  if (pairs.some(p => p.verdict === "incomplete")) return { verdict: "inconclusive", reason: "technical incompleteness: no quality conclusion from missing paired synthesis/judgments" };
  if (!replicated) return { verdict: "inconclusive", reason: "reference round-1 replication incomplete; all sole-b scores conditional" };
  if (pairs.length !== 6 || pairs.some(p => p.unresolved)) return { verdict: "inconclusive", reason: "missing/decision-changing unresolved evidence" };
  if (pairs.some(p => p.verdict === "regression") || !pairs.some(p => p.verdict === "improvement")) return { verdict: "not supported", reason: "regression or no primary improvement" };
  if (pairs.every(p => ["improvement", "secondary gain", "tie"].includes(p.verdict)) && UNITS.every(u => pairs.some(p => p.unit === u && p.verdict === "improvement"))) return { verdict: "supported", reason: "all safeguards met, improvement in every unit" };
  return { verdict: "inconclusive", reason: "mixed pairs or no improvement in a unit" };
}
/** A plan decision as shown to adjudicators: the same fields for both arms (no Q-only qualification fields, no retained/added). */
export const maskedDecision = (e: any) => ({ action: decisionAction(e.disposition), reason: e.reason, evidence: e.evidence, duplicateOf: e.duplicateOf, spans: e.spans });
export function textItems(ctx: Context, label: string): any[] {
  const items: any[] = [], plan = planOf(ctx.unit, label), byId = new Map(plan.map(e => [e.ref, e]));
  const getPair = (id: string) => ctx.entries(label, id);
  for (const c of ctx.claims) {
    const r = ctx.refs.get(c.ref), j = ctx.get(label, c.ref), b = ctx.get("baseline", c.ref);
    const valid = r?.support === "supported" && relevant(r), base = c.source === ctx.base;
    const reasons: string[] = [];
    if (valid && base && j.realization !== "complete") reasons.push("alleged baseline loss");
    if (j.disagreement) reasons.push("judge disagreement");
    if (r?.support === "refuted" || ["insufficient", "conflicting"].includes(r?.support)) reasons.push("false/insufficient handling");
    if (r?.relevance === "out" && asserted(j.stance)) reasons.push("scope acceptance");
    if (j.statusDrift !== "none" || j.stance === "mixed") reasons.push("status/occurrence");
    if (valid && !base && b.realization !== "complete") {
      const otherLabel = label.startsWith("T-") ? label.replace("T-", "Q-") : label.replace("Q-", "T-");
      if (ctx.get(otherLabel, c.ref).realization !== j.realization) reasons.push("addition difference");
    }
    if (reasons.length) items.push({ id: `R:${label}:${c.ref}`, kind: "realization", label, statement: c.ref, reference: r, judges: getPair(c.ref), reasons });
    const e = byId.get(c.ref); if (!e) continue;
    const action = decisionAction(e.disposition), accept = action === "include" || action === "duplicate";
    const bad = valid && action === "exclude" || accept && (r?.support !== "supported" || r?.relevance === "out") || action === "correct" || action === "duplicate" && j.realization !== "complete";
    if (bad) items.push({ id: `S:${label}:${c.ref}`, kind: "selection", label, statement: c.ref, reference: r, decision: maskedDecision(e), judges: getPair(c.ref) });
  }
  // Fixed random sample: <=6 agreed include and <=6 exclusions from each source, regardless of arm.
  for (const source of DOCS) for (const category of ["include", "exclude"]) {
    const candidates = ctx.claims.filter(c => c.source === source).filter(c => {
      const e = byId.get(c.ref), r = ctx.refs.get(c.ref), j = ctx.get(label, c.ref);
      if (!e || j.disagreement) return false;
      const action = decisionAction(e.disposition);
      return category === "include" ? (action === "include" || action === "duplicate") && r?.support === "supported" && relevant(r) && j.realization === "complete" : action === "exclude" && (r?.relevance === "out" || r?.support !== "supported");
    }).sort((a, b) => sha(`${ctx.unit}:${opaque(ctx.unit, label)}:${a.ref}:${category}`).localeCompare(sha(`${ctx.unit}:${opaque(ctx.unit, label)}:${b.ref}:${category}`))).slice(0, 6);
    for (const c of candidates) {
      const e = byId.get(c.ref)!;
      if (!items.some(i => i.id === `S:${label}:${c.ref}`)) items.push({ id: `S:${label}:${c.ref}`, kind: "selection", label, statement: c.ref, reference: ctx.refs.get(c.ref), decision: maskedDecision(e), judges: getPair(c.ref), sample: true });
      if (!items.some(i => i.id === `R:${label}:${c.ref}`)) items.push({ id: `R:${label}:${c.ref}`, kind: "realization", label, statement: c.ref, reference: ctx.refs.get(c.ref), judges: getPair(c.ref), sample: true });
    }
  }
  ctx.all[label]!.forEach((j: any, index: number) => {
    (j?.judgment?.other ?? []).forEach((o: any, n: number) => items.push({ id: `O:${label}:${index + 1}.${n + 1}`, kind: "other", label, ...o }));
    (j?.judgment?.contradictions ?? []).forEach((o: any, n: number) => items.push({ id: `X:${label}:${index + 1}.${n + 1}`, kind: "contradiction", label, ...o }));
  });
  return items;
}
export const opaque = (unit: string, label: string) => `t-${sha(`qual-text:${unit}:${label}`).slice(0, 8)}`;
/** Splits `cap` packets over groups by item count (largest remainder, at least one per group). */
export function allocatePackets(sizes: number[], cap = 8): number[] {
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const parts = sizes.map(n => Math.max(1, Math.floor(cap * n / total)));
  while (parts.reduce((a, b) => a + b, 0) > cap) { const i = parts.indexOf(Math.max(...parts)); if (parts[i]! <= 1) break; parts[i]!--; }
  while (parts.reduce((a, b) => a + b, 0) < cap) { const load = sizes.map((n, i) => n / parts[i]!); parts[load.indexOf(Math.max(...load))]!++; }
  return parts;
}
/**
 * Shard of every item of one group (retry-1 evaluation deviation dated 2026-10-18T17:43Z, evaluation-deviations.md). All O/X items of
 * one text go to one shard, so the frozen `sameAs` rule (twins must be items of the same text in the same packet) can apply: texts in
 * descending O/X count each go to the least-loaded shard. Every other item then goes, in sha256(id) order, to the least-loaded shard
 * (lowest index on ties). Depends only on item ids and labels, never on outcomes.
 */
export function shardItems(items: readonly { id: string; label: string }[], count: number): number[] {
  const load = Array.from({ length: Math.max(1, count) }, () => 0), out = items.map(() => 0);
  const least = () => load.indexOf(Math.min(...load));
  const coLocated = (item: { id: string }) => item.id[0] === "O" || item.id[0] === "X";
  const byText = new Map<string, number[]>();
  items.forEach((item, index) => { if (coLocated(item)) byText.set(item.label, [...(byText.get(item.label) ?? []), index]); });
  for (const [, indices] of [...byText.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) { const shard = least(); for (const i of indices) out[i] = shard; load[shard]! += indices.length; }
  const rest = items.map((item, index) => ({ item, index })).filter(({ item }) => !coLocated(item)).sort((a, b) => sha(a.item.id).localeCompare(sha(b.item.id)));
  for (const { index } of rest) { const shard = least(); out[index] = shard; load[shard]!++; }
  return out;
}
export async function adjudicationPackets(): Promise<any[]> {
  const baseDir = join(ROOT, "round2-packets");
  if (existsSync(join(baseDir, "index.json"))) throw new Error("round2 packets already frozen");
  const groups: any[] = [], skipped: any[] = [];
  // Retry 1 deviation (evaluation-deviations.md): only complete pairs have a verdict to adjudicate. A pair needs both final texts
  // and the baseline judged validly by both judges; baseline novelty disputes go with the unit's first complete pair.
  for (const unit of UNITS) {
    const ctx = context(unit), judged = (label: string) => ctx.all[label]!.every(j => j?.valid);
    if (!judged("baseline")) { skipped.push({ unit, reason: "baseline judgments incomplete" }); continue; }
    let baselineAttached = false;
    for (const rep of [1, 2]) {
      const labels = [`T-r${rep}`, `Q-r${rep}`];
      if (!labels.every(judged)) { skipped.push({ unit, rep, reason: "incomplete pair (missing final text or judgments)" }); continue; }
      const items = labels.flatMap(label => textItems(ctx, label)), withBaseline = !baselineAttached;
      if (withBaseline) for (const c of ctx.claims) if (ctx.get("baseline", c.ref).disagreement) items.push({ id: `R:baseline:${c.ref}`, kind: "realization", label: "baseline", statement: c.ref, reference: ctx.refs.get(c.ref), judges: ctx.entries("baseline", c.ref), reasons: ["baseline novelty disagreement"] });
      baselineAttached = true;
      groups.push({ unit, group: `${unit}-r${rep}`, labels: [...labels, ...(withBaseline ? ["baseline"] : [])], items });
    }
  }
  // At most eight workers in the one remaining host round; each shard of a group still sees the group's complete texts.
  const parts = allocatePackets(groups.map(g => g.items.length)), shards = groups.map((g, gi) => shardItems(g.items, parts[gi]!));
  const out: any[] = [];
  await mkdir(join(ROOT, "round2-keys"), { recursive: true });
  for (const [gi, g] of groups.entries()) for (let part = 0; part < parts[gi]!; part++) {
    const count = parts[gi]!, name = count === 1 ? g.group : `${g.group}-p${part + 1}`, dir = join(baseDir, name), input = packet(g.unit);
    await mkdir(join(dir, "texts"), { recursive: true });
    const key = Object.fromEntries(g.labels.map((l: string) => [opaque(g.unit, l), l]));
    for (const label of g.labels) await writeFile(join(dir, "texts", `${opaque(g.unit, label)}.md`), numberLines(finalText(g.unit, label)));
    for (const file of ["task.md", "guide.md", "claims.json", ...DOCS.map(d => `${d}.md`), "evidence-index.json", ...DOCS.map(d => `${d}-evidence.jsonl`)]) await writeFile(join(dir, file), input[file]!);
    const chosen = g.items.filter((_: any, index: number) => shards[gi]![index] === part).sort((a: any, b: any) => sha(a.id).localeCompare(sha(b.id))).map((i: any) => { const { reasons, sample, label, ...rest } = i; return { ...rest, id: i.id.replace(`:${label}:`, `:${opaque(g.unit, label)}:`), text: opaque(g.unit, label) }; });
    const data = { group: name, texts: Object.keys(key), items: chosen };
    await write(join(dir, "items.json"), data);
    await write(join(ROOT, "round2-keys", `${name}.json`), { unit: g.unit, key, itemsSha256: sha(text(join(dir, "items.json"))), selection: g.items.map((i: any, index: number) => ({ id: i.id, sample: !!i.sample, reasons: i.reasons, shard: shards[gi]![index] })) });
    out.push({ group: name, unit: g.unit, items: chosen.length, hashes: treeHashes(dir) });
  }
  await write(join(baseDir, "index.json"), out); await write(join(ROOT, "round2-skipped.json"), skipped); console.log(out.map(g => `${g.group}: ${g.items}`).join("\n")); return out;
}
export function validateAdjudication(items: any[], raw: any, texts: Record<string, string>): { accepted: Record<string, any>; errors: string[]; missing: string[] } {
  const accepted: Record<string, any> = {}, errors: string[] = [], seen = new Set<string>(), wanted = new Map(items.map(i => [i.id, i]));
  if (!Array.isArray(raw?.items)) return { accepted, errors: ["no items"], missing: [...wanted.keys()] };
  for (const e of raw.items) {
    if (!wanted.has(e.id) || seen.has(e.id)) { errors.push(`unknown/duplicate ${e.id}`); delete accepted[e.id]; continue; } seen.add(e.id);
    const item: any = wanted.get(e.id), kind = item.id[0];
    let valid = true;
    if (kind === "R") valid = e.realization in rank && ["asserted", "hedged", "rejected", "absent", "mixed"].includes(e.stance) && ["none", "upgrade", "downgrade", "mixed"].includes(e.statusDrift);
    if (kind === "S") valid = ["justified", "unjustified", "unresolved"].includes(e.verdict);
    if (kind === "O") valid = ["supported", "refuted", "insufficient", "conflicting", "not_new"].includes(e.support) && (e.support === "not_new" || ["finding", "supporting", "requested_context", "out", "ambiguous"].includes(e.relevance));
    if (kind === "X") valid = ["confirmed", "not", "unresolved"].includes(e.verdict);
    // Optional, any kind with a k-id: the adjudicator believes the frozen reference label is wrong. Kept as a second reading only.
    if (e.referenceDispute !== undefined) { const d = e.referenceDispute; if (!d || typeof d !== "object" || d.support !== undefined && !SUPPORT.includes(d.support) || d.relevance !== undefined && !RELEVANCE.includes(d.relevance) || d.support === undefined && d.relevance === undefined || !String(d.basis ?? "").trim()) { errors.push(`${e.id}: invalid referenceDispute`); valid = false; } }
    if (e.sameAs) { const twin: any = wanted.get(e.sameAs); if (kind !== "O" && kind !== "X" || !twin || twin.text !== item.text || String(e.sameAs)[0] !== kind || e.sameAs === e.id) { errors.push(`${e.id}: invalid sameAs`); valid = false; } }
    if (kind === "R" && e.realization !== "missing" && !spanFound(e.quote, texts[item.text] ?? "", 3)) { errors.push(`${e.id}: quote missing`); valid = false; }
    if (kind === "R" && e.stance === "mixed" && !spanFound(e.counterQuote, texts[item.text] ?? "", 3)) { errors.push(`${e.id}: mixed counterQuote missing`); valid = false; }
    if (!valid) errors.push(`${e.id}: invalid entry`); else accepted[e.id] = e;
  }
  return { accepted, errors, missing: [...wanted.keys()].filter(id => !(id in accepted)) };
}
export async function ingest(group: string, file: string): Promise<any> {
  const dir = join(ROOT, "round2-packets", group), k = json(join(ROOT, "round2-keys", `${group}.json`)), items = json(join(dir, "items.json")).items;
  if (sha(text(join(dir, "items.json"))) !== k.itemsSha256) throw new Error("packet hash mismatch");
  const raw = json(file), bodies = Object.fromEntries(Object.keys(k.key).map(t => [t, text(join(dir, "texts", `${t}.md`)).replace(/^L\d+: /gm, "")]));
  const result = validateAdjudication(items, raw, bodies), dest = join(ROOT, k.unit, "adjudication");
  if (existsSync(join(dest, `raw-${group}.json`))) throw new Error("raw adjudication already present; never replace");
  await mkdir(dest, { recursive: true }); await writeFile(join(dest, `raw-${group}.json`), text(file));
  const mapId = (id: string) => id.replace(/:(t-[a-f0-9]+):/, (_: string, t: string) => `:${k.key[t]}:`);
  await write(join(dest, `accepted-${group}.json`), { rawSha256: sha(text(file)), itemsSha256: k.itemsSha256, check: { errors: result.errors, missing: result.missing }, items: Object.fromEntries(Object.entries(result.accepted).map(([id, e]: [string, any]) => [mapId(id), { ...e, id: mapId(id), ...(e.sameAs ? { sameAs: mapId(e.sameAs) } : {}) }])) });
  console.log(group, "accepted", Object.keys(result.accepted).length, "missing", result.missing.length, "errors", result.errors.length); return result;
}
/**
 * Citation fidelity of one quote against a text body (line prefixes removed): byte-exact, exact after collapsing whitespace, or only
 * word-normalized (the ingestion criterion `spanFound`, which ignores case and punctuation). `lines` (1-based), when supplied, must
 * hold the quote within the listed lines or their direct neighbours.
 */
export function quoteFidelity(quote: unknown, body: string, lines?: unknown): { level: "exact" | "whitespace" | "normalized" | "absent"; lines?: boolean } {
  if (typeof quote !== "string" || !quote.trim()) return { level: "absent" };
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const level = body.includes(quote) ? "exact" : squash(body).includes(squash(quote)) ? "whitespace" : spanFound(quote, body, 3) ? "normalized" : "absent";
  if (!Array.isArray(lines) || !lines.length || !lines.every(n => Number.isInteger(n) && n > 0)) return { level };
  const all = body.split("\n"), near = [...new Set((lines as number[]).flatMap(n => [n - 1, n, n + 1]))].filter(n => n >= 1 && n <= all.length).sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const n of near) { const last = runs.at(-1); if (last && n === last.at(-1)! + 1) last.push(n); else runs.push([n]); }
  return { level, lines: runs.some(run => spanFound(quote, run.map(n => all[n - 1]).join("\n"), 3)) };
}
/** Round-2 coverage, verdict distribution, reference disputes and citation fidelity from the frozen packets and raw/accepted files. */
export function round2Report(meta: any): any {
  const groups: any[] = [], disputes: any[] = [];
  for (const p of json(join(ROOT, "round2-packets", "index.json"))) {
    const dir = join(ROOT, "round2-packets", p.group), k = json(join(ROOT, "round2-keys", `${p.group}.json`)), items = json(join(dir, "items.json")).items;
    const rawFile = join(ROOT, k.unit, "adjudication", `raw-${p.group}.json`), acceptedFile = join(ROOT, k.unit, "adjudication", `accepted-${p.group}.json`);
    if (!existsSync(rawFile) || !existsSync(acceptedFile)) { groups.push({ group: p.group, unit: k.unit, planned: items.length, ingested: false }); continue; }
    const raw = json(rawFile), accepted = json(acceptedFile), byId = new Map(items.map((i: any) => [i.id, i]));
    const bodies = Object.fromEntries(Object.keys(k.key).map(t => [t, text(join(dir, "texts", `${t}.md`)).replace(/^L\d+: /gm, "")]));
    const perKind: any = {}, fidelity: any = { quotes: {}, counterQuotes: {}, lineChecked: 0, lineMatch: 0, lineMismatch: [] as string[] };
    for (const e of raw.items ?? []) {
      const kind = String(e.id).charAt(0), item: any = byId.get(e.id), slot = perKind[kind] ??= { entries: 0, accepted: 0, values: {} };
      slot.entries++; if (accepted.items[e.id.replace(/:(t-[a-f0-9]+):/, (_: string, t: string) => `:${k.key[t]}:`)]) slot.accepted++;
      const value = kind === "R" ? `${e.realization}/${e.stance}/${e.statusDrift}` : kind === "O" ? `${e.support}${e.relevance ? `/${e.relevance}` : ""}${e.asserted === false ? "/hedged" : ""}` : e.verdict;
      slot.values[value] = (slot.values[value] ?? 0) + 1;
      if (e.referenceDispute) disputes.push({ group: p.group, id: e.id, label: k.key[item?.text], statement: item?.statement, frozen: { support: item?.reference?.support, relevance: item?.reference?.relevance }, dispute: e.referenceDispute });
      if (kind !== "R" || !item) continue;
      const body = bodies[item.text] ?? "";
      const q = quoteFidelity(e.quote, body, e.lines), level = q.level === "absent" && e.realization === "missing" && !String(e.quote ?? "").trim() ? "notRequired (missing)" : q.level;
      fidelity.quotes[level] = (fidelity.quotes[level] ?? 0) + 1;
      if (q.lines !== undefined) { fidelity.lineChecked++; if (q.lines) fidelity.lineMatch++; else fidelity.lineMismatch.push(e.id); }
      if (e.counterQuote !== undefined) { const c = quoteFidelity(e.counterQuote, body); fidelity.counterQuotes[c.level] = (fidelity.counterQuotes[c.level] ?? 0) + 1; }
    }
    const unresolved = Object.values(accepted.items).filter((a: any) => a.verdict === "unresolved").length;
    groups.push({ group: p.group, unit: k.unit, planned: items.length, entries: (raw.items ?? []).length, accepted: Object.keys(accepted.items).length, missing: accepted.check.missing.length, errors: accepted.check.errors, unresolvedVerdicts: unresolved, rawSha256: sha(text(rawFile)), acceptedRawSha256Matches: accepted.rawSha256 === sha(text(rawFile)), itemsSha256Matches: accepted.itemsSha256 === k.itemsSha256 && k.itemsSha256 === sha(text(join(dir, "items.json"))), perKind, fidelity });
  }
  const total = (f: (g: any) => number) => groups.reduce((s, g) => s + (f(g) ?? 0), 0);
  return { at: new Date().toISOString(), ...meta, coverage: { planned: total(g => g.planned), accepted: total(g => g.accepted), missing: total(g => g.missing), unresolvedVerdicts: total(g => g.unresolvedVerdicts), invalidEntries: total(g => g.errors?.length ?? 0) }, referenceDisputes: disputes, groups };
}
/** Planned round-2 items without a valid accepted entry, or whose accepted entry is itself "unresolved" (never counted as adjudicated). */
export const unresolvedItems = (planned: { id: string }[], adj: Adjudication) => planned.filter(i => !adj[i.id] || adj[i.id].verdict === "unresolved");
export const GATES = ["L", "A", "F", "O", "U", "H", "D", "X"] as const;
export type Intervals = Record<(typeof GATES)[number], [number, number]>;
/**
 * Admissible gate intervals of one text when its `unresolved` planned round-2 items (ids with real labels) could take ANY valid
 * adjudication (protocol: unresolved adjudication that can change the classification gives bounds, never assumed success). An R item
 * may move by one every gate its frozen reference makes applicable; an O item may add F, O and U; an X item may add X; an unresolved
 * baseline R item may move this text's A. Point values are the primary metrics `m`, which never count unadjudicated O/X items.
 */
export function gateIntervals(ctx: Context, label: string, m: any, unresolved: string[]): Intervals {
  const iv: any = Object.fromEntries(GATES.map(g => [g, [m[g], m[g]]]));
  const widen = (gate: string, counted: boolean) => { if (counted) iv[gate][0]--; else iv[gate][1]++; };
  const byRef = new Map(ctx.claims.map(c => [c.ref, c]));
  for (const id of unresolved) {
    const [kind, owner, k] = id.split(":");
    if (kind === "O" && owner === label) { iv.F[1]++; iv.O[1]++; iv.U[1]++; continue; }
    if (kind === "X" && owner === label) { iv.X[1]++; continue; }
    const c = byRef.get(k!), r = ctx.refs.get(k!);
    if (kind !== "R" || !c || !r) continue;
    const valid = r.support === "supported" && relevant(r), base = c.source === ctx.base, weak = ["insufficient", "conflicting"].includes(r.support);
    if (owner === "baseline") { if (valid && !base) widen("A", m.ids.addition.includes(k)); continue; }
    if (owner !== label) continue;
    if (valid && base) widen("L", m.ids.loss.includes(k));
    if (valid && !base) widen("A", m.ids.addition.includes(k));
    if (r.support === "refuted") widen("F", m.ids.F.includes(k));
    if (r.relevance === "out") widen("O", m.ids.O.includes(k));
    if (weak) widen("U", m.ids.U.includes(k));
    if (valid && c.stance !== "uncertain") widen("H", m.ids.H.includes(k));
    if (valid || weak) widen("D", m.ids.D.includes(k));
  }
  return iv;
}
/** Every pair verdict reachable when each gate of Q and T takes any value of its interval (gates varied independently: a superset). */
export function admissibleVerdicts(q: Intervals, t: Intervals): string[] {
  const rel = (a: [number, number], b: [number, number]) => [...(a[0] < b[1] ? ["<"] : []), ...(Math.max(a[0], b[0]) <= Math.min(a[1], b[1]) ? ["="] : []), ...(a[1] > b[0] ? [">"] : [])];
  const options = GATES.map(g => rel(q[g], t[g]));
  const fo = rel([q.F[0] + q.O[0], q.F[1] + q.O[1]], [t.F[0] + t.O[0], t.F[1] + t.O[1]]);
  const out = new Set<string>();
  const walk = (i: number, picked: string[]) => {
    if (i < GATES.length) { for (const r of options[i]!) walk(i + 1, [...picked, r]); return; }
    const f = picked[GATES.indexOf("F")], o = picked[GATES.indexOf("O")];
    const worse = picked.some((r, g) => GATES[g] === "A" ? r === "<" : r === ">"), better = picked.some((r, g) => GATES[g] === "A" ? r === ">" : r === "<");
    for (const s of fo) {
      if (s === "<" && f !== "<" && o !== "<" || s === ">" && f !== ">" && o !== ">" || s === "=" && !(f === "=" && o === "=" || f === "<" && o === ">" || f === ">" && o === "<")) continue;
      out.add(!worse && s === "<" ? "improvement" : !worse && !better ? "tie" : !worse ? "secondary gain" : better ? "mixed" : "regression");
    }
  };
  walk(0, []);
  return [...out].sort();
}
/**
 * One Q-vs-T pair; missing final/baseline judgments make it incomplete (baseline realization defines novelty/additions). `unresolved`
 * stays fail-closed (any planned item without a decided entry); `admissibleVerdicts` says whether those items could change the class.
 */
export function pairRecord(unit: string, rep: number, q: any, t: any, baseline: any, missing: string[], sensitivityNames: string[], bounds?: { Q: Intervals; T: Intervals }): any {
  if (!q?.valid || !t?.valid || !baseline?.valid) return { unit, rep, Q: q, T: t, verdict: "incomplete", unresolved: true, reason: !baseline?.valid ? "baseline judgments missing or invalid: novelty/additions cannot be scored" : "no valid paired final documents and judges", missingAdjudications: missing, sensitivity: {} };
  const admissible = bounds ? admissibleVerdicts(bounds.Q, bounds.T) : undefined;
  return { unit, rep, Q: q, T: t, verdict: pairVerdict(q, t), unresolved: missing.length > 0, missingAdjudications: missing, ...(bounds ? { intervals: bounds, admissibleVerdicts: admissible, classificationStable: admissible!.length === 1 } : {}), sensitivity: Object.fromEntries(sensitivityNames.map(v => [v, pairVerdict(q.variants[v], t.variants[v])])) };
}
/** Study conclusions; protocol: "Any conclusion-changing scope/support/reference interpretation forces inconclusive." */
export function conclusion(pairs: any[], replicated: boolean): any {
  const conditionalRaw = studyVerdict(pairs, true);
  const variantNames = [...new Set(pairs.flatMap(p => Object.keys(p.sensitivity ?? {})))];
  const underVariant = Object.fromEntries(variantNames.map(v => [v, studyVerdict(pairs.map(p => p.sensitivity?.[v] ? { ...p, verdict: p.sensitivity[v] } : p), true).verdict]));
  const changing = Object.entries(underVariant).filter(([, verdict]) => verdict !== conditionalRaw.verdict).map(([v]) => v);
  const conditionalStudy = changing.length ? { verdict: "inconclusive", reason: `conclusion changes under: ${changing.join(", ")} (rule alone: ${conditionalRaw.verdict})` } : conditionalRaw;
  return { study: studyVerdict(pairs, replicated), conditionalStudy, conditionalRaw, underVariant, conclusionChangingReadings: changing };
}
/** The frozen references with round-2 reference disputes applied (entries carrying referenceDispute: {support?, relevance?}). */
export function disputedReferences(ctx: Context): Map<string, any> {
  const out = new Map([...ctx.refs.entries()].map(([id, r]) => [id, { ...r }]));
  const seen = new Map<string, string>();
  for (const [id, entry] of Object.entries(ctx.adj)) {
    const dispute = (entry as any).referenceDispute, k = /:(k\d+)$/.exec(id)?.[1];
    if (!dispute || !k || !out.has(k)) continue;
    const reading = JSON.stringify({ support: dispute.support, relevance: dispute.relevance });
    const r = out.get(k)!;
    if (seen.has(k) && seen.get(k) !== reading) { r.support = "conflicting"; continue; }
    seen.set(k, reading);
    if (dispute.support) r.support = dispute.support;
    if (dispute.relevance) r.relevance = dispute.relevance;
  }
  return out;
}
export function score(): any {
  const pairs: any[] = [], units: any[] = [];
  const variants: Record<string, any> = { primary: {}, higherCoverageLowerAssertions: { optimistic: true }, ambiguousIncluded: { ambiguous: true }, findingsAndSupportOnly: { contextIncluded: false }, partialLossHalf: { partialLoss: true }, partialAdditions: { partialAddition: true }, equivalentDedup: { dedup: true } };
  for (const unit of UNITS) {
    const ctx = context(unit), texts: any = {};
    // Second reading: the frozen reference with every round-2 reference dispute applied (never a rewrite of the frozen file).
    const ctx2 = { ...ctx, refs: disputedReferences(ctx) };
    for (const label of LABELS) {
      const valid = ctx.all[label]!.every(j => j?.valid);
      if (!valid) { texts[label] = { valid: false, metrics: null, reason: "missing/invalid independent final-text judgments; no quality counts imputed" }; continue; }
      const metricsByVariant = Object.fromEntries(Object.entries(variants).map(([name, opts]) => [name, metrics(ctx, label, opts)]));
      metricsByVariant.round2ReferenceReading = metrics(ctx2 as Context, label);
      texts[label] = { valid, ...metricsByVariant.primary, variants: metricsByVariant, adjudicated: Object.keys(ctx.adj).filter(id => id.includes(`:${label}:`)).length };
    }
    for (const rep of [1, 2]) {
      const q = texts[`Q-r${rep}`], t = texts[`T-r${rep}`];
      if (!q.valid || !t.valid || !texts.baseline.valid) { pairs.push(pairRecord(unit, rep, q, t, texts.baseline, [], [])); continue; }
      const keysDir = join(ROOT, "round2-keys");
      const plannedIn = (prefix: string) => readdirSync(keysDir).filter(n => n.startsWith(prefix) && n.endsWith(".json")).flatMap(n => {
        const k = json(join(keysDir, n)), g = n.slice(0, -5);
        return json(join(ROOT, "round2-packets", g, "items.json")).items.map((i: any) => ({ id: i.id.replace(/:(t-[a-f0-9]+):/, (_: string, id: string) => `:${k.key[id]}:`) }));
      });
      // Baseline items change additions (A) of BOTH repetitions of a unit, whichever group carried them.
      const planned = existsSync(keysDir) ? [...new Map([...plannedIn(`${unit}-r${rep}`), ...plannedIn(`${unit}-r`).filter(i => i.id.startsWith("R:baseline:"))].map(i => [i.id, i])).values()] : textItems(ctx, `Q-r${rep}`).concat(textItems(ctx, `T-r${rep}`));
      const sensitivityNames = [...Object.keys(variants).slice(1), "round2ReferenceReading"];
      const open = unresolvedItems(planned, ctx.adj).map((i: any) => i.id);
      pairs.push(pairRecord(unit, rep, q, t, texts.baseline, open, sensitivityNames, { Q: gateIntervals(ctx, `Q-r${rep}`, q, open), T: gateIntervals(ctx, `T-r${rep}`, t, open) }));
    }
    units.push({ unit, claims: ctx.claims.length, referenceCounts: Object.fromEntries(["support", "relevance"].map(k => [k, [...ctx.refs.values()].reduce((a, e) => { a[e[k]] = (a[e[k]] ?? 0) + 1; return a; }, {})])), texts });
  }
  const frozenRefs = json(join(ROOT, "references-frozen.json")), replicated = frozenRefs.completeReplication;
  const referenceReadings = {
    primary: "labeller b, the sole frozen reference per unit: every score below is conditional on it",
    labellerA: replicated ? { available: true } : { available: false, reason: "replicas a wrote 0 label rows (references-frozen.json); the fixed 'labeller a' sensitivity cannot be computed and is not imputed" },
    round2ReferenceReading: "frozen b with every round-2 referenceDispute applied as a second reading (the frozen file is never rewritten)",
  };
  return { at: new Date().toISOString(), ...conclusion(pairs, replicated), referenceReplication: replicated, referenceReadings, units, pairs };
}
/**
 * Every manifest check, run independently. `checkManifest()` stops at its first mismatch, which hid the frozen-file, input and
 * reference checks behind the documented guard change. A source mismatch equal to the hash a dated addendum names is labelled as that
 * documented deviation but stays an error: expected hashes are never rebaselined.
 */
export function manifestChecks(): { errors: string[]; documented: string[]; passed: string[] } {
  const m = json(join(ROOT, "manifest.json")), errors: string[] = [], documented: string[] = [], passed: string[] = [];
  const check = (name: string, ok: () => boolean) => { try { if (ok()) passed.push(name); else errors.push(`${name} changed`); } catch (e) { errors.push(`${name}: ${String(e)}`); } };
  const now = sourceHashes(), addendum2File = join(ROOT, "retry-protocol-addendum-2.md");
  const addendum2 = existsSync(addendum2File) ? /sha256 `([0-9a-f]{64})`/.exec(text(addendum2File))?.[1] : undefined;
  for (const name of [...new Set([...Object.keys(m.sources), ...Object.keys(now)])]) {
    if (m.sources[name] === now[name]) { passed.push(`source ${name}`); continue; }
    const line = `runtime/helper source ${name} changed after manifest (manifest ${String(m.sources[name]).slice(0, 12)}, now ${String(now[name]).slice(0, 12)})`;
    if (name === "qualification-guard.mjs" && addendum2 && now[name] === addendum2) { errors.push(`${line}: documented deviation retry-protocol-addendum-2.md`); documented.push(line); } else errors.push(line);
  }
  const frozenFiles = { "protocol.md": m.protocol, "retry-protocol.md": m.retryProtocol, "retry-protocol-addendum-1.md": m.addendum1Sha256, "inputs-frozen.json": m.inputs, "references-frozen.json": m.referencesSha256, "round2-instructions.md": m.round2InstructionsSha256, "preflight.json": m.preflightSha256, "route-diagnosis.json": m.routeDiagnosisSha256, "first-attempt-reassessment.json": m.firstAttemptReassessmentSha256 };
  for (const [file, hash] of Object.entries(frozenFiles)) check(`frozen ${file}`, () => sha(text(join(ROOT, file))) === hash);
  check("first-attempt manifest.json", () => sha(text(join(REPO, m.firstAttempt.root, "manifest.json"))) === m.firstAttempt.manifestSha256);
  check("first-attempt technical-stop.json", () => sha(text(join(REPO, m.firstAttempt.root, "technical-stop.json"))) === m.firstAttempt.technicalStopSha256);
  const frozen = json(join(ROOT, "inputs-frozen.json"));
  for (const unit of UNITS) for (const [file, hash] of Object.entries(frozen.units[unit].files)) check(`input ${unit}/${file}`, () => sha(text(join(ROOT, "inputs", unit, file))) === hash);
  for (const unit of UNITS) for (const who of ["a", "b"]) { const ref = m.references.references[unit][who]; if (!ref.missing) check(`reference ${unit}-${who}`, () => sha(text(join(ROOT, "references", `${unit}-${who}.json`))) === ref.sha256); }
  for (const [name, body] of Object.entries(prompts)) check(`prompt ${name}`, () => sha(body) === m.prompts[name]);
  check("runtime node_modules/@earendil-works/pi-ai", () => JSON.stringify(treeHashes(join(REPO, "node_modules/@earendil-works/pi-ai"))) === JSON.stringify(m.runtimeNodeModules));
  check("Pi CLI", () => sha(readFileSync(PI_CLI)) === m.piCliSha256);
  check("live configuration orche.config.json", () => sha(readFileSync(join(AGENT, "orche.config.json"))) === m.liveConfig);
  if (sha(readFileSync(join(REPO, "experiments/mdsd-ab/qualification-eval.ts"))) !== m.evaluationSha256) documented.push("evaluation module qualification-eval.ts changed after manifest: dated in evaluation-deviations.md (scoring support; protocol.md allows dated evaluation changes, measured runtime unaffected)");
  return { errors, documented, passed };
}
/** Model identity of every retained measured and judge turn: raw routes kept, only bts/gpt-6-astra normalized (canonicalModel). */
export function identitySummary(): any {
  const turns = [...UNITS.flatMap(u => [1, 2].flatMap(r => ["T", "Q"].flatMap(a => { const f = join(ROOT, u, `${a}-r${r}`, "pipeline.json"); return existsSync(f) ? json(f).stages.map((s: any) => ({ phase: "measured", ...s.result })) : []; }))), ...UNITS.flatMap(u => readdirSync(join(ROOT, u, "judgments")).filter(n => n.endsWith(".json")).flatMap(n => (json(join(ROOT, u, "judgments", n)).turns ?? []).map((t: any) => ({ phase: "judge", ...t }))))];
  const raw = new Set<string>(), canonical = new Set<string>(), thinking = new Set<string>();
  let alias = 0, withIdentity = 0;
  for (const t of turns) {
    if (t.identity) { withIdentity++; if (t.identity.aliasUsed) alias++; for (const r of [...(t.identity.routes?.wire ?? []), ...(t.identity.routes?.response ?? []), ...(t.identity.routes?.transcript ?? [])]) { raw.add(r); canonical.add(canonicalModel(r)); } }
    if (t.thinking) thinking.add(t.thinking);
  }
  return { turns: turns.length, withIdentity, aliasTurns: alias, rawRoutes: [...raw].sort(), canonicalRoutes: [...canonical].sort(), thinking: [...thinking].sort(), rule: "only bts/gpt-6-astra -> gpt-6-astra is normalized (user clarification M17, addendum 1); raw routes stay in every record" };
}
export function verify(study: string): any {
  const manifestResult = manifestChecks(), errors: string[] = [...manifestResult.errors], notReverifiable: string[] = [];
  const old = json(join(ROOT, "prior-hashes.json"));
  for (const [name, hashes] of Object.entries(old)) {
    const now = treeHashes(join(REPO, "results", name));
    for (const f of new Set([...Object.keys(hashes as any), ...Object.keys(now)])) if ((hashes as any)[f] !== now[f]) errors.push(`old ${name}/${f} changed`);
  }
  const manifest = json(join(ROOT, "manifest.json"));
  if (!existsSync(study)) notReverifiable.push(`pinned catalogue, provider and runtime snapshots: scratch study ${study} no longer exists (removed when its worker retired); they were last verified in interim-tier1/verification.json`);
  else {
    try { setStudy(study); checkPins(); } catch (e) { errors.push(String(e)); }
    for (const sub of ["provider", "runtime"]) if (JSON.stringify(treeHashes(join(study, sub))) !== JSON.stringify(manifest[sub])) errors.push(`${sub} snapshot changed`);
  }
  const preservationErrors = [...errors];
  let pipelines = 0, validPipelines = 0, judges = 0, validJudges = 0, frozenOutputs = 0, retainedTurns = 0, retainedPrompts = 0, frozenInputsUsed = 0, retainedMissing = 0;
  const frozenInputs = json(join(ROOT, "inputs-frozen.json")).units;
  for (const u of UNITS) {
    for (const r of [1, 2]) for (const a of ["T", "Q"]) {
      const d = join(ROOT, u, `${a}-r${r}`), file = join(d, "pipeline.json"); if (!existsSync(file)) { errors.push(`missing pipeline ${u}/${a}${r}`); continue; }
      pipelines++; const p = json(file); if (p.valid) validPipelines++; else errors.push(`incomplete pipeline ${u}/${a}${r}: ${p.error}`);
      for (const s of p.stages) { if (!s.result.routeOk || !s.result.target.unchanged) errors.push(`route/target ${p.id}/${s.stage}`); }
      for (const sub of ["prepared", "draft", "final"]) { const f = join(d, sub, "frozen.json"); if (!existsSync(f)) continue; for (const [name, hash] of Object.entries(json(f).files)) { frozenOutputs++; if (sha(text(join(d, sub, name))) !== hash) errors.push(`changed frozen ${d}/${sub}/${name}`); } }
      // Retained turn copies (<arm>/sessions/<session>/turn-N): recorded prompt and output hashes must match the retained files, and every
      // input that is a frozen unit input must carry the frozen hash.
      for (const s of p.stages) {
        const dir = join(d, "sessions", ...String(s.result.dir).split("/").slice(-2));
        if (existsSync(join(dir, "prompt.md"))) { retainedPrompts++; if (sha(readFileSync(join(dir, "prompt.md"))) !== s.result.promptSha256) errors.push(`retained prompt changed ${dir}`); } else retainedMissing++;
        for (const [name, hash] of Object.entries(s.result.outputHashes ?? {})) { const f = join(dir, "outputs", name); if (!existsSync(f)) { retainedMissing++; continue; } retainedTurns++; if (sha(readFileSync(f)) !== hash) errors.push(`retained output changed ${dir}/${name}`); }
        for (const [name, hash] of Object.entries(s.result.inputHashes ?? {})) { const want = frozenInputs[u]?.files?.[name]; if (want === undefined) continue; frozenInputsUsed++; if (want !== hash) errors.push(`turn ${dir} used a non-frozen ${name}`); }
      }
    }
    for (const label of LABELS) for (const [i, j] of judgments(u, label).entries()) {
      if (!j) { errors.push(`missing judge ${u}/${label}/${i}`); continue; }
      judges++; const body = finalText(u, label); const errs = checkJudge(claimsOf(u).map(c => c.ref), j.judgment, body);
      if (j.valid && !errs.length && j.textSha256 === sha(body)) validJudges++; else errors.push(`invalid judge ${u}/${label}/${i}`);
    }
  }
  const failedJudgeRecords = UNITS.flatMap(u => readdirSync(join(ROOT, u, "judgments")).filter(n => /\.failed-\d{8}T\d{4}Z\.json$/.test(n)).map(n => `${u}/${n}`));
  const round2: any = { checked: false };
  if (existsSync(join(ROOT, "round2-freeze.json"))) {
    const freeze = json(join(ROOT, "round2-freeze.json"));
    round2.checked = true; round2.packets = freeze.packets.length;
    for (const p of freeze.packets) {
      if (sha(text(join(ROOT, "round2-packets", p.group, "items.json"))) !== p.itemsSha256) errors.push(`round-2 packet ${p.group} items changed`);
      if (sha(text(join(ROOT, "round2-keys", `${p.group}.json`))) !== p.keySha256) errors.push(`round-2 key ${p.group} changed`);
      const acc = join(ROOT, p.unit, "adjudication", `accepted-${p.group}.json`), raw = join(ROOT, p.unit, "adjudication", `raw-${p.group}.json`);
      if (!existsSync(acc) || !existsSync(raw)) { errors.push(`round-2 ${p.group} not ingested`); continue; }
      if (json(acc).rawSha256 !== sha(text(raw))) errors.push(`round-2 raw ${p.group} changed after ingestion`);
    }
    if (existsSync(join(ROOT, "round2-workers.json"))) for (const w of json(join(ROOT, "round2-workers.json")).workers) if (!existsSync(join(ROOT, w.rawReport)) || sha(readFileSync(join(ROOT, w.rawReport))) !== w.rawReportSha256) errors.push(`round-2 raw report ${w.rawReport} changed`);
  }
  return { at: new Date().toISOString(), pipelines, validPipelines, judges, validJudges, frozenOutputsChecked: frozenOutputs, retainedTurnOutputsChecked: retainedTurns, retainedPromptsChecked: retainedPrompts, retainedFilesAbsent: retainedMissing, frozenInputHashesChecked: frozenInputsUsed, failedJudgeRecordsPreserved: failedJudgeRecords, round2, identity: identitySummary(), manifestChecksPassed: manifestResult.passed.length, documentedDeviations: manifestResult.documented, notReverifiable, preservation: { passed: preservationErrors.length === 0, errors: preservationErrors }, previousFiles: Object.fromEntries(Object.entries(old).map(([n, h]) => [n, Object.keys(h as any).length])), errors };
}
export async function closeInterrupted(study: string): Promise<void> {
  if (!existsSync(join(ROOT, "technical-stop.json"))) throw new Error("explicit technical-stop record required");
  const stop = json(join(ROOT, "technical-stop.json"));
  let alive = false; try { process.kill(stop.pid, 0); alive = true; } catch {}
  if (alive) throw new Error("runner still alive; do not snapshot active work");
  for (const unit of UNITS) for (const rep of [1, 2]) for (const arm of ["T", "Q"]) {
    const dest = join(ROOT, unit, `${arm}-r${rep}`), source = join(study, "runs", unit, `${arm}-r${rep}`);
    if (existsSync(join(dest, "pipeline.json"))) continue;
    const stages: any[] = [];
    for (const session of ["compose", "audit", "recheck"]) {
      const dir = join(source, session); if (!existsSync(dir)) continue;
      await retainSession(dir, join(dest, "sessions", session));
      for (const name of readdirSync(dir).filter(n => /^turn-\d+$/.test(n))) {
        const td = join(dir, name); if (!existsSync(join(td, "meta.json"))) continue;
        const r = existsSync(join(td, "result.json")) ? json(join(td, "result.json")) : { ...json(join(td, "meta.json")), interrupted: true, routeOk: false, target: hashDiff(json(join(dir, "target-before.json")), contentHashes(join(dir, "target"))) };
        stages.push({ stage: `${session}/${name}`, result: r });
      }
      const work = join(dir, "private/work");
      if (existsSync(work)) await cp(work, join(dest, "partial-work", session), { recursive: true });
      const config = join(dir, "agent/cliproxyapi.json");
      const secret = existsSync(config) ? String(json(config).apiKey ?? "") : "";
      if (secret) await redact(join(dest, "sessions", session), [secret]);
    }
    await write(join(dest, "pipeline.json"), { id: `${unit}-${arm}-r${rep}`, unit, arm, rep, valid: false, error: "Interrupted by recorded technical stop after paired route validity became impossible; not a completed synthesis", stages, endedAt: stop.at, partialFiles: treeHashes(join(dest, "partial-work")) });
  }
  console.log("Interrupted records preserved; no attempts rerun");
}

/** End of an interrupted attempt: the `killed-<YYYYMMDD>T<HHMMSS>Z` stamp of a preserved killed session, else the recorded stop. */
export function interruptedEnd(dir: string, stop?: string): string | undefined {
  const m = /killed-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(dir);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : stop;
}
/** Phase of a scratch attempt directory; every `preflight`, `preflight-2`, ... run counts as preflight. */
export const phaseOf = (dir: string) => dir.includes("/runs/") ? "measured" : dir.includes("/judges/") ? "judges" : /\/preflight(-\d+)?\//.test(dir) ? "preflight" : "other";
export function accounting(study: string): any {
  if (!existsSync(study)) throw new Error(`scratch study ${study} is gone; use final-accounting (never overwrite accounting.json with an empty scan)`);
  const dirs = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => !e.isDirectory() || ["agent", "target", "private", "provider", "runtime", "outputs"].includes(e.name) ? [] : /^turn-\d+$/.test(e.name) ? [join(dir, e.name)] : dirs(join(dir, e.name))) : [];
  const stop = existsSync(join(ROOT, "technical-stop.json")) ? json(join(ROOT, "technical-stop.json")).at : undefined;
  const attempts = dirs(study).filter(d => existsSync(join(d, "meta.json"))).map(dir => {
    const m = json(join(dir, "meta.json")), complete = existsSync(join(dir, "result.json"));
    const result = complete ? json(join(dir, "result.json")) : {};
    const raw = readJsonl(join(dir, "wire.jsonl")).filter(e => e.method === "POST" && e.model);
    const envelope = existsSync(join(dir, "envelope.json")) ? json(join(dir, "envelope.json")) : {};
    const zeroPriceRoutes = [...new Set(raw.filter(e => !envelope.prices?.[e.model] || !envelope.prices[e.model].input && !envelope.prices[e.model].output).map(e => e.model))];
    const wire = complete ? result.wire : wireStats(raw);
    // An interrupted attempt ends at its preserved kill stamp or the recorded stop, never at "now" (that inflated every rerun).
    const end = result.endedAt ?? (m.startedAt ? interruptedEnd(dir, stop) : undefined);
    return { ...m, ...result, file: dir, dir, state: complete ? "completed" : m.startedAt ? "interrupted" : "queued", endedAt: end, endUnknown: !end && !!m.startedAt, ms: result.ms ?? (m.startedAt && end ? Date.parse(end) - Date.parse(m.startedAt) : 0), wire, unknownPricingRequests: raw.filter(e => zeroPriceRoutes.includes(e.model)).length, zeroPriceRoutes };
  });
  const totals = (xs: any[]) => ({ attempts: xs.length, interrupted: xs.filter(t => t.state === "interrupted").length, endUnknown: xs.filter(t => t.endUnknown).length, requests: xs.reduce((s, t) => s + (t.wire?.requests ?? 0), 0), recordedCostUSD: xs.reduce((s, t) => s + (t.wire?.costUSD ?? 0), 0), unknownPricingRequests: xs.reduce((s, t) => s + t.unknownPricingRequests, 0), eventCostUSD: xs.reduce((s, t) => s + (t.eventCostUSD ?? 0), 0), inputTokens: xs.reduce((s, t) => s + (t.wire?.input ?? 0), 0), outputTokens: xs.reduce((s, t) => s + (t.wire?.output ?? 0), 0), reasoningTokens: xs.reduce((s, t) => s + (t.wire?.reasoning ?? 0), 0), cachedTokens: xs.reduce((s, t) => s + (t.wire?.cached ?? 0), 0), unknownUsage: xs.reduce((s, t) => s + (t.wire?.unknownUsage ?? 0), 0), sessionMinutes: xs.reduce((s, t) => s + (t.ms ?? 0), 0) / 60000, elapsedMinutes: xs.some(t => t.endedAt) ? (Math.max(...xs.filter(t => t.endedAt).map(t => Date.parse(t.endedAt))) - Math.min(...xs.filter(t => t.startedAt).map(t => Date.parse(t.startedAt)))) / 60000 : 0 });
  return { at: new Date().toISOString(), rule: "every scratch physical turn once (including partial wire for interrupted attempts); results copies not counted; zero/absent configured price on alias routes is UNKNOWN, not free", measured: totals(attempts.filter(t => phaseOf(t.file) === "measured")), judges: totals(attempts.filter(t => phaseOf(t.file) === "judges")), preflight: totals(attempts.filter(t => phaseOf(t.file) === "preflight")), byArm: Object.fromEntries(["T", "Q"].map(a => [a, totals(attempts.filter(t => phaseOf(t.file) === "measured" && new RegExp(`/${a}-r[12]/`).test(t.file)))])), round1: json(join(ROOT, "reference-round1.json")), round2: existsSync(join(ROOT, "round2-report.json")) ? json(join(ROOT, "round2-report.json")) : null, unmetered: ["local tests/snapshots", "experimenter session", "host worker token counts", "alias routes with unknown configured price", "interrupted requests without final usage"], attempts: attempts.map(t => ({ dir: t.dir, label: t.label, number: t.number, state: t.state, model: t.model, ms: t.ms, cost: t.wire?.costUSD, requests: t.wire?.requests, ok: t.ok ?? false, unknownPricingRequests: t.unknownPricingRequests, zeroPriceRoutes: t.zeroPriceRoutes, routes: t.wire?.routes })) };
}
/** Usage recorded in a Pi session transcript (assistant messages), optionally within [from, to): requests, tokens, cost. */
export function sessionUsage(file: string, from?: string, to?: string): any {
  const out = { requests: 0, input: 0, output: 0, cacheRead: 0, costUSD: 0, first: undefined as string | undefined, last: undefined as string | undefined };
  for (const e of readJsonl(file)) {
    const m = e.message, at = e.timestamp;
    if (m?.role !== "assistant" || from && at < from || to && at >= to) continue;
    out.requests++; out.input += m.usage?.input ?? 0; out.output += m.usage?.output ?? 0; out.cacheRead += m.usage?.cacheRead ?? 0; out.costUSD += m.usage?.cost?.total ?? 0;
    out.first ??= at; out.last = at;
  }
  return out;
}
/**
 * Final cost/time record. The scratch study was removed when W7 retired, so `accounting <study>` can no longer rescan it. This uses the
 * per-attempt rows W7 computed from that scratch study (preserved byte-identically in interim-tier1/accounting.json) with the two
 * corrections (preflight-2 counted as preflight; killed judges end at their kill stamp, not at the time accounting ran), cross-checks
 * completed turns against the retained results copies, and adds round 2, the first attempt and recorded experimenter sessions. Every
 * physical attempt is counted once; the reference round 1 belongs to the first attempt only.
 */
export function finalAccounting(overhead: any = {}): any {
  const interim = json(join(ROOT, "interim-tier1", "accounting.json")), accountedAt = Date.parse(interim.at);
  const rows = interim.attempts.map((t: any) => {
    const end = t.state === "interrupted" ? interruptedEnd(t.dir) : undefined;
    // The interim ms of an interrupted row was (time of the interim run - start); the run is <= a few seconds before interim.at.
    return { ...t, phase: phaseOf(t.dir), ms: end ? t.ms - (accountedAt - Date.parse(end)) : t.ms, msInterim: t.ms, endedAt: end, msUncertaintySeconds: end ? "<= 5 (interim 'now' was taken shortly before interim.at)" : undefined };
  });
  const sum = (xs: any[], f: (t: any) => number) => xs.reduce((s, t) => s + (f(t) ?? 0), 0);
  const phase = (name: string, pred = (t: any) => t.phase === name) => { const xs = rows.filter(pred); return { attempts: xs.length, interrupted: xs.filter((t: any) => t.state === "interrupted").length, requests: sum(xs, t => t.requests), recordedCostUSD: sum(xs, t => t.cost), unknownPricingRequests: sum(xs, t => t.unknownPricingRequests), sessionMinutes: sum(xs, t => t.ms) / 60000 }; };
  const retained = (glob: RegExp, root = ROOT) => filesUnder(root, /result\.json$/).filter(f => glob.test(f)).map(f => json(f));
  const measuredCopies = retained(/\/[TQ]-r[12]\/sessions\/[^/]+\/turn-\d+\/result\.json$/), judgeCopies = retained(/\/judge-sessions\/[^/]+\/turn-\d+\/result\.json$/);
  const judgeTurns = UNITS.flatMap(u => readdirSync(join(ROOT, u, "judgments")).filter(n => n.endsWith(".json")).flatMap(n => json(join(ROOT, u, "judgments", n)).turns ?? []));
  const judgeStart = Math.min(...judgeTurns.map((t: any) => Date.parse(t.startedAt))), judgeEnd = Math.max(...judgeTurns.map((t: any) => Date.parse(t.endedAt)));
  const measured = { ...interim.measured, ...phase("measured") }, judges = { ...interim.judges, ...phase("judges"), elapsedMinutes: (judgeEnd - judgeStart) / 60000, firstStart: new Date(judgeStart).toISOString(), lastEnd: new Date(judgeEnd).toISOString() };
  const preflight = { ...phase("preflight"), runs: { "preflight (failed: zstd body not parsed)": phase("preflight", t => t.phase === "preflight" && /\/preflight\//.test(t.dir)), "preflight-2 (passed)": phase("preflight", t => /\/preflight-2\//.test(t.dir)) } };
  const r2 = existsSync(join(ROOT, "round2-report.json")) ? json(join(ROOT, "round2-report.json")) : undefined;
  const round2 = r2 ? { workers: r2.workers.length, requests: sum(r2.workers, (w: any) => w.requests), recordedCostUSD: sum(r2.workers, (w: any) => w.costUSD), wallSeconds: r2.spawn.reportedWallSeconds, sessionMinutes: sum(r2.workers, (w: any) => Date.parse(w.reportAt) - Date.parse(w.sessionStart)) / 60000, tokens: { input: sum(r2.workers, (w: any) => w.usage.input), output: sum(r2.workers, (w: any) => w.usage.output), cacheRead: sum(r2.workers, (w: any) => w.usage.cacheRead) }, source: "Pi session usage of the 8 verify workers (sum equals the orche_spawn total)" } : null;
  const first = json(join(REPO, "results/qualification-validation/accounting.json"));
  const firstAttempt = { measured: first.measured, preflight: first.preflight, round1: { requests: first.round1.requests, recordedCostUSD: first.round1.costUSD, wallSeconds: first.round1.wallSeconds, note: "reference labelling round 1 (6 workers); frozen references reused by the retry, counted once here" }, knownUSD: first.measured.recordedCostUSD + first.preflight.recordedCostUSD + first.round1.costUSD, unknown: { aliasRequestsWithUnknownPrice: first.measured.unknownPricingRequests, requestsWithoutFinalUsage: first.measured.unknownUsage, note: "bts/gpt-6-astra had a zero configured price; the user's model equivalence says nothing about its tariff, so its cost is unknown, not zero and not the gpt-6-astra price" } };
  const retryKnown = measured.recordedCostUSD + judges.recordedCostUSD + preflight.recordedCostUSD + (round2?.recordedCostUSD ?? 0);
  return {
    at: new Date().toISOString(),
    rule: "each physical attempt once; wire-recorded cost where known; unknown prices and missing usage stay unknown (never zero); reference round 1 counted only in the first attempt",
    sources: { interimAccounting: "interim-tier1/accounting.json", interimSha256: sha(text(join(ROOT, "interim-tier1", "accounting.json"))), interimComputedAt: interim.at, scratchStudy: "removed when W7 retired (not rescannable); its per-attempt rows survive in the interim file" },
    corrections: ["preflight now includes the passed preflight-2 run (the interim file counted only the failed first preflight)", "the 15 killed judge sessions end at their kill stamp 2026-10-18T16:04:31Z instead of the interim run time, reducing their summed session time; judge elapsed time now runs from the first judge start to the last recorded judge end"],
    crossCheck: { measuredRetainedCopies: { turns: measuredCopies.length, requests: sum(measuredCopies, r => r.wire?.requests), recordedCostUSD: sum(measuredCopies, r => r.wire?.costUSD) }, completedJudgeRetainedCopies: { turns: judgeCopies.length, requests: sum(judgeCopies, r => r.wire?.requests), recordedCostUSD: sum(judgeCopies, r => r.wire?.costUSD) }, killedJudgeRowsOnlyInInterim: phase("judges", t => t.phase === "judges" && t.state === "interrupted") },
    retry: { measured, byArm: interim.byArm, judges, preflight, round2, knownUSD: retryKnown },
    firstAttempt,
    knownTotalUSD: firstAttempt.knownUSD + retryKnown,
    experimenterOverhead: overhead,
    unknown: ["price of the 124 first-attempt bts/gpt-6-astra requests", "usage of requests without final usage (first attempt 14, retry measured 22, retry judges 6)", "local tests, snapshots and other unmetered tooling"],
    attempts: rows,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg, file] = process.argv.slice(2);
  if (cmd === "close-interrupted") { await closeInterrupted(arg!); process.exit(0); }
  if (cmd === "packets") await adjudicationPackets();
  else if (cmd === "ingest") await ingest(arg!, file!);
  else if (cmd === "score") { const s = score(); await write(join(ROOT, "scores.json"), s); console.log(s.study); for (const p of s.pairs) console.log(p.unit, p.rep, p.verdict, "unresolved", p.unresolved, "Q", [p.Q.L, p.Q.A, p.Q.F, p.Q.O, p.Q.U, p.Q.H, p.Q.D, p.Q.X], "T", [p.T.L, p.T.A, p.T.F, p.T.O, p.T.U, p.T.H, p.T.D, p.T.X]); }
  else if (cmd === "verify") { const v = verify(arg!); await write(join(ROOT, "verification.json"), v); console.log(JSON.stringify(v)); }
  else if (cmd === "accounting") { const a = accounting(arg!); await write(join(ROOT, "accounting.json"), a); console.log(JSON.stringify({ measured: a.measured, judges: a.judges, preflight: a.preflight, byArm: a.byArm })); }
  else if (cmd === "round2-report") { const r = round2Report(json(join(ROOT, "round2-workers.json"))); await write(join(ROOT, "round2-report.json"), r); console.log(JSON.stringify({ coverage: r.coverage, disputes: r.referenceDisputes.length, fidelity: r.groups.map((g: any) => [g.group, g.fidelity.quotes, g.fidelity.lineChecked, g.fidelity.lineMatch]) })); }
  else if (cmd === "final-accounting") {
    // Experimenter sessions recorded by Pi (outside the study's wire accounting): spec file lists {name, file, from?, to?}.
    const spec = existsSync(join(ROOT, "experimenter-sessions.json")) ? json(join(ROOT, "experimenter-sessions.json")) : { sessions: [] };
    const overhead = { note: spec.note, sessions: spec.sessions.map((s: any) => ({ ...s, ...(existsSync(s.file) ? sessionUsage(s.file, s.from, s.to) : { missing: true }) })) };
    const a = finalAccounting(overhead); await write(join(ROOT, "accounting.json"), a); console.log(JSON.stringify({ retry: { ...a.retry, byArm: undefined }, firstAttempt: a.firstAttempt, knownTotalUSD: a.knownTotalUSD, crossCheck: a.crossCheck, overhead: a.experimenterOverhead.sessions.map((s: any) => [s.name, s.requests, s.costUSD]) }));
  }
  else throw new Error("packets | ingest <group> <rawFile> | round2-report | score | verify <study> | accounting <study> | final-accounting");
}
