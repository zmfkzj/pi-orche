/** Current T vs T+qualification. New namespace only; imported previous study code is read-only. */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, sha, write } from "./run.js";
import { UNITS, REPS, T_COMPOSE, T_AUDIT, T_REPAIR, T_RECHECK, PLAN_FIX, checkPlan, diffOf, linesKept, parseJson, numberLines, spanFound, treeHashes } from "./synthesis.js";
import { ROOT, CASE, json, text, packet, claimsOf, keyOf, SUPPORT, RELEVANCE, type Claim } from "./qualification-inputs.js";
import { MODEL, JUDGES, guards, setup, setStudy, turn, readOutput, retainSession, freezeManifest, sourceHashes, type Turn } from "./qualification-runtime.js";
export type Arm = "T" | "Q";
export const COMMON = `This is synthesis of existing analyses, not a new investigation. Inputs are read-only /tmp/pi-orche/input; outputs go to /tmp/pi-orche/work, scratch to /tmp/pi-orche/tmp. Do not edit the target repository. Tools may check registered claims/conflicts only, never hunt new defects. Incidental new content belongs under 'New observations during checking'. Read task.md and guide.md completely, both doc-A.md/doc-B.md, claims.json/claims.md. evidence-index.json describes frozen original tool records doc-A-evidence.jsonl/doc-B-evidence.jsonl: search by path/command where needed, do not dump all records. These are not your own executions. Missing logs are missing corroboration, not proof of fabrication or a false mechanism. The task guide is common to all analyses. Source agreement, prestige and absence of refutation are not evidence of truth. Write in English. No external search. The whole final document, including summary/appendix, must answer the task.`;
export const PREP_T = `Read the source packet and prepare for a subsequent minimal-edit synthesis. The editing base will be supplied later; neither source is privileged now. Write /tmp/pi-orche/work/preparation.md: a concise factual index of the available source material and evidence locations, any unavailable artifacts and questions to check. Do not draft a final answer or make a new formal selection ledger now. Check existing source conflicts where helpful. Then reply done.`;
export const PREP_Q = `Before learning which document is the editing base, qualify EVERY registered claim independently of source prestige. Require the same task connection and evidential assessment for both sources; a single-source supported discovery remains eligible. Read the actual task/guide, claim as worded (including negation, conditions and uncertainty), evidence and code as needed.
Write /tmp/pi-orche/work/decisions.json: {"entries":[{"ref":"k1","relevance":"finding|supporting|requested_context|out|ambiguous","taskLink":"specific task/guide clause and why the claim helps or fails it","support":"supported|refuted|insufficient|conflicting","evidence":"specific code or recorded evidence, with conditions/time/type/limitations; say explicitly when unavailable","action":"include|correct|uncertain|exclude|duplicate","reason":"why this action follows; what would settle uncertainty","duplicateOf":"k2 only when fully equivalent","qualifiers":["conditions, negations, boundaries, consequences and status to preserve"]}]}.
Every claim needs ALL fields except duplicateOf when not duplicate. Include supported relevant content; correct contradicted assertions with counterevidence; preserve relevant insufficient/conflicting material as explicitly uncertain unless it would not help even as an open question, explaining that. Clear exclusion must cite the task scope, not say merely unnecessary. Ambiguous scope is not falsehood. Duplicate requires FULL meaning/qualifiers/status equivalence; preserve a unique detail even if both claims discuss the same topic. Do not use confidence/consensus to confirm. Do not write a final answer yet. Then reply done.`;
const adapt = (s: string) => s.replaceAll("P1.md", "doc-A.md").replaceAll("P2.md", "doc-B.md").replaceAll("P1:c1", "k1").replaceAll("P2:c3", "k2").replaceAll("P1:c4", "k4").replaceAll("P1", "doc-A").replaceAll("P2", "doc-B");
export const Q_COMPOSE = `Use the frozen initial qualification /tmp/pi-orche/input/decisions-initial.json. The editing BASE is now revealed, but is an editing base, not a truth authority. Apply those decisions through targeted edits to the seeded final.md. Supported task-relevant content from either source must survive completely, including single-source findings, negation, boundary conditions and uncertainty. Explicitly correct contradicted BASE claims, including repeated occurrences: a later correction does not excuse another surviving false assertion. Do not globally rewrite or compress. Do not move invalid content into an appendix or universally hedge.
In addition to the ordinary plan schema, EVERY final plan entry (including retained and added) MUST contain relevance, taskLink, support, evidence, reason, and qualifiers as in the qualification schema. Preserve original wording when it is correct and relevant. The initial decisions are revisable only with a recorded new evidence/reason: write decision-changes.json {"changes":[{"ref":"k1","before":"…","after":"…","reason":"…","evidence":"…"}]}, empty if none. A changed BASE identity is not evidence. Justified uncertainty must identify what would settle it. The original qualification stays unchanged.`;
export const Q_AUDIT = `FIRST assess each claim's eligibility from task/guide, claim and evidence, without assuming the composer's retained/added decision is correct. In particular challenge retained claims with the SAME evidential standard as additions. Then compare the decision to your assessment, and only then inspect final realization. Record an audit decision for EVERY claim in audit.json under "eligibility":[{"ref":"k1","assessment":"agree|challenge|unresolved","reason":"specific task/evidence basis","suggestedAction":"include|correct|uncertain|exclude|duplicate"}]. Missing evidence is not fabrication. A supported unique discovery must not be excluded for having one source; a duplicate pointer error is not an omission if the meaning exists elsewhere. Check ALL occurrences of a false or uncertain claim, including summaries and appendices. Do not let one correction erase another assertion. This is in addition to the ordinary defects/checked schema.`;
export const Q_REPAIR = `Keep the qualification fields for every entry and update decision-changes.json for changes relative to the initial frozen decisions. Apply agreed eligibility challenges locally as well as fixing realization defects; preserve all unaffected valid qualifiers and single-source content.`;
export const Q_RECHECK = `Also check the retained/added eligibility decisions challenged in the first audit, including any surviving repeated false assertions. Return eligibility entries for changed/challenged claims (full enumeration is not required in the recheck). Do not perform another revision.`;
export const JUDGE = `You are a semantic final-text evaluator, NOT a factual/reference labeller. You see task.md, guide.md, statements.json (origin-masked k-ids, assertion as worded and original stance) and text.md (FULL document, L<n>: line prefixes). No plans, source prestige or gold labels are provided. Read the ENTIRE text before deciding omissions; summary and appendix count equally.
For EVERY statement assess realization: complete (full conditions, negation, consequence, boundaries and status), partial (core present but some material detail/status differs), missing, opposed (text explicitly denies/refutes it). Assess stance RELATIVE TO THE STATEMENT AS WORDED: asserted, hedged, rejected, absent, mixed. For 'X is not a defect', repeating that denial ASSERTS the statement, not rejects it. If any occurrence still asserts a claim alongside another correction/hedge, use mixed and provide both passages; one correction cannot erase another assertion. Add statusDrift none|upgrade|downgrade|mixed relative to the source's stated certainty. 'rejected' source stance means the source itself denies the positive proposition, not that the claim should be discarded.
Write /tmp/pi-orche/work/judgment.json {"statements":[{"id":"k1","realization":"complete|partial|missing|opposed","stance":"asserted|hedged|rejected|absent|mixed","statusDrift":"none|upgrade|downgrade|mixed","quote":"verbatim excerpt without line prefix (empty if missing)","counterQuote":"opposite/qualifying occurrence if mixed, else empty","lines":[1],"note":"what is missing/changed or why mixed"}],"other":[{"claim":"new substantive claim not expressed by any statement, INCLUDING unsupported execution claims if substantive","quote":"verbatim","lines":[1]}],"contradictions":[{"a":"verbatim","b":"verbatim","note":"why inconsistent"}]}. Exactly one entry per statement; build in batches if needed. Do not decide truth, scope labels or importance. Reply done.`;
export const prompts = { COMMON, PREP_T, PREP_Q, T_COMPOSE, T_AUDIT, T_REPAIR, T_RECHECK, Q_COMPOSE, Q_AUDIT, Q_REPAIR, Q_RECHECK, JUDGE };
export function checkQualification(ids: string[], data: any, requireAction = true): string[] {
  const errors: string[] = [], seen = new Set<string>();
  if (!Array.isArray(data?.entries)) return ["no entries"];
  for (const e of data.entries) {
    if (!ids.includes(e.ref)) errors.push(`unknown ${e.ref}`);
    if (seen.has(e.ref)) errors.push(`duplicate ${e.ref}`); seen.add(e.ref);
    if (!(RELEVANCE as readonly string[]).includes(e.relevance)) errors.push(`${e.ref}: relevance`);
    if (!(SUPPORT as readonly string[]).includes(e.support)) errors.push(`${e.ref}: support`);
    for (const field of ["taskLink", "evidence", "reason"]) if (!String(e[field] ?? "").trim()) errors.push(`${e.ref}: ${field}`);
    if (!Array.isArray(e.qualifiers)) errors.push(`${e.ref}: qualifiers`);
    if ((requireAction || e.action) && !["include", "correct", "uncertain", "exclude", "duplicate"].includes(e.action)) errors.push(`${e.ref}: action`);
    if (e.action === "duplicate" && (!ids.includes(e.duplicateOf) || e.duplicateOf === e.ref)) errors.push(`${e.ref}: duplicateOf`);
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`missing ${id}`);
  return errors;
}
/** Maps the internal source-namespaced ids used to reuse checkPlan back to the neutral k-ids the composer actually sees. */
export const neutralIds = (message: string) => message.replace(/\b(?:doc-[AB]|D[12]):(k\d+)\b/g, "$1");
export function checkFinal(claims: Claim[], base: string, arm: Arm, data: any, final: string): string[] {
  const aliases = Object.fromEntries(claims.map(c => [c.ref, `${c.source}:${c.ref}`]));
  const converted = { entries: (data?.entries ?? []).map((e: any) => ({ ...e, ref: aliases[e.ref] ?? e.ref, duplicateOf: aliases[e.duplicateOf] ?? e.duplicateOf })) };
  const errors = checkPlan(Object.values(aliases), base, converted, final).errors.map(neutralIds);
  if (!final.trim()) errors.push("empty final.md");
  if (arm === "Q") errors.push(...checkQualification(claims.map(c => c.ref), data, false));
  return errors;
}
export const decisionAction = (disposition: string) => ({ retained: "include", added: "include", corrected: "correct", refuted: "correct", uncertain: "uncertain", out_of_scope: "exclude", unsupported: "exclude", duplicate: "duplicate" } as Record<string, string>)[disposition];
export function checkChanges(initial: any, final: any, changes: any): string[] {
  if (!Array.isArray(changes?.changes)) return ["missing decision-changes.json changes array"];
  const before = new Map((initial?.entries ?? []).map((e: any) => [e.ref, e]));
  const errors: string[] = [];
  for (const e of final?.entries ?? []) {
    const old: any = before.get(e.ref);
    if (!old) continue;
    if (old.action !== decisionAction(e.disposition) || old.support !== e.support || old.relevance !== e.relevance) {
      const change = changes.changes.find((c: any) => c.ref === e.ref);
      if (!change || !String(change.reason ?? "").trim() || !String(change.evidence ?? "").trim()) errors.push(`${e.ref}: changed initial qualification without evidence/reason trace`);
    }
  }
  return errors;
}
export function checkJudge(ids: string[], data: any, final: string): string[] {
  if (!Array.isArray(data?.statements) || !Array.isArray(data?.other) || !Array.isArray(data?.contradictions)) return ["missing judgment arrays"];
  const errors: string[] = [], seen = new Set<string>();
  for (const e of data.statements) {
    if (!ids.includes(e.id) || seen.has(e.id)) errors.push(`unknown/duplicate ${e.id}`); seen.add(e.id);
    if (!["complete", "partial", "missing", "opposed"].includes(e.realization)) errors.push(`${e.id}: realization`);
    if (!["asserted", "hedged", "rejected", "absent", "mixed"].includes(e.stance)) errors.push(`${e.id}: stance`);
    if (!["none", "upgrade", "downgrade", "mixed"].includes(e.statusDrift)) errors.push(`${e.id}: statusDrift`);
    if (e.realization !== "missing" && !spanFound(e.quote, final, 3)) errors.push(`${e.id}: quote not found`);
    if (e.stance === "mixed" && !spanFound(e.counterQuote, final, 3)) errors.push(`${e.id}: mixed without opposite quote`);
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`missing ${id}`);
  return errors;
}
function fill(p: string, base: string) { return adapt(p).replaceAll("{BASE}", `${base}.md`).replaceAll("{OTHER}", `${base === "doc-A" ? "doc-B" : "doc-A"}.md`); }
export async function freeze(dir: string, files: Record<string, string>, extra: any): Promise<void> {
  if (existsSync(join(dir, "frozen.json"))) { const old = json(join(dir, "frozen.json")); for (const [n, v] of Object.entries(files)) if (old.files[n] !== sha(v) || sha(text(join(dir, n))) !== old.files[n]) throw new Error(`frozen mismatch ${dir}/${n}`); return; }
  await mkdir(dir, { recursive: true });
  for (const [n, v] of Object.entries(files)) await writeFile(join(dir, n), v);
  await write(join(dir, "frozen.json"), { at: new Date().toISOString(), ...extra, files: Object.fromEntries(Object.entries(files).map(([n, v]) => [n, sha(v)])) });
}
export async function pipeline(study: string, unit: string, arm: Arm, rep: number): Promise<void> {
  const id = `${unit}-${arm}-r${rep}`, dir = join(study, "runs", unit, `${arm}-r${rep}`), dest = join(ROOT, unit, `${arm}-r${rep}`);
  if (existsSync(join(dest, "pipeline.json"))) return;
  const sources = packet(unit), claims = claimsOf(unit), base = keyOf(unit).base, ids = claims.map(c => c.ref);
  const record: any = { id, unit, arm, rep, startedAt: new Date().toISOString(), stages: [], model: MODEL, thinking: "max" };
  let n = 0;
  const composer = join(dir, "compose");
  const call = async (stage: string, session: string, prompt: string, inputs: Record<string, string>, guard: number, number: number) => {
    const t = await turn({ dir: session, label: `${id}-${session.endsWith("compose") ? "compose" : stage}`, number, kind: CASE(unit), prompt, inputs, guard });
    record.stages.push({ stage, result: t }); if (!t.ok || !t.target.unchanged) throw new Error(`${stage}: process, route or target failure (exit ${t.pi?.code}, guard ${!!t.pi?.guardFired}, route ${t.routeOk}, stop ${t.finalStop}, target ${t.target.unchanged})`); return t;
  };
  try {
    let p = await call("prepare", composer, `${COMMON}\n${arm === "Q" ? PREP_Q : PREP_T}`, sources, guards.prepare, ++n);
    const prepCheck = (t: Turn) => arm === "Q" ? checkQualification(ids, parseJson(readOutput(t, "decisions.json"))) : readOutput(t, "preparation.md").trim() ? [] : ["no preparation.md"];
    let errors = prepCheck(p);
    if (errors.length) p = await call("prepare-fix", composer, `Fix only the preparation schema errors:\n${errors.join("\n")}\nThe original rules apply. Do not compose a final answer yet.`, {}, guards.fix, ++n);
    errors = prepCheck(p);
    await freeze(join(dest, "prepared"), { [arm === "Q" ? "decisions.json" : "preparation.md"]: readOutput(p, arm === "Q" ? "decisions.json" : "preparation.md") }, { errors, baseHidden: true });
    if (errors.length) throw new Error(`preparation invalid: ${errors.length}`);
    const privateWork = join(composer, "private/work");
    // Only now reveal and seed BASE; qualification/preparation output is frozen already.
    if (!existsSync(join(privateWork, "final.md"))) await writeFile(join(privateWork, "final.md"), sources[`${base}.md`]!);
    const extra: Record<string, string> = arm === "Q" ? { "decisions-initial.json": readOutput(p, "decisions.json") } : {};
    const compose = fill(T_COMPOSE, base).replace(arm === "Q" ? "a strong earlier answer, the editing base" : "__never__", "the editing base, not a truth authority");
    let draft = await call("compose", composer, `${COMMON}\n${compose}\n${arm === "Q" ? Q_COMPOSE : ""}`, { ...extra, "base.json": JSON.stringify({ editingBase: base }) }, guards.compose, ++n);
    const check = (t: Turn) => {
      const plan = parseJson(readOutput(t, "plan.json"));
      const errors = checkFinal(claims, base, arm, plan, readOutput(t, "final.md"));
      if (arm === "Q") errors.push(...checkChanges(parseJson(extra["decisions-initial.json"]!), plan, parseJson(readOutput(t, "decision-changes.json"))));
      return errors;
    };
    let errs = check(draft);
    if (errs.length) draft = await call("compose-fix", composer, `${PLAN_FIX.replace("{ERRORS}", errs.join("\n"))}\n${arm === "Q" ? Q_COMPOSE : ""}`, {}, guards.fix, ++n);
    errs = check(draft);
    await freeze(join(dest, "draft"), { "final.md": readOutput(draft, "final.md"), "plan.json": readOutput(draft, "plan.json"), "decision-changes.json": readOutput(draft, "decision-changes.json"), "base.diff": diffOf(sources[`${base}.md`]!, readOutput(draft, "final.md"), dir) }, { errors: errs, linesKept: linesKept(sources[`${base}.md`]!, readOutput(draft, "final.md")) });
    if (errs.length) throw new Error(`compose schema invalid: ${errs.length}`);
    const auditInputs = { ...sources, ...extra, "final.md": readOutput(draft, "final.md"), "plan.json": readOutput(draft, "plan.json") };
    const audit = await call("audit", join(dir, "audit"), `${COMMON}\n${arm === "Q" ? Q_AUDIT : ""}\n${fill(T_AUDIT, base)}`, auditInputs, guards.audit, 1);
    const auditBody = readOutput(audit, "audit.json"), auditData = parseJson(auditBody);
    if (!Array.isArray(auditData?.defects)) throw new Error("audit schema invalid");
    if (arm === "Q" && (!Array.isArray(auditData.eligibility) || new Set(auditData.eligibility.map((e: any) => e.ref)).size !== ids.length || auditData.eligibility.some((e: any) => !ids.includes(e.ref) || !["agree", "challenge", "unresolved"].includes(e.assessment) || !String(e.reason ?? "").trim()))) throw new Error("eligibility audit incomplete");
    let final = await call("repair", composer, `${fill(T_REPAIR, base)}\n${arm === "Q" ? Q_REPAIR : ""}`, { "audit-1.json": auditBody }, guards.repair, ++n);
    errs = check(final);
    if (errs.length) final = await call("repair-fix", composer, `${PLAN_FIX.replace("{ERRORS}", errs.join("\n"))}\n${arm === "Q" ? Q_REPAIR : ""}`, {}, guards.fix, ++n);
    errs = check(final);
    const diff = diffOf(readOutput(draft, "final.md"), readOutput(final, "final.md"), dir);
    const again = await call("recheck", join(dir, "recheck"), `${COMMON}\n${fill(T_RECHECK, base)}\n${arm === "Q" ? Q_RECHECK : ""}`, { ...sources, ...extra, "final.md": readOutput(final, "final.md"), "plan.json": readOutput(final, "plan.json"), "audit-1.json": auditBody, "revision.diff": diff, "revision-note.md": final.reply }, guards.recheck, 1);
    const recheck = readOutput(again, "audit.json");
    if (!Array.isArray(parseJson(recheck)?.defects)) errs.push("recheck schema invalid");
    await freeze(join(dest, "final"), { "final.md": readOutput(final, "final.md"), "plan.json": readOutput(final, "plan.json"), "decision-changes.json": readOutput(final, "decision-changes.json"), "audit-1.json": auditBody, "recheck.json": recheck, "revision.diff": diff, "reply.md": final.reply }, { errors: errs, linesKept: linesKept(sources[`${base}.md`]!, readOutput(final, "final.md")), residual: parseJson(recheck)?.defects?.length });
    record.valid = errs.length === 0;
  } catch (e) { record.error = String(e); record.valid = false; console.error(id, record.error); }
  finally {
    record.endedAt = new Date().toISOString();
    for (const session of ["compose", "audit", "recheck"]) if (existsSync(join(dir, session))) await retainSession(join(dir, session), join(dest, "sessions", session));
    await write(join(dest, "pipeline.json"), record);
  }
}
export async function judge(study: string, unit: string, label: string, final: string, model: string): Promise<void> {
  const short = model.includes("claude") ? "claude" : "gpt", out = join(ROOT, unit, "judgments", `${label}.${short}.json`);
  if (existsSync(out)) { const old = json(out); if (old.textSha256 !== sha(final)) throw new Error("judgment text changed"); return; }
  const dir = join(study, "judges", unit, `${label}.${short}`), c = claimsOf(unit), source = packet(unit);
  const inputs = { "task.md": source["task.md"]!, "guide.md": source["guide.md"]!, "text.md": numberLines(final), "statements.json": JSON.stringify({ statements: c.map(x => ({ id: x.ref, statement: x.claim, stance: x.stance })) }) };
  const turns: Turn[] = [];
  try {
    turns.push(await turn({ dir, label: `${unit}-judge-${label}-${short}`, number: 1, model, kind: "none", prompt: JUDGE, inputs, guard: guards.judge }));
    let value = parseJson(readOutput(turns[0]!, "judgment.json")), errors = checkJudge(c.map(x => x.ref), value, final);
    if (errors.length && turns[0]!.ok) { turns.push(await turn({ dir, label: `${unit}-judge-${label}-${short}`, number: 2, model, kind: "none", prompt: `Fix only the JSON/schema/quote issues in judgment.json. Same semantic criteria.\n${errors.join("\n")}`, inputs: {}, guard: guards.fix })); value = parseJson(readOutput(turns[1]!, "judgment.json")); errors = checkJudge(c.map(x => x.ref), value, final); }
    await write(out, { label, model, textSha256: sha(final), valid: !errors.length && turns.every(t => t.ok), errors, judgment: value, turns });
  } catch (e) { await write(out, { label, model, textSha256: sha(final), valid: false, error: String(e), turns }); }
  finally { if (existsSync(dir)) await retainSession(dir, join(ROOT, unit, "judge-sessions", `${label}.${short}`)); }
}
export function checkManifest(): void {
  const m = json(join(ROOT, "manifest.json"));
  if (JSON.stringify(m.sources) !== JSON.stringify(sourceHashes())) throw new Error("runtime/helper source changed after manifest");
  for (const [file, hash] of Object.entries({ "protocol.md": m.protocol, "retry-protocol.md": m.retryProtocol, "retry-protocol-addendum-1.md": m.addendum1Sha256, "inputs-frozen.json": m.inputs, "references-frozen.json": m.referencesSha256, "round2-instructions.md": m.round2InstructionsSha256 })) if (sha(text(join(ROOT, file))) !== hash) throw new Error(`frozen ${file} changed`);
  const frozen = json(join(ROOT, "inputs-frozen.json"));
  for (const unit of UNITS) for (const [file, hash] of Object.entries(frozen.units[unit].files)) if (sha(text(join(ROOT, "inputs", unit, file))) !== hash) throw new Error(`input changed ${unit}/${file}`);
  for (const unit of UNITS) for (const who of ["a", "b"]) { const ref = m.references.references[unit][who]; if (!ref.missing && sha(text(join(ROOT, "references", `${unit}-${who}.json`))) !== ref.sha256) throw new Error("reference changed"); }
}
async function all(study: string) {
  checkManifest(); await setup(study);
  const lock = join(study, "runner-lock.json");
  if (existsSync(lock)) { const l = json(lock); let alive = false; try { process.kill(l.pid, 0); alive = true; } catch {} if (alive) throw new Error(`runner alive pid=${l.pid}`); }
  await write(lock, { pid: process.pid, startedAt: new Date().toISOString(), command: process.argv });
  await Promise.all(UNITS.flatMap(unit => REPS.flatMap(rep => (["T", "Q"] as Arm[]).map(arm => pipeline(study, unit, arm, rep)))));
  const jobs: Promise<void>[] = [];
  for (const unit of UNITS) {
    const source = packet(unit), base = keyOf(unit).base;
    for (const m of JUDGES) jobs.push(judge(study, unit, "baseline", source[`${base}.md`]!, m));
    for (const rep of REPS) for (const arm of ["T", "Q"]) {
      const dir = join(ROOT, unit, `${arm}-r${rep}`); if (!json(join(dir, "pipeline.json")).valid) continue;
      for (const m of JUDGES) jobs.push(judge(study, unit, `${arm}-r${rep}`, text(join(dir, "final/final.md")), m));
    }
  }
  await Promise.all(jobs);
  await write(join(study, "finished.json"), { at: new Date().toISOString(), pid: process.pid });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, study] = process.argv.slice(2); if (!study) throw new Error("study scratch path required"); setStudy(study);
  if (cmd === "prepare") await freezeManifest(study, prompts);
  else if (cmd === "all") await all(study);
  else if (cmd === "status") for (const u of UNITS) console.log(u, REPS.flatMap(r => ["T", "Q"].map(a => { const f = join(ROOT, u, `${a}-r${r}/pipeline.json`); return `${a}${r}:${existsSync(f) ? json(f).valid ? "valid" : "incomplete" : "pending"}`; })).join(" "), "judges", ["baseline", "T-r1", "Q-r1", "T-r2", "Q-r2"].map(l => `${l}:${JUDGES.map(m => { const f = join(ROOT, u, "judgments", `${l}.${m.includes("claude") ? "claude" : "gpt"}.json`); return existsSync(f) ? json(f).valid ? "V" : "X" : "."; }).join("")}`).join(" "));
  else throw new Error("prepare | all | status");
}
