import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONS, LIMITS, MODEL_REF, THINKING, drawTasks, fallbackChoice, integrity, isTestFile, kFromRatios, leakHits, lineDiff, oneShot, orcheConfig,
  paired, parseChoice, primaryPass, redact, runnerSection, schedule, selectorPrompt, signTest, statusOf, stratumOf, summarizeWire, terminalOf,
  userPrompt, verdict, type CalibrationRow, type Row, type TaskSpec, type WireEntry,
} from "../../experiments/ultra-ab/protocol.js";
import { gradeWorkspace, protectedFiles, type Task } from "../../experiments/ultra-ab/env.js";
import { finalText, runGuarded, taskRecords } from "../../experiments/ultra-ab/run-one.js";
import { selectionDir } from "../../experiments/ultra-ab/select.js";
import { drive, lock, type Plan } from "../../experiments/ultra-ab/driver.js";
import { summarize } from "../../experiments/ultra-ab/analyze.js";
// @ts-expect-error plain ESM module without types
import { usageFrom } from "../../experiments/ultra-ab/proxy.mjs";

/**
 * The ultra-vs-single study harness (experiments/ultra-ab, docs/ultra-ab-bench.md) without any model: the parts that decide what
 * was measured (conditions, schedule, outcome, integrity, grading, selection isolation, driver resume/retry, analysis).
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "ultra-ab-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

const task: TaskSpec = { id: "t", kind: "suite", title: "T", instruction: "Fix the bug in src/a.mjs." };

describe("conditions and configuration", () => {
  it("gives A, B and C the same prompt; only the mode word differs (C runs A's command)", () => {
    expect(oneShot("A", task)).toBe(`/orche strong ${userPrompt(task)}`);
    expect(oneShot("B", task)).toBe(`/orche ultra ${userPrompt(task)}`);
    expect(oneShot("C", task)).toBe(oneShot("A", task));
  });
  it("pins every model role to the canonical gpt-6.1-sol route with the registered effort; advisor off; strong-worker inherits", () => {
    const config = orcheConfig() as any;
    expect(MODEL_REF).toBe("cliproxyapi/gpt-6.1-sol");
    expect(config.models["strong-orchestrator"]).toEqual({ model: MODEL_REF, thinking: "xhigh" });
    expect(config.models["strong-worker"]).toBeUndefined();
    expect(config.models.advisor.model).toBe(MODEL_REF);
    expect(config.single).toEqual({ ledger: false, spawn: true, advisor: false });
    expect(config.thinkingPolicy).toBe("fixed");
    expect(config.concurrentSessions).toEqual({ enabled: false });
    expect(config.limits.maxExtensions).toBe(2);
    expect(THINKING).toEqual({ main: "high", orchestrator: "xhigh", selector: "xhigh" });
  });
});

describe("schedule", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => `t${i}`);
  it("plans 72 top-level results with C expanded into k attempts plus a selection that waits for them", () => {
    const units = schedule(tasks, 2, 3, "seed").map(item => item.unit);
    expect(units.filter(unit => unit.kind === "select" || unit.condition !== "C")).toHaveLength(72);
    expect(units.filter(unit => unit.condition === "C" && unit.kind === "solo")).toHaveLength(72);
    const select = units.find(unit => unit.kind === "select")!;
    expect(select.needs).toEqual([1, 2, 3].map(n => `${select.task}/C/r${select.repeat}/a${n}`));
    for (const unit of units) if (unit.kind === "select") for (const need of unit.needs!) expect(units.findIndex(item => item.id === need)).toBeLessThan(units.indexOf(unit));
  });
  it("is deterministic per seed, repeat-major, and does not always put the same condition first", () => {
    const a = schedule(tasks, 2, 2, "seed"), b = schedule(tasks, 2, 2, "seed");
    expect(a.map(item => item.unit.id)).toEqual(b.map(item => item.unit.id));
    expect(a.findIndex(item => item.unit.repeat === 2)).toBeGreaterThan(a.map(item => item.unit.repeat).lastIndexOf(1) - 1);
    const firsts = new Set(a.map(item => item.order[0]));
    expect(firsts.size).toBeGreaterThan(1);
    for (const item of a) expect([...item.order].sort()).toEqual([...CONDITIONS]);
  });
});

describe("k rule and task draw", () => {
  it("k = clamp(round(geometric mean of B/A output-token ratios), 2, 4) and reports capping", () => {
    expect(kFromRatios([3, 3])).toMatchObject({ k: 3, capped: false });
    expect(kFromRatios([1, 1.2])).toMatchObject({ k: 2 });
    expect(kFromRatios([9, 16])).toMatchObject({ k: 4, capped: true });
    expect(() => kFromRatios([Number.NaN])).toThrow();
  });
  it("strata follow the independent calibration; excluded and infra rows are not eligible; the draw is seeded and pilot/main are disjoint", () => {
    const row = (task: string, outcomes: string[], cost: number, kind = "swe", decision = "not selected"): CalibrationRow => ({ task, kind, outcomes, meanCostUsd: cost, decision });
    expect(stratumOf(row("h", ["fail", "fail"], 1))).toBe("hard");
    expect(stratumOf(row("m", ["pass", "fail"], 0.1))).toBe("medium");
    expect(stratumOf(row("m2", ["pass"], 0.6))).toBe("medium");
    expect(stratumOf(row("e", ["pass", "pass"], 0.59))).toBe("easy");
    expect(stratumOf(row("x", ["fail"], 1, "swe", "excluded"))).toBeUndefined();
    expect(stratumOf(row("i", ["infra", "pass"], 1))).toBeUndefined();
    const rows = [...Array.from({ length: 6 }, (_, i) => row(`h${i}`, ["fail"], 1)), row("hs", ["fail"], 1, "suite"), ...Array.from({ length: 6 }, (_, i) => row(`m${i}`, ["pass"], 1)), ...Array.from({ length: 6 }, (_, i) => row(`e${i}`, ["pass"], 0.1))];
    const one = drawTasks(rows, "s", 4, { hard: 1, medium: 1, easy: 1 }), two = drawTasks(rows, "s", 4, { hard: 1, medium: 1, easy: 1 });
    expect(one).toEqual(two);
    expect(one.main).toHaveLength(12);
    const pilot = new Set(one.pilot.map(item => item.task));
    expect(one.main.some(item => pilot.has(item.task))).toBe(false);
    if (!pilot.has("hs")) expect(one.main.some(item => item.task === "hs")).toBe(true);
  });
  it("the registered draw (tasks.json) matches the pre-registration", () => {
    const tasks = JSON.parse(readFileSync(new URL("../../experiments/ultra-ab/tasks.json", import.meta.url), "utf8"));
    expect(tasks.main).toHaveLength(12);
    expect(tasks.main.filter((item: any) => item.stratum === "hard").map((item: any) => item.task)).toEqual(["sqlfluff__sqlfluff-7615", "pycqa__isort-2491", "d1-transactional-outbox", "scientific-python__docstub-123"]);
    const pre = readFileSync(new URL("../../experiments/ultra-ab/PREREGISTRATION.md", import.meta.url), "utf8");
    for (const item of [...tasks.main, ...tasks.pilot]) expect(pre).toContain(item.task);
  });
});

describe("outcome", () => {
  it("terminal = the last orche task's status; guard, no delegation and infra are their own failures", () => {
    expect(terminalOf({ guardFired: false, taskStatuses: ["blocked", "done"] })).toBe("done");
    expect(terminalOf({ guardFired: false, taskStatuses: ["done", "blocked"] })).toBe("blocked");
    expect(terminalOf({ guardFired: false, taskStatuses: [] })).toBe("no-task");
    expect(terminalOf({ guardFired: true, taskStatuses: ["done"] })).toBe("harness-timeout");
    expect(terminalOf({ guardFired: false, taskStatuses: ["timed out"] })).toBe("timeout");
    expect(terminalOf({ guardFired: false, taskStatuses: ["done"], infra: "x" })).toBe("infra");
  });
  it("primary pass needs done + grade pass + no integrity violation", () => {
    const clean = { violations: [], suspicious: ["added lines"] };
    expect(primaryPass({ terminal: "done", gradePassed: true, integrity: clean })).toBe(true);
    expect(primaryPass({ terminal: "blocked", gradePassed: true, integrity: clean })).toBe(false);
    expect(primaryPass({ terminal: "done", gradePassed: false, integrity: clean })).toBe(false);
    expect(primaryPass({ terminal: "done", gradePassed: true, integrity: { violations: ["x"], suspicious: [] } })).toBe(false);
    expect(primaryPass({ terminal: "done", gradePassed: undefined, integrity: clean })).toBe(false);
  });
  it("integrity: deleted/changed test lines, added skip markers, runner-section edits and new conftest are violations; added tests are not", () => {
    const initial = new Map([["tests/test_a.py", "def test_a():\n    assert f() == 1\n"], ["test/a.test.mjs", "test('a', () => {});\n"], ["pyproject.toml", "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n"], ["package.json", JSON.stringify({ name: "x", scripts: { test: "node --test" } })]]);
    const same = new Map(initial);
    expect(integrity(initial, same)).toEqual({ violations: [], suspicious: [] });
    const added = new Map(initial); added.set("tests/test_a.py", `${initial.get("tests/test_a.py")}\ndef test_b():\n    assert g() == 2\n`);
    expect(integrity(initial, added).violations).toEqual([]);
    expect(integrity(initial, added).suspicious).toHaveLength(1);
    const weakened = new Map(initial); weakened.set("tests/test_a.py", "def test_a():\n    assert True\n");
    expect(integrity(initial, weakened).violations[0]).toMatch(/changed\/removed 1 line/);
    const skipped = new Map(initial); skipped.set("test/a.test.mjs", "test.skip('a', () => {});\ntest('a', () => {});\n");
    expect(integrity(initial, skipped).violations.join()).toMatch(/skip\/only/);
    const deleted = new Map(initial); deleted.delete("tests/test_a.py");
    expect(integrity(initial, deleted).violations).toEqual(["deleted test file tests/test_a.py"]);
    const packaging = new Map(initial); packaging.set("pyproject.toml", "[project]\nname='x'\nversion='2'\n[tool.pytest.ini_options]\naddopts='-q'\n");
    expect(integrity(initial, packaging).violations).toEqual([]);
    const runner = new Map(initial); runner.set("pyproject.toml", "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q -k not slow'\n");
    expect(integrity(initial, runner).violations).toEqual(["changed the test-runner section of pyproject.toml"]);
    const script = new Map(initial); script.set("package.json", JSON.stringify({ name: "x", scripts: { test: "true" } }));
    expect(integrity(initial, script).violations).toEqual(["changed the test-runner section of package.json"]);
    const conftest = new Map(initial); conftest.set("tests/conftest.py", "import pytest\n");
    expect(integrity(initial, conftest).violations).toEqual(["new test-runner file tests/conftest.py"]);
    expect(isTestFile("src/app.py")).toBe(false);
    expect(runnerSection("setup.cfg", "[metadata]\nname=x\n[tool:pytest]\naddopts=-q\n")).toBe("[tool:pytest]\naddopts=-q\n");
    expect(lineDiff("a\nb\nb\n", "a\nb\nc\n")).toEqual({ removed: ["b"], added: ["c"] });
  });
  it("SWE status: exact id, else all parametrized matches must pass", () => {
    const statuses = new Map([["t.py::a[1]", "PASSED"], ["t.py::a[2]", "FAILED"], ["t.py::b[1]", "PASSED"], ["t.py::c", "PASSED"]]);
    expect(statusOf(statuses, "t.py::c")).toBe("PASSED");
    expect(statusOf(statuses, "t.py::a")).toBe("FAILED");
    expect(statusOf(statuses, "t.py::b")).toBe("PASSED");
    expect(statusOf(statuses, "t.py::d")).toBe("MISSING");
  });
});

describe("wire evidence", () => {
  const entry = (patch: Partial<WireEntry>): WireEntry => ({ id: 1, at: "2026-10-10T00:00:00.000Z", endAt: "2026-10-10T00:00:01.000Z", method: "POST", model: "gpt-6.1-sol", respModel: "gpt-6.1-sol", effort: "high", status: 200, final: "response.completed", usage: { input: 10, cached: 2, output: 5, reasoning: 3 }, ...patch });
  it("counts routes and lists every model, response-model and effort deviation", () => {
    const summary = summarizeWire([entry({}), entry({ id: 2, worker: true, effort: "xhigh" }), entry({ id: 3, worker: true, effort: "high" }), entry({ id: 4, model: "bts/gpt-6.1-sol" }), entry({ id: 5, respModel: undefined }), entry({ id: 6, status: 500, usage: undefined, final: undefined }), entry({ id: 8, final: undefined, clientClosed: true }), { id: 7, at: "x", method: "GET" }], { main: "high", worker: "xhigh" });
    expect(summary.requests).toBe(7);
    expect(summary.streamErrors).toBe(1);
    expect(summary.byRoute["main|gpt-6.1-sol|gpt-6.1-sol|high|200"]).toBe(2);
    expect(summary.byRoute["worker|gpt-6.1-sol|gpt-6.1-sol|xhigh|200"]).toBe(1);
    expect(summary.unexpected).toEqual(["#3 worker: worker effort high (want xhigh)", "#4 main: model bts/gpt-6.1-sol", "#5 main: response model unverifiable"]);
    expect(summary.non200).toBe(1);
    expect(summary.usageMissing).toBe(1);
    expect(summary.output).toBe(30);
    expect(summary.latencyMsTotal).toBe(7000);
    // With the run's own session id, every other session (orche workers and their sub-workers, whatever their prompt) is a worker.
    const bySession = summarizeWire([entry({ session: "ab-main" }), entry({ id: 2, session: "sub-1", effort: "xhigh", worker: false })], { main: "high", worker: "xhigh", mainSession: "ab-main" });
    expect(bySession.byRoute).toEqual({ "main|gpt-6.1-sol|gpt-6.1-sol|high|200": 1, "worker|gpt-6.1-sol|gpt-6.1-sol|xhigh|200": 1 });
    expect(bySession.unexpected).toEqual([]);
  });
  it("reads top-level usage of the final Responses event, not the nested attribution", () => {
    const stream = [
      'event: response.created', 'data: {"type":"response.created","response":{"model":"gpt-6.1-sol","usage":null}}', '',
      'event: response.completed', `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-6.1-sol", usage: { attribution: { items: { m: { input_tokens: 9, output_tokens: 0 } } }, input_tokens: 1453, input_tokens_details: { cached_tokens: 7 }, output_tokens: 18, output_tokens_details: { reasoning_tokens: 11 } } } })}`, '',
    ].join("\n");
    expect(usageFrom(stream)).toEqual({ input: 1453, cached: 7, output: 18, reasoning: 11, final: "response.completed", respModel: "gpt-6.1-sol" });
    expect(usageFrom('data: {"type":"response.output_text.delta"}')).toBeUndefined();
  });
  it("leak audit flags hidden/fixture/results paths and network fetches; redaction removes secrets", () => {
    expect(leakHits([{ name: "bash", arguments: { command: "cat /x/fixtures/suite/a/hidden/test/a.test.js" } }, { name: "bash", arguments: { command: "ls results/ultra-ab/main" } }, { name: "read", arguments: { path: "src/a.py" } }, { name: "read", arguments: { path: "docs/reference/api.rst" } }, { name: "read", arguments: { path: "/home/u/oh-my-pi-extensions/orche/results/x" } }])).toHaveLength(3);
    expect(redact("key=sk-ABCDEFGH123 and sk-ABCDEFGH123", ["sk-ABCDEFGH123", "short"])).toBe("key=<redacted> and <redacted>");
  });
});

describe("C selection", () => {
  it("the selector prompt has the task and statuses but no hidden or result paths; choice parsing and fallback", () => {
    const prompt = selectorPrompt(task, [{ index: 1, terminal: "blocked", diffStat: " 1 file changed" }, { index: 2, terminal: "done", diffStat: "" }]);
    expect(prompt).toContain("cand-1: terminal status blocked");
    expect(prompt).toContain("> Fix the bug in src/a.mjs.");
    expect(prompt).not.toMatch(/hidden\/|fixtures|grade\.json|results\//);
    expect(parseChoice('thinking...\n{"choice": 1, "reason": "x"}\nfinal:\n{"choice": 2, "reason": "better"}', 2)).toBe(2);
    expect(parseChoice('{"choice": 3}', 2)).toBeUndefined();
    expect(parseChoice("no json", 2)).toBeUndefined();
    expect(fallbackChoice([{ index: 1, terminal: "blocked", diffStat: "" }, { index: 2, terminal: "done", diffStat: "" }])).toBe(2);
    expect(fallbackChoice([{ index: 1, terminal: "failed", diffStat: "" }])).toBe(1);
  });
  it("the selection directory holds only the base snapshot, candidate files and diffs (no meta, grade, transcript or records)", async () => {
    const root = await temp();
    const source = join(root, "source"); await mkdir(join(source, "src"), { recursive: true }); await writeFile(join(source, "src/a.mjs"), "x");
    const attempts: string[] = [];
    for (const n of [1, 2]) {
      const dir = join(root, `a${n}`); attempts.push(dir);
      await mkdir(join(dir, "workspace-final/src"), { recursive: true }); await mkdir(join(dir, "records"), { recursive: true });
      await writeFile(join(dir, "workspace-final/src/a.mjs"), `v${n}`); await writeFile(join(dir, "final.diff"), `diff ${n}`);
      await writeFile(join(dir, "meta.json"), "{}"); await writeFile(join(dir, "grade.json"), '{"passed":true}'); await writeFile(join(dir, "events.jsonl"), "secret transcript");
    }
    const sel = join(root, "sel");
    await selectionDir(sel, source, attempts);
    expect(readdirSync(sel).sort()).toEqual(["base", "cand-1", "cand-1.diff", "cand-2", "cand-2.diff"]);
    expect(await readFile(join(sel, "cand-2/src/a.mjs"), "utf8")).toBe("v2");
    expect(readdirSync(join(sel, "cand-1"))).toEqual(["src"]);
  });
});

describe("analysis", () => {
  const rows = (spec: Record<string, Record<string, boolean[]>>): Row[] => Object.entries(spec).flatMap(([taskId, byCondition]) => Object.entries(byCondition).flatMap(([condition, passes]) => passes.map((pass, index) => ({ task: taskId, condition: condition as Row["condition"], repeat: index + 1, pass, terminal: pass ? "done" : "blocked" } as Row))));
  it("pairs per task (repeats stay inside their task) and bootstraps tasks", () => {
    const data = rows({ t1: { A: [false, false], B: [true, true] }, t2: { A: [true, false], B: [true, true] }, t3: { A: [true, true], B: [true, true] }, t4: { A: [true, true], B: [false, true] } });
    const result = paired(data, "A", "B", { seed: "x", resamples: 2000 });
    expect(result.tasks).toBe(4);
    expect(result.meanDiff).toBeCloseTo((1 + 0.5 + 0 - 0.5) / 4);
    expect([result.better, result.worse, result.same]).toEqual([2, 1, 1]);
    expect(result.ci95[0]).toBeLessThanOrEqual(result.meanDiff);
    expect(result.ci95[1]).toBeGreaterThanOrEqual(result.meanDiff);
    expect(result.xFailYPass).toBeCloseTo(1 + 0.5);
    expect(result.xPassYFail).toBeCloseTo(0.5);
  });
  it("sign test and the pre-registered verdict rule", () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 0)).toBeCloseTo(0.0625);
    const p = (lo: number, hi: number) => ({ tasks: 12, meanDiff: (lo + hi) / 2, ci95: [lo, hi] as [number, number], better: 0, worse: 0, same: 0, signTestP: 1, xFailYPass: 0, xPassYFail: 0 });
    expect(verdict(p(0.05, 0.3), p(0.01, 0.2))).toBe("ultra-superior");
    expect(verdict(p(0.05, 0.3), p(-0.1, 0.2))).toBe("total-effect-only");
    expect(verdict(p(-0.3, -0.01), p(-0.1, 0.2))).toBe("ultra-inferior");
    expect(verdict(p(-0.1, 0.3), p(0.01, 0.2))).toBe("unconfirmed");
  });
});

describe("grader (suite task, no model)", () => {
  async function suiteTask(): Promise<{ task: Task; root: string }> {
    const root = await temp();
    const dir = join(root, "fixture"), source = join(dir, "repo");
    await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "test"), { recursive: true }); await mkdir(join(dir, "hidden/test"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "x", type: "module", scripts: { test: "node --test" } }));
    await writeFile(join(source, "src/a.mjs"), "export const add = (a, b) => a - b;\n");
    await writeFile(join(source, "test/visible.test.mjs"), "import test from 'node:test'; import assert from 'node:assert'; import { add } from '../src/a.mjs';\ntest('zero', () => { assert.equal(add(0, 0), 0); });\n");
    await writeFile(join(dir, "hidden/test/hidden.test.mjs"), "import test from 'node:test'; import assert from 'node:assert'; import { add } from '../src/a.mjs';\ntest('sum', () => { assert.equal(add(2, 3), 5); });\n");
    return { task: { id: "x", kind: "suite", title: "x", instruction: "fix add", dir, source, manifest: {} }, root };
  }
  const copyOf = async (task: Task, root: string, name: string) => { const ws = join(root, name); await (await import("node:fs/promises")).cp(task.source, ws, { recursive: true }); return ws; };

  it("fails the start, passes a real fix, and restores weakened original tests before grading", async () => {
    const { task, root } = await suiteTask();
    const start = await copyOf(task, root, "start");
    expect((await gradeWorkspace(task, start)).grade.passed).toBe(false);
    const fixed = await copyOf(task, root, "fixed");
    await writeFile(join(fixed, "src/a.mjs"), "export const add = (a, b) => a + b;\n");
    const good = await gradeWorkspace(task, fixed);
    expect(good.grade).toMatchObject({ passed: true, checks: { visibleTests: { passed: true }, hiddenTests: { passed: true } } });
    expect(good.integrity.violations).toEqual([]);
    // A broken implementation whose visible test was rewritten to pass: the grader runs the ORIGINAL visible test.
    const cheat = await copyOf(task, root, "cheat");
    await writeFile(join(cheat, "src/a.mjs"), "export const add = () => 0;\n");
    await writeFile(join(cheat, "test/visible.test.mjs"), "import test from 'node:test';\ntest.skip('zero', () => {});\n");
    const graded = await gradeWorkspace(task, cheat);
    expect(graded.grade.passed).toBe(false);
    expect(graded.integrity.violations.length).toBeGreaterThan(0);
    expect(protectedFiles(task.source).has("test/visible.test.mjs")).toBe(true);
  });
});

describe("process control and records", () => {
  it("the guard kills the whole process group (background children included)", async () => {
    const root = await temp();
    const pidFile = join(root, "pid");
    const result = await runGuarded("bash", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: root, env: process.env, stdout: join(root, "out"), stderr: join(root, "err"), guardMs: 500 });
    expect(result.guardFired).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });
  it("reads orche task records in start order and the final assistant text of a JSON event stream", async () => {
    const root = await temp();
    for (const [name, start, status] of [["b", "2026-10-10T00:02:00Z", "done"], ["a", "2026-10-10T00:01:00Z", "blocked"]] as const) {
      await mkdir(join(root, "s", name), { recursive: true });
      await writeFile(join(root, "s", name, "run.json"), JSON.stringify({ kind: "task", start, status, outcome: { status }, assignment: { mode: "ultra", tier: "strong-orchestrator", model: MODEL_REF, thinking: "xhigh" } }));
    }
    expect(taskRecords(root).map(record => [record.status, record.mode])).toEqual([["blocked", "ultra"], ["done", "ultra"]]);
    const events = join(root, "events.jsonl");
    await writeFile(events, [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "u" }] } }, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: "last" }] } }].map(line => JSON.stringify(line)).join("\n"));
    expect(finalText(events)).toBe("last");
  });
});

describe("driver: manifest, resume, retries, lock", () => {
  it("runs every planned unit once, keeps interrupted and infra attempts, retries infra once, reuses completed units and waits for C attempts", async () => {
    const out = await temp();
    const plan: Plan = { out, phase: "t", tasks: [{ task: "x", stratum: "easy", kind: "suite" }], repeats: 1, k: 2, seed: "s", concurrency: 3, scratch: join(out, "scratch") };
    // An interrupted earlier run of B: a directory without a completed meta.
    await mkdir(join(out, "runs/x/B/r1"), { recursive: true });
    await writeFile(join(out, "runs/x/B/r1/meta.json"), JSON.stringify({ status: "running" }));
    const calls: string[] = [];
    const runner = async (unit: any, input: any) => {
      calls.push(unit.id);
      if (unit.kind === "select") for (const need of unit.needs) expect(existsSync(join(out, "runs", need, "meta.json"))).toBe(true);
      const infra = unit.id === "x/A/r1" && calls.filter(id => id === "x/A/r1").length === 1;
      await writeFile(join(input.out, "meta.json"), JSON.stringify({ status: "completed", terminal: infra ? "infra" : "done", primaryPass: !infra }));
      return 0;
    };
    const states = await drive(plan, { runner, reuseFrozen: false });
    expect(states.every(state => state.status === "completed")).toBe(true);
    expect(calls.filter(id => id === "x/A/r1")).toHaveLength(2);
    expect(existsSync(join(out, "runs/x/A/r1.infra-1/meta.json"))).toBe(true);
    expect(existsSync(join(out, "runs/x/B/r1.interrupted-1/meta.json"))).toBe(true);
    expect(calls.indexOf("x/C/r1/select")).toBeGreaterThan(Math.max(calls.indexOf("x/C/r1/a1"), calls.indexOf("x/C/r1/a2")));
    const manifest = JSON.parse(readFileSync(join(out, "manifest-t.json"), "utf8"));
    expect(manifest.counts).toEqual({ completed: 5 });
    expect(existsSync(join(out, "rt/REVISION.json"))).toBe(true);
    expect(existsSync(join(out, "harness/ultra-ab/protocol.ts"))).toBe(true);
    // Resume: nothing runs again.
    const again: string[] = [];
    await drive(plan, { runner: async unit => { again.push(unit.id); return 0; }, reuseFrozen: true });
    expect(again).toEqual([]);
    // A unit process that dies without a completed meta is recorded as infra (and retried once).
    const out2 = await temp();
    const dead: string[] = [];
    await drive({ ...plan, out: out2, conditions: ["A"] }, { runner: async unit => { dead.push(unit.id); return 1; } });
    expect(dead).toEqual(["x/A/r1", "x/A/r1"]);
    expect(JSON.parse(readFileSync(join(out2, "runs/x/A/r1/meta.json"), "utf8"))).toMatchObject({ terminal: "infra", primaryPass: false });
    // Analysis counts planned units, completed results and kept attempts.
    const summary = summarize(out, "t");
    expect(summary.planned).toBe(5);
    expect(summary.completedUnits).toBe(5);
    expect(summary.kept.sort()).toEqual(["x/A/r1.infra-1", "x/B/r1.interrupted-1"]);
  }, 60_000);
  it("refuses a second driver on the same study while the first holds the lock", async () => {
    const dir = await temp();
    const release = await lock(join(dir, "l"));
    await writeFile(join(dir, "l"), `${process.ppid}\n`);
    await expect(lock(join(dir, "l"))).rejects.toThrow(/Another driver/);
    await release();
  });
});

void LIMITS;
