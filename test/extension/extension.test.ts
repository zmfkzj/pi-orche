import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { ORCHE_USAGE, parseOrcheCommand, RESULT_MESSAGE_TYPE } from "../../src/extension/index.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConcurrentSession, ConcurrentSessionsResult, DetectConcurrentSessionsOptions } from "../../src/extension/concurrent-sessions.js";
import { runOrchestrated, type RunOptions } from "../../src/orchestration/coordinator.js";

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

  it("a failed orchestration still hands the main model what the run produced, marked as incomplete", async () => {
    let toolResult: unknown;
    const h = await harness({
      mainSteps: [
        tool("orche_run", { request: "explain greeting.txt" }),
        context => { toolResult = context.messages.findLast(message => message.role === "toolResult"); return reply("noted"); },
      ],
      orcheSteps: [
        decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" }),
        tool("report_result", { kind: "answer", summary: "PRESERVED_ANALYSIS: greeting.txt says hello world.", data: { evidence: ["greeting.txt"] } }),
        decision({ type: "fail", reason: "coordinator gave up" }),
      ],
    });
    await h.session.prompt("go");
    expect(toolResult).toMatchObject({ isError: true });
    const text = JSON.stringify(toolResult);
    expect(text).toContain("coordinator gave up");
    expect(text).toContain("Result from failed run (may be incomplete)");
    expect(text).toContain("PRESERVED_ANALYSIS: greeting.txt says hello world.");
  });

  describe("concurrent pi sessions", () => {
    const sibling = (cwd: string): ConcurrentSession => ({ id: "sibling", cwd, file: "/sessions/sibling.jsonl", lastWriteMs: Date.now() - 30_000 });
    const stub = (sessions: ConcurrentSession[]) => vi.fn(async (_options: DetectConcurrentSessionsOptions): Promise<ConcurrentSessionsResult> => ({ sessions }));
    const WARNING = /⚠ 1 other pi session active in this repository \(cwd \/work\/repo, last write (29|30|31)s ago\); their changes are classified as external where possible/;
    /** The run options the extension handed to the orchestrator. */
    const recordingRun = () => {
      const seen: RunOptions[] = [];
      return { seen, run: (options: RunOptions) => { seen.push(options); return runOrchestrated(options); } };
    };
    const toolText = (message: unknown) => (message as { content: { text: string }[] }).content.map(part => part.text).join("\n");

    it("orche_run flags the run and returns the warning first in the tool result and in the progress updates", async () => {
      const detect = stub([sibling("/work/repo")]);
      const recorder = recordingRun();
      let toolResult: unknown;
      const updates: string[] = [];
      const h = await harness({
        mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), context => { toolResult = context.messages.findLast(message => message.role === "toolResult"); return reply("relayed"); }],
        orcheSteps: answerScript("TOOL_RESULT_ANSWER"),
        extension: { detectConcurrentSessions: detect, run: recorder.run },
      });
      h.session.subscribe(event => {
        if (event.type === "tool_execution_update" && event.toolName === "orche_run") updates.push(JSON.stringify(event.partialResult));
      });
      await h.session.prompt("please delegate");

      expect(toolResult).not.toMatchObject({ isError: true });
      const text = toolText(toolResult);
      expect(text).toMatch(WARNING);
      expect(text.indexOf("⚠")).toBe(0);
      expect(text).toContain("TOOL_RESULT_ANSWER");
      // Detection happened once, for this cwd, identifying this very session.
      expect(detect).toHaveBeenCalledTimes(1);
      expect(detect.mock.calls[0]![0]).toMatchObject({ cwd: h.cwd, currentSessionId: h.session.sessionManager.getSessionId(), windowMs: 600_000 });
      // ... and the run received the flag (RunOptions.concurrentActivity).
      expect(recorder.seen).toHaveLength(1);
      expect(recorder.seen[0]!.concurrentActivity).toEqual({ count: 1, detail: expect.stringContaining("/work/repo (last write 30s ago)") });
      // The warning is the first progress line from the start.
      expect(updates.length).toBeGreaterThan(1);
      for (const update of updates) expect(update).toMatch(/^\{"content":\[\{"type":"text","text":"⚠ 1 other pi session/);
      expect(updates.join("\n")).toContain("classified as answer");
    });

    it("a failed orche_run error carries the warning first", async () => {
      let toolResult: unknown;
      const h = await harness({
        mainSteps: [tool("orche_run", { request: "do the impossible" }), context => { toolResult = context.messages.findLast(message => message.role === "toolResult"); return reply("noted"); }],
        orcheSteps: [decision({ type: "fail", reason: "cannot be done" })],
        extension: { detectConcurrentSessions: stub([sibling("/work/repo")]) },
      });
      await h.session.prompt("go");
      expect(toolResult).toMatchObject({ isError: true });
      const text = toolText(toolResult);
      expect(text).toMatch(WARNING);
      expect(text.indexOf("⚠")).toBe(0);
      expect(text).toMatch(/\n\norche FAILED \(/);
      expect(text).toContain("cannot be done");
    });

    it("/orche multi posts the warning with its result and shows it in the widget", async () => {
      const h = await harness({
        mainSteps: [reply("acknowledged")],
        orcheSteps: answerScript("ORCHE_FINAL_ANSWER"),
        extension: { detectConcurrentSessions: stub([sibling("/work/repo")]) },
      });
      await h.session.prompt("/orche multi explain greeting.txt");
      const posted = resultMessages(h);
      expect(posted).toHaveLength(1);
      expect(String(posted[0]!.content)).toMatch(WARNING);
      expect(String(posted[0]!.content).startsWith("⚠ 1 other pi session")).toBe(true);
      expect(String(posted[0]!.content)).toContain("ORCHE_FINAL_ANSWER");
      expect(posted[0]!.details).toMatchObject({ status: "done", concurrentSessions: { count: 1 } });
      const shown = h.widgets.filter(widget => widget.key === "orche" && widget.lines?.length);
      expect(shown.length).toBeGreaterThan(0);
      for (const widget of shown) expect(widget.lines![0]).toMatch(/^orche · ⚠ 1 other pi session/);
    });

    it.each([
      ["nothing is detected", undefined],
      ["detection is disabled in the config", { enabled: false }],
    ])("adds no warning and no flag when %s", async (_name, settings) => {
      const detect = stub(settings ? [sibling("/work/repo")] : []);
      const recorder = recordingRun();
      let toolResult: unknown;
      const h = await harness({
        mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), context => { toolResult = context.messages.findLast(message => message.role === "toolResult"); return reply("relayed"); }],
        orcheSteps: answerScript("TOOL_RESULT_ANSWER"),
        extension: { detectConcurrentSessions: detect, run: recorder.run },
      });
      if (settings) await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, mainMode: "auto", concurrentSessions: settings }));
      await h.session.prompt("please delegate");
      const text = toolText(toolResult);
      expect(text).toContain("TOOL_RESULT_ANSWER");
      expect(text).not.toContain("other pi session");
      expect(text.startsWith("orche finished (")).toBe(true);
      expect(recorder.seen).toHaveLength(1);
      expect("concurrentActivity" in recorder.seen[0]!).toBe(false);
      expect(detect).toHaveBeenCalledTimes(settings ? 0 : 1);
    });
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
