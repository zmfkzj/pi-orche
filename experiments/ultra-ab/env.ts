/**
 * Environment of the ultra-vs-single study (experiments/ultra-ab): the frozen orche runtime, task workspaces, Python wrappers that
 * follow the current directory (so ultra's candidate copies import their own code), the private agent dir of a run and the
 * independent grader (original tests and runner config restored, hidden tests added, integrity checked).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SUITE_DIR, SWE_CACHE, SWE_DIR, readable } from "../advisor-reviewer/tasks.js";
import { MODEL, MODEL_REF, THINKING, integrity, isRunnerConfig, isTestFile, orcheConfig, statusOf, type Integrity, type TaskSpec } from "./protocol.js";

export const REPO = process.env.ULTRA_AB_REPO ?? new URL("../../", import.meta.url).pathname;
export const AGENT = join(homedir(), ".pi/agent");
export const PROVIDER_EXTENSION = join(AGENT, "npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/index.ts");
export const UPSTREAM = "http://127.0.0.1:8317";

export interface Task extends TaskSpec { dir: string; source: string; manifest: any }

/** A suite (fixtures/suite) or SWE (fixtures/advisor-bench/swe) task; `source` is the pristine initial snapshot. */
export async function loadTask(id: string): Promise<Task> {
  if (existsSync(join(SWE_DIR, id, "task.json"))) {
    const dir = join(SWE_DIR, id);
    const manifest = JSON.parse(await readFile(join(dir, "task.json"), "utf8"));
    if (!manifest.validation?.valid) throw new Error(`${id}: not validated`);
    if (!existsSync(join(SWE_CACHE, id, "venv/.ready"))) throw new Error(`${id}: no prepared environment in ${SWE_CACHE}`);
    return { id, kind: "swe", title: manifest.title, instruction: sweInstruction(manifest), dir, source: join(SWE_CACHE, id, "src"), manifest };
  }
  const dir = join(SUITE_DIR, id);
  const manifest = JSON.parse(await readFile(join(dir, "task.json"), "utf8"));
  const grading = manifest.grading ?? {};
  if (grading.rubric || grading.custom || grading.mustNotModify || !grading.hiddenTests) throw new Error(`${id}: only suite tasks graded by visible + hidden tests are eligible`);
  return { id, kind: "suite", title: manifest.title, instruction: manifest.instruction, dir, source: join(dir, "repo"), manifest };
}

