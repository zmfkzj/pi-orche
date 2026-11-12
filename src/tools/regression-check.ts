/**
 * `regression_check`: a deterministic comparison of the project's existing tests between the assignment's STARTING state and now,
 * for implement workers of the single workflow (docs/orchestrator.md, "Regression check").
 *
 * At the start of an implement assignment the workspace is captured as a git tree through a private index (the user's index,
 * worktree, stash and HEAD are untouched; src/orchestrator/candidate-workspace.ts). The tool runs one test command twice, in a
 * private checkout of that starting tree (made on first use, with the workspace's ignored dependency directories copied
 * privately) and in the workspace as it is now, with the same command, environment and relative directory. It parses per-test
 * results (pytest, node --test, vitest/jest, go test, cargo test) and classifies them:
 * - new failures: passed at the start, failed or errored now (regressions this assignment introduced);
 * - failing new tests: absent at the start, failing now;
 * - pre-existing failures: failing at the start and now (environment problems or earlier bugs, not this assignment's);
 * - fixed: failing at the start, passing now;
 * - disappeared / newly skipped: run at the start, absent or skipped now (a deleted, renamed, deselected or uncollected test is
 *   never counted as passing);
 * - reparametrized: a parametrized test whose parameter id changed between the runs (a timestamp or a docs line number in the id),
 *   paired one to one with a new id of the same test function in the same outcome class (passing or skipped with non-failing,
 *   failing with failing); reported, not counted as disappeared or as a failing new test. A failing pair is probably the same
 *   pre-existing failure, but the id change proves no identity: it makes an otherwise clean verdict inconclusive. A test that
 *   passed at the start never pairs with a failing new id: that stays a disappeared test plus a failing new test.
 * A run that stops early or filters its output (-x, --maxfail, a pipe) cannot tell a disappeared or new test from one the other
 * run never reached, and one run without any per-test result next to one with results is a parsing failure, not a mass
 * disappearance: both are inconclusive rather than regressions (a test that passed at the start and fails now still regresses).
 * Outputs are kept head and tail (the summary is at the end) when they exceed the cap.
 * The verdict is evidence for the worker, who still owns acceptance: nothing is gated, retried or reported on its behalf.
 * The command goes through the same guards and Bash safety review as a `bash` call (src/extension/workers.ts toolGuard).
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CandidateWorkspaces } from "../orchestrator/candidate-workspace.js";

export const REGRESSION_TOOL = "regression_check";
export type TestStatus = "passed" | "failed" | "error" | "skipped";
export interface ParsedRun { statuses: Map<string, TestStatus>; frameworks: string[] }

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const worse = (a: TestStatus | undefined, b: TestStatus): TestStatus => {
  const rank: Record<TestStatus, number> = { passed: 0, skipped: 1, failed: 2, error: 3 };
  return a === undefined || rank[b] > rank[a] ? b : a;
};

/**
 * Per-test results of one test run's output. Ids are runner-specific (pytest node ids, TAP/spec test paths joined with " > ",
 * `Package/TestName`, cargo test paths); the same runner on the same tests produces the same ids in both runs.
 */
