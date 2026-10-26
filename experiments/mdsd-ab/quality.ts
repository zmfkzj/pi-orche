/**
 * Quality-first validation of the strong-preserving workflow (protocol: results/quality-validation/protocol.md, frozen before any
 * measured run; docs/mdsd-ab-bench.md "Quality validation"). Per case and repetition every stage is a fresh `pi` process in its own
 * sandbox, agent dir, scratch and commit-free target copy, through a logging proxy without an envelope:
 *   S  `/orche strong <task>`   the user's configured strong route (models.strong-orchestrator = cliproxyapi/gpt-6-astra, max)
 *   E  `/orche mdsd <task>`     independent exploration (never sees S, the evaluator material or the research context)
 *   X  claim extraction of S and E (one direct `pi` call per answer, the same extractor for every answer; quotes checked)
 *   A  `/orche mdsd <task + integration protocol>` with mdsd.seed = the extracted claims under origin-blinded labels P1/P2 and both
 *      answers as files: every claim accounted for, a follow-up search round on observed gaps, fresh verification, the final answer
 *   Y  the same extraction of A's answer (the evaluation compares Y with S's extraction, origin-blinded)
 * S and E are frozen (sha256, copied to results) before X and A start. No dollar, request or output-token ceiling applies to any stage:
 * bounds are wall time, search rounds and the host's verification rounds (anti-loop), plus provider/context limits.
 *
 *   node --import tsx experiments/mdsd-ab/quality.ts prepare <studyDir>
 *   node --import tsx experiments/mdsd-ab/quality.ts preflight <studyDir>
 *   node --import tsx experiments/mdsd-ab/quality.ts pipeline <studyDir> <dev|isort> <rep>
 *   node --import tsx experiments/mdsd-ab/quality.ts summarize <studyDir>
 *   node --import tsx experiments/mdsd-ab/quality.ts packets <studyDir> <keysDir>
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMdsdConfig, type MdsdSeedClaim } from "../../src/orchestrator/mdsd-config.js";
import { AGENT, HOME, REPO, TARGET_MOUNT, TOY_PROMPT, agentDir, catalogEntries, filesUnder, prepare as prepareInputs, readJsonl, runGuarded, sandboxArgs, sha, startProxy, taskRuns, write } from "./run.js";
import { auditMatrix, contentHashes, hashDiff, piArgs, redact, sandboxEnv, sessionTranscripts, snapshot, wireStats } from "./matrix.js";

export const MODEL_ID = "gpt-6-astra";
export const MODEL = `cliproxyapi/${MODEL_ID}`;
export const RESULTS = join(REPO, "results/quality-validation");
export type CaseId = "dev" | "isort" | "toy";
export type StageName = "S" | "E" | "A";
const ISORT = {
  fixture: join(REPO, "fixtures/advisor-bench/swe/pycqa__isort-2491"), cache: join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491"),
  mount: join(HOME, "Code/isort"), venv: join(HOME, ".venvs/isort"),
};
const MIN = 60_000, HOUR = 60 * MIN;
/** Anti-loop bounds (time only): the orche assignment limit and the process guard (assignment + 2 extensions of 30 min + 30 min). */
export const BOUNDS: Record<StageName | "X", { assignmentMs: number; guardMs: number }> = {
  S: { assignmentMs: 4 * HOUR, guardMs: 5.5 * HOUR }, E: { assignmentMs: 4 * HOUR, guardMs: 5.5 * HOUR }, A: { assignmentMs: 6 * HOUR, guardMs: 7.5 * HOUR }, X: { assignmentMs: 0, guardMs: 45 * MIN },
};
/** MDSD without money, request or output ceilings for this validation (structural rules, rounds and time bounds unchanged). */
export const QUALITY_MDSD = {
  maxRounds: 3,
  explorer: { requests: 5000, minutes: 240, costUSD: 1_000_000, outputTokens: 100_000_000 },
  explorerMax: { requests: 5000, minutes: 240, costUSD: 1_000_000, outputTokens: 100_000_000 },
  total: { costUSD: 100_000_000, requests: 10_000_000 },
  explorerScratch: true,
};

/**
 * The stage's orche config: the user's live config (read only, never written) with the declared deviations: thinkingPolicy recovers
 * output-limit stops without lowering effort (`redecompose`; live: the default `step-down`), time limits instead of the 30-minute
 * defaults and a request soft budget that never stops work, no specialist routes, and the uncapped MDSD settings for E and A.
 */
