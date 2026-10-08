import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requirementIds } from "../../src/orchestration/result-schemas.js";
import {
  ARMS, MODELS, advisorRequest, classify, formatPlan, leakHits, reviewerRequest, revisionRequest, sameOutput, schedule, sessionToolCalls, usageByModel, workerRequest,
  type TaskSpec,
} from "../../experiments/advisor-reviewer/protocol.js";
import { armSummary, compare, rowOf, type RunRow } from "../../experiments/advisor-reviewer/analyze.js";
import { gradeLcb, matchStatus, pythonWrappers, readable, sweInstruction, sweLayout } from "../../experiments/advisor-reviewer/tasks.js";

/**
 * The advisor/reviewer benchmark harness (experiments/advisor-reviewer, docs/advisor-reviewer-bench.md): its protocol, grading and
 * aggregation without any model. The study itself ran on real models; these pin the parts that decide what was measured.
 */
const lcb: TaskSpec = { id: "lcb-x", kind: "lcb", title: "X", instruction: "Solve problem.md; write solution.py." };
const suite: TaskSpec = { id: "s", kind: "suite", title: "S", instruction: "R9: not a requirement of the harness\nFix the bug." };

describe("advisor/reviewer protocol", () => {
  it("names the requested models and effort", () => {
    expect(MODELS.worker).toEqual({ provider: "cliproxyapi", id: "claude-opus-5-5", thinking: "high" });
    expect(MODELS.helper).toEqual({ provider: "cliproxyapi", id: "gpt-6.1-sol", thinking: "high" });
  });

  it("gives every arm the same worker request, with requirement ids only from the harness", () => {
    expect(requirementIds(workerRequest(lcb))).toEqual(["R1"]);
    expect(requirementIds(workerRequest(suite))).toEqual(["R1", "R2"]);
    // The task text after "Original request" never adds requirement ids.
    expect(workerRequest(suite).endsWith(suite.instruction)).toBe(true);
  });

  it("keeps the advisor's and reviewer's assignments free of requirement ids (no checklist), quoting the worker's task", () => {
    const advice = advisorRequest(suite, "- a [running]: plan");
    const review = reviewerRequest(suite, "R1: met\ndone");
    expect(requirementIds(advice)).toEqual([]);
    expect(requirementIds(review)).toEqual([]);
    expect(advice).toContain("> R1: The task in the Original request");
    expect(review).toContain("> R1: met");
    expect(advice).toMatch(/read-only/);
    expect(review).toMatch(/passed: true only when you found no defect/);
  });

  it("gives the revision its own requirements and the original task quoted", () => {
    const text = revisionRequest(suite, "reviewer", "R1: wrong\nissue");
    expect(requirementIds(text)).toEqual(["R1", "R2"]);
    expect(text).toContain("> Fix the bug.");
    expect(text).toContain("> R1: wrong");
  });

  it("schedules every cell once, repeat-major, with the arm order rotated per task and repeat", () => {
    const cells = schedule(["t1", "t2", "t3"], ARMS, 2);
    expect(cells).toHaveLength(18);
    expect(new Set(cells.map(c => `${c.task}/${c.arm}/${c.repeat}`)).size).toBe(18);
    expect(cells.slice(0, 9).every(c => c.repeat === 1)).toBe(true);
    // Each arm is first exactly once per repeat across the three tasks.
    const firsts = [0, 3, 6].map(i => cells[i]!.arm);
    expect(new Set(firsts).size).toBe(3);
    expect(cells[0]!.arm).not.toBe(cells[9]!.arm);
  });

  it("compares outputs by tokens, with a tolerance only for real numbers", () => {
    expect(sameOutput("1 2\n3\n", "1 2 3")).toBe(true);
    expect(sameOutput("1 2", "1 2 3")).toBe(false);
    expect(sameOutput("10", "1e1")).toBe(true);
    expect(sameOutput("0.3333333", "0.33333333")).toBe(true);
    expect(sameOutput("12", "13")).toBe(false);
    expect(sameOutput("Yes", "yes")).toBe(false);
  });

  it("reads usage per model, reasoning when reported, errors, tool calls and plans from a session transcript", () => {
    const line = (message: object) => JSON.stringify({ type: "message", timestamp: "t", message });
    const jsonl = [
      line({ role: "user", content: "x" }),
      line({ role: "assistant", provider: "p", model: "m", stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, reasoning: 3, cost: { total: 0.5 } }, content: [{ type: "toolCall", name: "task_plan", arguments: { nodes: [{ id: "a", status: "running", title: "Do", dependsOn: [] }] } }] }),
      line({ role: "assistant", provider: "p", model: "m", stopReason: "error", content: [] }),
      line({ role: "assistant", provider: "q", model: "n", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, content: [{ type: "toolCall", name: "read", arguments: { path: "/repo/fixtures/suite/x/hidden/t.js" } }] }),
      "{broken",
    ].join("\n");
    const usage = usageByModel(jsonl);
    expect(usage["p/m"]).toMatchObject({ requests: 2, input: 10, output: 5, cacheRead: 100, cacheWrite: 1, reasoning: 3, reasoningReported: 1, errors: 1, unknownUsage: 1, cost: 0.5 });
    expect(usage["q/n"]).toMatchObject({ requests: 1, reasoningReported: 0 });
    const calls = sessionToolCalls(jsonl);
    expect(calls.map(call => call.name)).toEqual(["task_plan", "read"]);
    expect(formatPlan(calls[0]!.arguments)).toBe("- a [running]: Do");
    expect(formatPlan({})).toBeUndefined();
    expect(leakHits(calls)).toHaveLength(1);
  });

  it("classifies infrastructure failures, timeouts and grades apart", () => {
    expect(classify({ grade: { passed: true } })).toBe("pass");
    expect(classify({ grade: { passed: false } })).toBe("fail");
    expect(classify({ grade: { passed: false }, workerTimedOut: true })).toBe("timeout");
    expect(classify({ grade: { passed: true }, workerTimedOut: true })).toBe("pass");
    expect(classify({ grade: { passed: true }, infraError: "x" })).toBe("infra");
    expect(classify({})).toBe("infra");
    expect(classify({ grade: { passed: false, error: "EACCES" } })).toBe("infra");
  });
});

