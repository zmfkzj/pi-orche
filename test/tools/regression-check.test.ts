import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartingState, compareRuns, createRegressionCheckTool, parseTestOutput, partialCommand, runCommand, testEnv, verdictOf, type RunOutcome } from "../../src/tools/regression-check.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const run = (code: number | null, output = ""): RunOutcome => ({ code, signal: null, timedOut: false, ms: 1, output });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

describe("parseTestOutput", () => {
  it("reads pytest -rA summaries, verbose lines and collection errors", () => {
    const parsed = parseTestOutput([
      "tests/test_a.py::test_ok PASSED                                      [ 50%]",
      "PASSED tests/test_a.py::test_ok",
      "FAILED tests/test_a.py::test_bad[x-1] - AssertionError: no",
      "ERROR tests/test_b.py::test_fixture - RuntimeError",
      "SKIPPED [1] tests/test_c.py:3: no db",
      "XFAIL tests/test_a.py::test_known - reason",
      "_____________ ERROR collecting tests/test_d.py _____________",
    ].join("\n"));
    expect(Object.fromEntries(parsed.statuses)).toEqual({
      "tests/test_a.py::test_ok": "passed", "tests/test_a.py::test_bad[x-1]": "failed", "tests/test_b.py::test_fixture": "error",
      "tests/test_a.py::test_known": "passed", "tests/test_d.py (collection)": "error",
    });
    expect(parsed.frameworks).toEqual(["pytest"]);
  });

  it("reads node --test TAP with nested subtests, skips, and the spec reporter", () => {
    const tap = parseTestOutput([
      "# Subtest: suite", "    # Subtest: inner", "    ok 1 - inner", "    not ok 2 - broken", "    ok 3 - later # SKIP not now", "ok 1 - suite", "not ok 2 - top",
    ].join("\n"));
    expect(Object.fromEntries(tap.statuses)).toEqual({ "suite > inner": "passed", "suite > broken": "failed", "suite > later": "skipped", suite: "passed", top: "failed" });
    const spec = parseTestOutput(["✔ adds (0.5ms)", "✖ subtracts (1.2ms)", "▶ group", "  ✔ nested (0.1ms)"].join("\n"));
    expect(Object.fromEntries(spec.statuses)).toEqual({ "0:adds": "passed", "0:subtracts": "failed", "1:nested": "passed" });
  });

  it("reads go test -v and cargo test results; ANSI colours are ignored", () => {
    expect(Object.fromEntries(parseTestOutput("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- SKIP: TestC").statuses)).toEqual({ TestA: "passed", TestB: "failed", TestC: "skipped" });
    expect(Object.fromEntries(parseTestOutput("test a::ok ... ok\n\x1b[31mtest a::bad ... FAILED\x1b[0m\ntest a::slow ... ignored").statuses)).toEqual({ "a::ok": "passed", "a::bad": "failed", "a::slow": "skipped" });
  });
});

