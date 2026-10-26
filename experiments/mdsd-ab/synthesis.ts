/**
 * Synthesis-only validation (protocol: results/synthesis-validation/protocol.md, frozen with manifest.json before any measured run).
 * The frozen material of results/quality-validation (per unit: the task, the strong answer S and the independent exploration E as
 * the integration stage A read them, P1.md/P2.md, and their registered claims) is integrated again WITHOUT new exploration by:
 *   C  the current generative integration: origin-blinded P1/P2, every claim accounted for in a findings ledger (provenance or
 *      dropped with a reason; MDSD caps of 80 findings x 30 refs), a final answer written freely; then an independent free-form
 *      review, a free revision and an independent re-review (the review-opportunity/compute control). Texts: C0 (draft), C1 (final).
 *   T  the proposed integration: S is the editing base (final.md starts as S's text), a per-claim content plan whose retained
 *      claims point to verbatim spans of final.md, an independent two-directional audit, a local repair and an independent
 *      recheck. Texts: Tpre (draft), T (final).
 * Every measured session is a fresh `pi` process without orche, in its own bubblewrap sandbox, agent dir, scratch and target copy,
 * through the logging proxy, on cliproxyapi/gpt-6-astra at thinking max. Revisions and repairs continue the composer's session.
 * The texts are judged by statement-realization judges of two model families (Tier 1, evaluation instrument, not measured).
 *
 *   node --import tsx experiments/mdsd-ab/synthesis.ts prepare <study>
 *   node --import tsx experiments/mdsd-ab/synthesis.ts preflight <study>
 *   node --import tsx experiments/mdsd-ab/synthesis.ts all <study> [concurrency]
 *   node --import tsx experiments/mdsd-ab/synthesis.ts status <study>
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MdsdSeedClaim } from "../../src/orchestrator/mdsd-config.js";
import { contentHashes, hashDiff, piArgs, redact, sandboxEnv, sessionTranscripts, snapshot, wireStats } from "./matrix.js";
import { AGENT, HOME, PI_CLI, NODE, REPO, TARGET_MOUNT, agentDir, catalogEntries, filesUnder, readJsonl, runGuarded, sandboxArgs, sha, startProxy, write } from "./run.js";

export const COMPOSER_MODEL = "cliproxyapi/gpt-6-astra";
export const JUDGE_MODELS = ["cliproxyapi/claude-opus-5-5", "cliproxyapi/gpt-6-astra"] as const;
export const QV = join(REPO, "results/quality-validation");
export const RESULTS = join(REPO, "results/synthesis-validation");
export const UNITS = ["dev-r1", "isort-r1", "isort-r2"] as const;
export const REPS = [1, 2] as const;
export type Arm = "C" | "T";
type CaseId = "dev" | "isort" | "toy" | "none";
const PROVIDER_PKG = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
const ISORT = { cache: join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491"), mount: join(HOME, "Code/isort"), venv: join(HOME, ".venvs/isort") };
const MIN = 60_000;
/** Anti-loop process guards (time only; no money, request or output ceiling). */
export const GUARDS = { compose: 180 * MIN, review: 150 * MIN, revise: 120 * MIN, recheck: 120 * MIN, fix: 60 * MIN, judge: 120 * MIN };

// ---- prompts (preregistered: the manifest hashes every one) ------------------------------------------------------------------------
export const COMMON = [
  "This is one stage of a read-only analysis workflow. The current directory is the repository the task is about. Inputs are in /tmp/pi-orche/input (read-only); write your files to /tmp/pi-orche/work; use /tmp/pi-orche/tmp for scratch files (scripts, probe inputs, copies).",
  "Rules:",
  "- Do not modify, create or delete files in the repository (the current directory).",
  "- This stage synthesizes existing analyses; it is not a new investigation. Use the repository and tools only to check registered claims and conflicts between them (read code, run the program on small inputs, run existing tests). Do not search for new defects. If while checking you observe something that no registered claim covers, it may appear only under a heading \"New observations during checking\", with its evidence.",
  "- Evidence of record: a claim's own quote, file:line locations and reported reproductions in P1.md/P2.md, and your own checks. Check with tools where claims conflict, where a claim lacks evidence, or where you doubt it. A claim counts as confirmed only with evidence; a claim that was not refuted is not thereby confirmed: call it unverified.",
  "- Write in English.",
].join("\n");
export const INPUTS = [
  "Inputs (read all of them completely; use several reads with offset for long files):",
  "- /tmp/pi-orche/input/task.md: the task, verbatim.",
  "- /tmp/pi-orche/input/P1.md and P2.md: the final answers of two earlier analyses of exactly this task, made independently of each other (run-internal references are masked as [ref]).",
  "- /tmp/pi-orche/input/claims.json (and the compact claims.md): every claim extracted from P1 and P2, refs P1:c1…, P2:c1…, with its stance (asserted, uncertain or rejected), a verbatim quote from its answer and the locations it cites. None of them is verified, and agreement between P1 and P2 is not proof.",
].join("\n");
const DONE = "When the files are written, reply with a short note that you are done.";

