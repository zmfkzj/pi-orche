/**
 * Regressions of the bypasses found by the real-model pilot and the probes of 2026-10-08 (docs/thinking-policy.md "Runtime gate"):
 * effective effort aliases, the integration/hard gate, checkpoint evidence against the tool-call ledger, lineage-bounded splits,
 * rework under a new id, verified progress, the report gate, and fixed-mode compatibility. Session doubles; mechanics only.
 */
import { describe, expect, it } from "vitest";
import {
  beginThinkingPolicy, claimsSuccess, FIXED_THINKING_POLICY, onTaskPlan, PHASE_THINKING_POLICY, reportGateError, reportRewriteReason,
  requestRedecompose, resolveThinkingPolicy, thinkingPolicyOf, thinkingPolicySummary, MAX_SPLIT_DEPTH, checkPolicyPlan,
  type ThinkingPolicySettings,
} from "../../src/pi/thinking-policy.js";
import { lowerThinkingForRecovery, noteRequestLevel, stepDownLevel, thinkingStateOf } from "../../src/pi/thinking-state.js";
import { effortMappingFor } from "../../src/pi/effort-mapping.js";
import { classifyEvidence, evidenceLedgerOf, recordToolCall } from "../../src/pi/tool-evidence.js";
import { createTaskPlanTool, type TaskPlan } from "../../src/tools/task-plan.js";

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_VIA_CPA = { provider: "cliproxyapi", id: "claude-opus-5-5", api: "cliproxyapi-codex-responses", thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
const GPT_VIA_CPA = { provider: "cliproxyapi", id: "gpt-5.5", api: "cliproxyapi-codex-responses", thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } };

/** A Pi session double with a model (Pi's clamp: an unsupported level goes up to the next supported one, else down). */
function session(levels: string[], level: string, model?: Record<string, unknown>) {
  const clamp = (wanted: string) => {
    if (levels.includes(wanted)) return wanted;
    const index = ORDER.indexOf(wanted);
    for (let i = index; i < ORDER.length; i++) if (levels.includes(ORDER[i]!)) return ORDER[i]!;
    for (let i = index - 1; i >= 0; i--) if (levels.includes(ORDER[i]!)) return ORDER[i]!;
    return levels[0] ?? "off";
  };
  const double = { thinkingLevel: clamp(level), model, setThinkingLevel(wanted: never) { double.thinkingLevel = clamp(wanted); }, getAvailableThinkingLevels: () => [...levels] };
  return double;
}
const PI = ["off", "minimal", "low", "medium", "high"];

type Node = TaskPlan["nodes"][number];
const node = (id: string, status: Node["status"], extra: Partial<Node> = {}, dependsOn: string[] = []): Node => ({ id, title: `Work ${id}`, dependsOn, covers: ["R1"], status, ...extra });
const plan = (...nodes: Node[]): TaskPlan => ({ nodes });
const passed = (...evidence: string[]) => ({ result: "ok", evidence, verification: "passed" as const });

/** A worker double: the real task_plan tool with the policy's checks, a request counter and a tool ledger. */
function worker(settings: ThinkingPolicySettings = PHASE_THINKING_POLICY, levels = PI, level = "high", kind = "implement") {
  const s = session(levels, level);
  beginThinkingPolicy(s, settings, undefined, kind);
  let current: TaskPlan | undefined;
  const tool = createTaskPlanTool(value => { current = value; return onTaskPlan(s, value); }, ["R1", "R2"], {
    previous: () => current, checkpointsRequired: () => settings.checkpoints, validate: (previous, value) => checkPolicyPlan(s, previous, value),
  });
  /** One model request: noted at its level, then its tool calls. */
  const request = () => noteRequestLevel(s);
  const call = (name: string, input: Record<string, unknown>, isError = false) => {
    const thinking = thinkingStateOf(s);
    const running = thinkingPolicyOf(s)?.plan?.nodes.find(item => item.status === "running")?.id;
    return recordToolCall(s, { toolCallId: `c${Math.random()}`, toolName: name, input, isError }, { request: thinking.requestSeq, ...(thinking.requestLevel ? { level: thinking.requestLevel } : {}), atBaseline: thinking.requestLevel === thinking.baseline || thinking.requestLevel === "high", ...(running ? { node: running } : {}) }).ref;
  };
  const submit = async (value: TaskPlan) => {
    const result = await tool.execute("id", value as never, undefined, undefined, undefined as never) as { content: { text: string }[]; isError?: boolean };
    return { ok: !result.isError, text: result.content[0]!.text };
  };
  return { s, request, call, submit, plan: () => current };
}

