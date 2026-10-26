/**
 * Blind Sol/high scorer of the cb-ab study, round 2 (results/cb-ab/PROTOCOL-R2.md Part R "Scorers", "Scorer environment", "Scoring";
 * Amendment R2-A1 items 1, 3 and 7). One evaluator session (sol-session.ts) per (case, scorer S1|S2):
 *
 *   node --import tsx experiments/cb-ab/sol-score.ts score <study> <casesDir> <outRoot> --scorers S1[,S2] --cases c1[,c2,...]
 *        --scratch <dir> [--concurrency N] [--guard-min M]
 *
 * Mounted (fresh per attempt or staged copies; never this repository):
 *  - ~/Code/<projectDir>: a fresh writable copy of the case's pre-fix snapshot (cwd), its venv read-only with python/pytest wrappers;
 *  - ~/eval/rubric: the case's rubric.json and rubric.md; ~/eval/probes: the case's probes/ WITHOUT reference-fix or hidden-test
 *    material (patches, hunk specs, diffs, hidden-test logs, run_probes.sh; every exclusion is listed in inputs.json);
 *  - ~/eval/packets: the case's blinded packets of <study>/scoring/packets.json (sha256-checked) whose run has a final report, named
 *    NN-<label>.md in a seeded random order (seed `cb-ab-r2-2026-10-24/part-r/<scorer>/<case>`: different for S1 and S2);
 *  - ~/eval/out: writable, collected (the scorer writes scores.json there).
 * Never mounted (mountProblems refuses it): key.json and the rest of <study>/scoring (round-1 scores and analysis), the run evidence
 * (transcripts), <outRoot> (other scorers), the cases directory (reference material of every case), the fixtures (reference fixes,
 * hidden tests), the repository.
 * Output <outRoot>/<scorer>/<case>/: scores.json in the round-1 schema ({case, scorer, packets}) with scorer = {model, thinking,
 * scorerId, seed}; validation.json (packet status, session compliance, runs); inputs.json; run-<n>/ (session evidence). A packet
 * lacking a complete known-defect entry is `incomplete`: the session is re-run ONCE (fresh); still incomplete -> `unscored` (never zero).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha } from "../mdsd-ab/run.js";
import { rng, shuffle } from "../ultra-ab/protocol.js";
import { loadCases, loadKey, loadPacketIndex, unitStatus, validateScores, type ScoresValidation } from "./analysis-r2.js";
import { HOME, REPO, display, loadCase, readJson, targetMount, writeJson } from "./env.js";
import { MODEL_REF, THINKING } from "./protocol.js";
import { cleanScratch, runSession, stageFiles, type MountSpec, type SessionResult, type SessionSpec } from "./sol-session.js";

export const SCORERS = ["S1", "S2"] as const;
export type ScorerId = typeof SCORERS[number];
export const SCORE_SEED = "cb-ab-r2-2026-10-24/part-r";
export const seedFor = (scorer: string, caseId: string) => `${SCORE_SEED}/${scorer}/${caseId}`;
/** Scorer sessions read up to six long reports and reproduce claims: a longer guard than the runner's default. */
export const SCORER_GUARD_MS = 120 * 60_000;
/** Re-runs of an incomplete scorer session (R2-A1 item 1). */
export const COMPLETENESS_RERUNS = 1;
export const EVAL = join(HOME, "eval");

/** The packets in the scorer's order: sorted labels shuffled by the seed. */
export const packetOrder = (labels: readonly string[], seed: string): string[] => shuffle([...labels].sort(), rng(seed));

// ---- inputs ----------------------------------------------------------------------------------------------------------------------