/** C: the current integration (INTEGRATION_PROTOCOL items 1 and 4 of quality.ts, without the search round; MDSD's ledger contract). */
export const C_COMPOSE = [
  "Your job: produce the best possible final answer to the task from P1 and P2.",
  "1. Account for every registered claim with evidence: confirm it (its own evidence or your check), correct it (state the corrected claim and the evidence), keep it explicitly unverified or disputed when it stays open, or drop it with the evidence that refutes it, shows it outside the task's scope, or shows it duplicates another. A claim that was not refuted is not thereby confirmed.",
  "2. Write /tmp/pi-orche/work/final.md: the complete final answer to the user, self-contained (the user will not see P1, P2 or the claims; do not mention claim refs). It states every confirmed finding with its evidence (file:line, reproduction), the corrected claims, the rejected claims with the reason, and what stays uncertain. Do not omit a confirmed finding because an earlier analysis already stated it.",
  "3. Write /tmp/pi-orche/work/ledger.json: {\"findings\":[{\"id\":\"F1\",\"statement\":\"…\",\"status\":\"confirmed|refuted|unverified|disputed\",\"evidence\":\"…\",\"dissent\":\"… (disputed only)\",\"provenance\":[\"P1:c3\",\"P2:c7\"]}],\"dropped\":[{\"ref\":\"P2:c9\",\"reason\":\"…\"}]}. At most 80 findings and at most 30 provenance refs per finding. Every registered ref appears in some finding's provenance or in dropped with a reason. A confirmed or refuted finding needs evidence; a disputed one needs the dissent.",
  DONE,
].join("\n");
export const C_REVIEW = [
  "Your job: review the draft final answer /tmp/pi-orche/input/final.md (with its ledger /tmp/pi-orche/input/ledger.json), which another session wrote from P1 and P2. Review it as a demanding reviewer: errors, statements not supported by evidence, content outside the task's scope, valid content of P1/P2 that is missing or weakened, contradictions, and uncertainty stated wrongly (unverified presented as confirmed, or the reverse). Check against the inputs and, where needed, the code. Do not edit final.md.",
  "Write /tmp/pi-orche/work/review.json: {\"problems\":[{\"id\":\"R1\",\"kind\":\"error|unsupported|out_of_scope|missing|weakened|contradiction|uncertainty|other\",\"where\":\"a verbatim excerpt of final.md, or absent\",\"refs\":[\"P1:c4\"],\"problem\":\"…\",\"suggestion\":\"…\"}]} (an empty list if you find none).",
  DONE,
].join("\n");
export const C_REVISE = [
  "An independent reviewer checked your final answer; its review is /tmp/pi-orche/input/review-1.json. Revise /tmp/pi-orche/work/final.md and ledger.json to address the problems you agree with, in whatever way you judge best. The same rules and the same ledger contract apply. Then reply with a short note: what you changed, and which problems you rejected and why.",
].join("\n");
export const C_REREVIEW = [
  "Your job: check a revision. /tmp/pi-orche/input/final.md (with ledger.json) was revised after an independent review (/tmp/pi-orche/input/review-1.json); the change is /tmp/pi-orche/input/revision.diff and the reviser's note is /tmp/pi-orche/input/revision-note.md. Decide for each problem of the review whether it is now resolved (or rightly rejected). Then check the changed passages for new problems (errors, unsupported or out-of-scope statements, contradictions, uncertainty stated wrongly) and check that the revision removed or weakened no valid content. Check against the inputs and, where needed, the code. Do not edit final.md.",
  "Write /tmp/pi-orche/work/review.json in the same format ({\"problems\":[…]}) with the problems that remain or are new (an empty list if none).",
  DONE,
].join("\n");
/** T: the proposed integration. `{BASE}`/`{OTHER}` are replaced by P1.md/P2.md per unit (S is the base). */
export const T_COMPOSE = [
  "Your job: produce the final answer by integrating the other analysis into the baseline while preserving the baseline. BASE = /tmp/pi-orche/input/{BASE} (a strong earlier answer, the editing base); OTHER = /tmp/pi-orche/input/{OTHER} (an independent analysis). /tmp/pi-orche/work/final.md has been initialized as a verbatim copy of BASE.",
  "1. Content plan first. Give every registered claim (BASE's and OTHER's) exactly one disposition:",
  "   - retained: a BASE claim that stays as BASE states it (with BASE's own conditions and uncertainty).",
  "   - corrected: a claim contradicted by evidence; final.md states the corrected version and says explicitly that the earlier statement was wrong, with the evidence.",
  "   - added: an OTHER claim relevant to the task and adequately supported (its own evidence or your check) whose content BASE does not already express.",
  "   - uncertain: a relevant claim kept in final.md explicitly marked as unverified or disputed (say what would settle it); never present it as confirmed. Prefer checking a relevant claim over leaving it uncertain.",
  "   - duplicate: its full content (conditions, qualifiers, consequence and status included) is already expressed by another claim that is realized; name that claim. A claim that adds a condition, a boundary, a consequence or a dissenting view is not a duplicate.",
  "   - out_of_scope: outside what the task asks; give the reason; it does not appear in the answer body.",
  "   - refuted: shown false by evidence; give the evidence. When a BASE claim is refuted, final.md says explicitly that it is wrong.",
  "   - unsupported: an OTHER claim not added because its support is inadequate and it would not help the user as an open question; give the reason.",
  "2. Edit final.md minimally to realize the plan. Keep BASE's wording, structure, conditions, boundaries, negations (\"X is not affected\") and stated uncertainty wherever BASE is right. Change a BASE passage only to correct it, to mark it uncertain, to remove out-of-scope material, or to insert an addition next to related content (or in a section of additional findings), each addition with its evidence. Use targeted edits; never rewrite final.md as a whole, and do not compress or summarize BASE content.",
  "3. Write /tmp/pi-orche/work/plan.json: {\"entries\":[{\"ref\":\"P1:c1\",\"disposition\":\"retained|corrected|added|uncertain|duplicate|out_of_scope|refuted|unsupported\",\"spans\":[\"verbatim excerpt of final.md\"],\"duplicateOf\":\"P2:c3\",\"evidence\":\"…\",\"reason\":\"…\"}]} with exactly one entry per registered claim. spans are required for retained, corrected, added, uncertain and for a refuted BASE claim: each is copied exactly from final.md (at least four words) and together they express the claim completely, including its conditions and status. evidence is required for corrected, refuted and added; reason for out_of_scope, unsupported and duplicate; duplicateOf for duplicate.",
  "4. final.md is the complete answer to the user: self-contained (the user will not see P1, P2 or the claims) and without claim refs.",
  DONE,
].join("\n");
export const T_AUDIT = [
  "Your job: an independent two-directional audit of a final answer against its content plan. Besides the task, P1, P2 and the claims you get /tmp/pi-orche/input/final.md (the answer; it started as a copy of BASE = {BASE}) and /tmp/pi-orche/input/plan.json (one entry per registered claim: its disposition and the spans of final.md said to express it).",
  "A) Claims to text, for every plan entry: retained, corrected, added, uncertain: does final.md express the claim completely (its conditions, qualifiers, boundaries, negations, consequence and status)? Spans that exist but do not carry the meaning do not count. duplicate: is the full content really expressed by the named claim's realization? out_of_scope, refuted, unsupported: are the reason and evidence right? Dropping a valid, in-scope, adequately supported claim is a defect; a refuted BASE claim needs an explicit correction in the text.",
  "B) Text to evidence, for every substantive statement of final.md: is it supported (by a registered claim's evidence or your check), within the task's scope, and consistent with the rest of the text? Flag unsupported statements, out-of-scope material, contradictions, and any unverified or merely unrefuted claim presented as confirmed.",
  "Check against the inputs and, where needed, the code. Do not edit final.md or plan.json.",
  "Write /tmp/pi-orche/work/audit.json: {\"defects\":[{\"id\":\"D1\",\"kind\":\"absent|partial|bad_duplicate|unjustified_drop|missing_correction|unsupported|out_of_scope|contradiction|status_upgrade|other\",\"refs\":[\"P1:c4\"],\"where\":\"a verbatim excerpt of final.md, or absent\",\"problem\":\"…\",\"fix\":\"the smallest local change that fixes it\"}],\"checked\":{\"entries\":0,\"statements\":0}} (an empty defects list if there are none).",
  DONE,
].join("\n");
export const T_REPAIR = [
  "An independent auditor checked final.md against plan.json in both directions; its defects are in /tmp/pi-orche/input/audit-1.json. Repair them locally: for each defect you agree with, change only the affected passage of final.md with targeted edits (or insert the missing content next to related content) and update the affected plan.json entries. Do not rewrite, reorganize or shorten unaffected text. The plan contract still applies (one entry per registered claim, exact spans). Then reply with a short note listing each defect as fixed or rejected, with the reason for each rejection.",
].join("\n");
export const T_RECHECK = [
  "Your job: check a repair. /tmp/pi-orche/input/final.md and plan.json were repaired after an independent audit (/tmp/pi-orche/input/audit-1.json); the change is /tmp/pi-orche/input/revision.diff and the repairer's note is /tmp/pi-orche/input/revision-note.md. BASE = {BASE} was final.md's starting point. Decide for each defect of the audit whether it is now fixed (or rightly rejected). Then check the changed passages for new problems (unsupported or out-of-scope statements, contradictions, status upgrades, spans that no longer carry their claim) and check that the repair removed or weakened no valid content. Check against the inputs and, where needed, the code. Do not edit final.md or plan.json.",
  "Write /tmp/pi-orche/work/audit.json in the same format ({\"defects\":[…]}) with the defects that remain or are new (an empty list if none).",
  DONE,
].join("\n");
export const LEDGER_FIX = "The report check of ledger.json failed:\n{ERRORS}\nFix /tmp/pi-orche/work/ledger.json (and final.md only if needed) so that it meets the ledger contract. Reply with a short note when done.";
export const PLAN_FIX = "The mechanical plan check failed:\n{ERRORS}\nFix /tmp/pi-orche/work/plan.json so that it meets the plan contract (every span copied exactly from final.md); change final.md only where a planned claim is not yet expressed, with a targeted edit. Reply with a short note when done.";
/** Tier-1 judge (evaluation instrument): realization of every S and E statement in one text, origin-blind. */
export const JUDGE = [
  "You check which statements a text expresses, for an evaluation. You do not judge whether the statements are true.",
  "Files: /tmp/pi-orche/input/task.md (the task the text answers, for context only); /tmp/pi-orche/input/text.md (the text; every line starts with a line number \"L<n>: \" that is not part of the text); /tmp/pi-orche/input/statements.json (statements q1… from earlier analyses of the same task; stance asserted, uncertain or rejected means the earlier analysis asserted it, left it uncertain, or said it is false / not a defect).",
  "Read the whole text first (several reads with offset if it is long). Then judge every statement as worded, including its stance (for a rejected statement 'X is not a defect', a text that says X is not a defect expresses it, and a text that says X is a defect opposes it):",
  "- complete: the text expresses its full substantive content: its conditions, qualifiers, boundaries, negations, consequence and specifics (file, function, input, setting), in any wording, possibly spread over several places;",
  "- partial: the core is there, but a substantive element is missing or changed (a condition, a boundary, the consequence, a specific location or input, a negation), or it is stated with a different status (uncertain as confirmed, or the reverse);",
  "- missing: the text does not express it;",
  "- opposed: the text says the opposite, or says it is false or refuted.",
  "textStance is how the text presents that content: asserted, uncertain (hedged, unverified, disputed), rejected (said to be false or not a defect), or none when missing.",
  "Then list the other substantive claims of the text that no statement expresses (new content about the code or the task, not formatting or process remarks), and any two passages of the text that contradict each other.",
  "Write /tmp/pi-orche/out/judgment.json: {\"statements\":[{\"id\":\"q1\",\"realization\":\"complete|partial|missing|opposed\",\"textStance\":\"asserted|uncertain|rejected|none\",\"lines\":[12],\"quote\":\"verbatim excerpt of the text without the line prefix, 5 to 50 words (empty when missing)\",\"note\":\"for partial and opposed: what is missing or different\"}],\"other\":[{\"claim\":\"…\",\"lines\":[40],\"quote\":\"…\"}],\"contradictions\":[{\"a\":\"quote\",\"b\":\"quote\",\"note\":\"…\"}]} with exactly one entry per statement. You may build it in steps (e.g. a JSONL file converted with a script), but the final file must be valid JSON. Reply \"done\" when the file is written.",
].join("\n");
export const JUDGE_FIX = "The file /tmp/pi-orche/out/judgment.json is not usable:\n{ERRORS}\nFix it (one entry per statement id, valid JSON, the fields as specified). Reply \"done\" when the file is written.";

