import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool } from "./harness.js";
import { createAssignmentProjector } from "../../src/pi/context-projection.js";
import { createSession } from "../../src/pi/session-factory.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });
const checklist = (status: "met" | "unmet" | "partial" = "met") => [{ id: "R1", status, evidence: "greeting.txt:1 inspected", ...(status === "met" ? { verifiedBy: "node --test greeting.test.mjs" } : {}) }];
const report = (status: "met" | "unmet" | "partial" = "met", kind = "implement") => tool("report_result", { kind, summary: "Evidence-backed result", data: { status: "done", checklist: checklist(status) } });
const request = "Intent/Purpose: improve greeting\nRequirements:\nR1: greeting is correct (test greeting.txt).\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n원문 그대로: 인사말을 고쳐줘.";
const plan = { nodes: [{ id: "inspect", title: "Inspect greeting", dependsOn: [], covers: ["R1"], status: "pending" as const }] };
const eventsOf = async (record: string) => readFile(join(record, "events.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
async function fixture(steps: FauxResponseStep[], records = false) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, records, taskContext: { minClearTokens: 0 } });
  opened.push(h);
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  opened.push(pool);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", ...args });
  return { h, pool, execute };
}

describe("single-workflow task delegation", () => {
  it.each(["single"] as const)("%s registers task_plan, persists replacement plans and reports checklist summary/details", async mainMode => {
    const { execute, pool } = await fixture([tool("task_plan", plan), report("partial")], true);
    const result = await execute({ mainMode });
    expect(pool.session("W1").getActiveToolNames()).toContain("task_plan");
    expect(result.details).toMatchObject({ checklist: checklist("partial"), plan, compactions: { count: 0, events: [] } });
    expect(result.text).toContain("Checklist (worker self-report, not acceptance): 0/1 met, 0 with a named passing check; unmet: R1 (partial: greeting.txt:1 inspected)");
    expect(await readFile(join(result.details.record!, "events.jsonl"), "utf8")).toContain('"type":"task_plan"');
    expect(await readFile(join(result.details.record!, "run.json"), "utf8")).toContain('"checklist"');
  });
  it("orche_run/ordinary manager workers have no task_plan and compaction stays off", async () => {
    const { h } = await fixture([]);
    const manager = new AgentManager(h.runtime);
    opened.push({ dispose: async () => { await manager.dispose(); } });
    await manager.spawn({ id: "A1", role: "implementer", cwd: h.cwd, instructions: "test", route: h.orche.route });
    expect(manager.session("A1").getActiveToolNames()).not.toContain("task_plan");
    expect(manager.session("A1").settingsManager.getCompactionEnabled()).toBe(false);
  });
  it.each(["implement", "answer"] as const)("requires a complete valid checklist for %s with R-ids and allows repair in the same assignment", async role => {
    const { execute } = await fixture([
      tool("report_result", { kind: role, summary: "missing", data: {} }),
      context => { expect(JSON.stringify(context.messages)).toContain("data.checklist is required"); return tool("report_result", { kind: role, summary: "bad", data: { checklist: [{ id: "R1", status: "wrong", evidence: "x" }] } }); },
      context => { expect(JSON.stringify(context.messages)).toContain("checklist"); return report("met", role); },
    ]);
    const result = await execute({ role });
    expect(result.details.checklist).toEqual(checklist());
    expect(result.details.requests).toBe(3);
  });
  it("warns after two consecutive unmet/partial reports and resets after met", async () => {
    const { execute } = await fixture([report("unmet"), report("partial"), report("met"), report("unmet"), report("unmet")]);
    expect((await execute()).text).not.toContain("consecutive assignments");
    expect((await execute({ worker: "W1" })).text).toContain("Note: R1 unmet in 2 consecutive assignments of W1; hand only the unmet items to a NEW worker (omit worker)");
    expect((await execute({ worker: "W1" })).text).not.toContain("consecutive assignments");
    expect((await execute({ worker: "W1" })).text).not.toContain("consecutive assignments");
    expect((await execute({ worker: "W1" })).text).toContain("2 consecutive assignments");
  });
  it("inherits current main model/thinking and switches the same real session at the next hand-off", async () => {
    const { h, execute, pool } = await fixture([]);
    const main = fauxProvider({ provider: "main-reasoning", models: [{ id: "first", reasoning: true }, { id: "second", reasoning: true }] });
    h.runtime.registerNativeProvider(main.provider);
    main.setResponses([report(), report()]);
    const first = await execute({ model: main.getModel("first")!, thinking: "high" });
    const session = pool.session("W1");
    expect(first.details.model).toBe("main-reasoning/first");
    expect(first.details.thinking).toBe("high");
    const second = await execute({ worker: "W1", model: main.getModel("second")!, thinking: "low" });
    expect(pool.session("W1")).toBe(session);
    expect(session.model?.id).toBe("second");
    expect(second.details).toMatchObject({ model: "main-reasoning/second", thinking: "low" });
    expect(JSON.stringify(session.messages)).toContain("원문 그대로: 인사말을 고쳐줘.");
  });
  it("the extension captures main's current model and thinking at the tool hand-off", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], inheritMainModel: true });
    opened.push(h);
    const main = fauxProvider({ provider: "handoff-main", models: [{ id: "current", reasoning: true }] });
    h.runtime.registerNativeProvider(main.provider);
    const original = WorkerPool.prototype.execute;
    vi.spyOn(WorkerPool.prototype, "execute").mockImplementation(function (this: WorkerPool, args) { opened.push(this); return original.call(this, args); });
    main.setResponses([tool("orche_task", { role: "implement", request }), report(), reply("reviewed")]);
    await h.session.setModel(main.getModel());
    h.session.setThinkingLevel("high");
    await h.session.prompt("delegate this");
    const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "orche_task");
    expect(result).toMatchObject({ details: { model: "handoff-main/current", thinking: "high", checklist: checklist() } });
  });
  it("a resolvable main model takes priority even without a configured worker route", async () => {
    const { h, execute } = await fixture([]);
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, records: { enabled: false } }));
    h.main.faux.setResponses([report()]);
    expect((await execute({ model: h.main.faux.getModel() })).details.model).toBe(h.main.route.model);
  });
  it("falls back visibly when main is unresolvable and specialists retain configured routes", async () => {
    const { h, execute } = await fixture([report(), tool("report_result", { kind: "video", summary: "blocked", data: { status: "blocked", outputs: [] } })]);
    const result = await execute({ model: { provider: "unavailable", id: "model" }, thinking: "high" });
    expect(result.details.model).toBe(h.orche.route.model);
    expect(result.text).toContain("Warning: main model unavailable/model is unresolvable");
    expect(result.details.warnings).toHaveLength(1);
    const specialist = await execute({ role: "video", model: h.main.faux.getModel(), thinking: "high" });
    expect(specialist.details.model).toBe(h.orche.route.model);
    expect(specialist.details.thinking).toBe("off");
  });
  it("model switch failures suggest a new worker without dispatching another assignment", async () => {
    const { h, execute, pool } = await fixture([report()]);
    await execute();
    vi.spyOn(pool.session("W1"), "setModel").mockRejectedValueOnce(new Error("provider failed"));
    await expect(execute({ worker: "W1", model: h.main.faux.getModel() })).rejects.toThrow("Omit worker to start a new worker");
    expect(pool.list()[0]?.completedAssignments).toBe(1);
  });
  it("carries the inherited extended context window and enables only the task's 50% threshold", async () => {
    const { h, execute, pool } = await fixture([]);
    h.main.faux.setResponses([report()]);
    const model = { ...h.main.faux.getModel(), contextWindow: h.main.faux.getModel().contextWindow * 2 };
    await execute({ model });
    const session = pool.session("W1");
    expect(session.model?.contextWindow).toBe(model.contextWindow);
    expect(session.settingsManager.getCompactionSettings()).toMatchObject({ enabled: true, reserveTokens: Math.floor(model.contextWindow / 2), keepRecentTokens: 20_000 });
  });
  it("does not retire a single-workflow worker after an actual request above 70%", async () => {
    const { h, execute, pool } = await fixture([]);
    const scripted: FauxResponseStep = context => JSON.stringify(context.messages[0]).includes("You are a context summarization assistant") ? reply("summary") : report();
    h.orche.faux.setResponses(Array(8).fill(scripted));
    const result = await execute({ request: request + "\n" + "x".repeat(400_000) });
    const session = pool.session("W1");
    expect(session.messages.some(message => message.role === "assistant" && message.usage.input + message.usage.cacheRead > session.model!.contextWindow * 0.7)).toBe(true);
    expect(result.details.retired).toBeUndefined();
    expect(pool.list()[0]?.id).toBe("W1");
  });
  it("upgrades a failed-run handed-over worker without losing history", async () => {
    const { h, pool, execute } = await fixture([tool("report_result", { kind: "implement", summary: "first", data: {} }), report()]);
    const source = new AgentManager(h.runtime);
    opened.push({ dispose: async () => { await source.dispose(); } });
    await source.spawn({ id: "A1", role: "implementer", cwd: h.cwd, instructions: "run worker", route: h.orche.route });
    source.assign("A1", "implement", "previous run evidence");
    await source.wait("A1", 10_000);
    await pool.adoptFailedRun({ manager: source, workers: [{ id: "A1", role: "implementer" }], issues: [] }, h.cwd, 0);
    await execute({ worker: "W1" });
    const session = pool.session("W1");
    expect(JSON.stringify(session.messages)).toContain("previous run evidence");
    expect(session.getActiveToolNames()).toContain("task_plan");
    expect(session.settingsManager.getCompactionEnabled()).toBe(true);
  });
  it("resets the plan per assignment, validates the new coverage ids and never rejects a report for no DAG", async () => {
    const { h, execute, pool } = await fixture([tool("task_plan", plan), report(), report()], true);
    const first = await execute();
    expect(first.details.plan).toEqual(plan);
    const second = await execute({ worker: "W1" });
    expect(second.details).not.toHaveProperty("plan");
    expect(second.text).toContain("Note: no Task DAG recorded in this assignment.");
    expect(second.details.requests).toBe(1);
    expect(await eventsOf(second.details.record!)).not.toContain('"type":"task_plan"');
    expect(await readFile(join(second.details.record!, "run.json"), "utf8")).not.toContain('"plan":');
    h.orche.faux.setResponses([tool("task_plan", plan), context => {
      expect(JSON.stringify(context.messages)).toContain("Unknown covers ids: R1");
      return tool("task_plan", { nodes: [{ ...plan.nodes[0]!, covers: ["R2"] }] });
    }, tool("report_result", { kind: "implement", summary: "updated", data: { checklist: [{ id: "R2", status: "met", evidence: "checked", verifiedBy: "node --test" }] } })]);
    const third = await execute({ worker: "W1", request: "R2: revised requirement\nOriginal request\noriginal" });
    expect(third.details.plan?.nodes[0]?.covers).toEqual(["R2"]);
    expect(pool.session("W1").getActiveToolNames()).toContain("task_plan");
  });
  it.each(["Please follow the R1 spec doc and fix", "Update docs/R1.md", "Fix the R2D2 robot sprite", "Original user request (verbatim):\nR7: user text"])("incidental ids never demand a checklist: %s", async request => {
    const { execute } = await fixture([tool("report_result", { kind: "implement", summary: "legacy", data: { status: "done" } })]);
    expect((await execute({ request })).details.requests).toBe(1);
  });
  it("answer rejection hints contain the real checklist data contract", async () => {
    const { execute } = await fixture([tool("report_result", { kind: "answer", summary: "missing", data: {} }), context => {
      const rejection = JSON.stringify(context.messages);
      expect(rejection).toContain("data.checklist is required");
      expect(rejection).toContain("checklist");
      expect(rejection).toContain("evidence");
      expect(rejection).toContain("partial");
      return report("met", "answer");
    }]);
    expect((await execute({ role: "answer" })).details.checklist).toEqual(checklist());
  });
  it.each(["game-asset", "video"] as const)("%s keeps ordinary tools, compaction and 70% retirement", async role => {
    const { h, execute, pool } = await fixture([tool("report_result", { kind: role, summary: "done", data: { status: "done", outputs: [] } }), (_context, _options, _state, model) => {
      const response = tool("report_result", { kind: role, summary: "done", data: { status: "done", outputs: [] } });
      response.usage.input = Math.floor(model.contextWindow * 0.75);
      return response;
    }]);
    const first = await execute({ role, model: h.main.faux.getModel() });
    expect(first.details.model).toBe(h.orche.route.model);
    expect(first.details).not.toHaveProperty("compactions");
    expect(first.text).not.toContain("no Task DAG recorded");
    expect(pool.session("W1").getActiveToolNames()).not.toContain("task_plan");
    expect(pool.session("W1").settingsManager.getCompactionEnabled()).toBe(false);
    const second = await execute({ role, worker: "W1", model: h.main.faux.getModel(), request: "Large specialist assignment without R-ids\n" + "x".repeat(400_000) });
    expect(second.details.retired).toContain("W1");
  });
  it("turns the DAG and compaction off for a specialist follow-up and back on for standard work", async () => {
    const { execute, pool } = await fixture([tool("task_plan", plan), report(), tool("report_result", { kind: "video", summary: "done", data: { status: "done", outputs: [] } }), report()]);
    await execute();
    const session = pool.session("W1");
    await execute({ worker: "W1", role: "video" });
    expect(session.getActiveToolNames()).not.toContain("task_plan");
    expect(session.settingsManager.getCompactionEnabled()).toBe(false);
    await execute({ worker: "W1" });
    expect(pool.session("W1")).toBe(session);
    expect(session.getActiveToolNames()).toContain("task_plan");
    expect(session.settingsManager.getCompactionEnabled()).toBe(true);
  });
  it("warns for an absent main model, uses routes only on spawn and keeps reused model/thinking/window", async () => {
    const { h, execute, pool } = await fixture([report()]);
    const routed = await execute();
    expect(routed.details.model).toBe(h.orche.route.model);
    expect(routed.text).toContain(`Warning: main model is absent; using configured route ${h.orche.route.model}.`);
    const main = fauxProvider({ provider: "absent-main", models: [{ id: "reasoning", reasoning: true }] });
    h.runtime.registerNativeProvider(main.provider);
    main.setResponses([report(), report()]);
    const model = { ...main.getModel(), contextWindow: 128_000 };
    await execute({ worker: "W1", model, thinking: "high" });
    const session = pool.session("W1");
    const setModel = vi.spyOn(session, "setModel"), setThinking = vi.spyOn(session, "setThinkingLevel");
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, records: { enabled: false } }));
    const reused = await execute({ worker: "W1", model: undefined, thinking: "low" });
    expect(reused.details).toMatchObject({ model: "absent-main/reasoning", thinking: "high" });
    expect(reused.text).toContain("Warning: main model is absent; keeping this worker's current model and thinking.");
    expect(session.model?.contextWindow).toBe(128_000);
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinking).not.toHaveBeenCalled();
  });
  it.each(["omitted", "renamed", "revised", "revised continuation", "failed"])("resets a worker's unmet streak when a requirement is %s", async reset => {
    const { h, execute } = await fixture([report("unmet")]);
    const initial = reset === "revised continuation" ? "R1: acceptance\n  check: old\nOriginal request\noriginal" : request;
    await execute({ request: initial });
    if (reset === "failed") {
      h.orche.faux.setResponses([reply("no report"), reply("no report")]);
      await expect(execute({ worker: "W1", request: initial })).rejects.toThrow("no report");
    } else {
      const changed = reset === "omitted" ? "No requirement declarations" : reset === "renamed" ? "R2: greeting is correct" : reset === "revised continuation" ? "R1: acceptance\n  check: new\nOriginal request\noriginal" : "R1: revised acceptance";
      h.orche.faux.setResponses([tool("report_result", { kind: "implement", summary: "pending", data: reset === "omitted" ? {} : { checklist: [{ id: reset === "renamed" ? "R2" : "R1", status: "unmet", evidence: "remaining" }] } })]);
      expect((await execute({ worker: "W1", request: changed })).text).not.toContain("consecutive assignments");
    }
    h.orche.faux.setResponses([report("unmet")]);
    expect((await execute({ worker: "W1", request: initial })).text).not.toContain("consecutive assignments");
  });
  it("tracks consecutive unmet requirements per worker, not across workers", async () => {
    const { execute } = await fixture([report("unmet"), report("unmet"), report("unmet")]);
    expect((await execute()).text).not.toContain("consecutive assignments");
    expect((await execute()).text).not.toContain("consecutive assignments");
    expect((await execute({ worker: "W1" })).text).toContain("2 consecutive assignments of W1");
  });
  it.each(["explore", "answer", "implement", "verify"] as const)("%s gets standard single-workflow DAG and compaction", async role => {
    const { execute, pool } = await fixture([tool("task_plan", plan), tool("report_result", { kind: role, summary: "reported", data: { passed: true, status: "done", checklist: checklist() } })]);
    await execute({ role });
    expect(pool.session("W1").getActiveToolNames()).toContain("task_plan");
    expect(pool.session("W1").settingsManager.getCompactionEnabled()).toBe(true);
  });
  it("resets the unmet streak on a pre-dispatch model-switch failure", async () => {
    const { h, execute, pool } = await fixture([report("unmet"), report("unmet")]);
    await execute();
    vi.spyOn(pool.session("W1"), "setModel").mockRejectedValueOnce(new Error("switch failed"));
    await expect(execute({ worker: "W1", model: h.main.faux.getModel() })).rejects.toThrow("switch failed");
    expect((await execute({ worker: "W1" })).text).not.toContain("consecutive assignments");
  });
});