describe("compareRuns / verdictOf", () => {
  const start = parseTestOutput(["PASSED t.py::keeps", "PASSED t.py::breaks", "FAILED t.py::env - ImportError", "FAILED t.py::fixed", "PASSED t.py::removed", "PASSED t.py::skipped"].join("\n"));
  const now = parseTestOutput(["PASSED t.py::keeps", "FAILED t.py::breaks", "FAILED t.py::env - ImportError", "PASSED t.py::fixed", "FAILED t.py::added", "PASSED t.py::added_ok", "SKIPPED t.py::skipped"].join("\n"));

  it("separates new failures, failing new tests, pre-existing failures, fixed, disappeared and newly skipped tests", () => {
    const comparison = compareRuns(start, now);
    expect(comparison).toMatchObject({ newFailures: ["t.py::breaks"], failingNewTests: ["t.py::added"], preExisting: ["t.py::env"], fixed: ["t.py::fixed"], disappeared: ["t.py::removed"] });
    expect(verdictOf(comparison, run(1), run(1))).toBe("regressions");
  });

  it("is clean when only pre-existing failures remain; a removed or skipped test is never clean", () => {
    const clean = compareRuns(parseTestOutput("PASSED t.py::a\nFAILED t.py::env"), parseTestOutput("PASSED t.py::a\nFAILED t.py::env\nPASSED t.py::new"));
    expect(verdictOf(clean, run(1), run(1))).toBe("clean");
    const removed = compareRuns(parseTestOutput("PASSED t.py::a\nPASSED t.py::b"), parseTestOutput("PASSED t.py::a"));
    expect(verdictOf(removed, run(0), run(0))).toBe("regressions");
    const skipped = compareRuns(parseTestOutput("PASSED t.py::a"), parseTestOutput("SKIPPED t.py::a"));
    expect(skipped.newlySkipped).toEqual(["t.py::a"]);
    expect(verdictOf(skipped, run(0), run(0))).toBe("regressions");
  });

  it("falls back to exit codes without per-test results and is inconclusive when a run was cut off", () => {
    const none = compareRuns(parseTestOutput("all good"), parseTestOutput("boom"));
    expect(verdictOf(none, run(0), run(1))).toBe("regressions");
    expect(verdictOf(none, run(1), run(1))).toBe("inconclusive");
    const cut = compareRuns(parseTestOutput("PASSED t.py::a"), parseTestOutput("PASSED t.py::a"));
    expect(verdictOf(cut, run(0), { ...run(null), timedOut: true })).toBe("inconclusive");
  });

  it("asks pytest for per-test results (without -rA's PASSES output sections) and keeps the user's options", () => {
    expect(testEnv({}).PYTEST_ADDOPTS).toBe("-rfEsxXp");
    expect(testEnv({ PYTEST_ADDOPTS: "-q" }).PYTEST_ADDOPTS).toBe("-q -rfEsxXp");
    expect(testEnv({ PYTEST_ADDOPTS: "-rfEA" }).PYTEST_ADDOPTS).toBe("-rfEA");
    expect(testEnv({ PYTEST_ADDOPTS: "-rp" }).PYTEST_ADDOPTS).toBe("-rp");
  });

  // Live stage-eval findings (docs/stage-eval.md, #5 revision): false REGRESSIONS verdicts on unchanged suites.
  it("pairs a parametrized test whose id carries a changing value (a timestamp) instead of calling it disappeared", () => {
    const comparison = compareRuns(
      parseTestOutput("PASSED t.py::test_token_expired[1794463159.1093836-True]\nPASSED t.py::test_token_expired[1794463179.1093845-False]\nPASSED t.py::other[a]"),
      parseTestOutput("PASSED t.py::test_token_expired[1794464307.1437523-True]\nPASSED t.py::test_token_expired[1794464327.143754-False]"),
    );
    expect(comparison.reparametrized).toHaveLength(2);
    expect(comparison.disappeared).toEqual(["t.py::other[a]"]);
    expect(verdictOf(compareRuns(
      parseTestOutput("PASSED t.py::f[1]\nPASSED t.py::f[2]"), parseTestOutput("PASSED t.py::f[3]\nPASSED t.py::f[4]"),
    ), run(0), run(0))).toBe("clean");
    // A failing replacement is not a match: it stays a failing new test (and the old id disappeared).
    const failing = compareRuns(parseTestOutput("PASSED t.py::f[1]"), parseTestOutput("FAILED t.py::f[2]"));
    expect(failing).toMatchObject({ reparametrized: [], disappeared: ["t.py::f[1]"], failingNewTests: ["t.py::f[2]"] });
  });

  it("pairs a failing test whose id moved (a docs line number) with a failing new id as uncertain, never a passing test with a failing one", () => {
    // tox-dev__tox-3904: the worker edited docs/how-to/usage.rst, so the ids of its already failing doc-example tests shifted.
    const start = parseTestOutput("FAILED d.py::test_doc[usage.rst:1757]\nFAILED d.py::test_doc[usage.rst:1776]\nPASSED d.py::test_doc[usage.rst:954]\nPASSED t.py::a");
    const now = parseTestOutput("FAILED d.py::test_doc[usage.rst:1761]\nFAILED d.py::test_doc[usage.rst:1780]\nPASSED d.py::test_doc[usage.rst:956]\nPASSED t.py::a");
    const comparison = compareRuns(start, now);
    expect(comparison).toMatchObject({ failingNewTests: [], disappeared: [], newFailures: [] });
    expect(comparison.reparametrized).toEqual([
      "d.py::test_doc[usage.rst:1757] -> d.py::test_doc[usage.rst:1761] (failing at both)",
      "d.py::test_doc[usage.rst:1776] -> d.py::test_doc[usage.rst:1780] (failing at both)",
      "d.py::test_doc[usage.rst:954] -> d.py::test_doc[usage.rst:956]",
    ]);
    // Probably the same pre-existing failures, but an id change proves no identity: inconclusive rather than clean or regressions.
    expect(verdictOf(comparison, run(1), run(1))).toBe("inconclusive");
    // Passing pairs alone stay clean; a real regression next to a failing pair still wins.
    expect(verdictOf(compareRuns(parseTestOutput("PASSED d.py::f[1]"), parseTestOutput("PASSED d.py::f[2]")), run(0), run(0))).toBe("clean");
    const both = compareRuns(parseTestOutput("FAILED d.py::f[1]\nPASSED t.py::a"), parseTestOutput("FAILED d.py::f[2]\nFAILED t.py::a"));
    expect(both.newFailures).toEqual(["t.py::a"]);
    expect(verdictOf(both, run(1), run(1))).toBe("regressions");
    // A skipped start id is not paired or counted as disappeared; a passing start id never absorbs a failing new id.
    const skipped = compareRuns(parseTestOutput("SKIPPED d.py::f[1]\nPASSED d.py::f[2]"), parseTestOutput("FAILED d.py::f[9]"));
    expect(skipped).toMatchObject({ reparametrized: [], disappeared: ["d.py::f[2]"], failingNewTests: ["d.py::f[9]"] });
    // One more failing id than failing start ids: the extra one is a failing new test.
    const extra = compareRuns(parseTestOutput("FAILED d.py::f[1]\nPASSED d.py::f[2]"), parseTestOutput("FAILED d.py::f[3]\nFAILED d.py::f[4]"));
    expect(extra).toMatchObject({ failingNewTests: ["d.py::f[4]"], disappeared: ["d.py::f[2]"] });
    expect(verdictOf(extra, run(1), run(1))).toBe("regressions");
  });

  it("is inconclusive, not a mass disappearance, when only one run has per-test results", () => {
    const comparison = compareRuns(parseTestOutput(Array.from({ length: 65 }, (_, i) => `FAILED t.py::case_${i}`).join("\n")), parseTestOutput("all quiet"));
    expect(comparison.oneSided).toBe(true);
    expect(verdictOf(comparison, run(1), run(0))).toBe("inconclusive");
    expect(verdictOf(compareRuns(parseTestOutput("PASSED t.py::a"), parseTestOutput("")), run(0), run(1))).toBe("regressions");
  });

  it("treats tests missing from an early-stopping or filtered run as unreached, while real new failures still count", () => {
    for (const command of ["pytest -x tests", "pytest --maxfail=1", "pytest tests 2>&1 | grep FAILED", "npx jest --bail"]) expect(partialCommand(command)).toBe(true);
    for (const command of ["pytest tests", "pytest -k 'a or b'", "pytest -k \"x|y\"", "make test || true", "pytest --exitfirstish"]) expect(partialCommand(command)).toBe(false);
    const missing = compareRuns(parseTestOutput("PASSED t.py::a\nFAILED t.py::b\nPASSED t.py::c"), parseTestOutput("PASSED t.py::a\nFAILED t.py::b"));
    expect(verdictOf(missing, run(1), run(1), { partial: true })).toBe("inconclusive");
    expect(verdictOf(missing, run(1), run(1))).toBe("regressions");
    const broken = compareRuns(parseTestOutput("PASSED t.py::a\nPASSED t.py::c"), parseTestOutput("FAILED t.py::a"));
    expect(verdictOf(broken, run(1), run(1), { partial: true })).toBe("regressions");
    // A failing test absent from the start of a partial run may just not have been reached there (pypa__build-1027, -x -n 4).
    const unreached = compareRuns(parseTestOutput("PASSED t.py::a\nFAILED t.py::b"), parseTestOutput("PASSED t.py::a\nFAILED t.py::b\nFAILED t.py::later"));
    expect(unreached.failingNewTests).toEqual(["t.py::later"]);
    expect(verdictOf(unreached, run(1), run(1), { partial: true })).toBe("inconclusive");
    expect(verdictOf(unreached, run(1), run(1))).toBe("regressions");
  });

  it("keeps the end of a very large output, where the runner summary is", async () => {
    const result = await runCommand("head -c 14000000 /dev/zero | tr '\\0' 'x' | fold -w 100; echo; echo 'PASSED t.py::last'", tmpdir(), process.env, 60_000);
    expect(result.output.length).toBeLessThan(12 * 1024 * 1024 + 256 * 1024); // the head may overshoot by one pipe chunk
    expect(result.output).toMatch(/\[regression_check: \d+ characters omitted\]/);
    expect(parseTestOutput(result.output).statuses.get("t.py::last")).toBe("passed");
  });
});