export function parseTestOutput(output: string): ParsedRun {
  const statuses = new Map<string, TestStatus>();
  const frameworks = new Set<string>();
  const set = (id: string, status: TestStatus) => { const key = id.trim(); if (key) statuses.set(key, worse(statuses.get(key), status)); };
  const lines = output.replace(ANSI, "").split("\n");
  // node --test (spec reporter): indentation nests subtests; TAP: "ok N - name" / "not ok N - name" with "# Subtest:" nesting.
  const stack: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // pytest -rA / -rfE short summary and verbose lines.
    let match = /^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S+?)(?:\s+-\s.*)?$/.exec(line.trim());
    if (match && /::|\.py\b/.test(match[2]!)) {
      frameworks.add("pytest");
      const status = match[1] === "PASSED" || match[1] === "XFAIL" ? "passed" : match[1] === "SKIPPED" ? "skipped" : match[1] === "ERROR" ? "error" : "failed";
      set(match[2]!, status);
      continue;
    }
    match = /^(\S+?::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/.exec(line.trim());
    if (match) { frameworks.add("pytest"); set(match[1]!, match[2] === "PASSED" || match[2] === "XFAIL" ? "passed" : match[2] === "SKIPPED" ? "skipped" : match[2] === "ERROR" ? "error" : "failed"); continue; }
    match = /^_* ERROR collecting (\S+) _*$/.exec(line.trim());
    if (match) { frameworks.add("pytest"); set(`${match[1]} (collection)`, "error"); continue; }
    // node --test TAP.
    match = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (match) {
      frameworks.add("node-tap");
      const depth = Math.floor(match[1]!.length / 4);
      stack.length = depth;
      const id = [...stack, match[3]!].join(" > ");
      set(id, match[4] ? "skipped" : match[2] === "ok" ? "passed" : "failed");
      continue;
    }
    match = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (match) { const depth = Math.floor(match[1]!.length / 4); stack.length = depth; stack[depth] = match[2]!; continue; }
    // node --test spec reporter: "✔ name (1.2ms)" / "✖ name (1.2ms)" / "﹣ name # SKIP".
    match = /^(\s*)([✔✓√✖✗×﹣])\s+(.*?)(?:\s+\([\d.]+m?s\))?(?:\s+#\s*(SKIP|TODO).*)?$/.exec(line);
    if (match && !/^\s*(?:tests|suites|pass|fail)\b/.test(match[3]!)) {
      frameworks.add(/[✓√]/.test(match[2]!) ? "jest/vitest" : "node-spec");
      const depth = Math.floor(match[1]!.length / 2);
      const id = `${depth}:${match[3]!}`;
      set(id, match[4] || match[2] === "﹣" ? "skipped" : /[✔✓√]/.test(match[2]!) ? "passed" : "failed");
      continue;
    }
    // vitest/jest failure headers: "FAIL  path > suite > test" (the file summary "FAIL path" alone marks the file).
    match = /^\s*(?:FAIL|×)\s+(\S.*?)(?:\s+\d+ms)?$/.exec(line);
    if (match && /\.(?:[cm]?[jt]sx?)\b/.test(match[1]!)) { frameworks.add("jest/vitest"); set(match[1]!, "failed"); continue; }
    // go test -v.
    match = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(line);
    if (match) { frameworks.add("go"); set(match[2]!, match[1] === "PASS" ? "passed" : match[1] === "SKIP" ? "skipped" : "failed"); continue; }
    // cargo test.
    match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
    if (match) { frameworks.add("cargo"); set(match[1]!, match[2] === "ok" ? "passed" : match[2] === "ignored" ? "skipped" : "failed"); continue; }
  }
  return { statuses, frameworks: [...frameworks] };
}

export interface RunOutcome { code: number | null; signal: string | null; timedOut: boolean; ms: number; output: string }
export interface Comparison {
  newFailures: string[]; failingNewTests: string[]; preExisting: string[]; fixed: string[]; disappeared: string[]; newlySkipped: string[];
  reparametrized: string[];
  startCounts: Record<TestStatus, number>; nowCounts: Record<TestStatus, number>; parsed: boolean; frameworks: string[];
  /** Exactly one of the two runs produced per-test results. */
  oneSided: boolean;
}

const counts = (statuses: Map<string, TestStatus>): Record<TestStatus, number> => {
  const out: Record<TestStatus, number> = { passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const status of statuses.values()) out[status]++;
  return out;
};
const failing = (status: TestStatus | undefined) => status === "failed" || status === "error";

