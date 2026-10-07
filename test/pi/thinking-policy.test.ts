import { describe, expect, it } from "vitest";
import {
  beginThinkingPolicy, FIXED_THINKING_POLICY, MAX_REDECOMPOSITIONS, onTaskPlan, PHASE_THINKING_POLICY, phaseTarget, reportRewriteReason, beginReportPhase,
  requestRedecompose, requireReplan, resolveThinkingPolicy, thinkingPolicyOf, thinkingPolicySummary,
} from "../../src/pi/thinking-policy.js";
import { beginThinking, lowerThinkingForRecovery, clearThinkingOverride, noteRequestLevel, setThinkingPhase, stepDownLevel, thinkingStateOf } from "../../src/pi/thinking-state.js";
import type { TaskPlan } from "../../src/tools/task-plan.js";

/** A Pi session double: Pi's clamp (an unsupported level goes to the next supported one above, else below). */
function session(levels: string[], level: string) {
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const clamp = (wanted: string) => {
    if (levels.includes(wanted)) return wanted;
    const index = order.indexOf(wanted);
    for (let i = index; i < order.length; i++) if (levels.includes(order[i]!)) return order[i]!;
    for (let i = index - 1; i >= 0; i--) if (levels.includes(order[i]!)) return order[i]!;
    return levels[0] ?? "off";
  };
  const double = {
    thinkingLevel: clamp(level),
    sets: [] as string[],
    setThinkingLevel(wanted: never) { double.sets.push(wanted); double.thinkingLevel = clamp(wanted); },
    getAvailableThinkingLevels: () => [...levels],
  };
  return double;
}
// Supported levels of the cliproxyapi models in the user's catalog (thinkingLevelMap null = unsupported; see docs/thinking-policy.md).
const OPUS_5_5 = ["low", "medium", "high", "xhigh", "max"];
const OPUS_4_6 = ["low", "medium", "high", "max"];
const FLASH_IMAGE = ["minimal", "high"];
const PI_DEFAULT = ["off", "minimal", "low", "medium", "high"];

type Node = TaskPlan["nodes"][number];
const node = (id: string, status: Node["status"], extra: Partial<Node> = {}, dependsOn: string[] = []): Node => ({ id, title: `Work ${id}`, dependsOn, covers: ["R1"], status, ...extra });
const plan = (...nodes: Node[]): TaskPlan => ({ nodes });
const done = (id: string, extra: Partial<Node> = {}, dependsOn: string[] = []) => node(id, "done", { checkpoint: { result: "ok", evidence: ["a.ts:1"], verification: "passed" }, ...extra }, dependsOn);

describe("the step level S: one level the model supports below B, never off, never drifting", () => {
  it.each([
    ["opus-5-5 max", OPUS_5_5, "max", "xhigh"],
    ["opus-5-5 xhigh", OPUS_5_5, "xhigh", "high"],
    ["opus-4-6 (no xhigh) max", OPUS_4_6, "max", "high"],
    ["opus-5-5 low (no off/minimal)", OPUS_5_5, "low", undefined],
    ["flash-image high (minimal and high only)", FLASH_IMAGE, "high", "minimal"],
    ["a model with off but nothing else below", ["off", "low"], "low", undefined],
    ["Pi's default reasoning levels high", PI_DEFAULT, "high", "medium"],
  ])("%s", (_name, levels, level, expected) => {
    expect(stepDownLevel(levels, level)).toBe(expected);
  });
  it("S is computed once from B: switching phases or starting the next assignment never lowers it further", () => {
    const s = session(OPUS_5_5, "max");
    expect(beginThinking(s)).toMatchObject({ baseline: "max", step: "xhigh" });
    for (let i = 0; i < 3; i++) { setThinkingPhase(s, "step", "step"); setThinkingPhase(s, "baseline", "integration"); setThinkingPhase(s, "step", "step"); }
    expect(s.thinkingLevel).toBe("xhigh");
    // The next assignment starts from B, not from the step level it was left at.
    expect(beginThinking(s)).toMatchObject({ baseline: "max", step: "xhigh" });
    expect(s.thinkingLevel).toBe("max");
  });
  it("no level below B: S = B, so the phase policy never changes the level", () => {
    const s = session(OPUS_5_5, "low");
    expect(beginThinking(s)).toMatchObject({ baseline: "low", step: "low" });
    setThinkingPhase(s, "step", "step");
    expect(s.sets.filter(level => level !== "low")).toEqual([]);
  });
  it("the recovery step-down lowers the CURRENT level by one supported level and goes back to the phase level", () => {
    const s = session(OPUS_4_6, "max");
    beginThinking(s);
    expect(lowerThinkingForRecovery(s)).toBe(true);
    expect(s.thinkingLevel).toBe("high");
    clearThinkingOverride(s);
    expect(s.thinkingLevel).toBe("max");
    const low = session(OPUS_5_5, "low");
    beginThinking(low);
    expect(lowerThinkingForRecovery(low)).toBe(false);
    expect(low.thinkingLevel).toBe("low");
  });
  it("an explicit baseline (a new main level, a model switch) wins; a level set by the owner since is adopted; a recovery level is not", () => {
    const s = session(PI_DEFAULT, "high");
    beginThinking(s);
    lowerThinkingForRecovery(s); // medium, left over
    expect(beginThinking(s)).toMatchObject({ baseline: "high", step: "medium" });
    lowerThinkingForRecovery(s);
    s.setThinkingLevel("low" as never); // the owner chose a new level directly
    expect(beginThinking(s)).toMatchObject({ baseline: "low", step: "minimal" });
    expect(beginThinking(s, "medium")).toMatchObject({ baseline: "medium", step: "low" });
  });
});

