import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { loadRouteConfig, parseRouteConfig, type RouteConfig } from "../../src/orchestration/routing.js";
import { fauxRuntime } from "../helpers/faux.js";

afterEach(() => vi.restoreAllMocks());
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "Fix the typo", owner: "A1", files: ["greeting.txt"], status: "pending" };
const classify = decision({ type: "classify", taskClass: "change", workerCount: 2, language: "en", reason: "Explicit plan review" });
const assign = decision({ type: "assign", tasks: [task] });
const complete = decision({ type: "complete", summary: "Fixed the typo." });
const implemented = tool("report_result", { kind: "implement", summary: "typo fixed", data: { status: "done" } });
const verified = tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } });
const verdict = (value: "ok" | "concern", text = "NOTE", domain = "plan") => tool("advisor_verdict", { verdict: value, notes: value === "ok" ? [] : [{ domain, text, evidence: "greeting.txt:1" }] });
const lastUser = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.findLast(message => message.role === "user"));

async function runWith(advisors: unknown[], mainSteps: FauxResponseStep[], advisorSteps: FauxResponseStep[], extra: { baseSystemPrompt?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orche-adv-run-"));
  await writeFile(join(dir, "greeting.txt"), "hello wrold\n");
  const main = await fauxRuntime(mainSteps);
  const advisor = await fauxRuntime(advisorSteps);
  main.runtime.registerNativeProvider(advisor.faux.provider);
  const routes: RouteConfig = parseRouteConfig({ routes: { advisor: { model: advisor.route.model } }, default: { model: main.route.model }, advisors });
  const events: RunEvent[] = [];
  const dispose = vi.spyOn(AgentSession.prototype, "dispose");
  try {
    const report = await runOrchestrated({ problem: "Fix the typo in greeting.txt", cwd: dir, routes, modelRuntime: main.runtime, sink: event => events.push(event), ...extra });
    return { report, events, main, advisor, dispose };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("advisors inside runOrchestrated", () => {
  it("await decision trigger: one NOTE, at most one reconsideration per decision", async () => {
    const prompts: string[] = [];
    const seen = (message: AssistantMessage): FauxResponseStep => context => { prompts.push(lastUser(context)); return message; };
    const r = await runWith(
      [{ preset: "plan-review", enabled: true }],
      [seen(classify), seen(classify), seen(assign), seen(assign), implemented, verified, complete],
      [verdict("concern", "PLAN_CONCERN_ONE"), verdict("concern", "PLAN_CONCERN_TWO")],
    );
    expect(r.report.status).toBe("done");
    // classify + assign each reviewed once; each coordinator decision reconsidered exactly once, never re-reviewed.
    const triggered = r.events.filter(event => event.type === "advisor_triggered");
    expect(triggered.map(event => [event.name, event.trigger, event.target, event.await])).toEqual([
      ["plan-review", "coordinator_decision", "coordinator", true],
      ["plan-review", "coordinator_decision", "coordinator", true],
    ]);
    expect(r.events.filter(event => event.type === "advisor_result").map(event => [event.verdict, event.delivered])).toEqual([["concern", true], ["concern", true]]);
    expect(r.events.filter(event => event.type === "coordinator_deciding" || event.type === "coordinator_reconsidering").map(event => [event.type, event.phase])).toEqual([
      ["coordinator_deciding", "EXPLORE"], ["coordinator_reconsidering", "EXPLORE"], ["coordinator_deciding", "EXPLORE"],
      ["coordinator_deciding", "BACKLOG"], ["coordinator_reconsidering", "BACKLOG"], ["coordinator_deciding", "BACKLOG"],
      ["coordinator_deciding", "VERIFY"],
    ]);
    expect(r.events.filter(event => event.type === "coordinator_activity").map(event => event.requestCount)).toEqual([1, 2, 3, 4, 5]);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).not.toContain("Reconsider it exactly once");
    expect(prompts[1]).toContain("Reconsider it exactly once");
    expect(prompts[1]).toContain("advisor:plan-review");
    expect(prompts[1]).toContain("PLAN_CONCERN_ONE");
    expect(prompts[2]).not.toContain("Reconsider it exactly once");
    expect(prompts[3]).toContain("PLAN_CONCERN_TWO");
    expect(prompts[3]).not.toContain("PLAN_CONCERN_ONE");
    const notes = r.events.filter(event => event.type === "message_sent" && event.message.from.startsWith("advisor:"));
    expect(notes).toHaveLength(2);
    expect(r.events.filter(event => event.type === "advisor_usage").length).toBe(2);
    expect(r.advisor.faux.getPendingResponseCount()).toBe(0);
    expect(r.main.faux.getPendingResponseCount()).toBe(0);
  });

  it("ok verdict leaves the coordinator untouched (no NOTE, no reconsideration)", async () => {
    const r = await runWith([{ preset: "plan-review" }], [classify, assign, implemented, verified, complete], [verdict("ok"), verdict("ok")]);
    expect(r.report.status).toBe("done");
    expect(r.events.some(event => event.type === "message_sent" && event.message.from.startsWith("advisor:"))).toBe(false);
    expect(r.main.faux.state.callCount).toBe(5);
    expect(r.events.filter(event => event.type === "advisor_result").map(event => event.verdict)).toEqual(["ok", "ok"]);
    expect(r.events.some(event => event.type === "coordinator_reconsidering")).toBe(false);
  });

  it("verification-audit: the coordinator sees the audit of the verifier result before completing", async () => {
    let finalDecisionPrompt = "";
    const r = await runWith(
      [{ preset: "verification-audit", enabled: true }],
      [classify, assign, implemented, verified, context => { finalDecisionPrompt = lastUser(context); return complete; }],
      [verdict("ok"), verdict("concern", "CLAIM_WITHOUT_EVIDENCE", "verification")],
    );
    expect(r.report.status).toBe("done");
    const triggered = r.events.filter(event => event.type === "advisor_triggered");
    expect(triggered.map(event => event.subject)).toEqual(["A1", "V1"]);
    expect(finalDecisionPrompt).toContain("advisor:verification-audit");
    expect(finalDecisionPrompt).toContain("CLAIM_WITHOUT_EVIDENCE");
    expect(r.events.filter(event => event.type === "advisor_usage").every(event => event.name === "verification-audit")).toBe(true);
    const reconsidering = r.events.findIndex(event => event.type === "coordinator_reconsidering");
    expect(reconsidering).toBeGreaterThan(r.events.findIndex(event => event.type === "advisor_result" && event.verdict === "concern"));
    expect(r.events[reconsidering + 1]).toMatchObject({ type: "coordinator_deciding", phase: "VERIFY" });
  });

  it("before_complete reviews the completing decision and allows one reconsideration", async () => {
    const prompts: string[] = [];
    const r = await runWith(
      [{ name: "final-check", domains: ["verification"], targets: ["coordinator"], triggers: [{ on: "before_complete" }] }],
      [classify, assign, implemented, verified, context => { prompts.push(lastUser(context)); return complete; }, context => { prompts.push(lastUser(context)); return complete; }],
      [verdict("concern", "RERUN_THE_TESTS", "verification")],
    );
    expect(r.report.status).toBe("done");
    expect(prompts[1]).toContain("RERUN_THE_TESTS");
    expect(r.events.filter(event => event.type === "advisor_triggered")).toHaveLength(1);
  });

  it("shipped config keeps both presets disabled: no advisor calls, events or sessions", async () => {
    const shipped = await loadRouteConfig("orche.config.json");
    const dir = await mkdtemp(join(tmpdir(), "orche-adv-off-"));
    const main = await fauxRuntime([classify, assign, implemented, verified, complete]);
    const events: RunEvent[] = [];
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    try {
      const report = await runOrchestrated({ problem: "Fix", cwd: dir, routes: { ...shipped, default: { model: main.route.model } }, modelRuntime: main.runtime, sink: event => events.push(event) });
      expect(report.status).toBe("done");
      expect(events.filter(event => event.type.startsWith("advisor_"))).toEqual([]);
      expect(dispose).toHaveBeenCalledTimes(4); // coordinator, A1, unused A2, V1 only
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("baseSystemPrompt reaches coordinator and worker sessions, not advisors", async () => {
    const systemPrompts: Record<string, string> = {};
    const capture = (label: string, message: AssistantMessage): FauxResponseStep => context => {
      systemPrompts[label] = JSON.stringify(context.messages.find(item => item.role === "system"));
      return message;
    };
    await runWith(
      [{ preset: "verification-audit", enabled: true }],
      [capture("coordinator", classify), assign, capture("worker", implemented), capture("verifier", verified), complete],
      [capture("advisor", verdict("ok")), verdict("ok")],
      { baseSystemPrompt: "CUSTOM_BASE_PROMPT_MARKER" },
    );
    for (const label of ["coordinator", "worker", "verifier"]) expect(systemPrompts[label]).toContain("CUSTOM_BASE_PROMPT_MARKER");
    expect(systemPrompts.advisor).not.toContain("CUSTOM_BASE_PROMPT_MARKER");
    expect(systemPrompts.worker).toContain("persistent coding worker");
  });

  it("reports an unreachable advisor route as a run-level failure instead of silently skipping", async () => {
    const main = await fauxRuntime([]);
    const dir = await mkdtemp(join(tmpdir(), "orche-adv-route-"));
    try {
      const report = await runOrchestrated({
        problem: "Fix", cwd: dir, modelRuntime: main.runtime,
        routes: parseRouteConfig({ routes: {}, advisors: [{ preset: "plan-review", enabled: true }] }),
      });
      expect(report.status).toBe("failed");
      expect(report.summary).toContain("No route for role advisor");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