const R12 = { covers: ["R1", "R2"] };

describe("effective effort: a proxy alias is not a step down", () => {
  it("Claude through CLIProxyAPI: xhigh and max are both max, so B = max steps to high (not xhigh); B = xhigh too", () => {
    const names = effortMappingFor(CLAUDE_VIA_CPA).names;
    expect(effortMappingFor(CLAUDE_VIA_CPA)).toMatchObject({ source: "builtin:cliproxyapi-claude", aliases: { xhigh: "max" } });
    const levels = ["low", "medium", "high", "xhigh", "max"];
    expect([stepDownLevel(levels, "max", names), stepDownLevel(levels, "xhigh", names), stepDownLevel(levels, "high", names)]).toEqual(["high", "high", "medium"]);
    // Without the mapping the old answer (xhigh) comes back: the pilot's non-step-down.
    expect(stepDownLevel(levels, "max")).toBe("xhigh");
  });
  it("the alias is scoped: GPT on the same proxy path, another api, or a config entry with no aliases keep distinct levels", () => {
    expect(effortMappingFor(GPT_VIA_CPA)).toMatchObject({ source: "none", aliases: {} });
    expect(effortMappingFor({ ...CLAUDE_VIA_CPA, api: "anthropic-messages" })).toMatchObject({ source: "none", aliases: {} });
    expect(effortMappingFor(CLAUDE_VIA_CPA, [{ model: "cliproxyapi/claude-*", aliases: {} }])).toMatchObject({ source: "config:cliproxyapi/claude-*", aliases: {} });
    expect(effortMappingFor({ provider: "other", id: "m" }, [{ model: "other/*", aliases: { medium: "high" } }]).aliases).toEqual({ medium: "high" });
  });
  it("the model's own thinkingLevelMap: two names sent as the same string are one level", () => {
    const names = effortMappingFor({ provider: "p", id: "m", thinkingLevelMap: { high: "high", xhigh: "high" } }).names;
    expect(stepDownLevel(["medium", "high", "xhigh"], "xhigh", names)).toBe("medium");
  });
  it("assignment start, the recovery step-down, the report rewrite and the records use the effective level", () => {
    const s = session(["low", "medium", "high", "xhigh", "max"], "max", CLAUDE_VIA_CPA);
    beginThinkingPolicy(s, PHASE_THINKING_POLICY, "max");
    expect(thinkingStateOf(s)).toMatchObject({ baseline: "max", step: "high" });
    expect(thinkingPolicySummary(s)).toMatchObject({ baseline: "max", step: "high", effective: { baseline: "max", step: "high", source: "builtin:cliproxyapi-claude", aliases: { xhigh: "max" } } });
    // A report written at xhigh ran at B's effort (max upstream): not rewritten.
    s.setThinkingLevel("xhigh" as never);
    noteRequestLevel(s);
    expect(reportRewriteReason(s)).toBeUndefined();
    // The recovery step-down from max goes to high (xhigh would be max again).
    s.setThinkingLevel("max" as never);
    expect(lowerThinkingForRecovery(s)).toBe(true);
    expect(s.thinkingLevel).toBe("high");
    // A config override that knows better wins and is recorded.
    const t = session(["low", "medium", "high", "xhigh", "max"], "max", CLAUDE_VIA_CPA);
    beginThinkingPolicy(t, resolveThinkingPolicy({ mode: "phase", effortAliases: [{ model: "cliproxyapi/*", aliases: {} }] }), "max");
    expect(thinkingPolicySummary(t)).toMatchObject({ step: "xhigh", effective: { source: "config:cliproxyapi/*" } });
  });
});

