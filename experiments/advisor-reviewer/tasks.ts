/**
 * Candidate tasks of the advisor/reviewer benchmark and their workspaces and graders.
 * - `suite`: fixtures/suite/<id> (repo/ is the workspace; hidden/ tests and reference/ stay outside it), graded by the suite's own
 *   deterministic visible + hidden `node --test` checks (src/eval/suite.ts gradeTask; no rubric task is used).
 * - `lcb`: fixtures/advisor-bench/lcb/<id> (LiveCodeBench AtCoder problems imported by import-lcb.ts): public/ (problem.md,
 *   examples.json) is the workspace; hidden/tests.json (the full LiveCodeBench test set) grades solution.py by exact token comparison.
 * - `swe`: fixtures/advisor-bench/swe/<id> (SWE-rebench 2026 GitHub issues set up by setup-swe.ts): the workspace is the repository at
 *   the base commit (no history); the grader restores the test files of hidden/test.patch, applies it and requires every
 *   FAIL_TO_PASS test and every non-excluded PASS_TO_PASS test to pass (SWE-bench's criterion).
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readdirSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sameOutput, type TaskSpec } from "./protocol.js";

/** The repository (fixtures). The driver runs a frozen copy of this harness from the study directory and names the repository here. */
export const REPO = process.env.ADVISOR_BENCH_REPO ?? new URL("../../", import.meta.url).pathname;
export const SUITE_DIR = join(REPO, "fixtures/suite");
export const LCB_DIR = join(REPO, "fixtures/advisor-bench/lcb");
export const SWE_DIR = join(REPO, "fixtures/advisor-bench/swe");
/** Rebuilt by setup-swe.ts (source snapshots and virtualenvs); not tracked. */
export const SWE_CACHE = process.env.ADVISOR_BENCH_SWE_CACHE ?? join(REPO, "results/advisor-reviewer/cache/swe");

export interface Candidate extends TaskSpec { dir: string }

export async function loadCandidate(id: string): Promise<Candidate> {
  if (id.startsWith("lcb-")) {
    const dir = join(LCB_DIR, id);
    const manifest = JSON.parse(await readFile(join(dir, "task.json"), "utf8"));
    return { id, kind: "lcb", title: manifest.title ?? id, instruction: manifest.prompt, dir };
  }
  if (existsSync(join(SWE_DIR, id, "task.json"))) {
    const dir = join(SWE_DIR, id);
    const manifest = JSON.parse(await readFile(join(dir, "task.json"), "utf8"));
    if (!manifest.validation?.valid) throw new Error(`${id}: not validated by setup-swe.ts`);
    return { id, kind: "swe", title: manifest.title, instruction: sweInstruction(manifest), dir };
  }
  const dir = join(SUITE_DIR, id);
  const manifest = JSON.parse(await readFile(join(dir, "task.json"), "utf8"));
  if (manifest.grading?.rubric) throw new Error(`${id}: rubric-graded tasks are not deterministic; not usable here`);
  return { id, kind: "suite", title: manifest.title, instruction: manifest.instruction, dir };
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** A fresh workspace with only the visible files, committed as the starting state. */
export async function prepareWorkspace(task: Candidate, parent: string): Promise<string> {
  const dir = await mkdtemp(join(parent, "ws-"));
  const source = task.kind === "lcb" ? join(task.dir, "public") : task.kind === "swe" ? join(SWE_CACHE, task.id, "src") : join(task.dir, "repo");
  if (task.kind === "swe" && !existsSync(join(SWE_CACHE, task.id, "venv/.ready"))) throw new Error(`${task.id}: run setup-swe.ts first (no ${SWE_CACHE}/${task.id})`);
  await cp(source, dir, { recursive: true, filter: path => !path.endsWith("/.git") });
  for (const args of [["init", "--quiet"], ["add", "--force", "."], ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Starting state"]]) git(dir, args);
  return dir;
}

export interface TestVerdict { index: number; verdict: "AC" | "WA" | "TLE" | "RE"; ms: number; detail?: string }
export interface Grade { passed: boolean; /** The grader itself failed (not the solution): an infrastructure outcome. */ error?: string; checks: Record<string, { passed: boolean; detail: string }>; tests?: { total: number; passed: number; verdicts: Record<string, number>; failures: TestVerdict[] } }

function runPython(file: string, cwd: string, input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }> {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn("python3", [file], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", PYTHONHASHSEED: "0", PYTHONDONTWRITEBYTECODE: "1" } });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < 64 * 1024 * 1024) stdout += String(chunk); });
    child.stderr.on("data", chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.stdin.on("error", () => { /* the program may exit before reading everything */ });
    child.stdin.end(input);
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started), timedOut }); });
    child.once("error", error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error), ms: Math.round(performance.now() - started), timedOut }); });
  });
}