export interface ProbeSelection { include: { from: string; name: string }[]; exclude: { name: string; reason: string }[] }
const DIFF = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
/** The probes a scorer may see: everything but reference-fix and hidden-test material (by name, and any file holding a diff hunk). */
export function probeSelection(probesDir: string): ProbeSelection {
  const out: ProbeSelection = { include: [], exclude: [] };
  if (!existsSync(probesDir)) return out;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), name = relative(probesDir, path);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) { out.exclude.push({ name, reason: "not a regular file" }); continue; }
      const reason = /\.patch$|\.diff$/i.test(entry.name) ? "reference-fix material (a patch)"
        : /\.spec\.json$/i.test(entry.name) ? "reference-fix material (a hunk specification)"
          : /hidden/i.test(entry.name) ? "hidden-test material (a hidden-test run log)"
            : /^e1_testcmd/i.test(entry.name) ? "hidden-test material (the task's test command with the hidden tests)"
              : entry.name === "run_probes.sh" ? "evaluator reproduction script: needs the fixture (reference fix, hidden tests) and the repository"
                : statSync(path).size < 8 * 1024 * 1024 && DIFF.test(readFileSync(path, "utf8")) ? "reference-fix material (contains a diff)" : undefined;
      if (reason) out.exclude.push({ name, reason }); else out.include.push({ from: path, name });
    }
  };
  walk(probesDir);
  return out;
}

export interface PacketInfo { label: string; packetSha256: string; file: string; unit?: string; include: boolean; reason?: string }
/**
 * The case's packets (packets.json index, files sha256-checked): a packet is shown only when its run has a final report (a missing run,
 * e.g. the provider-stopped c2/A/r1, is never scored). The key is read here, by the harness, and never mounted.
 */
export function casePackets(study: string, caseId: string): PacketInfo[] {
  const index = loadPacketIndex(study)[caseId];
  if (!index?.length) throw new Error(`${study}/scoring/packets.json has no packets for ${caseId}`);
  const key = loadKey(study);
  return index.map(item => {
    const file = join(resolve(study), "scoring", caseId, "packets", `${item.label}.md`);
    if (!existsSync(file)) throw new Error(`packet ${file} is missing`);
    if (sha(readFileSync(file)) !== item.packetSha256) throw new Error(`packet ${file} does not match its packetSha256 in packets.json`);
    const unit = key[item.label]?.unit;
    if (!unit) return { label: item.label, packetSha256: item.packetSha256, file, include: false, reason: "label not in key.json" };
    const status = unitStatus(study, unit);
    return status.status === "missing" ? { label: item.label, packetSha256: item.packetSha256, file, unit, include: false, reason: `run missing: ${status.reasons.join("; ")}` } : { label: item.label, packetSha256: item.packetSha256, file, unit, include: true };
  });
}

/** Host paths no scorer mount may expose. */
export function scorerForbidden(study: string, casesDir: string, outRoot: string): string[] {
  const s = resolve(study);
  return [join(s, "scoring"), join(s, "scoring/key.json"), join(s, "runs"), join(s, "driver"), join(s, "logs"), resolve(outRoot), resolve(casesDir), join(REPO, "fixtures")];
}

// ---- the prompt ------------------------------------------------------------------------------------------------------------------

