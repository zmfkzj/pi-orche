/**
 * Per-case files of the headroom-pool study (model-free):
 *   grader/<id>/   grader-only data, never mounted into a model sandbox: hidden test patch, reference fix, F2P/P2P lists, the
 *                  validation of the hidden tests (base vs reference) and the visible-test baseline of the pre-fix snapshot;
 *   envs/<id>.json the environment manifest (envbuild.ts);
 *   packets/<id>/  the model-facing packet: the exact baseline prompt and the provenance of everything a session sees.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Log, removeTree } from "../swe-pool/env.js";
import { sha256 } from "../witness-replay/witness-run.js";
import { buildEnv, caseDir, pythonInstallDir, runTests, statusesOf, type CacheRoots, type EnvManifest } from "./envbuild.js";
import { readSource } from "./pool.js";
import { baselinePrompt, POOLS, type PoolName, type RawRecord } from "./protocol.js";

export interface StudyPaths { repo: string; out: string; roots: CacheRoots }
export const graderDir = (paths: StudyPaths, id: string) => join(paths.out, "grader", id);
export const envManifestPath = (paths: StudyPaths, id: string) => join(paths.out, "envs", `${id}.json`);
export const packetDir = (paths: StudyPaths, id: string) => join(paths.out, "packets", id);
export const readJsonFile = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** The raw dataset record of a pool case. */
export function recordOf(repo: string, pool: PoolName, id: string): RawRecord {
  for (const file of POOLS[pool].files) for (const record of readSource(repo, file)) if (record.instance_id === id) return record;
  throw new Error(`${id} is not in pool ${pool}'s sources`);
}

const writeText = async (path: string, text: string) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); };

/** Grader-only files of a case (written once per content; the record's hidden parts never leave grader/). */
export async function writeGrader(paths: StudyPaths, record: RawRecord): Promise<void> {
  const dir = graderDir(paths, record.instance_id);
  await mkdir(dir, { recursive: true });
  await writeText(join(dir, "test.patch"), record.test_patch ?? "");
  await writeText(join(dir, "fix.patch"), record.patch ?? "");
  await writeText(join(dir, "record.json"), `${JSON.stringify({ id: record.instance_id, repo: record.repo, baseCommit: record.base_commit, createdAt: record.created_at, failToPass: record.FAIL_TO_PASS ?? [], passToPass: record.PASS_TO_PASS ?? [], testCmd: record.install_config?.test_cmd, sha256: { testPatch: sha256(record.test_patch ?? ""), fixPatch: sha256(record.patch ?? "") } }, null, 2)}\n`);
}

/** Model-facing packet: the exact prompt and its provenance (issue text sha256, snapshot and environment digests). */
export async function writePacket(paths: StudyPaths, record: RawRecord, env: EnvManifest): Promise<{ promptSha256: string }> {
  const dir = packetDir(paths, record.instance_id);
  const prompt = baselinePrompt({ problemStatement: record.problem_statement });
  await mkdir(dir, { recursive: true });
  await writeText(join(dir, "prompt.txt"), prompt);
  await writeText(join(dir, "issue.md"), record.problem_statement);
  const packet = {
    id: record.instance_id, repo: record.repo, issueUrlHint: `https://github.com/${record.repo}`, baseCommit: record.base_commit, createdAt: record.created_at,
    promptSha256: sha256(prompt), issueSha256: sha256(record.problem_statement), snapshot: { digest: env.srcDigest, generatedFiles: env.generatedFiles ?? [], pythonPath: env.pythonPath },
    environment: { python: env.python?.version, venvDigest: env.venvDigest, excludeNewer: env.excludeNewer, closure: env.freeze?.length ?? 0 }, licenses: env.licenses ?? [],
    modelSees: ["prompt.txt (the issue verbatim inside the ordinary instruction)", "the pre-fix snapshot (snapshot.digest) as the workspace", "python/pytest of the sealed environment (no pip, no network)"],
  };
  await writeText(join(dir, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`);
  return { promptSha256: packet.promptSha256 };
}

/** Build the environment of one case (E1) and write its manifest and grader files. */
export async function setupCase(paths: StudyPaths, pool: PoolName, id: string): Promise<EnvManifest> {
  const record = recordOf(paths.repo, pool, id);
  await writeGrader(paths, record);
  await mkdir(join(paths.out, "logs"), { recursive: true });
  const log = new Log(join(paths.out, "logs", `${id}.env.log`));
  const manifest = await buildEnv(record, paths.roots, envManifestPath(paths, id), log);
  if (manifest.status === "built") await writePacket(paths, record, manifest);
  return manifest;
}

const applyPatch = (dir: string, patch: string) => execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Grader validation of a built case (sandboxed, no network): the dataset's test command on (a) the pristine snapshot (the visible
 * baseline, frozen before any solving), (b) the snapshot with the hidden tests, (c) the snapshot with the reference fix and the
 * hidden tests. F2P must fail on (b) and pass on (c); P2P failing on (c) are excluded from the regression comparison.
 */
export async function validateCase(paths: StudyPaths, id: string): Promise<any> {
  const env = readJsonFile<EnvManifest>(envManifestPath(paths, id));
  if (env.status !== "built") throw new Error(`${id}: environment not built`);
  const grader = graderDir(paths, id);
  const record = readJsonFile(join(grader, "record.json"));
  const venv = join(caseDir(paths.roots, id), "venv"), src = join(caseDir(paths.roots, id), "src");
  const variants: Record<string, any> = {};
  for (const variant of ["visible", "base", "reference"] as const) {
    const copy = await mkdtemp(join(paths.roots.scratch, `val-${variant}-`));
    try {
      await cp(src, copy, { recursive: true });
      execFileSync("chmod", ["-R", "u+w", copy]);
      if (variant === "reference") applyPatch(copy, join(grader, "fix.patch"));
      if (variant !== "visible") applyPatch(copy, join(grader, "test.patch"));
      const runResult = await runTests({ venv, pythonDir: pythonInstallDir(paths.roots), tree: copy, layout: env.pythonPath ?? ".", testCmd: record.testCmd, scratch: paths.roots.scratch });
      variants[variant] = { exit: runResult.exit, guardFired: runResult.guardFired, ms: runResult.ms, counts: countOf(runResult.statuses), statuses: runResult.statuses, f2p: statusesOf(runResult, record.failToPass), p2p: statusesOf(runResult, record.passToPass), tail: runResult.tail };
    } finally { await removeTree(copy); }
  }
  const f2pFailBase = record.failToPass.every((t: string) => variants.base.f2p[t] !== "PASSED");
  const f2pPassReference = record.failToPass.every((t: string) => variants.reference.f2p[t] === "PASSED");
  const excludedP2P = record.passToPass.filter((t: string) => variants.reference.p2p[t] !== "PASSED");
  const validation = { id, at: new Date().toISOString(), valid: f2pFailBase && f2pPassReference, f2pFailBase, f2pPassReference, excludedP2P, visible: variants.visible, base: variants.base, reference: variants.reference };
  await writeText(join(grader, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`);
  return validation;
}

export function countOf(statuses: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of Object.values(statuses)) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export const exists = existsSync;