// ---- pure helpers (unit-tested) ----------------------------------------------------------------------------------------------------
export const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
/** A span counts as found when its word-normalized form (at least `min` words) occurs in the word-normalized text. */
export function spanFound(span: unknown, text: string, min = 4): boolean {
  if (typeof span !== "string") return false;
  const normalized = words(span);
  return normalized.split(" ").filter(Boolean).length >= min && words(text).includes(normalized);
}
export const numberLines = (text: string) => text.split("\n").map((line, index) => `L${index + 1}: ${line}`).join("\n");
export const claimsMarkdown = (claims: MdsdSeedClaim[]) => claims.map(claim => `- ${claim.ref} [${claim.stance ?? "asserted"}] ${claim.claim}${claim.locations?.length ? ` (locations: ${claim.locations.join("; ")})` : ""}`).join("\n") + "\n";
const STATUSES = new Set(["confirmed", "refuted", "unverified", "disputed"]);
/** The current MDSD report gate on the ledger (accounting, caps, evidence/dissent presence); semantic correctness is not checked. */
export function checkLedger(refs: string[], ledger: any): { errors: string[]; stats: Record<string, number> } {
  const errors: string[] = [];
  const findings: any[] = Array.isArray(ledger?.findings) ? ledger.findings : [];
  const dropped: any[] = Array.isArray(ledger?.dropped) ? ledger.dropped : [];
  if (!Array.isArray(ledger?.findings)) errors.push("ledger.json has no findings array");
  if (findings.length > 80) errors.push(`${findings.length} findings; at most 80`);
  const known = new Set(refs), kept = new Set<string>(), drops = new Set<string>();
  findings.forEach((finding, index) => {
    const id = String(finding?.id ?? `#${index + 1}`);
    const provenance: unknown[] = Array.isArray(finding?.provenance) ? finding.provenance : [];
    if (provenance.length > 30) errors.push(`${id}: ${provenance.length} provenance refs; at most 30`);
    if (!STATUSES.has(finding?.status)) errors.push(`${id}: status must be confirmed, refuted, unverified or disputed`);
    if ((finding?.status === "confirmed" || finding?.status === "refuted") && !String(finding?.evidence ?? "").trim()) errors.push(`${id}: ${finding.status} without evidence`);
    if (finding?.status === "disputed" && !String(finding?.dissent ?? "").trim()) errors.push(`${id}: disputed without the dissent`);
    for (const ref of provenance) { if (typeof ref !== "string" || !known.has(ref)) errors.push(`${id}: unknown provenance ref ${String(ref)}`); else kept.add(ref); }
  });
  for (const drop of dropped) {
    if (typeof drop?.ref !== "string" || !known.has(drop.ref)) errors.push(`dropped: unknown ref ${String(drop?.ref)}`);
    else if (!String(drop?.reason ?? "").trim()) errors.push(`dropped ${drop.ref}: no reason`);
    else drops.add(drop.ref);
  }
  const missing = refs.filter(ref => !kept.has(ref) && !drops.has(ref));
  if (missing.length) errors.push(`${missing.length} registered refs neither in a finding's provenance nor dropped: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", …" : ""}`);
  return { errors, stats: { findings: findings.length, kept: kept.size, dropped: drops.size, both: [...kept].filter(ref => drops.has(ref)).length, unaccounted: missing.length } };
}
export const DISPOSITIONS = ["retained", "corrected", "added", "uncertain", "duplicate", "out_of_scope", "refuted", "unsupported"] as const;
const REALIZED = new Set(["retained", "corrected", "added", "uncertain"]);
/** The plan contract of T, checked mechanically: one entry per ref, spans found verbatim, required fields present. Meaning is not checked. */
export function checkPlan(refs: string[], baseLabel: string, plan: any, final: string): { errors: string[]; stats: Record<string, number> } {
  const errors: string[] = [];
  const entries: any[] = Array.isArray(plan?.entries) ? plan.entries : Array.isArray(plan) ? plan : [];
  if (!entries.length) errors.push("plan.json has no entries array");
  const known = new Set(refs), seen = new Map<string, any>();
  for (const entry of entries) {
    const ref = entry?.ref;
    if (typeof ref !== "string" || !known.has(ref)) { errors.push(`unknown ref ${String(ref)}`); continue; }
    if (seen.has(ref)) errors.push(`${ref}: more than one entry`);
    seen.set(ref, entry);
  }
  const stats: Record<string, number> = Object.fromEntries(DISPOSITIONS.map(name => [name, 0]));
  let spans = 0, spansFound = 0;
  for (const [ref, entry] of seen) {
    const disposition = entry?.disposition;
    if (!(DISPOSITIONS as readonly string[]).includes(disposition)) { errors.push(`${ref}: unknown disposition ${String(disposition)}`); continue; }
    stats[disposition] = (stats[disposition] ?? 0) + 1;
    const list: unknown[] = Array.isArray(entry.spans) ? entry.spans : typeof entry.spans === "string" ? [entry.spans] : [];
    const needsSpan = REALIZED.has(disposition) || (disposition === "refuted" && ref.startsWith(`${baseLabel}:`));
    if (needsSpan && !list.length) errors.push(`${ref} (${disposition}): no span`);
    for (const span of list) { spans++; if (spanFound(span, final)) spansFound++; else errors.push(`${ref}: span not found verbatim in final.md (or under four words): "${String(span).slice(0, 120)}"`); }
    if ((disposition === "corrected" || disposition === "refuted" || disposition === "added") && !String(entry.evidence ?? "").trim()) errors.push(`${ref} (${disposition}): no evidence`);
    if ((disposition === "out_of_scope" || disposition === "unsupported") && !String(entry.reason ?? "").trim()) errors.push(`${ref} (${disposition}): no reason`);
    if (disposition === "duplicate") {
      const target = seen.get(String(entry.duplicateOf ?? ""));
      if (!target || entry.duplicateOf === ref) errors.push(`${ref} (duplicate): duplicateOf names no other registered claim`);
      else if (!REALIZED.has(target.disposition)) errors.push(`${ref} (duplicate): ${entry.duplicateOf} is not realized (${String(target.disposition)})`);
    }
  }
  const missing = refs.filter(ref => !seen.has(ref));
  if (missing.length) errors.push(`${missing.length} registered refs without an entry: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", …" : ""}`);
  return { errors, stats: { ...stats, entries: seen.size, missing: missing.length, spans, spansFound } };
}
/** Share of BASE's non-empty lines that survive verbatim (as lines) in a text: a mechanical measure of editing versus rewriting. */
export function linesKept(base: string, text: string): { lines: number; kept: number } {
  const lines = base.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  const have = new Set(text.split("\n").map(line => line.trim()));
  return { lines: lines.length, kept: lines.filter(line => have.has(line)).length };
}
export interface Statement { id: string; origin: string; stance: string; statement: string; locations: string[] }
/** S and E claims as origin-blind statements q1…, in an order fixed by the unit's hash; the key maps q-ids back to S:c… / E:c…. */
export function statementsOf(unit: string, sets: Record<"S" | "E", { id: string; claim: string; stance: string; locations: string[] }[]>): { statements: Statement[]; key: Record<string, string> } {
  const all = (["S", "E"] as const).flatMap(origin => sets[origin].map(claim => ({ origin: `${origin}:${claim.id}`, claim })));
  all.sort((a, b) => sha(`${unit}:statement:${a.origin}`).localeCompare(sha(`${unit}:statement:${b.origin}`)));
  const key: Record<string, string> = {};
  const statements = all.map((item, index) => { const id = `q${index + 1}`; key[id] = item.origin; return { id, origin: item.origin, stance: item.claim.stance, statement: item.claim.claim, locations: item.claim.locations }; });
  return { statements, key };
}
const REALIZATIONS = new Set(["complete", "partial", "missing", "opposed"]);
/** A judge's judgment, validated: one entry per statement, known values, quotes found in the text (without the line prefixes). */
export function checkJudgment(ids: string[], judgment: any, text: string): { errors: string[]; byId: Map<string, any>; quotesFound: number; quotesNeeded: number } {
  const errors: string[] = [], byId = new Map<string, any>();
  const known = new Set(ids);
  const list: any[] = Array.isArray(judgment?.statements) ? judgment.statements : [];
  if (!Array.isArray(judgment?.statements)) errors.push("no statements array");
  for (const entry of list) {
    if (!known.has(entry?.id)) { errors.push(`unknown id ${String(entry?.id)}`); continue; }
    if (byId.has(entry.id)) errors.push(`${entry.id}: more than one entry`);
    if (!REALIZATIONS.has(entry.realization)) errors.push(`${entry.id}: realization must be complete, partial, missing or opposed`);
    byId.set(entry.id, entry);
  }
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) errors.push(`${missing.length} statements without an entry: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", …" : ""}`);
  let quotesFound = 0, quotesNeeded = 0;
  for (const entry of byId.values()) if (entry.realization !== "missing") { quotesNeeded++; if (spanFound(entry.quote, text, 3)) quotesFound++; }
  return { errors, byId, quotesFound, quotesNeeded };
}