export function scorerPrompt(input: { caseId: string; cwd: string; packets: { name: string; label: string }[]; known: { id: string; title?: string }[] }): string {
  const ids = input.known.map(item => item.id);
  return [
    "You are a blind scorer of defect reports: an evaluator session of a software-engineering study. Several independent runs investigated the same bug report against the Python project in your working directory, and each wrote one defect report. You score every report against a fixed rubric. You do not know, and must not try to infer, which system or configuration produced a report; score each report on its own text.",
    "",
    "## Your files",
    `- Working directory \`${input.cwd}\`: a fresh, disposable copy of the project's pre-fix source snapshot. Every line number in the rubric refers to this snapshot. \`python\` and \`pytest\` on PATH run this project's code with its dependencies preinstalled (read-only virtualenv; no network; pip is disabled). Do not modify this directory: reproductions must run on the unmodified pre-fix code. Put your own scripts, copies and logs under \`~/eval/out/checks/\` (writable) or \`$TMPDIR\`.`,
    "- `~/eval/rubric/rubric.json` (authoritative) and `~/eval/rubric/rubric.md` (the same, rendered): the contract of the bug report, the known defects (`knownDefects`: id, title, mechanism, pre-fix locations, triggering scenario, probe, and a per-defect scoring guide `scoring` with the criteria for M, L and S), `nonItems` (changes of the reference fix that are not defects) and the scope note for additional findings (`scope.inScope`, `scope.outOfScope`, `scope.examples`). You are an evaluator: the rubric and the probes are meant for you. Paths in the rubric that point to `results/...`, `fixtures/...` or `/home/.../orche` refer to the evaluators' machine and do not exist here; reference-fix and hidden-test material is not available.",
    `- \`~/eval/probes/\`: the evaluators' probe scripts for the known defects, with their recorded outputs (\`*-pre.log\` = on the pre-fix snapshot). Run a probe from the project root: \`cd ${input.cwd} && python ~/eval/probes/<probe>.py\` (exit 0 = correct behaviour, non-zero = the defect is present).`,
    `- \`~/eval/packets/\`: the ${input.packets.length} reports to score, in this order:`,
    ...input.packets.map((item, index) => `  ${index + 1}. \`${item.name}\` (report ${item.label})`),
    "",
    "## Known defects of this case",
    ...input.known.map(item => `- ${item.id}${item.title ? `: ${item.title}` : ""}`),
    "",
    "## Procedure, for every report in the order above",
    "1. Known defects. For every known defect in `rubric.json` `knownDefects`, award three points, each 0 or 1, by that defect's scoring guide (`scoring.M`, `scoring.L`, `scoring.S`) and these general rules:",
    "   - M (mechanism): 1 when the report states the defect's mechanism correctly.",
    "   - L (location): 1 when the report names the right file and the function, or a line range within ±10 lines of the rubric's cited range.",
    "   - S (scenario): 1 when the report gives a concrete triggering input or condition consistent with the mechanism.",
    "   Judge only what the report itself says, wherever in the report it says it. In `quote`, quote the report's own words for each point, as `M: \"...\" | L: \"...\" | S: \"...\"`; for a point of 0 quote the closest statement or write `(none)`. Every known defect gets exactly one entry in every report, also when all three points are 0.",
    "2. Additional findings. List every other distinct defect the report claims. A restatement, symptom or variant of a known defect is not a separate finding (mention it in `notes`); restatements of one claim are merged into one finding; statements of what the report checked and found correct are not defect claims. Classify each finding:",
    "   - `V`: in scope (by `scope.inScope` and `scope.examples`) and confirmed by your own reproduction executed on the pre-fix snapshot, or by an unambiguous code trace (file:line steps);",
    "   - `F`: refuted by such a check, or out of scope (by `scope.outOfScope`);",
    "   - `U`: in scope, neither confirmed nor refuted.",
    "   For every V and F, put in `evidence` the exact command you executed and its result (or the code trace with file:line), and in `reason` why the class applies (cite the scope note where it decides).",
    "3. `notes`: the restatements of known defects you merged, and any judgment call.",
    "",
    "## Output",
    "Write `~/eval/out/scores.json`, valid JSON of exactly this shape:",
    `{"case": "${input.caseId}", "packets": {"<label>": {"k": [{"k": "${ids[0] ?? "K1"}", "m": 0, "l": 0, "s": 0, "quote": "M: \\"...\\" | L: \\"...\\" | S: \\"...\\""}], "findings": [{"id": "f1", "claim": "... (the report's words)", "location": "file:line", "class": "V", "reason": "...", "evidence": "command -> result, or a file:line trace"}], "notes": "..."}}}`,
    `- One entry under \`packets\` per report, keyed by its label (the hex string, without \`NN-\` and \`.md\`). \`k\` has exactly one entry per known defect (${ids.join(", ")}), with \`m\`, \`l\`, \`s\` as the numbers 0 or 1. \`findings\` is an array (empty when there is none); \`class\` is "V", "F" or "U".`,
    "- Rewrite the file after you finish each report, so that it always holds every report scored so far.",
    "- At the end, check with `python` that the file parses and contains every label and every known defect; then reply with a short summary (per report: the known defects found, and the V/F/U counts).",
    "",
    "Rules: score each report independently and never use one report to fill a gap in another; no network; do not install packages; do not modify the project copy.",
  ].join("\n");
}

// ---- one (case, scorer) ----------------------------------------------------------------------------------------------------------

export interface ScoreJob {
  study: string; casesDir: string; caseDir: string; outRoot: string; scorer: ScorerId; scratch: string; guardMs?: number; log?: (line: string) => void;
  /** The session runner (default sol-session.ts runSession); tests substitute a stand-in. */
  runner?: (spec: SessionSpec) => Promise<SessionResult>;
}
export interface ScoreOutcome { caseId: string; scorer: ScorerId; status: "done" | "skipped"; finalRun?: number; compliant?: boolean; scored?: number; unscored?: number; requests: number; costUSD: number; runs: number }