describe("advisor/reviewer grading (LiveCodeBench stdin tasks)", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it("accepts a correct solution.py and reports WA, RE, TLE and a missing file", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-grade-"));
    const task = { id: "lcb-t", kind: "lcb" as const, title: "t", instruction: "", dir: join(dir, "task") };
    await mkdir(join(task.dir, "hidden"), { recursive: true });
    await writeFile(join(task.dir, "hidden/tests.json"), JSON.stringify([{ input: "2 3\n", output: "5\n" }, { input: "10 -4", output: "6" }, { input: "0 0", output: "0" }]));
    const ws = join(dir, "ws");
    await mkdir(ws);
    expect((await gradeLcb(task, ws)).tests?.verdicts).toEqual({ missing: 3 });
    await writeFile(join(ws, "solution.py"), "a, b = map(int, input().split())\nprint(a + b)\n");
    const good = await gradeLcb(task, ws, { parallel: 2 });
    expect(good).toMatchObject({ passed: true, tests: { total: 3, passed: 3, verdicts: { AC: 3 } } });
    await writeFile(join(ws, "solution.py"), "import time\na, b = map(int, input().split())\nif a == 10: raise SystemExit(1)\nif a == 0: time.sleep(5)\nprint(a - b)\n");
    const bad = await gradeLcb(task, ws, { timeoutMs: 1000 });
    expect(bad.passed).toBe(false);
    expect(bad.tests?.failures.map(f => f.verdict)).toEqual(["WA", "RE", "TLE"]);
  });
});

describe("advisor/reviewer SWE-rebench tasks", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) { await chmod(join(dir, "locked"), 0o644).catch(() => undefined); await rm(dir, { recursive: true, force: true }); } dir = undefined; });

  it("gives the worker the issue, the interface and the environment rules, and SWE requirement ids", () => {
    const text = sweInstruction({ problemStatement: "Bug: X\nR1: inside the issue", interface: "Type: Class" });
    expect(text).toMatch(/Hidden tests written by the maintainers/);
    expect(text).toMatch(/no pip, no network/);
    expect(text.indexOf("Bug: X")).toBeLessThan(text.indexOf("Type: Class"));
    const request = workerRequest({ id: "s", kind: "swe", title: "t", instruction: text });
    expect(requirementIds(request)).toEqual(["R1", "R2"]);
  });

  it("matches dataset test ids exactly or, when the dataset cut a parametrized id at a space, by prefix", () => {
    const statuses = new Map([["t.py::a", "PASSED"], ["t.py::b[599-Unknown Status-x]", "FAILED"]]);
    expect(matchStatus(statuses, "t.py::a")).toBe("PASSED");
    expect(matchStatus(statuses, "t.py::b[599-Unknown")).toBe("FAILED");
    expect(matchStatus(statuses, "t.py::c")).toBe("MISSING");
  });

  it("finds src layouts, writes PATH wrappers that put the workspace first and refuse pip, and skips unreadable files", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-swe-"));
    await mkdir(join(dir, "src/pkg"), { recursive: true });
    await writeFile(join(dir, "src/pkg/__init__.py"), "");
    expect(sweLayout(dir)).toBe("src");
    await mkdir(join(dir, "flat/pkg"), { recursive: true });
    expect(sweLayout(join(dir, "flat"))).toBe(".");
    await pythonWrappers({ id: "x", pythonPath: "src" }, "/ws", join(dir, "bin"));
    const python = await readFile(join(dir, "bin/python"), "utf8");
    expect(python).toContain('export PYTHONPATH="/ws/src${PYTHONPATH:+:$PYTHONPATH}"');
    expect(python).toMatch(/exec ".*\/x\/venv\/bin\/python" "\$@"/);
    expect(await readFile(join(dir, "bin/pip"), "utf8")).toMatch(/pip is disabled/);
    await writeFile(join(dir, "locked"), "x");
    await chmod(join(dir, "locked"), 0);
    if (process.getuid?.() !== 0) expect(readable(join(dir, "locked"))).toBe(false);
    expect(readable(join(dir, "src"))).toBe(true);
  });
});

