/**
 * Native environment of one pool record (eligibility E1, model-free; experiments/headroom-pool/README.md "Environments"):
 *   src/   the base commit's tree (`git fetch --depth 1` + `git archive`, no history) = the pre-fix snapshot, plus only the build's
 *          generated .py files the package needs to import from source (recorded);
 *   venv/  uv-managed CPython at the dataset's Python version; the dataset's install command under protocol.ts installPlan
 *          (uv pip, non-editable, dependencies resolved as of the record's date + 1 day); sealed read-only, no pip;
 *   E1 check: the package's top-level modules import from src/ (not from site-packages).
 * Every executed step, its output tail and the resolved closure (uv pip freeze, interpreter digest) go to the environment manifest
 * results/headroom-pool/envs/<id>.json; failures are recorded with their step and reason, never repaired beyond the protocol.
 * Test runs (grader validation, visible baseline) execute in the bubblewrap sandbox without network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { matchStatus, sweLayout } from "../advisor-reviewer/tasks.js";
import { CommandError, Log, gitArchive, isNetworkFailure, parseStatuses, removeTree, run } from "../swe-pool/env.js";
import { dirDigest } from "../witness-replay/env.js";
import { runSandboxed, type Bind } from "../witness-replay/sandbox.js";
import { fileSha256, sha256, treeDigest } from "../witness-replay/witness-run.js";
import { excludeNewerOf, installPlan, NETWORK_RETRIES, type InstallStep, type RawRecord } from "./protocol.js";

export const UV = process.env.HEADROOM_UV ?? join(process.env.HOME ?? "", ".local/bin/uv");
/** Version-bypass variables of the common dynamic-versioning backends (no git metadata in a snapshot). */
export const VERSION_BYPASS = { SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0+headroom", UV_DYNAMIC_VERSIONING_BYPASS: "0.0.0", POETRY_DYNAMIC_VERSIONING_BYPASS: "0.0.0", PDM_BUILD_SCM_VERSION: "0.0.0", HATCH_BUILD_HOOK_VCS_VERSION: "0.0.0" } as const;

export interface CacheRoots { cache: string; scratch: string }
export const caseDir = (roots: CacheRoots, id: string) => join(roots.cache, id);
export const pythonInstallDir = (roots: CacheRoots) => join(roots.cache, "_python");
export const uvCacheDir = (roots: CacheRoots) => join(roots.cache, "_uv-cache");

export interface EnvManifest {
  id: string; status: "built" | "failed"; step?: string; reason?: string; at: string; ms: number;
  repo: string; baseCommit: string; createdAt: string; datasetPython?: string; excludeNewer?: string;
  python?: { request: string; version: string; executable: string; sha256: string; installDir: string };
  uv?: string; install?: { dataset: string; steps: InstallStep[] }; generatedFiles?: string[]; pythonPath?: string; submodules?: string[];
  importCheck?: { modules: string[]; files: Record<string, string>; ok: boolean; output?: string };
  srcDigest?: string; venvDigest?: string; freeze?: string[]; licenses?: { file: string; firstLine: string }[];
  testCmd?: string;
}

const tail = (text: string, lines = 30) => text.trim().split("\n").slice(-lines).join("\n").slice(-4000);

function describe(error: unknown): string {
  if (error instanceof CommandError) return `${error.timedOut ? "timed out" : `exit ${error.code ?? error.signal}`}: ${tail(error.stderr, 15)}`;
  return error instanceof Error ? error.message.slice(0, 1500) : String(error).slice(0, 1500);
}

/** Fetch the base commit into src/ (once): `git archive` of the commit, or with submodules a checkout of the commit and its gitlinks. */
async function fetchSource(record: RawRecord, dir: string, log: Log, submodules: boolean): Promise<string[]> {
  if (existsSync(join(dir, "src"))) return existsSync(join(dir, "submodules.json")) ? JSON.parse(readFileSync(join(dir, "submodules.json"), "utf8")) : [];
  const clone = join(dir, "clone");
  const network = async (work: () => Promise<unknown>) => {
    for (let attempt = 0; ; attempt++) {
      try { await work(); return; } catch (error) { if (attempt < NETWORK_RETRIES && isNetworkFailure(describe(error))) continue; throw error; }
    }
  };
  await removeTree(clone);
  await mkdir(clone, { recursive: true });
  let modules: string[] = [];
  try {
    await run("git", ["init", "-q"], clone, log);
    await run("git", ["remote", "add", "origin", `https://github.com/${record.repo}.git`], clone, log);
    await network(() => run("git", ["fetch", "-q", "--depth", "1", "origin", record.base_commit], clone, log, { timeoutMs: 900_000 }));
    await removeTree(join(dir, "src.tmp"));
    await mkdir(join(dir, "src.tmp"), { recursive: true });
    if (!submodules) await gitArchive(clone, record.base_commit, join(dir, "src.tmp"), log);
    else {
      await run("git", ["-c", "advice.detachedHead=false", "checkout", "-q", record.base_commit], clone, log);
      await network(() => run("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], clone, log, { timeoutMs: 1_800_000 }));
      modules = execFileSync("git", ["submodule", "status", "--recursive"], { cwd: clone }).toString().trim().split("\n").filter(Boolean).map(line => line.trim());
      await cp(clone, join(dir, "src.tmp"), { recursive: true, filter: path => !/\/\.git$/.test(path) });
      await writeFile(join(dir, "submodules.json"), `${JSON.stringify(modules, null, 2)}\n`);
    }
    await rename(join(dir, "src.tmp"), join(dir, "src"));
  } finally { await removeTree(clone); }
  return modules;
}

const NOT_PACKAGES = /^(tests?|testing|docs?|examples?|benchmarks?|scripts?|tools|ci|build|dist)$/i;

/** Top-level importable names (packages, namespace packages, modules) the installed distributions put into site-packages. */
export function installedTopNames(site: string): Set<string> {
  const names = new Set<string>();
  for (const dist of readdirSync(site).filter(name => name.endsWith(".dist-info"))) {
    const recordFile = join(site, dist, "RECORD");
    if (!existsSync(recordFile)) continue;
    for (const line of readFileSync(recordFile, "utf8").split("\n")) {
      const path = line.split(",")[0] ?? "";
      if (!path || path.startsWith("..") || path.includes(".dist-info/") || path.includes(".data/")) continue;
      const top = path.split("/")[0]!;
      if (!path.includes("/") && !top.endsWith(".py")) continue;
      const name = top.endsWith(".py") ? top.slice(0, -3) : top;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== "__pycache__") names.add(name);
    }
  }
  return names;
}
const presentIn = (root: string, name: string): boolean => existsSync(join(root, `${name}.py`)) || (existsSync(join(root, name)) && statSync(join(root, name)).isDirectory());
/** The snapshot's import root: `src` when it holds more of the installed top-level names than the snapshot root, else `.`. */
export function layoutOf(src: string, names: ReadonlySet<string>): string {
  if (!existsSync(join(src, "src")) || !statSync(join(src, "src")).isDirectory()) return ".";
  const count = (root: string) => [...names].filter(name => presentIn(root, name)).length;
  const atRoot = count(src), atSrc = count(join(src, "src"));
  return atSrc > atRoot ? "src" : atRoot > atSrc ? "." : sweLayout(src);
}
/**
 * Top-level importable names from the snapshot's layout dir: those the installed distributions put into site-packages (namespace
 * packages included); for a project that is not installed as a package (an application run from its tree), its top-level packages.
 */
function snapshotModules(names: ReadonlySet<string>, layoutRoot: string): string[] {
  const found = new Set([...names].filter(name => presentIn(layoutRoot, name)));
  if (!found.size) for (const entry of readdirSync(layoutRoot, { withFileTypes: true })) if (entry.isDirectory() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) && !NOT_PACKAGES.test(entry.name) && existsSync(join(layoutRoot, entry.name, "__init__.py"))) found.add(entry.name);
  return [...found].sort();
}

/** Copy the .py files the build generated inside the package (absent from the snapshot) into the snapshot; returns them. */
async function copyGenerated(site: string, src: string, layout: string): Promise<string[]> {
  const generated: string[] = [];
  for (const dist of readdirSync(site).filter(name => name.endsWith(".dist-info"))) {
    const recordFile = join(site, dist, "RECORD");
    if (!existsSync(recordFile)) continue;
    for (const line of readFileSync(recordFile, "utf8").split("\n")) {
      const path = line.split(",")[0] ?? "";
      if (!path || path.includes(".dist-info/") || path.startsWith("..") || !path.endsWith(".py")) continue;
      const top = path.split("/")[0]!;
      if (!existsSync(join(src, layout, top)) || existsSync(join(src, layout, path))) continue;
      await mkdir(dirname(join(src, layout, path)), { recursive: true });
      await cp(join(site, path), join(src, layout, path));
      generated.push(join(layout, path));
    }
  }
  return generated.sort();
}

function licensesOf(src: string): { file: string; firstLine: string }[] {
  return readdirSync(src).filter(name => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(name) && statSync(join(src, name)).isFile()).sort().map(file => ({ file, firstLine: (readFileSync(join(src, file), "utf8").split("\n").find(line => line.trim()) ?? "").trim().slice(0, 120) }));
}

/** Build (or reuse) the environment of one record; never throws for a build failure (the manifest says why). */
export async function buildEnv(record: RawRecord, roots: CacheRoots, manifestPath: string, log: Log): Promise<EnvManifest> {
  const started = Date.now();
  const dir = caseDir(roots, record.instance_id);
  await mkdir(dir, { recursive: true });
  const manifest: EnvManifest = { id: record.instance_id, status: "failed", at: new Date().toISOString(), ms: 0, repo: record.repo, baseCommit: record.base_commit, createdAt: record.created_at, datasetPython: record.install_config?.python, testCmd: record.install_config?.test_cmd };
  const save = async () => { manifest.ms = Date.now() - started; await mkdir(dirname(manifestPath), { recursive: true }); await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); };
  let step = "plan";
  try {
    const install = String(record.install_config?.install ?? "");
    const pythonRequest = String(record.install_config?.python ?? "");
    if (!/^3\.\d+$/.test(pythonRequest)) throw new Error(`dataset python ${JSON.stringify(pythonRequest)} is not a CPython 3.x minor version`);
    const excludeNewer = `${excludeNewerOf(record.created_at)}T00:00:00Z`;
    manifest.excludeNewer = excludeNewer;
    const venv = join(dir, "venv");
    const plan = installPlan(install, join(venv, "bin/python"), excludeNewer);
    manifest.install = { dataset: install, steps: plan.ok ? plan.steps : [] };
    if (!plan.ok) throw new Error(plan.reason);
    const uvEnv = { ...process.env, UV_CACHE_DIR: uvCacheDir(roots), UV_PYTHON_INSTALL_DIR: pythonInstallDir(roots), UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1", ...VERSION_BYPASS };
    manifest.uv = execFileSync(UV, ["--version"]).toString().trim();
    step = "fetch";
    manifest.submodules = await fetchSource(record, dir, log, plan.steps.some(item => item.kind === "submodules"));
    step = "python";
    await run(UV, ["python", "install", pythonRequest], dir, log, { env: uvEnv, timeoutMs: 600_000 });
    // The exact patch-version install (not the minor-version link a later install could move).
    const executable = realpathSync(execFileSync(UV, ["python", "find", pythonRequest], { env: uvEnv }).toString().trim());
    const version = execFileSync(executable, ["-c", "import sys,platform;print(platform.python_version())"]).toString().trim();
    manifest.python = { request: pythonRequest, version, executable, sha256: fileSha256(executable), installDir: pythonInstallDir(roots) };
    if (!existsSync(join(venv, ".ready"))) {
      step = "venv";
      if (existsSync(venv)) { execFileSync("chmod", ["-R", "u+w", venv]); await removeTree(venv); }
      await run(UV, ["venv", "--python", executable, venv], dir, log, { env: uvEnv });
      step = "install";
      const build = await mkdtemp(join(roots.scratch, `build-${record.instance_id}-`));
      try {
        await cp(join(dir, "src"), build, { recursive: true });
        for (const item of plan.steps) {
          if (item.kind === "submodules") continue; // fetched with the source
          let argv = item.argv;
          // uv sync: the project's lock when it has one (exact versions), else resolved as of the record's date.
          if (item.kind === "uv-sync" && !existsSync(join(build, "uv.lock"))) argv = [...argv.filter(word => word !== "--frozen"), "--exclude-newer", excludeNewer];
          for (let attempt = 0; ; attempt++) {
            try { await run(UV, argv.slice(1), build, log, { env: { ...uvEnv, VIRTUAL_ENV: venv, UV_PROJECT_ENVIRONMENT: venv }, timeoutMs: 1_800_000 }); break; } catch (error) {
              if (attempt < NETWORK_RETRIES && isNetworkFailure(describe(error))) continue;
              throw error;
            }
          }
        }
      } finally { await removeTree(build); }
      step = "generated-files";
      const site = execFileSync(join(venv, "bin/python"), ["-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"]).toString().trim();
      const layout = layoutOf(join(dir, "src"), installedTopNames(site));
      manifest.generatedFiles = await copyGenerated(site, join(dir, "src"), layout);
      await writeFile(join(dir, "generated-files.json"), `${JSON.stringify({ layout, files: manifest.generatedFiles }, null, 2)}\n`);
      step = "seal";
      execFileSync("chmod", ["-R", "a-w", venv]);
      execFileSync("chmod", ["u+w", venv]);
      await writeFile(join(venv, ".ready"), new Date().toISOString());
      execFileSync("chmod", ["u-w", venv]);
    } else {
      const previous = existsSync(join(dir, "generated-files.json")) ? JSON.parse(readFileSync(join(dir, "generated-files.json"), "utf8")) : { files: [] };
      manifest.generatedFiles = previous.files;
    }
    step = "import-check";
    const site = execFileSync(join(venv, "bin/python"), ["-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"]).toString().trim();
    const names = installedTopNames(site);
    const layout = layoutOf(join(dir, "src"), names);
    manifest.pythonPath = layout;
    const modules = snapshotModules(names, layout === "." ? join(dir, "src") : join(dir, "src", layout));
    manifest.importCheck = { modules, files: {}, ok: false };
    if (!modules.length) throw new Error("no installed top-level module exists in the snapshot (nothing imports from source)");
    const check = await importCheck(venv, manifest.python.installDir, join(dir, "src"), layout, modules, roots.scratch);
    manifest.importCheck = { modules, files: check.files, ok: check.ok, ...(check.ok ? {} : { output: check.output }) };
    if (!check.ok) throw new Error(`the package does not import from the snapshot: ${check.output.slice(-1500)}`);
    step = "manifest";
    manifest.freeze = execFileSync(UV, ["pip", "freeze", "--python", join(venv, "bin/python")], { env: uvEnv }).toString().trim().split("\n").filter(Boolean);
    manifest.srcDigest = treeDigest(join(dir, "src"));
    manifest.venvDigest = dirDigest(venv);
    manifest.licenses = licensesOf(join(dir, "src"));
    manifest.status = "built";
    delete manifest.step;
  } catch (error) {
    manifest.status = "failed"; manifest.step = step; manifest.reason = `${step}: ${describe(error)}`;
  }
  await save();
  return manifest;
}

/** Common sandbox pieces of a Python run against a tree: binds and environment (no network; HOME/TMPDIR private). */
export function pythonSandbox(input: { venv: string; pythonInstallDir: string; tree: string; layout: string; work: string; treeWritable?: boolean }): { binds: Bind[]; env: Record<string, string>; bin: string } {
  const bin = join(input.work, "bin"), home = join(input.work, "home"), tmp = join(input.work, "tmp");
  const root = input.layout === "." ? input.tree : join(input.tree, input.layout);
  const binds: Bind[] = [{ from: input.venv }, { from: input.pythonInstallDir }, { from: input.tree, rw: input.treeWritable === true }, { from: bin }, { from: home, rw: true }, { from: tmp, rw: true }];
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", PYTHONNOUSERSITE: "1", TZ: "UTC" };
  return { binds, env, bin };
}

async function writeWrappers(bin: string, venv: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  for (const name of ["python", "python3"]) await writeFile(join(bin, name), `#!/bin/sh\nexec '${venv}/bin/python' "$@"\n`, { mode: 0o755 });
  await writeFile(join(bin, "pytest"), `#!/bin/sh\nexec '${venv}/bin/python' -m pytest "$@"\n`, { mode: 0o755 });
}

/** E1's import check: every snapshot module imports from the snapshot (sandboxed, no network). */
export async function importCheck(venv: string, pythonDir: string, src: string, layout: string, modules: string[], scratch: string): Promise<{ ok: boolean; files: Record<string, string>; output: string }> {
  const work = await mkdtemp(join(scratch, "import-"));
  try {
    const box = pythonSandbox({ venv, pythonInstallDir: pythonDir, tree: src, layout, work });
    for (const path of [join(work, "home"), join(work, "tmp")]) await mkdir(path, { recursive: true });
    await writeWrappers(box.bin, venv);
    // A namespace package has no __file__ (and may span site-packages too): its sub-packages that the snapshot holds must import
    // from the snapshot.
    const code = `import importlib, json, os, sys\nroot = os.path.realpath(${JSON.stringify(layout === "." ? src : join(src, layout))})\nout = {}\nok = True\ndef check(name):\n    module = importlib.import_module(name)\n    file = getattr(module, "__file__", None)\n    if file:\n        return os.path.realpath(file), os.path.realpath(file).startswith(root + os.sep)\n    local = os.path.join(root, *name.split("."))\n    subs = sorted(entry for entry in os.listdir(local) if os.path.isfile(os.path.join(local, entry, "__init__.py"))) if os.path.isdir(local) else []\n    results = {f"{name}.{sub}": check(f"{name}.{sub}") for sub in subs}\n    return results, bool(subs) and all(value[1] for value in results.values())\nfor name in ${JSON.stringify(modules)}:\n    try:\n        where, good = check(name)\n        out[name] = where\n        ok = ok and good\n    except BaseException as exc:\n        out[name] = f"ERROR {type(exc).__name__}: {exc}"[:400]\n        ok = False\nprint("IMPORT_CHECK " + json.dumps({"ok": ok, "files": out}))\n`;
    const result = await runSandboxed({ binds: box.binds, env: box.env, cwd: join(work, "tmp"), command: [join(venv, "bin/python"), "-c", code] }, { guardMs: 300_000 });
    const line = result.text.split("\n").reverse().find(text => text.startsWith("IMPORT_CHECK "));
    if (!line) return { ok: false, files: {}, output: tail(result.text) };
    const parsed = JSON.parse(line.slice("IMPORT_CHECK ".length));
    return { ok: parsed.ok === true && result.code === 0, files: parsed.files, output: tail(result.text) };
  } finally { await removeTree(work); }
}

export interface TestRun { exit: number | null; guardFired: boolean; ms: number; statuses: Record<string, string>; tail: string }
/** The dataset's test command in a writable copy (`tree`), sandboxed without network; statuses by pytest node id. */
export async function runTests(input: { venv: string; pythonDir: string; tree: string; layout: string; testCmd: string; scratch: string; guardMs?: number }): Promise<TestRun> {
  const work = await mkdtemp(join(input.scratch, "tests-"));
  try {
    const box = pythonSandbox({ venv: input.venv, pythonInstallDir: input.pythonDir, tree: input.tree, layout: input.layout, work, treeWritable: true });
    for (const path of [join(work, "home"), join(work, "tmp")]) await mkdir(path, { recursive: true });
    await writeWrappers(box.bin, input.venv);
    const result = await runSandboxed({ binds: box.binds, env: box.env, cwd: input.tree, command: ["/bin/bash", "-c", input.testCmd] }, { guardMs: input.guardMs ?? 1_200_000, keep: 8 * 1024 * 1024 });
    return { exit: result.code, guardFired: result.guardFired, ms: result.ms, statuses: Object.fromEntries(parseStatuses(result.text)), tail: result.text.slice(-4000) };
  } finally { await removeTree(work); }
}

/** Status of each listed test id in a run (dataset ids may be cut at a space: prefix match, as the earlier harnesses do). */
export function statusesOf(run: TestRun, ids: readonly string[]): Record<string, string> {
  const map = new Map(Object.entries(run.statuses));
  return Object.fromEntries(ids.map(id => [id, matchStatus(map, id)]));
}

export const digestText = (text: string): string => sha256(text);