const readScores = (session: SessionResult): { raw?: unknown; error?: string } => {
  const dir = session.final.outputs.out;
  const file = dir ? join(dir, "scores.json") : undefined;
  if (!file || !existsSync(file)) return { error: "no ~/eval/out/scores.json" };
  try { return { raw: JSON.parse(readFileSync(file, "utf8")) }; } catch (error) { return { error: `scores.json does not parse: ${String(error).slice(0, 200)}` }; }
};

export interface ScoringPlan {
  caseId: string; outDir: string; kItems: string[]; seed: string; order: string[]; names: { label: string; name: string }[]; stage: string; cwd: string;
  prompt: string; mounts: MountSpec[]; forbidden: string[]; venv: SessionSpec["venv"]; excluded: PacketInfo[];
}

/** Stage one scorer session's inputs (seeded packet order, rubric, filtered probes) below the scratch and write inputs.json. */
export function prepareScoring(job: Pick<ScoreJob, "study" | "casesDir" | "caseDir" | "outRoot" | "scorer" | "scratch">, outDir: string): ScoringPlan {
  const spec = loadCase(job.caseDir);
  const rubric = readJson(join(job.caseDir, "rubric.json"));
  const known = (rubric.knownDefects as any[]).map(item => ({ id: String(item.id), title: typeof item.title === "string" ? item.title : undefined }));
  const packets = casePackets(job.study, spec.id);
  const seed = seedFor(job.scorer, spec.id);
  const order = packetOrder(packets.filter(item => item.include).map(item => item.label), seed);
  const byLabel = new Map(packets.map(item => [item.label, item]));
  const stage = join(resolve(job.scratch), `stage-${job.scorer}-${spec.id}-${randomBytes(3).toString("hex")}`);
  const names = order.map((label, index) => ({ label, name: `${String(index + 1).padStart(2, "0")}-${label}.md` }));
  const stagedPackets = stageFiles(join(stage, "packets"), names.map(item => ({ from: byLabel.get(item.label)!.file, name: item.name })));
  const stagedRubric = stageFiles(join(stage, "rubric"), ["rubric.json", "rubric.md"].filter(name => existsSync(join(job.caseDir, name))).map(name => ({ from: join(job.caseDir, name), name })));
  const probes = probeSelection(join(job.caseDir, "probes"));
  const stagedProbes = stageFiles(join(stage, "probes"), probes.include);
  const excluded = packets.filter(item => !item.include);
  writeJson(join(outDir, "inputs.json"), {
    case: spec.id, scorer: job.scorer, seed, model: MODEL_REF, thinking: THINKING, caseDir: display(job.caseDir), caseSha256: spec.sha256,
    order: names.map((item, index) => ({ position: index + 1, label: item.label, name: item.name, sha256: stagedPackets[index]!.sha256 })),
    excludedPackets: excluded.map(item => ({ label: item.label, reason: item.reason })),
    rubric: stagedRubric, probes: { included: stagedProbes, excluded: probes.exclude },
  });
  const cwd = targetMount(spec.projectDir);
  const mounts: MountSpec[] = [
    { kind: "copy", host: spec.sourceDir, sandbox: cwd, purpose: "the case's pre-fix snapshot (fresh writable copy)", writable: true },
    { kind: "ro", host: join(stage, "rubric"), sandbox: join(EVAL, "rubric"), purpose: "the case's rubric.json and rubric.md (staged copies)" },
    { kind: "ro", host: join(stage, "probes"), sandbox: join(EVAL, "probes"), purpose: "the case's probes without reference-fix or hidden-test material (staged copies)" },
    { kind: "ro", host: join(stage, "packets"), sandbox: join(EVAL, "packets"), purpose: "the case's blinded packets in the seeded order (staged copies)" },
    { kind: "empty", sandbox: join(EVAL, "out"), purpose: "the scorer's output (scores.json, checks/)", collect: "out" },
  ];
  return {
    caseId: spec.id, outDir, kItems: known.map(item => item.id), seed, order, names, stage, cwd, prompt: scorerPrompt({ caseId: spec.id, cwd, packets: names, known }), mounts,
    forbidden: scorerForbidden(job.study, job.casesDir, job.outRoot), venv: { host: spec.venvDir, projectDir: spec.projectDir, pythonPath: spec.pythonPath, anchorsFrom: spec.sourceDir, fallbackRoot: cwd }, excluded,
  };
}