describe("single task compaction with a real AgentSession", () => {
  it("preserves checklist, original request and latest DAG verbatim; resets projection and resumes at the next boundary", async () => {
    const { h } = await fixture([]);
    const projector = createAssignmentProjector();
    let latest = plan;
    const compactions: { tokensBefore: number; tokensAfter: number }[] = [];
    const session = await createSession({ route: h.orche.route, cwd: h.cwd, instructions: "test", modelRuntime: h.runtime, tools: [], contextProjection: projector,
      taskCompaction: { essentials: () => `${request}\nLatest Task DAG:\n${JSON.stringify(latest)}`, onCompact: stats => compactions.push(stats) } });
    opened.push({ dispose: async () => session.dispose() });
    h.orche.faux.setResponses([reply("Earlier findings " + "x".repeat(6000)), reply("Compacted summary"), reply("continued")]);
    await session.prompt(request);
    projector.beginAssignment(session.messages, session.messages.length, { minClearTokens: 0 });
    latest = { nodes: [{ ...plan.nodes[0]!, status: "done" as never }] };
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 100 } });
    await session.compact();
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.tokensBefore).toBeGreaterThan(compactions[0]!.tokensAfter);
    expect(projector.plan).toBeUndefined();
    const stored = JSON.stringify(session.messages);
    expect(stored).toContain("R1: greeting is correct");
    expect(stored).toContain("원문 그대로: 인사말을 고쳐줘.");
    expect(stored).toContain('\\"status\\":\\"done\\"');
    expect(projector.project(session.messages)).toBe(session.messages);
    projector.beginAssignment(session.messages, session.messages.length, { minClearTokens: 0 });
    expect(projector.plan).toBeDefined();
    await session.prompt("continue");
    expect(session.getLastAssistantText()).toBe("continued");
  });
  it("auto-compacts mid-assignment, reinjects essentials before the next model call, and records tokens/count", async () => {
    const { h, execute, pool } = await fixture([], true);
    const faux = fauxProvider({ provider: "single-compact", models: [{ id: "small", contextWindow: 32_000, maxTokens: 4096 }] });
    h.runtime.registerNativeProvider(faux.provider);
    await writeFile(join(h.cwd, "large.txt"), Array(90).fill("x".repeat(500)).join("\n"));
    let step = 0;
    const scripted: FauxResponseStep = context => {
      if (JSON.stringify(context.messages.find(message => message.role === "system")).includes("You are a context summarization assistant")) return reply("COMPACTION_SUMMARY");
      if (step++ === 0) return tool("task_plan", plan);
      if (step <= 3) return tool("read", { path: "large.txt" });
      const messages = JSON.stringify(context.messages);
      expect(messages).toContain("Assignment in progress at compaction time (superseded by any later Assignment message)");
      expect(messages).toContain("R1: greeting is correct");
      expect(messages).toContain("원문 그대로: 인사말을 고쳐줘.");
      expect(messages).toContain("Inspect greeting");
      return report();
    };
    faux.setResponses(Array(12).fill(scripted));
    const result = await execute({ model: faux.getModel() });
    expect(result.details.compactions?.count).toBeGreaterThan(0);
    expect(result.details.compactions?.events[0]!.tokensBefore).toBeGreaterThan(16_000);
    expect(await readFile(join(result.details.record!, "events.jsonl"), "utf8")).toContain('"type":"compaction"');
    // Verifier cross.test.ts scenario: compacted ALPHA essentials must not claim to be current in round BETA.
    faux.setResponses([context => {
      const messages = JSON.stringify(context.messages);
      expect(messages).toContain("Assignment in progress at compaction time (superseded by any later Assignment message)");
      expect(messages).not.toContain("Current assignment");
      expect(messages).toContain("This Assignment message supersedes earlier requirement ids and plans");
      expect(messages).toContain("R1: BETA acceptance");
      return report();
    }]);
    const next = await execute({ worker: "W1", model: faux.getModel(), request: "R1: BETA acceptance\nOriginal user request (verbatim):\nBETA" });
    expect(next.details.plan).toBeUndefined();
    expect(next.text).toContain("no Task DAG recorded");
    expect(await eventsOf(next.details.record!)).not.toContain('"type":"task_plan"');
    expect(await readFile(join(next.details.record!, "run.json"), "utf8")).not.toContain('"plan":');
    expect(pool.list()[0]?.id).toBe("W1");
  });
  it("repeated compaction labels historical essentials and never accumulates them as current assignments", async () => {
    const { h } = await fixture([]);
    let original = "ALPHA";
    const session = await createSession({ route: h.orche.route, cwd: h.cwd, instructions: "test", modelRuntime: h.runtime, tools: [], taskCompaction: { essentials: () => `R1: ${original}\nOriginal request\n${original}\nTask DAG: historical ${original}` } });
    opened.push({ dispose: async () => session.dispose() });
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 100 } });
    for (const name of ["ALPHA", "BETA", "GAMMA"]) {
      original = name;
      h.orche.faux.setResponses([reply("finding " + "x".repeat(6000)), ...Array.from({ length: 4 }, () => reply("summary"))]);
      await session.prompt(`Assignment: ${name}. Supersedes earlier requirement ids and plans.\nR1: ${name}`);
      await session.compact();
      const essentials = session.messages.filter(message => message.role === "custom" && message.customType === "orche:task-essentials");
      expect(essentials).toHaveLength(1);
      expect(JSON.stringify(essentials)).toContain("Assignment in progress at compaction time (superseded by any later Assignment message)");
      expect(JSON.stringify(essentials)).toContain(name);
      expect(JSON.stringify(essentials)).not.toContain("Current assignment");
    }
  });
});