// ---- inputs ------------------------------------------------------------------------------------------------------------------------
export interface UnitInput { unit: string; caseId: "dev" | "isort" | "toy"; task: string; P1: string; P2: string; claims: MdsdSeedClaim[]; baseLabel: "P1" | "P2"; hashes: Record<string, string> }
export function unitInput(unit: string): UnitInput {
  const caseId = unit.startsWith("dev") ? "dev" : "isort";
  const seed = JSON.parse(readFileSync(join(QV, unit, "seed.json"), "utf8"));
  const meta = JSON.parse(readFileSync(join(QV, unit, "A/meta.json"), "utf8"));
  const task = readFileSync(join(QV, "eval/inputs", caseId === "dev" ? "task-dev.md" : "task-isort.md"), "utf8");
  const P1 = readFileSync(join(QV, unit, "A/prior/P1.md"), "utf8"), P2 = readFileSync(join(QV, unit, "A/prior/P2.md"), "utf8");
  // The frozen inputs are exactly what stage A read: the prior files' hashes, the seed's hash and the task body's hash.
  if (sha(P1) !== meta.priorSha256?.["P1.md"] || sha(P2) !== meta.priorSha256?.["P2.md"]) throw new Error(`${unit}: prior files differ from A's`);
  if (sha(JSON.stringify(seed.seed)) !== seed.sha256) throw new Error(`${unit}: seed hash mismatch`);
  const body = JSON.parse(readFileSync(join(QV, unit, "S/meta.json"), "utf8")).bodySha256;
  if (sha(task) !== body) throw new Error(`${unit}: task differs from the stages' body`);
  const baseLabel = seed.key.P1 === "S" ? "P1" : "P2";
  return { unit, caseId, task, P1, P2, claims: seed.seed.claims, baseLabel, hashes: { task: sha(task), P1: sha(P1), P2: sha(P2), seed: seed.sha256 } };
}
export const TOY: UnitInput = {
  unit: "toy", caseId: "toy", task: "Read-only question about the small repository in the current directory: which function in calc.js computes the average, and does it handle an empty list? Answer with file:line evidence; do not change files.\n",
  P1: "# Final message to the user\n\n`mean` (calc.js:5-7) computes the average. It does not handle an empty list: `mean([])` divides `sum([]) = 0` by `xs.length = 0` and returns NaN (calc.js:6).\n",
  P2: "# Final message to the user\n\nThe average is `mean` in calc.js:5. For an empty list it returns NaN (0/0). `sum` uses reduce with an initial value 0 (calc.js:2), so `sum([])` is 0. README.md describes the helpers.\n",
  claims: [
    { ref: "P1:c1", claim: "mean in calc.js:5-7 computes the average.", stance: "asserted", locations: ["calc.js:5-7"] },
    { ref: "P1:c2", claim: "mean([]) returns NaN because it divides sum([]) = 0 by xs.length = 0 without a guard.", stance: "asserted", locations: ["calc.js:6"] },
    { ref: "P2:c1", claim: "sum uses reduce with initial value 0, so sum([]) is 0.", stance: "asserted", locations: ["calc.js:2"] },
    { ref: "P2:c2", claim: "README.md describes the helpers.", stance: "asserted", locations: ["README.md"] },
  ],
  baseLabel: "P1", hashes: {},
};