/** Per-test time limit of LiveCodeBench tasks (the prompt says "about 6 s per test"). */
export const LCB_TEST_MS = 6_000;

/** Grade solution.py of an LCB workspace against every hidden test (stops counting nothing early: all tests run). */
export async function gradeLcb(task: Candidate, workspace: string, options: { timeoutMs?: number; parallel?: number } = {}): Promise<Grade> {
  const tests: { input: string; output: string }[] = JSON.parse(await readFile(join(task.dir, "hidden/tests.json"), "utf8"));
  const solution = join(workspace, "solution.py");
  if (!(await stat(solution).catch(() => undefined))?.isFile()) return { passed: false, checks: { hiddenTests: { passed: false, detail: "solution.py missing" } }, tests: { total: tests.length, passed: 0, verdicts: { missing: tests.length }, failures: [] } };
  const sandbox = await mkdtemp(join(tmpdir(), "lcb-grade-"));
  try {
    await cp(solution, join(sandbox, "solution.py"));
    const results: TestVerdict[] = new Array(tests.length);
    let next = 0;
    const worker = async () => {
      while (next < tests.length) {
        const index = next++;
        const test = tests[index]!;
        const run = await runPython("solution.py", sandbox, test.input, options.timeoutMs ?? LCB_TEST_MS);
        const verdict = run.timedOut ? "TLE" : run.code !== 0 ? "RE" : sameOutput(run.stdout, test.output) ? "AC" : "WA";
        results[index] = { index, verdict, ms: run.ms, ...(verdict === "RE" ? { detail: run.stderr.slice(-300) } : verdict === "WA" ? { detail: `got ${run.stdout.slice(0, 80)} want ${test.output.slice(0, 80)}` } : {}) };
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.parallel ?? 1) }, worker));
    const verdicts: Record<string, number> = {};
    for (const result of results) verdicts[result.verdict] = (verdicts[result.verdict] ?? 0) + 1;
    const passedCount = verdicts.AC ?? 0;
    const failures = results.filter(result => result.verdict !== "AC");
    return {
      passed: passedCount === tests.length,
      checks: { hiddenTests: { passed: passedCount === tests.length, detail: `${passedCount}/${tests.length} AC ${JSON.stringify(verdicts)}` } },
      tests: { total: tests.length, passed: passedCount, verdicts, failures: failures.slice(0, 20) },
    };
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}

/** Grade a suite task with the suite's own deterministic checks (`gradeTask` of the runtime's src/eval/suite.ts). */
export async function gradeSuite(suite: { loadSuite(root?: string): Promise<any[]>; gradeTask(task: any, dir: string, answer: string, options: any): Promise<any> }, task: Candidate, workspace: string): Promise<Grade> {
  const all = await suite.loadSuite(SUITE_DIR);
  const spec = all.find(item => item.id === task.id);
  if (!spec) throw new Error(`Unknown suite task ${task.id}`);
  const judge = async () => { throw new Error("no rubric in this benchmark"); };
  const graded = await suite.gradeTask(spec, workspace, "", { judge, timeoutMs: 300_000 });
  const checks: Grade["checks"] = {};
  for (const [name, check] of Object.entries(graded.checks as Record<string, { passed: boolean; detail: string }>)) checks[name] = { passed: check.passed, detail: check.detail.slice(-4000) };
  return { passed: graded.passed, checks };
}

