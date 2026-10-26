/**
 * Delivery-only validation (results/delivery-validation/protocol.md): the SAME frozen final admission decisions (three complete Q final
 * plans of results/qualification-validation-retry1) are delivered by
 *   C  fresh free writing (the composer writes final.md from the canonical ledger), and
 *   B  ledger-bound delivery (the composer only writes arrangement.json; delivery-render.mjs renders the approved entries verbatim with
 *      generated status/condition labels),
 * with the same model, inputs and review opportunity: compose → independent delivery audit → local revision → independent recheck.
 *   node --import tsx experiments/mdsd-ab/delivery.ts prepare|preflight|manifest|run|instruments|status <study scratch dir>
 * DELIVERY_VARIANT=effort-high selects the effort-only replication (results/delivery-validation-high/protocol.md; delivery-runtime.ts).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT, NODE, PI_CLI, REPO, sha, write } from "./run.js";
import { diffOf, numberLines, parseJson, spanFound, treeHashes } from "./synthesis.js";
import { json, text, type Claim } from "./qualification-inputs.js";
import { APPROVED, LABELS, MAIN_MAX, blockOf, check, render, requiredOf, scanText, validateArrangement, type Decision, type Ledger, type LedgerEntry } from "./delivery-render.mjs";
import { GUARDS, INPUT_ROOT, INSTRUMENT_EFFORT, JUDGES, MEASURED_EFFORT, MODEL, PINS, PROVIDER, ROOT, VARIANT, checkPins, freezePins, outputOf, providerHashes, retainSession, setStudy, setup, sourceHashes, studyDir, turn, type Turn } from "./delivery-runtime.js";

export { ROOT };
export const RETRY1 = join(REPO, "results/qualification-validation-retry1");
export const LEDGERS = [{ id: "dev-r1.Q-r2", unit: "dev-r1", label: "Q-r2" }, { id: "isort-r1.Q-r1", unit: "isort-r1", label: "Q-r1" }, { id: "isort-r1.Q-r2", unit: "isort-r1", label: "Q-r2" }] as const;
export type LedgerId = (typeof LEDGERS)[number]["id"];
export type Arm = "C" | "B";
export const ARMS: Arm[] = ["C", "B"];
export const REPS = [1, 2] as const;
export const family = (model: string) => model.includes("claude") ? "claude" : "gpt";
const RENDERER = join(REPO, "experiments/mdsd-ab/delivery-render.mjs");

// ---- canonicalization (protocol §3) ---------------------------------------------------------------------------------------------------
export const ACTION: Record<string, Decision> = { retained: "include", added: "include", corrected: "correct", refuted: "correct", uncertain: "uncertain", out_of_scope: "exclude", unsupported: "exclude", duplicate: "duplicate" };
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const sentencesOf = (s: string) => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
export const kNumber = (id: string) => Number(id.replace(/^k/, ""));
const CUES = /\bBASE\b|\bbaseline\b|editing base/g;
export const cueCount = (s: string) => (s.match(CUES) ?? []).length;
export function quoteStatus(quote: string, doc: string | undefined): "exact" | "normalized" | "not_found" | "empty" | "no_document" {
  if (!quote?.trim()) return "empty";
  if (doc === undefined) return "no_document";
  return doc.includes(quote) ? "exact" : norm(doc).includes(norm(quote)) ? "normalized" : "not_found";
}
/** The canonical delivery ledger of one frozen final plan, and the per-entry transformation record. Nothing is repaired. */
export function canonicalLedger(id: string, claims: Claim[], plan: any, docs: Record<string, string>): { ledger: Ledger; record: any } {
  const planEntries: any[] = Array.isArray(plan?.entries) ? plan.entries : [];
  const byRef = new Map<string, any>();
  for (const p of planEntries) { if (byRef.has(p.ref)) throw new Error(`${id}: two plan entries for ${p.ref}`); byRef.set(p.ref, p); }
  const known = new Set(claims.map(c => c.ref));
  for (const ref of byRef.keys()) if (!known.has(ref)) throw new Error(`${id}: plan entry for unregistered ${ref}`);
  // Notes are the frozen reasons VERBATIM (no sentence filtering): a frequency filter was tried on the inputs before any output and
  // removed entry-group rationale ("what would settle it") from uncertain entries, so it was rejected. Reasons that refer to the
  // earlier pipeline's own text or audit are recorded as an ambiguity instead.
  const EARLIER_PIPELINE = /cited final passage|final wording|fixed in both|audit eligibility|eligibility challenge|editing base|\bBASE\b|\bbaseline\b|the integrated answer|spans?\b/i;
  const entries: LedgerEntry[] = [], rows: any[] = [];
  for (const c of [...claims].sort((a, b) => kNumber(a.ref) - kNumber(b.ref))) {
    const p = byRef.get(c.ref);
    if (!p) throw new Error(`${id}: no plan entry for ${c.ref}`);
    const decision = ACTION[p.disposition];
    if (!decision) throw new Error(`${id}: ${c.ref} has unknown disposition ${p.disposition}`);
    const dropped: number[] = [], conditions: string[] = [];
    (Array.isArray(p.qualifiers) ? p.qualifiers : []).forEach((q: string, i: number) => { if (norm(String(q)) === norm(c.claim)) dropped.push(i); else conditions.push(String(q)); });
    const note = decision === "uncertain" || decision === "correct" || decision === "exclude" ? String(p.reason ?? "") : "";
    const duplicateOf = decision === "duplicate" ? String(p.duplicateOf ?? "") : null;
    if (decision === "duplicate" && !known.has(duplicateOf!)) throw new Error(`${id}: ${c.ref} duplicate of unknown ${duplicateOf}`);
    const entry: LedgerEntry = { id: c.ref, decision, required: "", statement: c.claim, sourceStance: c.stance, support: String(p.support ?? ""), relevance: String(p.relevance ?? ""), conditions, note, duplicateOf, locations: c.locations ?? [], quote: c.quote ?? "", evidence: String(p.evidence ?? ""), taskLink: String(p.taskLink ?? "") };
    entry.required = requiredOf(entry);
    entries.push(entry);
    rows.push({ id: c.ref, disposition: p.disposition, decision, droppedQualifiers: dropped, noteEmpty: (decision === "uncertain" || decision === "correct" || decision === "exclude") && !note.trim(), noteRefersToEarlierPipeline: !!note && EARLIER_PIPELINE.test(note), quote: quoteStatus(c.quote, docs[`${c.source}.md`]), source: c.source, deliveredCueWords: cueCount([entry.statement, ...conditions, note].join(" ")), backgroundCueWords: cueCount(`${entry.evidence} ${entry.taskLink}`) });
  }
  const byId = new Map(entries.map(e => [e.id, e]));
  const count = (f: (r: any) => boolean) => rows.filter(f).length;
  const record = {
    ledger: id, entries: entries.length,
    decisions: Object.fromEntries(["include", "uncertain", "correct", "duplicate", "exclude"].map(d => [d, entries.filter(e => e.decision === d).length])),
    dispositionMapping: ACTION, dispositions: rows.reduce((acc: Record<string, number>, r) => { acc[r.disposition] = (acc[r.disposition] ?? 0) + 1; return acc; }, {}),
    droppedQualifiers: count(r => r.droppedQualifiers.length > 0), notesEmpty: rows.filter(r => r.noteEmpty).map(r => r.id),
    deliveredNotesReferringToEarlierPipeline: rows.filter(r => r.noteRefersToEarlierPipeline && (r.decision === "uncertain" || r.decision === "correct")).map(r => r.id),
    quotes: rows.reduce((acc: Record<string, number>, r) => { acc[r.quote] = (acc[r.quote] ?? 0) + 1; return acc; }, {}), quotesNotFound: rows.filter(r => r.quote === "not_found" || r.quote === "normalized").map(r => ({ id: r.id, status: r.quote })),
    duplicatesToNonApproved: entries.filter(e => e.decision === "duplicate" && !APPROVED.includes(byId.get(e.duplicateOf!)!.decision)).map(e => e.id),
    cueWords: { delivered: rows.reduce((n, r) => n + r.deliveredCueWords, 0), background: rows.reduce((n, r) => n + r.backgroundCueWords, 0), deliveredEntries: rows.filter(r => r.deliveredCueWords > 0).map(r => r.id) },
    ambiguities: [
      "correct entries have no approved corrected wording: the frozen plan's spans are an earlier delivery, not a decision; delivery is 'not accurate as worded' + note + conditions",
      "duplicate pointers are admission judgments, not verified equivalence; duplicates are not delivered separately",
      "quotes not found verbatim in their source document are recorded, not repaired",
      "notes are the frozen reasons verbatim; some uncertain/correct notes refer to the earlier pipeline's own text or audit (listed in deliveredNotesReferringToEarlierPipeline) and are delivered as decision-record text, not edited",
    ],
    rows,
  };
  return { ledger: { ledger: id, entries }, record };
}
/**
 * Cited `path:line` locations against the snapshot (input integrity only; not support). A path that is not a snapshot path but the
 * basename of exactly one snapshot file (e.g. `parse.py` for `isort/parse.py`) is resolved to it; several candidates stay ambiguous.
 */