/** Marks a reparametrized pair failing at both ends (probably the same pre-existing failure, not proven: verdictOf). */
const FAILING_PAIR = " (failing at both)";
export function compareRuns(start: ParsedRun, now: ParsedRun): Comparison {
  const out: Comparison = {
    newFailures: [], failingNewTests: [], preExisting: [], fixed: [], disappeared: [], newlySkipped: [], reparametrized: [],
    startCounts: counts(start.statuses), nowCounts: counts(now.statuses), parsed: start.statuses.size > 0 || now.statuses.size > 0,
    frameworks: [...new Set([...start.frameworks, ...now.frameworks])], oneSided: (start.statuses.size > 0) !== (now.statuses.size > 0),
  };
  for (const [id, status] of now.statuses) {
    const before = start.statuses.get(id);
    if (failing(status)) {
      if (before === undefined) out.failingNewTests.push(id);
      else if (failing(before)) out.preExisting.push(id);
      else out.newFailures.push(id);
    } else if (status === "passed" && failing(before)) out.fixed.push(id);
    else if (status === "skipped" && before === "passed") out.newlySkipped.push(id);
  }
  // A parametrized id that changed (a timestamp, a line number of an edited docs file) pairs with a new id of the same test function
  // in the same outcome class: a non-failing start id with a non-failing new id, a failing start id with a failing new id (probably
  // the same pre-existing failure under a new id, flagged: verdictOf). A start id that passed never pairs with a failing new id.
  const base = (id: string) => /^(.*?)\[.*\]$/.exec(id)?.[1];
  const replacements = new Map<string, { ok: string[]; failing: string[] }>();
  for (const [id, status] of now.statuses) {
    const key = base(id);
    if (!key || start.statuses.has(id)) continue;
    const free = replacements.get(key) ?? { ok: [], failing: [] };
    (failing(status) ? free.failing : free.ok).push(id);
    replacements.set(key, free);
  }
  const paired = new Set<string>();
  for (const [id, status] of start.statuses) {
    if (now.statuses.has(id) || status === "skipped") continue;
    const key = base(id);
    const free = key === undefined ? undefined : replacements.get(key);
    const pool = free && (failing(status) ? free.failing : free.ok);
    const match = pool?.shift();
    if (match) { out.reparametrized.push(`${id} -> ${match}${failing(status) ? FAILING_PAIR : ""}`); paired.add(match); }
    else out.disappeared.push(id);
  }
  out.failingNewTests = out.failingNewTests.filter(id => !paired.has(id));
  for (const list of [out.newFailures, out.failingNewTests, out.preExisting, out.fixed, out.disappeared, out.newlySkipped, out.reparametrized]) list.sort();
  return out;
}

/** A command that stops at the first failure or filters its output: a test missing from one run may just not have been reached. */
export function partialCommand(command: string): boolean {
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, "");
  return /(?:^|\s)(?:-x|--exitfirst|--maxfail(?:=|\s)\S+|--bail|-failfast|--fail-fast)(?=\s|$)/.test(unquoted) || /(?:^|[^|])\|(?!\|)/.test(unquoted);
}

/**
 * "clean" only when nothing regressed, disappeared or got skipped and both runs ran normally with parseable results. A run that
 * was cut off, a one-sided parse and (for disappeared and failing new tests only) a partial command are inconclusive, never a
 * regression: a partial run may simply not have reached a test in the other run. A failing test paired with a failing start id
 * under a changed parameter id is probably the same pre-existing failure, but the pairing is no proof of identity: without other
 * findings the verdict is inconclusive (compare the two failures), not clean.
 */
export function verdictOf(comparison: Comparison, start: RunOutcome, now: RunOutcome, options: { partial?: boolean } = {}): "clean" | "regressions" | "inconclusive" {
  const abnormal = (run: RunOutcome) => run.timedOut || run.signal !== null;
  if (abnormal(start) || abnormal(now)) return "inconclusive";
  // A command that passed at the start and fails now regressed, whatever the parser read; without per-test results the exit codes
  // are all there is, and a failure at both ends cannot be split into old and new.
  if (now.code !== 0 && start.code === 0) return "regressions";
  if (comparison.oneSided) return "inconclusive";
  if (comparison.newFailures.length || comparison.newlySkipped.length) return "regressions";
  if (comparison.failingNewTests.length || comparison.disappeared.length) return options.partial ? "inconclusive" : "regressions";
  if (comparison.reparametrized.some(pair => pair.endsWith(FAILING_PAIR))) return "inconclusive";
  return comparison.parsed ? "clean" : start.code === 0 && now.code === 0 ? "clean" : "inconclusive";
}

