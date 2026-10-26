import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptCost, calibrationFacts, calibrationSelection, citedKind, classifyAttempt, decisionRules, groundingOf, studyCosts, driverAlive, expectedValidationUnits, isCapacityError, lastTaskFailure, MAX_CAPACITY_RERUNS, qualify, selectTasks, studyAttempts, unitAttempts,
  type CalibrationFacts, type Qualification, type UnitFacts,
} from "../../experiments/ultra-ho/r2.js";

/**
 * experiments/ultra-ho/r2.ts without any model: H2-A2's classes of an attempt (capacity stop, provider stop, harness, interrupted,
 * outcome) and the rerun bound, H2-A1 item 5 (qualification) and the selection in pool order, and the preregistered decision rules.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "ultra-ho-r2-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const jsonl = (items: unknown[]) => `${items.map(item => JSON.stringify(item)).join("\n")}\n`;
const put = async (root: string, files: Record<string, string>) => { for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); } };

const ok = (id: number) => ({ id, method: "POST", model: "gpt-6.1-sol", effort: "high", status: 200, respModel: "gpt-6.1-sol" });
const overloaded = (id: number) => ({ id, method: "POST", model: "gpt-6.1-sol", effort: "high", status: 503, providerError: { type: "server_error", code: "internal_server_error", message: "auth_unavailable: no auth available (providers=codex, model=gpt-6.1-sol; last upstream error: server_is_overloaded)" } });
const policy = (id: number) => ({ id, method: "POST", model: "gpt-6.1-sol", effort: "high", status: 200, providerError: { type: "invalid_request", code: "cyber_policy", message: "This content was flagged for possible cybersecurity risk." } });

/** One attempt directory: meta.json (completed unless `meta: null`), wire.jsonl and the last orche task's run.json. */
async function attempt(dir: string, options: { terminal?: string; wire?: unknown[]; failure?: string; meta?: null; extra?: Record<string, unknown> }) {
  const tasks = [{ dir: "s/2026-10-24T11-00-00-000Z_task-a", start: 1, status: "done" }, { dir: "s/2026-10-24T11-10-00-000Z_task-b", start: 2, status: options.terminal ?? "done" }];
  await put(dir, {
    ...(options.meta === null ? {} : { "meta.json": JSON.stringify({ status: "completed", terminal: options.terminal ?? "done", startedAt: Date.now(), tasks, wire: { requests: (options.wire ?? []).length, costUSD: 0.5, routeViolations: 0 }, ...options.extra }) }),
    "wire.jsonl": jsonl(options.wire ?? []),
    "records/s/2026-10-24T11-00-00-000Z_task-a/run.json": JSON.stringify({ status: "done", failure: "an earlier task's failure is not the last" }),
    "records/s/2026-10-24T11-10-00-000Z_task-b/run.json": JSON.stringify({ status: options.terminal ?? "done", ...(options.failure ? { failure: options.failure } : {}) }),
  });
  return dir;
}

