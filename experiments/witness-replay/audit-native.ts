/**
 * R9 native-boundary correction of the Narwhals audit (results/witness-replay/AUDIT.md "Narwhals: native PySpark"). The issue's
 * own reproduction (audit-only/nw-3478-pyspark.py) runs on REAL PySpark (classic, local mode, its JVM) instead of the SQLFrame
 * stand-in, in two hash-pinned dependency closures prepared in private scratch (README.md "Native PySpark audit"):
 *   task:  the task's original venv (Python 3.14.4 with its pyarrow/pandas/numpy) plus PySpark 4.1.1 / py4j 0.10.9.9 - the PySpark
 *          version the issue records - in a separate directory appended to PYTHONPATH;
 *   issue: the issue's recorded closure: Python 3.12.12, PySpark 4.1.1, pyarrow 23.0.0, pandas 2.3.3, numpy 2.4.2.
 * Both use the user-local Temurin JDK 17 (bound read-only). Every run goes through witness-run.ts (sandbox without network,
 * candidate copy read-only, witness hash, nonce, import roots). Trees: the original snapshot, the maintainers' reference fix
 * (offline, satisfiability only; applied with patch(1) to a scratch copy), the seed F/r1 and the other archived artifacts.
 * The witness hash, the tree digests and the environment manifest are written to <out>/frozen.json BEFORE the first run;
 * results go to <out>/results.json; neither is overwritten (a second run refuses).
 *   node --import tsx experiments/witness-replay/cli.ts audit-nw-native <out dir> <scratch dir> <native env dir>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, dirDigest, pythonPathOf, sourceOf, taskManifest, venvOf, writeJson } from "./env.js";
import type { Bind } from "./sandbox.js";
import { copyCandidate, fileSha256, runWitness, treeDigest, type WitnessRecord } from "./witness-run.js";

const TASK = "narwhals-dev__narwhals-3478", FIXTURES = "fixtures/advisor-bench/swe-r2", CACHE = "results/advisor-reviewer/cache/swe-r2";
const RUNS = "results/ultra-ho/stage3-r2/validation/runs";
export const NW_NATIVE_WITNESS = "experiments/witness-replay/audit-only/nw-3478-pyspark.py";
/** The seed first, then every other archived artifact of the task. */
export const NW_ARTIFACTS = ["F/r1", "F/r2", "H2/r1", "H2/r2"].map(arm => `${RUNS}/${TASK}/${arm}`);

export interface NativeEnv {
  id: "task" | "issue"; label: string; venv: string; nativeRoot: string; pythonPath: string[]; binds: Bind[]; requirements: string;
  digests: Record<string, string>;
}

/** The two closures inside <native dir> (built by the commands in README.md "Native PySpark audit"); missing ones are reported. */
export function nativeEnvs(nativeDir: string): { envs: NativeEnv[]; missing: string[] } {
  const envs: NativeEnv[] = [], missing: string[] = [];
  const site = join(nativeDir, "site-pyspark-4.1.1");
  if (existsSync(join(site, "pyspark")) && existsSync(join(nativeDir, "requirements.txt"))) {
    envs.push({ id: "task", label: "task venv (Python 3.14.4) + PySpark 4.1.1", venv: venvOf(CACHE, TASK), nativeRoot: site, pythonPath: [site], binds: [{ from: site }],
      requirements: join(nativeDir, "requirements.txt"), digests: { [site]: dirDigest(site), [venvOf(CACHE, TASK)]: dirDigest(venvOf(CACHE, TASK)) } });
  } else missing.push(`task closure: ${site}`);
  const venv = join(nativeDir, "venv-issue"), python = join(nativeDir, "python");
  if (existsSync(join(venv, "bin/python")) && existsSync(python) && existsSync(join(nativeDir, "issue-env.txt"))) {
    envs.push({ id: "issue", label: "issue closure (Python 3.12.12, PySpark 4.1.1, pyarrow 23.0.0, pandas 2.3.3, numpy 2.4.2)", venv, nativeRoot: venv, pythonPath: [], binds: [{ from: python }],
      requirements: join(nativeDir, "issue-env.txt"), digests: { [venv]: dirDigest(venv), [python]: dirDigest(python) } });
  } else missing.push(`issue closure: ${venv}`);
  return { envs, missing };
}

export const JDK = process.env.WITNESS_REPLAY_JDK ?? join(homedir(), ".local/opt/jdk-17");

export interface NativeRow { env: string; tree: string; treeDigest: string; status: WitnessRecord["status"]; reason?: string; cases?: { id: string; passed: boolean; observed?: unknown }[]; witnessEnv?: unknown; ms: number }