const LIST_LIMIT = 25;
const list = (title: string, items: readonly string[]) => items.length ? `${title} (${items.length}): ${items.slice(0, LIST_LIMIT).join("; ")}${items.length > LIST_LIMIT ? `; … ${items.length - LIST_LIMIT} more` : ""}` : "";
const describe = (run: RunOutcome) => `exit ${run.code ?? "none"}${run.signal ? ` signal ${run.signal}` : ""}${run.timedOut ? " TIMED OUT" : ""}, ${Math.round(run.ms / 1000)}s`;

export function formatComparison(command: string, comparison: Comparison, start: RunOutcome, now: RunOutcome, verdict: ReturnType<typeof verdictOf>, files?: { start: string; now: string }, partial = false): string {
  const c = (value: Record<TestStatus, number>) => `${value.passed} passed, ${value.failed} failed, ${value.error} errors, ${value.skipped} skipped`;
  const head = verdict === "clean" ? "Regression check: no new failures against the starting state."
    : verdict === "regressions" ? "Regression check: REGRESSIONS against the starting state (fix them, or report them with the reason)."
    : "Regression check: INCONCLUSIVE (a run was cut off, per-test results could not be read from both runs, the command stops early or filters its output, or a failing test matches a failing start test only under a changed parameter id; compare the outputs yourself).";
  return [
    head,
    `Command: ${command}`,
    `Starting state: ${describe(start)}; ${c(comparison.startCounts)}.`,
    `Now: ${describe(now)}; ${c(comparison.nowCounts)}.${comparison.frameworks.length ? ` Parsed as ${comparison.frameworks.join(", ")}.` : " No per-test results recognized: compared exit codes only."}`,
    list("New failures (passed at the start)", comparison.newFailures),
    list("Failing tests that did not exist at the start", comparison.failingNewTests),
    list("Disappeared since the start (deleted, renamed, deselected or not collected; never counted as passing)", comparison.disappeared),
    list("Newly skipped (passed at the start)", comparison.newlySkipped),
    list("Pre-existing failures (failing at the start too: environment or earlier bugs, not introduced by this assignment)", comparison.preExisting),
    list("Fixed (failing at the start, passing now)", comparison.fixed),
    list("Reparametrized (parameter id changed, matched to a new id of the same test with the same outcome)", comparison.reparametrized),
    comparison.oneSided ? `Per-test results were read from only one run (${comparison.startCounts.passed + comparison.startCounts.failed + comparison.startCounts.error + comparison.startCounts.skipped ? "the starting state" : "now"}): the other output has none, so the runs were not compared test by test.` : "",
    partial ? "The command stops at the first failure or filters its output: a test missing from one run, or new in it, may not have been reached by the other. Run the plain test command for a complete comparison." : "",
    files ? `Full outputs: ${files.start} (starting state), ${files.now} (now).` : "",
  ].filter(Boolean).join("\n");
}

const HEAD_CHARS = 4 * 1024 * 1024, TAIL_CHARS = 8 * 1024 * 1024;
/** One command in one directory: bash -c, its own process group, bounded output kept in memory, a hard timeout. */
export function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<RunOutcome> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    // Bounded: the first 4 MB and the last 8 MB (runner summaries come at the end), with the omitted character count between them.
    let tail = "", dropped = 0;
    const add = (chunk: Buffer) => {
      const text = String(chunk);
      if (!tail && output.length < HEAD_CHARS) { output += text; return; }
      tail += text;
      if (tail.length > 2 * TAIL_CHARS) { dropped += tail.length - TAIL_CHARS; tail = tail.slice(-TAIL_CHARS); }
    };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const full = () => {
      if (tail.length > TAIL_CHARS) { dropped += tail.length - TAIL_CHARS; tail = tail.slice(-TAIL_CHARS); }
      return dropped ? `${output}\n[regression_check: ${dropped} characters omitted]\n${tail.slice(tail.indexOf("\n") + 1)}` : output + tail;
    };
    child.once("close", (code, sig) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ code, signal: sig, timedOut, ms: Date.now() - started, output: full() }); });
    child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ code: -1, signal: null, timedOut, ms: Date.now() - started, output: String(error) }); });
  });
}