export function sweInstruction(manifest: { problemStatement: string; interface?: string }): string {
  return [
    "Resolve the GitHub issue below in this repository (a snapshot of the project at the time of the issue, without git history). Hidden tests written by the maintainers will check the fix; the existing tests must keep passing.",
    "Python environment: `python` and `pytest` on PATH run the code of the project you are in (the nearest directory with pyproject.toml/setup.py/setup.cfg above the current directory) with the project's dependencies preinstalled (read-only; no pip, no network).",
    "",
    "## Issue",
    manifest.problemStatement.trim(),
    ...(manifest.interface?.trim() ? ["", manifest.interface.trim()] : []),
  ].join("\n");
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const SKIP_COPY = /\/(\.git|\.orche|node_modules|__pycache__|\.pytest_cache|\.bench-bin)$/;

/** A fresh workspace with only the visible files, committed as the starting state. */
export async function prepareWorkspace(task: Task, parent: string): Promise<string> {
  const dir = await mkdtemp(join(parent, "ws-"));
  await cp(task.source, dir, { recursive: true, filter: path => !path.endsWith("/.git") });
  for (const args of [["init", "--quiet"], ["add", "--force", "."], ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Starting state"]]) git(dir, args);
  return dir;
}

/**
 * `python`, `python3`, `pytest` wrappers in `binDir` that run the task's read-only virtualenv with the CURRENT project first on
 * sys.path: the nearest ancestor of $PWD that holds one of the project's root anchors (pyproject.toml / setup.py / setup.cfg when
 * the snapshot root has them, else every regular file of the snapshot root; an ultra candidate copy is such a project), else
 * `fallbackRoot`. A `pip` that refuses.
 */
export function rootAnchors(source: string): string[] {
  const files = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).filter(name => /^[A-Za-z0-9._-]+$/.test(name)).sort();
  const standard = files.filter(name => ["pyproject.toml", "setup.py", "setup.cfg"].includes(name));
  return standard.length ? standard : files;
}

export async function pythonWrappers(task: { id: string; source: string; manifest: { pythonPath?: string } }, fallbackRoot: string, binDir: string): Promise<void> {
  const venv = join(SWE_CACHE, task.id, "venv");
  const sub = task.manifest.pythonPath && task.manifest.pythonPath !== "." ? `/${task.manifest.pythonPath}` : "";
  await mkdir(binDir, { recursive: true });
  const python = [
    "#!/bin/sh",
    'root="$PWD"',
    `anchored() { for f in ${rootAnchors(task.source).join(" ")}; do [ -e "$1/$f" ] && return 0; done; return 1; }`,
    'while [ "$root" != "/" ] && ! anchored "$root"; do root=$(dirname "$root"); done',
    `[ "$root" = "/" ] && root='${fallbackRoot}'`,
    `export PYTHONPATH="$root${sub}\${PYTHONPATH:+:$PYTHONPATH}"`,
    "export PYTHONDONTWRITEBYTECODE=1",
    `exec '${venv}/bin/python' "$@"`,
    "",
  ].join("\n");
  for (const name of ["python", "python3"]) await writeFile(join(binDir, name), python);
  await writeFile(join(binDir, "pytest"), `#!/bin/sh\nexec '${join(binDir, "python")}' -m pytest "$@"\n`);
  await writeFile(join(binDir, "pip"), "#!/bin/sh\necho \"pip is disabled in this environment: dependencies are preinstalled and there is no network.\" >&2\nexit 1\n");
  for (const name of ["python", "python3", "pytest", "pip"]) await chmod(join(binDir, name), 0o755);
}

/** The private agent dir of one run: provider catalog and connection (base URL = this run's proxy), settings, orche config. */
export async function overlay(dir: string, proxyUrl: string, options: { orche: boolean }): Promise<{ apiKey: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(dir, name));
  const connection = JSON.parse(await readFile(join(AGENT, "cliproxyapi.json"), "utf8"));
  await writeFile(join(dir, "cliproxyapi.json"), JSON.stringify({ ...connection, baseUrl: proxyUrl }), { mode: 0o600 });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: THINKING.main, quietStartup: true, transport: "sse" }, null, 2));
  if (options.orche) await writeFile(join(dir, "orche.config.json"), JSON.stringify(orcheConfig(), null, 2));
  await symlink(join(AGENT, "npm"), join(dir, "npm"), "dir");
  return { apiKey: String(connection.apiKey ?? "") };
}

/** Environment of a Pi child process: private agent/session/temp dirs, the run's proxy, no inherited Pi session variables. */
export function piEnv(base: NodeJS.ProcessEnv, agentDir: string, sessionDir: string, temp: string, proxyUrl: string, apiKey: string, pathPrefix?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of Object.keys(env)) if (/^(PI_|CLIPROXYAPI_|ORCHE_)/.test(name)) delete env[name];
  return {
    ...env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, TMPDIR: temp, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    CLIPROXYAPI_BASE_URL: proxyUrl, CLIPROXYAPI_API_KEY: apiKey, CLIPROXYAPI_FAST: "0",
    ...(pathPrefix ? { PATH: `${pathPrefix}:${base.PATH ?? ""}` } : {}),
  };
}

export const piArgs = (runtime: string | undefined, thinking: string, extra: string[]): string[] => [
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "-e", PROVIDER_EXTENSION,
  ...(runtime ? ["-e", join(runtime, "src/extension/index.ts")] : []), "--model", MODEL_REF, "--thinking", thinking, ...extra,
];

// ---------------------------------------------------------------------------------------------------------------------------
// Frozen runtime

/**
 * Freeze orche as it is in the working tree NOW (HEAD plus the uncommitted product changes): src/, package.json, tsconfig.json are
 * copied into <out>/rt with node_modules linked; REVISION records HEAD, the dirty list and a digest of every copied file. A later
 * launch with a different tree is refused (use a fresh out directory).
 */
export async function freezeRuntime(out: string): Promise<{ dir: string; digest: string }> {
  const rt = join(out, "rt");
  const files = git(REPO, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "package.json", "tsconfig.json"]).split("\n").filter(Boolean).filter(path => existsSync(join(REPO, path))).sort();
  const hash = createHash("sha256");
  const perFile: Record<string, string> = {};
  for (const path of files) { const sha = createHash("sha256").update(readFileSync(join(REPO, path))).digest("hex"); perFile[path] = sha; hash.update(`${path}\0${sha}\n`); }
  const digest = hash.digest("hex");
  if (existsSync(join(rt, "REVISION.json"))) {
    const existing = JSON.parse(readFileSync(join(rt, "REVISION.json"), "utf8"));
    if (existing.digest !== digest) throw new Error(`Runtime ${rt} was frozen from a different tree (${existing.digest.slice(0, 12)} vs now ${digest.slice(0, 12)}): runs keep using the frozen copy; pass --reuse-frozen or use a fresh out directory`);
    return { dir: rt, digest };
  }
  await mkdir(rt, { recursive: true });
  for (const path of files) { await mkdir(join(rt, path, ".."), { recursive: true }); await copyFile(join(REPO, path), join(rt, path)); }
  await symlink(join(REPO, "node_modules"), join(rt, "node_modules"), "dir");
  const head = git(REPO, ["rev-parse", "HEAD"]).trim();
  const dirty = git(REPO, ["status", "--porcelain=v1"]).split("\n").filter(Boolean);
  await writeFile(join(rt, "REVISION.json"), JSON.stringify({ head, dirty, digest, files: perFile, frozenAt: new Date().toISOString() }, null, 2));
  return { dir: rt, digest };
}