// ---- one pi process ----------------------------------------------------------------------------------------------------------------
const finalText = (events: any[]): string => {
  let text = "";
  for (const event of events) { const message = event?.message; if (event?.type === "message_end" && message?.role === "assistant" && Array.isArray(message.content)) { const part = message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join(""); if (part.trim()) text = part; } }
  return text;
};
async function makeTarget(dir: string, caseId: CaseId): Promise<{ dir: string; mount: string; extra: string[]; nodeModules: boolean }> {
  if (caseId === "isort") { const target = join(dir, "target"); await cp(join(ISORT.cache, "src"), target, { recursive: true }); return { dir: target, mount: ISORT.mount, extra: ["--ro-bind", join(ISORT.cache, "venv"), ISORT.venv], nodeModules: false }; }
  if (caseId === "dev" || caseId === "toy") { const target = await snapshot(dir, caseId === "toy"); return { dir: target.dir, mount: TARGET_MOUNT, extra: [], nodeModules: true }; }
  const target = join(dir, "target"); await mkdir(target, { recursive: true }); return { dir: target, mount: join(HOME, "work"), extra: [], nodeModules: false };
}
function prices(): Record<string, unknown> {
  const catalog = catalogEntries(JSON.parse(readFileSync(join(AGENT, "cliproxyapi-models.json"), "utf8")));
  return Object.fromEntries([COMPOSER_MODEL, ...JUDGE_MODELS].map(ref => ref.split("/")[1]!).map(id => { const entry = catalog.find(item => item.id === id); if (!entry) throw new Error(`${id} is not in the CLIProxyAPI catalog`); if (entry.thinkingLevelMap?.max !== "max") throw new Error(`${id}: thinking max is not mapped to max`); return [id, entry.cost]; }));
}
/** The secrets a session directory could hold (the CLIProxyAPI key, TypeSafe credentials), for redaction of kept records. */
function secrets(): string[] {
  const out: string[] = [];
  try { out.push(String(JSON.parse(readFileSync(join(AGENT, "cliproxyapi.json"), "utf8")).apiKey ?? "")); } catch { /* none */ }
  try { const auth = JSON.parse(readFileSync(join(AGENT, "auth.json"), "utf8")); for (const item of Object.values(auth as Record<string, any>)) if (item && typeof item === "object") for (const value of Object.values(item)) if (typeof value === "string" && value.length > 12) out.push(value); } catch { /* none */ }
  return out.filter(Boolean);
}
export interface Turn { label: string; turn: number; model: string; ok: boolean; code: number | null; guardFired: boolean; ms: number; text: string; costUSD: number; responses: number; stopReasons: Record<string, number>; wire: any; route: { requests: boolean; transcript: boolean; responseModels: Record<string, number> }; target: any }
let studyDir = "";
/** The study scratch directory (session directories, progress log); set by the command line, or by tests. */
export const setStudy = (dir: string) => { studyDir = dir; };
const log = (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); if (studyDir) appendFileSync(join(studyDir, "progress.log"), `${text}\n`); };
export class Gate { private active = 0; private queue: (() => void)[] = []; constructor(private limit: number) {} async run<T>(job: () => Promise<T>): Promise<T> { if (this.active >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve)); this.active++; try { return await job(); } finally { this.active--; this.queue.shift()?.(); } } }
const pools = { measured: new Gate(12), judge: new Gate(8) };

