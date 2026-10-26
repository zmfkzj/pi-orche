/** The decision-audit rescue pilot (experiments/strong-reflection/bench/pilot): texts, schedule, budget, proxy gates, fidelity, read-out. */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRONG_REFLECTION_PROMPT } from "../../src/single/reflection.js";
import { deepReplace, loadWire, rewriteSse, WireProxy } from "../../experiments/strong-reflection/bench/wire.js";
import { AUDIT, BUDGET, FOUR_LINES, JOBS, PATH_MAP, PILOT_TEXT_RE, REACHABLE, admits, armBody, clusterOf, pilotLivePath, pilotOrder, pilotText, readout, requestReservationUsd, settlementUsd, type Outcome } from "../../experiments/strong-reflection/bench/pilot/protocol.js";
import { Ledger } from "../../experiments/strong-reflection/bench/pilot/budget.js";
import { compareCheckpoint } from "../../experiments/strong-reflection/bench/pilot/fidelity.js";
import { changedFiles, reconcile, testTransitions } from "../../experiments/strong-reflection/bench/pilot/evaluate.js";
import { mkdir as mkdirP, writeFile as writeFileP } from "node:fs/promises";
import { failureSections } from "../../experiments/strong-reflection/bench/pilot/diagnose.js";

const open: { close(): unknown }[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const item of open.splice(0)) await item.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "srb-pilot-")); dirs.push(dir); return dir; };

