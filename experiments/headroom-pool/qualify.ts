/**
 * Witness qualification of one case (E4/E5/E7, model-free; experiments/headroom-pool/README.md "Witnesses"):
 *   try:      one run of the witness on the pre-fix snapshot only (authoring aid; logged in the case's history, never a verdict);
 *   qualify:  QUALIFY_REPEATS runs on the pre-fix snapshot and QUALIFY_REPEATS on the snapshot with the reference fix applied offline
 *             (grader/<id>/fix.patch); verdict by protocol.ts `qualifies`.
 * Every run is witness-replay's mechanical `runWitness` (sandbox without network, read-only candidate copy, frozen witness sha256,
 * nonce, exit/result agreement), with the case's sealed venv and the uv Python install bound read-only.
 * History: results/headroom-pool/qualification/<id>.json keeps every try and every qualification (witness sha256 of each), never
 * rewritten in place; the verdict is the LAST qualification's, and E6 forbids changing an expected value after a reference run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeTree } from "../swe-pool/env.js";
import { fileSha256, runWitness, type WitnessRecord } from "../witness-replay/witness-run.js";
import { envManifestPath, graderDir, readJsonFile, type StudyPaths } from "./cases.js";
import { caseDir, pythonInstallDir, type EnvManifest } from "./envbuild.js";
import { QUALIFY_REPEATS, qualifies, WITNESS_GUARD_MS } from "./protocol.js";

export const witnessPath = (paths: StudyPaths, id: string) => join(paths.repo, "experiments/headroom-pool/witnesses", `${id}.py`);
export const historyPath = (paths: StudyPaths, id: string) => join(paths.out, "qualification", `${id}.json`);

export interface RunSummary { tree: "prefix" | "reference"; status: string; reason?: string; exit: number | null; ms: number; candidateDigest: string; result?: unknown; outputTail: string }
const summarize = (tree: RunSummary["tree"], run: WitnessRecord): RunSummary => ({ tree, status: run.status, ...(run.reason ? { reason: run.reason } : {}), exit: run.exit, ms: run.ms, candidateDigest: run.candidateDigest, ...(run.result ? { result: run.result } : {}), outputTail: run.output.slice(-6000) });

export interface History { id: string; entries: { kind: "try" | "qualify"; at: string; witnessSha256: string; runs: RunSummary[]; verdict?: ReturnType<typeof qualifies>; status?: "running" | "completed"; referenceSetupError?: string }[] }

async function appendHistory(paths: StudyPaths, id: string, entry: History["entries"][number]): Promise<History> {
  const path = historyPath(paths, id);
  const history: History = existsSync(path) ? readJsonFile<History>(path) : { id, entries: [] };
  history.entries.push(entry);
  await mkdir(join(paths.out, "qualification"), { recursive: true });
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`);
  return history;
}

export const versionPath = (paths: StudyPaths, id: string, sha: string) => join(paths.out, "qualification", "versions", id, `${sha}.py`);
/** Keep the exact bytes of every witness version before it runs (by sha256). */
async function archiveWitness(paths: StudyPaths, id: string, file: string, sha: string): Promise<void> {
  const target = versionPath(paths, id, sha);
  if (!existsSync(target)) { await mkdir(join(paths.out, "qualification", "versions", id), { recursive: true }); await cp(file, target); }
  if (fileSha256(target) !== sha) throw new Error(`${id}: archived witness ${target} does not have sha256 ${sha} (the file changed while starting)`);
}

