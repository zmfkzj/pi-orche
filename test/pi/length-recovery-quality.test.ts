import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage as reply, fauxProvider, fauxThinking as thinking, fauxToolCall as call,
  InMemoryCredentialStore, type AssistantMessage, type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import { createTaskPlanTool, type TaskPlan } from "../../src/tools/task-plan.js";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { beginThinkingPolicy, FIXED_THINKING_POLICY, onTaskPlan, PHASE_THINKING_POLICY, thinkingPolicyOf, type ThinkingPolicySettings } from "../../src/pi/thinking-policy.js";
import { runScenario } from "../../experiments/length-recovery/bench.js";

/**
 * The quality-first output-limit recovery (`redecompose` ladder, src/pi/length-recovery.ts + src/pi/thinking-policy.ts) through the
 * real stack: AgentManager, orche's session factory, Pi's AgentSession and a scripted faux model (B = high, S = medium).
 * Controlled reproductions of the mechanics; no statement about how a real model behaves or about answer quality.
 */
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

type Node = TaskPlan["nodes"][number];
const node = (id: string, status: Node["status"], extra: Partial<Node> = {}): Node => ({ id, title: `Work ${id}`, dependsOn: [], covers: ["R1"], status, ...extra });
const cp = { result: "done", evidence: ["notes.txt:1"], verification: "passed" as const };
const capped = (): AssistantMessage => reply([thinking("t".repeat(32_000 * 4))], { stopReason: "length" });
const plan = (...nodes: Node[]): AssistantMessage => reply([call("task_plan", { nodes })], { stopReason: "toolUse" });
const read = (): AssistantMessage => reply([call("read", { path: "notes.txt" })], { stopReason: "toolUse" });
const report = (): AssistantMessage => reply([call("report_result", { kind: "answer", summary: "notes.txt says ok", data: { evidence: ["notes.txt:1"] } })], { stopReason: "toolUse" });

interface Seen { reasoning: string; last: string }
async function run(settings: ThinkingPolicySettings | undefined, script: (request: number, seen: Seen[]) => AssistantMessage, recovery: { ladder?: "redecompose" | "step-down" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orche-quality-"));
  await writeFile(join(dir, "notes.txt"), "ok\n");
  const faux = fauxProvider({ provider: `quality-${Math.random().toString(36).slice(2, 8)}`, models: [{ id: "m", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 }] });
  const seen: Seen[] = [];
  const factory: FauxResponseFactory = (context, options) => {
    seen.push({ reasoning: options?.reasoning ?? "off", last: JSON.stringify(context.messages.at(-1) ?? "") });
    return script(seen.length, seen);
  };
  faux.setResponses(Array.from({ length: 40 }, () => factory));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const manager = new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas });
  cleanup.push(async () => { await manager.disposeWithin(2_000).catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
  const tool = createTaskPlanTool(value => onTaskPlan(manager.session("W1"), value));
  await manager.spawn({ id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model: `${faux.provider.id}/m`, thinking: "high" }, instructions: "worker", peerMessaging: false,
    tools: [...WORKER_TOOL_NAMES, "task_plan"], customTools: [tool], lengthRecovery: recovery });
  if (settings) beginThinkingPolicy(manager.session("W1"), settings);
  manager.assign("W1", "answer", "Assignment: answer. What does notes.txt say?");
  const waited = await manager.wait("W1", 15_000);
  const outcome = waited.type === "outcome" ? waited.outcome : undefined;
  return { outcome, seen, manager, policy: thinkingPolicyOf(manager.session("W1")) };
}