describe("StartingState on a real git work tree (node --test)", () => {
  async function repo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "orche-regression-")); roots.push(root);
    const dir = join(root, "ws");
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(join(dir, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
    await writeFile(join(dir, "test/math.test.js"), [
      'import test from "node:test"; import assert from "node:assert"; import { add, sub } from "../math.js";',
      'test("adds", () => assert.equal(add(1, 2), 3));',
      'test("subtracts", () => assert.equal(sub(3, 1), 2));',
      'test("environment", () => assert.ok(process.env.ORCHE_TEST_ENV_PRESENT, "needs a service"));',
    ].join("\n"));
    git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "start");
    return dir;
  }

  it("classifies a regression the assignment introduced apart from a pre-existing failure, without touching the user's git state", async () => {
    const dir = await repo();
    // Uncommitted work present when the assignment starts is part of its starting state.
    await writeFile(join(dir, "notes.txt"), "user work in progress\n");
    const head = git(dir, "rev-parse", "HEAD"), status = git(dir, "status", "--porcelain");
    const state = (await StartingState.capture(dir, join(dir, "..", "scratch", "start")))!;
    expect(state).toBeDefined();
    // The assignment breaks sub and adds a failing test.
    await writeFile(join(dir, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
    await writeFile(join(dir, "test/new.test.js"), 'import test from "node:test"; import assert from "node:assert"; test("new behaviour", () => assert.fail("todo"));');
    const tool = createRegressionCheckTool(() => state, { env: () => ({ ...process.env, ORCHE_TEST_ENV_PRESENT: "" }) });
    const result = await tool.execute("call-1", { command: "node --test --test-reporter=tap" }, undefined as never, undefined as never, undefined as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("REGRESSIONS");
    expect(result.details).toMatchObject({ regression: { verdict: "regressions", newFailures: ["subtracts"], failingNewTests: ["new behaviour"], preExisting: 1 } });
    expect(text).toMatch(/Pre-existing failures[^\n]*environment/);
    // Second call: the starting-state run is reused (same command), the workspace runs again; after the fix only the new test fails.
    await writeFile(join(dir, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
    await rm(join(dir, "test/new.test.js"));
    const again = await tool.execute("call-2", { command: "node --test --test-reporter=tap" }, undefined as never, undefined as never, undefined as never);
    expect(again.details).toMatchObject({ regression: { verdict: "clean", newFailures: [], failingNewTests: [], preExisting: 1 } });
    expect(state.checks.map(check => check.verdict)).toEqual(["regressions", "clean"]);
    // Outputs are kept as artifacts; the user's HEAD, index state and worktree status are unchanged by the tool.
    expect(await readFile(join(dir, (again.content[0] as { text: string }).text.match(/(\.orche\/artifacts\/regression-\S+-start\.txt)/)![1]!), "utf8")).toContain("ok");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe(status);
    await state.close();
  });

  it("is unavailable without a starting state and outside a git work tree", async () => {
    const tool = createRegressionCheckTool(() => undefined);
    const result = await tool.execute("c", { command: "true" }, undefined as never, undefined as never, undefined as never);
    expect(result.isError).toBe(true);
    const plain = await mkdtemp(join(tmpdir(), "orche-regression-plain-")); roots.push(plain);
    expect(await StartingState.capture(plain, join(plain, "scratch"))).toBeUndefined();
  });
});
