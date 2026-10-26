/**
 * R1 public-witness audit (results/witness-replay/AUDIT.md): every candidate witness is executed MECHANICALLY (witness-run.ts,
 * sandboxed, hash-checked) against the unmodified snapshot, the maintainers' reference fix applied offline (satisfiability only;
 * never model-facing), the seed artifact and the other archived artifacts of the same task. A witness qualifies a failure family
 * only when it fails on the seed, passes on the reference and every expectation is publicly justified (AUDIT.md).
 *   node --import tsx experiments/witness-replay/cli.ts audit <out dir> <scratch dir>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, sourceOf, taskManifest, pythonPathOf, venvOf, writeJson } from "./env.js";
import { runSandboxed } from "./sandbox.js";
import { copyCandidate, fileSha256, runWitness, treeDigest, type WitnessRecord } from "./witness-run.js";

const V = "results/ultra-ho/stage3-r2/validation/runs";
export interface AuditTarget { task: string; fixtures: string; cache: string; checks: { name: string; file: string }[]; artifacts: string[] }

/** The candidate seeds of the assignment (HF H2/r2, Narwhals F/r1, tox H2/r1) and the two controls, with every archived artifact. */
export const AUDIT_TARGETS: AuditTarget[] = [
  { task: "huggingface__huggingface_hub-4056", fixtures: "fixtures/advisor-bench/swe-r2", cache: "results/advisor-reviewer/cache/swe-r2",
    checks: [{ name: "hf-4056", file: "experiments/witness-replay/witnesses/hf-4056.py" }, { name: "hf-4056-heldout", file: "experiments/witness-replay/heldout/hf-4056.py" }, { name: "hf-4056-diagnostic", file: "experiments/witness-replay/audit-only/hf-4056-diagnostic.py" }],
    artifacts: ["H2/r2", "H2/r1", "F/r1", "F/r2"].map(a => `${V}/huggingface__huggingface_hub-4056/${a}`) },
  { task: "tox-dev__tox-3904", fixtures: "fixtures/advisor-bench/swe", cache: "results/advisor-reviewer/cache/swe",
    checks: [{ name: "tox-3904", file: "experiments/witness-replay/witnesses/tox-3904.py" }, { name: "tox-3904-heldout", file: "experiments/witness-replay/heldout/tox-3904.py" }],
    artifacts: [...["H2/r1", "H2/r2"].map(a => `${V}/tox-dev__tox-3904/${a}`), "results/ultra-ho/stage3/runs/tox-dev__tox-3904/F/r2", "results/ultra-ho/stage3/runs/tox-dev__tox-3904/F/r1"] },
  { task: "narwhals-dev__narwhals-3478", fixtures: "fixtures/advisor-bench/swe-r2", cache: "results/advisor-reviewer/cache/swe-r2",
    checks: [{ name: "nw-3478-audit", file: "experiments/witness-replay/audit-only/nw-3478.py" }],
    artifacts: ["F/r1", "F/r2", "H2/r1", "H2/r2"].map(a => `${V}/narwhals-dev__narwhals-3478/${a}`) },
  { task: "tobymao__sqlglot-7187", fixtures: "fixtures/advisor-bench/swe", cache: "results/advisor-reviewer/cache/swe",
    checks: [{ name: "sqlglot-7187", file: "experiments/witness-replay/witnesses/sqlglot-7187.py" }, { name: "sqlglot-7187-heldout", file: "experiments/witness-replay/heldout/sqlglot-7187.py" }],
    artifacts: [`${V}/tobymao__sqlglot-7187/H2/r1`] },
  { task: "stravalib__stravalib-709_interface", fixtures: "fixtures/advisor-bench/swe", cache: "results/advisor-reviewer/cache/swe",
    checks: [{ name: "stravalib-709", file: "experiments/witness-replay/witnesses/stravalib-709.py" }],
    artifacts: [`${V}/stravalib__stravalib-709_interface/H2/r1`] },
];

export interface AuditRow { task: string; check: string; tree: string; treeDigest: string; status: WitnessRecord["status"]; reason?: string; cases?: { id: string; passed: boolean }[]; ms: number }

