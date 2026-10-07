import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage as reply, fauxProvider, fauxThinking as thinking, fauxToolCall as call,
  InMemoryCredentialStore, type AssistantMessage, type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { AgentManager, MAX_REPORT_REWRITES } from "../../src/agent/agent-manager.js";
import type { ManagerEvent } from "../../src/agent/agent-handle.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import { createTaskPlanTool, type TaskPlan } from "../../src/tools/task-plan.js";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { beginThinkingPolicy, FIXED_THINKING_POLICY, onTaskPlan, PHASE_THINKING_POLICY, reportRewriteReason, type ThinkingPolicySettings } from "../../src/pi/thinking-policy.js";

/**
 * The final report is written at the assignment's baseline effort B (docs/thinking-policy.md, "Report at B"): per-request effort
 * traces (the `reasoning` option the faux provider receives) through AgentManager, orche's session factory and Pi's AgentSession,
 * wired like WorkerPool (task_plan → onTaskPlan, reviseResult → reportRewriteReason). B = high, S = medium.
 */
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

type Node = TaskPlan["nodes"][number];
const node = (id: string, status: Node["status"], extra: Partial<Node> = {}): Node => ({ id, title: `Work ${id}`, dependsOn: [], covers: ["R1"], status, ...extra });
const capped = (): AssistantMessage => reply([thinking("t".repeat(32_000 * 4))], { stopReason: "length" });
const plan = (...nodes: Node[]): AssistantMessage => reply([call("task_plan", { nodes } as never)], { stopReason: "toolUse" });
const read = (): AssistantMessage => reply([call("read", { path: "notes.txt" })], { stopReason: "toolUse" });
const report = (): AssistantMessage => reply([call("report_result", { kind: "answer", summary: "notes.txt says ok", data: { evidence: ["notes.txt:1"] } })], { stopReason: "toolUse" });

interface Seen { reasoning: string; last: string }
async function run(settings: ThinkingPolicySettings, script: (request: number, seen: Seen[]) => AssistantMessage, options: { requestBudget?: number; ladder?: "redecompose" | "step-down"; revise?: () => string | undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orche-report-effort-"));
  await writeFile(join(dir, "notes.txt"), "ok\n");
  const faux = fauxProvider({ provider: `report-${Math.random().toString(36).slice(2, 8)}`, models: [{ id: "m", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 }] });
  const seen: Seen[] = [];
  const factory: FauxResponseFactory = context => {
    seen.push({ reasoning: "", last: JSON.stringify(context.messages.at(-1) ?? "") });
    return script(seen.length, seen);
  };
  faux.setResponses(Array.from({ length: 40 }, () => ((context, opts, state, model) => { const message = factory(context, opts, state, model); seen.at(-1)!.reasoning = opts?.reasoning ?? "off"; return message; }) as FauxResponseFactory));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const manager = new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas, ...(options.requestBudget ? { requestBudget: options.requestBudget } : {}) });
  const events: ManagerEvent[] = [];
  manager.subscribe(event => { events.push(event); });
  cleanup.push(async () => { await manager.disposeWithin(2_000).catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
  const tool = createTaskPlanTool(value => onTaskPlan(manager.session("W1"), value));
  await manager.spawn({ id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model: `${faux.provider.id}/m`, thinking: "high" }, instructions: "worker", peerMessaging: false,
    tools: [...WORKER_TOOL_NAMES, "task_plan"], customTools: [tool], lengthRecovery: { ...(options.ladder ? { ladder: options.ladder } : {}) },
    reviseResult: options.revise ?? (() => reportRewriteReason(manager.session("W1"))) });
  beginThinkingPolicy(manager.session("W1"), settings);
  manager.assign("W1", "answer", "Assignment: answer. What does notes.txt say?");
  const waited = await manager.wait("W1", 15_000);
  const outcome = waited.type === "outcome" ? waited.outcome : undefined;
  return { outcome, seen, events, efforts: seen.map(item => item.reasoning) };
}