async function upstream() {
  let calls = 0;
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { calls++; res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":10,"input_tokens_details":{"cached_tokens":0}}}}\n\n`); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise(resolve => server.close(resolve)) });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls: () => calls };
}
const post = async (base: string, body: unknown) => { const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }); return { status: response.status, text: await response.text() }; };
const worker = (key: string, calls: string[], model = "gpt-6-astra") => ({ prompt_cache_key: key, instructions: "You are a persistent coding worker.", model, reasoning: { effort: "high" }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Intent/Purpose task" }] }, ...calls.map(id => ({ type: "function_call", call_id: id, name: "read", arguments: "{}" }))] });
const advisor = (key: string, text = "plan") => ({ prompt_cache_key: key, instructions: "You are a read-only advisor of a coding agent (the worker).", model: "gpt-6-astra", reasoning: { effort: "high" }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] });

/** A recording: top worker 0,1 | advisor 0 | checkpoint at top ordinal 2 | top 2 | advisor 1 (after the checkpoint). */
async function recording(dir: string) {
  const up = await upstream();
  const record = new WireProxy({ mode: "record", upstream: up.url, wireFile: join(dir, "o.jsonl") });
  const base = await record.listen(); open.push(record);
  await post(base, worker("w", []));
  await post(base, advisor("a"));
  await post(base, worker("w", ["c1"]));
  record.markCheckpoint("integrate", "verify");
  await post(base, worker("w", ["c1", "c2"]));
  await post(base, advisor("a"));
  return { recording: loadWire(join(dir, "o.jsonl")), checkpoint: record.checkpoint! };
}

describe("pilot texts", () => {
  it("A is the audit alone, B the unchanged four lines then the identical audit, C0 nothing", () => {
    expect(FOUR_LINES).toBe(STRONG_REFLECTION_PROMPT);
    const rt = "results/strong-reflection/bench-2026-10-19/rt/src/single/reflection.ts";
    if (existsSync(rt)) for (const line of FOUR_LINES.split("\n")) expect(readFileSync(rt, "utf8")).toContain(line);
    const a = pilotText("A", "verify"), b = pilotText("B", "verify");
    expect(a.split(AUDIT).length - 1).toBe(1);
    expect(b.split(AUDIT).length - 1).toBe(1);
    expect(a).not.toContain(FOUR_LINES.split("\n")[0]);
    expect(b).toContain(`${FOUR_LINES}\n\n${AUDIT}`);
    expect(b.replace(`${FOUR_LINES}\n\n`, "")).toBe(a);
    expect(pilotText("C0", "verify")).toBe("");
    expect(armBody("C0")).toBe("");
    expect(`plan\n${a}`.replace(PILOT_TEXT_RE, "")).toBe("plan");
    expect(`plan\n${b}`.replace(PILOT_TEXT_RE, "")).toBe("plan");
  });

  it("the audit carries no task, domain or hidden-test content", () => {
    for (const word of [/tox/i, /isort/i, /docstub/i, /callable/i, /callback/i, /architecture|\bISA\b|arm64|x86/i, /type: ?ignore|mypy/i, /factor/i, /outbox/i, /hidden/i, /maintainer/i]) expect(pilotText("B", "verify")).not.toMatch(word);
  });
});

describe("pilot schedule", () => {
  it("16 units in pre-declared tiers, seeded and deterministic arm orders", () => {
    expect(JOBS.map(job => job.unit).sort()).toEqual(["d1-transactional-r1", "d1-transactional-r2", "d1-transactional-r3", "d1-transactional-r4", "docstub-123-r1", "docstub-123-r2", "docstub-123-r3", "docstub-123-r4", "isort-2491-r1", "isort-2491-r2", "isort-2491-r3", "isort-2491-r4", "tox-3904-r1", "tox-3904-r2", "tox-3904-r3", "tox-3904-r4"]);
    expect(JOBS.reduce((sum, job) => sum + job.arms.length, 0)).toBe(36);
    for (const job of JOBS) {
      expect([...job.arms].sort()).toEqual(job.cluster === "C1" ? ["A", "B", "C0"] : ["A", "B"]);
      expect(pilotOrder(job.unit, [...job.arms].sort())).toEqual(job.arms);
      expect(job.tier).toBe(REACHABLE.includes(job.cluster) || job.cluster === "D" ? 1 : 2);
    }
    const tier1 = JOBS.filter(job => job.tier === 1).length;
    expect(JOBS.slice(0, tier1).every(job => job.tier === 1)).toBe(true);
    expect([clusterOf("tox-3904-r2"), clusterOf("docstub-123-r1"), clusterOf("docstub-123-r3"), clusterOf("isort-2491-r1"), clusterOf("isort-2491-r4"), clusterOf("d1-transactional-r4")]).toEqual(["C1", "C2", "C3", "C4", "C5", "D"]);
    expect(new Set(JOBS.map(job => job.arms[0])).size).toBeGreaterThan(1);
  });
});

describe("pilot budget", () => {
  it("reserves before forwarding, settles at usage, and refuses past the gate or the arm cap", async () => {
    expect(requestReservationUsd(330_000, true)).toBeCloseTo(100_000 * 10 / 1e6 + 0.4, 6);
    expect(requestReservationUsd(330_000, false)).toBeCloseTo(100_000 * BUDGET.laterInputPerM / 1e6 + 0.4, 6);
    expect(settlementUsd({ input: 1000, cached: 0, output: 10 }, 200, 9)).toBeCloseTo(0.0105, 6);
    expect(settlementUsd(undefined, 429, 9)).toBe(0);
    expect(settlementUsd(undefined, 200, 9)).toBe(9);
    expect(admits(30, 10, 5)).toBe(true);
    expect(admits(30, 10, 5.01)).toBe(false);
    const ledger = new Ledger(await temp(), 10, 1);
    expect(ledger.reserve({ id: "1", unit: "u", arm: "A", usd: 4, armCapUsd: 6 })).toEqual({ ok: true });
    expect(ledger.reserve({ id: "2", unit: "u", arm: "A", usd: 2.5, armCapUsd: 6 }).ok).toBe(false);
    expect(ledger.reserve({ id: "3", unit: "v", arm: "B", usd: 5, armCapUsd: 6 })).toEqual({ ok: true });
    expect(ledger.reserve({ id: "4", unit: "w", arm: "B", usd: 0.5, armCapUsd: 6 }).ok).toBe(false);
    ledger.settle("1", 1.5);
    expect(ledger.state()).toMatchObject({ settledUsd: 1.5, outstandingUsd: 5, committedUsd: 6.5, reservations: 2, refusals: 2 });
    expect(ledger.reserve({ id: "5", unit: "w", arm: "B", usd: 2, armCapUsd: 6 })).toEqual({ ok: true });
    expect(ledger.state().byArm).toEqual({ "u/A": 1.5, "v/B": 5, "w/B": 2 });
  });
});

describe("pilot proxy gates", () => {
  it("offline: no request reaches the upstream, and the replay still reaches its reflection point", async () => {
    const dir = await temp();
    const { recording: rec, checkpoint } = await recording(dir);
    const up = await upstream();
    const proxy = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "dry.jsonl"), recording: rec, checkpoint, speed: 0, offline: true, strictPrefix: true });
    const base = await proxy.listen(); open.push(proxy);
    expect((await fetch(`${base}/v1/models`)).status).toBe(503); // not forwarded, but no halt: the dry replay goes on
    expect((await post(base, worker("w2", []))).status).toBe(200);
    expect((await post(base, advisor("a2"))).status).toBe(200);
    expect((await post(base, worker("w2", ["c1"]))).status).toBe(200);
    expect((await post(base, worker("w2", ["c1", "c2"]))).status).toBe(503); // the switch request
    expect((await post(base, advisor("a2"))).status).toBe(503); // a helper request after the checkpoint
    expect(proxy.switched).toBe(true);
    expect(proxy.events.filter(event => event.type === "refused")).toHaveLength(3);
    expect(up.calls()).toBe(0);
    const fresh = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "dry2.jsonl"), recording: rec, checkpoint, speed: 0, offline: true, strictPrefix: true });
    const b2 = await fresh.listen(); open.push(fresh);
    expect((await post(b2, worker("w3", []))).status).toBe(200);
    expect((await post(b2, worker("w3", ["c1"]))).status).toBe(200);
    expect((await post(b2, worker("w3", ["c1", "c2"]))).status).toBe(503); // the switch request: offline
    expect((await post(b2, worker("w3", ["c1", "c2"]))).status).toBe(503);
    expect(up.calls()).toBe(0);
    expect(fresh.halted).toBeUndefined();
    expect(loadWire(join(dir, "dry2.jsonl")).filter(entry => entry.mode === "live")).toEqual([]);
  });

  it("strict prefix: a divergence, an unmapped helper or an extra request before the reflection point is refused", async () => {
    const dir = await temp();
    const { recording: rec, checkpoint } = await recording(dir);
    const up = await upstream();
    const diverge = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "r1.jsonl"), recording: rec, checkpoint, speed: 0, strictPrefix: true });
    const b1 = await diverge.listen(); open.push(diverge);
    await post(b1, worker("w", []));
    expect((await post(b1, worker("w", ["other"]))).status).toBe(503);
    expect((await post(b1, worker("w", ["other", "c2"]))).status).toBe(503);
    const unmapped = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "r2.jsonl"), recording: rec, checkpoint, speed: 0, strictPrefix: true });
    const b2 = await unmapped.listen(); open.push(unmapped);
    await post(b2, worker("w", []));
    await post(b2, advisor("a1"));
    expect((await post(b2, advisor("a2"))).status).toBe(503); // a second helper session the recording does not have
    const malformed = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "r3.jsonl"), recording: rec, checkpoint, speed: 0, strictPrefix: true });
    const b3 = await malformed.listen(); open.push(malformed);
    expect((await post(b3, "{not json")).status).toBe(503);
    expect(up.calls()).toBe(0);
    expect(loadWire(join(dir, "r1.jsonl")).some(entry => entry.mode === "refused")).toBe(true);
  });

  it("the fidelity gate refuses the switch and everything after it; the forward gate refuses another model and settles accepted requests", async () => {
    const dir = await temp();
    const { recording: rec, checkpoint } = await recording(dir);
    const up = await upstream();
    const refused = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "g1.jsonl"), recording: rec, checkpoint, speed: 0, strictPrefix: true, onCheckpointRequest: () => false });
    const b1 = await refused.listen(); open.push(refused);
    await post(b1, worker("w", [])); await post(b1, worker("w", ["c1"]));
    expect((await post(b1, worker("w", ["c1", "c2"]))).status).toBe(503);
    expect((await post(b1, worker("w", ["c1", "c2"]))).status).toBe(503);
    expect(up.calls()).toBe(0);
    const settled: { usage: unknown; status: number }[] = [];
    const gated = new WireProxy({
      mode: "replay", upstream: up.url, wireFile: join(dir, "g2.jsonl"), recording: rec, checkpoint, speed: 0, strictPrefix: true, onCheckpointRequest: () => true,
      gate: request => request.model === "gpt-6-astra" && request.reasoning?.effort === "high" ? { ok: true, settle: (usage, status) => settled.push({ usage, status }) } : { ok: false, reason: "model" },
    });
    const b2 = await gated.listen(); open.push(gated);
    await post(b2, worker("w", [])); await post(b2, worker("w", ["c1"]));
    expect((await post(b2, worker("w", ["c1", "c2"]))).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(up.calls()).toBe(1);
    expect(settled).toEqual([{ usage: { input: 1000, cached: 0, output: 10, reasoning: 0 }, status: 200 }]);
    expect((await post(b2, worker("w", ["c1", "c2", "c3"], "gpt-6-sol"))).status).toBe(503);
    expect((await post(b2, worker("w", ["c1", "c2", "c3"]))).status).toBe(503); // halted
    expect(up.calls()).toBe(1);
  });
});