export function qualityConfig(stage: StageName, seed?: { claims: MdsdSeedClaim[] }): Record<string, unknown> {
  const live = JSON.parse(readFileSync(join(AGENT, "orche.config.json"), "utf8")) as Record<string, unknown>;
  const { images: _images, routes: _routes, ...kept } = live;
  const assignmentMs = BOUNDS[stage].assignmentMs;
  return {
    ...kept, routes: {},
    thinkingPolicy: { mode: "fixed", lengthRecovery: "redecompose" },
    limits: { overallMs: assignmentMs, assignmentMs, extensionMs: 30 * MIN, extensionStepMs: 0, maxExtensions: 2, assignmentRequests: 5000 },
    ...(stage === "S" ? {} : { mdsd: { ...QUALITY_MDSD, ...(seed ? { seed } : {}) } }),
  };
}

// ---- prompts (preregistered: protocol.md quotes them by sha256) --------------------------------------------------------------------
export function isortPrompt(): string {
  const task = JSON.parse(readFileSync(join(ISORT.fixture, "task.json"), "utf8"));
  const report = String(task.problemStatement).replace(/\r\n/g, "\n").trim();
  return [
    `Read-only investigation of a bug report against the Python project in the current directory (the PyCQA/isort repository at commit ${task.baseCommit}; no git history is available). Bug report, verbatim:`,
    "", report, "",
    "Your task:",
    "1. Determine the root cause(s) in the code, with file:line evidence.",
    "2. Determine the complete set of input conditions under which the reported misplacement, or the same underlying defect, occurs — including related variants (other import forms, comment positions, wrapping modes or settings) that a complete fix must also handle — and similar-looking conditions that are not affected.",
    "3. State precisely what a correct fix must change (the required behaviour and the code locations), without modifying the repository.",
    `4. Support every claim with evidence: code reading, and running isort on example inputs where possible. \`python3\` can import isort from the current directory; a virtualenv with the project's test dependencies is at ${ISORT.venv} (read-only; run \`${ISORT.venv}/bin/python -m pytest ...\` from the current directory). Use your scratch directory for temporary files; do not modify the repository.`,
  ].join("\n");
}
export const EXTRACTION_PROMPT = [
  "You extract claims from an answer to a code-analysis task, for a later evaluation. You do not judge them.",
  "The answer is in the file /tmp/pi-orche/answer.md (the final message to the user, then the task report). Read the whole file (use several reads with offset if it is long) before you answer.",
  "List every distinct substantive claim the answer makes about the code or the task: each defect, risk, behaviour, root cause, required fix condition or conclusion it asserts, and each item it explicitly rejects (says is not a defect, or was refuted) or leaves uncertain. Merge only restatements of the same claim within this answer; keep different claims separate even when related. Do not add claims, do not use outside knowledge, do not evaluate truth.",
  'Return ONLY one JSON object, no prose and no code fence: {"claims":[{"id":"c1","claim":"faithful restatement in one or two sentences with the specifics the answer gives","quote":"a verbatim excerpt of 8 to 60 words copied exactly from the answer where it states this claim","locations":["file:line or file references exactly as the answer cites them"],"requirements":["requirement ids the answer ties it to, e.g. A1-R3"],"stance":"asserted"}]} where stance is "asserted", "uncertain" or "rejected".',
].join("\n");
export const INTEGRATION_PROTOCOL = [
  "=== Integration and follow-up stage (this run) ===",
  "Two earlier analyses of exactly this task were made independently of each other: P1 and P2 (the order is random). Their final answers are in /tmp/pi-orche/prior/P1.md and /tmp/pi-orche/prior/P2.md (read both completely), and every claim extracted from them is registered for this run (refs P1:c1…, P2:c1…; listed in your MDSD instructions). None of them is verified, and agreement between P1 and P2 is not proof.",
  "Produce the best possible final answer to the task above:",
  "1. Account for every registered claim with evidence: confirm it with your own checks or a fresh verifier's, correct it (state the corrected claim and the evidence), keep it explicitly unverified or disputed when it stays open, or drop it with the evidence that refutes it, shows it outside the task's scope, or shows it duplicates another. A claim that was not refuted is not thereby confirmed.",
  "2. Find the gaps before searching: requirements of the task no claim covers, conflicting claims, and claims that need a reproduction. Your first search round follows up these observed gaps (adapt.basis cites the registered claim ids and aggregation ids it acts on; include an explore strategy for requirements and scope no claim covers). Further rounds only for gaps that remain.",
  "3. Stop when every requirement of the task has an evidenced verdict (a confirmed finding, or no defect found after a targeted search), when a round adds no new validated finding, or at the round cap.",
  "4. The final answer states every confirmed finding with its evidence (file:line, reproduction), the corrected claims, the rejected claims with the reason, and what stays uncertain. Do not omit a confirmed finding because an earlier analysis already stated it.",
].join("\n");

