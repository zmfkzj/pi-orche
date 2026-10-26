/**
 * Round-2 case screening, verification and selection (results/cb-ab/PROTOCOL-R2.md Part S "Case screening", "Qualifying and selection";
 * Amendment R2-A1 item 4).
 *
 *   node --import tsx experiments/cb-ab/screen.ts run <poolJson> <T1|T2> <outDir> --scratch <dir> [--concurrency N] [--fixtures <root>] [--cache <root>] [--guard-min M]
 *   node --import tsx experiments/cb-ab/screen.ts one <taskId> <outDir> --scratch <dir> [--n N] [--fixtures <root>] [--cache <root>]   (one record, e.g. a preflight)
 *   node --import tsx experiments/cb-ab/screen.ts verify <outDir> [--fixtures <root>] [--cache <root>]                    (model-free re-verification)
 *   node --import tsx experiments/cb-ab/screen.ts select <outDir> <calibrationStudy> <calibrationScoresDir> <selectedDir>
 *
 * Roots: fixtures <root>/<id>/{task.json, hidden/test.patch, reference/fix.patch} (default fixtures/advisor-bench/swe-r2), cache
 * <root>/<id>/{src, venv} (default results/advisor-reviewer/cache/swe-r2); the canonical fixtures/advisor-bench/swe and
 * results/advisor-reviewer/cache/swe work the same way.
 * Pool JSON: {"tranches": {"T1": [...], "T2": [...]}} or {"T1": [...], "T2": [...]} or {"records": [...]} / [...] with a `tranche`
 * field; an element is an id or {id, order?}. A record's number N (its case dir c<N>-<id>) is its `order` when given, else its position
 * over T1 then T2 (1-based).
 *
 * Per record ONE Sol/high screener session (sol-session.ts): a fresh writable snapshot copy, the venv read-only (wrappers), and staged
 * copies of task.json, the reference fix (with its hunk listing) and the hidden tests; it writes ~/out/screening.json (E1, candidate
 * known defects with hunks and a probe each, the scope note) and ~/out/probes/. Then verify.ts (model-free) on fresh copies; E2, E3;
 * eligible = E1 and E2. Output: <outDir>/records/<id>/{session/, output/, verification/, screening.json}, and for an eligible record the
 * cb-ab case dir <outDir>/c<N>-<id>/ (case.json with protocol.ts diagnosisPrompt, rubric.json with the verified known defects only,
 * rubric.md, probes/, verification/), accepted by run.ts unit/driver and score.ts packets; <outDir>/screening-summary.json.
 */
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha } from "../mdsd-ab/run.js";
import { loadKey, loadPacketIndex, unitStatus, validatePacket } from "./analysis-r2.js";
import { HOME, REPO, display, readJson, targetMount, writeJson } from "./env.js";
import { MODEL_REF, THINKING, diagnosisPrompt } from "./protocol.js";
import { cleanScratch, runSession, stageFiles, type MountSpec } from "./sol-session.js";
import { hunkListing, parsePatch, verifyScreening, writeVerification, type RecordVerification } from "./verify.js";

export const DEFAULT_FIXTURES = join(REPO, "fixtures/advisor-bench/swe-r2");
export const DEFAULT_CACHE = join(REPO, "results/advisor-reviewer/cache/swe-r2");
export const SCREENER_GUARD_MS = 120 * 60_000;
const TASK_MOUNT = join(HOME, "task"), OUT_MOUNT = join(HOME, "out");

// ---- pool ------------------------------------------------------------------------------------------------------------------------

export interface PoolRecord { id: string; n: number; tranche: string }
/** The ordered records of one tranche (see the header for the accepted pool formats). */
export function readPool(pool: unknown, tranche: string): PoolRecord[] {
  const data = pool as any;
  const listOf = (name: string): unknown[] | undefined => {
    if (data?.tranches && Array.isArray(data.tranches[name])) return data.tranches[name];
    if (data && !Array.isArray(data) && Array.isArray(data[name])) return data[name];
    const records = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : undefined;
    return records ? records.filter((item: any) => item?.tranche === name) : undefined;
  };
  const t1 = listOf("T1") ?? [];
  const list = listOf(tranche);
  if (!list) throw new Error(`the pool has no tranche ${tranche} (accepted: {tranches:{T1,T2}}, {T1,T2}, {records:[{id,tranche}]} or [{id,tranche}])`);
  const offset = tranche === "T2" ? t1.length : 0;
  const out = list.map((item: any, index: number) => {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`pool ${tranche}[${index}]: no valid id`);
    const order = typeof item === "object" ? Number(item.order ?? item.n) : NaN;
    return { id, n: Number.isSafeInteger(order) && order > 0 ? order : offset + index + 1, tranche };
  });
  if (new Set(out.map(item => item.n)).size !== out.length) throw new Error(`pool ${tranche}: record numbers are not unique`);
  return out;
}

// ---- one record ------------------------------------------------------------------------------------------------------------------