describe("H2-A2: the class of an attempt from its meta, wire log and last orche task only", () => {
  it("capacity errors: 429/5xx or a capacity message; a content-policy refusal is not one", () => {
    expect(isCapacityError(overloaded(1))).toBe(true);
    expect(isCapacityError({ ...ok(1), status: 429, providerError: { message: "slow down" } })).toBe(true);
    expect(isCapacityError({ ...ok(1), providerError: { message: "Our servers are currently overloaded. Please try again later." } })).toBe(true);
    expect(isCapacityError({ ...ok(1), providerError: { message: "rate limit reached" } })).toBe(true);
    expect([isCapacityError(policy(1)), isCapacityError(ok(1)), isCapacityError({ ...overloaded(1), method: "GET" })]).toEqual([false, false, false]);
  });

  it("a failed unit whose last request or last orche task failure is a capacity error is a capacity stop; a policy stop, a harness failure, an interrupted unit and a recovered unit are not", async () => {
    const root = await temp();
    const byWire = classifyAttempt(await attempt(join(root, "a"), { terminal: "failed", wire: [ok(1), overloaded(2), overloaded(3)] }));
    expect(byWire).toMatchObject({ class: "capacity-stop", terminal: "failed", requests: 3, okRequests: 1, providerErrors: 2 });
    // The last request succeeded (main answered after the outage) but the orche task failed on the gateway's error.
    const byFailure = classifyAttempt(await attempt(join(root, "b"), { terminal: "failed", wire: [ok(1), overloaded(2), ok(3)], failure: "auth_unavailable: no auth available (providers=codex)" }));
    expect(byFailure).toMatchObject({ class: "capacity-stop" });
    expect(byFailure.reason).toContain("last orche task failed");
    expect(classifyAttempt(await attempt(join(root, "c"), { terminal: "failed", wire: [ok(1), policy(2)] }))).toMatchObject({ class: "provider-stop" });
    expect(classifyAttempt(await attempt(join(root, "d"), { terminal: "infra", wire: [] }))).toMatchObject({ class: "harness" });
    expect(classifyAttempt(await attempt(join(root, "e"), { terminal: "harness-error", wire: [ok(1)] }))).toMatchObject({ class: "harness" });
    expect(classifyAttempt(await attempt(join(root, "f"), { meta: null, wire: [ok(1)] }))).toMatchObject({ class: "interrupted" });
    // Recovered: capacity errors mid-run, terminal done: an ordinary outcome. A failed unit without any provider error: an outcome.
    expect(classifyAttempt(await attempt(join(root, "g"), { terminal: "done", wire: [ok(1), overloaded(2), ok(3)] }))).toMatchObject({ class: "outcome" });
    expect(classifyAttempt(await attempt(join(root, "h"), { terminal: "failed", wire: [ok(1), ok(2)], failure: "the candidates could not agree" }))).toMatchObject({ class: "outcome" });
    // Only the LAST orche task's failure counts.
    expect(lastTaskFailure(join(root, "h"), { tasks: [{ dir: "s/2026-10-24T11-10-00-000Z_task-b", start: 2 }, { dir: "s/2026-10-24T11-00-00-000Z_task-a", start: 1 }] })).toBe("the candidates could not agree");
  });

  it("a unit's status over its attempts: capacity stops are rerun at most twice, then MISSING; harness attempts do not count; a policy stop is never rerun", async () => {
    const out = await temp();
    const unit = (task: string) => ({ id: `${task}/F/r1`, task, arm: "F", repeat: 1 });
    const runs = (task: string) => join(out, "runs", task, "F");
    // Two harness attempts (the 11:27Z launch), then a capacity stop: rerun.
    await attempt(join(runs("t1"), "r1.infra-1"), { terminal: "infra" });
    await attempt(join(runs("t1"), "r1.rerun-1"), { terminal: "infra" });
    await attempt(join(runs("t1"), "r1"), { terminal: "failed", wire: [ok(1), overloaded(2)] });
    expect(unitAttempts(out, unit("t1"))).toMatchObject({ status: "rerun", capacityStops: 1 });
    // Three capacity stops (the first run and both reruns): missing.
    await attempt(join(runs("t2"), "r1.rerun-1"), { terminal: "failed", wire: [overloaded(1)] });
    await attempt(join(runs("t2"), "r1.rerun-2"), { terminal: "failed", wire: [overloaded(1)] });
    await attempt(join(runs("t2"), "r1"), { terminal: "failed", wire: [overloaded(1)] });
    expect(MAX_CAPACITY_RERUNS).toBe(2);
    expect(unitAttempts(out, unit("t2"))).toMatchObject({ status: "missing", capacityStops: 3 });
    // A capacity stop, then an outcome on the rerun: the outcome counts.
    await attempt(join(runs("t3"), "r1.rerun-1"), { terminal: "failed", wire: [overloaded(1)] });
    await attempt(join(runs("t3"), "r1"), { terminal: "done", wire: [ok(1)] });
    expect(unitAttempts(out, unit("t3"))).toMatchObject({ status: "outcome", capacityStops: 1, current: { name: "r1", class: "outcome" } });
    await attempt(join(runs("t4"), "r1"), { terminal: "failed", wire: [ok(1), policy(2)] });
    expect(unitAttempts(out, unit("t4"))).toMatchObject({ status: "missing" });
    expect(unitAttempts(out, unit("t5"))).toMatchObject({ status: "pending" });
    // H2-A3: an off-route attempt is void (harness) and counts toward the same bound as capacity stops.
    const offRoute = (id: number) => ({ ...ok(id), model: "bts/gpt-6.1-sol" });
    expect(classifyAttempt(await attempt(join(runs("t6"), "r1.rerun-1"), { terminal: "done", wire: [ok(1), offRoute(2)] }))).toMatchObject({ class: "harness", reason: expect.stringContaining("void: 1 off-route") });
    await attempt(join(runs("t6"), "r1"), { terminal: "harness-error", wire: [offRoute(1)] });
    expect(unitAttempts(out, unit("t6"))).toMatchObject({ status: "rerun", note: expect.stringContaining("H2-A3") });
    await attempt(join(runs("t7"), "r1.rerun-1"), { terminal: "failed", wire: [overloaded(1)] });
    await attempt(join(runs("t7"), "r1.rerun-2"), { terminal: "done", wire: [offRoute(1)] });
    await attempt(join(runs("t7"), "r1"), { terminal: "failed", wire: [overloaded(1)] });
    expect(unitAttempts(out, unit("t7"))).toMatchObject({ status: "missing", capacityStops: 2 });
    // Through the manifests.
    await put(out, { "manifest-x.json": JSON.stringify({ units: ["t1", "t3"].map(unit) }) });
    expect(studyAttempts(out).map(item => [item.task, item.status])).toEqual([["t1", "rerun"], ["t3", "outcome"]]);
  });

  it("costs every attempt, current and kept, from its wire log, and counts off-route requests", async () => {
    const out = await temp();
    await attempt(join(out, "runs/t1/F/r1.rerun-1"), { terminal: "failed", wire: [{ ...ok(1), costUSD: 0.01 }, { ...overloaded(2) }] , extra: { startedAt: 1 } });
    await attempt(join(out, "runs/t1/F/r1"), { terminal: "done", wire: [{ ...ok(1), costUSD: 0.5 }, { ...ok(2), costUSD: 0.25, effort: "xhigh" }, { ...ok(3), costUSD: 0.1, respModel: "gpt-5" }] , extra: { startedAt: 2 } });
    await put(out, { "manifest-p.json": JSON.stringify({ units: [{ id: "t1/F/r1", task: "t1", arm: "F", repeat: 1 }] }) });
    expect(attemptCost(join(out, "runs/t1/F/r1"), "outcome", "x")).toMatchObject({ requests: 3, ok: 3, offRoute: 2, unpriced: 0, costUSD: 0.85 });
    const costs = studyCosts(out);
    expect(costs.total).toEqual({ attempts: 2, requests: 5, ok: 4, providerErrors: 1, capacityErrors: 1, offRoute: 2, unpriced: 1, costUSD: 0.86 });
    // The attempt with off-route requests is void (class harness), never an outcome.
    expect(Object.keys(costs.byClass).sort()).toEqual(["capacity-stop", "harness"]);
    expect(costs.attempts.map(item => item.attempt)).toEqual(["t1/F/r1.rerun-1", "t1/F/r1"]);
  });

  it("an unfinished attempt under a live driver is running, never rerun; under a dead driver it is interrupted and rerun", async () => {
    const out = await temp();
    await attempt(join(out, "runs/t1/F/r1.rerun-1"), { terminal: "failed", wire: [overloaded(1)] });
    await attempt(join(out, "runs/t1/F/r1"), { meta: null, wire: [ok(1), ok(2)] });
    const unit = { id: "t1/F/r1", task: "t1", arm: "F", repeat: 1 };
    expect(unitAttempts(out, unit, true)).toMatchObject({ status: "running", capacityStops: 1 });
    expect(unitAttempts(out, unit, false)).toMatchObject({ status: "rerun", current: { class: "interrupted" } });
    await put(out, { "manifest-p.json": JSON.stringify({ units: [unit] }), "driver-p.lock": String(process.pid) });
    expect(driverAlive(out, "p")).toBe(true);
    expect(studyAttempts(out).map(item => item.status)).toEqual(["running"]);
    await put(out, { "driver-p.lock": "2147483646" });
    expect(driverAlive(out, "p")).toBe(false);
    expect(studyAttempts(out).map(item => item.status)).toEqual(["rerun"]);
    expect(driverAlive(out, "absent")).toBe(false);
  });
});

