/**
 * Model-free tests of the headroom-pool study harness (experiments/headroom-pool): the mechanical prescreen and exposure rules, the
 * bounded install transformations, the qualification verdict, the baseline prompt, attempt classification (refusals, truncated streams,
 * response-model failures, crashes, outage-made timeouts, budget), the slot/rerun bounds, promotion, families, the stop rule and the
 * exact intervals.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { slotState, attemptsOf } from "../../experiments/headroom-pool/driver.js";
import { aliasPatterns, factsOf, slug, type ExposureScan } from "../../experiments/headroom-pool/exposure.js";
import {
  CAL_BUDGET, CONFIRM_RUNS, EFFORT, MAX_ATTEMPTS_PER_POOL, MAX_RERUNS, MODEL, OUTAGE_IN_FLIGHT_MS, PROMOTE_MIN_CONFIRM_MISSES, SCREEN_RUNS,
  baselinePrompt, classifyAttempt, clopperPearson, codeBlocks, excludeNewerOf, exposed, families, installPlan, needsConfirmation, orderKey,
  outcomeOf, prescreen, promoted, qualifies, refusalSuspected, selectPool, stopDecision, stopOf, unitsOf, upstreamKey, type PoolEntry, type WireTotals,
} from "../../experiments/headroom-pool/protocol.js";
import { commandTestFiles, isTestPath, patchFiles } from "../../experiments/headroom-pool/score.js";
import { finalText, inFlightAt, wireOf } from "../../experiments/headroom-pool/unit.js";

const scratch = mkdtempSync(join(tmpdir(), "hp-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const wire = (over: Partial<WireTotals> = {}): WireTotals => ({ forwarded: 5, completed: 5, refusedRoute: 0, refusedUnverifiable: 0, refusedBudget: 0, providerErrors: 0, offRouteResponses: 0, unknownUsage: 0, ...over });
const events = (...messages: object[]) => messages.map(message => JSON.stringify({ type: "message_end", message: { role: "assistant", ...message } })).join("\n");

describe("the route", () => {
  it("is Sol at effort high", () => {
    expect(MODEL).toEqual({ provider: "cliproxyapi", id: "gpt-6.1-sol" });
    expect(EFFORT).toBe("high");
  });
});

describe("mechanical prescreen (M1..M3)", () => {
  const issue = "Calling `f` fails.\n\n```python\nimport pkg\npkg.f(1)\n```\n\nExpected: returns 2.";
  it("passes a bug report with a fenced reproduction and a stated expectation", () => {
    expect(prescreen({ problem_statement: issue, interface: "" })).toMatchObject({ m1NoInterface: true, m2Reproduction: true, m3Expectation: true, passed: true });
  });
  it("rejects interface tasks, traceback-only blocks and missing expectations", () => {
    expect(prescreen({ problem_statement: issue, interface: "def f(x): ..." }).passed).toBe(false);
    expect(codeBlocks("```\nTraceback (most recent call last):\n  File \"a.py\", line 1, in <module>\nValueError: bad\n```")).toEqual([]);
    expect(prescreen({ problem_statement: "```python\nimport pkg\npkg.f(1)\n```\nit breaks", interface: null }).m3Expectation).toBe(false);
  });
  it("accepts shell reproductions and REPL sessions", () => {
    expect(codeBlocks("```console\n$ tox -e py\n```")).toHaveLength(1);
    expect(codeBlocks("```pycon\n>>> import pkg\n>>> pkg.f()\n```")).toHaveLength(1);
  });
});

describe("exposure rule X and pool selection", () => {
  it("canonicalizes upstream issues and their aliases", () => {
    expect(upstreamKey("pytest-dev__pyfakefs-1286")).toBe("pyfakefs#1286");
    expect(upstreamKey("jmcgeheeiv__pyfakefs-1286")).toBe("pyfakefs#1286");
    expect(upstreamKey("narwhals-dev__narwhals-3478_interface")).toBe("narwhals#3478");
    const [full, alias] = aliasPatterns("jmcgeheeiv__pyfakefs-1286");
    expect(alias!.test(slug("results/ultra-ho/stage3/runs/pytest-dev__pyfakefs-1286/F/r1"))).toBe(true);
    expect(alias!.test(slug("results/x/pyfakefs-12860"))).toBe(false);
    expect(full!.test(slug("uho-jmcgeheeiv-pyfakefs-1286-H2-r1"))).toBe(true);
  });
  it("separates model runs from setup-only material", () => {
    const scan: ExposureScan = { dirs: ["results/advisor-reviewer/cache/swe-r2/a__b-1", "results/swe-pool/r2/build", "results/cb-ab/cases-r2/c__d-2", "results/iso-token/repos/e__f-3"], isoRuns: [{ plan: "results/iso-token/runs/p.plan.json", task: "g__h-4" }], historical: new Set(["i__j-5"]), r2Fixtures: new Set(["a__b-1"]) };
    expect(factsOf("a__b-1", scan)).toMatchObject({ modelRuns: [], setupOnly: ["fixtures/advisor-bench/swe-r2", "results/advisor-reviewer/cache"], historicalFixtureSet: false });
    expect(exposed(factsOf("a__b-1", scan))).toBe(false);
    expect(exposed(factsOf("c__d-2", scan))).toBe(true);
    expect(exposed(factsOf("e__f-3", scan))).toBe(false);
    expect(exposed(factsOf("g__h-4", scan))).toBe(true);
    expect(exposed(factsOf("i__j-5", scan))).toBe(true);
    expect(factsOf("k__h-4", scan, new Map([["h#4", "g__h-4"]])).duplicateOf).toBe("g__h-4");
    expect(exposed(factsOf("x__smolvm-172", scan))).toBe(true);
  });
  it("orders by the seeded key and caps the pool; every exclusion keeps its reason", () => {
    const entry = (id: string, over: Partial<PoolEntry> = {}): PoolEntry => ({ id, upstream: upstreamKey(id), order: orderKey(id), split: "s", createdAt: "", repo: "o/r", prescreen: { m1NoInterface: true, m2Reproduction: true, m3Expectation: true, codeBlocks: 1, passed: true }, exposure: { modelRuns: [], historicalFixtureSet: false, setupOnly: [], named: false }, ...over });
    const entries = ["a__x-1", "a__x-2", "a__x-3", "a__x-4"].map(id => entry(id));
    entries.push(entry("a__x-5", { exposure: { modelRuns: ["results/cb-ab/cases"], historicalFixtureSet: false, setupOnly: [], named: false } }));
    const { pool, excluded } = selectPool(entries, 3);
    expect(pool).toHaveLength(3);
    expect(pool.map(item => item.order)).toEqual([...pool.map(item => item.order)].sort());
    expect(excluded.map(item => item.excluded)).toEqual(expect.arrayContaining(["X: exposed in an earlier study", "cap: beyond the first 3"]));
  });
});

describe("E1 install transformations (bounded)", () => {
  const py = "/v/bin/python", date = "2026-01-08T00:00:00Z";
  it("maps pip installs to uv pip with the date cut-off, non-editable", () => {
    const plan = installPlan("pip install -q -e .[test] && pip install pytest pytest-cov --quiet", py, date);
    expect(plan).toEqual({ ok: true, steps: [{ kind: "uv-pip", argv: ["uv", "pip", "install", "--python", py, "--exclude-newer", date, ".[test]"] }, { kind: "uv-pip", argv: ["uv", "pip", "install", "--python", py, "--exclude-newer", date, "pytest", "pytest-cov"] }] });
    expect(installPlan("pip install -q -ve . --no-build-isolation", py, date)).toMatchObject({ ok: true, steps: [{ argv: expect.arrayContaining([".", "--no-build-isolation"]) }] });
    expect(installPlan("pip install -r requirements-tests.txt -q", py, date)).toMatchObject({ ok: true, steps: [{ argv: expect.arrayContaining(["-r", "requirements-tests.txt"]) }] });
  });
  it("drops container plumbing and handles uv and submodules", () => {
    expect(installPlan("pip install uv --quiet && cd /testbed && uv pip install -e \".[all]\" --system --quiet", py, date)).toMatchObject({ ok: true, steps: [{ kind: "uv-pip", argv: expect.arrayContaining([".[all]"]) }] });
    expect(installPlan("export DEBIAN_FRONTEND=noninteractive && pip install -q uv && uv venv && source .venv/bin/activate && uv pip install -q -e .[dev]", py, date)).toMatchObject({ ok: true, steps: [{ kind: "uv-pip" }] });
    expect(installPlan("pip install -q uv && uv sync --group test -q", py, date)).toMatchObject({ ok: true, steps: [{ kind: "uv-sync", argv: ["uv", "sync", "--python", py, "--frozen", "--no-editable", "--group", "test"] }] });
    expect(installPlan("git submodule update --init --recursive && pip install -q -e .[test]", py, date)).toMatchObject({ ok: true, steps: [{ kind: "submodules" }, { kind: "uv-pip" }] });
  });
  it("refuses system packages, other scripts and other indexes", () => {
    expect(installPlan("apt-get update && pip install .", py, date).ok).toBe(false);
    expect(installPlan("pip install -q -r requirements.txt && python pip_build.py --install", py, date).ok).toBe(false);
    expect(installPlan("pip install --index-url https://x/simple pkg", py, date).ok).toBe(false);
    expect(installPlan("export HOME=/root && pip install .", py, date).ok).toBe(false);
    expect(installPlan("pip install --upgrade pip", py, date)).toEqual({ ok: false, reason: "no install step" });
  });
  it("cuts dependencies off one day after the record", () => {
    expect(excludeNewerOf("2026-01-07 16:47:41")).toBe("2026-01-08");
    expect(excludeNewerOf("2025-12-31T23:00:00Z")).toBe("2026-01-01");
  });
});

describe("qualification verdict (E4, E5, E7)", () => {
  it("needs every pre-fix run to fail and every reference run to pass", () => {
    expect(qualifies({ prefix: ["fail", "fail"], reference: ["pass", "pass"] }).qualified).toBe(true);
    expect(qualifies({ prefix: ["fail", "pass"], reference: ["pass", "pass"] })).toMatchObject({ qualified: false, failed: "E4" });
    expect(qualifies({ prefix: ["fail", "fail"], reference: ["pass", "fail"] })).toMatchObject({ qualified: false, failed: "E5" });
    expect(qualifies({ prefix: ["fail", "untrusted"], reference: ["pass", "pass"] })).toMatchObject({ qualified: false, failed: "E7" });
    expect(qualifies({ prefix: ["fail"], reference: ["pass", "pass"] })).toMatchObject({ qualified: false, failed: "E7" });
  });
});

describe("the baseline prompt", () => {
  it("carries the issue verbatim with the ordinary instruction, the budget and the constraints, and nothing about witnesses", () => {
    const issue = "Bug: `f(1)` returns 3.\n```python\nimport pkg\nprint(pkg.f(1))\n```\nExpected 2.";
    const prompt = baselinePrompt({ problemStatement: issue });
    expect(prompt).toContain(issue);
    expect(prompt).toContain("Hidden tests written by the maintainers will check the fix; the existing tests must keep passing.");
    expect(prompt).toContain(`at most ${CAL_BUDGET.maxRequests} model requests and ${CAL_BUDGET.wallMs / 60_000} minutes`);
    expect(prompt).toContain("no git commits");
    expect(prompt).not.toMatch(/witness|reproducer\.py|WITNESS|headroom/i);
  });
});

describe("attempt classification", () => {
  const ok = { code: 0, guardFired: false };
  it("a turn end with exit 0 is valid", () => {
    expect(stopOf(events({ stopReason: "stop" }), ok, wire())).toEqual({ stop: "turn-end", detail: "stop" });
    expect(classifyAttempt({ stop: "turn-end", wire: wire(), inFlightAtEndMs: 0, refusalSuspected: false })).toEqual({ valid: true, terminal: "turn-end" });
  });
  it("a turn end with a non-zero exit is a crash (invalid)", () => {
    expect(stopOf(events({ stopReason: "stop" }), { code: 1, guardFired: false }, wire()).stop).toBe("crash");
    expect(classifyAttempt({ stop: "crash", wire: wire(), inFlightAtEndMs: 0, refusalSuspected: false })).toMatchObject({ valid: false, invalid: "infrastructure" });
  });
  it("output-length stops are invalid, not completions", () => {
    expect(stopOf(events({ stopReason: "length" }), ok, wire()).stop).toBe("length");
    expect(classifyAttempt({ stop: "length", wire: wire(), inFlightAtEndMs: 0, refusalSuspected: false })).toMatchObject({ valid: false, invalid: "infrastructure" });
  });
  it("an HTTP-200 error event or a 5xx ending the session is capacity (invalid)", () => {
    expect(stopOf(events({ stopReason: "error", errorMessage: "upstream overloaded" }), ok, wire({ providerErrors: 1 })).stop).toBe("provider-error");
    expect(classifyAttempt({ stop: "provider-error", wire: wire({ providerErrors: 1 }), inFlightAtEndMs: 0, refusalSuspected: false })).toMatchObject({ valid: false, invalid: "capacity" });
  });
  it("a truncated stream or one without a verifiable response model is off-route (invalid)", () => {
    const offRoute = wire({ offRouteResponses: 1 });
    expect(stopOf(events({ stopReason: "stop" }), ok, offRoute).stop).toBe("route-refused");
    expect(classifyAttempt({ stop: "turn-end", wire: offRoute, inFlightAtEndMs: 0, refusalSuspected: false })).toMatchObject({ valid: false, invalid: "off-route" });
    expect(classifyAttempt({ stop: "turn-end", wire: wire({ refusedUnverifiable: 1 }), inFlightAtEndMs: 0, refusalSuspected: false })).toMatchObject({ valid: false, invalid: "off-route" });
  });
  it("time runs out: valid, unless a request hung (an outage)", () => {
    expect(stopOf(events({ stopReason: "toolUse" }), { code: null, guardFired: true }, wire()).stop).toBe("time");
    expect(classifyAttempt({ stop: "time", wire: wire(), inFlightAtEndMs: 30_000, refusalSuspected: false })).toEqual({ valid: true, terminal: "time" });
    expect(classifyAttempt({ stop: "time", wire: wire({ completed: 4 }), inFlightAtEndMs: OUTAGE_IN_FLIGHT_MS, refusalSuspected: false })).toMatchObject({ valid: false, invalid: "capacity" });
  });
  it("the request budget ends a valid attempt", () => {
    expect(stopOf(events({ stopReason: "error", errorMessage: "request budget of 120 model requests for this session is spent" }), ok, wire({ refusedBudget: 1 })).stop).toBe("budget");
    expect(classifyAttempt({ stop: "budget", wire: wire({ refusedBudget: 1 }), inFlightAtEndMs: 0, refusalSuspected: false })).toEqual({ valid: true, terminal: "budget" });
  });
  it("no model request or no assistant message is infrastructure", () => {
    expect(stopOf("", { code: 1, guardFired: false }, wire({ forwarded: 0, completed: 0 })).stop).toBe("no-model");
    expect(stopOf("", { code: 1, guardFired: false }, wire()).stop).toBe("crash");
  });
  it("a provider refusal with no change is invalid; an empty change alone is a valid outcome", () => {
    expect(refusalSuspected("I can't help with that request.", 0)).toBe(true);
    expect(refusalSuspected("No change is needed: the behaviour is correct.", 0)).toBe(false);
    expect(refusalSuspected("I can't help with that request.", 2)).toBe(false);
    expect(classifyAttempt({ stop: "turn-end", wire: wire(), inFlightAtEndMs: 0, refusalSuspected: true })).toMatchObject({ valid: false, invalid: "refusal" });
  });
  it("reads wire totals without inventing usage, and finds requests still in flight", () => {
    expect(wireOf({ forwarded: 3, completed: 2, refused: { budget: 1 }, unknownUsage: 1 })).toMatchObject({ forwarded: 3, completed: 2, refusedBudget: 1, unknownUsage: 1, providerErrors: 0 });
    const log = join(scratch, "wire.jsonl");
    writeFileSync(log, [JSON.stringify({ phase: "start", id: 1, at: "2026-10-25T00:00:00.000Z" }), JSON.stringify({ phase: "end", id: 1, at: "2026-10-25T00:00:05.000Z" }), JSON.stringify({ phase: "start", id: 2, at: "2026-10-25T00:01:00.000Z" })].join("\n"));
    expect(inFlightAt(log, Date.parse("2026-10-25T00:11:00.000Z"))).toEqual({ count: 1, oldestMs: 600_000 });
    expect(finalText(events({ content: [{ type: "text", text: "first" }] }, { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }] }))).toBe("done");
  });
  it("outcomes: only a valid attempt with a failing public witness is a miss", () => {
    expect(outcomeOf({ valid: true, witness: "fail" })).toBe("miss");
    expect(outcomeOf({ valid: true, witness: "pass" })).toBe("solved");
    expect(outcomeOf({ valid: true, witness: "untrusted" })).toBe("unscored");
    expect(outcomeOf({ valid: false, witness: "fail" })).toBe("invalid");
  });
});

describe("schedule, reruns, promotion, families, stop", () => {
  it("names the screening and confirmation units", () => {
    expect(unitsOf("c", "screen").map(unit => unit.name)).toEqual(["c-s1", "c-s2"]);
    expect(unitsOf("c", "confirm").map(unit => unit.name)).toEqual(["c-c1", "c-c2", "c-c3"]);
    expect([SCREEN_RUNS, CONFIRM_RUNS, PROMOTE_MIN_CONFIRM_MISSES, MAX_RERUNS]).toEqual([2, 3, 2, 1]);
    expect(MAX_ATTEMPTS_PER_POOL).toBe(200);
  });
  it("reruns an invalid attempt once, never a valid one; an invalid slot after its rerun is missing", () => {
    const unit = unitsOf("c", "screen")[0]!;
    const done = (outcome: string, n: number) => ({ n, dir: `/x/attempt-${n}`, completed: true, valid: outcome !== "invalid", outcome: outcome as any });
    expect(slotState(unit, []).outcome).toBe("pending");
    expect(slotState(unit, [done("miss", 1)]).outcome).toBe("miss");
    expect(slotState(unit, [done("invalid", 1)]).outcome).toBe("pending");
    expect(slotState(unit, [done("invalid", 1), done("solved", 2)]).outcome).toBe("solved");
    expect(slotState(unit, [done("invalid", 1), done("invalid", 2)]).outcome).toBe("missing");
    expect(slotState(unit, [{ n: 1, dir: "/x/.interrupted-1", completed: false, interrupted: true, outcome: "interrupted" }, done("invalid", 2)]).outcome).toBe("missing");
  });
  it("lists attempts and archived interruptions of a unit directory", () => {
    const dir = join(scratch, "unit");
    mkdirSync(join(dir, "attempt-2"), { recursive: true });
    mkdirSync(join(dir, ".interrupted-1"), { recursive: true });
    writeFileSync(join(dir, "attempt-2", "meta.json"), JSON.stringify({ status: "completed", valid: true }));
    writeFileSync(join(dir, "attempt-2", "score.json"), JSON.stringify({ outcome: "miss" }));
    expect(attemptsOf(dir).map(item => [item.n, item.outcome])).toEqual([[1, "interrupted"], [2, "miss"]]);
  });
  it("promotes only after a screening miss and two confirmation misses", () => {
    expect(needsConfirmation(["solved", "miss"])).toBe(true);
    expect(needsConfirmation(["solved", "missing"])).toBe(false);
    expect(promoted({ case: "a", repo: "o/a", screen: ["miss", "solved"], confirm: ["miss", "miss", "solved"] })).toBe(true);
    expect(promoted({ case: "a", repo: "o/a", screen: ["miss", "miss"], confirm: ["miss", "solved", "missing"] })).toBe(false);
    expect(promoted({ case: "a", repo: "o/a", screen: ["solved", "solved"], confirm: ["miss", "miss", "miss"] })).toBe(false);
  });
  it("groups promoted cases into families by repository and behaviour class", () => {
    const hard = (id: string, repo: string, mechanism?: string) => ({ case: id, repo, screen: ["miss" as const], confirm: ["miss" as const, "miss" as const], ...(mechanism ? { mechanism } : {}) });
    expect(families([hard("a1", "o/a"), hard("a2", "o/a"), hard("b", "o/b")]).map(family => family.cases)).toEqual([["a1", "a2"], ["b"]]);
    expect(families([hard("a", "o/a", "same"), hard("b", "o/b", "same")])).toHaveLength(1);
    expect(stopDecision("A", 2)).toBe("done");
    expect(stopDecision("A", 1)).toBe("pool-B");
    expect(stopDecision("B", 1)).toBe("negative");
  });
});

describe("exact intervals", () => {
  it("Clopper-Pearson matches known values", () => {
    const [lo1, hi1] = clopperPearson(1, 3);
    expect(lo1).toBeCloseTo(0.0084, 3); expect(hi1).toBeCloseTo(0.9057, 3);
    const [lo2, hi2] = clopperPearson(3, 3);
    expect(lo2).toBeCloseTo(0.2924, 3); expect(hi2).toBe(1);
    expect(clopperPearson(0, 5)[0]).toBe(0); expect(clopperPearson(0, 5)[1]).toBeCloseTo(0.5218, 3);
    expect(clopperPearson(0, 0)).toEqual([0, 1]);
  });
});

describe("scoring helpers", () => {
  it("finds test files of a command and of a patch, and the test-file rule", () => {
    expect(commandTestFiles("pytest -rA tests/test_a.py tests/test_b.py::test_x -p no:cacheprovider")).toEqual(["tests/test_a.py", "tests/test_b.py"]);
    expect(patchFiles("diff --git a/tests/t.py b/tests/t.py\n--- a/tests/t.py\n+++ b/tests/t.py\n")).toEqual(["tests/t.py"]);
    expect(isTestPath("tests/test_core.py")).toBe(true);
    expect(isTestPath("pkg/conftest.py")).toBe(true);
    expect(isTestPath("pkg/core.py")).toBe(false);
  });
});

describe("families: shared repository OR shared behaviour class, transitively", () => {
  const hard = (id: string, repo: string, mechanism?: string) => ({ case: id, repo, screen: ["miss" as const], confirm: ["miss" as const, "miss" as const], ...(mechanism ? { mechanism } : {}) });
  it("joins a repository's classes with another repository that shares one of them, in any order", () => {
    expect(families([hard("r1", "o/r", "X"), hard("r2", "o/r", "Y"), hard("s", "o/s", "Y")])).toHaveLength(1);
    expect(families([hard("s", "o/s", "Y"), hard("r1", "o/r", "X"), hard("r2", "o/r", "Y")])).toHaveLength(1);
    expect(families([hard("r1", "o/r", "X"), hard("s", "o/s", "Y")])).toHaveLength(2);
    expect(families([hard("r1", "o/r", "X"), { ...hard("t", "o/t", "X"), confirm: ["miss" as const, "solved" as const] }])).toEqual([{ family: "X", cases: ["r1"] }]);
  });
});

describe("harness errors and frozen inputs", () => {
  it("records a harness exception as a completed infrastructure-invalid attempt that keeps its wire totals", async () => {
    const { markHarnessError } = await import("../../experiments/headroom-pool/driver.js");
    const unitDirPath = join(scratch, "harness-error"), dir = join(unitDirPath, "attempt-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ unit: "c-s1", case: "c", attempt: 1, status: "running" }));
    writeFileSync(join(dir, "wire.jsonl.totals.json"), JSON.stringify({ forwarded: 2, completed: 1 }));
    const meta = markHarnessError(dir, unitsOf("c", "screen")[0]!, 1, new Error("staging failed"));
    expect(meta).toMatchObject({ status: "completed", valid: false, invalid: "infrastructure", wire: { forwarded: 2, completed: 1 } });
    expect(meta.invalidDetail).toContain("staging failed");
    expect(attemptsOf(unitDirPath)).toEqual([expect.objectContaining({ n: 1, completed: true, valid: false, outcome: "invalid" })]);
    expect(slotState(unitsOf("c", "screen")[0]!, attemptsOf(unitDirPath)).outcome).toBe("pending");
  });
  it("digests the frozen provider copy without its FROZEN.json and detects a changed file", async () => {
    const { providerDigest } = await import("../../experiments/headroom-pool/unit.js");
    const dir = join(scratch, "provider");
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeFileSync(join(dir, "extensions", "index.ts"), "export {}\n");
    const before = providerDigest(dir);
    writeFileSync(join(dir, "FROZEN.json"), "{}");
    expect(providerDigest(dir)).toBe(before);
    writeFileSync(join(dir, "extensions", "index.ts"), "export const x = 1\n");
    expect(providerDigest(dir)).not.toBe(before);
  });
});

describe("unit proxy socket path (A4)", () => {
  it("stays under the Unix socket limit for long unit directories and refuses an over-long root", async () => {
    const { socketPath } = await import("../../experiments/headroom-pool/unit.js");
    const previous = process.env.HEADROOM_SOCKET_DIR;
    try {
      process.env.HEADROOM_SOCKET_DIR = "/var/tmp/pi-arthur/pi-orche/01a152d6-1832-7291-b05c-3e9a404e5ca3/W9/k";
      const longDir = "/var/tmp/pi-arthur/pi-orche/01a152d6-1832-7291-b05c-3e9a404e5ca3/W9/scratch/units/koxudaxi__datamodel-code-generator-3046-s1-a1/proxy";
      const path = socketPath(longDir);
      expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
      expect(path).toMatch(/\/k\/[0-9a-f]{12}\.sock$/);
      expect(socketPath(`${longDir}2`)).not.toBe(path);
      delete process.env.HEADROOM_SOCKET_DIR;
      expect(() => socketPath(longDir)).toThrow(/too long/);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_SOCKET_DIR; else process.env.HEADROOM_SOCKET_DIR = previous;
    }
  });
});

describe("generated summary wording (report fidelity)", () => {
  it("names witness passes and failures as such, keeps hidden, regression and infrastructure results separate, promotes on raw outcomes and computes no pooled bound", async () => {
    const { summarize, DEFINITIONS } = await import("../../experiments/headroom-pool/analyze.js");
    const out = join(scratch, "summary-out");
    const paths = { repo: scratch, out, roots: { cache: join(scratch, "c"), scratch: join(scratch, "s") } };
    const attempt = (unit: string, n: number, meta: object, score?: object) => {
      const dir = join(out, "calibration", "A", "units", unit, `attempt-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ status: "completed", ...meta }));
      if (score) writeFileSync(join(dir, "score.json"), JSON.stringify(score));
    };
    const valid = { valid: true, terminal: "turn-end", wire: { forwarded: 3, completed: 3, costUSD: 0.1 } };
    const witness = (outcome: "solved" | "miss", over: object = {}) => ({ outcome, witness: { status: outcome === "solved" ? "pass" : "fail" }, hidden: { f2pPassed: 1, f2pTotal: 2, resolved: false }, regressions: { nowNotPassing: [] }, integrity: { testFilesChanged: [] }, ...over });
    // Task t: an infrastructure-invalid attempt then a witness pass with a hidden failure and a visible regression; a second witness pass.
    attempt("t-s1", 1, { valid: false, invalid: "infrastructure", invalidDetail: "harness error", wire: { forwarded: 0, completed: 0 } });
    attempt("t-s1", 2, valid, witness("solved", { regressions: { nowNotPassing: ["tests/test_x.py::test_y"] } }));
    attempt("t-s2", 1, valid, witness("solved"));
    // Task u: a screening witness failure, then two of three confirmation failures (promoted on the raw outcomes).
    attempt("u-s1", 1, valid, witness("miss"));
    attempt("u-s2", 1, valid, witness("solved"));
    for (const [unit, outcome] of [["u-c1", "miss"], ["u-c2", "miss"], ["u-c3", "solved"]] as const) attempt(unit, 1, valid, witness(outcome));
    const plan = { pool: "A", planDigest: "d", cases: [{ id: "t", repo: "o/r", order: 0 }, { id: "u", repo: "o/u", order: 1 }] } as any;
    const summary = summarize(paths as any, plan);
    expect(summary.screening).toMatchObject({ tasks: 2, slots: 4, witnessPassed: 3, witnessFailed: 1, missing: 0, pending: 0 });
    expect(summary.confirmation).toMatchObject({ cases: 1, slots: 3, witnessFailed: 2, witnessPassed: 1 });
    expect(summary.screening).not.toHaveProperty("solved");
    const [t, u] = summary.cases;
    expect(t!.screen).toEqual(["witness-pass", "witness-pass"]);
    expect(u!.screen).toEqual(["witness-fail", "witness-pass"]);
    expect(t!.hidden).toEqual(["t-s1:1/2", "t-s2:1/2"]);
    expect(t!.confirmation.ci95).toBeNull();
    expect(u!.confirmation.ci95).toHaveLength(2);
    expect(summary.promoted).toEqual(["u"]);
    expect(summary.families).toEqual([{ family: "repo:o/u", cases: ["u"] }]);
    const rows = summary.attempts.filter(row => row.case === "t");
    expect(rows.map(row => [row.unit, row.n, row.valid, row.invalid, row.outcome, row.regressions])).toEqual([["t-s1", 1, false, "infrastructure", undefined, undefined], ["t-s1", 2, true, undefined, "witness-pass", 1], ["t-s2", 1, true, undefined, "witness-pass", 0]]);
    expect(summary.ledger).toMatchObject({ attempts: 8, validAttempts: 7, invalidAttempts: 1, requests: 21 });
    expect(summary.definitions["witness-pass"]).toContain("not full-task correctness");
    expect(DEFINITIONS.counts).toContain("no pooled interval");
    expect(t!.confirmation.ci95Scope).toContain("this case's own confirmation sessions only");
    for (const aggregate of [summary.screening, summary.confirmation]) expect(Object.keys(aggregate).some(key => /ci|bound|interval/i.test(key))).toBe(false);
  });
});