describe("advisor/reviewer aggregation", () => {
  const meta = (task: string, arm: string, repeat: number, passed: boolean, extra: object = {}) => ({
    task, arm, repeat, status: "completed", wallMs: 100_000, grade: { passed },
    assignments: [{ role: "worker", startedAt: 0, finishedAt: 60_000 }, ...(arm !== "baseline" ? [{ role: arm, startedAt: 60_000, finishedAt: 80_000 }, { role: "revision", startedAt: 80_000, finishedAt: 100_000 }] : [])],
    usage: { byRole: { worker: { "c/opus": { requests: 10, input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, reasoning: 0, cost: 1 } }, ...(arm !== "baseline" ? { [arm]: { "c/sol": { requests: 4, input: 40, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, cost: 0.2 } } } : {}) }, total: { cost: arm === "baseline" ? 1 : 1.2 } },
    ...extra,
  });

  it("builds rows with time per role, tokens per model, and the regraded outcome", () => {
    const row = rowOf(meta("t", "reviewer", 1, false, { reviewer: { passed: false, issues: [{}, {}] } }), { passed: true, tests: { passed: 3, total: 3 } });
    expect(row).toMatchObject({ outcome: "pass", gradeInRun: false, tests: "3/3", workerMs: 60_000, helperMs: 20_000, revisionMs: 20_000, revision: true, reviewerPassed: false, reviewerIssues: 2, cost: 1.2 });
    expect(row.tokens["c/sol"]).toMatchObject({ requests: 4, reasoning: 5 });
    expect(row.requests).toEqual({ worker: 10, reviewer: 4 });
  });

  it("compares an arm with baseline per task, over every run pairing, and summarizes cost and variability", () => {
    const rows: RunRow[] = [
      rowOf(meta("a", "baseline", 1, false)), rowOf(meta("a", "baseline", 2, false)), rowOf(meta("a", "reviewer", 1, true)), rowOf(meta("a", "reviewer", 2, false)),
      rowOf(meta("b", "baseline", 1, true)), rowOf(meta("b", "baseline", 2, true)), rowOf(meta("b", "reviewer", 1, true)), rowOf(meta("b", "reviewer", 2, true)),
      rowOf(meta("c", "baseline", 1, true)), rowOf(meta("c", "baseline", 2, true)), rowOf(meta("c", "reviewer", 1, false)), rowOf(meta("c", "reviewer", 2, true, { infraError: "x" })),
    ];
    const result = compare(rows, "reviewer", ["a", "b", "c"]);
    expect(result.perTask).toEqual([{ task: "a", baseline: 0, arm: 0.5 }, { task: "b", baseline: 1, arm: 1 }, { task: "c", baseline: 1, arm: 0 }]);
    expect(result.meanDiff).toBeCloseTo(-1 / 6);
    expect([result.tasksBetter, result.tasksWorse, result.tasksSame]).toEqual([1, 1, 1]);
    expect(result.transitions).toEqual({ failToPass: 0.5, passToFail: 1, bothPass: 1, bothFail: 0.5 });
    expect(result.ci95[0]).toBeLessThanOrEqual(result.meanDiff);
    expect(result.ci95[1]).toBeGreaterThanOrEqual(result.meanDiff);
    const summary = armSummary(rows, "reviewer");
    expect(summary).toMatchObject({ runs: 6, counted: 5, passes: 3, outcomes: { pass: 3, fail: 2, infra: 1 }, revisions: 6, discordantTasks: 1 });
    expect(summary.cost.total).toBeCloseTo(7.2);
    expect(summary.cost.perPass).toBeCloseTo(2.4);
    expect(summary.models["c/opus"]!.requests).toBe(60);
  });
});
