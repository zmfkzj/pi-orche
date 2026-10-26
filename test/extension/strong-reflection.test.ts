/**
 * Strong-mode reflection before the self-review (`single.strongReflection`, src/single/reflection.ts) through the real stack:
 * WorkerPool → AgentManager → Pi AgentSession with faux models. These tests check wiring only (prompt text, where and when the model
 * receives it, which modes get it); they say nothing about whether a real model reviews better with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { parseSingleConfig } from "../../src/extension/config.js";
import { integrationReflection, REPORT_REFLECTION, STRONG_REFLECTION_PROMPT, StrongReflection } from "../../src/single/reflection.js";
import { createHarness, tool } from "./harness.js";

/** The user's four lines, written out here independently of the exported constant. */
const USER_PROMPT = `지금까지의 대화를 한 걸음 떨어져 바라보라.
기존 판단을 옹호하거나 부정하려는 목적 없이, 대화에 드러난 전제와 판단 경향을 살펴보라.
무엇을 충분히 살폈고 무엇을 당연하게 넘겼는지 돌아보되, 장점이나 단점을 억지로 만들어내지 마라.
그 관찰에서 실제로 판단을 바꿀 이유가 발견되면 결과에 반영하라.`;
const FIRST_LINE = "지금까지의 대화를 한 걸음 떨어져 바라보라.";

const opened: { dispose(): Promise<void> }[] = [];
const temp: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true });
});

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says fixed.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
const split = { decision: "none", reason: "small" };
type Args = ToolCall["arguments"];
const report = (data: Args = { status: "done", checklist, split }): Args => ({ kind: "implement", summary: "Done", data });
const step = { id: "N1", title: "fix", dependsOn: [], covers: ["R1"] };
const integration = { id: "N2", title: "integrate", dependsOn: ["N1"], covers: ["R1"] };
const plan1 = () => tool("task_plan", { nodes: [{ ...step, status: "running" }, { ...integration, status: "pending", phase: "integrate" }] });
/** Starts the integration node; `phase` is omitted on purpose: it is carried over from the previous plan. */
const plan2 = () => tool("task_plan", { nodes: [{ ...step, status: "done" }, { ...integration, status: "running" }] });
const plan3 = () => tool("task_plan", { nodes: [{ ...step, status: "done" }, { ...integration, status: "done" }] });
const reported = (data?: Args) => tool("report_result", report(data));

interface Seen { results: { name: string; text: string }[]; all: string }
/** Wraps each step so that the context of the request it answers is kept: the tool results it ends with, and all of it. */
function recording(steps: AssistantMessage[], seen: Seen[]): FauxResponseStep[] {
  return steps.map(message => ((context => {
    const results: Seen["results"] = [];
    for (let i = context.messages.length - 1; i >= 0 && context.messages[i]!.role === "toolResult"; i--) {
      const result = context.messages[i] as { toolName?: string; content?: { type: string; text?: string }[] };
      results.unshift({ name: result.toolName ?? "?", text: (result.content ?? []).map(part => part.text ?? "").join("") });
    }
    seen.push({ results, all: JSON.stringify(context.messages) });
    return message;
  }) as FauxResponseFactory));
}
const count = (text: string, part: string) => text.split(part).length - 1;

async function fixture(single: Record<string, unknown> | undefined) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", ...(single ? { single } : {}) }));
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-scratch-"));
  temp.push(scratchBase);
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, scratchBase });
  opened.push(pool);
  const main = fauxProvider({ provider: "main-reasoning", models: [{ id: "current", reasoning: true }] });
  h.runtime.registerNativeProvider(main.provider);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "strong", model: main.getModel(), thinking: "high", ...args });
  // Every worker model in these tests is main's (the strong tiers are unset, so standard roles inherit it).
  const script = (steps: AssistantMessage[]) => { const seen: Seen[] = []; main.setResponses(recording(steps, seen)); return seen; };
  return { pool, execute, script, main };
}