// ---- targets -----------------------------------------------------------------------------------------------------------------------
async function makeTarget(dir: string, caseId: CaseId): Promise<{ dir: string; mount: string; extra: string[]; nodeModules: boolean; head?: string; tree?: string }> {
  if (caseId !== "isort") { const target = await snapshot(dir, caseId === "toy"); return { dir: target.dir, mount: TARGET_MOUNT, extra: [], nodeModules: true, ...(target.head ? { head: target.head, tree: target.tree } : {}) }; }
  const target = join(dir, "target");
  await cp(join(ISORT.cache, "src"), target, { recursive: true });
  return { dir: target, mount: ISORT.mount, extra: ["--ro-bind", join(ISORT.cache, "venv"), ISORT.venv], nodeModules: false };
}
function prices(): Record<string, unknown> {
  const entry = catalogEntries(JSON.parse(readFileSync(join(AGENT, "cliproxyapi-models.json"), "utf8"))).find(item => item.id === MODEL_ID);
  if (!entry) throw new Error(`${MODEL_ID} is not in the CLIProxyAPI catalog`);
  if (entry.thinkingLevelMap?.max !== "max") throw new Error(`${MODEL_ID}: thinking max is not mapped to effort max`);
  return { [MODEL_ID]: entry.cost };
}
/**
 * The orche result the user got: the last report of the worker that ran the last completed orche task. Main may continue or retry a
 * failed task with the same or a new worker (W2 after a failed W1), so W1's last report is not necessarily the answer.
 */
export function finalReport(tasks: { run: any }[], sessions: Map<string, { agent: string; reports: any[] }>): any {
  const time = (value: unknown) => new Date(value as string | number).getTime() || 0;
  const ordered = [...tasks].sort((a, b) => time(a.run.start) - time(b.run.start));
  const done = ordered.filter(item => item.run.status === "done" || item.run.outcome?.status === "completed");
  const worker = (done.at(-1) ?? ordered.at(-1))?.run.worker?.id ?? "W1";
  return [...sessions.values()].find(item => item.agent === worker)?.reports.at(-1) ?? null;
}
/** Re-select a frozen stage's report from its copied records with finalReport (the earlier final.json is kept as final-v1.json). */
async function refreeze(unit: string, name: StageName, apply: boolean): Promise<void> {
  const results = join(RESULTS, unit, name);
  const old = JSON.parse(readFileSync(join(results, "final.json"), "utf8"));
  const tasks = taskRuns(join(results, "records"));
  const report = finalReport(tasks, sessionTranscripts(join(results, "records"), join(results, "sessions")));
  const changed = sha(JSON.stringify(report)) !== old.reportSha256;
  const workers = tasks.map(item => `${item.run.worker?.id}:${item.run.status}/${item.run.outcome?.status}`).join(", ");
  console.log(`${unit}/${name}: tasks ${workers}; report ${changed ? "CHANGES" : "unchanged"}`);
  if (!changed || !apply) return;
  await copyFile(join(results, "final.json"), join(results, "final-v1.json"));
  const final = { ...old, report, reportSha256: sha(JSON.stringify(report)), refrozenAt: new Date().toISOString(), refreezeReason: "report of the last completed task's worker (finalReport), not W1's last report" };
  await write(join(results, "final.json"), final);
  const frozen = JSON.parse(readFileSync(join(results, "frozen.json"), "utf8"));
  await write(join(results, "frozen.json"), { ...frozen, reportSha256: final.reportSha256, refrozenAt: final.refrozenAt, previousReportSha256: old.reportSha256 });
}
const finalText = (events: any[]): string => {
  let text = "";
  for (const event of events) { const message = event?.message; if (event?.type === "message_end" && message?.role === "assistant" && Array.isArray(message.content)) { const part = message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join(""); if (part.trim()) text = part; } }
  return text;
};

// ---- one stage ---------------------------------------------------------------------------------------------------------------------
export interface StageOut { ok: boolean; report: any; text: string; results: string; meta: any }
const log = (study: string, line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); appendFileSync(join(study, "progress.log"), `${text}\n`); };