describe("the integration gate (phase): B integration is real, not a label", () => {
  it("a plan without an integration node is rejected; the fixed policy accepts it as before", async () => {
    const w = worker();
    w.request();
    expect(await w.submit(plan(node("a", "running", R12)))).toMatchObject({ ok: false, text: expect.stringMatching(/the plan has no integration node/) });
    const f = worker(FIXED_THINKING_POLICY);
    f.request();
    expect((await f.submit(plan(node("a", "running", R12)))).ok).toBe(true);
    f.request();
    expect((await f.submit(plan(node("a", "done", R12)))).ok).toBe(true); // pending/running -> done without anything: fixed compat
  });
  it("pilot c1: hard and integration nodes batched to done from pending in one S response are rejected", async () => {
    const w = worker();
    w.request();
    await w.submit(plan(node("a", "running", R12), node("h", "pending", { ...R12, hard: true }, ["a"]), node("i", "pending", { ...R12, phase: "integrate" }, ["h"])));
    w.request(); // at S
    const ref = w.call("bash", { command: "npm test" });
    const result = await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed(`${ref} npm test -> pass`) }), node("h", "done", { ...R12, checkpoint: passed(`${ref} npm test -> pass`) }, ["a"]), node("i", "done", { ...R12, checkpoint: passed(`${ref} npm test -> pass`) }, ["h"])));
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/hard node h goes to done without having run/);
    expect(result.text).toMatch(/integration node i goes to done without having run/);
    expect(thinkingPolicyOf(w.s)!.gateRejections).toBe(1);
  });
  it("the same-response illusion: set running and marked done in one response is rejected; done in the next response at B with a B check passes", async () => {
    const w = worker();
    w.request();
    await w.submit(plan(node("a", "running", R12), node("i", "pending", { ...R12, phase: "integrate" }, ["a"])));
    w.request(); // S
    const s1 = w.call("bash", { command: "npm test" });
    await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed(`${s1} npm test -> pass`) }), node("i", "running", R12, ["a"])));
    // Same S response: a check and the done mark.
    const s2 = w.call("bash", { command: "npm test" });
    expect(await w.submit(plan(node("a", "done", R12), node("i", "done", { ...R12, checkpoint: passed(`${s2} npm test -> pass`) }, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/was set running in this same response/) });
    w.request(); // B
    expect(thinkingStateOf(w.s).requestLevel).toBe("high");
    // A check made at S before the node ran does not count for the integration.
    expect(await w.submit(plan(node("a", "done", R12), node("i", "done", { ...R12, checkpoint: passed(`${s1} npm test -> pass`) }, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/needs checkpoint evidence citing a successful check/) });
    const b = w.call("bash", { command: "npm test" });
    expect(await w.submit(plan(node("a", "done", R12), node("i", "done", { ...R12, checkpoint: passed(`${b} npm test -> 14 pass`) }, ["a"])))).toMatchObject({ ok: true });
  });
  it("an integration node cannot be dropped, demoted to a step, skipped or finished not_applicable; a per-requirement split may replace it", async () => {
    const w = worker();
    w.request();
    await w.submit(plan(node("a", "running", R12), node("i", "pending", { ...R12, phase: "integrate" }, ["a"])));
    w.request();
    expect(await w.submit(plan(node("a", "running", R12)))).toMatchObject({ ok: false, text: expect.stringMatching(/the plan has no integration node.*integration node i cannot be removed/) });
    expect(await w.submit(plan(node("a", "running", R12), node("i", "pending", { ...R12, phase: "step" }, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/cannot become a step/) });
    expect(await w.submit(plan(node("a", "running", R12), node("i", "skipped", R12, ["a"]), node("i1", "pending", { phase: "integrate", covers: ["R1"] }, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/i cannot be skipped unless other integration nodes take over its requirements \(R2 would lose/) });
    expect((await w.submit(plan(node("a", "running", R12), node("i", "skipped", R12, ["a"]), node("i1", "pending", { phase: "integrate", covers: ["R1"], parent: "i" }, ["a"]), node("i2", "pending", { phase: "integrate", covers: ["R2"], parent: "i" }, ["a"])))).ok).toBe(true);
    const v = worker();
    v.request();
    await v.submit(plan(node("a", "done", { ...R12, checkpoint: passed("x") }), node("i", "running", { ...R12, phase: "integrate" }, ["a"])));
    v.request();
    const notApplicable = plan(node("a", "done", R12), node("i", "done", { ...R12, checkpoint: { result: "looked fine", evidence: ["looked"], verification: "not_applicable" } }, ["a"]));
    expect(await v.submit(notApplicable)).toMatchObject({ ok: false, text: expect.stringMatching(/verification "passed"/) });
    // Without required checkpoints the gate itself still refuses it.
    const x = worker(resolveThinkingPolicy({ mode: "phase", checkpoints: false }));
    x.request();
    await x.submit(plan(node("a", "done", R12), node("i", "running", { ...R12, phase: "integrate" }, ["a"])));
    x.request();
    expect(await x.submit(notApplicable)).toMatchObject({ ok: false, text: expect.stringMatching(/Task DAG gate .*integration node i is done only with a checkpoint whose verification is "passed"/) });
  });
  it("an integration node is not done while a step covering its requirements is open", async () => {
    const w = worker();
    w.request();
    await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed("x") }), node("b", "pending", { covers: ["R2"] }), node("i", "running", { ...R12, phase: "integrate" }, ["a"])));
    w.request();
    const ref = w.call("read", { path: "src/a.ts" });
    expect(await w.submit(plan(node("a", "done", R12), node("b", "pending", { covers: ["R2"] }), node("i", "done", { ...R12, checkpoint: passed(`${ref} src/a.ts read`) }, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/cannot be done while b \(pending\)/) });
  });
  it("B = S (no lower effective level): the request-level checks are moot, the structure and evidence rules stay", async () => {
    const w = worker(PHASE_THINKING_POLICY, ["low"], "low");
    w.request();
    const ref = w.call("bash", { command: "npm test" });
    expect(await w.submit(plan(node("i", "done", { ...R12, phase: "integrate", checkpoint: passed(`${ref} npm test -> pass`) })))).toMatchObject({ ok: true });
    w.request();
    expect(await w.submit(plan(node("i", "done", { ...R12, phase: "integrate" }), node("x", "pending", R12)))).toMatchObject({ ok: true });
    const v = worker(PHASE_THINKING_POLICY, ["low"], "low");
    v.request();
    expect((await v.submit(plan(node("i", "done", { ...R12, phase: "integrate", checkpoint: passed("T9 npm test -> pass") })))).text).toMatch(/no such tool call/);
  });
});