describe("single.strongReflection config", () => {
  it("is absent unless set, accepts only booleans, and leaves the other single settings as they were", () => {
    expect(parseSingleConfig({})).toEqual({ ledger: false, spawn: true, advisor: false, maxSubWorkers: 4 });
    expect("strongReflection" in parseSingleConfig({})).toBe(false);
    expect(parseSingleConfig({ strongReflection: true })).toEqual({ ledger: false, spawn: true, advisor: false, maxSubWorkers: 4, strongReflection: true });
    expect(parseSingleConfig({ strongReflection: false }).strongReflection).toBe(false);
    expect(() => parseSingleConfig({ strongReflection: "yes" })).toThrow("config.single.strongReflection: expected boolean");
  });

  it("StrongReflection: once per assignment; a report of the delivering response is held, a later one passes", () => {
    let calls = ["c1", "c2"];
    const reflection = new StrongReflection({ responseCalls: () => calls });
    const nodes = [{ ...step, status: "done" as const }, { ...integration, status: "running" as const, phase: "integrate" as const }];
    expect(reflection.onPlan({ nodes: [{ ...step, status: "running" }] })).toEqual([]);
    expect(reflection.onPlan({ nodes })[0]).toContain(USER_PROMPT);
    expect(reflection.onPlan({ nodes })).toEqual([]);
    expect(reflection.beforeReport("c2")).toContain("same response");
    calls = ["c3"];
    expect(reflection.beforeReport("c3")).toBeUndefined();
    expect(reflection.summary()).toMatchObject({ delivered: "integrate", node: "N2", sameResponseHolds: 1 });
    const fallback = new StrongReflection({ responseCalls: () => ["r1"] });
    expect(fallback.beforeReport("r1")).toContain(USER_PROMPT);
    expect(fallback.beforeReport("r2")).toBeUndefined();
    expect(new StrongReflection().summary()).toEqual({ delivered: "none" });
  });

  it("the prompt constant is the user's four lines, character for character", () => {
    expect(STRONG_REFLECTION_PROMPT).toBe(USER_PROMPT);
    expect(REPORT_REFLECTION).toContain(USER_PROMPT);
    expect(integrationReflection("N9")).toContain(USER_PROMPT);
    expect(STRONG_REFLECTION_PROMPT.split("\n")).toHaveLength(4);
  });
});

