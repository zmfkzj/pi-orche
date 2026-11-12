/**
 * SWE task environments of the stage evaluation (experiments/stage-eval), rebuilt OUTSIDE the repository: for each task the
 * source snapshot of results/advisor-reviewer/cache/swe/<id>/src (base commit without history, plus the build-generated files the
 * package needs) is copied to <cache>/<id>/src and a fresh Python virtualenv is built at <cache>/<id>/venv with the install command
 * recorded in fixtures/advisor-bench/swe/<id>/task.json (`install`, non-editable). pip is then removed and the venv made read-only,
 * exactly as experiments/advisor-reviewer/setup-swe.ts does; unlike that script nothing under fixtures/ is rewritten.
 *
 *   npx tsx experiments/stage-eval/envbuild.ts <cache dir> <task id> [...]
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = process.env.STAGE_EVAL_REPO ?? new URL("../../", import.meta.url).pathname;
export const SOURCE_CACHE = join(REPO, "results/advisor-reviewer/cache/swe");
export const SWE_FIXTURES = join(REPO, "fixtures/advisor-bench/swe");

const sh = (command: string, cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execSync(command, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 }).toString();

export async function buildEnvironment(cache: string, id: string): Promise<{ id: string; python: string; ms: number }> {
  const started = Date.now();
  const manifest = JSON.parse(readFileSync(join(SWE_FIXTURES, id, "task.json"), "utf8"));
  if (!manifest.validation?.valid) throw new Error(`${id}: not validated`);
  const dir = join(cache, id);
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, "src"))) await cp(join(SOURCE_CACHE, id, "src"), join(dir, "src"), { recursive: true });
  if (!existsSync(join(dir, "venv/.ready"))) {
    if (existsSync(join(dir, "venv"))) sh("chmod -R u+w venv && rm -rf venv", dir);
    sh("python3 -m venv --without-pip venv", dir);
    const getPip = join(SOURCE_CACHE, "get-pip.py");
    sh(`venv/bin/python ${getPip} -q`, dir);
    const build = await mkdtemp(join(cache, ".build-"));
    try {
      // Install from a throwaway copy of the snapshot, without the generated files (the package build makes its own).
      await cp(join(dir, "src"), build, { recursive: true });
      for (const file of manifest.generatedFiles ?? []) await rm(join(build, file), { force: true });
      const env = { ...process.env, PATH: `${join(dir, "venv/bin")}:${process.env.PATH}`, SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0+bench", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
      sh(String(manifest.install), build, env);
    } finally { await rm(build, { recursive: true, force: true }); }
    sh("venv/bin/python -m pip uninstall -y -q pip", dir);
    sh("chmod -R a-w venv", dir);
    sh("chmod u+w venv && touch venv/.ready && chmod u-w venv", dir);
  }
  const python = sh("venv/bin/python --version", dir).trim();
  if (manifest.pythonVersion && python !== manifest.pythonVersion) throw new Error(`${id}: built with ${python}, the task was validated with ${manifest.pythonVersion}`);
  // Installed distributions (pip is gone, so read them with importlib.metadata) and a digest of the source snapshot.
  const packages = sh(`venv/bin/python -c "import importlib.metadata as m; print('\\n'.join(sorted(set(d.metadata['Name'] + '==' + d.version for d in m.distributions()))))"`, dir).trim().split("\n");
  const sourceDigest = sh("find src -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum", dir).trim().split(/\s+/)[0];
  await writeFile(join(dir, "BUILD.json"), `${JSON.stringify({ id, python, expectedPython: manifest.pythonVersion, install: manifest.install, sourceDigest, packages, builtAt: new Date().toISOString() }, null, 2)}\n`);
  return { id, python, ms: Date.now() - started };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cache, ...ids] = process.argv.slice(2);
  let failed = 0;
  for (const id of ids) {
    try { console.log(JSON.stringify(await buildEnvironment(cache!, id))); }
    catch (error) { failed++; console.log(`${id}: BUILD FAILED ${String(error instanceof Error ? error.message : error).slice(0, 2000)}`); }
  }
  if (failed) process.exit(1);
}