/** Use an existing frozen runtime as is (resume after the working tree moved on). */
export function frozenRuntime(out: string): { dir: string; digest: string } {
  const rt = join(out, "rt");
  return { dir: rt, digest: JSON.parse(readFileSync(join(rt, "REVISION.json"), "utf8")).digest };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Grading

/** Relevant text files of a tree (tests and runner configs), relative paths. */
export function protectedFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (SKIP_COPY.test(path) || entry.name === ".venv" || entry.name === "venv") continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const rel = relative(root, path);
      if (!isTestFile(rel) && !isRunnerConfig(rel)) continue;
      try { if (statSync(path).size <= 4 * 1024 * 1024) out.set(rel, readFileSync(path, "utf8")); } catch { /* unreadable: absent */ }
    }
  };
  walk(root);
  return out;
}

export interface Grade { passed: boolean; error?: string; checks: Record<string, { passed: boolean; detail: string }> }

interface Exec { code: number | null; signal: NodeJS.Signals | null; text: string; timedOut: boolean }
export function execIn(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Exec> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    const add = (chunk: Buffer) => { if (text.length < 32 * 1024 * 1024) text += String(chunk); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, text, timedOut }); });
    child.once("error", error => { clearTimeout(timer); resolve({ code: -1, signal: null, text: String(error), timedOut }); });
  });
}

/** node --test TAP result: passed only for exit 0, no failure, at least one passing test. */
export function tapVerdict(run: Exec): { passed: boolean; detail: string } {
  const pass = Number(/^# pass (\d+)/m.exec(run.text)?.[1] ?? 0), fail = Number(/^# fail (\d+)/m.exec(run.text)?.[1] ?? -1);
  const passed = run.code === 0 && !run.timedOut && fail === 0 && pass > 0;
  return { passed, detail: `exit ${run.code}${run.signal ? ` ${run.signal}` : ""}${run.timedOut ? " TIMEOUT" : ""}, pass ${pass}, fail ${fail}${passed ? "" : `\n${run.text.split("\n").filter(line => /^not ok|^# |Error|error/.test(line)).slice(0, 40).join("\n")}`}` };
}

const testFilesOf = (root: string): string[] => {
  const out: string[] = [];
  // The suite's own rule (src/eval/suite.ts testFiles): *.test|spec.{js,cjs,mjs,ts,...} outside .git/node_modules.
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.name === ".git" || entry.name === "node_modules") continue; const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile() && /\.(?:test|spec)\.(?:[cm]?js|[cm]?ts)$/.test(entry.name)) out.push(relative(root, path)); } };
  walk(root);
  return out.sort();
};

/** A grading copy of a final workspace: original tests and runner configs restored, new runner files removed. */
async function gradingCopy(task: Task, workspace: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "ultra-ab-grade-"));
  await cp(workspace, copy, { recursive: true, filter: path => !SKIP_COPY.test(path) && readable(path) });
  for (const [rel, text] of protectedFiles(task.source)) { await mkdir(join(copy, rel, ".."), { recursive: true }); await writeFile(join(copy, rel), text); }
  for (const rel of protectedFiles(copy).keys()) {
    const name = rel.split("/").at(-1)!;
    if (!existsSync(join(task.source, rel)) && ["conftest.py", "pytest.ini", ".pytest.ini", "tox.ini"].includes(name)) await rm(join(copy, rel), { force: true });
  }
  return copy;
}