export async function runNwNative(out: string, scratch: string, nativeDir: string): Promise<NativeRow[]> {
  if (existsSync(join(out, "results.json"))) throw new Error(`${join(out, "results.json")} exists; native evidence is never overwritten`);
  const witness = join(REPO, NW_NATIVE_WITNESS);
  const witnessSha256 = fileSha256(witness);
  const jdk = realpathSync(JDK);
  // `java -version` prints to stderr (the first native run recorded an empty version here; its runs carry javaVersion/javaHome).
  const probe = spawnSync(join(jdk, "bin/java"), ["-version"], { encoding: "utf8" });
  const java = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  const { envs, missing } = nativeEnvs(nativeDir);
  const manifest = taskManifest(FIXTURES, TASK);
  const sub = pythonPathOf(manifest);
  const original = sourceOf(CACHE, TASK);
  const reference = join(scratch, "reference");
  await rm(reference, { recursive: true, force: true });
  await copyCandidate(original, reference);
  execFileSync("chmod", ["-R", "u+w", reference]);
  execFileSync("patch", ["-p1", "--forward", "--no-backup-if-mismatch", "--quiet", "-i", join(REPO, FIXTURES, TASK, "reference/fix.patch")], { cwd: reference, stdio: ["ignore", "pipe", "pipe"] });
  const trees = [{ label: "original snapshot", dir: original }, { label: "reference fix (offline)", dir: reference }, ...NW_ARTIFACTS.map(artifact => ({ label: artifact, dir: join(REPO, artifact, "workspace-final") }))];
  await mkdir(out, { recursive: true });
  for (const env of envs) copyFileSync(env.requirements, join(out, `requirements-${env.id}.txt`));
  const frozen = {
    at: new Date().toISOString(), task: TASK, witness: { path: NW_NATIVE_WITNESS, sha256: witnessSha256 },
    trees: trees.map(tree => ({ label: tree.label, digest: treeDigest(tree.dir) })), referenceApplied: "patch -p1 (offline; satisfiability only)",
    jdk: { path: jdk, version: java.trim().split("\n"), digest: dirDigest(jdk) },
    envs: envs.map(env => ({ id: env.id, label: env.label, venv: env.venv, nativeRoot: env.nativeRoot, requirements: `requirements-${env.id}.txt`, requirementsSha256: fileSha256(env.requirements), digests: env.digests })),
    missing, sandbox: "witness-run.ts: bwrap, --unshare-net (loopback only), candidate copy read-only, JDK and closures read-only, writes only in the run's scratch",
  };
  if (existsSync(join(out, "frozen.json"))) throw new Error(`${join(out, "frozen.json")} exists; refusing to re-freeze`);
  await writeJson(join(out, "frozen.json"), frozen);
  const rows: NativeRow[] = [];
  const records: Record<string, WitnessRecord> = {};
  for (const env of envs) {
    for (const tree of trees) {
      const record = await runWitness({
        name: "nw-3478-pyspark", file: witness, expectedSha256: witnessSha256, candidate: tree.dir, venv: env.venv, pythonPath: sub, scratch: join(scratch, "runs"), guardMs: 300_000,
        extra: {
          binds: [{ from: jdk }, ...env.binds], path: [join(jdk, "bin")], pythonPath: env.pythonPath,
          env: { TZ: "UTC", JAVA_HOME: jdk, SPARK_LOCAL_IP: "127.0.0.1", SPARK_LOCAL_HOSTNAME: "localhost", PYSPARK_PYTHON: join(env.venv, "bin/python"), PYSPARK_DRIVER_PYTHON: join(env.venv, "bin/python"), WITNESS_NATIVE_ROOT: env.nativeRoot },
        },
      });
      records[`${env.id} @ ${tree.label}`] = record;
      const cases = (record.result?.cases ?? []) as { id: string; passed: boolean; observed?: Record<string, unknown> }[];
      rows.push({ env: env.id, tree: tree.label, treeDigest: record.candidateDigest, status: record.status, ...(record.reason ? { reason: record.reason } : {}),
        cases: cases.map(c => ({ id: c.id, passed: c.passed, observed: Object.fromEntries(Object.entries(c.observed ?? {}).filter(([key]) => key !== "traceback")) })), witnessEnv: (record.result as any)?.env, ms: record.ms });
      console.log(`${env.id.padEnd(6)} ${record.status.padEnd(9)} ${tree.label.padEnd(70)} ${cases.map(c => `${c.passed ? "+" : "-"}${c.id}`).join(" ")}${record.reason ? `  (${record.reason})` : ""}`);
    }
  }
  await writeJson(join(out, "results.json"), { at: new Date().toISOString(), frozen: "frozen.json", rows, records });
  await rm(join(scratch, "runs"), { recursive: true, force: true });
  await rm(reference, { recursive: true, force: true });
  return rows;
}