describe("forced reports of the runtime run at B", () => {
  it("request budget: the stopped turn's forced report prompt is answered at B, after steps at S", async () => {
    // Budget 2 → stop at 3 requests: plan (B), read (S), read (S, stopped), forced report (B).
    const { outcome, efforts, events, seen } = await run(PHASE_THINKING_POLICY, request => [plan(node("a", "running")), read(), read()][request - 1] ?? report(), { requestBudget: 2 });
    expect(efforts).toEqual(["high", "medium", "medium", "high"]);
    expect(seen.at(-1)!.last).toMatch(/request budget .* is exhausted/);
    expect(events.filter(event => event.type === "request_budget").map(event => event.type === "request_budget" && event.action)).toEqual(["notice", "stop"]);
    expect(outcome).toMatchObject({ status: "completed" });
    expect(events.some(event => event.type === "result_rewrite")).toBe(false);
  });

  it("output limit exhausted (step-down ladder): the forced report is answered at B, not at the stepped-down level", async () => {
    const { outcome, efforts } = await run(FIXED_THINKING_POLICY, request => request <= 3 ? capped() : report(), { ladder: "step-down" });
    // high, high (nudge), medium (last recovery one level lower), forced report at B.
    expect(efforts).toEqual(["high", "high", "medium", "high"]);
    expect(outcome).toMatchObject({ status: "completed", lengthStops: { count: 3, exhausted: true } });
  });

  it("output limit exhausted inside a step (phase, split ladder): the forced report is answered at B", async () => {
    const { outcome, efforts } = await run(PHASE_THINKING_POLICY, request => request === 1 ? plan(node("a", "running")) : request <= 4 ? capped() : report());
    // plan (B), three overruns at S (nudge, split asked, exhausted), forced report at B.
    expect(efforts).toEqual(["high", "medium", "medium", "medium", "high"]);
    expect(outcome?.status).toBe("completed");
  });

  it("the missing-result nudge is answered at B", async () => {
    const { outcome, efforts } = await run(PHASE_THINKING_POLICY, request => [plan(node("a", "running")), reply("I think it says ok.")][request - 1] ?? report());
    expect(efforts).toEqual(["high", "medium", "high"]);
    expect(outcome?.status).toBe("completed");
  });
});

describe("a report below B is never accepted", () => {
  it("a spontaneous report at S during the budget notice is rewritten at B (not a result retry)", async () => {
    const { outcome, efforts, events } = await run(PHASE_THINKING_POLICY, request => [plan(node("a", "running")), read(), report()][request - 1] ?? report(), { requestBudget: 2 });
    expect(efforts).toEqual(["high", "medium", "medium", "high"]);
    expect(events.filter(event => event.type === "result_rewrite")).toHaveLength(1);
    expect(events.filter(event => event.type === "result_rejected")).toEqual([]);
    expect(outcome?.status).toBe("completed");
  });

  it("fail-closed: when B cannot be applied the report is rewritten at most MAX_REPORT_REWRITES times, then the assignment fails (never completed)", async () => {
    const { outcome, efforts, events } = await run(PHASE_THINKING_POLICY, request => request === 1 ? plan(node("a", "running")) : report(), { revise: () => "This report_result was written at the reduced step effort (medium); stuck" });
    expect(efforts).toHaveLength(MAX_REPORT_REWRITES + 2);
    expect(events.filter(event => event.type === "result_rewrite")).toHaveLength(MAX_REPORT_REWRITES + 1);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toMatch(/Report not accepted: This report_result was written at the reduced step effort \(medium\), again after 2 rewrites \(the required thinking level could not be applied\)/);
  });

  it("a model error in the rewrite request fails the assignment; the discarded S report is never the result", async () => {
    const { outcome, efforts } = await run(PHASE_THINKING_POLICY, request => [plan(node("a", "running")), report()][request - 1] ?? reply([], { stopReason: "error", errorMessage: "400 invalid request" }));
    expect(efforts.slice(0, 3)).toEqual(["high", "medium", "high"]);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.result).toBeUndefined();
  });

  it("the fixed policy never sends a report back", async () => {
    const { outcome, efforts, events } = await run(FIXED_THINKING_POLICY, request => [plan(node("a", "running")), report()][request - 1] ?? report());
    expect(efforts).toEqual(["high", "high"]);
    expect(events.some(event => event.type === "result_rewrite")).toBe(false);
    expect(outcome?.status).toBe("completed");
  });
});
