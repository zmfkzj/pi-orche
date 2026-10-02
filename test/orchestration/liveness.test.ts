import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import type { Liveness } from "../../src/agent/liveness.js";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { createPhaseState } from "../../src/orchestration/phases.js";
import { forwardManagerEvent, runLiveness, spawnWorker } from "../../src/orchestration/run/context.js";
import { createCoordinator, decide } from "../../src/orchestration/run/decisions.js";
import { defaultRunLimits, type RunContext } from "../../src/orchestration/run/types.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

/** Not a git work tree: these runs must not snapshot or write refs into the developer's repository. */
const outsideGit = tmpdir();
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const classify = decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" });

const managers: AgentManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); });

/** A RunContext with exactly what the coordinator session needs: real AgentManager, real coordinator session. */
function context(runtime: Awaited<ReturnType<typeof fauxRuntime>>["runtime"], model: string, events: RunEvent[]): RunContext {
  const manager = new AgentManager(runtime);
  managers.push(manager);
  const ctx = {
    options: { problem: "p", cwd: outsideGit, routes: { routes: {}, default: { model } }, sink: (event: RunEvent) => events.push(event) },
    limits: { ...defaultRunLimits, decisionMs: 5000 }, startedAt: Date.now(), state: createPhaseState(2, 3), manager,
    decisionValue: undefined, decisionSet: false, activeTasks: new Map(), violations: [], unsubscribers: [], mainNotes: [], bufferedNoteIds: new Set(),
    workerIds: [], workerAnswers: new Map(), cancelled: false,
  } as unknown as RunContext;
  // As runOrchestrated wires it: the manager's events (workers' liveness included) go to the run's sink.
  ctx.unsubscribers.push(manager.subscribe(event => forwardManagerEvent(ctx, event)));
  return ctx;
}