describe("pilot live-path move", () => {
  it("moves the recorded live root (same length) and rewrites a replayed SSE stream, fragments included", () => {
    const { from, to } = PATH_MAP;
    expect(from.length).toBe(to.length);
    expect(pilotLivePath(`${from}/tox-3904-r1/live`)).toBe(`${to}/tox-3904-r1/live`);
    expect(() => pilotLivePath("/elsewhere/live")).toThrow();
    const args = JSON.stringify({ path: `${from}/tox-3904-r1/live/ws/src/a.py` });
    const cut = args.indexOf("/W1/") + 2; // split right after "W": the changed character starts the next fragment
    const events = [
      { type: "response.created", response: { instructions: `cwd ${from}/x` } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: args.slice(0, cut) },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: args.slice(cut) },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 2, content_index: 0, delta: "unrelated \u2019 text" },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: args },
    ];
    const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
    const out = rewriteSse(sse, from, to);
    const parsed = out.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(parsed[0].response.instructions).toBe(`cwd ${to}/x`);
    expect(parsed[1].delta.length).toBe(cut);
    expect(parsed[1].delta + parsed[2].delta).toBe(args.split(from).join(to));
    expect(parsed[4].arguments).toBe(args.split(from).join(to));
    expect(out.split("\n")[10]).toBe(sse.split("\n")[10]); // an unchanged event (the text delta) stays byte for byte
    expect(out).not.toContain(from);
    expect(deepReplace({ a: [`${from}/q`], b: 1 }, from, to)).toEqual({ a: [`${to}/q`], b: 1 });
  });
});


