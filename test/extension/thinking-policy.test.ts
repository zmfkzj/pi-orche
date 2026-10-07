/**
 * The Task DAG thinking policy through orche_task (WorkerPool, real sessions, faux models; docs/thinking-policy.md): which effort each
 * request of a worker really runs at (the `reasoning` option the provider receives), the report guard, the reset between
 * assignments, sub-worker levels, messages from main, and the fixed default. Mechanics only: nothing here measures answer quality.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, fauxToolCall, type AssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { parseThinkingPolicyConfig } from "../../src/extension/config.js";
import { thinkingStateOf } from "../../src/pi/thinking-state.js";
import { createHarness, tool } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says hello.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
const implemented = (split: { decision: string; criteria?: string[]; reason: string } = { decision: "none", reason: "small" }) => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split } });
const cp = { result: "greeting checked", evidence: ["greeting.txt:1", "cat greeting.txt → hello world"], verification: "passed" };
type Node = { id: string; title: string; dependsOn: string[]; covers: string[]; status: string; phase?: string; hard?: boolean; note?: string; checkpoint?: unknown };
const n = (id: string, status: string, extra: Partial<Node> = {}, dependsOn: string[] = []): Node => ({ id, title: `Work ${id}`, dependsOn, covers: ["R1"], status, ...extra });
const plan = (...nodes: Node[]) => tool("task_plan", { nodes } as never);
const read = () => tool("read", { path: "greeting.txt" });

async function fixture(thinkingPolicy?: unknown, models?: Record<string, unknown>) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [], records: true });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: {}, mainMode: "single", ...(thinkingPolicy !== undefined ? { thinkingPolicy } : {}), ...(models ? { models } : {}) }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  opened.push(pool);
  // Main's model, which the worker inherits: reasoning levels off..high (B = high, S = medium).
  const mainFaux = fauxProvider({ provider: "main-reasoning", models: [{ id: "current", reasoning: true }] });
  h.runtime.registerNativeProvider(mainFaux.provider);
  const seen: { reasoning: string; last: string; first: string }[] = [];
  const script = (steps: (AssistantMessage | ((index: number) => AssistantMessage))[]) => mainFaux.setResponses(steps.map(step => ((context, options) => {
    seen.push({ reasoning: options?.reasoning ?? "off", last: JSON.stringify(context.messages.at(-1) ?? ""), first: JSON.stringify(context.messages[0] ?? "") });
    return typeof step === "function" ? step(seen.length) : step;
  }) as FauxResponseFactory));
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: mainFaux.getModel(), thinking: "high", ...args });
  return { h, pool, execute, script, seen };
}

describe("thinkingPolicy phase through orche_task", () => {
  it("plans at B, runs ordinary nodes at S without switching between them, integrates and reports at B; records every switch", async () => {
    const { execute, script, seen } = await fixture("phase");
    script([
      plan(n("a", "running"), n("b", "pending", {}, ["a"]), n("i", "pending", { phase: "integrate" }, ["b"])),
      read(),
      plan(n("a", "done", { checkpoint: cp }), n("b", "running", {}, ["a"]), n("i", "pending", { phase: "integrate" }, ["b"])),
      read(),
      plan(n("a", "done"), n("b", "done", { checkpoint: cp }, ["a"]), n("i", "running", { phase: "integrate" }, ["b"])),
      read(),
      plan(n("a", "done"), n("b", "done", {}, ["a"]), n("i", "done", { phase: "integrate", checkpoint: cp }, ["b"])),
      implemented(),
    ]);
    const result = await execute();
    expect(seen.map(item => item.reasoning)).toEqual(["high", "medium", "medium", "medium", "medium", "high", "high", "high"]);
    // The policy is in the assignment prompt; the result names baseline, step and switches.
    expect(seen[0]!.last).toContain("Task DAG effort (thinkingPolicy phase)");
    expect(result.text).toContain("Thinking policy: phase (baseline high, steps medium): 2 level switches");
    expect(result.details).toMatchObject({ thinking: "high", thinkingPolicy: { mode: "phase", baseline: "high", step: "medium", switches: 2 } });
    const events = (await readFile(join(result.details.record!, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; from?: string; to?: string; reason?: string });
    expect(events.filter(event => event.type === "thinking_change").map(event => [event.from, event.to, event.reason])).toEqual([["high", "medium", "step node a"], ["medium", "high", "integration node i"]]);
    const run = JSON.parse(await readFile(join(result.details.record!, "run.json"), "utf8")) as { outcome: Record<string, unknown> };
    expect(run.outcome).toMatchObject({ thinkingPolicy: { mode: "phase", switches: 2 } });
  });

  it("a report written at S is discarded and rewritten at B in the next request (not a result retry); a missing checkpoint is refused at B", async () => {
    const { execute, script, seen } = await fixture("phase");
    script([
      plan(n("a", "running")),
      implemented(),
      plan(n("a", "done")),
      plan(n("a", "done", { checkpoint: cp })),
      implemented(),
    ]);
    const result = await execute();
    // Request trace: plan at B, the S report, then everything at B (the report phase): the rewrite never runs at S.
    expect(seen.map(item => item.reasoning)).toEqual(["high", "medium", "high", "high", "high"]);
    expect(seen[2]!.last).toMatch(/Result not accepted yet: This report_result was written at the reduced step effort \(medium\) while node a is still running.*baseline effort \(high\), which applies from your next request\. It is not counted as a failed attempt/);
    expect(seen[3]!.last).toMatch(/Invalid checkpoints: a is marked done without a checkpoint/);
    expect(result.details).toMatchObject({ status: "done", thinkingPolicy: { reportRewrites: 1 } });
    expect(result.text).toContain("1 report written below the baseline rewritten at it");
    const events = (await readFile(join(result.details.record!, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; attempt?: number });
    expect(events.filter(event => event.type === "result_rewrite").map(event => event.attempt)).toEqual([1]);
    expect(events.filter(event => event.type === "result_rejected")).toEqual([]);
  });

  it("race: task_plan switching to integration and report_result in the same S response; the report is still rewritten at B", async () => {
    const { execute, script, seen } = await fixture("phase");
    const both = reply([
      fauxToolCall("task_plan", { nodes: [n("a", "done", { checkpoint: cp }), n("i", "running", { phase: "integrate" }, ["a"])] } as never),
      fauxToolCall("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: { decision: "none", reason: "small" } } } as never),
    ], { stopReason: "toolUse" });
    script([
      plan(n("a", "running"), n("i", "pending", { phase: "integrate" }, ["a"])),
      both,
      plan(n("a", "done"), n("i", "done", { phase: "integrate", checkpoint: cp }, ["a"])),
      implemented(),
    ]);
    const result = await execute();
    expect(seen.map(item => item.reasoning)).toEqual(["high", "medium", "high", "high"]);
    expect(result.details).toMatchObject({ status: "done", thinkingPolicy: { reportRewrites: 1 } });
  });

  it("a message from main mid-assignment sends the worker back to B until its next plan", async () => {
    const { pool, execute, script, seen } = await fixture("phase");
    script([
      plan(n("a", "running")),
      () => { expect(pool.inject("W1", "Also keep the trailing newline.").status).toBe("queued"); return read(); },
      plan(n("a", "running", { note: "trailing newline too" })),
      plan(n("a", "done", { checkpoint: cp })),
      implemented(),
    ]);
    await execute();
    expect(seen.map(item => item.reasoning)).toEqual(["high", "medium", "high", "medium", "high"]);
  });

  it("every assignment starts at its own B: a failed one left at S does not leak, and a new main level gives a new B and S", async () => {
    const { pool, execute, script, seen } = await fixture("phase");
    script([plan(n("a", "running")), reply("no report"), reply("still no report")]);
    expect(await execute().catch((error: unknown) => error)).toBeInstanceOf(TaskFailedError);
    expect(pool.session("W1").thinkingLevel).toBe("high");
    script([plan(n("a", "running")), plan(n("a", "done", { checkpoint: cp })), implemented()]);
    seen.length = 0;
    await execute({ worker: "W1", thinking: "medium" });
    expect(seen.map(item => item.reasoning)).toEqual(["medium", "low", "medium"]);
    expect(thinkingStateOf(pool.session("W1"))).toMatchObject({ baseline: "medium", step: "low" });
  });

  it("standard sub-workers run at S of the orchestrator's B, an independent verifier at B; never chained", async () => {
    const { execute, script } = await fixture("phase");
    const answered = tool("report_result", { kind: "answer", summary: "greeting.txt says hello world", data: { evidence: ["greeting.txt:1"] } });
    script([
      plan(n("a", "running")),
      tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "one", role: "answer", request: "Read greeting.txt." }, { name: "two", role: "answer", request: "Read greeting.txt too." }] }),
      answered, answered,
      plan(n("a", "done", { checkpoint: cp }), n("v", "running", { phase: "integrate" })),
      tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] }),
      tool("report_result", { kind: "verify", summary: "ok", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } }),
      plan(n("a", "done"), n("v", "done", { phase: "integrate", checkpoint: cp })),
      implemented({ decision: "split", criteria: ["parallelism", "verification"], reason: "two reads and an independent check" }),
    ]);
    const result = await execute();
    expect(result.details.spawned?.map(item => [item.name, item.thinking, item.thinkingSource])).toEqual([
      ["one", "medium", "orchestrator:step"], ["two", "medium", "orchestrator:step"], ["check", "high", "orchestrator"],
    ]);
  });

  it("models.worker without a level: the step level is computed on that model from the orchestrator's B", async () => {
    // tier-limited supports minimal and high only: B high → S minimal on that model (on main's model it would be medium).
    const worker = fauxProvider({ provider: "tier-limited", models: [{ id: "w1", reasoning: true }] });
    Object.assign(worker.getModel(), { thinkingLevelMap: { off: null, low: null, medium: null } });
    const { h, execute, script } = await fixture("phase", { worker: { model: "tier-limited/w1" } });
    h.runtime.registerNativeProvider(worker.provider);
    worker.setResponses([
      tool("report_result", { kind: "answer", summary: "hello world", data: { evidence: ["greeting.txt:1"] } }),
      tool("report_result", { kind: "answer", summary: "hello world", data: { evidence: ["greeting.txt:1"] } }),
      tool("report_result", { kind: "verify", summary: "ok", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } }),
    ]);
    script([
      tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "one", role: "answer", request: "Read greeting.txt." }, { name: "two", role: "answer", request: "Read greeting.txt too." }] }),
      tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] }),
      implemented({ decision: "split", criteria: ["parallelism", "verification"], reason: "two reads and an independent check" }),
    ]);
    const result = await execute();
    expect(result.details.spawned?.map(item => [item.name, item.model, item.thinking, item.thinkingSource])).toEqual([
      ["one", "tier-limited/w1", "minimal", "orchestrator:step"], ["two", "tier-limited/w1", "minimal", "orchestrator:step"], ["check", "tier-limited/w1", "high", "orchestrator"],
    ]);
  });

  it("an explicit models.worker level is kept for every sub-worker", async () => {
    const worker = fauxProvider({ provider: "tier-worker", models: [{ id: "w1", reasoning: true }] });
    const { h, execute, script } = await fixture("phase", { worker: { model: "tier-worker/w1", thinking: "high" } });
    h.runtime.registerNativeProvider(worker.provider);
    worker.setResponses([tool("report_result", { kind: "verify", summary: "ok", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } })]);
    script([
      tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] }),
      implemented({ decision: "split", criteria: ["verification"], reason: "independent check" }),
    ]);
    const result = await execute();
    expect(result.details.spawned?.map(item => [item.thinking, item.thinkingSource])).toEqual([["high", "config"]]);
  });
});

describe("the default stays fixed", () => {
  it("without thinkingPolicy every request runs at the assignment's level, checkpoints are optional and the prompt has no policy text", async () => {
    const { execute, script, seen } = await fixture();
    script([plan(n("a", "running")), read(), plan(n("a", "done")), implemented()]);
    const result = await execute();
    expect(new Set(seen.map(item => item.reasoning))).toEqual(new Set(["high"]));
    expect(seen[0]!.last).not.toContain("thinkingPolicy");
    expect(result.details.thinkingPolicy).toBeUndefined();
    expect(result.text).not.toContain("Thinking policy");
    // Every plan of the pre-policy format was accepted (no task_plan error reached the model), and nothing was sent back.
    expect(seen.slice(1).map(item => item.last).filter(text => /"isError":true/.test(text))).toEqual([]);
    const events = (await readFile(join(result.details.record!, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string });
    expect(events.filter(event => event.type === "result_rewrite" || event.type === "thinking_change")).toEqual([]);
  });
  it.each([
    ["fixed", "fixed"],
    ["phase without checkpoints (arm b)", { mode: "phase", checkpoints: false, escalation: false, lengthRecovery: "step-down", subWorkers: false }],
  ])("%s: a multi-node plan in the pre-policy format (no phase, hard or checkpoint) is accepted as it is", async (_name, policy) => {
    const { execute, script, seen } = await fixture(policy);
    script([
      plan(n("a", "running"), n("b", "pending", {}, ["a"])),
      plan(n("a", "done"), n("b", "running", {}, ["a"])),
      plan(n("a", "done"), n("b", "done", {}, ["a"])),
      implemented(),
    ]);
    const result = await execute();
    expect(seen.slice(1).map(item => item.last).filter(text => /"isError":true/.test(text))).toEqual([]);
    expect(result.details.status).toBe("done");
    expect(result.details.plan?.nodes.map(node => node.status)).toEqual(["done", "done"]);
  });
  it("checkpoints alone (arm d: fixed B with checkpoints) keep B and require checkpoints", async () => {
    const { execute, script, seen } = await fixture({ mode: "fixed", checkpoints: true });
    script([plan(n("a", "running")), plan(n("a", "done")), plan(n("a", "done", { checkpoint: cp })), implemented()]);
    await execute();
    expect(new Set(seen.map(item => item.reasoning))).toEqual(new Set(["high"]));
    expect(seen[0]!.last).toContain("Task DAG checkpoints (thinkingPolicy)");
    expect(seen[2]!.last).toMatch(/Invalid checkpoints/);
    expect(seen[2]!.last).toMatch(/"isError":true/); // the detector the pre-policy-format tests rely on
  });
});

describe("thinkingPolicy config", () => {
  it("accepts the two modes and per-field overrides, with the mode's defaults", () => {
    expect(parseThinkingPolicyConfig("fixed")).toEqual({ mode: "fixed", checkpoints: false, escalation: false, lengthRecovery: "step-down", subWorkers: false });
    expect(parseThinkingPolicyConfig("phase")).toEqual({ mode: "phase", checkpoints: true, escalation: true, lengthRecovery: "redecompose", subWorkers: true });
    expect(parseThinkingPolicyConfig({ mode: "phase", checkpoints: false, escalation: false, lengthRecovery: "step-down" })).toEqual({ mode: "phase", checkpoints: false, escalation: false, lengthRecovery: "step-down", subWorkers: true });
    expect(parseThinkingPolicyConfig({ checkpoints: true, lengthRecovery: "redecompose" })).toMatchObject({ mode: "fixed", checkpoints: true, lengthRecovery: "redecompose" });
  });
  it.each([
    ["an unknown mode", "lower", /expected "fixed", "phase" or an object/],
    ["an unknown field", { mode: "phase", stepLevels: 2 }, /unknown field stepLevels/],
    ["a bad mode", { mode: "auto" }, /mode: expected "fixed" or "phase"/],
    ["a bad boolean", { checkpoints: "yes" }, /checkpoints: expected boolean/],
    ["a bad ladder", { lengthRecovery: "lower" }, /lengthRecovery: expected "redecompose" or "step-down"/],
  ])("rejects %s", (_name, value, error) => {
    expect(() => parseThinkingPolicyConfig(value)).toThrow(error);
  });
});