export async function scoreCase(job: ScoreJob): Promise<ScoreOutcome> {
  const log = job.log ?? ((line: string) => console.log(line));
  const runner = job.runner ?? runSession;
  const spec = loadCase(job.caseDir);
  const outDir = join(resolve(job.outRoot), job.scorer, spec.id);
  if (existsSync(join(outDir, "scores.json"))) { log(`SKIP ${job.scorer}/${spec.id}: ${display(outDir)}/scores.json exists`); return { caseId: spec.id, scorer: job.scorer, status: "skipped", requests: 0, costUSD: 0, runs: 0 }; }
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`${outDir} holds an earlier, unfinished scoring of ${job.scorer}/${spec.id}: inspect it and move it aside before a new run`);
  mkdirSync(outDir, { recursive: true });
  const plan = prepareScoring(job, outDir);
  const { order, kItems, seed, stage, prompt, cwd, mounts, forbidden } = plan;
  const packets = plan.excluded;
  const runs: Record<string, unknown>[] = [];
  let final: { session: SessionResult; raw?: unknown; validation: ScoresValidation; error?: string } | undefined;
  try {
    for (let run = 1; run <= 1 + COMPLETENESS_RERUNS; run++) {
      log(`START ${job.scorer}/${spec.id} run ${run}: ${order.length} packets in seeded order ${order.join(",")}`);
      const session = await runner({
        outDir: join(outDir, `run-${run}`), scratch: job.scratch, label: `${job.scorer}-${spec.id}-run-${run}`, prompt, cwd, mounts, venv: plan.venv,
        guardMs: job.guardMs ?? SCORER_GUARD_MS, forbidden,
      });
      cleanScratch(session);
      const read = readScores(session);
      const validation = validateScores(read.raw, order, kItems);
      runs.push({ run, dir: `run-${run}`, routeOk: session.routeOk, finalRouteOk: session.final.route?.ok === true, attempts: session.attempts.length, infra: session.final.infra, exit: session.final.exit, guardFired: session.final.guardFired, requests: session.requests, costUSD: session.costUSD, ...(read.error ? { outputError: read.error } : {}), incomplete: validation.incomplete, problems: validation.problems, unknownLabels: validation.unknownLabels });
      final = { session, raw: read.raw, validation, ...(read.error ? { error: read.error } : {}) };
      log(`END ${job.scorer}/${spec.id} run ${run}: ${session.requests} requests, $${session.costUSD}, route ${session.routeOk ? "ok" : "VIOLATED"}, incomplete ${validation.incomplete.length ? validation.incomplete.join(",") : "none"}${read.error ? ` (${read.error})` : ""}`);
      if (!validation.incomplete.length) break;
      if (run <= COMPLETENESS_RERUNS) log(`INCOMPLETE ${job.scorer}/${spec.id}: ${validation.incomplete.length} packet(s) without a complete known-defect entry; re-running the session once`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const { session, raw, validation } = final!;
  const packetsOut = raw && typeof raw === "object" && (raw as any).packets && typeof (raw as any).packets === "object" ? (raw as any).packets : {};
  const reportedCase = raw && typeof raw === "object" ? (raw as any).case : undefined;
  writeJson(join(outDir, "scores.json"), { case: spec.id, scorer: { model: MODEL_REF, thinking: THINKING, scorerId: job.scorer, seed }, packets: packetsOut });
  const compliant = session.routeOk && session.final.route?.ok === true;
  const statuses = Object.fromEntries(order.map(label => [label, validation.packets[label]!.status === "scored" ? "scored" : "unscored"]));
  writeJson(join(outDir, "validation.json"), {
    case: spec.id, scorer: job.scorer, seed, model: MODEL_REF, thinking: THINKING, finalRun: runs.length, compliant,
    note: "scores.json = the final run's ~/eval/out/scores.json packets verbatim, with case and scorer set by the harness; packet status per R2-A1 item 1 (incomplete after the one re-run = unscored, never zero)",
    packets: statuses,
    problems: Object.fromEntries(order.map(label => [label, validation.packets[label]!.problems])),
    warnings: Object.fromEntries(order.map(label => [label, validation.packets[label]!.warnings]).filter(([, list]) => (list as string[]).length)),
    counts: Object.fromEntries(order.map(label => [label, validation.packets[label]!.counts ?? null])),
    unknownLabels: validation.unknownLabels, ...(reportedCase !== undefined && reportedCase !== spec.id ? { reportedCase } : {}),
    excludedPackets: packets.map(item => ({ label: item.label, reason: item.reason })),
    runs,
  });
  const requests = runs.reduce((total, item) => total + Number(item.requests ?? 0), 0);
  const costUSD = Math.round(runs.reduce((total, item) => total + Number(item.costUSD ?? 0), 0) * 1e6) / 1e6;
  const scored = Object.values(statuses).filter(status => status === "scored").length;
  log(`DONE ${job.scorer}/${spec.id}: final run ${runs.length}, compliant ${compliant}, scored ${scored}/${order.length}, ${requests} requests, $${costUSD}`);
  if (!compliant) console.error(`NON-COMPLIANT SCORER SESSION ${job.scorer}/${spec.id}: see ${display(outDir)}/run-${runs.length}/session.json`);
  return { caseId: spec.id, scorer: job.scorer, status: "done", finalRun: runs.length, compliant, scored, unscored: order.length - scored, requests, costUSD, runs: runs.length };
}

// ---- CLI -------------------------------------------------------------------------------------------------------------------------

const USAGE = "usage: sol-score.ts score <study> <casesDir> <outRoot> --scorers S1[,S2] --cases c1[,c2,...] --scratch <dir> [--concurrency N] [--guard-min M]";
const option = (argv: readonly string[], name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };

export async function main(argv: readonly string[]): Promise<number> {
  const [command, study, casesDir, outRoot] = argv;
  if (command !== "score" || !study || !casesDir || !outRoot) throw new Error(USAGE);
  const scorers = (option(argv, "--scorers") ?? "").split(",").filter(Boolean);
  if (!scorers.length || scorers.some(item => !(SCORERS as readonly string[]).includes(item))) throw new Error(`--scorers must list ${SCORERS.join(" and/or ")}`);
  const scratch = option(argv, "--scratch") ?? process.env.CB_AB_SOL_SCRATCH;
  if (!scratch) throw new Error("--scratch <dir> (or CB_AB_SOL_SCRATCH) is required: sandbox copies never go to /tmp itself or the repository");
  const concurrency = Number(option(argv, "--concurrency") ?? "1");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error("--concurrency must be 1..5");
  const guardMin = option(argv, "--guard-min");
  const cases = loadCases(casesDir);
  const wanted = (option(argv, "--cases") ?? "").split(",").filter(Boolean);
  const selected = wanted.length ? wanted.map(id => { const found = cases.find(item => item.id === id); if (!found) throw new Error(`no case ${id} in ${casesDir}`); return found; }) : cases;
  mkdirSync(resolve(outRoot), { recursive: true });
  const logFile = join(resolve(outRoot), "score.log");
  const log = (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); appendFileSync(logFile, `${text}\n`); };
  const queue = selected.flatMap(info => scorers.map(scorer => ({ info, scorer: scorer as ScorerId })));
  log(`SCORE ${queue.map(item => `${item.scorer}/${item.info.id}`).join(" ")}; concurrency ${concurrency}; pid ${process.pid}`);
  const outcomes: ScoreOutcome[] = [];
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try { outcomes.push(await scoreCase({ study, casesDir, caseDir: item.info.dir, outRoot, scorer: item.scorer, scratch, ...(guardMin ? { guardMs: Number(guardMin) * 60_000 } : {}), log })); }
      catch (error) { failed++; log(`FAILED ${item.scorer}/${item.info.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
  log(`SCORE END: ${outcomes.filter(item => item.status === "done").length} done, ${outcomes.filter(item => item.status === "skipped").length} skipped, ${failed} failed; $${Math.round(outcomes.reduce((total, item) => total + item.costUSD, 0) * 1e6) / 1e6}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