describe("pilot fidelity gate", () => {
  const recorded = () => ({
    model: "gpt-6-astra", instructions: "worker 2026-10-19T06-27-28-781Z", tools: [{ name: "read" }], prompt_cache_key: "k1", reasoning: { effort: "high" },
    input: [
      { role: "user", content: [{ type: "input_text", text: "hand-off" }] },
      { type: "function_call", call_id: "c1", name: "bash", arguments: "{\"command\":\"pytest\"}" },
      { type: "function_call_output", call_id: "c1", output: "3 passed in 1.20s" },
      { type: "function_call", call_id: "c2", name: "task_plan", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "verify [running] {integrate}\nNext ready: none" },
    ],
  });
  const withText = (request: any, text: string) => { const copy = structuredClone(request); copy.prompt_cache_key = "k2"; copy.instructions = "worker 2026-10-23T08-00-00-000Z"; if (text) copy.input[4].output += `\n${text}`; return copy; };

  it("passes the intended delivery and counts re-executed tool-output noise without failing", () => {
    const actual = withText(recorded(), pilotText("B", "verify"));
    actual.input[2].output = "3 passed in 0.98s";
    const report = compareCheckpoint(actual, recorded(), "B", "verify");
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.outputs).toMatchObject({ raw: 1, normalized: 0, orderOnly: 0 });
    expect(compareCheckpoint(withText(recorded(), ""), recorded(), "C0", "verify").ok).toBe(true);
    expect(compareCheckpoint(withText(recorded(), pilotText("A", "verify")), recorded(), "A", "verify").ok).toBe(true);
  });

  it("fails on a wrong or missing text, a changed model-written item, other instructions or R1's text", () => {
    expect(compareCheckpoint(withText(recorded(), pilotText("B", "verify")), recorded(), "A", "verify").ok).toBe(false);
    expect(compareCheckpoint(withText(recorded(), ""), recorded(), "A", "verify").ok).toBe(false);
    expect(compareCheckpoint(withText(recorded(), pilotText("A", "verify")), recorded(), "C0", "verify").ok).toBe(false);
    const changed = withText(recorded(), pilotText("A", "verify")); changed.input[1].arguments = "{\"command\":\"pytest -x\"}";
    expect(compareCheckpoint(changed, recorded(), "A", "verify").problems.join()).toMatch(/item 1/);
    const instructions = withText(recorded(), pilotText("A", "verify")); instructions.instructions = "other";
    expect(compareCheckpoint(instructions, recorded(), "A", "verify").problems.join()).toMatch(/instructions/);
    const r1 = withText(recorded(), `Reflection before your self-review (strong mode, single.strongReflection; integration node verify):\n${FOUR_LINES}`);
    expect(compareCheckpoint(r1, recorded(), "C0", "verify").ok).toBe(false);
    const leaked = withText(recorded(), pilotText("A", "verify")); leaked.input[2].output += `\n${AUDIT}`;
    expect(compareCheckpoint(leaked, recorded(), "A", "verify").problems.join()).toMatch(/outside the delivering item/);
  });
});