/** Independent grade of a final workspace (never any model): original visible tests + hidden tests on a restored copy. */
export async function gradeWorkspace(task: Task, workspace: string): Promise<{ grade: Grade; integrity: Integrity }> {
  const check = integrity(protectedFiles(task.source), protectedFiles(workspace));
  const checks: Grade["checks"] = {};
  try {
    if (task.kind === "suite") {
      const visible = testFilesOf(task.source);
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
      const v = await gradingCopy(task, workspace);
      try { checks.visibleTests = visible.length ? tapVerdict(await execIn(process.execPath, ["--test", "--test-reporter=tap", ...visible], v, env, 300_000)) : { passed: true, detail: "no visible test files" }; } finally { await rm(v, { recursive: true, force: true }); }
      const h = await gradingCopy(task, workspace);
      try {
        const hiddenRoot = join(task.dir, "hidden");
        const hidden = testFilesOf(hiddenRoot);
        if (!hidden.length) throw new Error("no hidden test files");
        await cp(hiddenRoot, h, { recursive: true });
        checks.hiddenTests = tapVerdict(await execIn(process.execPath, ["--test", "--test-reporter=tap", ...hidden], h, env, 300_000));
      } finally { await rm(h, { recursive: true, force: true }); }
    } else {
      const copy = await gradingCopy(task, workspace);
      try {
        const patchFile = join(task.dir, "hidden/test.patch");
        const patch = await readFile(patchFile, "utf8");
        for (const file of [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]!)) {
          const original = join(task.source, file);
          if (existsSync(original)) { await mkdir(join(copy, file, ".."), { recursive: true }); await cp(original, join(copy, file)); } else await rm(join(copy, file), { force: true });
        }
        try { execFileSync("git", ["apply", "--whitespace=nowarn", patchFile], { cwd: copy, stdio: ["ignore", "pipe", "pipe"] }); }
        catch (error) { return { grade: { passed: false, error: `hidden test patch does not apply: ${String(error).slice(0, 500)}`, checks }, integrity: check }; }
        const bin = join(copy, ".bench-bin");
        await pythonWrappers(task, copy, bin);
        const command = String(task.manifest.testCmd).replace(/^pytest\b/, `'${join(bin, "pytest")}'`);
        const run = await execIn("bash", ["-c", command], copy, { ...process.env, PATH: `${bin}:${process.env.PATH}`, PYTHONHASHSEED: "0" }, 900_000);
        const statuses = new Map<string, string>();
        for (const line of run.text.split("\n")) {
          const match = /^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S.*?)(?:\s+-\s+.*)?$/.exec(line.trim());
          if (match && match[2]!.includes("::")) statuses.set(match[2]!.trim(), match[1]!);
        }
        const excluded = new Set<string>(task.manifest.excludedPassToPass ?? []);
        const f2p = (task.manifest.failToPass as string[]).map(id => ({ id, status: statusOf(statuses, id) }));
        const p2pIds: string[] = Array.isArray(task.manifest.passToPass) ? task.manifest.passToPass : JSON.parse(String(task.manifest.passToPass).replace(/'/g, '"'));
        const p2p = p2pIds.filter(id => !excluded.has(id)).map(id => ({ id, status: statusOf(statuses, id) }));
        const abnormal = run.timedOut || run.signal !== null || run.code === null || run.code > 1;
        const bad = (items: { id: string; status: string }[]) => items.filter(item => item.status !== "PASSED");
        checks.failToPass = { passed: !bad(f2p).length, detail: `${f2p.length - bad(f2p).length}/${f2p.length} passed${bad(f2p).length ? `: ${bad(f2p).map(item => `${item.id} ${item.status}`).join("; ").slice(0, 1500)}` : ""}` };
        checks.passToPass = { passed: !bad(p2p).length, detail: `${p2p.length - bad(p2p).length}/${p2p.length} passed (${excluded.size} excluded)${bad(p2p).length ? `: ${bad(p2p).slice(0, 20).map(item => `${item.id} ${item.status}`).join("; ").slice(0, 1500)}` : ""}` };
        checks.runner = { passed: !abnormal, detail: `exit ${run.code}${run.signal ? ` ${run.signal}` : ""}${run.timedOut ? " TIMEOUT" : ""}${abnormal ? `\n${run.text.slice(-1500)}` : ""}` };
      } finally { await rm(copy, { recursive: true, force: true }); }
    }
  } catch (error) {
    return { grade: { passed: false, error: String(error instanceof Error ? error.message : error).slice(0, 1500), checks }, integrity: check };
  }
  const values = Object.values(checks);
  return { grade: { passed: values.length > 0 && values.every(item => item.passed), checks }, integrity: check };
}

/** Text files of a tree, for redaction after a run (skips large and binary files). */
export function textFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      try { const stat = lstatSync(path); if (stat.size > 0 && stat.size < 64 * 1024 * 1024) out.push(path); } catch { /* gone */ }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