export function citationStatus(loc: string, snapshot: { files: Set<string>; lines: (path: string) => number }): "in_range" | "out_of_range" | "file_not_in_snapshot" | "ambiguous_path" | "not_a_line_citation" {
  const m = /^([^\s:]+):(\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*)$/.exec(loc.trim());
  if (!m) return "not_a_line_citation";
  let path = m[1]!.replace(/^\.\//, "");
  if (!snapshot.files.has(path)) {
    const candidates = path.includes("/") ? [] : [...snapshot.files].filter(f => f.endsWith(`/${path}`));
    if (candidates.length > 1) return "ambiguous_path";
    if (candidates.length !== 1) return "file_not_in_snapshot";
    path = candidates[0]!;
  }
  const max = snapshot.lines(path);
  return (m[2]!.match(/\d+/g) ?? []).map(Number).every(n => n >= 1 && n <= max) ? "in_range" : "out_of_range";
}
function snapshotOf(unit: string): { files: Set<string>; lines: (path: string) => number; source: string } {
  const cache = new Map<string, number>();
  if (unit.startsWith("dev")) {
    const files = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", "2de1f04"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter(Boolean));
    return { files, source: "git 2de1f04 (dev snapshot commit)", lines: path => { if (!cache.has(path)) cache.set(path, execFileSync("git", ["show", `2de1f04:${path}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").length - 1); return cache.get(path)!; } };
  }
  const root = join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491/src");
  const files = new Set(execFileSync("find", [".", "-type", "f"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter(Boolean).map(f => f.replace(/^\.\//, "")));
  return { files, source: "isort snapshot results/advisor-reviewer/cache/swe/pycqa__isort-2491/src", lines: path => { if (!cache.has(path)) { const body = readFileSync(join(root, path), "utf8"); cache.set(path, body.split("\n").length - (body.endsWith("\n") ? 1 : 0)); } return cache.get(path)!; } };
}
export function ledgerMarkdown(ledger: Ledger): string {
  const out = [`# Frozen decision ledger \`${ledger.ledger}\`: ${ledger.entries.length} entries`, "", "Every entry has exactly one decision: include, uncertain, correct, duplicate or exclude. \"Required\" is the delivery every answer must give the entry. ledger.json holds the same entries plus background fields (evidence, taskLink, quote).", ""];
  for (const e of ledger.entries) {
    out.push(`## ${e.id} — ${e.decision}`, `- Required: ${e.required}`, `- Statement: ${e.statement}`, `- Source stance: ${e.sourceStance} · Support: ${e.support} · Relevance: ${e.relevance}`);
    for (const c of e.conditions) out.push(`- Condition/limit: ${c}`);
    if (e.note) out.push(`- Note: ${e.note}`);
    if (e.duplicateOf) out.push(`- Duplicate of: ${e.duplicateOf}`);
    if (e.locations.length) out.push(`- Cited: ${e.locations.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}
export const judgeLedger = (l: Ledger) => `${JSON.stringify({ ledger: l.ledger, entries: l.entries.map(e => ({ id: e.id, decision: e.decision, required: e.required, statement: e.statement, sourceStance: e.sourceStance, conditions: e.conditions, note: e.note, duplicateOf: e.duplicateOf })) }, null, 1)}\n`;
export const judgeBackground = (l: Ledger) => `${JSON.stringify({ ledger: l.ledger, entries: l.entries.map(e => ({ id: e.id, evidence: e.evidence, taskLink: e.taskLink, locations: e.locations })) }, null, 1)}\n`;
export const ledgerJson = (l: Ledger) => `${JSON.stringify(l, null, 1)}\n`;

// ---- prompts (hashed in the manifest; identical delivery contract for both arms) -------------------------------------------------------
export const COMMON = "This is one stage of a delivery workflow for an earlier analysis task. Inputs are in /tmp/pi-orche/input (read-only); write your files to /tmp/pi-orche/work; use /tmp/pi-orche/tmp for scratch files. The working directory is empty: there is no repository to inspect, and this stage is not an investigation. Everything the answer may say about the task's subject is in the frozen decision ledger. Do not use the network. Read long files completely (several reads with offset/limit when needed). Write in English.\nInputs: task.md (the original task, verbatim), guide.md (common interpretation of what the task asks), ledger.md (every ledger entry with its decision, required delivery, statement, conditions/limits, note and cited locations) and ledger.json (the same entries plus background fields: evidence, taskLink, quote).";
export const CONTRACT = [
  "Delivery contract (identical for every answer built from this ledger):",
  "- The ledger's decisions are final. Do not re-decide relevance, support, inclusion or wording; do not add, drop, merge away or re-qualify entries.",
  "- include: the statement is part of the answer as an accepted statement, with every listed condition/limit.",
  "- uncertain: the statement is part of the answer, explicitly marked as not established as its required delivery says (unverified, disputed, or scope/applicability open), with its conditions/limits and its open question (note).",
  "- correct: the answer says that the statement is not accurate as worded and gives the correction basis recorded in the note, with its conditions/limits; it never restates the statement as accurate. The ledger has no approved corrected wording beyond the note and conditions.",
  "- duplicate: covered by the named entry; no separate delivery is required.",
  "- exclude: not part of the answer; do not present it as answer content.",
  "- No other factual content: every claim about the task's subject must come from a ledger entry's statement, conditions/limits or note (evidence and task links are background that may be cited).",
  "- The whole document (summary, body, appendix, notes) is the delivered answer; nothing in it is exempt.",
  "- Do not mention ledger ids (k1, k2, ...) in the answer.",
].join("\n");
export const C_COMPOSE = "Your job: write the final answer to the task for the user from the frozen decision ledger. Read task.md, guide.md and the whole ledger first. Then write /tmp/pi-orche/work/final.md: the complete, self-contained final answer (the user sees only this document, not the ledger). You decide its structure, order, summary and wording as you judge best for the user, within the delivery contract below. If you disagree with a decision, do not change the answer: write the disagreement to /tmp/pi-orche/work/notes.md (not part of the answer). When final.md is written, reply with a short note that you are done.";
export const B_COMPOSE = [
  "Your job: arrange the final answer to the task for the user from the frozen decision ledger. You do not write the answer's text: code renders every include, uncertain and correct entry verbatim from the ledger, with status, scope and condition labels generated from the ledger fields, plus a fixed title, delivery note and accounting. You choose the arrangement: which entries form \"Main points\" (the concise core answer, 1 to 20 entries), the topical sections, their headings and order, the order of entries, and which entries go to \"Additional approved details\". Read task.md, guide.md and the whole ledger first.",
  "Write /tmp/pi-orche/work/arrangement.json:",
  "{\"main\":[\"k1\",...],\"sections\":[{\"label\":\"Findings\",\"span\":\"exact words\",\"from\":\"k7\",\"items\":[\"k7\",...]}],\"appendix\":[\"k9\",...],\"proposals\":[{\"ids\":[\"k1\"],\"kind\":\"reword|merge|split|add|correct|reclassify|other\",\"text\":\"...\",\"why\":\"...\"}]}",
  "Rules (checked by code):",
  "- Place every include, uncertain and correct entry exactly once: in main, in one section, or in appendix. Never place duplicate or exclude entries.",
  `- A section heading is a label, a span, or both (rendered "label: span"). label must be one of: ${LABELS.join(", ")}. span must be 1 to 8 consecutive words copied exactly (same characters, whole words) from the statement or one condition/limit of an entry placed in that section, and "from" names that entry. Use null for an unused part. No other heading text exists.`,
  `- main holds 1 to ${MAIN_MAX} entries. proposals are never rendered and stay unapproved: use them for any rewording, merging, correction or addition you would want.`,
  "Preview: run `node /tmp/pi-orche/input/render.mjs /tmp/pi-orche/input/ledger.json /tmp/pi-orche/work/arrangement.json /tmp/pi-orche/tmp/preview.md`. It writes the rendered answer to preview.md and prints the mechanical check; arrangement errors must be zero. Read the preview and improve the arrangement for the user. When arrangement.json is written and the check reports 0 arrangement errors, reply with a short note that you are done.",
].join("\n");
const DEFECT_SCHEMA = "{\"defects\":[{\"id\":\"D1\",\"kind\":\"absent|partial|status|conditions|excluded_content|unauthorized_content|contradiction|misleading_arrangement|readability|ledger_concern|other\",\"refs\":[\"k4\"],\"where\":\"verbatim excerpt of final.md, or absent\",\"problem\":\"...\",\"fix\":\"...\"}],\"checked\":{\"entries\":0,\"statements\":0}}";
export const C_AUDIT = [
  "Your job: an independent delivery review. Another session wrote the final answer /tmp/pi-orche/input/final.md from the frozen decision ledger. The ledger's decisions are final; you review the delivery, not the decisions. Read the whole answer and the whole ledger, then check:",
  "A) every include, uncertain and correct entry: is it delivered completely as its required delivery says (meaning as worded, status, every condition/limit, and the note for uncertain and correct entries)?",
  "B) exclude entries: is any presented as answer content?",
  "C) every substantive statement of the answer: does it come from a ledger entry (statement, condition/limit, note; evidence or task link as cited background)? Flag content found nowhere in the ledger, contradictions, and anything presented with a different status than required.",
  "D) usefulness to the user: does the answer address the task directly; organization, readability, redundancy.",
  "A disagreement with a ledger decision itself is reported with kind \"ledger_concern\"; it will not change the answer.",
  `Write /tmp/pi-orche/work/audit.json: ${DEFECT_SCHEMA} (an empty defects list if there are none); "fix" is the smallest local change that fixes the defect. Do not edit final.md. When audit.json is written, reply with a short note.`,
].join("\n");
export const B_AUDIT = [
  "Your job: an independent delivery review. The final answer /tmp/pi-orche/input/final.md was rendered by code from the frozen decision ledger and an arrangement (/tmp/pi-orche/input/arrangement.json) chosen by another session; /tmp/pi-orche/input/check.json is the renderer's mechanical check. Entry text, labels, title and generated notes are fixed by code and cannot change; only the arrangement can (Main points selection, sections and their allowed headings, order, Additional approved details). The ledger's decisions are final; you review the delivery, not the decisions. Read the whole answer and the whole ledger, then check:",
  "A) every include, uncertain and correct entry: is it delivered completely as its required delivery says, and is any entry misrepresented by its placement or heading (a heading or grouping implying something its entries do not say)?",
  "B) exclude entries: is any presented as answer content?",
  "C) does any text of the answer come from neither a ledger entry nor a generated label or note? Are there contradictions?",
  "D) usefulness to the user: do the Main points give the core answer to the task; organization, grouping, order, readability, redundancy.",
  "A disagreement with a ledger decision, statement or label itself is reported with kind \"ledger_concern\"; it will not change the answer.",
  `Write /tmp/pi-orche/work/audit.json: ${DEFECT_SCHEMA} (an empty defects list if there are none); "fix" must be an arrangement change. Do not edit the input files. When audit.json is written, reply with a short note.`,
].join("\n");
export const C_REVISE = "An independent reviewer checked your final answer against the ledger; its review is /tmp/pi-orche/input/audit-1.json. Revise /tmp/pi-orche/work/final.md locally for each defect you agree with: change only the affected passages (or insert missing content next to related content); do not rewrite, reorganize or shorten unaffected text. ledger_concern items do not change the answer's content. The delivery contract still applies. Then reply with a short note listing each defect as fixed or rejected, with the reason for each rejection.";
export const B_REVISE = "An independent reviewer checked the rendered answer; its review is /tmp/pi-orche/input/audit-1.json. Revise /tmp/pi-orche/work/arrangement.json for each defect you agree with that an arrangement change can fix, and re-run the preview until it reports 0 arrangement errors. Entry text, labels and generated notes cannot change; ledger_concern items stay as they are. Then reply with a short note listing each defect as fixed, rejected or not fixable by arrangement, with the reason.";
const RECHECK_TAIL = "Decide for each defect of the review whether it is now fixed, rightly rejected, or remains. Then check the changed passages for new problems under the same criteria and the delivery contract, and check that the revision lost no delivered content. Write /tmp/pi-orche/work/audit.json in the same format ({\"defects\":[...]}) with the defects that remain or are new (an empty list if none). Do not edit the input files. When audit.json is written, reply with a short note.";
export const C_RECHECK = `Your job: check a revision. /tmp/pi-orche/input/final.md was revised after an independent delivery review (/tmp/pi-orche/input/audit-1.json, criteria A-D: complete delivery of include/uncertain/correct entries, no excluded content, no content outside the ledger or contradictions, usefulness); the change is /tmp/pi-orche/input/revision.diff and the reviser's note is /tmp/pi-orche/input/revision-note.md. ${RECHECK_TAIL}`;
export const B_RECHECK = `Your job: check a revision. /tmp/pi-orche/input/final.md is code-rendered from the frozen ledger and the revised arrangement /tmp/pi-orche/input/arrangement.json (check.json is its mechanical check); only the arrangement could change after an independent delivery review (/tmp/pi-orche/input/audit-1.json, criteria A-D: complete delivery and no misleading placement or heading, no excluded content, no text outside ledger entries and generated labels/notes, usefulness). The change of the rendered answer is /tmp/pi-orche/input/revision.diff and the reviser's note is /tmp/pi-orche/input/revision-note.md. ${RECHECK_TAIL}`;
export const C_FIX = "The mechanical check of /tmp/pi-orche/work/final.md failed:\n{ERRORS}\nFix only that: final.md must exist, be the complete non-empty answer, and must not mention ledger ids (k1, k2, ...). Reply with a short note when done.";
export const B_FIX = "The arrangement check failed:\n{ERRORS}\nFix /tmp/pi-orche/work/arrangement.json so that the preview (node /tmp/pi-orche/input/render.mjs /tmp/pi-orche/input/ledger.json /tmp/pi-orche/work/arrangement.json /tmp/pi-orche/tmp/preview.md) reports 0 arrangement errors. Reply with a short note when done.";
export const AUDIT_FIX = "/tmp/pi-orche/work/audit.json is not usable:\n{ERRORS}\nFix it: valid JSON with a defects array as specified (the same review content). Reply with a short note when done.";
export const JUDGE = [
  "You evaluate how a delivered answer realizes a frozen decision ledger, for an evaluation. You do not decide whether statements are true, in scope or important, and you do not judge the decisions.",
  "Files in /tmp/pi-orche/input: task.md (the task the answer responds to), guide.md (task interpretation), ledger.json (one entry per registered statement: id, decision, required delivery, statement, sourceStance, conditions, note, duplicateOf), ledger-background.json (evidence, taskLink and locations of the same entries; use it only to decide whether a claim of the text comes from the ledger) and text.md (the FULL answer; every line starts with \"L<n>: \", which is not part of the text).",
  "Read the whole text first (several reads with offset when long). Summary, body, appendix and generated notes count equally; decide an omission only after reading everything.",
  "For EVERY ledger entry give one item:",
  "- realization of the statement AS WORDED (its own negation, conditions, specifics) anywhere in the text, in any wording: complete | partial (core present but a substantive element missing or changed) | missing | opposed (the text says it is false or not accurate);",
  "- stance: how the text presents the statement as worded: asserted | hedged (unverified, disputed, uncertain, open) | rejected | absent | mixed (one occurrence asserts while another hedges or rejects; give both quotes). Repeating a denial such as \"X is not a defect\" asserts that statement;",
  "- status, compared with the entry's required delivery: as_required | upgraded (more accepted or certain than required: an uncertain entry asserted, a corrected entry restated as accurate, an excluded entry presented as answer content) | downgraded (less than required: an accepted entry hedged, rejected or only mentioned as uncertain) | mixed | not_applicable (duplicate entries). An excluded entry that is absent or not presented as answer content is as_required;",
  "- conditions: kept (every listed condition/limit, and for uncertain and correct entries the note, is conveyed where the entry is delivered) | partial | lost | not_applicable (no conditions and no note required, the entry is not delivered, or a duplicate/exclude entry);",
  "- quote: verbatim excerpt of the text without the line prefix (5 to 60 words) of the main passage, empty when missing; counterQuote for mixed; lines; note (what is missing, changed or mixed; empty when complete, as_required and kept).",
  "Then list:",
  "- other: every substantive claim of the text about the task's subject (including headings) that no ledger statement expresses, with source = the ledger field it comes from (conditions | note | evidence | taskLink) and the ids, or none when it appears nowhere in the ledger, or unclear. Generated delivery notes, counts and formatting are not claims;",
  "- contradictions: pairs of passages of the text that contradict each other;",
  "- usefulness for the asking user, 1 (poor) to 5 (excellent): answersTask, organization, readability, statusClarity (established vs uncertain vs corrected), concision; mainAnswerLines (where the core answer is); problems (short list).",
  "Write /tmp/pi-orche/work/judgment.json:",
  "{\"items\":[{\"id\":\"k1\",\"realization\":\"complete|partial|missing|opposed\",\"stance\":\"asserted|hedged|rejected|absent|mixed\",\"status\":\"as_required|upgraded|downgraded|mixed|not_applicable\",\"conditions\":\"kept|partial|lost|not_applicable\",\"quote\":\"...\",\"counterQuote\":\"\",\"lines\":[1],\"note\":\"\"}],\"other\":[{\"claim\":\"...\",\"quote\":\"...\",\"lines\":[1],\"source\":\"conditions|note|evidence|taskLink|none|unclear\",\"ids\":[\"k3\"]}],\"contradictions\":[{\"a\":\"verbatim\",\"b\":\"verbatim\",\"note\":\"...\"}],\"usefulness\":{\"answersTask\":3,\"organization\":3,\"readability\":3,\"statusClarity\":3,\"concision\":3,\"mainAnswerLines\":[1],\"problems\":[\"...\"]}}",
  "Exactly one item per ledger entry. You may build the file in steps (for example JSONL converted with a script), but the final file must be valid JSON. Reply \"done\" when the file is written.",
].join("\n");
export const JUDGE_FIX = "/tmp/pi-orche/work/judgment.json is not usable:\n{ERRORS}\nFix it (one item per ledger id, allowed values, quotes copied verbatim from the text without line prefixes). Same criteria. Reply \"done\" when the file is written.";
export const PAIR = [
  "You compare two answers to the same task, for an evaluation. Files in /tmp/pi-orche/input: task.md (the task), guide.md (its interpretation), answer-X.md and answer-Y.md (two complete answers built from the same frozen decisions). Read both completely.",
  "Do not judge factual truth (both rest on the same decisions). Judge usefulness to the user who asked the task: does it answer the task directly; organization; readability; clarity of what is established, uncertain or corrected; concision and redundancy. Length alone is neither good nor bad.",
  "Write /tmp/pi-orche/work/pairwise.json: {\"overall\":\"X|Y|tie\",\"criteria\":{\"answersTask\":\"X|Y|tie\",\"organization\":\"X|Y|tie\",\"readability\":\"X|Y|tie\",\"statusClarity\":\"X|Y|tie\",\"concision\":\"X|Y|tie\"},\"reasons\":\"...\",\"problemsX\":[\"...\"],\"problemsY\":[\"...\"]}. Reply \"done\" when the file is written.",
].join("\n");
export const PAIR_FIX = "/tmp/pi-orche/work/pairwise.json is not usable:\n{ERRORS}\nFix it (valid JSON with overall, the five criteria as X, Y or tie, reasons, problemsX, problemsY). Same judgment. Reply \"done\" when the file is written.";
export const prompts = { COMMON, CONTRACT, C_COMPOSE, B_COMPOSE, C_AUDIT, B_AUDIT, C_REVISE, B_REVISE, C_RECHECK, B_RECHECK, C_FIX, B_FIX, AUDIT_FIX, JUDGE, JUDGE_FIX, PAIR, PAIR_FIX };
export const composePrompt = (arm: Arm) => [COMMON, arm === "C" ? C_COMPOSE : B_COMPOSE, CONTRACT].join("\n\n");
export const auditPrompt = (arm: Arm) => [COMMON, arm === "C" ? C_AUDIT : B_AUDIT, CONTRACT].join("\n\n");
export const recheckPrompt = (arm: Arm) => [COMMON, arm === "C" ? C_RECHECK : B_RECHECK, CONTRACT].join("\n\n");

// ---- validators (mechanical; schema only, never semantic) ------------------------------------------------------------------------------
export const ID_MENTION = /\bk\d{1,3}\b/g;
export function checkComposeC(final: string): string[] {
  const errors: string[] = [];
  if (!final.trim()) errors.push("final.md is missing or empty");
  const ids = [...new Set(final.match(ID_MENTION) ?? [])];
  if (ids.length) errors.push(`final.md mentions ledger ids: ${ids.slice(0, 30).join(", ")}`);
  return errors;
}
export function arrangementOf(raw: string): { value: any; errors: string[] } {
  if (!raw.trim()) return { value: {}, errors: ["arrangement.json is missing"] };
  try { return { value: JSON.parse(raw), errors: [] }; } catch (e) { return { value: {}, errors: [`arrangement.json is not valid JSON: ${String(e).slice(0, 160)}`] }; }
}
export function checkComposeB(ledger: Ledger, raw: string): string[] { const a = arrangementOf(raw); return a.errors.length ? a.errors : validateArrangement(ledger, a.value).errors; }
export const DEFECT_KINDS = ["absent", "partial", "status", "conditions", "excluded_content", "unauthorized_content", "contradiction", "misleading_arrangement", "readability", "ledger_concern", "other"];
export function checkAudit(value: any): string[] {
  if (!value || typeof value !== "object" || !Array.isArray(value.defects)) return ["audit.json needs a defects array"];
  const errors: string[] = [];
  value.defects.forEach((d: any, i: number) => {
    if (!d || typeof d !== "object") { errors.push(`defect ${i + 1}: not an object`); return; }
    if (!DEFECT_KINDS.includes(d.kind)) errors.push(`defect ${i + 1}: kind must be one of ${DEFECT_KINDS.join("|")}`);
    if (!String(d.problem ?? "").trim()) errors.push(`defect ${i + 1}: problem missing`);
    if (d.refs !== undefined && !Array.isArray(d.refs)) errors.push(`defect ${i + 1}: refs must be an array`);
  });
  return errors;
}
export const REALIZATION = ["complete", "partial", "missing", "opposed"], STANCE = ["asserted", "hedged", "rejected", "absent", "mixed"], STATUS = ["as_required", "upgraded", "downgraded", "mixed", "not_applicable"], CONDITIONS = ["kept", "partial", "lost", "not_applicable"], SOURCES = ["conditions", "note", "evidence", "taskLink", "none", "unclear"], RUBRIC = ["answersTask", "organization", "readability", "statusClarity", "concision"];
const quoted = (q: unknown, text: string) => typeof q === "string" && (spanFound(q, text, 3) || (q.trim().length >= 4 && text.includes(q.trim())));
/** A judgment is usable when every ledger entry has exactly one item with allowed values and verbatim quotes (schema, not meaning). */
export function checkJudgment(ids: string[], value: any, text: string): string[] {
  if (!value || typeof value !== "object" || !Array.isArray(value.items) || !Array.isArray(value.other) || !Array.isArray(value.contradictions)) return ["judgment.json needs items, other and contradictions arrays"];
  const errors: string[] = [], seen = new Set<string>(), known = new Set(ids);
  for (const e of value.items) {
    if (!known.has(e?.id) || seen.has(e?.id)) { errors.push(`unknown or repeated item ${String(e?.id)}`); continue; }
    seen.add(e.id);
    if (!REALIZATION.includes(e.realization)) errors.push(`${e.id}: realization`);
    if (!STANCE.includes(e.stance)) errors.push(`${e.id}: stance`);
    if (!STATUS.includes(e.status)) errors.push(`${e.id}: status`);
    if (!CONDITIONS.includes(e.conditions)) errors.push(`${e.id}: conditions`);
    if (e.realization !== "missing" && !quoted(e.quote, text)) errors.push(`${e.id}: quote not found verbatim in the text`);
    if (e.stance === "mixed" && !quoted(e.counterQuote, text)) errors.push(`${e.id}: mixed stance without a verbatim counterQuote`);
  }
  const missing = ids.filter(id => !seen.has(id));
  if (missing.length) errors.push(`${missing.length} ledger entries without an item: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", ..." : ""}`);
  value.other.forEach((o: any, i: number) => { if (!String(o?.claim ?? "").trim()) errors.push(`other ${i + 1}: claim missing`); if (!quoted(o?.quote, text)) errors.push(`other ${i + 1}: quote not found verbatim`); if (!SOURCES.includes(o?.source)) errors.push(`other ${i + 1}: source`); });
  value.contradictions.forEach((c: any, i: number) => { if (!quoted(c?.a, text) || !quoted(c?.b, text)) errors.push(`contradiction ${i + 1}: a/b not found verbatim`); });
  const u = value.usefulness;
  if (!u || typeof u !== "object" || RUBRIC.some(k => !Number.isInteger(u[k]) || u[k] < 1 || u[k] > 5)) errors.push("usefulness needs integer 1-5 scores for answersTask, organization, readability, statusClarity, concision");
  return errors;
}
export function checkPairwise(value: any): string[] {
  const ok = (v: unknown) => v === "X" || v === "Y" || v === "tie";
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["pairwise.json must be a JSON object"];
  if (!ok(value.overall)) errors.push("overall must be X, Y or tie");
  for (const k of RUBRIC) if (!ok(value.criteria?.[k])) errors.push(`criteria.${k} must be X, Y or tie`);
  if (!String(value.reasons ?? "").trim()) errors.push("reasons missing");
  if (!Array.isArray(value.problemsX) || !Array.isArray(value.problemsY)) errors.push("problemsX and problemsY must be arrays");
  return errors;
}

// ---- inputs (protocol §2-3) ------------------------------------------------------------------------------------------------------------
export const ledgerDir = (id: string) => join(INPUT_ROOT, "inputs", id);
export const ledgerOf = (id: string): Ledger => json(join(ledgerDir(id), "ledger.json"));
export const packetOf = (id: string): Record<string, string> => Object.fromEntries(["task.md", "guide.md", "ledger.json", "ledger.md"].map(n => [n, text(join(ledgerDir(id), n))]));
export const judgePacketOf = (id: string): Record<string, string> => ({ "task.md": text(join(ledgerDir(id), "task.md")), "guide.md": text(join(ledgerDir(id), "guide.md")), "ledger.json": text(join(ledgerDir(id), "judge-ledger.json")), "ledger-background.json": text(join(ledgerDir(id), "judge-background.json")) });
export const rendererSource = () => text(RENDERER);
const PRIOR = ["quality-validation", "synthesis-validation", "qualification-validation", "qualification-validation-retry1"];
export const priorModules = () => Object.fromEntries(execFileSync("git", ["ls-files", "--others", "--cached", "--exclude-standard", "experiments/mdsd-ab", "test/experiments"], { cwd: REPO }).toString().split("\n").filter(f => f && !/\/delivery[^/]*$/.test(f)).map(f => [f, sha(readFileSync(join(REPO, f)))]));
export async function prepare(): Promise<void> {
  if (VARIANT.baseline) return prepareReplication();
  if (existsSync(join(ROOT, "inputs-frozen.json"))) throw new Error("inputs already frozen; never overwrite");
  if (!existsSync(join(ROOT, "protocol.md"))) throw new Error("protocol.md must exist before inputs are frozen");
  const prior: Record<string, unknown> = { modules: priorModules() };
  for (const name of PRIOR) prior[name] = treeHashes(join(REPO, "results", name));
  await write(join(ROOT, "prior-hashes.json"), prior);
  const ledgers: any = {};
  for (const l of LEDGERS) {
    const finalDir = join(RETRY1, l.unit, l.label, "final"), frozen = json(join(finalDir, "frozen.json"));
    const planText = text(join(finalDir, "plan.json"));
    if (sha(planText) !== frozen.files["plan.json"]) throw new Error(`${l.id}: final plan differs from its frozen hash`);
    if (json(join(RETRY1, l.unit, l.label, "pipeline.json")).valid !== true || (frozen.errors ?? []).length) throw new Error(`${l.id}: not a complete valid final plan`);
    const input = join(RETRY1, "inputs", l.unit), claimsText = text(join(input, "claims.json"));
    const docs = { "doc-A.md": text(join(input, "doc-A.md")), "doc-B.md": text(join(input, "doc-B.md")) };
    const { ledger, record } = canonicalLedger(l.id, JSON.parse(claimsText).claims, JSON.parse(planText), docs);
    const snap = snapshotOf(l.unit), citations: Record<string, number> = {}, outOfRange: any[] = [];
    for (const e of ledger.entries) for (const loc of e.locations) { const s = citationStatus(loc, snap); citations[s] = (citations[s] ?? 0) + 1; if (s === "out_of_range") outOfRange.push({ id: e.id, loc }); }
    const files: Record<string, string> = { "task.md": text(join(input, "task.md")), "guide.md": text(join(input, "guide.md")), "ledger.json": ledgerJson(ledger), "ledger.md": ledgerMarkdown(ledger), "judge-ledger.json": judgeLedger(ledger), "judge-background.json": judgeBackground(ledger) };
    files["canonical-record.json"] = `${JSON.stringify({ ...record, citations: { snapshot: snap.source, counts: citations, outOfRange } }, null, 1)}\n`;
    await mkdir(ledgerDir(l.id), { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(join(ledgerDir(l.id), name), body);
    ledgers[l.id] = { source: { plan: `${l.unit}/${l.label}/final/plan.json`, planSha256: sha(planText), frozenSha256: sha(text(join(finalDir, "frozen.json"))), claimsSha256: sha(claimsText), docs: Object.fromEntries(Object.entries(docs).map(([n, b]) => [n, sha(b)])) }, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)])), decisions: record.decisions };
  }
  await write(join(ROOT, "inputs-frozen.json"), { frozenAt: new Date().toISOString(), protocolSha256: sha(text(join(ROOT, "protocol.md"))), builderSha256: sha(readFileSync(fileURLToPath(import.meta.url))), rendererSha256: sha(rendererSource()), ledgers, unavailable: { "dev-r1/Q-r1": "draft plan only (compose-fix ended with upstream 503)", "isort-r2/Q-r1": "compose ended with 503; only initial decisions", "isort-r2/Q-r2": "compose ended with 503; only initial decisions", "T plans": "not admission ledgers of the approved form", "results/qualification-validation": "first attempt: no eligible final" } });
}
/** Content hashes of the analysed targets and frozen evidence (compared again at scoring; the sandboxes never see these paths). */
export function targetHashes(): Record<string, unknown> {
  const tree = (p: string) => { const t = treeHashes(join(REPO, p)); return { files: Object.keys(t).length, sha256: sha(JSON.stringify(t)) }; };
  return { devCommitTree: execFileSync("git", ["rev-parse", "2de1f04^{tree}"], { cwd: REPO }).toString().trim(), isortSnapshot: tree("results/advisor-reviewer/cache/swe/pycqa__isort-2491/src"), isortFixture: tree("fixtures/advisor-bench/swe/pycqa__isort-2491"), retry1Inputs: tree("results/qualification-validation-retry1/inputs"), retry1References: tree("results/qualification-validation-retry1/references") };
}
/**
 * Input freeze of the effort-only replication: nothing is rebuilt. The max study's frozen inputs, pins, provider copy, renderer and
 * prompts are verified byte for byte against its own freeze and manifest and then read in place; the byte copies of the max study's
 * delivery modules (baseline-sources/, taken before any edit) are verified; prior study trees, including the max study, are hashed.
 */
export async function prepareReplication(): Promise<void> {
  const base = join(REPO, VARIANT.baseline!);
  if (existsSync(join(ROOT, "inputs-frozen.json"))) throw new Error("inputs already frozen; never overwrite");
  if (!existsSync(join(ROOT, "protocol.md"))) throw new Error("protocol.md must exist before inputs are frozen");
  const baseFrozen = json(join(base, "inputs-frozen.json")), baseManifest = json(join(base, "manifest.json"));
  for (const l of LEDGERS) for (const [name, hash] of Object.entries<string>(baseFrozen.ledgers[l.id].files)) if (sha(text(join(ledgerDir(l.id), name))) !== hash) throw new Error(`max-study input changed: ${l.id}/${name}`);
  for (const [name, hash] of Object.entries<string>(baseManifest.pins)) if (sha(readFileSync(join(PINS, name))) !== hash) throw new Error(`max-study pin changed: ${name}`);
  if (JSON.stringify(treeHashes(PROVIDER)) !== JSON.stringify(baseManifest.provider)) throw new Error("max-study provider copy changed");
  if (sha(rendererSource()) !== baseFrozen.rendererSha256 || sha(rendererSource()) !== baseManifest.rendererSha256) throw new Error("renderer differs from the max study");
  if (JSON.stringify(promptHashes()) !== JSON.stringify(baseManifest.prompts)) throw new Error("prompts differ from the max study");
  const snapshot = json(join(ROOT, "baseline-sources", "hashes.json"));
  for (const [rel, hash] of Object.entries<string>(snapshot.files)) if (sha(readFileSync(join(ROOT, "baseline-sources", rel))) !== hash) throw new Error(`baseline source copy changed: ${rel}`);
  for (const [name, hash] of Object.entries<string>(baseManifest.sources)) if (snapshot.files[`experiments/mdsd-ab/${name}`] && snapshot.files[`experiments/mdsd-ab/${name}`] !== hash) throw new Error(`baseline source copy of ${name} is not the max study's runtime`);
  const prior: Record<string, unknown> = { modules: priorModules() };
  for (const name of [...PRIOR, basename(base)]) prior[name] = treeHashes(join(REPO, "results", name));
  await write(join(ROOT, "prior-hashes.json"), prior);
  await write(join(ROOT, "target-hashes-before.json"), { at: new Date().toISOString(), note: "target/evidence content hashes captured at the replication's input freeze (before any model call); compared again at scoring", ...targetHashes() });
  const hashOf = (file: string) => sha(readFileSync(join(base, file)));
  await write(join(ROOT, "inputs-frozen.json"), {
    frozenAt: new Date().toISOString(), variant: VARIANT.name, protocolSha256: sha(text(join(ROOT, "protocol.md"))), builderSha256: sha(readFileSync(fileURLToPath(import.meta.url))), rendererSha256: sha(rendererSource()),
    inputsReadFrom: `${VARIANT.inputs}/inputs (read in place; hashes below are the max study's own freeze)`,
    baseline: { root: VARIANT.baseline, protocolSha256: hashOf("protocol.md"), addendumSha256: hashOf("addendum-1.md"), inputsFrozenSha256: hashOf("inputs-frozen.json"), manifestSha256: hashOf("manifest.json"), scoresSha256: hashOf("scores.json"), reportSha256: hashOf("report.md"), pins: baseManifest.pins, providerTreeSha256: sha(JSON.stringify(baseManifest.provider)), prompts: baseManifest.prompts, sourceSnapshot: "baseline-sources/hashes.json" },
    ledgers: baseFrozen.ledgers, unavailable: baseFrozen.unavailable,
  });
}
export const promptHashes = (): Record<string, string> => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, sha(v)]));
export function checkInputs(): void {
  const frozen = json(join(ROOT, "inputs-frozen.json"));
  if (sha(text(join(ROOT, "protocol.md"))) !== frozen.protocolSha256) throw new Error("protocol.md changed after the input freeze");
  for (const l of LEDGERS) for (const [name, hash] of Object.entries(frozen.ledgers[l.id].files)) if (sha(text(join(ledgerDir(l.id), name))) !== hash) throw new Error(`input changed: ${l.id}/${name}`);
}

// ---- pipelines (protocol §4, §6) -------------------------------------------------------------------------------------------------------
class TechnicalFailure extends Error { constructor(readonly stage: string, readonly detail: string) { super(`${stage}: ${detail}`); } }
const summary = (stage: string, t: Turn) => ({ stage, label: t.label, number: t.number, ok: t.ok, technical: t.technical, finalStop: t.finalStop, ms: t.ms, wireUSD: t.wire?.costUSD, requests: t.wire?.requests, unknownUsage: t.wire?.unknownUsage, record: t.record?.slice(ROOT.length + 1) });
async function freezeDir(dir: string, files: Record<string, string>, extra: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  await write(join(dir, "frozen.json"), { at: new Date().toISOString(), ...extra, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)])) });
}
interface Delivery { text: string; files: Record<string, string>; errors: string[]; arrangementRaw?: string; checkJson?: string }
function deliveryOf(arm: Arm, ledger: Ledger, t: Turn, errors: string[]): Delivery {
  if (arm === "C") { const final = outputOf(t, "final.md"), notes = outputOf(t, "notes.md"); return { text: final, errors, files: { "final.md": final, ...(notes ? { "notes.md": notes } : {}), "scan.json": `${JSON.stringify(scanText(ledger, final), null, 1)}\n` } }; }
  const raw = outputOf(t, "arrangement.json"), arrangement = arrangementOf(raw).value, r = render(ledger, arrangement), c = check(ledger, arrangement, r.text);
  const checkJson = `${JSON.stringify(c, null, 1)}\n`;
  return { text: r.text, errors, arrangementRaw: raw, checkJson, files: { "final.md": r.text, "arrangement.json": raw || "{}\n", "render-map.json": `${JSON.stringify(r.map, null, 1)}\n`, "check.json": checkJson, "proposals.json": `${JSON.stringify(r.proposals, null, 1)}\n`, "scan.json": `${JSON.stringify(scanText(ledger, r.text), null, 1)}\n` } };
}
/** One attempt of one cell: compose → audit → revise → recheck in fresh sandboxes (composer session continued). */
async function attemptCell(ledgerId: LedgerId, arm: Arm, rep: number, n: number): Promise<any> {
  const id = `${ledgerId}-${arm}-r${rep}-a${n}`, scratch = join(studyDir(), "runs", ledgerId, `${arm}-r${rep}`, `a${n}`), record = join(ROOT, "runs", ledgerId, `${arm}-r${rep}`, `a${n}`);
  const ledger = ledgerOf(ledgerId), packet = packetOf(ledgerId), out: any = { attempt: n, startedAt: new Date().toISOString(), stages: [] };
  let composerTurn = 0;
  const call = async (stage: string, session: "compose" | "audit" | "recheck", number: number, prompt: string, inputs: Record<string, string>, guard: number) => {
    const t = await turn({ session: join(scratch, session), record: join(record, session), label: `${id}-${session}`, number, model: MODEL, effort: MEASURED_EFFORT, prompt, inputs, guard });
    out.stages.push(summary(stage, t));
    if (!t.ok) throw new TechnicalFailure(stage, t.technical.join("; "));
    return t;
  };
  const composeCheck = (t: Turn) => arm === "C" ? checkComposeC(outputOf(t, "final.md")) : checkComposeB(ledger, outputOf(t, "arrangement.json"));
  const fixPrompt = (errors: string[]) => (arm === "C" ? C_FIX : B_FIX).replace("{ERRORS}", errors.join("\n"));
  try {
    let t = await call("compose", "compose", ++composerTurn, composePrompt(arm), { ...packet, ...(arm === "B" ? { "render.mjs": rendererSource() } : {}) }, GUARDS.compose);
    let errors = composeCheck(t);
    if (errors.length) { t = await call("compose-fix", "compose", ++composerTurn, fixPrompt(errors), {}, GUARDS.fix); errors = composeCheck(t); }
    const draft = deliveryOf(arm, ledger, t, errors);
    out.deliverable = arm === "B" || !!draft.text.trim();
    await freezeDir(join(ROOT, "runs", ledgerId, `${arm}-r${rep}`, `a${n}`, "draft"), draft.files, { errors });
    if (!out.deliverable) { out.outcome = "no deliverable after the fix continuation (measured failure: every approved entry undelivered)"; out.final = draft; return out; }
    const reviewInputs = (d: Delivery) => ({ ...packet, "final.md": d.text, ...(arm === "B" ? { "arrangement.json": d.arrangementRaw || "{}\n", "check.json": d.checkJson! } : {}) });
    let a = await call("audit", "audit", 1, auditPrompt(arm), reviewInputs(draft), GUARDS.audit);
    let auditBody = outputOf(a, "audit.json"), auditErrors = checkAudit(parseJson(auditBody));
    if (auditErrors.length) { a = await call("audit-fix", "audit", 2, AUDIT_FIX.replace("{ERRORS}", auditErrors.join("\n")), {}, GUARDS.fix); auditBody = outputOf(a, "audit.json"); auditErrors = checkAudit(parseJson(auditBody)); }
    out.auditErrors = auditErrors;
    if (auditErrors.length) { out.reviewAvailable = false; out.outcome = "review unavailable (unusable audit after its fix): final = draft"; out.final = draft; out.files = { ...draft.files, "audit-1.json": auditBody }; return out; }
    out.reviewAvailable = true;
    t = await call("revise", "compose", ++composerTurn, arm === "C" ? C_REVISE : B_REVISE, { "audit-1.json": auditBody }, GUARDS.revise);
    const reviseNote = t.reply;
    errors = composeCheck(t);
    if (errors.length) { t = await call("revise-fix", "compose", ++composerTurn, fixPrompt(errors), {}, GUARDS.fix); errors = composeCheck(t); }
    let final = deliveryOf(arm, ledger, t, errors);
    if (arm === "C" && !final.text.trim()) final = { ...draft, errors: [...errors, "final.md empty after revision: the draft stays the deliverable"] };
    const diff = diffOf(draft.text, final.text, scratch);
    const r = await call("recheck", "recheck", 1, recheckPrompt(arm), { ...reviewInputs(final), "audit-1.json": auditBody, "revision.diff": diff, "revision-note.md": reviseNote }, GUARDS.recheck);
    let recheck = outputOf(r, "audit.json"), recheckErrors = checkAudit(parseJson(recheck));
    if (recheckErrors.length) { const r2 = await call("recheck-fix", "recheck", 2, AUDIT_FIX.replace("{ERRORS}", recheckErrors.join("\n")), {}, GUARDS.fix); recheck = outputOf(r2, "audit.json"); recheckErrors = checkAudit(parseJson(recheck)); }
    out.recheckErrors = recheckErrors;
    out.final = final;
    out.files = { ...final.files, "audit-1.json": auditBody, "recheck.json": recheck, "revision.diff": diff, "revision-note.md": reviseNote };
    out.outcome = "complete";
    return out;
  } catch (e) {
    out.technicalFailure = e instanceof TechnicalFailure ? e.message : `harness: ${String(e).slice(0, 400)}`;
    return out;
  } finally {
    out.endedAt = new Date().toISOString();
    for (const s of ["compose", "audit", "recheck"]) await retainSession(join(scratch, s), join(record, s));
  }
}
export async function cell(ledgerId: LedgerId, arm: Arm, rep: number): Promise<void> {
  const dir = join(ROOT, "runs", ledgerId, `${arm}-r${rep}`);
  if (existsSync(join(dir, "pipeline.json"))) return;
  const attempts: any[] = [];
  for (const n of [1, 2]) {
    const r = await attemptCell(ledgerId, arm, rep, n);
    const { final, files, ...rest } = r;
    attempts.push(rest);
    if (!r.technicalFailure) {
      await freezeDir(join(dir, "final"), files ?? final.files, { attempt: n, outcome: r.outcome, composeErrors: final.errors, reviewAvailable: r.reviewAvailable ?? false });
      await write(join(dir, "pipeline.json"), { id: `${ledgerId}-${arm}-r${rep}`, ledger: ledgerId, arm, rep, model: MODEL, thinking: MEASURED_EFFORT, status: "complete", deliverable: r.deliverable, reviewAvailable: r.reviewAvailable ?? false, finalAttempt: n, attempts });
      return;
    }
    console.error(`${ledgerId}-${arm}-r${rep} attempt ${n}: ${r.technicalFailure}`);
  }
  await write(join(dir, "pipeline.json"), { id: `${ledgerId}-${arm}-r${rep}`, ledger: ledgerId, arm, rep, model: MODEL, thinking: MEASURED_EFFORT, status: "technically-incomplete", attempts });
}

// ---- instruments (protocol §7) ---------------------------------------------------------------------------------------------------------
export const finalTextOf = (ledgerId: string, label: string): string | undefined => {
  if (label === "hist") { const l = LEDGERS.find(x => x.id === ledgerId)!; return text(join(RETRY1, l.unit, l.label, "final/final.md")); }
  const p = join(ROOT, "runs", ledgerId, label, "pipeline.json");
  if (!existsSync(p) || json(p).status !== "complete") return undefined;
  // A complete cell without a deliverable (C: no final.md after the fix) is scored as all approved entries undelivered, not judged.
  if (json(p).deliverable === false) return undefined;
  return text(join(ROOT, "runs", ledgerId, label, "final/final.md"));
};
async function instrument(kind: "judge" | "pairwise", ledgerId: string, label: string, model: string, inputs: Record<string, string>, validate: (value: any) => string[], output: string, extra: Record<string, unknown>): Promise<void> {
  const fam = family(model), out = join(ROOT, kind === "judge" ? "judgments" : "pairwise", ledgerId, `${label}.${fam}.json`);
  if (existsSync(out)) return;
  await mkdir(join(out, ".."), { recursive: true });
  const attempts: any[] = [];
  for (const n of [1, 2]) {
    const session = join(studyDir(), `${kind}-runs`, ledgerId, `${label}.${fam}`, `a${n}`), record = join(ROOT, `${kind}-runs`, ledgerId, `${label}.${fam}`, `a${n}`);
    const turns: Turn[] = [];
    try {
      turns.push(await turn({ session, record, label: `${ledgerId}-${kind}-${label}-${fam}-a${n}`, number: 1, model, effort: INSTRUMENT_EFFORT, prompt: kind === "judge" ? JUDGE : PAIR, inputs, guard: kind === "judge" ? GUARDS.judge : GUARDS.pairwise }));
      if (!turns[0]!.ok) { attempts.push({ attempt: n, technical: turns[0]!.technical, turns: turns.map(t => summary(kind, t)) }); continue; }
      let value = parseJson(outputOf(turns[0]!, output)), errors = validate(value);
      if (errors.length) {
        turns.push(await turn({ session, record, label: `${ledgerId}-${kind}-${label}-${fam}-a${n}`, number: 2, model, effort: INSTRUMENT_EFFORT, prompt: (kind === "judge" ? JUDGE_FIX : PAIR_FIX).replace("{ERRORS}", errors.slice(0, 60).join("\n")), inputs: {}, guard: GUARDS.fix }));
        if (!turns[1]!.ok) { attempts.push({ attempt: n, technical: turns[1]!.technical, turns: turns.map(t => summary(kind, t)) }); continue; }
        value = parseJson(outputOf(turns[1]!, output)); errors = validate(value);
      }
      attempts.push({ attempt: n, turns: turns.map(t => summary(kind, t)) });
      await write(out, { kind, ledger: ledgerId, label, model, ...extra, valid: errors.length === 0, errors, value, attempts });
      return;
    } catch (e) { attempts.push({ attempt: n, harness: String(e).slice(0, 400), turns: turns.map(t => summary(kind, t)) }); }
    finally { await retainSession(session, record); }
  }
  await write(out, { kind, ledger: ledgerId, label, model, ...extra, valid: false, technicalFailure: true, attempts });
}
export async function judge(ledgerId: string, label: string, model: string): Promise<void> {
  const body = finalTextOf(ledgerId, label);
  if (body === undefined) return;
  const ids = ledgerOf(ledgerId).entries.map(e => e.id);
  await instrument("judge", ledgerId, label, model, { ...judgePacketOf(ledgerId), "text.md": numberLines(body) }, v => checkJudgment(ids, v, body), "judgment.json", { textSha256: sha(body) });
}
/** X/Y order: by hash per pair; the two families get opposite orders. */
export function pairOrder(ledgerId: string, rep: number, model: string): { X: string; Y: string } {
  const even = parseInt(sha(`${ledgerId}:r${rep}:pairwise`)[0]!, 16) % 2 === 0, cFirst = family(model) === "claude" ? even : !even;
  return cFirst ? { X: `C-r${rep}`, Y: `B-r${rep}` } : { X: `B-r${rep}`, Y: `C-r${rep}` };
}
export async function pairwise(ledgerId: string, rep: number, model: string): Promise<void> {
  const order = pairOrder(ledgerId, rep, model), x = finalTextOf(ledgerId, order.X), y = finalTextOf(ledgerId, order.Y);
  if (x === undefined || y === undefined) return;
  const packet = judgePacketOf(ledgerId);
  await instrument("pairwise", ledgerId, `r${rep}`, model, { "task.md": packet["task.md"]!, "guide.md": packet["guide.md"]!, "answer-X.md": x, "answer-Y.md": y }, checkPairwise, "pairwise.json", { order, textSha256: { X: sha(x), Y: sha(y) } });
}

// ---- preflight (protocol §6) -----------------------------------------------------------------------------------------------------------
export const TOY = {
  task: "Read-only question about a small JavaScript repository: which function in calc.js computes the average, and does it handle an empty list? Answer with file:line evidence and say what was checked.\n",
  guide: "# Task interpretation (toy)\nFindings answer the two questions; supporting details give evidence or limits; style is out of scope.\n",
  claims: [
    { ref: "k1", claim: "mean in calc.js:5-7 computes the average.", quote: "mean (calc.js:5-7) computes the average", stance: "asserted", locations: ["calc.js:5-7"], source: "doc-A" },
    { ref: "k2", claim: "mean([]) returns NaN because it divides sum([]) = 0 by xs.length = 0 without a guard.", quote: "returns NaN", stance: "asserted", locations: ["calc.js:6"], source: "doc-A" },
    { ref: "k3", claim: "sum([]) does not throw: reduce starts from the initial value 0.", quote: "sum uses reduce with an initial value 0", stance: "asserted", locations: ["calc.js:2"], source: "doc-B" },
    { ref: "k4", claim: "README.md documents the empty-list behavior.", quote: "README.md describes the helpers", stance: "asserted", locations: ["README.md"], source: "doc-B" },
    { ref: "k5", claim: "The average is computed by mean (calc.js:5).", quote: "The average is mean in calc.js:5", stance: "asserted", locations: ["calc.js:5"], source: "doc-B" },
    { ref: "k6", claim: "calc.js uses two-space indentation.", quote: "two-space indentation", stance: "asserted", locations: [], source: "doc-B" },
  ] as Claim[],
  plan: { entries: [
    { ref: "k1", disposition: "retained", support: "supported", relevance: "finding", qualifiers: ["Numeric arrays only"], evidence: "calc.js:5-7 defines mean.", reason: "Answers the first question.", taskLink: "Question 1" },
    { ref: "k2", disposition: "uncertain", support: "insufficient", relevance: "finding", qualifiers: ["Not executed in the earlier analysis"], evidence: "Code reading only.", reason: "Running mean([]) once would settle it.", taskLink: "Question 2" },
    { ref: "k3", disposition: "added", support: "supported", relevance: "supporting", qualifiers: ["Initial value 0 at calc.js:2"], evidence: "calc.js:2.", reason: "Limits the empty-list consequence.", taskLink: "Question 2 evidence" },
    { ref: "k4", disposition: "corrected", support: "refuted", relevance: "supporting", qualifiers: ["README.md lists helper names only"], evidence: "README.md has no empty-list text.", reason: "README.md does not mention empty lists.", taskLink: "Evidence" },
    { ref: "k5", disposition: "duplicate", support: "supported", relevance: "finding", qualifiers: [], evidence: "Same as k1.", reason: "Same claim as k1.", taskLink: "Question 1", duplicateOf: "k1" },
    { ref: "k6", disposition: "out_of_scope", support: "supported", relevance: "out", qualifiers: [], evidence: "Style.", reason: "Style is outside the task.", taskLink: "None" },
  ] },
};
export async function preflight(): Promise<void> {
  checkInputs();
  const prior = existsSync(join(ROOT, "preflight.json")) ? json(join(ROOT, "preflight.json")) : undefined;
  if (prior?.passed) throw new Error("preflight already passed");
  const n = (prior?.attempts?.length ?? 0) + 1, scratch = join(studyDir(), "preflight", `attempt-${n}`), record = join(ROOT, "preflight", `attempt-${n}`);
  const { ledger } = canonicalLedger("toy", TOY.claims, TOY.plan, {});
  const packet = { "task.md": TOY.task, "guide.md": TOY.guide, "ledger.json": ledgerJson(ledger), "ledger.md": ledgerMarkdown(ledger) };
  const run = (name: string, number: number, model: string, effort: string, prompt: string, inputs: Record<string, string>, pinModel?: string) => turn({ session: join(scratch, name), record: join(record, name), label: `preflight-${n}-${name}`, number, model, effort, prompt, inputs, guard: 20 * 60_000, pinModel });
  const results: any[] = [], failures: string[] = [];
  const note = (name: string, t: Turn, extra: Record<string, unknown> = {}) => { results.push({ name, ok: t.ok, technical: t.technical, routeOk: t.routeOk, finalStop: t.finalStop, effort: t.thinking, thinkingLevels: t.identity?.thinking, routes: t.identity?.routes, aliasUsed: t.identity?.aliasUsed, guard: t.identity?.guard, wire: { requests: t.wire?.requests, costUSD: t.wire?.costUSD, unknownUsage: t.wire?.unknownUsage, routes: t.wire?.routes, updateEfforts: t.wire?.updateEfforts }, ms: t.ms, ...extra }); };
  /** Every request of the turn on `model@effort`, and a non-empty transcript record of exactly that thinking level. */
  const atEffort = (t: Turn, effort: string) => t.ok && Object.keys(t.wire?.routes ?? {}).length > 0 && Object.keys(t.wire?.routes ?? {}).every(r => r.endsWith(`@${effort}`)) && Object.keys(t.wire?.updateEfforts ?? {}).every(e => e === effort) && (t.identity?.thinking ?? []).length > 0 && t.identity.thinking.every((x: string) => x === effort);
  const [b1, c1, neg] = await Promise.all([
    run("b-composer", 1, MODEL, MEASURED_EFFORT, composePrompt("B"), { ...packet, "render.mjs": rendererSource() }),
    run("c-composer", 1, MODEL, MEASURED_EFFORT, composePrompt("C"), packet),
    run("negative", 1, MODEL, MEASURED_EFFORT, "Reply with the single word OK.", { "note.md": "identity preflight\n" }, JUDGES[0]),
  ]);
  let bErrors = checkComposeB(ledger, outputOf(b1, "arrangement.json"));
  note("B compose (fresh)", b1, { arrangementErrors: bErrors });
  let cErrors = checkComposeC(outputOf(c1, "final.md"));
  note("C compose (fresh)", c1, { composeErrors: cErrors });
  note("negative identity (pinned to another model)", neg, { expected: "refused before dispatch" });
  if (!(neg.identity?.guard?.refused > 0 && neg.identity?.guard?.forwarded === 0 && (neg.wire?.requests ?? 0) === 0 && !neg.ok)) failures.push("negative identity turn was not refused before dispatch");
  if (!b1.ok || !c1.ok) failures.push("a fresh composer turn failed technically");
  const toyAudit = JSON.stringify({ defects: [{ id: "D1", kind: "readability", refs: ["k3"], where: "absent", problem: "Place the supporting detail on the initial value next to the open question about empty lists.", fix: "Move k3 into the same section as k2." }] });
  // Continuation shapes of the measured flow: B revise and C mechanical fix (the same templates as the measured continuations).
  const [b2, c2] = await Promise.all([
    run("b-composer", 2, MODEL, MEASURED_EFFORT, B_REVISE, { "audit-1.json": toyAudit }),
    run("c-composer", 2, MODEL, MEASURED_EFFORT, C_FIX.replace("{ERRORS}", "preflight check of the fix continuation: confirm that final.md exists, is the complete answer and mentions no ledger ids; change nothing else"), {}),
  ]);
  bErrors = checkComposeB(ledger, outputOf(b2, "arrangement.json"));
  note("B revise (continuation, same session)", b2, { arrangementErrors: bErrors });
  if (!b2.ok || bErrors.length) failures.push("B continuation failed or left arrangement errors");
  cErrors = checkComposeC(outputOf(c2, "final.md"));
  note("C mechanical fix (continuation, same session)", c2, { composeErrors: cErrors });
  if (!c2.ok || cErrors.length) failures.push("C fix continuation failed or left compose errors");
  const bText = render(ledger, arrangementOf(outputOf(b2, "arrangement.json")).value).text, bCheck = check(ledger, arrangementOf(outputOf(b2, "arrangement.json")).value, bText);
  if (bCheck.errors.length) failures.push(`B render check: ${bCheck.errors.join("; ")}`);
  const cText = outputOf(c2, "final.md") || outputOf(c1, "final.md");
  if (!cText.trim() || cErrors.length) failures.push("C compose produced no clean final.md");
  await mkdir(record, { recursive: true });
  await writeFile(join(record, "toy-B-final.md"), bText); await writeFile(join(record, "toy-C-final.md"), cText); await write(join(record, "toy-B-check.json"), bCheck);
  const ids = ledger.entries.map(e => e.id), jp = { "task.md": TOY.task, "guide.md": TOY.guide, "ledger.json": judgeLedger(ledger), "ledger-background.json": judgeBackground(ledger) };
  const [au, rc, jc, jg, pw] = await Promise.all([
    run("auditor", 1, MODEL, MEASURED_EFFORT, auditPrompt("C"), { ...packet, "final.md": cText }),
    run("recheck", 1, MODEL, MEASURED_EFFORT, recheckPrompt("C"), { ...packet, "final.md": cText, "audit-1.json": toyAudit, "revision.diff": "(no change)\n", "revision-note.md": "D1 rejected: preflight of the recheck stage.\n" }),
    run("judge-claude", 1, JUDGES[0], INSTRUMENT_EFFORT, JUDGE, { ...jp, "text.md": numberLines(bText) }),
    run("judge-gpt", 1, MODEL, INSTRUMENT_EFFORT, JUDGE, { ...jp, "text.md": numberLines(cText) }),
    run("pairwise-claude", 1, JUDGES[0], INSTRUMENT_EFFORT, PAIR, { "task.md": TOY.task, "guide.md": TOY.guide, "answer-X.md": cText, "answer-Y.md": bText }),
  ]);
  const auditErrors = checkAudit(parseJson(outputOf(au, "audit.json")));
  note("C audit (fresh)", au, { auditErrors });
  const recheckErrors = checkAudit(parseJson(outputOf(rc, "audit.json")));
  note("C recheck (fresh)", rc, { auditErrors: recheckErrors });
  // Audit-schema fix continuation shape (the same template as the measured audit-fix and recheck-fix continuations).
  const au2 = await run("auditor", 2, MODEL, MEASURED_EFFORT, AUDIT_FIX.replace("{ERRORS}", "preflight check of the fix continuation: re-validate audit.json (valid JSON with a defects array); keep the same review content"), {});
  const audit2Errors = checkAudit(parseJson(outputOf(au2, "audit.json")));
  note("audit fix (continuation, same session)", au2, { auditErrors: audit2Errors });
  let jcErrors = checkJudgment(ids, parseJson(outputOf(jc, "judgment.json")), bText), jcFix: Turn | undefined;
  if (jc.ok && jcErrors.length) { jcFix = await run("judge-claude", 2, JUDGES[0], INSTRUMENT_EFFORT, JUDGE_FIX.replace("{ERRORS}", jcErrors.join("\n")), {}); jcErrors = checkJudgment(ids, parseJson(outputOf(jcFix, "judgment.json")), bText); }
  note("judge claude (fresh + fix if needed)", jcFix ?? jc, { judgmentErrors: jcErrors, fixUsed: !!jcFix });
  let jgErrors = checkJudgment(ids, parseJson(outputOf(jg, "judgment.json")), cText), jgFix: Turn | undefined;
  if (jg.ok && jgErrors.length) { jgFix = await run("judge-gpt", 2, MODEL, INSTRUMENT_EFFORT, JUDGE_FIX.replace("{ERRORS}", jgErrors.join("\n")), {}); jgErrors = checkJudgment(ids, parseJson(outputOf(jgFix, "judgment.json")), cText); }
  note("judge gpt (fresh + fix if needed)", jgFix ?? jg, { judgmentErrors: jgErrors, fixUsed: !!jgFix });
  const pwErrors = checkPairwise(parseJson(outputOf(pw, "pairwise.json")));
  note("pairwise claude (fresh)", pw, { pairwiseErrors: pwErrors });
  for (const [name, t, errs] of [["audit", au, auditErrors], ["recheck", rc, recheckErrors], ["audit fix", au2, audit2Errors], ["judge claude", jcFix ?? jc, jcErrors], ["judge gpt", jgFix ?? jg, jgErrors], ["pairwise", pw, pwErrors]] as const) if (!t.ok || errs.length) failures.push(`${name}: ${t.ok ? errs.slice(0, 5).join("; ") : t.technical.join("; ")}`);
  // Role-based effort: every measured turn at the measured effort, every instrument turn at max (wire requests and transcript).
  const measured = { "B compose": b1, "C compose": c1, "B revise": b2, "C fix": c2, "C audit": au, "C recheck": rc, "audit fix": au2 }, instrumentTurns = { "judge claude": jc, "judge gpt": jg, "pairwise claude": pw, ...(jcFix ? { "judge claude fix": jcFix } : {}), ...(jgFix ? { "judge gpt fix": jgFix } : {}) };
  const offMeasured = Object.entries(measured).filter(([, t]) => !atEffort(t, MEASURED_EFFORT)).map(([k]) => k), offInstrument = Object.entries(instrumentTurns).filter(([, t]) => !atEffort(t, INSTRUMENT_EFFORT)).map(([k]) => k);
  if (offMeasured.length) failures.push(`measured turns not entirely at ${MEASURED_EFFORT}: ${offMeasured.join(", ")}`);
  if (offInstrument.length) failures.push(`instrument turns not entirely at ${INSTRUMENT_EFFORT}: ${offInstrument.join(", ")}`);
  for (const name of ["b-composer", "c-composer", "negative", "auditor", "recheck", "judge-claude", "judge-gpt", "pairwise-claude"]) await retainSession(join(scratch, name), join(record, name));
  const attempt = { attempt: n, at: new Date().toISOString(), variant: VARIANT.name, measuredEffort: MEASURED_EFFORT, instrumentEffort: INSTRUMENT_EFFORT, passed: failures.length === 0, failures, turns: results };
  await write(join(ROOT, "preflight.json"), { passed: attempt.passed, at: attempt.at, sourceHashes: sourceHashes(), rendererSha256: sha(rendererSource()), pins: json(join(PINS, "pins.json")).hashes, attempts: [...(prior?.attempts ?? []), attempt] });
  console.log(JSON.stringify({ passed: attempt.passed, failures }, null, 1));
}

// ---- manifest, runner, status ----------------------------------------------------------------------------------------------------------
export async function freezeManifest(): Promise<void> {
  if (existsSync(join(ROOT, "manifest.json"))) throw new Error("manifest already frozen");
  checkInputs(); checkPins();
  const pre = json(join(ROOT, "preflight.json"));
  if (pre.passed !== true || JSON.stringify(pre.sourceHashes) !== JSON.stringify(sourceHashes())) throw new Error("preflight did not pass on the current runtime sources");
  const hashOf = (file: string) => sha(text(join(ROOT, file)));
  await write(join(ROOT, "manifest.json"), {
    frozenAt: new Date().toISOString(), protocolSha256: hashOf("protocol.md"), inputsFrozenSha256: hashOf("inputs-frozen.json"), preflightSha256: hashOf("preflight.json"), priorHashesSha256: hashOf("prior-hashes.json"),
    sources: sourceHashes(), rendererSha256: sha(rendererSource()), prompts: promptHashes(), pins: json(join(PINS, "pins.json")).hashes, provider: providerHashes(),
    runtimeNodeModules: treeHashes(join(REPO, "node_modules/@earendil-works/pi-ai")), piVersion: execFileSync(NODE, [PI_CLI, "--version"]).toString().trim(), piCliSha256: sha(readFileSync(PI_CLI)),
    models: JSON.parse(text(join(PINS, "cliproxyapi-models.json"))), liveConfigSha256: sha(readFileSync(join(AGENT, "orche.config.json"))), dirty: execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO }).toString(), guards: GUARDS, model: MODEL, judges: JUDGES, design: { ledgers: LEDGERS, arms: ARMS, reps: REPS },
    ...(VARIANT.baseline ? { variant: VARIANT.name, measuredEffort: MEASURED_EFFORT, instrumentEffort: INSTRUMENT_EFFORT, sessionPrefix: VARIANT.sessionPrefix, inputRoot: VARIANT.inputs, baselineManifestSha256: sha(readFileSync(join(REPO, VARIANT.baseline, "manifest.json"))) } : {}),
  });
}
/**
 * Machine-readable experimental delta of the replication against the max study (written right after its manifest): the intended
 * change, every manifest field that is identical or different, the runtime source hashes and the code diff against baseline-sources/.
 */