/** The worker's task text for a SWE-rebench issue (identical in every arm). */
export function sweInstruction(manifest: { problemStatement: string; interface?: string }): string {
  return [
    "Resolve the GitHub issue below in this repository (a snapshot of the project at the time of the issue, without git history). Hidden tests written by the maintainers will check the fix; the existing tests must keep passing.",
    "Python environment: `python` and `pytest` on PATH run this workspace's code with the project's dependencies preinstalled (read-only; no pip, no network).",
    "",
    "## Issue",
    manifest.problemStatement.trim(),
    ...(manifest.interface?.trim() ? ["", manifest.interface.trim()] : []),
  ].join("\n");
}

/** Where the package lives in a source tree: `src` for a src/ layout, otherwise the root. */
export function sweLayout(src: string): string {
  const inner = join(src, "src");
  if (existsSync(inner) && readdirSync(inner, { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(inner, entry.name, "__init__.py")))) return "src";
  return ".";
}

/**
 * `python`, `python3`, `pytest` wrappers in `binDir` that run the task's read-only virtualenv with `root` (its package dir) first on
 * sys.path, and a `pip` that refuses. Prepend `binDir` to PATH.
 */
export async function pythonWrappers(task: { id: string; pythonPath?: string }, root: string, binDir: string): Promise<void> {
  const venv = join(SWE_CACHE, task.id, "venv");
  const path = task.pythonPath && task.pythonPath !== "." ? join(root, task.pythonPath) : root;
  await mkdir(binDir, { recursive: true });
  const python = `#!/bin/sh\nexport PYTHONPATH="${path}\${PYTHONPATH:+:\$PYTHONPATH}"\nexport PYTHONDONTWRITEBYTECODE=1\nexec "${venv}/bin/python" "$@"\n`;
  for (const name of ["python", "python3"]) await writeFile(join(binDir, name), python);
  await writeFile(join(binDir, "pytest"), `#!/bin/sh\nexec "${join(binDir, "python")}" -m pytest "$@"\n`);
  await writeFile(join(binDir, "pip"), `#!/bin/sh\necho "pip is disabled in this environment: dependencies are preinstalled and there is no network." >&2\nexit 1\n`);
  for (const name of ["python", "python3", "pytest", "pip"]) await chmod(join(binDir, name), 0o755);
}

/** Run the task's test command in `dir` (wrappers in `binDir`); statuses by pytest node id from the `-rA` summary. */
export async function runSweTests(manifest: { id: string; testCmd: string; pythonPath?: string }, _cache: string, dir: string, binDir: string, timeoutMs = 900_000): Promise<{ statuses: Map<string, string>; exit: number | null; tail: string }> {
  await pythonWrappers(manifest, dir, binDir);
  const command = manifest.testCmd.replace(/^pytest\b/, `"${join(binDir, "pytest")}"`);
  const output = await new Promise<{ code: number | null; text: string }>(resolve => {
    const child = spawn("bash", ["-c", command], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PYTHONHASHSEED: "0" } });
    let text = "";
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on("data", chunk => { text += String(chunk); });
    child.stderr.on("data", chunk => { text += String(chunk); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, text }); });
  });
  const statuses = new Map<string, string>();
  for (const line of output.text.split("\n")) {
    const match = /^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S.*?)(?:\s+-\s+.*)?$/.exec(line.trim());
    if (match && match[2]!.includes("::")) statuses.set(match[2]!.trim(), match[1]!);
  }
  return { statuses, exit: output.code, tail: output.text.slice(-3000) };
}

