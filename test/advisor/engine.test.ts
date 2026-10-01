import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import type { ManagerEvent } from "../../src/agent/agent-handle.js";
import { AdvisorEngine } from "../../src/advisor/engine.js";
import type { AdvisorConfig } from "../../src/advisor/config.js";
import { parseAdvisorConfigs } from "../../src/advisor/config.js";
import type { CoordinatorEvent } from "../../src/orchestration/events.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanup.splice(0).reverse()) await task();
});
const verdict = (value: "ok" | "concern" | "blocker", notes: { domain: string; text: string; evidence?: string }[] = []) =>
  reply([call("advisor_verdict", { verdict: value, notes })], { stopReason: "toolUse" });
const toolTurn = (name: string, args: Record<string, never> = {}) => reply([call(name, args)], { stopReason: "toolUse" });
const report = (kind: string) => reply([call("report_result", { kind, summary: `${kind} done` })], { stopReason: "toolUse" });
async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const quickTool = (name: string, text = "ok", gate?: () => Promise<void>): ToolDefinition => ({
  name, label: name, description: name, parameters: Type.Object({}),
  execute: async () => {
    await gate?.();
    return { content: [{ type: "text", text }], details: {} };
  },
});

interface Setup { advisors: unknown[]; workerSteps: FauxResponseStep[]; advisorSteps: FauxResponseStep[]; tools?: ToolDefinition[]; cwd?: string }
interface FauxSide { faux: { getPendingResponseCount(): number; state: { callCount: number }; setResponses(responses: FauxResponseStep[]): void }; route: { model: string } }
interface Harness {
  manager: AgentManager; engine: AdvisorEngine; events: CoordinatorEvent[]; managerEvents: ManagerEvent[];
  worker: FauxSide; advisor: FauxSide; settled(): number; notes(): unknown[];
}
let current: Harness;
/** Tools call this so no advisor trigger is dropped as "busy": the worker proceeds only once every started review finished. */
const advisorsIdle = () => until(() => current.settled() >= current.events.filter(event => event.type === "advisor_triggered").length, "idle advisors");
async function setup(options: Setup): Promise<Harness> {
  const worker = await fauxRuntime(options.workerSteps);
  const advisor = await fauxRuntime(options.advisorSteps);
  worker.runtime.registerNativeProvider(advisor.faux.provider);
  const manager = new AgentManager(worker.runtime);
  cleanup.push(() => manager.dispose());
  const tools = options.tools ?? [quickTool("work")];
  await manager.spawn({
    id: "a", role: "implementer", route: worker.route, modelRuntime: worker.runtime, cwd: options.cwd ?? process.cwd(),
    instructions: "worker", tools: tools.map(tool => tool.name), customTools: tools,
  });
  const events: CoordinatorEvent[] = [];
  const managerEvents: ManagerEvent[] = [];
  manager.subscribe(event => managerEvents.push(event));
  const configs: AdvisorConfig[] = parseAdvisorConfigs(options.advisors);
  const engine = new AdvisorEngine(configs, {
    cwd: options.cwd ?? process.cwd(), problem: "Fix the typo in greeting", runtime: worker.runtime,
    routes: { routes: { advisor: { model: advisor.route.model } } }, manager, coordinator: () => undefined, emit: event => events.push(event),
  });
  engine.start();
  cleanup.push(() => engine.dispose());
  const settled = () => events.filter(event => event.type === "advisor_result" || event.type === "advisor_failed").length;
  const notes = () => manager.session("a").messages.filter(message => message.role === "custom" && message.customType === "pi-orche.note");
  current = { manager, engine, events, managerEvents, worker, advisor, settled, notes };
  return current;
}
const names = (events: CoordinatorEvent[], type: CoordinatorEvent["type"]) => events.filter(event => event.type === type).map(event => "name" in event ? event.name : "");