describe("H2-A1 item 5 and the selection", () => {
  const facts = (extra: Partial<CalibrationFacts> = {}): CalibrationFacts => ({
    terminal: "done", routeViolations: 0, diffFiles: ["src/a.py", "tests/test_a.py"], decisive: ["src/a.py", "src/b.py"],
    failToPass: { passed: false, detail: "1/2 passed" }, runner: { passed: true, detail: "exit 1" }, ...extra,
  });

  it("qualifies only with route compliance, an artifact, a graded fail-to-pass failure and an untouched decisive file", () => {
    expect(qualify(facts())).toMatchObject({ qualifies: true, untouched: ["src/b.py"], reasons: [] });
    expect(qualify(facts({ routeViolations: 1 })).qualifies).toBe(false);
    expect(qualify(facts({ routeViolations: null })).reasons).toContain("route compliance unknown");
    expect(qualify(facts({ diffFiles: [] })).reasons).toContain("no artifact (empty final diff)");
    expect(qualify(facts({ failToPass: { passed: true } })).reasons).toContain("hidden fail-to-pass tests all pass");
    expect(qualify(facts({ diffFiles: ["src/a.py", "src/b.py"] })).reasons).toContain("the final diff touches every decisive file");
    // Missing grades and runner failures never make headroom.
    expect(qualify(facts({ runner: { passed: false, detail: "pytest could not start" } }))).toMatchObject({ qualifies: false, checks: { f2pFails: null } });
    expect(qualify(facts({ gradeError: "no grade.json grade" }))).toMatchObject({ qualifies: false, checks: { f2pFails: null } });
    expect(qualify(facts({ failToPass: undefined })).qualifies).toBe(false);
    expect(qualify(facts({ decisive: null })).reasons).toContain("no reference fix found");
    expect(qualify(facts({ decisive: [] })).qualifies).toBe(false);
  });

  it("selects the first three qualifying tasks in pool order; determined once no earlier task must run, final only when every planned unit is accounted for", () => {
    const row = (order: number, qualifies: boolean | null, status: Qualification["status"] = "outcome"): Qualification => ({ task: `t${order}`, order, unit: `t${order}/F/r1`, status, note: status, qualifies, reasons: [] });
    expect(selectTasks([row(2, true), row(1, false), row(3, true), row(4, true), row(5, true)])).toEqual({ selected: ["t2", "t3", "t4"], determined: true, final: true });
    expect(selectTasks([row(1, true), row(2, null, "rerun"), row(3, true), row(4, true)])).toMatchObject({ selected: ["t1"], determined: false, final: false, pending: "t2: rerun" });
    expect(selectTasks([row(1, true), row(2, null, "running"), row(3, true), row(4, true)])).toMatchObject({ determined: false, final: false, pending: "t2: running" });
    // A task after the third qualifier still running: the selection is determined but not final (the run list is not complete).
    expect(selectTasks([row(1, true), row(2, false, "missing"), row(3, true), row(4, true), row(5, null, "rerun")])).toEqual({ selected: ["t1", "t3", "t4"], determined: true, final: false, pending: "t5: rerun" });
    expect(selectTasks([row(1, true), row(2, false, "missing"), row(3, true), row(4, true), row(5, false)])).toEqual({ selected: ["t1", "t3", "t4"], determined: true, final: true });
    expect(selectTasks([row(1, false), row(2, true)])).toMatchObject({ selected: ["t2"], final: true, fewerThanThree: expect.stringContaining("1 qualifying") });
    expect(selectTasks([row(1, false)]).fewerThanThree).toContain("UNRESOLVED");
  });

  it("reads a calibration unit end to end: the gold under the unit's own fixture root, the final diff and grade.json, in the plan's order", async () => {
    const root = await temp();
    const fixtures = join(root, "fixtures"), cache = join(root, "cache"), out = join(root, "cal");
    const patch = (files: string[]) => files.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`).join("");
    for (const task of ["p1", "p2"]) await put(fixtures, { [`${task}/task.json`]: "{}", [`${task}/hidden/test.patch`]: "", [`${task}/reference/fix.patch`]: patch(["src/a.py", "src/b.py", "tests/test_a.py", "docs/x.md"]) });
    await put(cache, { "p1/src/src/a.py": "x", "p2/src/src/a.py": "x" });
    const meta = (task: string) => ({ task, kind: "swe", fixtureRoot: fixtures, sweCacheSource: cache });
    const p1 = await attempt(join(out, "runs/p1/F/r1"), { terminal: "done", wire: [ok(1)], extra: meta("p1") });
    await put(p1, { "final.diff": patch(["src/a.py", "tests/test_a.py"]), "grade.json": JSON.stringify({ grade: { passed: false, checks: { failToPass: { passed: false, detail: "0/1 passed" }, passToPass: { passed: true, detail: "3/3 passed" }, runner: { passed: true, detail: "exit 1" } } } }) });
    const p2 = await attempt(join(out, "runs/p2/F/r1"), { terminal: "done", wire: [ok(1)], extra: meta("p2") });
    await put(p2, { "final.diff": patch(["src/a.py", "src/b.py"]), "grade.json": JSON.stringify({ grade: { passed: false, checks: { failToPass: { passed: false, detail: "0/1 passed" }, runner: { passed: true, detail: "exit 1" } } } }) });
    expect(await calibrationFacts(p1)).toMatchObject({ decisive: ["src/a.py", "src/b.py"], diffFiles: ["src/a.py", "tests/test_a.py"], routeViolations: 0 });
    const plan = join(root, "plan.json");
    await writeFile(plan, JSON.stringify({ out, phase: "c", seed: "s", repeats: 1, concurrency: 1, scratch: "/tmp/x", tasks: [{ task: "p2", kind: "swe" }, { task: "p1", kind: "swe" }], arms: [{ name: "F", mode: "ultra", runtime: "fixed" }] }));
    await put(out, { "manifest-c.json": JSON.stringify({ units: ["p1", "p2"].map(task => ({ id: `${task}/F/r1`, task, arm: "F", repeat: 1 })) }) });
    const selection = await calibrationSelection(out, plan);
    expect(selection.tasks.map(row => [row.order, row.task, row.qualifies, row.untouched])).toEqual([[1, "p2", false, []], [2, "p1", true, ["src/b.py"]]]);
    expect(selection).toMatchObject({ selected: ["p1"], final: true });
  });
});

describe("the decision rules (PREREGISTRATION.md)", () => {
  const unit = (task: string, arm: string, n: number, extra: Partial<UnitFacts> = {}): UnitFacts => ({ unit: `${task}/${arm}/r${n}`, task, arm, status: "outcome", note: "", terminal: "done", primaryPass: true, gradePassed: true, integrityViolations: [], handoffEnding: false, ...extra });
  const headroom = (fPasses: number, hPasses: number, extra: { hLoss?: number; hIntegrity?: number } = {}) => [
    ...[1, 2, 3, 4, 5, 6].map(n => unit(`h${Math.ceil(n / 2)}`, "F", n, { primaryPass: n <= fPasses })),
    ...[1, 2, 3, 4, 5, 6].map(n => unit(`h${Math.ceil(n / 2)}`, "H2", n, { primaryPass: n <= hPasses, ...(n <= (extra.hLoss ?? 0) ? { terminal: "failed", primaryPass: false } : {}), ...(n <= (extra.hIntegrity ?? 0) ? { integrityViolations: ["changed a test"] } : {}) })),
  ];
  const tasks = ["h1", "h2", "h3"];

  it("efficacy: supported only with at least 2 more primary passes, no higher terminal loss and no more integrity violations; no headroom task: unresolved", () => {
    expect(decisionRules(headroom(1, 3), tasks).efficacy.result).toBe("supported on these tasks");
    expect(decisionRules(headroom(1, 2), tasks).efficacy.result).toBe("not demonstrated");
    expect(decisionRules([...headroom(1, 4, { hLoss: 1 })], tasks).efficacy).toMatchObject({ result: "not demonstrated", H2: { terminalLoss: 1 } });
    expect(decisionRules(headroom(0, 4, { hIntegrity: 1 }), tasks)).toMatchObject({ efficacy: { result: "not demonstrated" }, regression: { flag: true, moreIntegrityOnHeadroom: true } });
    expect(decisionRules([], []).efficacy.result).toBe("unresolved");
    // A missing unit is not an outcome: "supported" must survive the worst case for H2, else the result is inconclusive.
    const missingH2 = decisionRules([...headroom(1, 3).slice(0, 11), unit("h3", "H2", 6, { status: "missing", primaryPass: undefined, terminal: undefined })], tasks);
    expect(missingH2.efficacy).toMatchObject({ result: "inconclusive", H2: { missing: 1 } });
    const missingF = decisionRules([...headroom(1, 3).filter(item => item.unit !== "h3/F/r6"), unit("h3", "F", 6, { status: "missing", primaryPass: undefined, terminal: undefined })], tasks);
    expect(missingF.efficacy).toMatchObject({ result: "inconclusive", F: { missing: 1 } });
    expect(decisionRules([...headroom(0, 4).filter(item => item.unit !== "h3/F/r6"), unit("h3", "F", 6, { status: "missing", primaryPass: undefined, terminal: undefined })], tasks).efficacy.result).toBe("supported on these tasks");
    expect(decisionRules([...headroom(2, 2).filter(item => item.unit !== "h3/F/r6"), unit("h3", "F", 6, { status: "missing", primaryPass: undefined, terminal: undefined })], tasks).efficacy.result).toBe("not demonstrated");
    expect(decisionRules([...headroom(1, 3), unit("x", "F", 1, { status: "rerun", note: "capacity" })], tasks)).toMatchObject({ final: false, pending: ["x/F/r1: capacity"] });
    expect(decisionRules([unit("x", "F", 1, { status: "running", note: "running" })], []).pending).toEqual(["x/F/r1: running"]);
  });

  it("completeness: final only with exactly the 4k + 4 preregistered units", () => {
    expect(expectedValidationUnits(["a"])).toEqual(["a/F/r1", "a/F/r2", "a/H2/r1", "a/H2/r2", "tox-dev__tox-3904/H2/r1", "tox-dev__tox-3904/H2/r2", "stravalib__stravalib-709_interface/H2/r1", "tobymao__sqlglot-7187/H2/r1"]);
    expect(expectedValidationUnits(["a", "b", "c"])).toHaveLength(16);
    const all = expectedValidationUnits(["a"]).map(id => { const [task, arm, repeat] = id.split("/"); return unit(task!, arm!, Number(repeat!.slice(1))); });
    expect(decisionRules(all, ["a"])).toMatchObject({ final: true, completeness: { expected: 8, found: 8, absent: [], unexpected: [] } });
    expect(decisionRules(all.slice(1), ["a"])).toMatchObject({ final: false, completeness: { found: 7, absent: ["a/F/r1"] } });
    expect(decisionRules([...all, unit("z", "F", 1)], ["a"])).toMatchObject({ final: false, completeness: { unexpected: ["z/F/r1"] } });
    // A missing H2 control leaves the regression flag incomplete, not cleared.
    const control = all.map(item => item.unit === "tobymao__sqlglot-7187/H2/r1" ? { ...item, status: "missing" as const, primaryPass: undefined } : item);
    expect(decisionRules(control, ["a"]).regression).toMatchObject({ flag: false, unknown: ["tobymao__sqlglot-7187/H2/r1"] });
  });

  it("mechanism: an H2 tox unit that assigned the TOML site, changed it and passed; gate-caused only when the gate transferred it", () => {
    const tox = (n: number, toml: UnitFacts["toml"], extra: Partial<UnitFacts> = {}) => unit("tox-dev__tox-3904", "H2", n, { toml, ...extra });
    expect(decisionRules([tox(1, { reported: true, class: "assigned", gateTransferred: false, touched: true })], []).mechanism).toMatchObject({ shown: true, gateCaused: false });
    expect(decisionRules([tox(1, { reported: true, class: "assigned", gateTransferred: true, touched: true })], []).mechanism).toMatchObject({ shown: true, gateCaused: true });
    expect(decisionRules([tox(1, { reported: true, class: "mention-only", gateTransferred: false, touched: true })], []).mechanism.shown).toBe(false);
    expect(decisionRules([tox(1, { reported: true, class: "assigned", gateTransferred: false, touched: false })], []).mechanism.shown).toBe(false);
    expect(decisionRules([tox(1, { reported: true, class: "assigned", gateTransferred: false, touched: true }, { gradePassed: false })], []).mechanism.shown).toBe(false);
    expect(decisionRules([tox(1, { reported: false, gateTransferred: false, touched: true })], []).mechanism.shown).toBe(false);
  });

  it("regression flag: a control failing under H2, an H2 unit ended by a hand-off refusal, or more H2 integrity violations on the headroom tasks", () => {
    expect(decisionRules([unit("tobymao__sqlglot-7187", "H2", 1, { primaryPass: false })], []).regression).toMatchObject({ flag: true, controlFailures: ["tobymao__sqlglot-7187/H2/r1"] });
    expect(decisionRules([unit("stravalib__stravalib-709_interface", "H2", 1)], []).regression.flag).toBe(false);
    expect(decisionRules([unit("h1", "H2", 1, { terminal: "blocked", primaryPass: false, handoffEnding: true })], ["h1"]).regression).toMatchObject({ flag: true, handoffEndings: ["h1/H2/r1"] });
    // A missing control (provider stop) is not a control failure.
    expect(decisionRules([unit("tobymao__sqlglot-7187", "H2", 1, { status: "missing", primaryPass: undefined })], []).regression.flag).toBe(false);
  });
});

describe("grounding audit of H2 reference/excluded dispositions (descriptive)", () => {
  it("classifies a cited call: reading the file or running content naming it is a content check; listing names only", () => {
    expect(citedKind({ tool: "read", args: { path: "src/a.py" }, text: "" }, "src/a.py").kind).toBe("content");
    expect(citedKind({ tool: "read", args: { path: "tests/t.py" }, text: "mentions src/a.py" }, "src/a.py")).toEqual({ kind: "unrelated", namesPath: true });
    expect(citedKind({ tool: "bash", args: { command: "git ls-files -- src/a.py src/b.py" }, text: "src/a.py" }, "src/a.py").kind).toBe("listing");
    expect(citedKind({ tool: "bash", args: { command: "sed -n 1,40p src/a.py" }, text: "" }, "src/a.py").kind).toBe("content");
    expect(citedKind({ tool: "bash", args: { command: "python -m pytest tests/test_a.py" }, text: "src/a.py:3 ok" }, "src/a.py").kind).toBe("unrelated");
    expect(citedKind({ tool: "grep", args: { pattern: "x", path: "src/a.py" }, text: "" }, "src/a.py").kind).toBe("content");
    expect(citedKind({ tool: "bash", args: { command: "echo hi" }, text: "" }, "src/a.py")).toEqual({ kind: "unrelated", namesPath: false });
  });

  it("resolves each disposition's refs in the orchestrator transcript at its candidates call, after the finding's round", async () => {
    const dir = await temp();
    const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 13, 0, s)).toISOString();
    const call = (id: string, name: string, args: unknown, s: number) => ({ type: "message", timestamp: at(s), message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
    const result = (id: string, text: string, s: number, isError = false) => ({ type: "message", timestamp: at(s), message: { role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text }] } });
    await put(dir, {
      "records/s/2026-10-24T13-00-00-000Z_task-a/events.jsonl": jsonl([
        { type: "ultra", timestamp: Date.parse(at(10)), worker: "W1", stage: "handoff", exploration: 1, findings: [{ path: "src/a.py" }, { path: "src/b.py" }, { path: "src/c.py" }] },
        { type: "ultra", timestamp: Date.parse(at(40)), worker: "W1", stage: "handoff", candidates: 1, dispositions: [
          { path: "src/a.py", exploration: 1, disposition: "excluded", reason: "out of fix scope", evidence: ["T3"] },
          { path: "src/b.py", exploration: 1, disposition: "reference", reason: "context", evidence: ["T4"] },
          { path: "src/c.py", exploration: 1, disposition: "excluded", reason: "old check", evidence: ["T1", "T9"] },
          { path: "src/d.py", exploration: 1, disposition: "assigned", by: ["W1.3"] },
        ] },
      ]),
      "records/s/workers/W1-2026-10-24T13-00-00-000Z.jsonl": jsonl([
        call("c1", "read", { path: "src/c.py" }, 1), result("c1", "body [orche ref T1]", 2),
        call("c3", "bash", { command: "git ls-files -- src/a.py src/b.py src/c.py" }, 20), result("c3", "src/a.py\nsrc/b.py [orche ref T3]", 21),
        call("c4", "read", { path: "src/b.py" }, 22), result("c4", "def b(): ... [orche ref T4]", 23),
        call("c5", "orche_spawn", { reason: "candidates", workers: [] }, 39),
      ]),
    });
    const entries = groundingOf(dir, "u/H2/r1", new Set(["src/a.py"]));
    expect(entries.map(entry => [entry.path, entry.disposition, entry.decisive, entry.verdict])).toEqual([
      ["src/a.py", "excluded", true, "listing only"], ["src/b.py", "reference", false, "content check"], ["src/c.py", "excluded", false, "unverified"],
    ]);
    expect(entries[2]!.cited).toMatchObject([{ ref: "T1", tool: "read", kind: "content", afterRound: false }, { ref: "T9", kind: "unresolved" }]);
  });
});