export function matchStatus(statuses: Map<string, string>, id: string): string {
  if (statuses.has(id)) return statuses.get(id)!;
  // Dataset ids are cut at the first space of a parametrized id: match by prefix.
  for (const [name, value] of statuses) if (name.startsWith(id)) return value;
  return "MISSING";
}

/**
 * Copy filter: skip entries the grader cannot read (tests that manipulate permissions can leave such files behind in a workspace;
 * they are never part of a solution, and one of them must not abort the copy).
 */
export function readable(path: string): boolean {
  try { accessSync(path, constants.R_OK); return lstatSync(path).isDirectory() ? (accessSync(path, constants.X_OK), true) : true; } catch { return false; }
}

/** SWE-bench grading of a final workspace: original test files restored, hidden test.patch applied, FAIL_TO_PASS and PASS_TO_PASS checked. */
export async function gradeSwe(task: Candidate, workspace: string): Promise<Grade> {
  const manifest = JSON.parse(await readFile(join(task.dir, "task.json"), "utf8"));
  const copy = await mkdtemp(join(tmpdir(), "swe-grade-"));
  try {
    await cp(workspace, copy, { recursive: true, filter: path => !/\/(\.git|\.orche|__pycache__|\.pytest_cache)$/.test(path) && readable(path) });
    const patch = await readFile(join(task.dir, "hidden/test.patch"), "utf8");
    for (const file of [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]!)) {
      const original = join(SWE_CACHE, task.id, "src", file);
      if (existsSync(original)) await cp(original, join(copy, file)); else await rm(join(copy, file), { force: true });
    }
    execFileSync("git", ["apply", "--whitespace=nowarn", join(task.dir, "hidden/test.patch")], { cwd: copy, stdio: ["ignore", "pipe", "pipe"] });
    const result = await runSweTests(manifest, join(SWE_CACHE, task.id), copy, join(copy, ".bench-bin"));
    const excluded = new Set<string>(manifest.excludedPassToPass ?? []);
    const f2p = (manifest.failToPass as string[]).map(id => ({ id, status: matchStatus(result.statuses, id) }));
    const p2p = (manifest.passToPass as string[]).filter(id => !excluded.has(id)).map(id => ({ id, status: matchStatus(result.statuses, id) }));
    const f2pOk = f2p.every(item => item.status === "PASSED"), p2pOk = p2p.every(item => item.status === "PASSED");
    const failed = [...f2p, ...p2p].filter(item => item.status !== "PASSED");
    return {
      passed: f2pOk && p2pOk,
      checks: {
        failToPass: { passed: f2pOk, detail: `${f2p.filter(item => item.status === "PASSED").length}/${f2p.length} passed${f2pOk ? "" : `: ${f2p.filter(item => item.status !== "PASSED").map(item => `${item.id} ${item.status}`).join("; ").slice(0, 1500)}`}` },
        passToPass: { passed: p2pOk, detail: `${p2p.filter(item => item.status === "PASSED").length}/${p2p.length} passed (${excluded.size} excluded)${p2pOk ? "" : `: ${p2p.filter(item => item.status !== "PASSED").map(item => `${item.id} ${item.status}`).slice(0, 20).join("; ").slice(0, 1500)}`}` },
      },
      tests: { total: f2p.length + p2p.length, passed: f2p.length + p2p.length - failed.length, verdicts: Object.fromEntries([...new Set([...f2p, ...p2p].map(item => item.status))].map(status => [status, [...f2p, ...p2p].filter(item => item.status === status).length])), failures: [] },
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1500);
    // A hidden test patch that no longer applies means the solution rewrote those test files: that is the solution's failure.
    return { passed: false, ...(/git apply|patch/i.test(message) ? {} : { error: message }), checks: { hiddenTests: { passed: false, detail: `grading error: ${message}` } } };
  } finally { await rm(copy, { recursive: true, force: true }); }
}