describe("advisor engine with real sessions", () => {
  it("fires each advisor only on its own trigger, kinds and period; ok injects nothing", async () => {
    const s = await setup({
      advisors: [
        { name: "audit", domains: ["verification"], targets: ["coordinator"], cooldownMs: 0, triggers: [{ on: "assignment_result", kinds: ["verify"] }] },
        { name: "pulse", domains: ["tests"], targets: ["workers"], cooldownMs: 0, triggers: [{ on: "turn_end", every: 3 }] },
        { name: "idle", domains: ["docs"], targets: ["coordinator"], triggers: [{ on: "tool_error" }] },
      ],
      workerSteps: [toolTurn("work"), toolTurn("work"), report("implement"), report("verify")],
      advisorSteps: [verdict("concern", [{ domain: "tests", text: "PULSE_NOTE_TEXT", evidence: "a.test.ts:3" }]), verdict("ok", [{ domain: "verification", text: "IGNORED_NOTE" }])],
    });
    s.manager.assign("a", "implement", "do it");
    expect((await s.manager.wait("a", 3000))).toMatchObject({ type: "outcome", outcome: { kind: "implement", status: "completed" } });
    await until(() => s.settled() === 1, "first advisor");
    expect(names(s.events, "advisor_triggered")).toEqual(["pulse"]);
    s.manager.assign("a", "verify", "check");
    await s.manager.wait("a", 3000);
    await until(() => s.settled() === 2, "audit result");
    expect(names(s.events, "advisor_triggered")).toEqual(["pulse", "audit"]);
    const results = s.events.filter(event => event.type === "advisor_result");
    expect(results.map(event => [event.name, event.target, event.trigger, event.verdict, event.delivered])).toEqual([
      ["pulse", "a", "turn_end", "concern", true],
      ["audit", "coordinator", "assignment_result", "ok", false],
    ]);
    expect(results[1]!.notes).toEqual([]);
    expect(s.advisor.faux.getPendingResponseCount()).toBe(0);
    const sent = s.managerEvents.filter(event => event.type === "message_sent");
    expect(sent.map(event => [event.message.from, event.message.to])).toEqual([["advisor:pulse", "a"]]);
    expect(s.notes()).toHaveLength(1);
  });

  it("injects exactly one NOTE to the target and never cancels the running tool", async () => {
    const entered = deferred();
    const release = deferred();
    let aborted = false;
    const slow: ToolDefinition = {
      name: "slow", label: "slow", description: "slow", parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        signal?.addEventListener("abort", () => { aborted = true; });
        entered.resolve();
        await release.promise;
        return { content: [{ type: "text", text: "slow done" }], details: {} };
      },
    };
    let context = "";
    const s = await setup({
      advisors: [{ name: "watch", domains: ["correctness", "scope"], targets: ["agent:a"], triggers: [{ on: "assignment_started" }] }],
      tools: [slow],
      workerSteps: [toolTurn("slow"), ctx => { context = JSON.stringify(ctx); return report("implement"); }],
      advisorSteps: [verdict("blocker", [{ domain: "scope", text: "STAY_IN_SCOPE_PLEASE", evidence: "greeting.ts:1" }, { domain: "correctness", text: "SECOND_POINT" }])],
    });
    s.manager.assign("a", "implement", "do it");
    await entered.promise;
    await until(() => s.settled() === 1, "advisor result");
    expect(s.manager.get("a").status).toBe("running");
    expect(aborted).toBe(false);
    release.resolve();
    expect(await s.manager.wait("a", 3000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(aborted).toBe(false);
    const sent = s.managerEvents.filter(event => event.type === "message_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ type: "note", from: "advisor:watch", to: "a", signal: { kind: "advisor_blocker" } });
    expect(s.notes()).toHaveLength(1);
    expect(context).toContain("STAY_IN_SCOPE_PLEASE");
    expect(context).toContain("SECOND_POINT");
    expect(s.worker.faux.state.callCount).toBe(2);
    expect(s.events.find(event => event.type === "advisor_result")).toMatchObject({ verdict: "blocker", target: "a", delivered: true });
  });

  it("enforces cooldown, per-run and per-target budgets", async () => {
    const work = quickTool("work", "ok", advisorsIdle);
    const s = await setup({
      advisors: [
        { name: "cool", domains: ["tests"], targets: ["coordinator"], cooldownMs: 60_000, triggers: [{ on: "turn_end", every: 1 }] },
        { name: "run", domains: ["tests"], targets: ["coordinator"], cooldownMs: 0, maxCallsPerRun: 2, triggers: [{ on: "turn_end", every: 1 }] },
        { name: "target", domains: ["tests"], targets: ["coordinator", "agent:a"], cooldownMs: 0, maxCallsPerRun: 99, maxCallsPerTarget: 1, triggers: [{ on: "turn_end", every: 1 }] },
      ],
      tools: [work],
      workerSteps: [toolTurn("work"), toolTurn("work"), toolTurn("work"), toolTurn("work"), report("implement")],
      advisorSteps: Array.from({ length: 9 }, () => verdict("ok")),
    });
    s.manager.assign("a", "implement", "go");
    await s.manager.wait("a", 5000);
    await until(() => s.settled() === s.events.filter(event => event.type === "advisor_triggered").length, "all advisors idle");
    const count = (name: string, target?: string) => s.events.filter(event => event.type === "advisor_triggered" && event.name === name && (!target || event.target === target)).length;
    expect(count("cool")).toBe(1);
    expect(count("run")).toBe(2);
    expect(count("target", "coordinator")).toBe(1);
    expect(count("target", "a")).toBe(1);
  });

  it("turn period counts turns per agent and fires on every Nth", async () => {
    const work = quickTool("work", "ok", advisorsIdle);
    const s = await setup({
      advisors: [{ name: "third", domains: ["tests"], targets: ["coordinator"], cooldownMs: 0, maxCallsPerRun: 9, maxCallsPerTarget: 9, triggers: [{ on: "turn_end", every: 3 }] }],
      tools: [work],
      workerSteps: [...Array.from({ length: 6 }, () => toolTurn("work")), report("implement")],
      advisorSteps: [verdict("ok"), verdict("ok")],
    });
    s.manager.assign("a", "implement", "go");
    await s.manager.wait("a", 5000);
    await until(() => s.settled() === 2, "two periodic reviews");
    // 7 worker turns: reviews after turn 3 and 6 only.
    expect(s.events.filter(event => event.type === "advisor_triggered")).toHaveLength(2);
  });

  it("fires on tool errors (not protocol tools) and on intervals while an agent runs", async () => {
    const release = deferred();
    const failing: ToolDefinition = { name: "boom", label: "boom", description: "boom", parameters: Type.Object({}), execute: async () => { throw new Error("BOOM_FAILURE"); } };
    const hold: ToolDefinition = { name: "hold", label: "hold", description: "hold", parameters: Type.Object({}), execute: async () => { await release.promise; return { content: [{ type: "text", text: "held" }], details: {} }; } };
    const s = await setup({
      advisors: [
        { name: "errors", domains: ["correctness"], targets: ["coordinator"], triggers: [{ on: "tool_error" }] },
        { name: "clock", domains: ["scope"], targets: ["coordinator"], maxCallsPerRun: 1, triggers: [{ on: "interval", ms: 100 }] },
      ],
      tools: [failing, hold],
      workerSteps: [toolTurn("boom"), toolTurn("hold"), report("implement")],
      advisorSteps: [verdict("ok"), verdict("ok")],
    });
    let errorPrompt = "";
    s.advisor.faux.setResponses([ctx => { errorPrompt = JSON.stringify(ctx); return verdict("ok"); }, verdict("ok")]);
    s.manager.assign("a", "implement", "go");
    await until(() => names(s.events, "advisor_triggered").includes("clock"), "interval trigger");
    release.resolve();
    await s.manager.wait("a", 3000);
    await until(() => s.settled() === 2, "both reviews");
    const triggered = s.events.filter(event => event.type === "advisor_triggered");
    expect(triggered.map(event => [event.name, event.trigger, event.subject]).sort()).toEqual([["clock", "interval", "a"], ["errors", "tool_error", "a"]]);
    expect(errorPrompt).toContain("BOOM_FAILURE");
  });

  it("reports advisor usage, disposes its sessions and tolerates an advisor that never answers", async () => {
    const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
    const s = await setup({
      advisors: [{ name: "flaky", domains: ["tests"], targets: ["coordinator"], cooldownMs: 0, triggers: [{ on: "assignment_result" }] }],
      workerSteps: [report("implement"), report("fix")],
      advisorSteps: [verdict("ok"), reply("I think everything is fine.")],
    });
    s.manager.assign("a", "implement", "go");
    await s.manager.wait("a", 3000);
    await until(() => s.settled() === 1, "first review");
    s.manager.assign("a", "fix", "again");
    await s.manager.wait("a", 3000);
    await until(() => s.settled() === 2, "second review");
    const usage = s.events.filter(event => event.type === "advisor_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ name: "flaky", model: s.advisor.route.model });
    expect(usage[0]!.input + usage[0]!.output).toBeGreaterThan(0);
    expect(s.events.filter(event => event.type === "advisor_failed")).toMatchObject([{ name: "flaky", reason: expect.stringContaining("advisor_verdict") }]);
    expect(s.managerEvents.some(event => event.type === "message_sent")).toBe(false);
    // worker session + 2 advisor sessions are the only ones created in the test; advisors are already disposed
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it("gives the advisor the transcript since its last advice, the workspace diff and a bounded prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-advisor-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(join(dir, "greeting.txt"), "hello wrold\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir });
    await writeFile(join(dir, "greeting.txt"), "hello world DIFF_MARKER\n");
    const huge = "H".repeat(100_000);
    let marker = "FIRST_TURN_MARK";
    const work: ToolDefinition = quickTool("work");
    work.execute = async () => {
      await advisorsIdle();
      const text = `${marker}${huge}`;
      marker = "SECOND_TURN_MARK";
      return { content: [{ type: "text", text }], details: {} };
    };
    const prompts: string[] = [];
    const capture = (): FauxResponseStep => ctx => { prompts.push(JSON.stringify(ctx.messages.findLast(message => message.role === "user"))); return verdict("ok"); };
    const s = await setup({
      cwd: dir,
      advisors: [{ name: "reader", domains: ["correctness"], targets: ["coordinator"], cooldownMs: 0, maxCallsPerRun: 5, maxCallsPerTarget: 5, triggers: [{ on: "turn_end", every: 1 }] }],
      tools: [work],
      workerSteps: [toolTurn("work"), toolTurn("work"), async () => { await advisorsIdle(); return report("implement"); }],
      advisorSteps: [capture(), capture(), capture()],
    });
    s.manager.assign("a", "implement", "go");
    await s.manager.wait("a", 5000);
    await until(() => s.settled() === 3, "three reviews");
    expect(prompts[0]).toContain("DIFF_MARKER");
    expect(prompts[0]).toContain("Fix the typo in greeting");
    expect(prompts[0]).toContain("FIRST_TURN_MARK");
    expect(prompts[1]).toContain("SECOND_TURN_MARK");
    expect(prompts[1]).not.toContain("FIRST_TURN_MARK");
    for (const prompt of prompts) expect(prompt.length).toBeLessThan(45_000);
  });

  it("does nothing when every advisor is disabled", async () => {
    const s = await setup({
      advisors: [{ preset: "plan-review", enabled: false }, { preset: "verification-audit", enabled: false }],
      workerSteps: [report("implement")], advisorSteps: [],
    });
    expect(s.engine.active).toBe(false);
    s.manager.assign("a", "implement", "go");
    await s.manager.wait("a", 3000);
    expect(s.events).toEqual([]);
    expect(s.advisor.faux.state.callCount).toBe(0);
  });
});