export async function writeExperimentalDelta(): Promise<void> {
  if (!VARIANT.baseline) throw new Error("only the replication has a baseline");
  const base = join(REPO, VARIANT.baseline), bm = json(join(base, "manifest.json")), hm = json(join(ROOT, "manifest.json")), bf = json(join(base, "inputs-frozen.json")), hf = json(join(ROOT, "inputs-frozen.json"));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const fields = ["prompts", "rendererSha256", "pins", "provider", "runtimeNodeModules", "piVersion", "piCliSha256", "models", "liveConfigSha256", "guards", "model", "judges", "design"];
  const snapshot = json(join(ROOT, "baseline-sources", "hashes.json")), patches: string[] = [];
  const code = Object.entries<string>(snapshot.files).map(([rel, hash]) => {
    const now = existsSync(join(REPO, rel)) ? sha(readFileSync(join(REPO, rel))) : null;
    if (now !== hash) { try { execFileSync("diff", ["-u", "--label", `max-study/${rel}`, "--label", `replication/${rel}`, join(ROOT, "baseline-sources", rel), join(REPO, rel)]); } catch (e: any) { patches.push(String(e.stdout ?? "")); } }
    return { file: rel, maxStudy: hash, replication: now, changed: now !== hash };
  });
  await writeFile(join(ROOT, "experimental-delta.patch"), patches.join(""));
  await write(join(ROOT, "experimental-delta.json"), {
    at: new Date().toISOString(), maxManifestSha256: sha(readFileSync(join(base, "manifest.json"))), replicationManifestSha256: sha(readFileSync(join(ROOT, "manifest.json"))),
    intendedChange: { factor: "reasoning effort (Pi --thinking / request reasoning.effort) of the measured turns", from: "max", fromSource: "max study protocol §4 and its turn records (every measured request gpt-6-astra@max)", to: MEASURED_EFFORT, measuredStages: ["compose", "compose-fix", "audit", "audit-fix", "revise", "revise-fix", "recheck", "recheck-fix"], instruments: { judges: JUDGES, pairwise: JUDGES, effort: INSTRUMENT_EFFORT, unchanged: true }, sameModel: bm.model === hm.model },
    manifestFields: { identical: fields.filter(f => same(bm[f], hm[f])), different: fields.filter(f => !same(bm[f], hm[f])).map(f => ({ field: f, maxStudy: bm[f], replication: hm[f] })) },
    inputs: { ledgerFileHashesIdentical: same(bf.ledgers, hf.ledgers), rendererIdentical: bf.rendererSha256 === hf.rendererSha256, readInPlaceFrom: hf.inputsReadFrom },
    runtimeSources: { changed: Object.keys(hm.sources).filter(k => hm.sources[k] !== bm.sources[k]), unchanged: Object.keys(hm.sources).filter(k => hm.sources[k] === bm.sources[k]) },
    code, patch: "experimental-delta.patch",
    infrastructureDifferences: [
      "experiment-scoped variant switch and per-role effort in delivery-runtime.ts / delivery.ts / delivery-eval.ts (default max behaviour kept; see patch)",
      `session ids prefixed ${VARIANT.sessionPrefix}- instead of dv- (Pi session id = provider prompt_cache_key; avoids prompt-cache coupling with the max study)`,
      "sandbox agent settings default thinking level set to the turn's level (no-op at max)",
      "cached-turn reuse also checks the recorded model and thinking level",
      "preflight additionally exercises recheck, C fix and audit-fix continuations and checks per-role efforts (not measured)",
      "host-verifier masking sentence names this namespace and forbids the max study's namespace",
      "historical Q final judgments reused from the max study (not judged again)",
      "run date about one day after the max study; provider-side state not observable; no contemporaneous max control",
    ],
  });
}
export function checkManifest(): void {
  const m = json(join(ROOT, "manifest.json"));
  if (JSON.stringify(m.sources) !== JSON.stringify(sourceHashes())) throw new Error("runtime source changed after the manifest");
  if (sha(rendererSource()) !== m.rendererSha256) throw new Error("renderer changed after the manifest");
  if (JSON.stringify(m.prompts) !== JSON.stringify(promptHashes())) throw new Error("prompts changed after the manifest");
  if (VARIANT.baseline && (m.measuredEffort !== MEASURED_EFFORT || m.instrumentEffort !== INSTRUMENT_EFFORT)) throw new Error("efforts differ from the frozen manifest");
  checkInputs(); checkPins();
}
async function withLock(name: string, job: () => Promise<void>): Promise<void> {
  const lock = join(studyDir(), `${name}-lock.json`);
  if (existsSync(lock)) { const l = json(lock); let alive = false; try { process.kill(l.pid, 0); alive = true; } catch { /* gone */ } if (alive) throw new Error(`runner alive pid=${l.pid}`); }
  await write(lock, { pid: process.pid, startedAt: new Date().toISOString(), command: process.argv });
  await job();
  await write(join(studyDir(), `${name}-finished.json`), { at: new Date().toISOString(), pid: process.pid });
}
/** One job's harness error is logged and recorded; it never ends the runner while other sandboxes are in flight. */
const settled = (name: string, job: Promise<void>) => job.catch(async e => { console.error(`${name}: harness error ${String(e)}`); await mkdir(join(ROOT, "harness-errors"), { recursive: true }); await write(join(ROOT, "harness-errors", `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}-${Date.now()}.json`), { name, error: String(e), at: new Date().toISOString() }); });
export async function runAll(): Promise<void> {
  checkManifest();
  await withLock("run", () => Promise.all(LEDGERS.flatMap(l => REPS.flatMap(rep => ARMS.map(arm => settled(`${l.id}-${arm}-r${rep}`, cell(l.id, arm, rep)))))).then(() => undefined));
}
export async function instruments(): Promise<void> {
  checkManifest();
  await withLock("instruments", async () => {
    const jobs: Promise<void>[] = [];
    for (const l of LEDGERS) {
      for (const rep of REPS) for (const arm of ARMS) for (const m of JUDGES) jobs.push(settled(`judge-${l.id}-${arm}-r${rep}-${family(m)}`, judge(l.id, `${arm}-r${rep}`, m)));
      for (const rep of REPS) for (const m of JUDGES) jobs.push(settled(`pairwise-${l.id}-r${rep}-${family(m)}`, pairwise(l.id, rep, m)));
    }
    await Promise.all(jobs);
    // Historical Q finals: descriptive context only, judged after the measured texts. The replication reuses the max study's
    // judgments of the same three texts (same instrument); it never judges them again.
    if (!VARIANT.baseline) await Promise.all(LEDGERS.flatMap(l => JUDGES.map(m => settled(`judge-${l.id}-hist-${family(m)}`, judge(l.id, "hist", m)))));
  });
}
export function status(): void {
  for (const l of LEDGERS) {
    const cells = REPS.flatMap(rep => ARMS.map(arm => { const f = join(ROOT, "runs", l.id, `${arm}-r${rep}`, "pipeline.json"); return `${arm}${rep}:${existsSync(f) ? json(f).status : "pending"}`; }));
    const judged = ["C-r1", "C-r2", "B-r1", "B-r2", "hist"].map(label => `${label}:${JUDGES.map(m => { const f = join(ROOT, "judgments", l.id, `${label}.${family(m)}.json`); return existsSync(f) ? (json(f).valid ? "V" : "X") : "."; }).join("")}`);
    console.log(l.id, cells.join(" "), "| judges", judged.join(" "));
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, scratch] = process.argv.slice(2);
  if (!scratch) throw new Error("study scratch path required");
  setStudy(scratch);
  if (cmd === "prepare") { await prepare(); await setup(scratch); await freezePins(); }
  else if (cmd === "preflight") { await setup(scratch); await preflight(); }
  else if (cmd === "manifest") { await freezeManifest(); if (VARIANT.baseline) await writeExperimentalDelta(); }
  else if (cmd === "run") { await setup(scratch); await runAll(); }
  else if (cmd === "instruments") { await setup(scratch); await instruments(); }
  else if (cmd === "status") status();
  else throw new Error("prepare | preflight | manifest | run | instruments | status");
}