export async function runStage(study: string, unit: string, name: StageName, caseId: CaseId, body: string, config: Record<string, unknown>, prior?: Record<string, string>): Promise<StageOut> {
  const dir = join(study, unit, name), results = join(RESULTS, unit, name);
  if (existsSync(join(results, "frozen.json"))) { const frozen = JSON.parse(readFileSync(join(results, "final.json"), "utf8")); return { ok: !!frozen.report, report: frozen.report, text: frozen.text, results, meta: JSON.parse(readFileSync(join(results, "meta.json"), "utf8")) }; }
  if (existsSync(join(dir, "meta.json"))) throw new Error(`${dir} ran without a frozen result; inspect it (never rerun a measured stage silently)`);
  await mkdir(dir, { recursive: true });
  const target = await makeTarget(dir, caseId);
  const before = contentHashes(target.dir);
  const scratch = join(dir, "pi-orche");
  await mkdir(join(scratch, "tmp"), { recursive: true });
  if (prior) { await mkdir(join(scratch, "prior"), { recursive: true }); for (const [file, text] of Object.entries(prior)) await writeFile(join(scratch, "prior", file), text); }
  await write(join(dir, "envelope.json"), { prices: prices() });
  await write(join(dir, "orche.config.json"), config);
  const proxy = await startProxy(join(dir, "wire.jsonl"), join(dir, "envelope.json"));
  const agent = await agentDir(dir, proxy.url, config);
  const mode = name === "S" ? "strong" : "mdsd";
  const prompt = `/orche ${mode} ${body}`;
  const sessionId = `qv-${unit}-${name}`;
  const args = [...sandboxArgs({ agent: agent.dir, target: target.dir, runtime: join(study, "runtime"), provider: join(study, "provider"), scratch, mount: target.mount, extra: target.extra, targetNodeModules: target.nodeModules }), "--", ...piArgs(MODEL, sessionId, prompt, true)];
  const meta: any = {
    unit, stage: name, mode, caseId, model: MODEL, thinking: "max", configSha256: sha(JSON.stringify(config)), promptSha256: sha(prompt), bodySha256: sha(body),
    priorSha256: prior ? Object.fromEntries(Object.entries(prior).map(([file, text]) => [file, sha(text)])) : undefined,
    target: { head: target.head, tree: target.tree, files: Object.keys(before).length, digest: sha(JSON.stringify(before)), mount: target.mount },
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), proxySha256: sha(readFileSync(join(REPO, "experiments/mdsd-ab/proxy.mjs"))), startedAt: new Date().toISOString(),
  };
  await write(join(dir, "meta.json"), meta);
  await write(join(dir, "target-before.json"), before);
  log(study, `${unit}/${name} start (${mode}, ${caseId})`);
  // orche removes the orchestrator's scratch when its assignment ends: copy MDSD round files as they appear (every version, hashed).
  const sessionScratch = join(scratch, "tmp/pi-orche", sessionId), rounds = join(dir, "rounds"), seen = new Map<string, string>();
  const copyRounds = () => { try { for (const file of filesUnder(sessionScratch, /^mdsd-.*\.(md|json)$/)) { const bytes = readFileSync(file), digest = sha(bytes), base = basename(file); if (seen.get(base) === digest) continue; seen.set(base, digest); mkdirSync(rounds, { recursive: true }); writeFileSync(join(rounds, base), bytes); appendFileSync(join(rounds, "copies.jsonl"), `${JSON.stringify({ name: base, sha256: digest, bytes: bytes.length, at: new Date().toISOString() })}\n`); } } catch { /* next tick */ } };
  const copier = setInterval(copyRounds, 500);
  try {
    meta.pi = await runGuarded("bwrap", args, { env: sandboxEnv(proxy.url, agent.apiKey), stdout: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt"), guardMs: BOUNDS[name].guardMs });
  } finally { clearInterval(copier); copyRounds(); proxy.child.kill("SIGTERM"); }
  meta.wallMs = meta.pi.endedAt - meta.pi.startedAt;
  const after = contentHashes(target.dir);
  await write(join(dir, "target-after.json"), after);
  meta.targetCheck = hashDiff(before, after);
  // Telemetry: every request, every session's route, the orche task records, the audit.
  const wire = readJsonl(join(dir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model);
  const records = join(agent.dir, "orche/records");
  const sessions = sessionTranscripts(records, join(agent.dir, "sessions"));
  const known = new Set(sessions.keys());
  meta.wire = { ...wireStats(wire), unmatched: wire.filter(entry => !known.has(entry.session)).length, totals: existsSync(join(dir, "wire.jsonl.totals.json")) ? JSON.parse(readFileSync(join(dir, "wire.jsonl.totals.json"), "utf8")) : undefined };
  meta.sessions = [...sessions.values()].map(item => ({ agent: item.agent, id: item.id, models: [...new Set(item.models)], thinking: [...new Set(item.thinking)], responseModels: item.responseModels, requests: wire.filter(entry => entry.session === item.id).length }));
  meta.route = {
    requests: wire.every(entry => entry.model === MODEL_ID && entry.effort === "max" && (entry.updateEfforts ?? []).every((effort: string) => effort === "max")),
    sessions: meta.sessions.every((item: any) => item.models.every((model: string) => model === MODEL) && item.thinking.every((level: string) => level === "max") && Object.keys(item.responseModels).every(model => model === MODEL)),
  };
  const tasks = taskRuns(records);
  meta.tasks = tasks.map(item => ({ file: item.file, status: item.run.status, outcome: item.run.outcome?.status, mode: item.run.assignment?.mode, tier: item.run.assignment?.tier, model: item.run.assignment?.model, thinking: item.run.assignment?.thinking, requests: item.run.outcome?.requests, durationMs: item.run.durationMs, compactions: item.run.outcome?.compactions?.count, agents: (item.run.agents ?? []).map((a: any) => ({ id: a.id, role: a.role, reason: a.reason, model: a.model, thinking: a.thinking, modelSource: a.modelSource, status: a.status, requests: a.requests, durationMs: a.durationMs })), mdsd: item.run.outcome?.mdsd ? (({ explorers, ...rest }: any) => ({ ...rest, explorers: (explorers ?? []).map((e: any) => ({ id: e.id, round: e.round, status: e.status, findings: e.findings, actual: e.actual, stoppedBy: e.stoppedBy, wrapUp: e.wrapUp })) }))(item.run.outcome.mdsd) : undefined }));
  const subWorkers = new Set(meta.sessions.map((item: any) => item.agent).filter((id: string) => /^W1\.\d+$/.test(id)));
  meta.audit = auditMatrix([...sessions.values()].map(item => item.file), `/tmp/pi-orche/tmp/pi-orche/${sessionId}`, subWorkers as Set<string>);
  meta.truncation = { guardFired: meta.pi.guardFired, exit: meta.pi.code, incompleteResponses: meta.wire.incomplete, unknownUsage: meta.wire.unknownUsage, providerErrors: meta.wire.providerErrors.length };
  // Freeze: the report of the last completed orche task's worker (main may retry with a new worker) and main's final message.
  const report = finalReport(tasks, sessions);
  const text = finalText(readJsonl(join(dir, "events.jsonl")));
  const final = { report, text, reportSha256: report ? sha(JSON.stringify(report)) : null, textSha256: sha(text), frozenAt: new Date().toISOString() };
  meta.ok = !!report && meta.pi.code === 0 && !meta.pi.guardFired;
  meta.endedAt = new Date().toISOString();
  await write(join(dir, "meta.json"), meta);
  await mkdir(results, { recursive: true });
  await write(join(results, "final.json"), final);
  for (const file of ["meta.json", "events.jsonl", "stderr.txt", "wire.jsonl", "wire.jsonl.totals.json", "envelope.json", "orche.config.json", "target-before.json", "target-after.json"]) if (existsSync(join(dir, file))) await copyFile(join(dir, file), join(results, file));
  await cp(records, join(results, "records"), { recursive: true }).catch(() => undefined);
  await cp(join(agent.dir, "sessions"), join(results, "sessions"), { recursive: true }).catch(() => undefined);
  if (existsSync(rounds)) await cp(rounds, join(results, "rounds"), { recursive: true });
  if (prior) await cp(join(scratch, "prior"), join(results, "prior"), { recursive: true });
  await redact(results, agent.secrets);
  await write(join(results, "frozen.json"), { ok: meta.ok, reportSha256: final.reportSha256, textSha256: final.textSha256, frozenAt: final.frozenAt });
  log(study, `${unit}/${name} done ok=${meta.ok} exit=${meta.pi.code} ${Math.round(meta.wallMs / 1000)}s ${meta.wire.requests} req $${meta.wire.costUSD} route=${meta.route.requests && meta.route.sessions} target=${meta.targetCheck.unchanged} audit=${meta.audit.hits.length}/${meta.audit.cross.length}`);
  return { ok: meta.ok, report, text, results, meta };
}

// ---- claim extraction --------------------------------------------------------------------------------------------------------------
export interface Claim { id: string; claim: string; quote: string; locations: string[]; requirements: string[]; stance: "asserted" | "uncertain" | "rejected"; quoteOk: boolean }
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
/** The answer as the extractor and the integration stage read it: main's final message, then the orche task report. */
export function answerDocument(out: { text: string; report: any }): string {
  const report = out.report?.arguments ?? {};
  return [`# Final message to the user`, "", out.text || "(none)", "", `# Task report`, "", `## Summary`, "", String(report.summary ?? "(none)"), "", "## Data", "", "```json", JSON.stringify(report.data ?? {}, null, 1), "```", ""].join("\n");
}
/** Claims of the extractor's JSON, checked: unique ids renumbered c1…, fields typed, each quote found verbatim (word-normalized) in the answer. */
export function parseClaims(raw: string, document: string): Claim[] {
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the extractor's answer");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed?.claims)) throw new Error("the extractor's JSON has no claims array");
  const source = words(document);
  return parsed.claims.filter((item: any) => item && typeof item.claim === "string" && item.claim.trim()).map((item: any, index: number): Claim => {
    const quote = typeof item.quote === "string" ? item.quote : "";
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 40) : [];
    return { id: `c${index + 1}`, claim: item.claim.trim().slice(0, 4000), quote: quote.slice(0, 4000), locations: strings(item.locations), requirements: strings(item.requirements), stance: item.stance === "uncertain" || item.stance === "rejected" ? item.stance : "asserted", quoteOk: !!words(quote) && source.includes(words(quote)) };
  });
}
export async function extract(study: string, unit: string, label: string, out: { text: string; report: any }): Promise<{ claims: Claim[]; meta: any }> {
  const results = join(RESULTS, unit, `X-${label}`);
  if (existsSync(join(results, "claims.json"))) return JSON.parse(readFileSync(join(results, "claims.json"), "utf8"));
  const document = answerDocument(out);
  const attempts: any[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const dir = join(study, unit, `X-${label}-${attempt}`);
    await mkdir(join(dir, "target"), { recursive: true });
    await mkdir(join(dir, "pi-orche/tmp"), { recursive: true });
    await writeFile(join(dir, "pi-orche/answer.md"), document);
    await write(join(dir, "envelope.json"), { prices: prices() });
    const proxy = await startProxy(join(dir, "wire.jsonl"), join(dir, "envelope.json"));
    const agent = await agentDir(dir, proxy.url, { routes: {} });
    const sessionId = `qv-${unit}-X-${label}-${attempt}`;
    const args = [...sandboxArgs({ agent: agent.dir, target: join(dir, "target"), runtime: join(study, "runtime"), provider: join(study, "provider"), scratch: join(dir, "pi-orche"), mount: join(HOME, "work"), targetNodeModules: false }), "--", ...piArgs(MODEL, sessionId, EXTRACTION_PROMPT, false)];
    let outcome;
    try { outcome = await runGuarded("bwrap", args, { env: sandboxEnv(proxy.url, agent.apiKey), stdout: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt"), guardMs: BOUNDS.X.guardMs }); } finally { proxy.child.kill("SIGTERM"); }
    const raw = finalText(readJsonl(join(dir, "events.jsonl")));
    const wire = readJsonl(join(dir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model);
    const record: any = { attempt, exit: outcome.code, guardFired: outcome.guardFired, ms: outcome.endedAt - outcome.startedAt, wire: wireStats(wire), route: wire.every(entry => entry.model === MODEL_ID && entry.effort === "max"), rawSha256: sha(raw) };
    attempts.push(record);
    await mkdir(results, { recursive: true });
    await writeFile(join(results, `raw-${attempt}.txt`), raw);
    for (const file of ["events.jsonl", "wire.jsonl", "stderr.txt"]) if (existsSync(join(dir, file))) await copyFile(join(dir, file), join(results, `${attempt}-${file}`));
    try {
      const claims = parseClaims(raw, document);
      const meta = { label, attempts, documentSha256: sha(document), claims: claims.length, quoteOk: claims.filter(claim => claim.quoteOk).length, stances: claims.reduce((acc: Record<string, number>, claim) => { acc[claim.stance] = (acc[claim.stance] ?? 0) + 1; return acc; }, {}) };
      await writeFile(join(results, "answer.md"), document);
      await write(join(results, "claims.json"), { claims, meta });
      await redact(results, agent.secrets);
      log(study, `${unit}/X-${label} ${claims.length} claims (quotes found ${meta.quoteOk})`);
      return { claims, meta };
    } catch (error) { record.parseError = String(error).slice(0, 300); log(study, `${unit}/X-${label} attempt ${attempt} unusable: ${record.parseError}`); }
  }
  throw new Error(`${unit}/X-${label}: no usable extraction after 2 attempts`);
}

// ---- seeds and the pipeline --------------------------------------------------------------------------------------------------------
/** Origin-blinded seeds: the two claim sets as P1/P2 in an order fixed by the unit's hash; the key stays with the harness records. */
export function seedsOf(unit: string, sets: { S: Claim[]; E: Claim[] }): { seed: { claims: MdsdSeedClaim[] }; key: { P1: "S" | "E"; P2: "S" | "E" }; map: Record<string, string> } {
  const sFirst = parseInt(sha(`${unit}:labels`).slice(0, 1), 16) % 2 === 0;
  const key = sFirst ? { P1: "S" as const, P2: "E" as const } : { P1: "E" as const, P2: "S" as const };
  const claims: MdsdSeedClaim[] = [], map: Record<string, string> = {};
  for (const label of ["P1", "P2"] as const) sets[key[label]].forEach((claim, index) => {
    const ref = `${label}:c${index + 1}`;
    map[ref] = `${key[label]}:${claim.id}`;
    claims.push({ ref, claim: claim.claim, ...(claim.quote ? { quote: claim.quote } : {}), ...(claim.locations.length ? { locations: claim.locations } : {}), ...(claim.requirements.length ? { requirements: claim.requirements } : {}), stance: claim.stance });
  });
  parseMdsdConfig({ seed: { claims } });
  return { seed: { claims }, key, map };
}
/** A prior answer as the integration stage reads it: the same document, with run-internal worker refs masked (origin cues). */
const masked = (document: string) => document.replace(/\bW\d+(?:\.\d+)+(?::f\d+)?\b/g, "[ref]").replace(/\bF\d+=/g, "");

export async function pipeline(study: string, caseId: CaseId, rep: number): Promise<void> {
  const unit = `${caseId}-r${rep}`;
  const body = caseId === "dev" ? await readFile(join(study, "input/prompt-body.md"), "utf8") : caseId === "isort" ? isortPrompt() : TOY_PROMPT;
  const [S, E] = await Promise.all([runStage(study, unit, "S", caseId, body, qualityConfig("S")), runStage(study, unit, "E", caseId, body, qualityConfig("E"))]);
  if (!S.ok || !E.ok) { log(study, `${unit}: S ok=${S.ok} E ok=${E.ok}; the pipeline stops here (incomplete, not a quality result)`); if (!S.report || !E.report) return; }
  const [xs, xe] = await Promise.all([extract(study, unit, "S", S), extract(study, unit, "E", E)]);
  const { seed, key, map } = seedsOf(unit, { S: xs.claims, E: xe.claims });
  await mkdir(join(RESULTS, unit), { recursive: true });
  await write(join(RESULTS, unit, "seed.json"), { seed, key, map, sha256: sha(JSON.stringify(seed)) });
  const prior = { "P1.md": masked(answerDocument(key.P1 === "S" ? S : E)), "P2.md": masked(answerDocument(key.P2 === "S" ? S : E)) };
  const A = await runStage(study, unit, "A", caseId, `${body}\n\n${INTEGRATION_PROTOCOL}`, qualityConfig("A", seed), prior);
  if (!A.report) { log(study, `${unit}: A produced no report (incomplete)`); return; }
  await extract(study, unit, "A", A);
  log(study, `${unit}: pipeline complete`);
}

// ---- preflight, summary, evaluation packets ----------------------------------------------------------------------------------------
async function preflight(study: string): Promise<void> {
  const toySeed = { claims: [
    { ref: "P1:c1", claim: "mean([]) returns NaN: calc.js divides sum([]) = 0 by xs.length = 0 without a guard", locations: ["calc.js:6"], stance: "asserted" as const },
    { ref: "P2:c1", claim: "sum([]) throws a TypeError because reduce has no initial value", locations: ["calc.js:2"], stance: "asserted" as const },
  ] };
  const prior = { "P1.md": "# Final message\n\nmean([]) returns NaN (calc.js:6): 0/0.\n", "P2.md": "# Final message\n\nsum([]) throws a TypeError (calc.js:2): reduce without an initial value.\n" };
  const [strong, seeded] = await Promise.all([
    runStage(study, "toy-strong", "S", "toy", TOY_PROMPT, qualityConfig("S")),
    runStage(study, "toy-seed", "A", "toy", `${TOY_PROMPT}\n\n${INTEGRATION_PROTOCOL}`, qualityConfig("A", toySeed), prior),
  ]);
  const check = (out: StageOut) => ({ ok: out.ok, route: out.meta.route, tasks: out.meta.tasks?.map((task: any) => ({ mode: task.mode, tier: task.tier, model: task.model, thinking: task.thinking, outcome: task.outcome, mdsd: task.mdsd ? { rounds: task.mdsd.rounds, findings: task.mdsd.findings, gate: task.mdsd.gate } : undefined })), wire: { requests: out.meta.wire.requests, routes: out.meta.wire.routes, updateEfforts: out.meta.wire.updateEfforts, unmatched: out.meta.wire.unmatched, costUSD: out.meta.wire.costUSD } });
  const result = { at: new Date().toISOString(), strong: check(strong), seeded: check(seeded), pass: strong.ok && seeded.ok && strong.meta.route.requests && strong.meta.route.sessions && seeded.meta.route.requests && seeded.meta.route.sessions };
  await write(join(RESULTS, "preflight.json"), result);
  console.log(JSON.stringify(result, null, 1));
}

async function summarize(study: string): Promise<void> {
  const units = ["dev-r1", "isort-r1", "isort-r2"].filter(unit => existsSync(join(RESULTS, unit)));
  const rows = units.flatMap(unit => (["S", "E", "A"] as const).filter(name => existsSync(join(RESULTS, unit, name, "meta.json"))).map(name => {
    const meta = JSON.parse(readFileSync(join(RESULTS, unit, name, "meta.json"), "utf8"));
    const task = meta.tasks?.at(-1);
    return { unit, stage: name, ok: meta.ok, wallMs: meta.wallMs, requests: meta.wire?.requests, costUSD: meta.wire?.costUSD, input: meta.wire?.input, cached: meta.wire?.cached, output: meta.wire?.output, reasoning: meta.wire?.reasoning, unknownUsage: meta.wire?.unknownUsage, unmatched: meta.wire?.unmatched, route: meta.route, truncation: meta.truncation, target: meta.targetCheck?.unchanged, spill: meta.targetCheck?.spill, audit: { hits: meta.audit?.hits?.length, cross: meta.audit?.cross?.length, review: meta.audit?.review?.length }, agents: task?.agents?.length, compactions: task?.compactions, mdsd: task?.mdsd ? { rounds: task.mdsd.rounds, findings: task.mdsd.findings, verificationRounds: task.mdsd.verificationRounds, gate: task.mdsd.gate, decision: task.mdsd.decision } : undefined };
  }));
  const extractions = units.flatMap(unit => ["S", "E", "A"].filter(label => existsSync(join(RESULTS, unit, `X-${label}`, "claims.json"))).map(label => { const { meta } = JSON.parse(readFileSync(join(RESULTS, unit, `X-${label}`, "claims.json"), "utf8")); return { unit, label, claims: meta.claims, quoteOk: meta.quoteOk, stances: meta.stances, attempts: meta.attempts.map((a: any) => ({ requests: a.wire.requests, costUSD: a.wire.costUSD, ms: a.ms, route: a.route })) }; }));
  await write(join(RESULTS, "summary.json"), { at: new Date().toISOString(), rows, extractions });
  for (const row of rows) console.log(`${row.unit}/${row.stage} ok=${row.ok} ${Math.round((row.wallMs ?? 0) / 1000)}s ${row.requests}req $${row.costUSD} route=${row.route?.requests}/${row.route?.sessions} trunc=${JSON.stringify(row.truncation)} target=${row.target} audit=${JSON.stringify(row.audit)} mdsd=${JSON.stringify(row.mdsd ?? {})}`);
  for (const row of extractions) console.log(`${row.unit}/X-${row.label} claims=${row.claims} quotes=${row.quoteOk} ${JSON.stringify(row.stances)} ${JSON.stringify(row.attempts)}`);
}

/** Origin-blinded packets: S's and A's extracted claims as answers X and Y (order by hash); the key goes to keysDir, not the packet. */
async function packets(study: string, keysDir: string): Promise<void> {
  await mkdir(keysDir, { recursive: true });
  for (const unit of ["dev-r1", "isort-r1", "isort-r2"]) {
    const xs = join(RESULTS, unit, "X-S/claims.json"), xa = join(RESULTS, unit, "X-A/claims.json");
    if (!existsSync(xs) || !existsSync(xa)) { console.log(`${unit}: no pair`); continue; }
    const sFirst = parseInt(sha(`${unit}:eval`).slice(0, 1), 16) % 2 === 0;
    const sets = { S: JSON.parse(readFileSync(xs, "utf8")).claims as Claim[], A: JSON.parse(readFileSync(xa, "utf8")).claims as Claim[] };
    const order = sFirst ? (["S", "A"] as const) : (["A", "S"] as const);
    const block = (label: string, claims: Claim[]) => [`## Answer ${label}`, "", ...claims.map(claim => `- ${label}${claim.id.slice(1)} [${claim.stance}] ${claim.claim}${claim.locations.length ? ` | locations: ${claim.locations.join("; ")}` : ""}${claim.requirements.length ? ` | requirements: ${claim.requirements.join(", ")}` : ""}\n  quote: "${claim.quote}"`), ""].join("\n");
    const text = [`# Evaluation packet ${unit}`, "", `Answers X and Y are two final answers to the same task, as extracted claim lists (same extractor for both; quotes are verbatim from each answer). Their origin is withheld.`, "", block("X", sets[order[0]]), block("Y", sets[order[1]])].join("\n");
    await mkdir(join(RESULTS, unit, "eval"), { recursive: true });
    await writeFile(join(RESULTS, unit, "eval/packet.md"), text);
    await write(join(keysDir, `${unit}.json`), { X: order[0], Y: order[1], packetSha256: sha(text) });
    console.log(`${unit}: packet ${sha(text).slice(0, 12)} X=${sets[order[0]].length} Y=${sets[order[1]].length} claims`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, study, a, b] = process.argv.slice(2);
  if (!study) throw new Error("usage: quality.ts prepare|preflight|pipeline|summarize|packets <studyDir> …");
  await mkdir(study, { recursive: true });
  if (command === "prepare") { await prepareInputs(study); console.log(`prepared ${study}; isort prompt ${sha(isortPrompt()).slice(0, 12)}, dev prompt ${sha(await readFile(join(study, "input/prompt-body.md"), "utf8")).slice(0, 12)}`); }
  else if (command === "preflight") await preflight(study);
  else if (command === "pipeline") await pipeline(study, a as CaseId, Number(b));
  else if (command === "summarize") await summarize(study);
  else if (command === "packets") await packets(study, a!);
  else if (command === "refreeze") { for (const unit of ["dev-r1", "isort-r1", "isort-r2"]) for (const name of ["S", "E", "A"] as const) if (existsSync(join(RESULTS, unit, name, "final.json"))) await refreeze(unit, name, a === "--apply"); }
  else if (command === "extract") { const out = JSON.parse(readFileSync(join(RESULTS, a!, b!, "final.json"), "utf8")); await extract(study, a!, b!, out); }
  else throw new Error(`unknown command ${command}`);
  process.exit(0);
}