describe("phase target", () => {
  const phase = PHASE_THINKING_POLICY;
  const none = { escalated: new Map<string, string>(), replan: false, current: "baseline" as const };
  it.each([
    ["no plan yet (analysis and planning)", phase, undefined, none, "baseline"],
    ["an ordinary step running", phase, plan(node("a", "running")), none, "step"],
    ["an integration node running", phase, plan(done("a"), node("i", "running", { phase: "integrate" }, ["a"])), none, "baseline"],
    ["a hard step running", phase, plan(node("a", "running", { hard: true })), none, "baseline"],
    ["a hard step without escalation (plain S/B)", resolveThinkingPolicy({ mode: "phase", escalation: false }), plan(node("a", "running", { hard: true })), none, "step"],
    ["an escalated (reworked) node running", phase, plan(node("a", "running")), { ...none, escalated: new Map([["a", "rework"]]) }, "baseline"],
    ["between two ordinary steps", phase, plan(done("a"), node("b", "pending", {}, ["a"])), { ...none, current: "step" as const }, "step"],
    ["after a step, the next node is integration", phase, plan(done("a"), node("i", "pending", { phase: "integrate" }, ["a"])), { ...none, current: "step" as const }, "baseline"],
    ["all done (report)", phase, plan(done("a"), done("i", { phase: "integrate" })), { ...none, current: "step" as const }, "baseline"],
    ["a re-plan (message from main, rejected plan)", phase, plan(node("a", "running")), { ...none, replan: true }, "baseline"],
    ["the fixed policy", FIXED_THINKING_POLICY, plan(node("a", "running")), none, "baseline"],
  ])("%s", (_name, settings, value, context, expected) => {
    expect(phaseTarget(settings, value, context).phase).toBe(expected);
  });
});

