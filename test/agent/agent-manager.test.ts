import { afterEach, describe, it, expect, vi } from "vitest";
import * as sessionFactory from "../../src/pi/session-factory.js";
import { Type } from "typebox";
import {
  fauxAssistantMessage as reply,
  fauxToolCall as call,
  type FauxResponseStep,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import type { AgentManagerOptions, ManagerEvent } from "../../src/agent/agent-handle.js";
const managers: AgentManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  vi.restoreAllMocks();
});
async function setup(
  steps: FauxResponseStep[],
  customTools: Parameters<AgentManager["spawn"]>[0]["customTools"] = [],
  options: AgentManagerOptions = {},
) {
  const f = await fauxRuntime(steps);
  const m = new AgentManager(f.runtime, options);
  managers.push(m);
  await m.spawn({
    id: "a",
    role: "test",
    route: f.route,
    modelRuntime: f.runtime,
    cwd: process.cwd(),
    instructions: "test",
    tools: customTools?.map((t) => t.name) ?? [],
    customTools,
  });
  return { m, ...f };
}
const result = (summary = "done", kind = "explore") =>
  reply([call("report_result", { kind, summary })], {
    stopReason: "toolUse",
  });
const note = (id = "n") => ({
  type: "note" as const,
  id,
  from: "main",
  to: "a",
  content: "PEER_UNIQUE_NOTE",
});
function notes(m: AgentManager) {
  return m
    .session("a")
    .messages.filter(
      (x) => x.role === "custom" && x.customType === "pi-orche.note",
    );
}
describe("real AgentSession deterministic races", () => {
  it("NOTE mid-tool neither aborts nor forces another request and reaches next context", async () => {
    const entered = deferred();
    const release = deferred();
    let aborted = false;
    let context = "";
    const { m, faux } = await setup(
      [
        reply([call("work", {})], { stopReason: "toolUse" }),
        (c) => {
          context = JSON.stringify(c);
          return result();
        },
      ],
      [
        {
          name: "work",
          label: "work",
          description: "work",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
            });
            entered.resolve();
            await release.promise;
            return {
              content: [{ type: "text", text: "success" }],
              details: {},
            };
          },
        },
      ],
    );
    m.assign("a", "explore", "start");
    await entered.promise;
    await m.send(note());
    release.resolve();
    const outcome = await m.wait("a", 1000);
    expect(outcome).toMatchObject({
      type: "outcome",
      outcome: { status: "completed", result: { summary: "done" } },
    });
    expect(aborted).toBe(false);
    expect(context).toContain("PEER_UNIQUE_NOTE");
    expect(faux.state.callCount).toBe(2);
    expect(notes(m)).toHaveLength(1);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("idle NOTE starts no turn; next assignment sees it, duplicate id once", async () => {
    let context = "";
    const { m, faux } = await setup([
      (c) => {
        context = JSON.stringify(c);
        return result("done", "next");
      },
    ]);
    const message = { ...note("framed-note-718"), signal: { kind: "root_cause_found", cause: "stale token invalidation", confidence: 0.91 } };
    expect(await m.send(message)).toMatchObject({ status: "delivered" });
    expect(await m.send(message)).toMatchObject({ status: "duplicate" });
    expect(faux.state.callCount).toBe(0);
    m.assign("a", "next", "start");
    await m.wait("a", 1000);
    expect(context).toContain("PEER_UNIQUE_NOTE");
    expect(context).toContain("main");
    expect(context).toContain("framed-note-718");
    expect(context).toContain("NOTE");
    expect(context).toContain("informational");
    expect(context).toContain("root_cause_found");
    expect(context).toContain("stale token invalidation");
    expect(context).toContain("0.91");
    expect(notes(m)).toHaveLength(1);
  });
  for (const timing of ["tool", "message_end", "settled"] as const)
    it(`NOTE near terminal ${timing}: no continuation, one outcome`, async () => {
      const { m, faux } = await setup([result()]);
      let delivery: Promise<unknown> | undefined;
      const seen = deferred();
      if (timing === "tool") {
        const tool = m
          .session("a")
          .agent.state.tools.find((t) => t.name === "report_result")!;
        const execute = tool.execute;
        tool.execute = async (...args) => {
          delivery = m.send(note());
          await delivery;
          return execute(...args);
        };
      } else
        m.session("a").subscribe((e) => {
          if (
            !delivery &&
            ((timing === "message_end" &&
              e.type === "message_end" &&
              e.message.role === "assistant") ||
              (timing === "settled" && e.type === "agent_settled"))
          ) {
            delivery = m.send(note());
            seen.resolve();
          }
        });
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 1000)).toMatchObject({
        type: "outcome",
        outcome: { status: "completed" },
      });
      await m.session("a").waitForIdle();
      await delivery;
      expect(faux.state.callCount).toBe(1);
      expect(notes(m)).toHaveLength(1);
      expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
    });
  it("REDIRECT mid-tool supersedes old once and completes new on same session", async () => {
    const entered = deferred();
    const cancelled = deferred();
    const { m } = await setup(
      [reply([call("work", {})], { stopReason: "toolUse" }), result("new", "fix")],
      [
        {
          name: "work",
          label: "work",
          description: "work",
          parameters: Type.Object({}),
          execute: async (_i, _a, signal) => {
            entered.resolve();
            signal?.addEventListener("abort", () => cancelled.resolve(), {
              once: true,
            });
            await cancelled.promise;
            return {
              content: [{ type: "text", text: "cancelled" }],
              details: {},
            };
          },
        },
      ],
    );
    const s = m.session("a");
    const old = m.assign("a", "explore", "OLD");
    await entered.promise;
    await m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "fix",
      prompt: "NEW",
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { assignmentId: old.id, status: "superseded" },
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { kind: "fix", status: "completed", result: { summary: "new" } },
    });
    expect(m.session("a")).toBe(s);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("REDIRECT after accepted report before settle preserves result", async () => {
    const accepted = deferred();
    const release = deferred();
    const { m } = await setup([result("old", "old"), result("new", "new")]);
    const tool = m
      .session("a")
      .agent.state.tools.find((t) => t.name === "report_result")!;
    const execute = tool.execute;
    let first = true;
    tool.execute = async (...args) => {
      const value = await execute(...args);
      if (first) {
        first = false;
        accepted.resolve();
        await release.promise;
      }
      return value;
    };
    const old = m.assign("a", "old", "OLD");
    await accepted.promise;
    const redirect = m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "new",
      prompt: "NEW",
    });
    const outcome = await m.wait("a", 1000);
    expect(outcome).toMatchObject({
      type: "outcome",
      outcome: {
        assignmentId: old.id,
        status: "completed",
        result: { summary: "old" },
      },
    });
    release.resolve();
    await redirect;
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed", result: { summary: "new" } },
    });
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("REDIRECT just after settle retains one old result and reuses context", async () => {
    let context = "";
    const { m } = await setup([
      result("old", "old"),
      (c) => {
        context = JSON.stringify(c);
        return result("new", "new");
      },
    ]);
    m.assign("a", "old", "SECRET_OLD");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { result: { summary: "old" } },
    });
    await m.session("a").waitForIdle();
    await m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "new",
      prompt: "NEW",
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { result: { summary: "new" } },
    });
    expect(context).toContain("SECRET_OLD");
    expect(m.get("a")).toMatchObject({
      status: "idle",
      completedAssignments: 2,
    });
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("NOTE and REDIRECT during STOP retain NOTE and consume outcomes once", async () => {
    const entered = deferred();
    const aborting = deferred();
    const release = deferred();
    const { m } = await setup(
      [reply([call("work", {})], { stopReason: "toolUse" }), result("new", "new")],
      [
        {
          name: "work",
          label: "work",
          description: "work",
          parameters: Type.Object({}),
          execute: async (_i, _a, signal) => {
            entered.resolve();
            signal?.addEventListener("abort", () => aborting.resolve(), {
              once: true,
            });
            await release.promise;
            return {
              content: [{ type: "text", text: "stopped" }],
              details: {},
            };
          },
        },
      ],
    );
    m.assign("a", "old", "OLD");
    await entered.promise;
    const stopping = m.stop("a");
    await aborting.promise;
    expect(m.get("a").status).toBe("stopping");
    await m.send(note());
    const redirect = m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "new",
      prompt: "NEW",
    });
    release.resolve();
    await stopping;
    await redirect;
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "stopped" },
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed" },
    });
    expect(notes(m)).toHaveLength(1);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("bounded waits and main inbox are separate from outcomes; peer sender policy", async () => {
    const { m } = await setup([result("done", "work")]);
    expect(await m.wait("any", 2)).toEqual({ type: "timeout" });
    expect(
      await m.send({
        type: "redirect",
        id: "bad",
        from: "a",
        to: "a",
        kind: "x",
        prompt: "bad",
      }),
    ).toMatchObject({ status: "rejected" });
    await m.send({ ...note(), id: "inbox", from: "a", to: "main" });
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
    expect(await m.wait(["a"], 0)).toEqual({ type: "timeout" });
    m.assign("a", "work", "start");
    expect(await m.wait(["a"], 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed" },
    });
    expect(await m.wait("any", 10)).toMatchObject({
      type: "message",
      message: { id: "inbox" },
    });
  });
  it("three workers maintain independent contexts across sequential reuse; usage observed", async () => {
    const m = new AgentManager();
    managers.push(m);
    const events: ManagerEvent[] = [];
    m.subscribe((e) => events.push(e));
    const contexts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await fauxRuntime([
        result("done", "first"),
        (c) => {
          contexts[i] = JSON.stringify(c);
          return result("done", "second");
        },
      ]);
      await m.spawn({
        id: `w${i}`,
        role: "test",
        route: f.route,
        modelRuntime: f.runtime,
        cwd: process.cwd(),
        instructions: "test",
        tools: [],
      });
      m.assign(`w${i}`, "first", `SECRET_WORKER_${i}`);
    }
    for (let i = 0; i < 3; i++) await m.wait(`w${i}`, 1000);
    for (let i = 0; i < 3; i++) {
      await m.session(`w${i}`).waitForIdle();
      m.assign(`w${i}`, "second", "recall");
    }
    for (let i = 0; i < 3; i++) {
      await m.wait(`w${i}`, 1000);
      expect(contexts[i]).toContain(`SECRET_WORKER_${i}`);
      for (let j = 0; j < 3; j++)
        if (i !== j) expect(contexts[i]).not.toContain(`SECRET_WORKER_${j}`);
      expect(m.get(`w${i}`).completedAssignments).toBe(2);
    }
    expect(events.filter((e) => e.type === "usage")).toHaveLength(6);
  });
  it("settles without report as no_result and model errors as failed", async () => {
    const { m, faux } = await setup([reply("ordinary answer")], [], { resultNudges: 0 });
    m.assign("a", "first", "start");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "no_result", lastText: "ordinary answer" },
    });
    await m.session("a").waitForIdle();
    faux.setResponses([
      reply("failure", {
        stopReason: "error",
        errorMessage: "invalid request",
      }),
    ]);
    m.assign("a", "second", "start");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "failed", error: "invalid request" },
    });
  });
  it("first report wins in a duplicate tool batch, rejected later report cannot replace it", async () => {
    const { m, faux } = await setup([
      reply(
        [
          call("report_result", { kind: "first", summary: "FIRST" }),
          call("report_result", { kind: "second", summary: "SECOND" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    m.assign("a", "first", "start");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: {
        status: "completed",
        result: { kind: "first", summary: "FIRST" },
      },
    });
    expect(faux.state.callCount).toBe(1);
    expect(
      m
        .session("a")
        .messages.filter((x) => x.role === "toolResult" && x.isError),
    ).toHaveLength(1);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("successful bounded auto-retry completes rather than retaining a transient failure", async () => {
    const { m, faux } = await setup([
      reply("temporary", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      result("recovered", "retry"),
    ]);
    m.assign("a", "retry", "start");
    expect(await m.wait("a", 3000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed", result: { summary: "recovered" } },
    });
    expect(faux.state.callCount).toBe(2);
  });
  it("fork-join worker cannot call send_message when peer messaging is disabled", async () => {
    let request = "";
    const f = await fauxRuntime([context => { request = JSON.stringify(context); return result("done", "baseline"); }]);
    const m = new AgentManager(f.runtime);
    managers.push(m);
    await m.spawn({ id: "a", role: "baseline", route: f.route, cwd: process.cwd(), instructions: "Report your finding.", tools: [], peerMessaging: false });
    expect(m.session("a").getToolDefinition("send_message")).toBeUndefined();
    expect(m.session("a").agent.state.tools.map(tool => tool.name)).not.toContain("send_message");
    m.assign("a", "baseline", "investigate");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(request).not.toContain("send_message");
  });
  it("rejects self-addressed messages without transcript or delivery side effects", async () => {
    const { m } = await setup([]);
    const before = [...m.session("a").messages];
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    const messages = [
      { ...note("self-note"), from: "a" },
      { type: "redirect" as const, id: "self-redirect", from: "a", to: "a", kind: "work", prompt: "new" },
      { type: "stop" as const, id: "self-stop", from: "a", to: "a" },
    ];
    for (const message of messages)
      expect(await m.send(message)).toMatchObject({ status: "rejected", reason: "self-addressed" });
    expect(m.session("a").messages).toEqual(before);
    expect(events.filter(event => event.type === "message_delivered")).toEqual([]);
    expect(m.get("a").status).toBe("idle");
  });
  it("nudges a missing result once and completes under the same assignment identity", async () => {
    const { m, faux } = await setup([reply("ordinary answer"), result("nudged result", "backlog_proposal")]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    const assignment = m.assign("a", "backlog_proposal", "start");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: assignment.id, status: "completed", result: { summary: "nudged result" } } });
    expect(events.filter(event => event.type === "assignment_nudged")).toMatchObject([{ agentId: "a", assignmentId: assignment.id, attempt: 1 }]);
    expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(1);
    expect(events.filter(event => event.type === "assignment_started")).toHaveLength(1);
    expect(events.filter(event => event.type === "usage").map(event => event.assignmentId)).toEqual([assignment.id, assignment.id]);
    expect(m.get("a").completedAssignments).toBe(1);
    expect(faux.state.callCount).toBe(2);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("a nudge that also omits a report produces only one final no_result", async () => {
    const { m, faux } = await setup([reply("initial"), reply("last unreported answer")]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    const assignment = m.assign("a", "explore", "start");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: assignment.id, status: "no_result", lastText: "last unreported answer" } });
    expect(events.filter(event => event.type === "assignment_nudged")).toHaveLength(1);
    expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
  });
  for (const action of ["redirect", "stop", "note"] as const)
    it(`${action.toUpperCase()} during nudge preserves interruption and context-only semantics`, async () => {
      const entered = deferred();
      const release = deferred();
      let aborted = false;
      let finalContext = "";
      const { m, faux } = await setup([
        reply("initial without report"),
        reply([call("work", {})], { stopReason: "toolUse" }),
        context => { finalContext = JSON.stringify(context); return result("final", action === "redirect" ? "new" : "old"); },
      ], [{
        name: "work", label: "work", description: "work", parameters: Type.Object({}),
        execute: async (_id, _args, signal) => {
          signal?.addEventListener("abort", () => { aborted = true; release.resolve(); }, { once: true });
          entered.resolve();
          await release.promise;
          return { content: [{ type: "text", text: "work finished" }], details: {} };
        },
      }]);
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      const old = m.assign("a", "old", "start");
      await entered.promise;
      if (action === "redirect")
        await m.send({ type: "redirect", id: "nudge-redirect", from: "main", to: "a", kind: "new", prompt: "NEW" });
      else if (action === "stop")
        await m.stop("a");
      else {
        await m.send(note("during-nudge"));
        expect(aborted).toBe(false);
        release.resolve();
      }
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: old.id, status: action === "redirect" ? "superseded" : action === "stop" ? "stopped" : "completed" } });
      if (action === "redirect")
        expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { kind: "new", status: "completed" } });
      if (action === "note") {
        expect(finalContext).toContain("PEER_UNIQUE_NOTE");
        expect(notes(m)).toHaveLength(1);
      }
      expect(events.filter(event => event.type === "assignment_nudged")).toHaveLength(1);
      expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(action === "redirect" ? 2 : 1);
      expect(faux.state.callCount).toBe(action === "stop" ? 2 : 3);
      expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
    });
  it("disabled nudges retain no_result behavior and model errors are never nudged", async () => {
    for (const failed of [false, true]) {
      const { m, faux } = await setup([failed ? reply("failure", { stopReason: "error", errorMessage: "invalid request" }) : reply("unreported")], [], { resultNudges: failed ? 1 : 0 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: failed ? "failed" : "no_result" } });
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(faux.state.callCount).toBe(1);
    }
  });
  describe("RESULT data contracts", () => {
    const contract = { schema: Type.Object({ passed: Type.Boolean() }) };
    type Data = ToolCall["arguments"][string];
    const submit = (data?: Data) => reply([call("report_result", { kind: "verify", summary: "s", ...(data === undefined ? {} : { data }) })], { stopReason: "toolUse" });
    it("rejects invalid data in the same turn and accepts the correction under one assignment", async () => {
      let correction = "";
      const { m, faux } = await setup([submit({ passed: "yes" }), context => { correction = JSON.stringify(context); return submit({ passed: true }); }], [], { resultSchemas: { verify: contract } });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      const assignment = m.assign("a", "verify", "start");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: assignment.id, status: "completed", result: { data: { passed: true } } } });
      expect(events.filter(event => event.type === "result_rejected")).toMatchObject([{ agentId: "a", assignmentId: assignment.id, kind: "verify", attempt: 1, errors: expect.stringContaining("/passed") }]);
      expect(correction).toContain("Result rejected");
      expect(correction).toContain("3 attempts left");
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(faux.state.callCount).toBe(2);
    });
    it("fails the assignment once the retry cap is exhausted, without nudging", async () => {
      const { m, faux } = await setup([submit({}), submit({}), submit({})], [], { resultSchemas: { verify: contract }, resultSchemaRetries: 2 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "verify", "start");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "failed", error: expect.stringContaining("Invalid verify RESULT after 3 attempts") } });
      expect(events.filter(event => event.type === "result_rejected").map(event => event.attempt)).toEqual([1, 2, 3]);
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(faux.state.callCount).toBe(3);
      expect(m.get("a").status).toBe("idle");
    });
    it("optional contracts accept absent or null data; uncontracted kinds accept anything", async () => {
      const optional = { verify: { ...contract, optional: true } };
      for (const data of [undefined, null] as const) {
        const { m } = await setup([submit(data)], [], { resultSchemas: optional });
        m.assign("a", "verify", "start");
        expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
      }
      const { m } = await setup([reply([call("report_result", { kind: "answer", summary: "s", data: 42 })], { stopReason: "toolUse" })], [], { resultSchemas: { verify: contract } });
      m.assign("a", "answer", "start");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { data: 42 } } });
    });
    it("a new assignment starts with a fresh retry budget", async () => {
      const { m } = await setup([submit({}), submit({}), submit({ passed: false }), submit({}), submit({ passed: true })], [], { resultSchemas: { verify: contract }, resultSchemaRetries: 1 });
      m.assign("a", "verify", "first");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "failed" } });
      m.assign("a", "verify", "second");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { data: { passed: false } } } });
      m.assign("a", "verify", "third");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { data: { passed: true } } } });
    });
    it("rejects an invalid retry cap", () => {
      expect(() => new AgentManager(undefined, { resultSchemaRetries: -1 })).toThrow("resultSchemaRetries");
    });
  });
  describe("request budget", () => {
    const workTool = {
      name: "work", label: "work", description: "work", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "worked" }], details: {} }),
    };
    const work = () => reply([call("work", {})], { stopReason: "toolUse" });
    it("notices at the budget, stops at 1.5x and gets the forced report under the same assignment", async () => {
      let noticed = "";
      let forced = "";
      const { m, faux } = await setup([
        work(), work(),
        context => { noticed = JSON.stringify(context); return work(); },
        context => { forced = JSON.stringify(context); return result("partial"); },
      ], [workTool], { requestBudget: 2 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      const assignment = m.assign("a", "explore", "start");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { assignmentId: assignment.id, status: "completed", result: { summary: "partial" } } });
      expect(events.filter(event => event.type === "request_budget").map(event => [event.action, event.requests])).toEqual([["notice", 2], ["stop", 3]]);
      expect(noticed).toContain("soft budget 2");
      expect(forced).toContain("request budget for assignment explore is exhausted");
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(1);
      expect(faux.state.callCount).toBe(4);
    });
    it("a stop-threshold request that already reports is not aborted", async () => {
      const { m } = await setup([work(), result("on time")], [workTool], { requestBudget: 1 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { summary: "on time" } } });
      expect(events.filter(event => event.type === "request_budget").map(event => event.action)).toEqual(["notice"]);
    });
    it("fails the assignment when the forced report keeps working past the grace requests", async () => {
      const { m } = await setup(Array.from({ length: 2 + 6 }, work), [workTool], { requestBudget: 1 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 4000)).toMatchObject({ type: "outcome", outcome: { status: "failed", error: expect.stringContaining("Request budget exhausted after 7 requests") } });
      expect(events.filter(event => event.type === "request_budget").map(event => event.action)).toEqual(["notice", "stop", "abort"]);
      expect(m.get("a").status).toBe("idle");
    });
    it("each assignment has its own budget and 0 disables it", async () => {
      expect(() => new AgentManager(undefined, { requestBudget: 1.5 })).toThrow("requestBudget");
      const { m } = await setup([work(), result("first"), work(), result("second")], [workTool], { requestBudget: 3 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "one");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
      m.assign("a", "explore", "two");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
      expect(events.filter(event => event.type === "request_budget")).toEqual([]);
    });
  });
  /**
   * Pi 1.1.0 adds `agent_settled.aborted` (any abort of the run). The manager deliberately keeps classifying a settled run by its own
   * state: its own budget stop aborts the run and must still lead to the forced report, and a stop has already finalized the outcome.
   */
  describe("agent_settled.aborted (pi 1.1.0) does not change the outcome", () => {
    const settledFlags = (m: AgentManager) => {
      const flags: unknown[] = [];
      m.session("a").subscribe(event => { if (event.type === "agent_settled") flags.push(event.aborted); });
      return flags;
    };
    const workTool = {
      name: "work", label: "work", description: "work", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "worked" }], details: {} }),
    };
    const work = () => reply([call("work", {})], { stopReason: "toolUse" });
    it("a normal run settles with aborted false and completes", async () => {
      const { m } = await setup([result("plain")]);
      const flags = settledFlags(m);
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
      await m.session("a").waitForIdle();
      expect(flags).toEqual([false]);
    });
    it("the budget stop settles with aborted true and still gets the forced report", async () => {
      const { m, faux } = await setup([work(), work(), work(), result("partial")], [workTool], { requestBudget: 2 });
      const flags = settledFlags(m);
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { summary: "partial" } } });
      await m.session("a").waitForIdle();
      expect(flags).toEqual([true, false]);
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(faux.state.callCount).toBe(4);
      expect(m.workerLiveness("a")).toMatchObject({ active: false, state: "idle" });
    });
    it("a stop settles with aborted true, stays stopped and sends nothing more", async () => {
      const entered = deferred();
      const { m, faux } = await setup([work(), result("never")], [{
        ...workTool,
        execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
          entered.resolve();
          await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
          return { content: [{ type: "text" as const, text: "stopped" }], details: {} };
        },
      }]);
      const flags = settledFlags(m);
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "start");
      await entered.promise;
      await m.stop("a");
      expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "stopped" } });
      await m.session("a").waitForIdle();
      expect(flags).toEqual([true]);
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(1);
      expect(faux.state.callCount).toBe(1);
      expect(m.get("a").status).toBe("idle");
      expect(m.workerLiveness("a")).toMatchObject({ active: false, state: "idle" });
    });
  });
});

 describe("RESULT kind and lifecycle fences", () => {
  it("checks kind without a schema and corrects under the same identity", async () => {
    let context = "";
    const { m } = await setup([result("wrong", "analysis"), c => { context = JSON.stringify(c); return result(); }]);
    const a = m.assign("a", "explore", "start");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: a.id, status: "completed" } });
    expect(context).toContain('Expected RESULT kind');
    expect(context).toContain('analysis');
    expect(context).toContain('3 attempts left');
    expect(m.get("a")).toMatchObject({ requestCount: 2, lastToolName: "report_result", lastToolAt: expect.any(Number), lastActivityAt: expect.any(Number) });
  });
  it("kind mismatches share a bounded budget; a new kind resets it", async () => {
    const { m } = await setup([result("bad", "wrong"), result("bad", "wrong"), result("bad", "explore"), result("good", "fix")], [], { resultSchemaRetries: 1 });
    const events: ManagerEvent[] = [];
    m.subscribe(e => events.push(e));
    m.assign("a", "explore", "first");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "failed", error: expect.stringContaining('received "wrong"') } });
    await m.session("a").waitForIdle();
    const second = m.assign("a", "fix", "second");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: second.id, status: "completed", result: { kind: "fix" } } });
    expect(events.filter(e => e.type === "result_rejected").map(e => e.attempt)).toEqual([1, 2, 1]);
    expect(events.filter(e => e.type === "assignment_outcome")).toHaveLength(2);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("redirect resets mismatches and uses the new expected kind", async () => {
    const entered = deferred();
    const release = deferred();
    const { m } = await setup([
      result("bad", "wrong"), reply([call("work", {})], { stopReason: "toolUse" }),
      result("old", "explore"), result("good", "fix"),
    ], [{
      name: "work", label: "work", description: "work", parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        signal?.addEventListener("abort", () => release.resolve(), { once: true });
        entered.resolve(); await release.promise;
        return { content: [{ type: "text", text: "stopped" }], details: {} };
      },
    }], { resultSchemaRetries: 1 });
    const events: ManagerEvent[] = [];
    m.subscribe(e => events.push(e));
    const old = m.assign("a", "explore", "first");
    await entered.promise;
    await m.send({ type: "redirect", id: "new-kind", from: "main", to: "a", kind: "fix", prompt: "second" });
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: old.id, status: "superseded" } });
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { kind: "fix", status: "completed" } });
    expect(events.filter(e => e.type === "result_rejected").map(e => [e.kind, e.attempt])).toEqual([["explore", 1], ["fix", 1]]);
  });
  it("kind is checked before otherwise valid data", async () => {
    const submit = (kind: string) => reply([call("report_result", { kind, summary: "s", data: { passed: true } })], { stopReason: "toolUse" });
    const { m } = await setup([submit("wrong"), submit("verify")], [], { resultSchemas: { verify: { schema: Type.Object({ passed: Type.Boolean() }) } } });
    const events: ManagerEvent[] = [];
    m.subscribe(e => events.push(e));
    m.assign("a", "verify", "start");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(events.filter(e => e.type === "result_rejected")).toHaveLength(1);
  });
  it("close rejects assignment, spawn and tool side effects", async () => {
    const { m } = await setup([]);
    const before = [...m.session("a").messages];
    m.close("deadline");
    expect(() => m.assign("a", "explore", "late")).toThrow("deadline");
    await expect(m.spawn({ id: "b", role: "test", cwd: process.cwd(), route: m.get("a").route, instructions: "test", tools: [] })).rejects.toMatchObject({ name: "AbortError" });
    for (const name of ["report_result", "send_message"]) {
      const tool = m.session("a").agent.state.tools.find(t => t.name === name)!;
      const response = await tool.execute("late", name === "report_result" ? { kind: "explore", summary: "late" } : { to: "main", content: "late" });
      expect(response).toMatchObject({ isError: true });
    }
    expect(await m.send(note())).toMatchObject({ status: "rejected" });
    expect(m.session("a").messages).toEqual(before);
    expect(await m.wait("any", 0)).toEqual({ type: "timeout" });
  });
  for (const cancellation of ["close", "signal"] as const) it(`disposes late creation after ${cancellation}`, async () => {
    const { m } = await setup([]);
    const late = Promise.withResolvers<Awaited<ReturnType<typeof sessionFactory.createSession>>>();
    vi.spyOn(sessionFactory, "createSession").mockReturnValueOnce(late.promise);
    const controller = new AbortController();
    const spawning = m.spawn({ id: "b", role: "test", cwd: process.cwd(), route: m.get("a").route, instructions: "test", tools: [], signal: controller.signal });
    await Promise.resolve();
    if (cancellation === "close") m.close("timeout"); else controller.abort("timeout");
    await expect(spawning).rejects.toMatchObject({ name: "AbortError" });
    const dispose = vi.fn();
    late.resolve({ dispose } as unknown as Awaited<ReturnType<typeof sessionFactory.createSession>>);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispose).toHaveBeenCalledOnce();
    expect(m.list().map(w => w.id)).toEqual(["a"]);
  });
  it("bounds abort waits, disposes all workers and observes a late rejection", async () => {
    const { m } = await setup([]);
    const late = Promise.withResolvers<void>();
    vi.spyOn(m.session("a"), "abort").mockReturnValue(late.promise);
    const dispose = vi.spyOn(m.session("a"), "dispose");
    expect(await m.disposeWithin(5)).toEqual({ pendingWorkerIds: ["a"] });
    expect(dispose).toHaveBeenCalledOnce();
    expect(m.get("a").status).toBe("disposed");
    late.reject(new Error("late abort failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
 });

it("close releases outstanding manager wait timers", async () => {
  const { m } = await setup([]);
  const waiting = m.wait("any", 60_000);
  m.close("deadline");
  expect(await waiting).toEqual({ type: "timeout" });
});

describe("liveness (see src/agent/liveness.ts)", () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const beat = (extra: Record<string, unknown> = {}) => ({ type: "bash_heartbeat", seq: 1, at: Date.now(), elapsedMs: 15_000, outputBytes: 0, newOutput: false, procAvailable: true, progressing: false, ...extra });
  /** A tool that runs until released and may leave heartbeats (as partial results) while it does. */
  type Update = (partial: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  function holdTool(entered: { resolve(): void }, release: { promise: Promise<void> }, report: { onUpdate?: Update } = {}) {
    return {
      name: "work", label: "work", description: "work", parameters: Type.Object({}),
      execute: async (_id: string, _args: unknown, _signal: AbortSignal | undefined, onUpdate?: Update) => {
        report.onUpdate = onUpdate;
        entered.resolve(); await release.promise;
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
  }
  it("an unassigned worker is idle and never active", async () => {
    const { m } = await setup([]);
    expect(m.liveness()).toEqual({ active: false, reasons: [], sessions: [{ id: "a", role: "test", state: "idle", active: false, detail: "idle" }] });
    expect(m.workerLiveness("a")).toMatchObject({ id: "a", state: "idle", active: false });
    expect(() => m.workerLiveness("nope")).toThrow("Unknown agent");
  });
  it("tracks a worker through its assignment: tool in flight is active, the finished assignment is idle", async () => {
    const entered = deferred(); const release = deferred();
    const { m } = await setup([reply([call("work", {})], { stopReason: "toolUse" }), result()], [holdTool(entered, release)]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    m.assign("a", "explore", "start");
    await entered.promise;
    const during = m.liveness();
    expect(during.active).toBe(true);
    expect(during.sessions).toEqual([expect.objectContaining({ id: "a", role: "test", state: "tool", active: true })]);
    expect(during.reasons).toEqual([expect.stringMatching(/^a work running \d+s, no updates$/)]);
    expect(m.workerLiveness("a")).toMatchObject({ state: "tool", active: true });
    // Another id filter excludes it.
    expect(m.liveness(Date.now(), 60_000, ["other"])).toEqual({ active: false, reasons: [], sessions: [] });
    release.resolve();
    expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(m.liveness()).toMatchObject({ active: false, reasons: [], sessions: [{ id: "a", state: "idle", active: false }] });
    // The records/events stream gets the state changes, once each, with the tool named.
    const samples = events.filter(event => event.type === "liveness");
    expect(samples.map(sample => sample.state)).toEqual(expect.arrayContaining(["request-wait", "streaming", "tool", "idle"]));
    expect(samples.find(sample => sample.state === "tool")).toMatchObject({ type: "liveness", agentId: "a", role: "test", detail: "work", timestamp: expect.any(Number) });
    expect(samples.at(-1)).toMatchObject({ state: "idle" });
    for (let i = 1; i < samples.length; i++) expect(samples[i]!.state, "only changes are reported").not.toBe(samples[i - 1]!.state);
  });
  it("a bash-style heartbeat that is alive but idle is not activity; a progressing one is", async () => {
    const entered = deferred(); const release = deferred();
    const report: { onUpdate?: Update } = {};
    const { m } = await setup([reply([call("work", {})], { stopReason: "toolUse" }), result()], [holdTool(entered, release, report)]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    m.assign("a", "explore", "start");
    await entered.promise;
    await sleep(15);
    const quiet = m.get("a").lastActivityAt!;
    report.onUpdate!({ content: [], details: { heartbeat: beat() } });
    await sleep(15);
    expect(m.get("a").lastActivityAt, "an idle heartbeat does not refresh lastActivityAt").toBe(quiet);
    // Long after the start, with only idle heartbeats: alive, not progressing, not active.
    const late = m.workerLiveness("a", Date.now() + 10 * 60_000, 60_000);
    expect(late).toMatchObject({ state: "tool", active: false });
    expect(late.detail).toContain("alive but not progressing");
    report.onUpdate!({ content: [], details: { heartbeat: beat({ seq: 2, progressing: true, cpuMs: 500, processes: 2 }) } });
    await sleep(15);
    expect(m.get("a").lastActivityAt!).toBeGreaterThan(quiet);
    const progressing = m.workerLiveness("a", Date.now(), 60_000);
    expect(progressing.active).toBe(true);
    expect(progressing.detail).toMatch(/^work running \d+s, cpu\/io activity \d+s ago \(cpu 500ms, 2 procs\)$/);
    expect(events.filter(event => event.type === "liveness").map(event => event.state).filter(state => state === "tool")).toHaveLength(1);
    release.resolve();
    await m.wait("a", 2000);
  });
  it("a worker's known tool timeout bounds its silent tool", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fauxRuntime([reply([call("work", {})], { stopReason: "toolUse" }), result()]);
    const m = new AgentManager(f.runtime); managers.push(m);
    await m.spawn({ id: "a", role: "test", route: f.route, modelRuntime: f.runtime, cwd: process.cwd(), instructions: "test", tools: ["work"], customTools: [holdTool(entered, release)], toolTimeoutsMs: { work: 20 * 60_000 } });
    m.assign("a", "explore", "start");
    await entered.promise;
    expect(m.workerLiveness("a", Date.now() + 15 * 60_000, 60_000).active).toBe(true); // its own timeout, not the generic 10 minutes
    expect(m.workerLiveness("a", Date.now() + 25 * 60_000, 60_000).active).toBe(false);
    release.resolve();
    await m.wait("a", 2000);
  });
  it("a closed manager emits no more liveness samples and a disposed worker is left out", async () => {
    const entered = deferred(); const release = deferred();
    const { m } = await setup([reply([call("work", {})], { stopReason: "toolUse" }), result()], [holdTool(entered, release)]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    m.assign("a", "explore", "start");
    await entered.promise;
    m.close("deadline");
    const seen = events.filter(event => event.type === "liveness").length;
    release.resolve();
    await sleep(30);
    expect(events.filter(event => event.type === "liveness")).toHaveLength(seen);
    await m.dispose();
    expect(m.liveness()).toEqual({ active: false, reasons: [], sessions: [] });
    expect(m.workerLiveness("a")).toMatchObject({ state: "idle", active: false });
  });
});