describe("quality-first output-limit recovery: same effort, smaller scope", () => {
  it("an overrunning step: one next-step nudge, then a split of the running node; the effort never drops below the step level", async () => {
    const { outcome, seen, policy } = await run(PHASE_THINKING_POLICY, request => [
      plan(node("a", "running"), node("b", "pending")),
      capped(), capped(),
      plan(node("a", "skipped"), node("a1", "running", { parent: "a" }), node("a2", "pending", { parent: "a" }), node("b", "pending")),
      read(),
      plan(node("a", "skipped"), node("a1", "done", { checkpoint: cp }), node("a2", "done", { checkpoint: cp }), node("b", "done", { checkpoint: cp })),
      report(),
    ][request - 1] ?? report());
    expect(outcome).toMatchObject({ status: "completed", lengthStops: { count: 2, exhausted: false } });
    expect(seen.map(item => item.reasoning)).toEqual(["high", "medium", "medium", "medium", "medium", "medium", "high"]);
    expect(seen[2]!.last).toMatch(/Reason only about the immediate next step/);
    expect(seen[3]!.last).toMatch(/your effort level stays the same\. Call task_plan now and split the running node a into two or more smaller nodes with distinct titles, each with parent \\"a\\"/);
    expect(policy).toMatchObject({ redecompositions: 1, falseRedecompositions: 0 });
  });

  it("an overrunning integration stays at the baseline and is split into one verification node per requirement", async () => {
    const { outcome, seen } = await run(PHASE_THINKING_POLICY, request => [
      plan(node("a", "done", { checkpoint: cp }), node("i", "running", { phase: "integrate" })),
      capped(), capped(),
      plan(node("a", "done"), node("i", "skipped", { phase: "integrate" }), node("i1", "running", { phase: "integrate", parent: "i" }), node("i2", "pending", { phase: "integrate", parent: "i" })),
      read(),
      plan(node("a", "done"), node("i", "skipped"), node("i1", "done", { checkpoint: cp }), node("i2", "done", { checkpoint: cp })),
      report(),
    ][request - 1] ?? report());
    expect(outcome?.status).toBe("completed");
    expect(new Set(seen.map(item => item.reasoning))).toEqual(new Set(["high"]));
    expect(seen[3]!.last).toMatch(/Split the integration now: call task_plan with one verification node per requirement id \(phase \\"integrate\\", covering that id only, parent \\"i\\"\), mark i skipped/);
  });

  it("a plan update that does not split anything is not progress: the recovery ends in an explicit failure, bounded in requests", async () => {
    const same = () => plan(node("a", "running"));
    const { outcome, seen, policy } = await run(PHASE_THINKING_POLICY, request => [same(), capped(), capped(), same(), capped(), capped(), same()][request - 1] ?? capped());
    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toMatch(/^Output limit: /);
    // plan, overrun, overrun (nudge), unchanged plan (split asked), overrun, overrun (split asked again), unchanged plan, overrun
    // (5 stops without progress: exhausted), the forced report overruns too: failed.
    expect(seen.length).toBe(9);
    expect(policy).toMatchObject({ falseRedecompositions: 2, redecompositions: 0, progress: 0 });
    expect(seen.every(item => item.reasoning === "high" || item.reasoning === "medium")).toBe(true);
    // The forced report asks for honesty about what is not verified.
    expect(seen.at(-1)!.last).toMatch(/never report unverified or failed work as done/);
  });

  it("a trivial tool call between overruns cannot reset the budget forever (redecompose: no progress; any ladder: per-assignment cap)", async () => {
    const alternate = (request: number) => request % 2 === 1 ? capped() : read();
    const quality = await run(PHASE_THINKING_POLICY, alternate);
    expect(quality.outcome?.error).toMatch(/^Output limit: /);
    // Five overruns without Task DAG progress exhaust it (plus the forced report).
    expect([quality.seen.length, quality.outcome?.lengthStops]).toEqual([11, { count: 6, exhausted: true }]);
    const legacy = await run(FIXED_THINKING_POLICY, alternate);
    expect(legacy.outcome?.error).toMatch(/^Output limit: /);
    // 8 recovered stops, the 9th exhausts (maxPerAssignment), then the forced report (answered with a read) and one more overrun.
    expect([legacy.seen.length, legacy.outcome?.lengthStops]).toEqual([19, { count: 10, exhausted: true }]);
  });

  it("a real context overflow still goes to Pi's compact-and-retry under the quality ladder", async () => {
    expect(await runScenario("P0_pi_default", "real_overflow", { recovery: { ladder: "redecompose" } })).toMatchObject({ reported: true, compactions: 1, summarizerCalls: 1 });
    // A length stop far from the window is not an overflow: no compaction, recovered by nudges, no step-down.
    expect(await runScenario("P0_pi_default", "needs_nudge", { recovery: { ladder: "redecompose" } })).toMatchObject({ reported: true, compactions: 0 });
  });
});