describe("pilot read-out", () => {
  const units = JOBS.map(job => job.unit);
  const base = (): Outcome[] => units.flatMap(unit => JOBS.find(job => job.unit === unit)!.arms.map(arm => ({ unit, arm, valid: true, pass: clusterOf(unit) === "D", prePass: clusterOf(unit) === "D", adherence: "full" as const })));
  const set = (items: Outcome[], unit: string, arm: string, patch: Partial<Outcome>) => items.map(item => item.unit === unit && item.arm === arm ? { ...item, ...patch } : item);

  it("go needs two reachable clusters with two distinct C1 units rescued in ONE arm, above C0, no d1 harm, full tier-1 coverage", () => {
    let items = base();
    items = set(items, "tox-3904-r1", "A", { pass: true, mechanism: true });
    items = set(items, "tox-3904-r3", "A", { pass: true, mechanism: true });
    items = set(items, "docstub-123-r1", "A", { pass: true, mechanism: true });
    expect(readout(items).overall).toBe("go");
    expect(readout(items).perArm.A.rescuedReachableClusters).toEqual(["C1", "C2"]);
    expect(readout(set(items, "d1-transactional-r2", "B", { pass: false })).overall).toBe("inconclusive");
    expect(readout(set(set(items, "tox-3904-r2", "C0", { pass: true }), "tox-3904-r4", "C0", { pass: true })).overall).toBe("inconclusive");
    expect(readout(set(items, "d1-transactional-r1", "A", { valid: false })).perArm.A.reasons.join()).toMatch(/coverage incomplete/);
    expect(readout(set(items, "tox-3904-r3", "A", { mechanism: false })).perArm.A.unexplainedPasses).toEqual(["tox-3904-r3"]);
  });

  it("A and B rescuing the same unit is one repeat per arm; policy passes never count; stop needs adherence", () => {
    let items = base();
    for (const arm of ["A", "B"]) items = set(items, "tox-3904-r1", arm, { pass: true, mechanism: true });
    items = set(items, "isort-2491-r4", "A", { pass: true, mechanism: true });
    items = set(items, "docstub-123-r3", "B", { pass: true, mechanism: true });
    const out = readout(items);
    expect(out.perArm.A.c1Rescues).toBe(1);
    expect(out.perArm.B.policyPasses).toEqual(["docstub-123-r3"]);
    expect(out.overall).toBe("inconclusive");
    expect(readout(base()).overall).toBe("stop");
    expect(readout(base().map(item => ({ ...item, adherence: "none" as const }))).overall).toBe("inconclusive");
  });
});