export interface RecordPaths { id: string; taskJson: string; reference: string; hidden: string; src: string; venv: string }
export function recordPaths(id: string, fixtures = DEFAULT_FIXTURES, cache = DEFAULT_CACHE): RecordPaths {
  const paths = { id, taskJson: join(fixtures, id, "task.json"), reference: join(fixtures, id, "reference/fix.patch"), hidden: join(fixtures, id, "hidden/test.patch"), src: join(cache, id, "src"), venv: join(cache, id, "venv") };
  for (const [name, path] of Object.entries(paths)) if (name !== "id" && !existsSync(path)) throw new Error(`${id}: ${name} missing (${path})`);
  if (!existsSync(join(paths.venv, "bin/python"))) throw new Error(`${id}: no virtualenv at ${paths.venv}`);
  return paths;
}
/** The case's project directory name in the sandbox: the repository's name, lower case. */
export const projectDirOf = (repo: string) => (repo.split("/").pop() ?? "project").toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "project";

export function screenerPrompt(input: { task: any; cwd: string; listing: string; pythonPath: string }): string {
  const { task } = input;
  return [
    "You are a case screener: an evaluator session that prepares one case of a software-engineering study. You see the answers (the reference fix and the hidden tests) because you are an evaluator, not a subject; nothing you write is shown to the systems under study.",
    "",
    "## Files",
    `- Working directory \`${input.cwd}\`: a fresh copy of the project's pre-fix source snapshot (${task.repo} at ${task.baseCommit}; no git history). \`python\` and \`pytest\` on PATH run the code of the project in the current directory (the nearest pyproject.toml/setup.py/setup.cfg at or above it) with its dependencies preinstalled (read-only virtualenv; no network; pip is disabled). Keep this directory unmodified. To try the reference fix or the hidden tests, copy the project into \`$TMPDIR\` and work there, e.g. \`cp -a ${input.cwd} $TMPDIR/fixed && cd $TMPDIR/fixed && git apply ~/task/reference/fix.patch\`.`,
    "- `~/task/task.json`: the task record (`problemStatement` = the issue text, verbatim; `failToPass` / `passToPass` tests; `testCmd`).",
    "- `~/task/reference/fix.patch`: the reference fix. `~/task/reference/hunks.txt`: the same patch split into its hunks, with the index the verifier uses (listed below).",
    "- `~/task/hidden/test.patch`: the hidden tests (the fail-to-pass tests of the fix's author).",
    "- `~/out/` (writable): your outputs.",
    "",
    "## Hunks of the reference fix (index: file, header; [non-test source] = changes non-test Python source)",
    input.listing,
    "",
    "## What to produce",
    "1. E1: does the issue report incorrect behaviour of existing functionality, and is it understandable offline from its verbatim text? (`e1.met` true or false, `e1.reason`).",
    "2. Candidate known defects: the distinct defect mechanisms that the reference fix changes in non-test source. Work out what each part of the reference fix corrects (run the code before and after, with the hidden tests and with your own inputs). For each distinct mechanism:",
    "   - `id` K1, K2, ...; `title`: one line;",
    "   - `mechanism`: what goes wrong in the pre-fix code and why;",
    "   - `locations`: the pre-fix locations, [{\"file\", \"function\" (`Class.method` or `function`), \"lines\" (\"a-b\" in the pre-fix snapshot)}];",
    "   - `scenario`: a concrete triggering input or condition, with observed vs expected behaviour;",
    "   - `hunks`: the indexes (from the list above) of the reference-fix hunks that belong to this defect; a hunk belongs to at most one defect; leave out hunks that change no behaviour of this defect (documentation, changelog, pure refactoring, tests);",
    "   - `recoverability`: why a complete fix of the behaviour the issue reports requires this change, and how it can be inferred from the issue and the repository;",
    "   - `probe`: the file name of its probe script in `~/out/probes/`.",
    "   Do not merge distinct mechanisms into one candidate, and do not split one mechanism into several.",
    `3. Probes: one standalone Python script per candidate in \`~/out/probes/\` (helper modules next to them are allowed). The verifier runs \`python <probe>\` with the project root of a FRESH copy as the current directory and PYTHONPATH = that root${input.pythonPath && input.pythonPath !== "." ? `/${input.pythonPath}` : ""}; exit code 0 = correct behaviour, non-zero = the defect is present. It runs each probe three times, each on a fresh copy: on the pre-fix snapshot (must exit non-zero), with the full reference fix applied (must exit 0), and with the reference fix minus this candidate's hunks (must exit non-zero). Make each probe specific to its own mechanism, deterministic, offline and quick (each run is killed after 120 s: guard a call that may hang with a timeout in a subprocess or thread and exit 1 on timeout). A probe must not modify the project files, must not need the hidden tests (they are not applied), and uses only the standard library, the project and its installed dependencies. Print what it checks and what it observed. Check every probe yourself on such copies before you finish (\`git apply\` works on a copy without git history; build the minus-hunks patch from hunks.txt).`,
    "4. A scope note, as in a rubric: `inScope` (defects of the same behaviour or contract the issue concerns, including related variants a complete fix must handle), `outOfScope`, and `examples` (short classified examples).",
    "",
    "## Output",
    "Write `~/out/screening.json`:",
    `{"task": "${task.id}", "e1": {"met": true, "reason": "..."}, "candidates": [{"id": "K1", "title": "...", "mechanism": "...", "locations": [{"file": "...", "function": "...", "lines": "a-b"}], "scenario": "...", "hunks": [1], "recoverability": "...", "probe": "k1_name.py"}], "scope": {"inScope": "...", "outOfScope": "...", "examples": ["..."]}}`,
    "Then reply with a short summary.",
  ].join("\n");
}