/**
 * The environment of both runs: the worker's, with per-test pytest results requested and colours off. `-rfEsxXp` lists every
 * test's outcome in the short summary without -rA's PASSES section, whose captured output of passing tests can be enormous.
 */
export const PYTEST_REPORT = "-rfEsxXp";
export function testEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const addopts = base.PYTEST_ADDOPTS?.trim();
  return { ...base, PYTEST_ADDOPTS: addopts && /(^|\s)-r\S*[pA]/.test(addopts) ? addopts : `${addopts ? `${addopts} ` : ""}${PYTEST_REPORT}`, NO_COLOR: "1", FORCE_COLOR: "0" };
}

/**
 * The assignment's starting state. `capture` takes the tree when the assignment starts; `copy` checks it out once into a private
 * directory (with the dependency directories). Start-state runs are cached per (command, directory): the starting state does not
 * change during the assignment.
 */
export class StartingState {
  private copyDir: Promise<string> | undefined;
  private readonly startRuns = new Map<string, Promise<RunOutcome>>();
  checks: { command: string; verdict: string; newFailures: number; failingNewTests: number; disappeared: number; preExisting: number; fixed: number }[] = [];

  private constructor(readonly cwd: string, readonly root: string, private readonly spaces: CandidateWorkspaces, readonly tree: string) {}

  /** Undefined outside a git work tree or when the snapshot fails (the tool then says so). */
  static async capture(cwd: string, root: string, signal?: AbortSignal): Promise<StartingState | undefined> {
    const spaces = await CandidateWorkspaces.open(cwd, root, signal).catch(() => undefined);
    if (!spaces) return undefined;
    try { return new StartingState(cwd, root, spaces, await spaces.snapshot(signal)); }
    catch { await spaces.close().catch(() => undefined); return undefined; }
  }

  copy(signal?: AbortSignal): Promise<string> {
    this.copyDir ??= this.spaces.materialize("start", this.tree, undefined, signal).then(() => this.spaces.path("start"));
    this.copyDir.catch(() => { this.copyDir = undefined; });
    return this.copyDir;
  }