/** One `pi` turn in a session directory: a fresh session (turn 1) or a continuation of the same session id (turn > 1). */
export async function runTurn(spec: { dir: string; label: string; caseId: CaseId; model: string; prompt: string; inputs: Record<string, string>; turn: number; guardMs: number; pool: keyof typeof pools }): Promise<Turn> {
  const scratch = join(spec.dir, "pi-orche"), turnDir = join(spec.dir, `turn-${spec.turn}`);
  if (existsSync(join(turnDir, "meta.json"))) throw new Error(`${turnDir} already ran (a measured turn is never rerun silently)`);
  await mkdir(turnDir, { recursive: true });
  await write(join(turnDir, "meta.json"), { label: spec.label, turn: spec.turn, queuedAt: new Date().toISOString() });
  return pools[spec.pool].run(async () => {
    for (const sub of ["input", "work", "tmp", "out"]) await mkdir(join(scratch, sub), { recursive: true });
    for (const [name, text] of Object.entries(spec.inputs)) await writeFile(join(scratch, "input", name), text);
    let target: { dir: string; mount: string; extra: string[]; nodeModules: boolean };
    if (spec.turn === 1) { target = await makeTarget(spec.dir, spec.caseId); await write(join(spec.dir, "target.json"), target); await write(join(spec.dir, "target-before.json"), contentHashes(target.dir)); }
    else target = JSON.parse(readFileSync(join(spec.dir, "target.json"), "utf8"));
    await write(join(turnDir, "envelope.json"), { prices: prices() });
    const proxy = await startProxy(join(turnDir, "wire.jsonl"), join(turnDir, "envelope.json"));
    const agent = await agentDir(spec.dir, proxy.url, { routes: {} });
    const sessionId = `sv-${spec.label.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    const args = [...sandboxArgs({ agent: agent.dir, target: target.dir, runtime: join(studyDir, "runtime"), provider: join(studyDir, "provider"), scratch, mount: target.mount, extra: target.extra, targetNodeModules: target.nodeModules }), "--", ...piArgs(spec.model, sessionId, spec.prompt, false)];
    const meta: any = { label: spec.label, turn: spec.turn, model: spec.model, thinking: "max", sessionId, promptSha256: sha(spec.prompt), inputs: Object.fromEntries(Object.entries(spec.inputs).map(([name, text]) => [name, sha(text)])), startedAt: new Date().toISOString(), runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))) };
    await write(join(turnDir, "meta.json"), meta);
    await writeFile(join(turnDir, "prompt.md"), spec.prompt);
    log(`${spec.label} turn ${spec.turn} start (${spec.model})`);
    try { meta.pi = await runGuarded("bwrap", args, { env: sandboxEnv(proxy.url, agent.apiKey), stdout: join(turnDir, "events.jsonl"), stderr: join(turnDir, "stderr.txt"), guardMs: spec.guardMs }); }
    finally { proxy.child.kill("SIGTERM"); }
    const events = readJsonl(join(turnDir, "events.jsonl"));
    const ends = events.filter(event => event?.type === "message_end" && event.message?.role === "assistant");
    const costUSD = Math.round(ends.reduce((total, event) => total + (event.message?.usage?.cost?.total ?? 0), 0) * 1e6) / 1e6;
    const stopReasons = ends.reduce((acc: Record<string, number>, event) => { const reason = String(event.message?.stopReason ?? "?"); acc[reason] = (acc[reason] ?? 0) + 1; return acc; }, {});
    const wire = readJsonl(join(turnDir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model);
    const modelId = spec.model.split("/")[1]!;
    const transcript = [...sessionTranscripts(join(agent.dir, "sessions")).values()].find(item => item.id === sessionId);
    const responseModels = Object.fromEntries(ends.map(event => `${event.message?.provider}/${event.message?.model}`).map(name => [name, ends.filter(event => `${event.message?.provider}/${event.message?.model}` === name).length]));
    const route = {
      // Requests as sent (model, and effort max for the Responses API) and responses as received (provider/model of every reply).
      requests: wire.length > 0 && wire.every(entry => entry.model === modelId && (modelId.startsWith("claude") || (entry.effort === "max" && (entry.updateEfforts ?? []).every((effort: string) => effort === "max")))),
      transcript: !!transcript && transcript.models.every(model => model === spec.model) && transcript.thinking.every(level => level === "max") && Object.keys(responseModels).every(model => model === spec.model) && ends.length > 0,
      responseModels,
    };
    const after = contentHashes(target.dir);
    const out: Turn = { label: spec.label, turn: spec.turn, model: spec.model, ok: meta.pi.code === 0 && !meta.pi.guardFired, code: meta.pi.code, guardFired: meta.pi.guardFired, ms: meta.pi.endedAt - meta.pi.startedAt, text: finalText(events), costUSD, responses: ends.length, stopReasons, wire: wireStats(wire), route, target: hashDiff(JSON.parse(readFileSync(join(spec.dir, "target-before.json"), "utf8")), after) };
    await write(join(turnDir, "meta.json"), { ...meta, ...out, text: undefined, textSha256: sha(out.text), endedAt: new Date().toISOString() });
    await writeFile(join(turnDir, "reply.md"), out.text);
    // The streaming deltas are dropped from the kept event log (the session transcript holds every message).
    await writeFile(join(turnDir, "events.slim.jsonl"), events.filter(event => event?.type !== "message_update").map(event => JSON.stringify(event)).join("\n") + "\n");
    await redact(turnDir, agent.secrets);
    log(`${spec.label} turn ${spec.turn} done ok=${out.ok} exit=${out.code} ${Math.round(out.ms / 1000)}s ${out.responses} responses $${out.costUSD} wire=${out.wire.requests}req/$${out.wire.costUSD} errors=${out.wire.providerErrors.length} route=${route.requests}/${route.transcript} target=${out.target.unchanged}`);
    return out;
  });
}

// ---- the two pipelines -------------------------------------------------------------------------------------------------------------
const readWork = (dir: string, name: string) => { const file = join(dir, "pi-orche/work", name); return existsSync(file) ? readFileSync(file, "utf8") : ""; };
export const parseJson = (text: string): any => { try { return text.trim() ? JSON.parse(text) : undefined; } catch { return undefined; } };
export function diffOf(before: string, after: string, dir: string): string {
  const a = join(dir, "diff-a.md"), b = join(dir, "diff-b.md");
  execFileSync("bash", ["-c", 'cat > "$1"', "_", a], { input: before }); execFileSync("bash", ["-c", 'cat > "$1"', "_", b], { input: after });
  try { return execFileSync("diff", ["-u", "--label", "before/final.md", "--label", "after/final.md", a, b], { maxBuffer: 64 * 1024 * 1024 }).toString(); }
  catch (error: any) { return String(error.stdout ?? ""); }
}
const fill = (template: string, input: UnitInput) => template.split("{BASE}").join(`${input.baseLabel}.md`).split("{OTHER}").join(`${input.baseLabel === "P1" ? "P2" : "P1"}.md`);
/** The only source material any measured session receives: the task, both prior answers and the registered claims (no evaluator file). */
export const sourceInputs = (input: UnitInput): Record<string, string> => ({ "task.md": input.task, "P1.md": input.P1, "P2.md": input.P2, "claims.json": `${JSON.stringify({ claims: input.claims }, null, 1)}\n`, "claims.md": claimsMarkdown(input.claims) });
export const composePrompt = (input: UnitInput, arm: Arm) => [COMMON, "", INPUTS, "", arm === "C" ? C_COMPOSE : fill(T_COMPOSE, input)].join("\n");
export const reviewPrompt = (input: UnitInput, arm: Arm, second: boolean) => [COMMON, "", INPUTS, "", arm === "C" ? (second ? C_REREVIEW : C_REVIEW) : fill(second ? T_RECHECK : T_AUDIT, input)].join("\n");

/** Freeze one text of a pipeline (sha256 per file). */
async function freeze(results: string, label: string, files: Record<string, string>, extra: Record<string, unknown>): Promise<void> {
  const dir = join(results, label);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await write(join(dir, "frozen.json"), { ...extra, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])), frozenAt: new Date().toISOString() });
  log(`${basename(results)}/${label} frozen (${Object.keys(files).join(", ")})`);
}
/** Copy a session directory's record (transcripts, turns, work and out files) into results, secrets redacted. */
async function keep(sessionDir: string, results: string): Promise<void> {
  await mkdir(results, { recursive: true });
  if (existsSync(join(sessionDir, "agent/sessions"))) await cp(join(sessionDir, "agent/sessions"), join(results, "sessions"), { recursive: true });
  for (const name of existsSync(sessionDir) ? readdirSync(sessionDir) : []) if (/^turn-\d+$/.test(name)) for (const file of ["meta.json", "prompt.md", "reply.md", "events.slim.jsonl", "stderr.txt", "wire.jsonl", "wire.jsonl.totals.json", "envelope.json"]) if (existsSync(join(sessionDir, name, file))) { await mkdir(join(results, name), { recursive: true }); await copyFile(join(sessionDir, name, file), join(results, name, file)); }
  for (const sub of ["work", "out"]) if (existsSync(join(sessionDir, "pi-orche", sub))) await cp(join(sessionDir, "pi-orche", sub), join(results, sub), { recursive: true });
  if (existsSync(join(sessionDir, "target-before.json"))) await copyFile(join(sessionDir, "target-before.json"), join(results, "target-before.json"));
  await redact(results, secrets());
}

/**
 * One pipeline (arm C or T, one repetition) of one unit, into `root/<unit>/<arm>-r<rep>`. Stages: compose (+1 gate-fix turn when the
 * mechanical check fails) → independent review/audit → revision/local repair in the composer's session (+1 gate-fix turn) → independent
 * re-review/recheck (recorded; no further revision). Texts: the draft (C0/Tpre) and the revised text (C1/T). Failures are recorded.
 */
export async function pipeline(input: UnitInput, arm: Arm, rep: number, root = RESULTS): Promise<void> {
  const id = `${input.unit}-${arm}-r${rep}`, dir = join(studyDir, root === RESULTS ? "" : "preflight", input.unit, `${arm}-r${rep}`), results = join(root, input.unit, `${arm}-r${rep}`);
  if (existsSync(join(results, "pipeline.json"))) { log(`${id}: already complete`); return; }
  if (existsSync(dir)) throw new Error(`${dir} exists without a recorded pipeline: inspect it (a measured pipeline is never rerun silently)`);
  await mkdir(dir, { recursive: true });
  const refs = input.claims.map(claim => claim.ref);
  const base = input.baseLabel === "P1" ? input.P1 : input.P2;
  const record: any = { unit: input.unit, arm, rep, model: COMPOSER_MODEL, thinking: "max", inputs: input.hashes, baseSha256: sha(base), startedAt: new Date().toISOString(), stages: [] as any[] };
  const composeDir = join(dir, "compose");
  const check = (final: string, side: string) => arm === "C" ? checkLedger(refs, parseJson(side)) : checkPlan(refs, input.baseLabel, parseJson(side), final);
  const sideName = arm === "C" ? "ledger.json" : "plan.json";
  let turn = 0;
  const composerTurn = async (stage: string, prompt: string, inputs: Record<string, string>, guardMs: number) => {
    const turns = [await runTurn({ dir: composeDir, label: `${id}-compose`, caseId: input.caseId, model: COMPOSER_MODEL, prompt, inputs, turn: ++turn, guardMs, pool: "measured" })];
    let final = readWork(composeDir, "final.md"), side = readWork(composeDir, sideName), result = check(final, side);
    const firstErrors = result.errors.length, firstStats = result.stats;
    if (result.errors.length && turns[0]!.ok) {
      turns.push(await runTurn({ dir: composeDir, label: `${id}-compose`, caseId: input.caseId, model: COMPOSER_MODEL, prompt: (arm === "C" ? LEDGER_FIX : PLAN_FIX).replace("{ERRORS}", result.errors.slice(0, 80).map(error => `- ${error}`).join("\n")), inputs: {}, turn: ++turn, guardMs: GUARDS.fix, pool: "measured" }));
      final = readWork(composeDir, "final.md"); side = readWork(composeDir, sideName); result = check(final, side);
    }
    record.stages.push({ stage, turns: turns.map(t => ({ ...t, text: undefined })), check: { firstErrors, firstStats, errors: result.errors.slice(0, 200), errorCount: result.errors.length, stats: result.stats } });
    return { final, side, ok: turns.every(t => t.ok), reply: turns.at(-1)!.text, result };
  };
  const independent = async (stage: string, prompt: string, inputs: Record<string, string>, outName: string, guardMs: number) => {
    const sessionDir = join(dir, stage);
    const t = await runTurn({ dir: sessionDir, label: `${id}-${stage}`, caseId: input.caseId, model: COMPOSER_MODEL, prompt, inputs, turn: 1, guardMs, pool: "measured" });
    const out = readWork(sessionDir, outName), parsed = parseJson(out);
    const items: any[] = Array.isArray(parsed?.problems) ? parsed.problems : Array.isArray(parsed?.defects) ? parsed.defects : [];
    record.stages.push({ stage, turns: [{ ...t, text: undefined }], output: { file: outName, valid: !!parsed && (Array.isArray(parsed.problems) || Array.isArray(parsed.defects)), items: items.length, kinds: items.reduce((acc: Record<string, number>, item) => { acc[String(item?.kind)] = (acc[String(item?.kind)] ?? 0) + 1; return acc; }, {}) } });
    await keep(sessionDir, join(results, "sessions", stage));
    return { out, items, ok: t.ok && !!parsed && (Array.isArray(parsed.problems) || Array.isArray(parsed.defects)) };
  };
  try {
    if (arm === "T") { await mkdir(join(composeDir, "pi-orche/work"), { recursive: true }); await writeFile(join(composeDir, "pi-orche/work/final.md"), base); }
    const draft = await composerTurn("compose", composePrompt(input, arm), sourceInputs(input), GUARDS.compose);
    if (!draft.final.trim()) throw new Error("compose produced no final.md");
    const draftLabel = arm === "C" ? "C0" : "Tpre";
    await freeze(results, draftLabel, { "final.md": draft.final, [sideName]: draft.side, "reply.md": draft.reply, ...(arm === "T" ? { "base.diff": diffOf(base, draft.final, dir) } : {}) }, { arm, rep, text: draftLabel, checkErrors: draft.result.errors.length, checkStats: draft.result.stats, linesKept: linesKept(base, draft.final), ok: draft.ok });
    const firstName = arm === "C" ? "review-1" : "audit-1", outName = arm === "C" ? "review.json" : "audit.json";
    const first = await independent(firstName, reviewPrompt(input, arm, false), { ...sourceInputs(input), "final.md": draft.final, [sideName]: draft.side }, outName, GUARDS.review);
    if (!first.ok) throw new Error(`${firstName} produced no usable ${outName}`);
    const revised = await composerTurn(arm === "C" ? "revise" : "repair", arm === "C" ? C_REVISE : T_REPAIR, { [`${firstName}.json`]: first.out }, GUARDS.revise);
    const diff = diffOf(draft.final, revised.final, dir);
    const secondName = arm === "C" ? "review-2" : "recheck";
    const second = await independent(secondName, reviewPrompt(input, arm, true), { ...sourceInputs(input), "final.md": revised.final, [sideName]: revised.side, [`${firstName}.json`]: first.out, "revision.diff": diff, "revision-note.md": revised.reply }, outName, GUARDS.recheck);
    record.residual = { ok: second.ok, items: second.items.length };
    await freeze(results, arm === "C" ? "C1" : "T", { "final.md": revised.final, [sideName]: revised.side, "reply.md": revised.reply, "revision.diff": diff, [`${firstName}.json`]: first.out, [`${secondName}.json`]: second.out, ...(arm === "T" ? { "base.diff": diffOf(base, revised.final, dir) } : {}) }, { arm, rep, text: arm === "C" ? "C1" : "T", checkErrors: revised.result.errors.length, checkStats: revised.result.stats, linesKept: linesKept(base, revised.final), linesKeptFromDraft: linesKept(draft.final, revised.final), firstItems: first.items.length, residualItems: second.items.length, residualValid: second.ok, ok: revised.ok && second.ok });
  } catch (error) { record.error = String(error).slice(0, 500); log(`${id}: ${record.error}`); }
  finally {
    await keep(composeDir, join(results, "sessions", "compose"));
    record.endedAt = new Date().toISOString();
    const turns = record.stages.flatMap((stage: any) => stage.turns);
    record.totals = { turns: turns.length, costUSD: round(turns.reduce((total: number, t: any) => total + t.costUSD, 0)), wireCostUSD: round(turns.reduce((total: number, t: any) => total + (t.wire?.costUSD ?? 0), 0)), requests: turns.reduce((total: number, t: any) => total + (t.wire?.requests ?? 0), 0), responses: turns.reduce((total: number, t: any) => total + t.responses, 0), providerErrors: turns.reduce((total: number, t: any) => total + (t.wire?.providerErrors?.length ?? 0), 0), unknownUsage: turns.reduce((total: number, t: any) => total + (t.wire?.unknownUsage ?? 0), 0), ms: turns.reduce((total: number, t: any) => total + t.ms, 0), allOk: turns.every((t: any) => t.ok), routeOk: turns.every((t: any) => t.route.requests && t.route.transcript), targetUnchanged: turns.every((t: any) => t.target.unchanged) };
    await mkdir(results, { recursive: true });
    await write(join(results, "pipeline.json"), record);
    log(`${id}: pipeline ${record.error ? "INCOMPLETE" : "complete"} $${record.totals.costUSD} ${Math.round(record.totals.ms / 1000)}s`);
  }
}
const round = (value: number) => Math.round(value * 1e6) / 1e6;

// ---- Tier-1 judges (evaluation instrument) -----------------------------------------------------------------------------------------
export function unitStatements(unit: string): { statements: Statement[]; key: Record<string, string> } {
  const load = (label: string) => (JSON.parse(readFileSync(join(QV, unit, `X-${label}`, "claims.json"), "utf8")).claims as any[]).map(claim => ({ id: claim.id, claim: claim.claim, stance: claim.stance, locations: claim.locations ?? [] }));
  return statementsOf(unit, { S: load("S"), E: load("E") });
}
/** Every text of a unit: the historical stage answers exactly as the extractor read them, and the frozen pipeline texts. */
export function unitTexts(unit: string, root = RESULTS): { label: string; file: string }[] {
  const out = (["S", "E", "A"] as const).map(label => ({ label: `hist-${label}`, file: join(QV, unit, `X-${label}`, "answer.md") }));
  for (const rep of REPS) for (const [arm, labels] of [["C", ["C0", "C1"]], ["T", ["Tpre", "T"]]] as const) for (const label of labels) out.push({ label: `${label}-r${rep}`, file: join(root, unit, `${arm}-r${rep}`, label, "final.md") });
  return out;
}
/** A judge's only inputs: the task, the numbered text and the statements without their origin (S/E) or any label. */
export const judgeInputs = (task: string, text: string, statements: Statement[]): Record<string, string> => ({ "task.md": task, "text.md": numberLines(text), "statements.json": `${JSON.stringify({ statements: statements.map(({ origin: _origin, ...rest }) => rest) }, null, 1)}\n` });
export async function judge(unit: string, label: string, file: string, model: string, statements: Statement[], task: string, root = RESULTS): Promise<void> {
  const short = model.split("/")[1]!.split("-")[0]!;
  const out = join(root, unit, "judgments", `${label}.${short}.json`);
  if (existsSync(out)) return;
  const text = readFileSync(file, "utf8");
  const dir = join(studyDir, root === RESULTS ? "" : "preflight", unit, "judge", `${label}.${short}`);
  if (existsSync(dir)) throw new Error(`${dir} exists without a recorded judgment: inspect it`);
  const ids = statements.map(item => item.id);
  const inputs = judgeInputs(task, text, statements);
  const turns = [await runTurn({ dir, label: `${unit}-judge-${label}.${short}`, caseId: "none", model, prompt: JUDGE, inputs, turn: 1, guardMs: GUARDS.judge, pool: "judge" })];
  const read = () => { const file = join(dir, "pi-orche/out/judgment.json"); return parseJson(existsSync(file) ? readFileSync(file, "utf8") : ""); };
  let judgment = read(), result = checkJudgment(ids, judgment, text);
  if ((!judgment || result.errors.length) && turns[0]!.ok) {
    turns.push(await runTurn({ dir, label: `${unit}-judge-${label}.${short}`, caseId: "none", model, prompt: JUDGE_FIX.replace("{ERRORS}", (judgment ? result.errors : ["the file is missing or not valid JSON"]).slice(0, 60).map(error => `- ${error}`).join("\n")), inputs: {}, turn: 2, guardMs: GUARDS.fix, pool: "judge" }));
    judgment = read(); result = checkJudgment(ids, judgment, text);
  }
  await keep(dir, join(root, unit, "judge-sessions", `${label}.${short}`));
  await mkdir(dirname(out), { recursive: true });
  await write(out, { unit, label, model, textSha256: sha(text), statements: statements.length, valid: !!judgment && !result.errors.length, errors: result.errors.slice(0, 100), quotesFound: result.quotesFound, quotesNeeded: result.quotesNeeded, turns: turns.map(t => ({ ...t, text: undefined })), judgment: judgment ?? null });
  log(`${unit}/${label} judged by ${short}: errors ${result.errors.length}, quotes ${result.quotesFound}/${result.quotesNeeded}`);
}

// ---- commands ----------------------------------------------------------------------------------------------------------------------
export function promptHashes(): Record<string, string> {
  return Object.fromEntries(Object.entries({ COMMON, INPUTS, C_COMPOSE, C_REVIEW, C_REVISE, C_REREVIEW, T_COMPOSE, T_AUDIT, T_REPAIR, T_RECHECK, LEDGER_FIX, PLAN_FIX, JUDGE, JUDGE_FIX }).map(([name, text]) => [name, sha(text)]));
}
/** sha256 of every file below a directory (relative paths): the preservation check of earlier results. */
export function treeHashes(root: string): Record<string, string> { return Object.fromEntries(filesUnder(root, /./).map(file => [file.slice(root.length + 1), sha(readFileSync(file))])); }
async function prepare(study: string): Promise<void> {
  if (existsSync(join(RESULTS, "manifest.json"))) throw new Error("manifest.json exists: the protocol is frozen");
  await mkdir(join(study, "runtime/node_modules"), { recursive: true });
  if (!existsSync(join(study, "provider"))) await cp(PROVIDER_PKG, join(study, "provider"), { recursive: true });
  const units = Object.fromEntries(UNITS.map(unit => { const input = unitInput(unit); const statements = unitStatements(unit); return [unit, { ...input.hashes, claims: input.claims.length, base: input.baseLabel, statements: statements.statements.length, statementsSha256: sha(JSON.stringify(statements)) }]; }));
  const catalog = catalogEntries(JSON.parse(readFileSync(join(AGENT, "cliproxyapi-models.json"), "utf8")));
  const prior = treeHashes(QV);
  await write(join(study, "qv-before.json"), prior);
  const manifest = {
    protocolSha256: sha(readFileSync(join(RESULTS, "protocol.md"))), runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), prompts: promptHashes(), units, reps: REPS, guards: GUARDS,
    composer: { model: COMPOSER_MODEL, thinking: "max", catalog: catalog.find(item => item.id === COMPOSER_MODEL.split("/")[1]) }, judges: JUDGE_MODELS.map(model => ({ model, thinking: "max", catalog: catalog.find(item => item.id === model.split("/")[1]) })),
    pi: { cli: PI_CLI, version: execFileSync(NODE, [PI_CLI, "--version"]).toString().trim() }, provider: { version: JSON.parse(readFileSync(join(study, "provider/package.json"), "utf8")).version },
    liveConfigSha256: sha(readFileSync(join(AGENT, "orche.config.json"))), head: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"]).toString().trim(), dirty: execFileSync("git", ["-C", REPO, "status", "--porcelain=v1"]).toString().split("\n").filter(Boolean),
    sources: Object.fromEntries(["quality.ts", "run.ts", "matrix.ts", "proxy.mjs"].map(name => [name, sha(readFileSync(join(REPO, "experiments/mdsd-ab", name)))])),
    qualityValidation: { files: Object.keys(prior).length, digest: sha(JSON.stringify(prior)) },
    frozenAt: new Date().toISOString(),
  };
  await write(join(RESULTS, "manifest.json"), manifest);
  console.log(JSON.stringify({ units, prompts: manifest.prompts, qualityValidation: manifest.qualityValidation }, null, 1));
}
/** The toy preflight: both pipelines and one judge on the calc.js toy, into the study scratch (never into results/). */
async function preflight(study: string): Promise<void> {
  const root = join(study, "preflight-results");
  await mkdir(join(study, "runtime/node_modules"), { recursive: true });
  if (!existsSync(join(study, "provider"))) await cp(PROVIDER_PKG, join(study, "provider"), { recursive: true });
  await Promise.all([pipeline(TOY, "C", 1, root), pipeline(TOY, "T", 1, root)]);
  const statements = statementsOf("toy", { S: TOY.claims.filter(claim => claim.ref.startsWith("P1:")).map(claim => ({ id: claim.ref.slice(3), claim: claim.claim, stance: claim.stance ?? "asserted", locations: claim.locations ?? [] })), E: TOY.claims.filter(claim => claim.ref.startsWith("P2:")).map(claim => ({ id: claim.ref.slice(3), claim: claim.claim, stance: claim.stance ?? "asserted", locations: claim.locations ?? [] })) }).statements;
  const text = join(root, "toy", "T-r1", "T", "final.md");
  if (existsSync(text)) await judge("toy", "T-r1", text, JUDGE_MODELS[0], statements, TOY.task, root);
  for (const arm of ["C", "T"]) { const record = JSON.parse(readFileSync(join(root, "toy", `${arm}-r1`, "pipeline.json"), "utf8")); console.log(arm, JSON.stringify({ error: record.error, totals: record.totals, stages: record.stages.map((stage: any) => ({ stage: stage.stage, turns: stage.turns.length, check: stage.check ? { errors: stage.check.errorCount, stats: stage.check.stats } : undefined, output: stage.output })) })); }
}

async function all(): Promise<void> {
  if (!existsSync(join(RESULTS, "manifest.json"))) throw new Error("prepare first (the manifest freezes the protocol)");
  const manifest = JSON.parse(readFileSync(join(RESULTS, "manifest.json"), "utf8"));
  if (manifest.runnerSha256 !== sha(readFileSync(fileURLToPath(import.meta.url)))) throw new Error("the runner changed after the manifest was frozen");
  const inputs = UNITS.map(unitInput);
  const judged = new Set<string>();
  const judgeText = async (unit: string, label: string, file: string) => {
    if (judged.has(`${unit}/${label}`) || !existsSync(file)) return;
    judged.add(`${unit}/${label}`);
    const { statements } = unitStatements(unit), task = unitInput(unit).task;
    await Promise.all(JUDGE_MODELS.map(model => judge(unit, label, file, model, statements, task).catch(error => log(`${unit}/${label} judge ${model}: ${String(error).slice(0, 300)}`))));
  };
  const jobs: Promise<void>[] = [];
  for (const input of inputs) for (const rep of REPS) for (const arm of ["C", "T"] as const) jobs.push((async () => {
    await pipeline(input, arm, rep);
    for (const text of unitTexts(input.unit).filter(text => text.label.endsWith(`-r${rep}`) && (arm === "C" ? /^C/.test(text.label) : /^T/.test(text.label)))) jobs.push(judgeText(input.unit, text.label, text.file));
  })().catch(error => log(`${input.unit}-${arm}-r${rep}: ${String(error).slice(0, 300)}`)));
  for (const unit of UNITS) for (const text of unitTexts(unit).filter(text => text.label.startsWith("hist-"))) jobs.push(judgeText(unit, text.label, text.file));
  for (let index = 0; index < jobs.length; index++) await jobs[index];
  await write(join(studyDir, "qv-after.json"), treeHashes(QV));
  log("all: every pipeline and judge finished");
}
function status(): void {
  for (const unit of UNITS) {
    const rows = unitTexts(unit).map(text => `${text.label}:${existsSync(text.file) ? "text" : "-"}/${JUDGE_MODELS.map(model => existsSync(join(RESULTS, unit, "judgments", `${text.label}.${model.split("/")[1]!.split("-")[0]}.json`)) ? "J" : ".").join("")}`);
    console.log(`${unit}: ${rows.join(" ")}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, study, a, b] = process.argv.slice(2);
  if (!study) throw new Error("usage: synthesis.ts prepare|preflight|all|status <study> [measured-concurrency] [judge-concurrency]");
  studyDir = study;
  await mkdir(study, { recursive: true });
  if (a && /^\d+$/.test(a)) pools.measured = new Gate(Number(a));
  if (b && /^\d+$/.test(b)) pools.judge = new Gate(Number(b));
  if (command === "prepare") await prepare(study);
  else if (command === "preflight") await preflight(study);
  else if (command === "all") await all();
  else if (command === "status") status();
  else throw new Error(`unknown command ${command}`);
  process.exit(0);
}
void statSync;