describe("strong mode with single.strongReflection: the prompt before the self-review", () => {
  it("rides on the accepted task_plan that starts the integration node (phase carried over) and reaches the next request once", async () => {
    const { pool, execute, script } = await fixture({ strongReflection: true });
    const seen = script([plan1(), plan2(), plan3(), reported()]);
    const result = await execute();
    expect(seen).toHaveLength(4);
    // Not in the hand-off and not at the plan that only creates the integration node.
    expect(seen[0]!.all).not.toContain(FIRST_LINE);
    expect(seen[1]!.results.map(item => item.text).join("")).not.toContain(FIRST_LINE);
    // The request after the integration node started: the task_plan result ends with the prompt, verbatim.
    expect(seen[2]!.results).toHaveLength(1);
    expect(seen[2]!.results[0]!.name).toBe("task_plan");
    expect(seen[2]!.results[0]!.text).toContain(`integration node N2):\n${USER_PROMPT}\nThen carry out the integration as planned`);
    expect(count(seen[2]!.all, FIRST_LINE)).toBe(1);
    // The report after the review is accepted at once; the prompt is never repeated.
    expect(count(seen[3]!.all, FIRST_LINE)).toBe(1);
    expect(result.details.reflection).toMatchObject({ delivered: "integrate", node: "N2" });
    expect(result.details.status).toBe("done");
    expect(result.text).toContain("Reflection (single.strongReflection, experiment): given at the start of integration node N2.");
    expect(pool.session(result.details.worker).messages.filter(message => message.role === "toolResult" && JSON.stringify(message).includes("Result rejected"))).toHaveLength(0);
  });

  it("without an integration node: the first report is held once (no validation error), the next one is accepted", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const seen = script([plan1(), reported(), reported()]);
    const result = await execute();
    expect(seen).toHaveLength(3);
    const held = seen[2]!.results;
    expect(held).toHaveLength(1);
    expect(held[0]!.name).toBe("report_result");
    expect(held[0]!.text).toContain(`Report held once (strong mode, single.strongReflection): this is not a validation error`);
    expect(held[0]!.text).toContain(`Before your self-review of the result:\n${USER_PROMPT}\nThen review the result afresh`);
    expect(held[0]!.text).not.toContain("attempts left");
    expect(result.details.reflection).toMatchObject({ delivered: "report" });
    expect(result.details.status).toBe("done");
  });

  it("an integration node that goes pending → done in one call ran without the prompt: the report is held", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const seen = script([plan1(), plan3(), reported(), reported()]);
    const result = await execute();
    expect(seen).toHaveLength(4);
    expect(seen[2]!.all).not.toContain(FIRST_LINE);
    expect(seen[3]!.results[0]!.text).toContain(USER_PROMPT);
    expect(result.details.reflection).toMatchObject({ delivered: "report" });
  });

  it("a report_result in the same response as the integration start is never accepted before the prompt was read", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const both = fauxAssistantMessage([fauxToolCall("task_plan", { nodes: [{ ...step, status: "done" }, { ...integration, status: "running" }] }), fauxToolCall("report_result", report())], { stopReason: "toolUse" });
    const seen = script([plan1(), both, reported()]);
    const result = await execute();
    expect(seen).toHaveLength(3);
    const texts = seen[2]!.results.map(item => `${item.name}: ${item.text}`);
    // Pi runs the tool_call hooks of a response before its tools, so the report's hold carries the prompt here (the task_plan
    // result then does not repeat it); either way the prompt reaches the model exactly once and the report is held.
    expect(texts.filter(text => text.includes(USER_PROMPT))).toHaveLength(1);
    expect(texts.some(text => text.startsWith("report_result: Report held"))).toBe(true);
    expect(count(seen[2]!.all, FIRST_LINE)).toBe(1);
    expect(result.details.reflection?.delivered).not.toBe("none");
    expect(result.details.status).toBe("done");
  });

  it("two report_result calls in one response: both held, the report after the prompt was read is accepted", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const twice = fauxAssistantMessage([fauxToolCall("report_result", report()), fauxToolCall("report_result", report())], { stopReason: "toolUse" });
    const seen = script([plan1(), twice, reported()]);
    const result = await execute();
    expect(seen).toHaveLength(3);
    const texts = seen[2]!.results.map(item => item.text);
    expect(texts).toHaveLength(2);
    expect(texts.filter(text => text.includes(USER_PROMPT))).toHaveLength(1);
    expect(texts.filter(text => text.includes("it was sent in the same response"))).toHaveLength(1);
    expect(result.details.reflection).toMatchObject({ delivered: "report", sameResponseHolds: 1 });
  });

  it("keeps the existing gates: a report without its checklist is still rejected after the reflection", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const seen = script([plan1(), plan2(), plan3(), reported({ status: "done", split }), reported()]);
    const result = await execute();
    expect(seen).toHaveLength(5);
    expect(seen[4]!.results[0]!.text).toContain("Result rejected");
    expect(seen[4]!.results[0]!.text).toContain("checklist");
    expect(result.details.status).toBe("done");
  });

  it("a rejected task_plan does not use up the reflection: the next accepted plan that starts integration carries it", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const invalid = tool("task_plan", { nodes: [{ ...step, status: "done" }, { ...integration, covers: ["R9"], status: "running" }] });
    const seen = script([plan1(), invalid, plan2(), plan3(), reported()]);
    const result = await execute();
    expect(seen).toHaveLength(5);
    expect(seen[2]!.results[0]!.text).toContain("Unknown covers ids");
    expect(seen[2]!.all).not.toContain(FIRST_LINE);
    expect(seen[3]!.results[0]!.text).toContain(USER_PROMPT);
    expect(result.details.reflection).toMatchObject({ delivered: "integrate", node: "N2" });
  });

  it("answer assignments get it too (their first report is held when no integration ran)", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const answer = () => tool("report_result", { kind: "answer", summary: "It says hello.", data: { evidence: ["greeting.txt:1"], checklist: [{ id: "R1", status: "met", evidence: "greeting.txt:1" }], split } });
    const seen = script([answer(), answer()]);
    const result = await execute({ role: "answer" });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.results[0]!.text).toContain(USER_PROMPT);
    expect(result.details.reflection).toMatchObject({ delivered: "report" });
  });
});