/** Rewrite the last history entry (a qualification recorded incrementally, run by run). */
async function replaceLast(paths: StudyPaths, id: string, entry: History["entries"][number]): Promise<void> {
  const path = historyPath(paths, id);
  const history = readJsonFile<History>(path);
  history.entries[history.entries.length - 1] = entry;
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`);
}

/** One witness run against a tree of the case (the venv and the uv Python install read-only). */
export async function witnessRun(paths: StudyPaths, id: string, tree: string, file: string, sha: string, name: string, env: EnvManifest): Promise<WitnessRecord> {
  return runWitness({ name, file, expectedSha256: sha, candidate: tree, venv: join(caseDir(paths.roots, id), "venv"), pythonPath: env.pythonPath ?? ".", scratch: join(paths.roots.scratch, "witness-runs"), guardMs: WITNESS_GUARD_MS, extra: { binds: [{ from: pythonInstallDir(paths.roots) }], env: { TZ: "UTC" } } });
}

/** A writable copy of the pre-fix snapshot with the reference fix applied (offline; grader data). */
export async function referenceTree(paths: StudyPaths, id: string): Promise<string> {
  const copy = await mkdtemp(join(paths.roots.scratch, `ref-${id}-`));
  await cp(join(caseDir(paths.roots, id), "src"), copy, { recursive: true });
  execFileSync("chmod", ["-R", "u+w", copy]);
  execFileSync("git", ["apply", "--whitespace=nowarn", join(graderDir(paths, id), "fix.patch")], { cwd: copy, stdio: ["ignore", "pipe", "pipe"] });
  return copy;
}

function builtEnv(paths: StudyPaths, id: string): EnvManifest {
  if (!existsSync(envManifestPath(paths, id))) throw new Error(`${id}: no environment manifest`);
  const env = readJsonFile<EnvManifest>(envManifestPath(paths, id));
  if (env.status !== "built") throw new Error(`${id}: environment not built (${env.reason ?? "?"})`);
  return env;
}

/** Authoring aid: the witness once on the pre-fix snapshot. */
export async function tryWitness(paths: StudyPaths, id: string): Promise<RunSummary> {
  const env = builtEnv(paths, id);
  const file = witnessPath(paths, id);
  const sha = fileSha256(file);
  await archiveWitness(paths, id, file, sha);
  const run = await witnessRun(paths, id, join(caseDir(paths.roots, id), "src"), file, sha, `${id}-try`, env);
  const summary = summarize("prefix", run);
  await appendHistory(paths, id, { kind: "try", at: new Date().toISOString(), witnessSha256: sha, runs: [summary] });
  return summary;
}

/** The qualification runs and verdict (E4, E5, E7). */
export async function qualifyCase(paths: StudyPaths, id: string): Promise<History["entries"][number]> {
  const env = builtEnv(paths, id);
  const file = witnessPath(paths, id);
  const sha = fileSha256(file);
  await archiveWitness(paths, id, file, sha);
  const entry: History["entries"][number] = { kind: "qualify", at: new Date().toISOString(), witnessSha256: sha, runs: [], status: "running" };
  await appendHistory(paths, id, entry);
  for (let index = 1; index <= QUALIFY_REPEATS; index++) {
    entry.runs.push(summarize("prefix", await witnessRun(paths, id, join(caseDir(paths.roots, id), "src"), file, sha, `${id}-prefix-${index}`, env)));
    await replaceLast(paths, id, entry);
  }
  let reference: string;
  try { reference = await referenceTree(paths, id); } catch (error) {
    entry.referenceSetupError = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    entry.verdict = { qualified: false, failed: "E7", detail: `the reference fix could not be applied: ${entry.referenceSetupError.split("\n")[0]}` };
    entry.status = "completed";
    await replaceLast(paths, id, entry);
    return entry;
  }
  try {
    for (let index = 1; index <= QUALIFY_REPEATS; index++) {
      entry.runs.push(summarize("reference", await witnessRun(paths, id, reference, file, sha, `${id}-reference-${index}`, env)));
      await replaceLast(paths, id, entry);
    }
  } finally { await removeTree(reference); }
  entry.verdict = qualifies({ prefix: entry.runs.filter(run => run.tree === "prefix").map(run => run.status), reference: entry.runs.filter(run => run.tree === "reference").map(run => run.status) });
  entry.status = "completed";
  await replaceLast(paths, id, entry);
  return entry;
}

/** The current verdict of a case: its last qualification, when the witness file still has that sha256. */
export function currentVerdict(paths: StudyPaths, id: string): { qualified: boolean; witnessSha256?: string; detail: string } {
  if (!existsSync(historyPath(paths, id))) return { qualified: false, detail: "no qualification" };
  const last = readJsonFile<History>(historyPath(paths, id)).entries.filter(entry => entry.kind === "qualify").at(-1);
  if (!last?.verdict) return { qualified: false, detail: "no qualification" };
  const file = witnessPath(paths, id);
  if (!existsSync(file) || fileSha256(file) !== last.witnessSha256) return { qualified: false, witnessSha256: last.witnessSha256, detail: "witness changed after its last qualification" };
  return { qualified: last.verdict.qualified, witnessSha256: last.witnessSha256, detail: last.verdict.detail };
}

export const readText = (path: string): string => readFileSync(path, "utf8");