describe("pilot diagnostics helpers", () => {
  it("files changed by the review and pytest failure sections (FAILURES only, not PASSES)", () => {
    const a = "diff --git a/x.py b/x.py\n+1\ndiff --git a/t.py b/t.py\n+t\n";
    const b = "diff --git a/x.py b/x.py\n+2\ndiff --git a/t.py b/t.py\n+t\ndiff --git a/n.py b/n.py\n+n\n";
    expect(changedFiles(a, b)).toEqual(["n.py", "x.py"]);
    expect(changedFiles(a, a)).toEqual([]);
    const out = ["=================================== FAILURES ===================================", "______ test_a ______", "E   AssertionError: one", "______ test_b ______", "E   assert 2", "==================================== PASSES ====================================", "______ test_c ______", "captured", "=========================== short test summary info ============================", "FAILED t.py::test_a"].join("\n");
    const sections = failureSections(out);
    expect(Object.keys(sections)).toEqual(["test_a", "test_b"]);
    expect(sections.test_a).toContain("AssertionError: one");
    expect(sections.test_b).not.toContain("PASSES");
  });
});

describe("pilot read-out inputs", () => {
  it("per-test transitions of the hidden tests between the pre-review and a final state", () => {
    const out = testTransitions(
      { statuses: { a: "PASSED", b: "FAILED", c: "PASSED" }, failToPass: [], passToPassFailing: [] },
      { statuses: { a: "FAILED", b: "PASSED", d: "PASSED" }, failToPass: [{ id: "b", status: "PASSED" }, { id: "e", status: "MISSING" }], passToPassFailing: [{ id: "a", status: "FAILED" }] },
    );
    expect(out).toEqual({ newlyFailing: ["a", "c (missing)"], newlyPassing: ["b", "d"], f2pFailing: ["e"], p2pFailing: ["a"] });
  });

  it("reconciles the ledger with every recorded request, incomplete arms and infra archives included", async () => {
    const dir = await temp();
    await mkdirP(join(dir, "budget"), { recursive: true });
    await writeFileP(join(dir, "budget/ledger.jsonl"), [
      { k: "r", id: "u/A/1/1", unit: "u", arm: "A", usd: 1 }, { k: "s", id: "u/A/1/1", usd: 0.01 },
      { k: "r", id: "u/A/1/2", unit: "u", arm: "A", usd: 0.5 }, { k: "x", id: "u/A/1/3", unit: "u", arm: "A", usd: 3, reason: "budget" },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const record = (seq: number, mode: string, usage?: object) => JSON.stringify({ seq, session: "s", ordinal: seq, top: true, start: 0, end: 1, status: mode === "refused" ? 503 : 200, mode, path: "", request: {}, response: "", ...(usage ? { usage } : {}) });
    await mkdirP(join(dir, "units/u/A"), { recursive: true });
    await mkdirP(join(dir, "units/u/A.infra-1"), { recursive: true });
    await writeFileP(join(dir, "units/u/A/wire.jsonl"), [record(1, "live", { input: 1000, cached: 0, output: 0, reasoning: 0 }), record(2, "live"), record(3, "refused")].join("\n") + "\n");
    await writeFileP(join(dir, "units/u/A.infra-1/wire.jsonl"), record(1, "live", { input: 2000, cached: 0, output: 0, reasoning: 0 }) + "\n");
    const out = reconcile(dir);
    expect(out.ledger).toMatchObject({ reservations: 2, settlements: 1, refusals: 1, reservedUsd: 1.5, settledUsd: 0.01, outstandingUsd: 0.5, committedUsd: 0.51 });
    expect(out.wire).toMatchObject({ files: 2, live: 3, withUsage: 2, withoutUsage: 1, refused: 1, infraDirs: ["u/A.infra-1"] });
    expect(out.wire.usageUsd).toBeCloseTo(0.03, 6);
    expect(out.perArm["u/A"]).toMatchObject({ requests: 2, live: 3, withoutUsage: 1 });
    expect(out.differenceUsd).toBeCloseTo(0.48, 6);
  });
});
