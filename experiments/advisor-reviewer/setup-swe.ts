/**
 * Import and set up SWE-rebench tasks (real GitHub issues of 2026 with the maintainers' fix and tests) for the advisor/reviewer
 * benchmark. Source records: results/iso-token/raw/rebench-2026_0*.jsonl (local copy of the SWE-rebench dataset, not tracked).
 *
 *   npx tsx experiments/advisor-reviewer/setup-swe.ts <instance_id> [...]
 *
 * Per task:
 * - fixtures/advisor-bench/swe/<id>/: task.json (issue text, repository, base commit, FAIL_TO_PASS / PASS_TO_PASS, test command, the
 *   dataset's install command, validation), hidden/test.patch (the tests the grader adds), reference/fix.patch (the maintainers' fix,
 *   used only to validate the environment). Neither patch ever enters a workspace.
 * - results/advisor-reviewer/cache/swe/<id>/ (not tracked, rebuilt by this script): src/ = `git archive` of the base commit (no git
 *   history, so no later commit is reachable from a workspace) plus build-generated files the package needs to import (e.g. a
 *   setuptools-scm _version.py), venv/ = Python 3.14 virtualenv with the package and its test dependencies installed NON-editable and
 *   then made read-only. Workspaces run their own code first on sys.path through PYTHONPATH (tasks.ts `pythonWrappers`).
 * - Validation (recorded in task.json): with the hidden tests applied, the FAIL_TO_PASS tests must fail on the starting code and every
 *   FAIL_TO_PASS test must pass with the reference fix. PASS_TO_PASS tests that fail WITH the reference fix in this environment
 *   (Python 3.14 instead of the dataset's version) are excluded from grading and listed.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO, SWE_CACHE, SWE_DIR, matchStatus, runSweTests, sweLayout } from "./tasks.js";

const RAW = join(REPO, "results/iso-token/raw");
const sh = (command: string, cwd: string, env: NodeJS.ProcessEnv = process.env) => execSync(command, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 }).toString();

function record(id: string): { record: any; file: string; sha256: string } {
  for (const name of readdirSync(RAW).filter(file => /^rebench-.*\.jsonl$/.test(file)).sort()) {
    for (const line of readFileSync(join(RAW, name), "utf8").split("\n")) {
      if (!line.includes(`"${id}"`)) continue;
      const parsed = JSON.parse(line);
      if (parsed.instance_id === id) return { record: parsed, file: `results/iso-token/raw/${name}`, sha256: createHash("sha256").update(line).digest("hex") };
    }
  }
  throw new Error(`${id}: not in ${RAW}`);
}

async function setup(id: string) {
  const { record: r, file, sha256 } = record(id);
  const fixture = join(SWE_DIR, id), cache = join(SWE_CACHE, id);
  await mkdir(join(fixture, "hidden"), { recursive: true });
  await mkdir(join(fixture, "reference"), { recursive: true });
  await writeFile(join(fixture, "hidden/test.patch"), r.test_patch);
  await writeFile(join(fixture, "reference/fix.patch"), r.patch);
  const testCmd: string = r.install_config.test_cmd;
  const testFiles = [...new Set(testCmd.split(/\s+/).filter((part: string) => /\.py$/.test(part)))];
  const manifest: any = {
    id, title: r.problem_statement.split("\n")[0].replace(/^#+\s*/, "").slice(0, 120), repo: r.repo, baseCommit: r.base_commit, createdAt: r.created_at,
    problemStatement: r.problem_statement, interface: r.interface || "", failToPass: r.FAIL_TO_PASS, passToPass: r.PASS_TO_PASS, testFiles,
    testCmd, datasetInstall: r.install_config.install, datasetPython: r.install_config.python,
    source: { dataset: "SWE-rebench (nebius/SWE-rebench, 2026 releases)", file, recordSha256: sha256 },
  };

  // Source snapshot of the base commit, without history.
  if (!existsSync(join(cache, "src"))) {
    const clone = join(cache, "clone");
    await rm(clone, { recursive: true, force: true });
    await mkdir(clone, { recursive: true });
    sh("git init -q && git remote add origin https://github.com/" + r.repo + ".git", clone);
    sh(`git fetch -q --depth 1 origin ${r.base_commit}`, clone);
    await mkdir(join(cache, "src.tmp"), { recursive: true });
    const archive = execFileSync("git", ["archive", r.base_commit], { cwd: clone, maxBuffer: 1024 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", join(cache, "src.tmp")], { input: archive, maxBuffer: 1024 * 1024 * 1024 });
    await rm(clone, { recursive: true, force: true });
    execFileSync("mv", [join(cache, "src.tmp"), join(cache, "src")]);
  }
  // Virtualenv: the dataset's install command, non-editable, from a throwaway copy of the source.
  if (!existsSync(join(cache, "venv/.ready"))) {
    if (existsSync(join(cache, "venv"))) sh(`chmod -R u+w venv && rm -rf venv`, cache);
    sh("python3 -m venv --without-pip venv", cache);
    const getPip = join(SWE_CACHE, "get-pip.py");
    if (!existsSync(getPip)) sh(`curl -sSf -m 120 https://bootstrap.pypa.io/get-pip.py -o ${getPip}`, SWE_CACHE);
    sh(`venv/bin/python ${getPip} -q`, cache);
    const build = await mkdtemp(join(tmpdir(), "swe-build-"));
    try {
      await cp(join(cache, "src"), build, { recursive: true });
      // setuptools-scm and friends need a version without git metadata.
      const env = { ...process.env, PATH: `${join(cache, "venv/bin")}:${process.env.PATH}`, SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0+bench", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
      const install = String(r.install_config.install).replace(/(pip install[^&;]*?)\s-e\s+/g, "$1 ").replace(/--root-user-action=ignore/g, "");
      manifest.install = install;
      sh(install, build, env);
      // Files the build generated inside the package (absent from the source): copy them into the snapshot.
      const layout = sweLayout(join(cache, "src"));
      const site = sh(`venv/bin/python -c "import sysconfig;print(sysconfig.get_paths()['purelib'])"`, cache).trim();
      const generated: string[] = [];
      for (const dist of readdirSync(site).filter(name => name.endsWith(".dist-info"))) {
        const recordFile = join(site, dist, "RECORD");
        if (!existsSync(recordFile)) continue;
        for (const line of readFileSync(recordFile, "utf8").split("\n")) {
          const path = line.split(",")[0];
          if (!path || path.includes(".dist-info/") || path.startsWith("..") || !path.endsWith(".py")) continue;
          const top = path.split("/")[0]!;
          if (!existsSync(join(cache, "src", layout, top))) continue;
          if (!existsSync(join(cache, "src", layout, path))) { await mkdir(dirname(join(cache, "src", layout, path)), { recursive: true }); await cp(join(site, path), join(cache, "src", layout, path)); generated.push(join(layout, path)); }
        }
      }
      manifest.generatedFiles = generated;
      manifest.pythonPath = layout;
    } finally { await rm(build, { recursive: true, force: true }); }
    // No pip inside the environment the models use (dependencies are fixed; nothing may be downloaded), then read-only.
    sh("venv/bin/python -m pip uninstall -y -q pip", cache);
    sh("chmod -R a-w venv", cache);
    sh("chmod u+w venv && touch venv/.ready && chmod u-w venv", cache);
  } else {
    const previous = JSON.parse(await readFile(join(fixture, "task.json"), "utf8").catch(() => "{}"));
    manifest.install = previous.install; manifest.generatedFiles = previous.generatedFiles ?? []; manifest.pythonPath = previous.pythonPath ?? sweLayout(join(cache, "src"));
  }
  manifest.pythonVersion = sh("venv/bin/python --version", cache).trim();
  await writeFile(join(fixture, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Validation: starting code vs reference fix, both with the hidden tests.
  const validation: any = {};
  for (const variant of ["base", "reference"] as const) {
    const copy = await mkdtemp(join(tmpdir(), `swe-${variant}-`));
    try {
      await cp(join(cache, "src"), copy, { recursive: true });
      if (variant === "reference") execFileSync("git", ["apply", "--whitespace=nowarn", join(fixture, "reference/fix.patch")], { cwd: copy });
      execFileSync("git", ["apply", "--whitespace=nowarn", join(fixture, "hidden/test.patch")], { cwd: copy });
      const started = Date.now();
      const result = await runSweTests(manifest, cache, copy, join(copy, ".bench-bin"));
      validation[variant] = { ms: Date.now() - started, ...summarize(manifest, result.statuses), exit: result.exit };
    } finally { await rm(copy, { recursive: true, force: true }); }
  }
  const f2pFailBase = manifest.failToPass.every((t: string) => validation.base.status[t] !== "PASSED");
  const f2pPassRef = manifest.failToPass.every((t: string) => validation.reference.status[t] === "PASSED");
  manifest.excludedPassToPass = manifest.passToPass.filter((t: string) => validation.reference.status[t] !== "PASSED");
  manifest.validation = {
    at: new Date().toISOString(), valid: f2pFailBase && f2pPassRef, f2pFailOnBase: f2pFailBase, f2pPassWithReference: f2pPassRef,
    base: { ms: validation.base.ms, counts: validation.base.counts }, reference: { ms: validation.reference.ms, counts: validation.reference.counts },
    excludedPassToPass: manifest.excludedPassToPass.length,
  };
  await writeFile(join(fixture, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${id}: valid=${manifest.validation.valid} f2p ${manifest.failToPass.length} p2p ${manifest.passToPass.length} excluded ${manifest.excludedPassToPass.length} (${manifest.pythonVersion}, ${Math.round(validation.reference.ms / 1000)}s)`);
}

function summarize(manifest: any, statuses: Map<string, string>) {
  const status: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const id of [...manifest.failToPass, ...manifest.passToPass]) {
    const value = matchStatus(statuses, id);
    status[id] = value;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return { status, counts };
}
for (const id of process.argv.slice(2)) {
  try { await setup(id); } catch (error) { console.log(`${id}: SETUP FAILED ${String(error instanceof Error ? error.message : error).slice(0, 1500)}`); }
}