describe("the policy on task_plan boundaries", () => {
  const start = (levels = PI_DEFAULT, level = "high", settings = PHASE_THINKING_POLICY) => {
    const s = session(levels, level);
    beginThinkingPolicy(s, settings);
    return s;
  };
  it("plans at B, runs ordinary steps at S, does not switch between consecutive steps, integrates and reports at B", () => {
    const s = start();
    expect(s.thinkingLevel).toBe("high");
    expect(onTaskPlan(s, plan(node("a", "running"), node("b", "pending", {}, ["a"]), node("i", "pending", { phase: "integrate" }, ["b"])))[0]).toMatch(/run at medium, one level below the baseline high \(step node a\)/);
    expect(s.thinkingLevel).toBe("medium");
    // a done and b running in one call: still S, no switch.
    expect(onTaskPlan(s, plan(done("a"), node("b", "running", {}, ["a"]), node("i", "pending", { phase: "integrate" }, ["b"])))).toEqual([]);
    // b done, nothing running yet, next is integration: B.
    onTaskPlan(s, plan(done("a"), done("b", {}, ["a"]), node("i", "pending", { phase: "integrate" }, ["b"])));
    expect(s.thinkingLevel).toBe("high");
    onTaskPlan(s, plan(done("a"), done("b", {}, ["a"]), node("i", "running", { phase: "integrate" }, ["b"])));
    expect(s.thinkingLevel).toBe("high");
    expect(thinkingPolicySummary(s)).toMatchObject({ mode: "phase", baseline: "high", step: "medium", switches: 2 });
  });
  it("a node reopened after done, or whose check failed, runs at B (rework); the escalation is kept for the assignment", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running"), node("b", "pending", {}, ["a"])));
    onTaskPlan(s, plan(done("a"), node("b", "running", {}, ["a"])));
    expect(s.thinkingLevel).toBe("medium");
    // Integration found a wrong: a goes back to running.
    expect(onTaskPlan(s, plan(node("a", "running"), node("b", "pending", {}, ["a"]))).join("\n")).toMatch(/baseline high \(node a: reopened after it was finished \(rework\)\)/);
    expect(s.thinkingLevel).toBe("high");
    onTaskPlan(s, plan(done("a"), node("b", "running", { checkpoint: { result: "tests fail", evidence: ["npm test → 2 failed"], verification: "failed" } }, ["a"])));
    expect(s.thinkingLevel).toBe("high");
    expect(thinkingPolicyOf(s)!.escalated).toEqual(new Map([["a", "reopened after it was finished (rework)"], ["b", "its verification failed (rework)"]]));
  });
  it("a hard node runs at B; a rejected task_plan or a message from main plans again at B until the next accepted plan", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running", { hard: true })));
    expect(s.thinkingLevel).toBe("high");
    onTaskPlan(s, plan(done("a"), node("b", "running", {}, ["a"])));
    expect(s.thinkingLevel).toBe("medium");
    requireReplan(s, "rejected task_plan call");
    expect(s.thinkingLevel).toBe("high");
    onTaskPlan(s, plan(done("a"), node("b", "running", {}, ["a"])));
    expect(s.thinkingLevel).toBe("medium");
    requireReplan(s, "message from main");
    expect(s.thinkingLevel).toBe("high");
  });
  it("the fixed policy never changes the level", () => {
    const s = start(PI_DEFAULT, "high", FIXED_THINKING_POLICY);
    onTaskPlan(s, plan(node("a", "running")));
    requireReplan(s, "x");
    expect(s.sets.every(level => level === "high")).toBe(true);
    expect(s.thinkingLevel).toBe("high");
  });
  it("re-decomposition: a plan that does not split the running node is not progress; a real split is, and inherits B", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running", { hard: true }), node("b", "pending", {}, ["a"])));
    const state = thinkingPolicyOf(s)!;
    expect(requestRedecompose(s)).toEqual({ kind: "step", node: "a" });
    const notes = onTaskPlan(s, plan(node("a", "running", { hard: true, note: "still thinking" }), node("b", "pending", {}, ["a"])));
    expect(notes.join("\n")).toMatch(/does not split a into two or more new, smaller nodes \(a is still running\)/);
    expect(state).toMatchObject({ progress: 0, falseRedecompositions: 1, redecompositions: 0 });
    requestRedecompose(s);
    onTaskPlan(s, plan(node("a", "skipped", { hard: true }), node("a1", "running"), node("a2", "pending", {}, ["a1"]), node("b", "pending", {}, ["a"])));
    expect(state).toMatchObject({ progress: 1, redecompositions: 1 });
    // a ran at B (hard): its parts stay at B.
    expect(s.thinkingLevel).toBe("high");
    expect(state.escalated.get("a1")).toBe("split of a");
  });
  it("integration and no-plan requests, and the cap on re-decompositions", () => {
    const s = start();
    expect(requestRedecompose(s)).toEqual({ kind: "no-plan" });
    onTaskPlan(s, plan(done("a"), node("i", "running", { phase: "integrate" }, ["a"])));
    expect(requestRedecompose(s)).toEqual({ kind: "integrate", node: "i" });
    let nodes = [done("a"), node("i", "running", { phase: "integrate" }, ["a"])];
    for (let round = 0; round < MAX_REDECOMPOSITIONS; round++) {
      nodes = [...nodes.map(item => item.status === "running" ? { ...item, status: "skipped" as const } : item), node(`i${round}x`, "running", { phase: "integrate" }), node(`i${round}y`, "pending", { phase: "integrate" })];
      onTaskPlan(s, plan(...nodes));
      if (round < MAX_REDECOMPOSITIONS - 1) requestRedecompose(s);
    }
    expect(thinkingPolicyOf(s)!.redecompositions).toBe(MAX_REDECOMPOSITIONS);
    expect(requestRedecompose(s)).toEqual({ kind: "exhausted" });
    // A newly finished node is progress too.
    const before = thinkingPolicyOf(s)!.progress;
    onTaskPlan(s, plan(...nodes.map(item => item.status === "running" ? { ...item, status: "done" as const, checkpoint: { result: "R1 met", evidence: ["test → pass"], verification: "passed" as const } } : item)));
    expect(thinkingPolicyOf(s)!.progress).toBe(before + 1);
  });
  it("a report whose request ran at S is sent back and the report phase pins B; never re-accepted at S, no loop", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running")));
    noteRequestLevel(s); // the response carrying report_result ran at S
    expect(reportRewriteReason(s)).toMatch(/written at the reduced step effort \(medium\) while node a is still running.*baseline effort \(high\), which applies from your next request\. It is not counted as a failed attempt/);
    expect(s.thinkingLevel).toBe("high");
    // A plan that would go back to S (a step running again) stays at B in the report phase: the race cannot return to S.
    onTaskPlan(s, plan(done("a"), node("b", "running", {}, ["a"])));
    expect(s.thinkingLevel).toBe("high");
    noteRequestLevel(s);
    expect(reportRewriteReason(s)).toBeUndefined();
    expect(thinkingPolicySummary(s)).toMatchObject({ reportRewrites: 1 });
  });
  it("the level that counts is the request's, not the current one: task_plan switching to B in the same response does not launder an S report", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running")));
    noteRequestLevel(s); // request at S; its response calls task_plan (integration) and then report_result
    onTaskPlan(s, plan(done("a"), node("i", "running", { phase: "integrate" }, ["a"])));
    expect(s.thinkingLevel).toBe("high");
    expect(reportRewriteReason(s)).toMatch(/reduced step effort \(medium\)/);
  });
  it("a recovery step-down below B counts as below B too; a report at B, the fixed policy and no policy are never sent back", () => {
    const s = start(PI_DEFAULT, "high", { ...PHASE_THINKING_POLICY, lengthRecovery: "step-down" });
    lowerThinkingForRecovery(s);
    noteRequestLevel(s);
    expect(reportRewriteReason(s)).toMatch(/\(medium\)/);
    const atB = start();
    noteRequestLevel(atB);
    expect(reportRewriteReason(atB)).toBeUndefined();
    const fixed = start(PI_DEFAULT, "high", FIXED_THINKING_POLICY);
    lowerThinkingForRecovery(fixed);
    noteRequestLevel(fixed);
    expect(reportRewriteReason(fixed)).toBeUndefined();
    expect(reportRewriteReason(session(PI_DEFAULT, "low"))).toBeUndefined();
  });
  it("the report phase of a runtime report prompt: B before the request in every mode (the fixed policy: a recovery step-down is cleared)", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running")));
    expect(beginReportPhase(s, "forced report (request budget)")).toBe("high");
    onTaskPlan(s, plan(node("a", "running", { note: "x" })));
    expect(s.thinkingLevel).toBe("high");
    const fixed = start(PI_DEFAULT, "high", FIXED_THINKING_POLICY);
    lowerThinkingForRecovery(fixed);
    expect(fixed.thinkingLevel).toBe("medium");
    expect(beginReportPhase(fixed, "forced report (output limit)")).toBe("high");
  });
  it("a new assignment forgets the plan state and starts at B", () => {
    const s = start();
    onTaskPlan(s, plan(node("a", "running")));
    requestRedecompose(s);
    beginThinkingPolicy(s, PHASE_THINKING_POLICY);
    expect(s.thinkingLevel).toBe("high");
    const fresh = thinkingPolicyOf(s)!;
    expect([fresh.plan, fresh.redecompose, fresh.progress, fresh.escalated.size, fresh.reporting]).toEqual([undefined, undefined, 0, 0, false]);
    const thinking = thinkingStateOf(s);
    expect([thinking.baseline, thinking.step, thinking.phase, thinking.override]).toEqual(["high", "medium", "baseline", undefined]);
  });
});