describe("single.strongReflection targets strong only", () => {
  it("strong without the key, or with false: no prompt, nothing held (the behaviour before)", async () => {
    for (const single of [undefined, { strongReflection: false }]) {
      const { execute, script } = await fixture(single);
      const seen = script([plan1(), plan2(), plan3(), reported()]);
      const result = await execute();
      expect(seen).toHaveLength(4);
      expect(seen.every(item => !item.all.includes(FIRST_LINE))).toBe(true);
      expect(result.details.reflection).toBeUndefined();
      expect(result.text).not.toContain("Reflection (single.strongReflection");
    }
  });

  it("enabled, but single mode, or a verify worker in strong mode: no prompt, nothing held", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const seen = script([plan1(), plan2(), plan3(), reported()]);
    const single = await execute({ mainMode: "single" });
    expect(seen).toHaveLength(4);
    expect(seen.every(item => !item.all.includes(FIRST_LINE))).toBe(true);
    expect(single.details.reflection).toBeUndefined();
    const verifySeen = script([tool("report_result", { kind: "verify", summary: "fine", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } })]);
    const verify = await execute({ role: "verify" });
    expect(verifySeen).toHaveLength(1);
    expect(verify.details.reflection).toBeUndefined();
  });

  it("enabled, ultra mode: its blocked report is not held and carries no prompt", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const seen = script([tool("report_result", { kind: "implement", summary: "Blocked before exploration", data: { status: "blocked", reason: "the user must decide the wording first", checklist: [{ id: "R1", status: "partial", evidence: "not done yet" }], ultra: { stage: "exploration" } } })]);
    const result = await execute({ mainMode: "ultra" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.all).not.toContain(FIRST_LINE);
    expect(result.details.reflection).toBeUndefined();
  });

  it("a reused worker: strong gets it per assignment, a single assignment in between does not", async () => {
    const { execute, script } = await fixture({ strongReflection: true });
    const first = script([plan1(), plan2(), plan3(), reported()]);
    const a = await execute();
    expect(first.some(item => item.all.includes(FIRST_LINE))).toBe(true);
    const between = script([plan1(), plan2(), plan3(), reported()]);
    const b = await execute({ worker: a.details.worker, mainMode: "single" });
    expect(b.details.worker).toBe(a.details.worker);
    expect(b.details.reflection).toBeUndefined();
    // The single assignment's own requests add no prompt (the first assignment's tool result may still be in the context).
    expect(between.map(item => count(item.all, FIRST_LINE))).toEqual(between.map(() => count(between[0]!.all, FIRST_LINE)));
    const again = script([plan1(), plan2(), plan3(), reported()]);
    const c = await execute({ worker: a.details.worker });
    expect(c.details.reflection).toMatchObject({ delivered: "integrate", node: "N2" });
    expect(count(again[2]!.all, FIRST_LINE)).toBe(count(again[1]!.all, FIRST_LINE) + 1);
  });
});
