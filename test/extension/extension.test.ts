import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { ORCHE_USAGE, parseOrcheCommand, RESULT_MESSAGE_TYPE } from "../../src/extension/index.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

const open: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of open.splice(0)) await harness.dispose();
});
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const created = await createHarness(...args);
  open.push(created);
  return created;
}
const lastUser = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.findLast(message => message.role === "user" || message.role === "custom" || message.role === "toolResult"));
interface Posted { content: unknown; display: boolean; details?: unknown }
const resultMessages = (h: Harness): Posted[] => h.session.messages.flatMap(message => message.role === "custom" && message.customType === RESULT_MESSAGE_TYPE ? [message] : []);

describe("pi-orche as a Pi extension (real AgentSession, faux providers)", () => {
  it("exposes exactly one read and one edit, both ours, plus the search/ast/diagnostics tools", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], mainMode: "direct" });
    const active = h.session.getActiveToolNames();
    expect(active.filter(name => name === "read")).toHaveLength(1);
    expect(active.filter(name => name === "edit")).toHaveLength(1);
    expect(h.session.getToolDefinition("read")?.description).toContain("LINE#TAG");
    expect(h.session.getToolDefinition("edit")?.description).toContain("LINE#TAG");
    expect(active).toEqual(expect.arrayContaining([...WORKER_TOOL_NAMES]));
    expect(active).not.toContain("orche_run");
    expect(active).not.toContain("orche_task");
    expect(new Set(active).size).toBe(active.length);
  });

  it("long tool output from the main session is spilled to an artifact", async () => {
    let toolText = "";
    const h = await harness({
      mainSteps: [
        tool("bash", { command: "seq 1 6000" }),
        context => {
          toolText = JSON.stringify(context.messages.findLast(message => message.role === "toolResult"));
          return reply("ok");
        },
      ],
      orcheSteps: [],
      mainMode: "direct",
    });
    await h.session.prompt("print many lines");
    expect(toolText).toContain("Full output saved to .orche/artifacts/");
    expect(toolText.length).toBeLessThan(30_000);
  });

  it("/orche multi runs the orchestration and posts a visible result the main model sees next turn", async () => {
    let nextTurn = "";
    const h = await harness({
      mainSteps: [context => { nextTurn = JSON.stringify(context.messages); return reply("acknowledged"); }],
      orcheSteps: answerScript("ORCHE_FINAL_ANSWER: greeting.txt says hello world"),
    });
    await h.session.prompt("/orche multi explain greeting.txt");
    const posted = resultMessages(h);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ display: true, details: { status: "done", taskClass: "answer" } });
    expect(JSON.stringify(posted[0]!.content)).toContain("ORCHE_FINAL_ANSWER");
    expect(h.main.faux.state.callCount).toBe(0); // the command itself triggers no main-model turn
    await h.session.prompt("what did orche find?");
    expect(nextTurn).toContain("ORCHE_FINAL_ANSWER");
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("/orche direct hands the prompt to the current session as a normal user turn, with no orchestration", async () => {
    let context = "";
    const h = await harness({
      mainSteps: [ctx => { context = JSON.stringify(ctx.messages); return reply("handled by the main agent"); }],
      orcheSteps: answerScript("MUST_NOT_RUN"),
    });
    await h.session.prompt("/orche direct rename greeting"); // the command stays pending until the turn settled
    expect(h.main.faux.state.callCount).toBe(1);
    expect(context).toContain("rename greeting");
    expect(h.session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("rename greeting"))).toBe(true);
    expect(h.session.messages.some(message => message.role === "assistant")).toBe(true);
    expect(resultMessages(h)).toHaveLength(0);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(h.orche.faux.getPendingResponseCount()).toBe(3);
    expect(h.notifications).toEqual([]);
  });

  it("/orche direct while the agent is busy in direct is queued as a follow-up turn, not dropped or run concurrently", async () => {
    const gate = deferred();
    const entered = deferred();
    const seen: string[] = [];
    const h = await harness({
      mainSteps: [
        async ctx => { seen.push(JSON.stringify(ctx.messages)); entered.resolve(); await gate.promise; return reply("first done"); },
        ctx => { seen.push(JSON.stringify(ctx.messages)); return reply("second done"); },
      ],
      orcheSteps: [],
      mainMode: "direct",
    });
    const first = h.session.prompt("first request");
    await entered.promise;
    await h.session.prompt("/orche direct second request");
    expect(h.notifications.map(n => n.message).join()).toContain("queued");
    expect(h.main.faux.state.callCount).toBe(1);
    gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(2);
    expect(seen[0]).not.toContain("second request");
    expect(seen[1]).toContain("second request");
  });

  it("invalid commands print usage and start nothing", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: answerScript("MUST_NOT_RUN") });
    const invalid = ["", "single", "direct", "multi", "multi   ", "explain greeting.txt", "singlefoo bar", "Single x", "cancel now", "cancelled", "fix it multi", "stop", "stop W1 W2", "workers W1"];
    for (const args of invalid) await h.session.prompt(`/orche ${args}`.trimEnd());
    await h.session.agent.waitForIdle();
    expect(h.notifications).toHaveLength(invalid.length);
    for (const note of h.notifications) expect(note).toEqual({ message: ORCHE_USAGE, type: "warning" });
    expect(h.main.faux.state.callCount).toBe(0);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(resultMessages(h)).toHaveLength(0);
    expect(h.session.messages).toEqual([]);
  });

  it("parses the mode token strictly and keeps the prompt verbatim", () => {
    expect(parseOrcheCommand("single fix the bug")).toEqual({ mode: "single", prompt: "fix the bug" });
    expect(parseOrcheCommand("  multi   line one\n  line two  ")).toEqual({ mode: "multi", prompt: "line one\n  line two" });
    expect(parseOrcheCommand(" cancel ")).toEqual({ mode: "cancel" });
    expect(parseOrcheCommand("direct fix")).toEqual({ mode: "direct", prompt: "fix" });
    expect(parseOrcheCommand(" workers ")).toEqual({ mode: "workers" });
    expect(parseOrcheCommand("stop W1")).toEqual({ mode: "stop", worker: "W1" });
    expect(parseOrcheCommand("stop all")).toEqual({ mode: "stop", worker: "all" });
    for (const bad of ["", " ", "single", "multi\n", "fix", "multiple things", "orche multi x", "cancel now", "cancel\nmulti x"]) expect(parseOrcheCommand(bad)).toBeUndefined();
  });

  const blockedUntilAbort = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
    entered.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
    return reply("aborted");
  };

  it("/orche cancel during /orche multi stops it, disposes the sessions, posts a cancelled result; a new multi works after", async () => {
    const entered = deferred();
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const h = await harness({ mainSteps: [], orcheSteps: [blockedUntilAbort(entered)] });
    const running = h.session.prompt("/orche multi long job");
    await entered.promise;
    const disposedBefore = dispose.mock.calls.length;
    await h.session.prompt("/orche cancel");
    await running;
    expect(dispose.mock.calls.length - disposedBefore).toBe(1); // the coordinator session
    expect(h.notifications.map(note => note.message)).toContain("orche run cancelled");
    const posted = resultMessages(h);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ display: true, details: { status: "failed", cancelled: true } });
    expect(JSON.stringify(posted[0]!.content)).toContain("CANCELLED by user");
    expect(posted[0]).toMatchObject({ details: { cancellation: { scope: "cancelled", phase: "EXPLORE", workers: [] } } });
    expect(JSON.stringify(posted[0]!.content)).toContain("Cancelled at EXPLORE after");

    h.orche.faux.setResponses(answerScript("AFTER_CANCEL_ANSWER"));
    await h.session.prompt("/orche multi second try");
    const second = resultMessages(h)[1];
    expect(second).toMatchObject({ details: { status: "done", cancelled: false } });
    expect(JSON.stringify(second!.content)).toContain("AFTER_CANCEL_ANSWER");
  });

  it("in the TUI /orche multi runs in the background so the editor can submit /orche cancel", async () => {
    const entered = deferred();
    const h = await harness({ mainSteps: [], orcheSteps: [blockedUntilAbort(entered)], mode: "tui" });
    await h.session.prompt("/orche multi long job"); // returns while the run is still going
    await entered.promise;
    expect(resultMessages(h)).toHaveLength(0);
    await h.session.prompt("/orche multi parallel attempt");
    expect(h.notifications.map(note => note.message).join()).toContain("already active");
    await h.session.prompt("/orche cancel");
    expect(resultMessages(h)[0]).toMatchObject({ details: { cancelled: true } });
  });

  it("/orche cancel during orche_run ends the tool call with the error 'cancelled by user'", async () => {
    const entered = deferred();
    let toolResult: unknown;
    const h = await harness({
      mainSteps: [
        tool("orche_run", { request: "long job" }),
        context => { toolResult = context.messages.findLast(message => message.role === "toolResult"); return reply("understood"); },
      ],
      orcheSteps: [blockedUntilAbort(entered)],
    });
    const turn = h.session.prompt("delegate");
    await entered.promise;
    await h.session.prompt("/orche cancel");
    await turn;
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain("cancelled by user");
    expect(JSON.stringify(toolResult)).toContain("Cancelled at EXPLORE after");
    expect(h.notifications.map(note => note.message)).toContain("orche run cancelled");
  });

  it("/orche cancel with nothing running says so and starts nothing", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: answerScript("MUST_NOT_RUN") });
    await h.session.prompt("/orche cancel");
    expect(h.notifications).toEqual([{ message: "no active orche run", type: "info" }]);
    expect(h.main.faux.state.callCount).toBe(0);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(h.session.messages).toEqual([]);
  });

  it("orche_run delegates from the main model, streams progress and returns the final answer as the tool result", async () => {
    const updates: string[] = [];
    let toolResultSeen = "";
    const h = await harness({
      mainSteps: [
        tool("orche_run", { request: "explain greeting.txt" }),
        context => { toolResultSeen = lastUser(context); return reply("relayed"); },
      ],
      orcheSteps: answerScript("TOOL_RESULT_ANSWER"),
    });
    h.session.subscribe(event => {
      if (event.type === "tool_execution_update" && event.toolName === "orche_run") updates.push(JSON.stringify(event.partialResult));
    });
    await h.session.prompt("please delegate");
    expect(toolResultSeen).toContain("TOOL_RESULT_ANSWER");
    expect(updates.join("\n")).toContain("classified as answer");
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("a failed orchestration is an error tool result, not a success", async () => {
    let toolResult: unknown;
    const h = await harness({
      mainSteps: [
        tool("orche_run", { request: "do the impossible" }),
        context => { toolResult = context.messages.findLast(message => message.role === "toolResult"); return reply("noted"); },
      ],
      orcheSteps: [decision({ type: "fail", reason: "cannot be done" })],
    });
    await h.session.prompt("go");
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain("cannot be done");
  });

  it("aborting the main turn cancels a running orche_run and disposes the orchestration sessions", async () => {
    const entered = deferred();
    let observedAbort = false;
    const blocked: (context: unknown, options: { signal?: AbortSignal } | undefined) => Promise<AssistantMessage> = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { observedAbort = true; resolve(); }));
      return reply("aborted");
    };
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "long job" })],
      orcheSteps: [blocked as never],
    });
    const turn = h.session.prompt("delegate");
    await entered.promise;
    const disposedBefore = dispose.mock.calls.length;
    await h.session.abort();
    await turn;
    expect(observedAbort).toBe(true);
    expect(dispose.mock.calls.length - disposedBefore).toBe(1); // the coordinator session
    const toolResult = h.session.messages.findLast(message => message.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain("cancelled");
  });

  it("without any orche config the session's own model and thinking level route every role", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], writeUserConfig: false });
    h.main.faux.setResponses(answerScript("SESSION_MODEL_ANSWER"));
    await h.session.prompt("/orche multi explain greeting.txt");
    const posted = resultMessages(h);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ details: { status: "done", config: expect.stringContaining("session model") } });
    expect(JSON.stringify(posted[0]!.content)).toContain("SESSION_MODEL_ANSWER");
  });

  it("an unresolvable session model fails clearly and names the project config file", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], writeUserConfig: false, extension: { createRuntime: async () => (await fauxRuntime()).runtime } });
    await h.session.prompt("/orche multi anything");
    const posted = resultMessages(h);
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0]!.content)).toContain(".pi/orche.config.json");
    expect(posted[0]).toMatchObject({ details: { status: "failed" } });
  });
});