describe("(g) the coordinator's activity is tracked and aggregated by ctx.liveness", () => {
  it("sees the coordinator waiting, streaming and calling its decision tool, then idle", async () => {
    const events: RunEvent[] = [];
    const snapshots: Record<string, Liveness> = {};
    let ctx!: RunContext;
    const f = await fauxRuntime([() => { snapshots.request = ctx.liveness!(); return classify; }]);
    ctx = context(f.runtime, f.route.model, events);

    // Before the coordinator exists nothing is tracked; runLiveness still answers.
    expect(ctx.liveness).toBeUndefined();
    expect(runLiveness(ctx)).toEqual({ active: false, reasons: [], sessions: [] });

    await createCoordinator(ctx, f.runtime);
    expect(ctx.liveness).toBeTypeOf("function");
    expect(ctx.coordinatorLiveness).toBeDefined();
    expect(ctx.liveness!()).toEqual({ active: false, reasons: [], sessions: [{ id: "coordinator", role: "coordinator", state: "idle", active: false, detail: "idle" }] });

    ctx.coordinator!.subscribe(event => {
      // The tracker subscribed first, so it has seen the event by now.
      if (event.type === "message_update") snapshots.streaming ??= ctx.liveness!();
      if (event.type === "tool_execution_start") snapshots.tool = ctx.liveness!();
    });
    const result = await decide(ctx, { problem: "p" }, "classify");
    expect(result).toMatchObject({ type: "classify", taskClass: "answer" });

    // The request was in flight, with no output yet, while the model had not answered.
    expect(snapshots.request).toMatchObject({ active: true, sessions: [{ id: "coordinator", state: "request-wait", active: true }] });
    expect(snapshots.request!.reasons).toEqual([expect.stringMatching(/^coordinator request in flight \d+s, no output yet$/)]);
    // Streaming its reply (the tool call arrives as deltas).
    expect(snapshots.streaming).toMatchObject({ active: true, sessions: [{ state: "streaming", active: true, lastSignalAt: expect.any(Number) }] });
    expect(snapshots.streaming!.reasons).toEqual([expect.stringMatching(/^coordinator streaming \d+s ago$/)]);
    // Running its decision tool.
    expect(snapshots.tool).toMatchObject({ active: true, sessions: [{ state: "tool", detail: expect.stringContaining("coordinator_decision") }] });
    // Done: idle again, however fresh its last output is.
    expect(ctx.liveness!()).toMatchObject({ active: false, reasons: [], sessions: [{ id: "coordinator", state: "idle", active: false }] });

    // The state changes, and only those, went into the event stream.
    const samples = events.filter(event => event.type === "liveness");
    expect(samples.map(sample => sample.state)).toEqual(["request-wait", "streaming", "tool", "request-wait", "idle"]);
    expect(samples.every(sample => sample.agentId === "coordinator" && sample.role === "coordinator" && typeof sample.timestamp === "number")).toBe(true);
    expect(samples[2]).toMatchObject({ detail: "coordinator_decision" });
  });

  it("aggregates the coordinator with every worker: a worker's tool in flight keeps the run active while the coordinator is idle", async () => {
    const events: RunEvent[] = [];
    const entered = deferred(); const release = deferred();
    const f = await fauxRuntime([classify, tool("hold", {}), tool("report_result", { kind: "answer", summary: "ok", data: { evidence: [] } })]);
    const ctx = context(f.runtime, f.route.model, events);
    await createCoordinator(ctx, f.runtime);
    await decide(ctx, { problem: "p" }, "classify");

    await spawnWorker(ctx, {
      id: "A1", role: "analyst", route: f.route, modelRuntime: f.runtime, cwd: outsideGit, instructions: "test", tools: ["hold"],
      customTools: [{ name: "hold", label: "hold", description: "hold", parameters: Type.Object({}), execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "ok" }], details: {} }; } }],
    });
    expect(ctx.liveness!().sessions.map(session => [session.id, session.state])).toEqual([["coordinator", "idle"], ["A1", "idle"]]);
    ctx.manager.assign("A1", "answer", "work");
    await entered.promise;

    const busy = ctx.liveness!();
    expect(busy.active).toBe(true);
    expect(busy.sessions.map(session => [session.id, session.state, session.active])).toEqual([["coordinator", "idle", false], ["A1", "tool", true]]);
    expect(busy.reasons).toEqual([expect.stringMatching(/^A1 hold running \d+s, no updates$/)]);
    // `now` and `windowMs` are honoured; a non-bash tool without updates is bounded by the generic 10 minutes.
    expect(ctx.liveness!(Date.now() + 9 * 60_000, 60_000).active).toBe(true);
    expect(ctx.liveness!(Date.now() + 11 * 60_000, 60_000).active).toBe(false);

    release.resolve();
    expect(await ctx.manager.wait("A1", 3000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(ctx.liveness!().active).toBe(false);
    expect(events.filter(event => event.type === "liveness").filter(event => event.agentId === "A1").map(event => event.state)).toEqual(expect.arrayContaining(["tool", "idle"]));
  });
});

describe("a whole orchestrated run reports liveness state changes", () => {
  it("emits compact samples for the coordinator and the worker, only on change, and run_finished stays last", async () => {
    const events: RunEvent[] = [];
    const steps: FauxResponseStep[] = [
      classify,
      tool("report_result", { kind: "answer", summary: "explained", data: { evidence: ["core.mjs"] } }),
      decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" }),
    ];
    const f = await fauxRuntime(steps);
    const report = await runOrchestrated({ problem: "Explain the code.", cwd: outsideGit, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
    expect(report.status).toBe("done");
    expect(events.at(-1)).toMatchObject({ type: "run_finished" });

    const samples = events.filter(event => event.type === "liveness");
    for (const id of ["coordinator", "A1"]) {
      const states = samples.filter(sample => sample.agentId === id).map(sample => sample.state);
      expect(states.length, id).toBeGreaterThan(2);
      expect(states[0], id).toBe("request-wait");
      expect(states.at(-1), id).toBe("idle");
      for (let i = 1; i < states.length; i++) expect(states[i], `${id}: only changes are reported`).not.toBe(states[i - 1]);
    }
    expect(samples.find(sample => sample.agentId === "coordinator" && sample.state === "tool")).toMatchObject({ detail: "coordinator_decision" });
    expect(samples.find(sample => sample.agentId === "A1" && sample.state === "tool")).toMatchObject({ detail: "report_result" });
    // Compact: no payload beyond the sample, and bounded in number for a three-request run.
    for (const sample of samples) expect(Object.keys(sample).sort()).toEqual(expect.arrayContaining(["agentId", "role", "state", "timestamp", "type"]));
    expect(samples.length).toBeLessThan(40);
  });
});