describe("checkpoint evidence against the tool ledger", () => {
  it("probe L3: a fabricated file:line and an unrun command are not evidence; strict rejects a made-up ref or a failed call for \"passed\"", async () => {
    const w = worker();
    w.request();
    await w.submit(plan(node("a", "running", R12), node("i", "pending", { ...R12, phase: "integrate" }, ["a"])));
    w.request();
    const failed = w.call("bash", { command: "npm test" }, true);
    expect(await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed("T99 npm test -> 999 pass") }), node("i", "running", R12, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/no such tool call/) });
    expect(await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed(`${failed} npm test -> pass`) }), node("i", "running", R12, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/a call that failed/) });
    // Free text proves nothing: accepted for an ordinary step, with a note, and not progress.
    // A command that only ever failed is a failed call even without a ref.
    expect(await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed("npm test -> 14 pass") }), node("i", "running", R12, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/a call that failed/) });
    const accepted = await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed("src/nowhere.js:999", "make check -> 999 pass (never run)") }), node("i", "running", R12, ["a"])));
    expect(accepted).toMatchObject({ ok: true, text: expect.stringMatching(/no evidence item of a cites a tool call/) });
    expect(thinkingPolicyOf(w.s)!.progress).toBe(0);
    w.request();
    expect(await w.submit(plan(node("a", "done", R12), node("i", "done", { ...R12, checkpoint: passed("src/nowhere.js:999", "make check -> 999 pass (never run)") }, ["a"])))).toMatchObject({ ok: false, text: expect.stringMatching(/needs checkpoint evidence/) });
  });
  it("warn mode: the same references are notes, not rejections; off: no notes", async () => {
    const w = worker(resolveThinkingPolicy({ mode: "phase", evidence: "warn" }));
    w.request();
    await w.submit(plan(node("a", "running", R12), node("i", "pending", { ...R12, phase: "integrate" }, ["a"])));
    w.request();
    expect(await w.submit(plan(node("a", "done", { ...R12, checkpoint: passed("T99 x") }), node("i", "running", R12, ["a"])))).toMatchObject({ ok: true, text: expect.stringMatching(/Evidence warning: a's checkpoint says "passed" but cites/) });
  });
  it("classification: refs, command and path matches, failed calls, calls before the window, calls below B", () => {
    const s = session(PI, "high");
    beginThinkingPolicy(s, PHASE_THINKING_POLICY);
    const ledger = evidenceLedgerOf(s);
    const at = (request: number, atBaseline = true) => ({ request, atBaseline });
    recordToolCall(s, { toolCallId: "1", toolName: "bash", input: { command: "npm test -- --run" }, isError: false }, at(1, false));
    recordToolCall(s, { toolCallId: "2", toolName: "read", input: { path: "./src/cron.js" }, isError: false }, at(3));
    recordToolCall(s, { toolCallId: "3", toolName: "bash", input: { command: "node --test" }, isError: true }, at(3));
    recordToolCall(s, { toolCallId: "4", toolName: "task_plan", input: {}, isError: false }, at(3));
    const verdict = (item: string, fromRequest = 0, atBaseline = false) => classifyEvidence(item, ledger, { fromRequest, atBaseline }).verdict;
    expect([verdict("T2 cron read"), verdict("src/cron.js:12"), verdict("npm test -> 14 pass"), verdict("T3 node --test -> pass"), verdict("node --test -> pass")]).toEqual(["verified", "verified", "verified", "failed_call", "failed_call"]);
    expect([verdict("T4 plan"), verdict("T5"), verdict("looked at it")]).toEqual(["unknown_ref", "unknown_ref", "unmatched"]);
    expect([verdict("T1 npm test", 2), verdict("T1 npm test", 0, true), verdict("T2", 2, true)]).toEqual(["outside_window", "outside_window", "verified"]);
  });
});

describe("bounded re-decomposition and rework under a new id", () => {
  const started = () => {
    const s = session(PI, "high");
    beginThinkingPolicy(s, PHASE_THINKING_POLICY);
    onTaskPlan(s, plan(node("s3", "running", { covers: ["R1", "R2"], title: "Parse cron" }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"])));
    return s;
  };
  it("probe L6: two unrelated new nodes, or a rename-only split, earn neither a split nor progress", () => {
    const s = started();
    requestRedecompose(s);
    const notes = onTaskPlan(s, plan(node("s3", "pending", { covers: ["R1", "R2"], title: "Parse cron" }), node("x", "done", { checkpoint: passed("x") }), node("y", "pending"), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"])));
    expect(notes.join("\n")).toMatch(/does not split s3: s3 is still pending/);
    const t = started();
    requestRedecompose(t);
    expect(onTaskPlan(t, plan(node("s3", "skipped", { covers: ["R1", "R2"], title: "Parse cron" }), node("x", "running"), node("y", "pending"), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"]))).join("\n")).toMatch(/two or more new nodes with parent "s3" are needed \(new nodes without that parent do not count: x, y\)/);
    const u = started();
    requestRedecompose(u);
    expect(onTaskPlan(u, plan(node("s3", "skipped", { covers: ["R1", "R2"], title: "Parse cron" }), node("s3a", "running", { covers: ["R1"], title: "Parse cron", parent: "s3" }), node("s3b", "pending", { covers: ["R2"], title: "Parse  CRON", parent: "s3" }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"]))).join("\n")).toMatch(/distinct, smaller parts/);
    for (const x of [s, t, u]) expect(thinkingPolicyOf(x)).toMatchObject({ redecompositions: 0, progress: 0 });
  });
  it("a split must carry exactly the node's requirements and nests at most MAX_SPLIT_DEPTH deep", () => {
    let s = started();
    requestRedecompose(s);
    expect(onTaskPlan(s, plan(node("s3", "skipped", { covers: ["R1", "R2"], title: "Parse cron" }), node("a", "running", { covers: ["R1"], parent: "s3" }), node("b", "pending", { covers: ["R1"], parent: "s3" }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"]))).join("\n")).toMatch(/must carry s3's requirements \(missing R2\)/);
    const t = started();
    requestRedecompose(t);
    expect(onTaskPlan(t, plan(node("s3", "skipped", { covers: ["R1", "R2"], title: "Parse cron" }), node("a", "running", { covers: ["R1", "R3"], parent: "s3" }), node("b", "pending", { covers: ["R2"], parent: "s3" }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"]))).join("\n")).toMatch(/may cover only s3's requirements \(R3 belong elsewhere\)/);
    s = started();
    requestRedecompose(s);
    onTaskPlan(s, plan(node("s3", "skipped", { covers: ["R1", "R2"], title: "Parse cron" }), node("a", "running", { covers: ["R1"], parent: "s3" }), node("b", "pending", { covers: ["R2"], parent: "s3" }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"])));
    expect(thinkingPolicyOf(s)).toMatchObject({ redecompositions: 1 });
    expect(requestRedecompose(s)).toEqual({ kind: "step", node: "a" });
    onTaskPlan(s, plan(node("s3", "skipped", { covers: ["R1", "R2"] }), node("a", "skipped", { covers: ["R1"], parent: "s3" }), node("a1", "running", { covers: ["R1"], parent: "a" }), node("a2", "pending", { covers: ["R1"], parent: "a" }), node("b", "pending", { covers: ["R2"], parent: "s3" }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3"])));
    expect(thinkingPolicyOf(s)).toMatchObject({ redecompositions: 2 });
    expect(MAX_SPLIT_DEPTH).toBe(2);
    expect(requestRedecompose(s)).toEqual({ kind: "exhausted" }); // a1 is at depth 2
  });
  it("probe L4: rework under a new id runs at B: after the integration started, for a failed requirement, or as a child of a finished node", () => {
    const s = started();
    onTaskPlan(s, plan(node("s3", "done", { covers: ["R1", "R2"], checkpoint: passed("x") }), node("i", "running", { ...R12, phase: "integrate" }, ["s3"])));
    onTaskPlan(s, plan(node("s3", "done", { covers: ["R1", "R2"] }), node("s3-fix", "running", { covers: ["R2"] }), node("i", "pending", { ...R12, phase: "integrate" }, ["s3-fix"])));
    expect(s.thinkingLevel).toBe("high");
    expect(thinkingPolicyOf(s)!.escalated.get("s3-fix")).toBe("added after the integration started (rework)");
    const t = started();
    onTaskPlan(t, plan(node("s3", "blocked", { covers: ["R2"], checkpoint: { result: "fails", evidence: ["x"], verification: "failed" } }), node("i", "pending", { ...R12, phase: "integrate" })));
    onTaskPlan(t, plan(node("s3", "blocked", { covers: ["R2"] }), node("retry", "running", { covers: ["R2"] }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(thinkingPolicyOf(t)!.escalated.get("retry")).toBe("redoes failed requirement R2 (rework)");
    expect(t.thinkingLevel).toBe("high");
    const u = started();
    onTaskPlan(u, plan(node("s3", "done", { covers: ["R1", "R2"], checkpoint: passed("x") }), node("i", "pending", { ...R12, phase: "integrate" })));
    onTaskPlan(u, plan(node("s3", "done", { covers: ["R1", "R2"] }), node("s3b", "running", { parent: "s3" }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(thinkingPolicyOf(u)!.escalated.get("s3b")).toBe("child of the finished node s3 (rework)");
    // A genuinely new ordinary step before any failure or integration stays at S.
    const v = started();
    onTaskPlan(v, plan(node("s3", "done", { covers: ["R1", "R2"], checkpoint: passed("x") }), node("s4", "running", { covers: ["R1"] }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(v.thinkingLevel).toBe("medium");
  });
  it("progress: a tool call alone or a checkpoint citing nothing is not progress; a verified checkpoint is", () => {
    const s = started();
    const policy = thinkingPolicyOf(s)!;
    noteRequestLevel(s);
    recordToolCall(s, { toolCallId: "1", toolName: "read", input: { path: "a.ts" }, isError: false }, { request: 1, atBaseline: false });
    onTaskPlan(s, plan(node("s3", "running", { covers: ["R1", "R2"], note: "after a read" }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(policy.progress).toBe(0);
    onTaskPlan(s, plan(node("s3", "done", { covers: ["R1", "R2"], checkpoint: passed("all good") }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(policy.progress).toBe(0);
    const t = started();
    noteRequestLevel(t);
    recordToolCall(t, { toolCallId: "1", toolName: "bash", input: { command: "npm test" }, isError: false }, { request: 1, atBaseline: false });
    onTaskPlan(t, plan(node("s3", "done", { covers: ["R1", "R2"], checkpoint: passed("T1 npm test -> pass") }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(thinkingPolicyOf(t)!.progress).toBe(1);
  });
});

describe("the report gate: a success claim needs the integration; partial, blocked and failed reports always pass", () => {
  const data = (status: string) => ({ status, checklist: [{ id: "R1", status: status === "done" ? "met" : "partial", evidence: "x" }] });
  it("success without a finished integration is sent back; blocked/partial is accepted; no plan or the fixed policy is not gated", () => {
    const s = session(PI, "high");
    beginThinkingPolicy(s, PHASE_THINKING_POLICY, undefined, "implement");
    expect(reportGateError(s, "implement", data("done"))).toBeUndefined(); // no plan: everything ran at B
    onTaskPlan(s, plan(node("a", "done", { checkpoint: passed("x") }), node("i", "pending", { ...R12, phase: "integrate" })));
    expect(reportGateError(s, "implement", data("done"))).toMatch(/node i \(pending\) is not finished; requirements R1, R2 have no finished integration node/);
    expect(reportGateError(s, "implement", data("blocked"))).toBeUndefined();
    expect(reportGateError(s, "answer", { checklist: [{ id: "R1", status: "partial" }] })).toBeUndefined();
    expect(reportGateError(s, "verify", { passed: true })).toBeUndefined();
    onTaskPlan(s, plan(node("a", "done"), node("i", "done", { ...R12, phase: "integrate", checkpoint: passed("x") })));
    expect(reportGateError(s, "implement", data("done"))).toBeUndefined();
    const f = session(PI, "high");
    beginThinkingPolicy(f, FIXED_THINKING_POLICY, undefined, "implement");
    onTaskPlan(f, plan(node("a", "done")));
    expect(reportGateError(f, "implement", data("done"))).toBeUndefined();
    expect([claimsSuccess("implement", { status: "done" }), claimsSuccess("answer", { checklist: [{ status: "met" }] }), claimsSuccess("answer", { checklist: [] })]).toEqual([true, true, false]);
  });
  it("a new assignment (reuse after a cancel, a timeout or a failure) forgets plan, gate and ledger state", () => {
    const s = session(PI, "high");
    beginThinkingPolicy(s, PHASE_THINKING_POLICY, undefined, "implement");
    noteRequestLevel(s);
    recordToolCall(s, { toolCallId: "1", toolName: "bash", input: { command: "x" }, isError: false }, { request: 1, atBaseline: true });
    onTaskPlan(s, plan(node("a", "running"), node("i", "pending", { ...R12, phase: "integrate" })));
    beginThinkingPolicy(s, PHASE_THINKING_POLICY, undefined, "implement");
    expect([evidenceLedgerOf(s).calls.length, thinkingStateOf(s).requestSeq, thinkingPolicyOf(s)!.runningSince.size, thinkingPolicyOf(s)!.plan]).toEqual([0, 0, 0, undefined]);
    expect(recordToolCall(s, { toolCallId: "2", toolName: "bash", input: { command: "x" }, isError: false }, { request: 1, atBaseline: true }).ref).toBe("T1");
  });
});