export interface ScreenJob { id: string; n: number; tranche: string; outDir: string; scratch: string; fixtures?: string; cache?: string; guardMs?: number; log?: (line: string) => void }

/** One record: the screener session (unless its output already exists), then the verification and the record's decision. */
export async function screenRecord(job: ScreenJob): Promise<Record<string, unknown>> {
  const log = job.log ?? ((line: string) => console.log(line));
  const paths = recordPaths(job.id, job.fixtures, job.cache);
  const recordDir = join(resolve(job.outDir), "records", job.id);
  if (existsSync(join(recordDir, "screening.json"))) { log(`SKIP ${job.id}: screened (${display(recordDir)}/screening.json)`); return readJson(join(recordDir, "screening.json")); }
  if (existsSync(join(recordDir, "session"))) throw new Error(`${recordDir}/session exists without screening.json: an earlier screening of ${job.id} is unfinished; inspect it (verify re-runs only the model-free part)`);
  mkdirSync(recordDir, { recursive: true });
  const task = readJson(paths.taskJson);
  const reference = readFileSync(paths.reference, "utf8");
  const parsed = parsePatch(reference);
  const projectDir = projectDirOf(String(task.repo));
  const cwd = targetMount(projectDir);
  const stage = join(resolve(job.scratch), `stage-screen-${job.id.slice(0, 40)}-${randomBytes(3).toString("hex")}`);
  const hunksFile = join(resolve(job.scratch), `hunks-${randomBytes(4).toString("hex")}.txt`);
  writeFileSync(hunksFile, `${hunkListing(parsed)}\n`);
  const staged = stageFiles(stage, [
    { from: paths.taskJson, name: "task.json" }, { from: paths.reference, name: "reference/fix.patch" }, { from: hunksFile, name: "reference/hunks.txt" }, { from: paths.hidden, name: "hidden/test.patch" },
  ]);
  rmSync(hunksFile, { force: true });
  writeJson(join(recordDir, "inputs.json"), { task: job.id, n: job.n, tranche: job.tranche, model: MODEL_REF, thinking: THINKING, projectDir, staged, source: display(paths.src), venv: display(paths.venv), hunks: parsed.hunks.map(item => ({ index: item.index, file: item.file, header: item.header, nonTestSource: item.nonTestSource })) });
  const mounts: MountSpec[] = [
    { kind: "copy", host: paths.src, sandbox: cwd, purpose: "the pre-fix snapshot (fresh writable copy)", writable: true },
    { kind: "ro", host: stage, sandbox: TASK_MOUNT, purpose: "task.json, the reference fix (+ hunk listing) and the hidden tests (staged copies)" },
    { kind: "empty", sandbox: OUT_MOUNT, purpose: "the screener's outputs (screening.json, probes/)", collect: "out" },
  ];
  const forbidden = [join(REPO, "results/cb-ab"), resolve(job.outDir), join(REPO, "fixtures")];
  log(`START ${job.id} (N ${job.n}, ${job.tranche})`);
  let session;
  try {
    session = await runSession({
      outDir: join(recordDir, "session"), scratch: job.scratch, label: `screen-${job.id}`, cwd, mounts, forbidden, guardMs: job.guardMs ?? SCREENER_GUARD_MS,
      prompt: screenerPrompt({ task, cwd, listing: hunkListing(parsed, false), pythonPath: String(task.pythonPath || ".") }),
      venv: { host: paths.venv, projectDir, pythonPath: String(task.pythonPath || "."), anchorsFrom: paths.src, fallbackRoot: cwd },
    });
    cleanScratch(session);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  const out = session.final.outputs.out;
  if (out && existsSync(out)) cpSync(out, join(recordDir, "output"), { recursive: true });
  log(`END ${job.id} session: ${session.requests} requests, $${session.costUSD}, route ${session.routeOk ? "ok" : "VIOLATED"}`);
  return finishRecord(job, recordDir, paths, task, reference, projectDir, session && { dir: display(session.dir), routeOk: session.routeOk, finalRouteOk: session.final.route?.ok === true, requests: session.requests, costUSD: session.costUSD, attempts: session.attempts.length, infra: session.final.infra, exit: session.final.exit });
}

/** Verify a record's screener output (model-free), decide E1/E2/E3/eligible, write screening.json and, if eligible, the case dir. */
export async function finishRecord(job: Pick<ScreenJob, "id" | "n" | "tranche" | "outDir" | "scratch" | "log">, recordDir: string, paths: RecordPaths, task: any, reference: string, projectDir: string, session: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const log = job.log ?? ((line: string) => console.log(line));
  const outputFile = join(recordDir, "output/screening.json");
  let output: any, outputError: string | undefined;
  if (!existsSync(outputFile)) outputError = "no ~/out/screening.json";
  else { try { output = JSON.parse(readFileSync(outputFile, "utf8")); } catch (error) { outputError = `screening.json does not parse: ${String(error).slice(0, 200)}`; } }
  const work = join(resolve(job.scratch), `verify-${job.id.slice(0, 40)}-${randomBytes(3).toString("hex")}`);
  const verificationDir = join(recordDir, "verification");
  rmSync(verificationDir, { recursive: true, force: true });
  let verification: RecordVerification;
  try {
    verification = await verifyScreening(output, reference, join(recordDir, "output/probes"), { source: paths.src, venv: paths.venv, projectDir, pythonPath: String(task.pythonPath || "."), work }, String(task.problemStatement ?? ""), join(verificationDir, "logs"), job.id);
  } finally { rmSync(work, { recursive: true, force: true }); }
  writeVerification(verificationDir, verification);
  const reasons = [...(outputError ? [outputError] : []), ...verification.reasons];
  const routeOk = session ? session.routeOk === true : readJsonSafe(join(recordDir, "session/session.json"))?.routeOk === true;
  if (!routeOk) reasons.push("the screener session was not route-compliant (model rule): its output cannot make a case");
  const eligible = verification.eligible && !outputError && routeOk;
  const caseName = `c${job.n}-${job.id}`;
  const caseDir = join(resolve(job.outDir), caseName);
  rmSync(caseDir, { recursive: true, force: true });
  if (eligible) writeCaseDir(caseDir, job, paths, task, projectDir, output, verification, recordDir);
  const record = {
    task: job.id, n: job.n, tranche: job.tranche, decidedAt: new Date().toISOString(),
    session: session ?? readJsonSafe(join(recordDir, "session/session.json")) ?? null,
    output: { present: !outputError, ...(outputError ? { error: outputError } : {}), file: existsSync(outputFile) ? "output/screening.json" : null },
    e1: verification.e1,
    candidates: verification.candidates.map(item => ({ id: item.id, title: (output?.candidates ?? []).find((c: any) => c?.id === item.id)?.title, verified: item.verified, reasons: item.reasons, hunks: item.hunks, nonTestHunks: item.nonTestHunks, probe: item.probe, e3: item.e3, runs: Object.fromEntries(Object.entries(item.runs).map(([condition, run]) => [condition, { exit: run!.exit, timedOut: run!.timedOut, applyError: run!.applyError ? true : undefined, log: run!.log }])) })),
    verified: verification.verified, e2: verification.e2,
    e3: Object.fromEntries(verification.candidates.filter(item => item.verified).map(item => [item.id, item.e3])),
    eligible, reasons: eligible ? [] : reasons, hunkOverlaps: verification.hunkOverlaps,
    caseDir: eligible ? caseName : null,
  };
  writeJson(join(recordDir, "screening.json"), record);
  log(`DECIDED ${job.id}: e1 ${verification.e1?.met ?? "?"}, verified ${verification.verified.join(",") || "none"} of ${verification.candidates.length}, eligible ${eligible}${eligible ? ` -> ${caseName}` : `: ${reasons.join("; ")}`}`);
  return record;
}
const readJsonSafe = (file: string): any => { try { return readJson(file); } catch { return undefined; } };

/** The rubric's scoring guide of one verified defect, from the screener's fields (fixed templates of PROTOCOL.md's M/L/S guide). */
export function scoringGuide(candidate: any): { M: string; L: string; S: string } {
  const locations: any[] = Array.isArray(candidate.locations) ? candidate.locations : [];
  return {
    M: `1 when the report states this mechanism: ${candidate.mechanism} A report that gives only the symptom, or a different mechanism, earns 0.`,
    L: `1 for the right file and the function (${locations.map(item => `${item.file} ${item.function ?? ""}`.trim()).join("; ")}), or a cited line range within ±10 lines of ${locations.map(item => `${item.file}:${item.lines ?? "?"}`).join(", ")} (pre-fix snapshot).`,
    S: `1 for a concrete triggering input or condition consistent with the mechanism, with observed vs expected behaviour (for example: ${candidate.scenario})`,
  };
}

export function renderRubric(rubric: any): string {
  const lines = [
    `# Rubric ${rubric.case}: ${rubric.task} (evaluator-only)`, "", `> ${rubric.evaluatorOnly}`, "",
    "Generated from `rubric.json` by `experiments/cb-ab/screen.ts`; the JSON is authoritative.", "",
    `- Repository: ${rubric.repo} at \`${rubric.baseCommit}\``, `- Snapshot: ${rubric.snapshot}`, `- Environment: ${rubric.environment}`, `- Source: ${rubric.source}`, "",
    "## Known defects (verified)", "",
  ];
  for (const item of rubric.knownDefects) {
    lines.push(`### ${item.id}: ${item.title ?? ""}`.trimEnd(), "", `- Named in issue (E3 names): ${item.namedInIssue ? `yes (${item.e3.named.join(", ")})` : "no"}`, "- Locations (pre-fix snapshot):", ...item.locations.map((loc: any) => `  - \`${loc.file}\` ${loc.function ?? ""} ${loc.lines ? `lines ${loc.lines}` : ""}`.trimEnd()),
      `- Mechanism: ${item.mechanism}`, `- Scenario: ${item.scenario}`, `- Recoverability: ${item.recoverability}`, `- Reference-fix hunks: ${item.hunks.join(", ")}`,
      `- Probe: \`${item.probe.path}\` (pre-fix exit ${item.probe.outputs.pre.exit}, full fix exit ${item.probe.outputs.fix.exit}, fix minus these hunks exit ${item.probe.outputs.minus.exit})`,
      "- Scoring:", `  - M: ${item.scoring.M}`, `  - L: ${item.scoring.L}`, `  - S: ${item.scoring.S}`, "");
  }
  const scope = rubric.scope ?? {};
  lines.push("## Scope of additional findings", "");
  if (typeof scope === "string") lines.push(scope, "");
  else {
    if (scope.inScope) lines.push(`- In scope: ${scope.inScope}`);
    if (scope.outOfScope) lines.push(`- Out of scope: ${scope.outOfScope}`);
    for (const example of Array.isArray(scope.examples) ? scope.examples : []) lines.push(`- Example: ${typeof example === "string" ? example : JSON.stringify(example)}`);
    lines.push("");
  }
  if (rubric.verification?.unverified?.length) lines.push("## Candidates not verified (not known defects)", "", ...rubric.verification.unverified.map((item: any) => `- ${item.id}: ${item.reasons.join("; ")}`), "");
  return lines.join("\n");
}

function writeCaseDir(caseDir: string, job: Pick<ScreenJob, "id" | "n">, paths: RecordPaths, task: any, projectDir: string, output: any, verification: RecordVerification, recordDir: string): void {
  mkdirSync(caseDir, { recursive: true });
  const prompt = diagnosisPrompt({ repo: String(task.repo), baseCommit: String(task.baseCommit), problemStatement: String(task.problemStatement) });
  writeJson(join(caseDir, "case.json"), { id: `c${job.n}`, order: job.n, task: job.id, repo: task.repo, baseCommit: task.baseCommit, projectDir, pythonPath: String(task.pythonPath || "."), prompt, promptSha256: sha(prompt), source: display(paths.src), venv: display(paths.venv) });
  const verified = verification.candidates.filter(item => item.verified);
  const knownDefects = verified.map(result => {
    const candidate = output.candidates.find((item: any) => item?.id === result.id);
    return {
      id: result.id, ...(typeof candidate.title === "string" ? { title: candidate.title } : {}), mechanism: candidate.mechanism, locations: candidate.locations, scenario: candidate.scenario, recoverability: candidate.recoverability,
      hunks: result.hunks, namedInIssue: !result.e3!.met, e3: result.e3,
      probe: { path: `probes/${result.probe}`, sha256: result.probeSha256, cmd: "cd <fresh copy of the pre-fix snapshot> && PYTHONPATH=<copy>[/pythonPath] <venv>/bin/python <probe> (exit 0 = correct behaviour)", outputs: Object.fromEntries(Object.entries(result.runs).map(([condition, run]) => [condition, { exit: run!.exit, timedOut: run!.timedOut, log: `verification/logs/${basename(run!.log)}` }])) },
      scoring: scoringGuide(candidate),
    };
  });
  const rubric = {
    case: `c${job.n}`, task: job.id, repo: task.repo, baseCommit: task.baseCommit,
    evaluatorOnly: "Never mount or show this file, the probes or the reference fix to a measured run.",
    snapshot: `${display(paths.src)} (pre-fix; every line number refers to it and is identical in a run's fresh copy)`,
    environment: `Task venv ${task.pythonVersion ?? ""} (${display(paths.venv)}, read-only)`.replace("  ", " "),
    source: "screened by one Sol/high screener session (PROTOCOL-R2 'Case screening'); known defects = the candidates verified by experiments/cb-ab/verify.ts",
    knownDefects, scope: output.scope ?? null,
    verification: { verifiedAt: verification.verifiedAt, referenceSha256: verification.referenceSha256, e1: verification.e1, unverified: verification.candidates.filter(item => !item.verified).map(item => ({ id: item.id, reasons: item.reasons })), hunkOverlaps: verification.hunkOverlaps },
    reproduce: "node --import tsx experiments/cb-ab/screen.ts verify <screening outDir> (re-runs every probe on fresh copies)",
  };
  writeJson(join(caseDir, "rubric.json"), rubric);
  writeFileSync(join(caseDir, "rubric.md"), `${renderRubric(rubric)}\n`);
  cpSync(join(recordDir, "output/probes"), join(caseDir, "probes"), { recursive: true });
  cpSync(join(recordDir, "verification"), join(caseDir, "verification"), { recursive: true });
}

/** Re-verify every screened record of an outDir (model-free; the sessions are not re-run). */
export async function verifyAll(outDir: string, options: { fixtures?: string; cache?: string; scratch: string; log?: (line: string) => void }): Promise<Record<string, unknown>[]> {
  const root = join(resolve(outDir), "records");
  const out: Record<string, unknown>[] = [];
  for (const id of existsSync(root) ? readdirSync(root).sort() : []) {
    const inputs = readJsonSafe(join(root, id, "inputs.json"));
    if (!inputs) continue;
    const paths = recordPaths(id, options.fixtures, options.cache);
    out.push(await finishRecord({ id, n: Number(inputs.n), tranche: String(inputs.tranche), outDir, scratch: options.scratch, ...(options.log ? { log: options.log } : {}) }, join(root, id), paths, readJson(paths.taskJson), readFileSync(paths.reference, "utf8"), String(inputs.projectDir), undefined));
  }
  writeSummary(outDir);
  return out;
}

export function writeSummary(outDir: string): void {
  const root = join(resolve(outDir), "records");
  const records = (existsSync(root) ? readdirSync(root).sort() : []).map(id => readJsonSafe(join(root, id, "screening.json"))).filter(Boolean).sort((a: any, b: any) => a.n - b.n);
  writeJson(join(resolve(outDir), "screening-summary.json"), {
    generatedAt: new Date().toISOString(), screened: records.length, eligible: records.filter((item: any) => item.eligible).map((item: any) => item.caseDir),
    records: records.map((item: any) => ({ task: item.task, n: item.n, tranche: item.tranche, e1: item.e1?.met ?? null, verified: item.verified, e2: item.e2, eligible: item.eligible, caseDir: item.caseDir, reasons: item.reasons, requests: item.session?.requests, costUSD: item.session?.costUSD, routeOk: item.session?.routeOk })),
    costUSD: Math.round(records.reduce((total: number, item: any) => total + Number(item.session?.costUSD ?? 0), 0) * 1e6) / 1e6,
  });
}

// ---- selection -------------------------------------------------------------------------------------------------------------------

export interface SelectionCandidate {
  caseDir: string; task: string; n: number; caseId: string; knownDefects: string[];
  reports: { unit: string; label?: string; runStatus: string; runReasons: string[]; packetStatus: string; inSet: boolean; found?: Record<string, boolean>; why?: string }[];
  missed: { unit: string; k: string }[]; qualifies: boolean; selectedAs?: string;
}

// ---- descriptive comparison with a round-1 rubric (preflight) ----------------------------------------------------------------------

/**
 * Model-free correspondence of a screened record's candidates with a round-1 case's known defects: each round-1 K's reference-fix hunks
 * are the reference hunks missing from its probes/fix-minus-<K>-*.patch (exact hunk bodies); a candidate corresponds by hunk set
 * (identical / overlapping) and by location (same file and a shared function or class name).
 */
export function round1Correspondence(record: any, output: any, round1CaseDir: string, reference: string): Record<string, unknown> {
  const parsed = parsePatch(reference);
  const body = (lines: readonly string[]) => lines.slice(1).join("");
  const rubric = readJson(join(round1CaseDir, "rubric.json"));
  const probes = join(round1CaseDir, "probes");
  const round1 = (rubric.knownDefects as any[]).map(item => {
    const variant = readdirSync(probes).find(name => name.startsWith(`fix-minus-${item.id}-`) && name.endsWith(".patch"));
    const kept = variant ? new Set(parsePatch(readFileSync(join(probes, variant), "utf8")).hunks.map(hunk => `${hunk.file}\0${body(hunk.lines)}`)) : undefined;
    const hunks = kept ? parsed.hunks.filter(hunk => !kept.has(`${hunk.file}\0${body(hunk.lines)}`)).map(hunk => hunk.index) : null;
    return { id: String(item.id), title: item.title, hunks, variant: variant ?? null, locations: (item.locations as any[]).map(loc => ({ file: String(loc.file), names: String(loc.function ?? "").trim().split(/[\s(]/)[0]!.split(".").filter(Boolean) })) };
  });
  const names = (locations: any[]) => (locations ?? []).map(loc => ({ file: String(loc?.file ?? ""), names: String(loc?.function ?? "").trim().split(/[\s(]/)[0]!.split(".").filter(Boolean) }));
  const candidates = (record.candidates as any[]).map(candidate => {
    const own = names((output?.candidates ?? []).find((item: any) => item?.id === candidate.id)?.locations ?? []);
    const matches = round1.map(k => {
      const shared = k.hunks ? candidate.hunks.filter((index: number) => k.hunks!.includes(index)) : [];
      const sameHunks = !!k.hunks && shared.length === k.hunks.length && shared.length === candidate.hunks.length;
      const location = own.some(loc => k.locations.some(other => other.file === loc.file && loc.names.some((name: string) => other.names.includes(name))));
      return { round1: k.id, sameHunks, sharedHunks: shared, sameFileAndName: location };
    }).filter(item => item.sameHunks || item.sharedHunks.length || item.sameFileAndName);
    return { id: candidate.id, verified: candidate.verified, hunks: candidate.hunks, locations: own, matches };
  });
  return { round1Case: display(round1CaseDir), round1, candidates, note: "descriptive and model-free: hunk sets (round-1 hunks = reference hunks absent from its fix-minus patch) and file/function-name overlap; no judgement of mechanism equivalence" };
}


/**
 * Qualifying and selection (PROTOCOL-R2; R2-A1 item 4): a case qualifies when at least one verified known defect is NOT FOUND
 * (M=1 ∧ L=1 fails) in at least one calibration report of the analysis set (completed ∧ compliant ∧ scored); missing, non-compliant
 * and unscored reports are never evidence of a miss. The first three qualifying cases in pool order become c1, c2, c3.
 */
export function selectCases(outDir: string, calibrationStudy: string, calibrationScoresDir: string, selectedDir: string): Record<string, unknown> {
  if (existsSync(resolve(selectedDir)) && readdirSync(resolve(selectedDir)).length) throw new Error(`${selectedDir} exists and is not empty: the selection is written once`);
  const dirs = readdirSync(resolve(outDir)).filter(name => /^c\d+-/.test(name) && existsSync(join(resolve(outDir), name, "case.json")))
    .map(name => ({ name, spec: readJson(join(resolve(outDir), name, "case.json")) })).sort((a, b) => a.spec.order - b.spec.order);
  const key = existsSync(join(resolve(calibrationStudy), "scoring/key.json")) ? loadKey(calibrationStudy) : {};
  const index = existsSync(join(resolve(calibrationStudy), "scoring/packets.json")) ? loadPacketIndex(calibrationStudy) : {};
  const candidates: SelectionCandidate[] = [];
  for (const { name, spec } of dirs) {
    const caseId = String(spec.id);
    const kItems: string[] = readJson(join(resolve(outDir), name, "rubric.json")).knownDefects.map((item: any) => String(item.id));
    const scoresFile = join(resolve(calibrationScoresDir), caseId, "scores.json");
    const scores = readJsonSafe(scoresFile);
    const validation = readJsonSafe(join(resolve(calibrationScoresDir), caseId, "validation.json"));
    const scorerCompliant = validation ? validation.compliant !== false : !!scores;
    const byUnit = new Map(Object.entries(key).map(([label, entry]) => [entry.unit, label]));
    const reports: SelectionCandidate["reports"] = [];
    for (const repeat of [1, 2]) {
      const unit = `${caseId}/A/r${repeat}`;
      const status = unitStatus(calibrationStudy, unit);
      const label = byUnit.get(unit);
      const inIndex = label ? (index[caseId] ?? []).some(item => item.label === label) : false;
      let packetStatus = status.status === "missing" ? "not scored (run missing)" : !label || !inIndex ? "no packet" : "unscored";
      let found: Record<string, boolean> | undefined;
      if (status.status !== "missing" && label && inIndex && scores) {
        const check = validatePacket(label, scores.packets?.[label], kItems);
        if (check.status === "scored" && scorerCompliant) { packetStatus = "scored"; found = Object.fromEntries(kItems.map(id => { const item = scores.packets[label].k.find((x: any) => x.k === id); return [id, item.m === 1 && item.l === 1]; })); }
        else packetStatus = scorerCompliant ? "unscored" : "unscored (scorer session not route-compliant)";
      }
      const inSet = status.status === "completed" && packetStatus === "scored";
      reports.push({ unit, ...(label ? { label } : {}), runStatus: status.status, runReasons: status.reasons, packetStatus, inSet, ...(found ? { found } : {}), ...(inSet ? {} : { why: status.status !== "completed" ? `run ${status.status}: ${status.reasons.join("; ")}` : `packet ${packetStatus}` }) });
    }
    const missed = reports.filter(item => item.inSet).flatMap(item => kItems.filter(id => !item.found![id]).map(id => ({ unit: item.unit, k: id })));
    candidates.push({ caseDir: name, task: String(spec.task), n: Number(spec.order), caseId, knownDefects: kItems, reports, missed, qualifies: missed.length > 0 });
  }
  const qualifying = candidates.filter(item => item.qualifies);
  const selected = qualifying.slice(0, 3);
  mkdirSync(resolve(selectedDir), { recursive: true });
  selected.forEach((item, index) => {
    const id = `c${index + 1}`;
    const target = join(resolve(selectedDir), `${id}-${item.task}`);
    cpSync(join(resolve(outDir), item.caseDir), target, { recursive: true });
    const spec = readJson(join(target, "case.json"));
    writeJson(join(target, "case.json"), { ...spec, id, order: index + 1 });
    item.selectedAs = `${id}-${item.task}`;
  });
  const fewer = selected.length === 3 ? null : selected.length === 2 ? "2 cases: both are validated, and the stop gate uses both (PROTOCOL-R2)"
    : selected.length === 1 ? "1 case: validated descriptively; the verdict cannot be supported (PROTOCOL-R2)" : "0 cases: no validation; stage-1 efficacy is UNRESOLVED (PROTOCOL-R2)";
  const selection = {
    generatedAt: new Date().toISOString(), outDir: display(resolve(outDir)), calibrationStudy: display(resolve(calibrationStudy)), calibrationScores: display(resolve(calibrationScoresDir)),
    rule: "qualifies = at least one verified known defect NOT FOUND (M=1 and L=1 fails) in at least one calibration report of the analysis set (completed, route-compliant, scored); missing/non-compliant/unscored reports are no evidence; the first three qualifying in pool order -> c1, c2, c3",
    candidates, selected: selected.map(item => ({ as: item.selectedAs, from: item.caseDir, task: item.task, n: item.n })),
    ...(fewer ? { fewerThanThree: `${fewer}. If this selection covers T1 only, PROTOCOL-R2's expansion screens, calibrates and selects T2 once (select over T1 then T2 in pool order).` } : {}),
  };
  writeJson(join(resolve(selectedDir), "selection.json"), selection);
  return selection;
}

// ---- CLI -------------------------------------------------------------------------------------------------------------------------

const USAGE = "usage: screen.ts run <poolJson> <T1|T2> <outDir> --scratch <dir> [--concurrency N] [--fixtures <root>] [--cache <root>] [--guard-min M] | one <taskId> <outDir> --scratch <dir> [--n N] [--fixtures <root>] [--cache <root>] | verify <outDir> --scratch <dir> [--fixtures <root>] [--cache <root>] | select <outDir> <calibrationStudy> <calibrationScoresDir> <selectedDir> | compare-round1 <recordDir> <round1CaseDir> <referencePatch> <outFile>";
const option = (argv: readonly string[], name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };

export async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;
  const fixtures = option(argv, "--fixtures") ? resolve(option(argv, "--fixtures")!) : undefined, cache = option(argv, "--cache") ? resolve(option(argv, "--cache")!) : undefined;
  const scratch = option(argv, "--scratch") ?? process.env.CB_AB_SOL_SCRATCH;
  const guardMin = option(argv, "--guard-min");
  const logTo = (outDir: string) => (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); mkdirSync(resolve(outDir), { recursive: true }); writeFileSync(join(resolve(outDir), "screen.log"), `${text}\n`, { flag: "a" }); };
  if (command === "compare-round1") {
    const [, recordDir, round1CaseDir, referencePatch, outFile] = argv;
    if (!recordDir || !round1CaseDir || !referencePatch || !outFile) throw new Error(USAGE);
    const result = round1Correspondence(readJson(join(recordDir, "screening.json")), readJsonSafe(join(recordDir, "output/screening.json")), round1CaseDir, readFileSync(referencePatch, "utf8"));
    writeJson(outFile, result);
    console.log(JSON.stringify(result, null, 1));
    return 0;
  }
  if (command === "select") {
    const [, outDir, study, scores, selectedDir] = argv;
    if (!outDir || !study || !scores || !selectedDir) throw new Error(USAGE);
    const selection = selectCases(outDir, study, scores, selectedDir) as any;
    console.log(JSON.stringify({ selected: selection.selected, fewerThanThree: selection.fewerThanThree ?? null }));
    return 0;
  }
  if (!scratch) throw new Error("--scratch <dir> (or CB_AB_SOL_SCRATCH) is required: sandbox copies never go to /tmp itself or the repository");
  if (command === "verify") {
    const [, outDir] = argv;
    if (!outDir) throw new Error(USAGE);
    await verifyAll(outDir, { ...(fixtures ? { fixtures } : {}), ...(cache ? { cache } : {}), scratch, log: logTo(outDir) });
    return 0;
  }
  if (command === "one") {
    const [, id, outDir] = argv;
    if (!id || !outDir) throw new Error(USAGE);
    await screenRecord({ id, n: Number(option(argv, "--n") ?? "1"), tranche: "single", outDir, scratch, ...(fixtures ? { fixtures } : {}), ...(cache ? { cache } : {}), ...(guardMin ? { guardMs: Number(guardMin) * 60_000 } : {}), log: logTo(outDir) });
    writeSummary(outDir);
    return 0;
  }
  if (command === "run") {
    const [, poolFile, tranche, outDir] = argv;
    if (!poolFile || !tranche || !outDir || !["T1", "T2"].includes(tranche)) throw new Error(USAGE);
    const records = readPool(readJson(poolFile), tranche);
    const concurrency = Number(option(argv, "--concurrency") ?? "1");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
    mkdirSync(resolve(outDir), { recursive: true });
    const log = logTo(outDir);
    writeJson(join(resolve(outDir), `pool-${tranche}.json`), { pool: display(resolve(poolFile)), poolSha256: sha(readFileSync(poolFile)), tranche, records });
    log(`SCREEN ${tranche}: ${records.length} records; concurrency ${concurrency}`);
    const queue = [...records];
    let failed = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        try { await screenRecord({ id: record.id, n: record.n, tranche, outDir, scratch, ...(fixtures ? { fixtures } : {}), ...(cache ? { cache } : {}), ...(guardMin ? { guardMs: Number(guardMin) * 60_000 } : {}), log }); }
        catch (error) { failed++; log(`FAILED ${record.id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }));
    writeSummary(outDir);
    return failed ? 1 : 0;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