/** Run the audit; writes <out>/audit.json (rows + the full records) and returns the rows. */
export async function runAudit(out: string, scratch: string): Promise<AuditRow[]> {
  await mkdir(out, { recursive: true });
  const rows: AuditRow[] = [];
  const records: Record<string, WitnessRecord> = {};
  for (const target of AUDIT_TARGETS) {
    const manifest = taskManifest(target.fixtures, target.task);
    const sub = pythonPathOf(manifest);
    const base = sourceOf(target.cache, target.task);
    const reference = join(scratch, "trees", `${target.task}-reference`);
    if (!existsSync(reference)) {
      await copyCandidate(base, reference);
      execFileSync("git", ["apply", "--whitespace=nowarn", join(REPO, target.fixtures, target.task, "reference/fix.patch")], { cwd: reference, stdio: ["ignore", "pipe", "pipe"] });
    }
    const trees: { label: string; dir: string }[] = [{ label: "original snapshot", dir: base }, { label: "reference fix (offline)", dir: reference }];
    for (const artifact of target.artifacts) if (existsSync(join(REPO, artifact, "workspace-final"))) trees.push({ label: artifact, dir: join(REPO, artifact, "workspace-final") });
    for (const check of target.checks) {
      const expected = fileSha256(join(REPO, check.file));
      for (const tree of trees) {
        const record = await runWitness({ name: check.name, file: join(REPO, check.file), expectedSha256: expected, candidate: tree.dir, venv: venvOf(target.cache, target.task), pythonPath: sub, scratch: join(scratch, "runs") });
        const key = `${check.name} @ ${tree.label}`;
        records[key] = record;
        rows.push({ task: target.task, check: check.name, tree: tree.label, treeDigest: record.candidateDigest, status: record.status, ...(record.reason ? { reason: record.reason } : {}), ...(record.result?.cases ? { cases: record.result.cases.map(c => ({ id: c.id, passed: c.passed })) } : {}), ms: record.ms });
        console.log(`${record.status.padEnd(9)} ${check.name.padEnd(22)} ${tree.label}${record.reason ? `  (${record.reason})` : ""}  ${(record.result?.cases ?? []).map(c => `${c.passed ? "+" : "-"}${c.id}`).join(" ")}`);
      }
    }
  }
  await writeJson(join(out, "audit.json"), { at: new Date().toISOString(), rows, records, witnesses: Object.fromEntries(AUDIT_TARGETS.flatMap(t => t.checks).map(c => [c.file, fileSha256(join(REPO, c.file))])) });
  await rm(join(scratch, "runs"), { recursive: true, force: true });
  return rows;
}

/**
 * The tox issue's only statement about the host-ISA insertion (prompt.txt:71): "Commenting out this 'current.add' line fixes the
 * issue, but breaks a whole bunch of other tests". Executed: the original snapshot with exactly that one line disabled versus the
 * unmodified snapshot, the whole visible test suite on each (sandboxed, offline, writable copies), failing test ids compared.
 * Writes <out>/tox-line71.json.
 */
export async function runToxLine71(out: string, scratch: string): Promise<{ onlyCommented: string[]; onlyOriginal: string[] }> {
  const task = "tox-dev__tox-3904", cache = "results/advisor-reviewer/cache/swe";
  const base = join(scratch, "tox-line71");
  await rm(base, { recursive: true, force: true });
  const line = "        current.add(parts[-1])\n";
  const variants = { original: join(base, "original"), commented: join(base, "commented") };
  for (const dir of Object.values(variants)) { await copyCandidate(sourceOf(cache, task), dir); execFileSync("chmod", ["-R", "u+w", dir]); }
  const factor = join(variants.commented, "src/tox/config/loader/ini/factor.py");
  const text = await readFile(factor, "utf8");
  if (text.split(line).length !== 2) throw new Error("the current.add(parts[-1]) line is not unique in factor.py");
  await writeFile(factor, text.replace(line, "        pass  # current.add(parts[-1])  -- disabled as in the issue (prompt.txt:71)\n"));
  const venv = venvOf(cache, task);
  const failing = { original: [] as string[], commented: [] as string[] };
  const summary: Record<string, string> = {};
  for (const label of ["original", "commented"] as const) {
    const dir = variants[label];
    const tmp = join(base, `${label}-tmp`), home = join(base, `${label}-home`);
    await mkdir(tmp, { recursive: true }); await mkdir(home, { recursive: true });
    const junit = join(tmp, "junit.xml");
    const run = await runSandboxed({
      binds: [{ from: dir, rw: true }, { from: venv }, { from: tmp, rw: true }, { from: home, rw: true }],
      env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONPATH: join(dir, "src"), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      cwd: dir, command: [join(venv, "bin/python"), "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests", `--junitxml=${junit}`],
    }, { guardMs: 40 * 60_000 });
    summary[label] = run.text.split("\n").filter(item => /^\d+ (passed|failed)|^=+ .*(passed|failed)/.test(item)).at(-1) ?? `exit ${run.code}`;
    const xml = existsSync(junit) ? readFileSync(junit, "utf8") : "";
    failing[label] = [...xml.matchAll(/<testcase classname="([^"]*)" name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
      .filter(match => /<(failure|error)\b/.test(match[3] ?? "")).map(match => `${match[1]}::${match[2]}`).sort();
  }
  const onlyCommented = failing.commented.filter(id => !failing.original.includes(id));
  const onlyOriginal = failing.original.filter(id => !failing.commented.includes(id));
  await writeJson(join(out, "tox-line71.json"), {
    at: new Date().toISOString(), task, statement: "prompt.txt:71 (public issue text)", edit: "src/tox/config/loader/ini/factor.py: `current.add(parts[-1])` disabled",
    command: "python -m pytest -q -p no:cacheprovider tests (sandboxed: no network, writable copies)", summary, failing, onlyCommented, onlyOriginal,
  });
  await chmod(base, 0o755);
  await rm(base, { recursive: true, force: true });
  return { onlyCommented, onlyOriginal };
}

export const listArtifacts = (dir: string): string[] => existsSync(dir) ? readdirSync(dir) : [];
export { treeDigest };