  async check(command: string, options: { dir?: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<{ text: string; verdict: ReturnType<typeof verdictOf>; comparison: Comparison }> {
    const relativeDir = options.dir ? relative(this.cwd, options.dir) : "";
    if (relativeDir.startsWith("..")) throw new Error(`dir must be inside the workspace (${this.cwd})`);
    const copy = await this.copy(options.signal);
    const env = testEnv(options.env);
    const key = `${relativeDir}\0${command}`;
    let startRun = this.startRuns.get(key);
    if (!startRun) { startRun = runCommand(command, join(copy, relativeDir), env, options.timeoutMs, options.signal); this.startRuns.set(key, startRun); }
    const start = await startRun;
    if (start.timedOut || options.signal?.aborted) this.startRuns.delete(key);
    const now = await runCommand(command, join(this.cwd, relativeDir), env, options.timeoutMs, options.signal);
    const comparison = compareRuns(parseTestOutput(start.output), parseTestOutput(now.output));
    const partial = partialCommand(command);
    const verdict = verdictOf(comparison, start, now, { partial });
    const stamp = `${Date.now().toString(36)}-${this.checks.length + 1}`;
    // Full outputs next to the spill artifacts (ignored by git and searches; they outlive the starting-state copy).
    const artifacts = join(this.cwd, ".orche/artifacts");
    await mkdir(artifacts, { recursive: true });
    for (const name of [".gitignore", ".ignore"]) await writeFile(join(artifacts, name), "*\n", { flag: "a" }).catch(() => undefined);
    const files = { start: `.orche/artifacts/regression-${stamp}-start.txt`, now: `.orche/artifacts/regression-${stamp}-now.txt` };
    await writeFile(join(this.cwd, files.start), start.output).catch(() => undefined);
    await writeFile(join(this.cwd, files.now), now.output).catch(() => undefined);
    this.checks.push({ command, verdict, newFailures: comparison.newFailures.length, failingNewTests: comparison.failingNewTests.length, disappeared: comparison.disappeared.length, preExisting: comparison.preExisting.length, fixed: comparison.fixed.length });
    return { text: formatComparison(command, comparison, start, now, verdict, files, partial), verdict, comparison };
  }

  async close(): Promise<void> { await this.spaces.discard().catch(() => undefined); await this.spaces.close().catch(() => undefined); }
}

export const REGRESSION_RULE = `Regression check: before you report an implement assignment that changed code covered by existing tests, run ${REGRESSION_TOOL} with the project's test command for the affected tests (the whole suite when it is practical). It runs the command on this assignment's starting state and on the workspace now, with the same environment, and separates new failures from failures that already existed at the start (environment problems or earlier bugs). Pass the plain test command: no -x/--maxfail, output pipes or filters, which hide tests from the comparison. Fix every new failure, failing new test, disappeared or newly skipped test, or report it with the reason; pre-existing failures are not yours to fix unless the request asks. Its verdict is evidence, not acceptance: you still own the result and its other checks.`;

export function createRegressionCheckTool(state: () => StartingState | undefined, options: { env?: () => NodeJS.ProcessEnv } = {}): ToolDefinition {
  return {
    name: REGRESSION_TOOL, label: "Regression check",
    description: "Run one test command on this assignment's starting state and on the workspace now (same command, environment and relative directory) and compare per-test results: new failures vs pre-existing failures, failing new tests, disappeared or newly skipped tests, fixed tests. Use the project's real test command (e.g. pytest path/to/tests, node --test, npx vitest run).",
    parameters: Type.Object({
      command: Type.String({ description: "The test command, as you would run it with bash in the workspace" }),
      dir: Type.Optional(Type.String({ description: "Directory to run it in, inside the workspace (default: the workspace root)" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Per run (default 900, at most 3600)" })),
    }),
    execute: async (_id, args, signal) => {
      const { command, dir, timeoutSeconds } = args as { command: string; dir?: string; timeoutSeconds?: number };
      const current = state();
      if (!current) return { content: [{ type: "text", text: `${REGRESSION_TOOL} is unavailable in this assignment: no starting state was captured (not a git work tree, or not an implement assignment). Run the tests with bash and compare against the original code yourself.` }], details: {}, isError: true };
      try {
        const timeoutMs = Math.min(3600, Math.max(10, timeoutSeconds ?? 900)) * 1000;
        const result = await current.check(command, { ...(dir ? { dir: dir.startsWith("/") ? dir : join(current.cwd, dir) } : {}), timeoutMs, env: options.env?.() ?? process.env, ...(signal ? { signal } : {}) });
        return { content: [{ type: "text", text: result.text }], details: { regression: { command, verdict: result.verdict, newFailures: result.comparison.newFailures, failingNewTests: result.comparison.failingNewTests, disappeared: result.comparison.disappeared, newlySkipped: result.comparison.newlySkipped, preExisting: result.comparison.preExisting.length, fixed: result.comparison.fixed.length, reparametrized: result.comparison.reparametrized.length } } };
      } catch (error) {
        return { content: [{ type: "text", text: `${REGRESSION_TOOL} failed: ${error instanceof Error ? error.message : String(error)}` }], details: {}, isError: true };
      }
    },
  };
}
