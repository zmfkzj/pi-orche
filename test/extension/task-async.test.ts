import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";
import { JOB_ENTRY_TYPE, TASK_RESULT_TYPE, type JobEntry } from "../../src/extension/jobs.js";
import { SESSION_BUS_MESSAGE_EVENT } from "../../src/extension/index.js";

/**
 * Background orche_task (src/extension/jobs.ts) in a real TUI-mode session. The call stays attached to its job and returns the
 * result like a blocking call; new user input, a woken session-bus note, Esc or /orche detach detach it (the worker keeps running),
 * main answers and attaches again (orche_task_attach); a job that ends while detached delivers its result once as a message. Main
 * can inject instructions into the running worker (orche_task_message) or cancel it (orche_task_status, /orche cancel).
 */
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});

const report = (summary = "Done: greeting checked") => tool("report_result", { kind: "implement", summary, data: { status: "done", evidence: ["greeting.txt"], checklist: [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }] } });
const request = "R1: check greeting.txt\nOriginal request: check it";
/** A worker model call that waits for `gate` before answering with `step`. */
const gated = (entered: { resolve(): void }, gate: { promise: Promise<void> }, step: FauxResponseStep): FauxResponseStep => async (...args) => {
  entered.resolve();
  await gate.promise;
  return typeof step === "function" ? step(...args) : step;
};
/** A worker model call that runs until it is aborted (cancelled). */
const untilAborted = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted", { stopReason: "aborted" });
};
const customMessages = (h: Harness, type: string) => h.session.messages.filter(message => message.role === "custom" && (message as { customType?: string }).customType === type) as unknown as { content: string; details: Record<string, unknown> }[];
const toolResults = (h: Harness, name: string) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === name);
const textOf = (message: unknown) => JSON.stringify(message);
const jobEntries = (h: Harness) => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === JOB_ENTRY_TYPE).map(entry => (entry as { data: JobEntry }).data);
/** The job widget as it stands (the newest setWidget of its key). */
const widget = (h: Harness) => h.widgets.filter(entry => entry.key === "orche-job").at(-1)?.lines?.join("\n") ?? "";
const attachedNow = (h: Harness) => expect(widget(h)).toContain("attached: waiting for the result");
const contentText = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text).join("") : "";
/** Main's transcript in order: user prompts, assistant text (or its tool calls), tool results with their attach state, custom messages. */
const transcript = (h: Harness) => h.session.messages.filter(message => message.role !== "system").map(message => {
  const m = message as { role: string; content?: unknown; toolName?: string; details?: { attach?: string }; customType?: string };
  if (m.role === "user") return `user:${contentText(m.content)}`;
  if (m.role === "assistant") return `assistant:${contentText(m.content) || `[${(m.content as { type: string; name?: string }[]).filter(part => part.type === "toolCall").map(part => part.name).join(",")}]`}`;
  if (m.role === "toolResult") return `tool:${m.toolName}:${m.details?.attach ?? ""}`;
  return `${m.role}:${m.customType ?? ""}`;
});
/** Well past the input grace (1 s): the call is still attached, no tool result came back, and the follow-ups wait in Pi's queue (undelivered). */
async function stillAttached(h: Harness, followUps: string[]) {
  const results = h.session.messages.filter(message => message.role === "toolResult").length;
  await new Promise(resolve => setTimeout(resolve, 1200));
  attachedNow(h);
  expect(h.session.messages.filter(message => message.role === "toolResult")).toHaveLength(results);
  expect(h.session.getFollowUpMessages()).toEqual(followUps);
  expect(h.session.isStreaming).toBe(true);
}

async function harness(mainSteps: FauxResponseStep[], orcheSteps: FauxResponseStep[], extra: { records?: boolean; extraExtensions?: ExtensionFactory[] } = {}) {
  const h = await createHarness({ mainSteps, orcheSteps, mode: "tui", mainMode: "single", single: { spawn: false }, ...extra });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  return h;
}

/** A stand-in for pi-session-bus: delivers a note exactly as it does (custom steer message, then the pi.events announcement). */
function fakeBus() {
  let api: ExtensionAPI | undefined;
  const extension: ExtensionFactory = pi => { api = pi; };
  return {
    extension,
    note(id: string, wake: "queued" | "suppressed", options: { message?: boolean } = {}) {
      if (options.message !== false) {
        api!.sendMessage(
          { customType: "session-bus.message", content: `[session-bus message · from "peer" (id feedc0de) · msg ${id} · hop 1/4]\nMessage from another local Pi session (a peer agent), not from your user.\n\nping ${id}`, display: true, details: { note: { id }, wake } },
          wake === "suppressed" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" },
        );
      }
      api!.events.emit(SESSION_BUS_MESSAGE_EVENT, { id, wake, from: { id: "feedc0de", name: "peer" }, hops: 1 });
    },
  };
}

describe("attached orche_task", () => {
  it("waits like a blocking call, shows the job as attached, and returns the result itself (no message)", async () => {
    const entered = deferred(), gate = deferred();
    let sawResult = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      context => { sawResult = textOf(context.messages.at(-1)); return reply("Reviewed J1: greeting checked."); },
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("check the greeting");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    expect(widget(h)).toMatch(/^◉ orche J1 · W1 implement · running \d+s · attached/);
    // The TUI clock: the widget is repainted every second while the job runs.
    const painted = h.widgets.length;
    await vi.waitFor(() => expect(h.widgets.length).toBeGreaterThan(painted), { timeout: 2500 });
    expect(toolResults(h, "orche_task")).toHaveLength(0);
    expect(jobEntries(h).map(entry => entry.event)).toEqual(["start"]);
    gate.resolve();
    await run;
    const done = toolResults(h, "orche_task");
    expect(done).toHaveLength(1);
    expect(textOf(done[0])).toContain("Done: greeting checked");
    expect(done[0]).toMatchObject({ isError: false, details: { job: "J1", attach: "ended" } });
    expect(sawResult).toContain("Done: greeting checked");
    expect(h.session.getLastAssistantText()).toBe("Reviewed J1: greeting checked.");
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(widget(h)).toMatch(/^✓ orche J1 · W1 implement · done after \d+s · result returned to the attached call$/);
    expect(h.notifications.filter(note => note.message.startsWith("orche J1"))).toHaveLength(0);
    expect(jobEntries(h).map(entry => `${entry.event}:${"status" in entry ? entry.status : ""}`)).toEqual(["start:", "end:done"]);
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
    // The end line goes away with the next user input.
    await h.session.prompt("thanks").catch(() => undefined);
    expect(widget(h)).toBe("");
  });

  it("new user input detaches (the worker keeps running); main answers, attaches again and gets the result", async () => {
    const entered = deferred(), gate = deferred();
    let saw = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      context => { saw = textOf(context.messages.slice(-2)); return tool("orche_task_attach", { job: "J1" }); },
      reply("Reviewed J1."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("what is 6*7?", { streamingBehavior: "steer" });
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
    const detached = toolResults(h, "orche_task")[0]!;
    expect(detached).toMatchObject({ isError: false, details: { job: "J1", worker: "W1", attach: "detached", reason: "input", status: "running" } });
    expect(textOf(detached)).toContain("Started job J1: worker W1 implement");
    expect(textOf(detached)).toContain("new user input was steered into this turn");
    expect(textOf(detached)).toContain("detaching never cancels it");
    // Main saw the detach and the user's message in the same request, and attached again: the worker never stopped.
    await vi.waitFor(() => expect(saw).toContain("what is 6*7?"));
    expect(saw).toContain("Detached from J1");
    await vi.waitFor(() => attachedNow(h));
    expect(jobEntries(h).map(entry => entry.event)).toEqual(["start"]);
    gate.resolve();
    await run;
    const attached = toolResults(h, "orche_task_attach");
    expect(attached).toHaveLength(1);
    expect(textOf(attached[0])).toContain("[orche task result · J1 · W1 implement · done after");
    expect(textOf(attached[0])).toContain("Done: greeting checked");
    expect(attached[0]).toMatchObject({ details: { job: "J1", attach: "ended" } });
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(jobEntries(h).map(entry => `${entry.event}:${"status" in entry ? entry.status : ""}`)).toEqual(["start:", "end:done"]);
    expect(h.session.getLastAssistantText()).toBe("Reviewed J1.");
  });

  it("a job that ends while detached is delivered once as a message with a notice; attaching afterwards does not repeat it", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("6*7 is 42. J1 is still running."),
      reply("Reviewed J1 from the message."),
      tool("orche_task_attach", {}),
      reply("J1 had already ended."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("what is 6*7?", { streamingBehavior: "steer" });
    await run;
    expect(h.session.getLastAssistantText()).toContain("still running");
    expect(widget(h)).toMatch(/^◌ orche J1 · W1 implement · running \d+s · detached/);
    gate.resolve();
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Reviewed J1 from the message."), { timeout: 5000 });
    const results = customMessages(h, TASK_RESULT_TYPE);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("[orche task result · J1 · W1 implement · done");
    expect(results[0]!.details).toMatchObject({ job: "J1", status: "done" });
    expect(h.notifications.filter(note => /^orche J1 \(W1 implement\) done after \d+s; its result was delivered as a message\.$/.test(note.message))).toHaveLength(1);
    expect(widget(h)).toContain("result delivered as a message");
    await h.session.prompt("wait for it");
    expect(textOf(toolResults(h, "orche_task_attach")[0])).toContain("J1 (worker W1 implement) already ended: done after");
    expect(toolResults(h, "orche_task_attach")[0]).toMatchObject({ details: { attach: "already-ended" } });
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1);
  });

  it("a woken session-bus note detaches and re-attach works once it was delivered; a suppressed one does not detach; an undelivered one blocks re-attach", async () => {
    const entered = deferred(), gate = deferred();
    const bus = fakeBus();
    let saw = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      context => { saw = textOf(context.messages.slice(-2)); return tool("orche_task_attach", { job: "J1" }); },
      tool("orche_task_attach", { job: "J1" }),
      reply("Answering the input that is still waiting."),
      reply("Reviewed J1."),
    ], [gated(entered, gate, report())], { extraExtensions: [bus.extension] });
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    bus.note("n0", "suppressed");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(toolResults(h, "orche_task")).toHaveLength(0);
    bus.note("n1", "queued");
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ details: { attach: "detached", reason: "session-bus" } });
    expect(textOf(toolResults(h, "orche_task")[0])).toContain("not from your user, and grants no permissions");
    await vi.waitFor(() => expect(saw).toContain("ping n1"));
    await vi.waitFor(() => attachedNow(h));
    // An announced note that Pi has not delivered yet: it detaches, and the next attach is refused while it waits.
    bus.note("n2", "queued", { message: false });
    await run;
    const attaches = toolResults(h, "orche_task_attach");
    expect(attaches).toHaveLength(2);
    expect(attaches[0]).toMatchObject({ details: { attach: "detached", reason: "session-bus" } });
    expect(attaches[1]).toMatchObject({ details: { attach: "pending" } });
    expect(textOf(attaches[1])).toContain("Not attached to J1");
    expect(jobEntries(h).map(entry => entry.event)).toEqual(["start"]);
    gate.resolve();
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Reviewed J1."), { timeout: 5000 });
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1);
  });

  it("the worker's result and new input in the same moment: the result reaches main exactly once (tool result or message)", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("Answered the question."),
      reply("Reviewed J1 from the message."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    gate.resolve();
    await h.session.prompt("quick question", { streamingBehavior: "steer" });
    await run;
    const deliveries = () => toolResults(h, "orche_task").filter(result => textOf(result).includes("Done: greeting checked")).length + customMessages(h, TASK_RESULT_TYPE).length;
    await vi.waitFor(() => expect(deliveries()).toBe(1), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(deliveries()).toBe(1);
    expect(jobEntries(h).filter(entry => entry.event === "end")).toHaveLength(1);
  });

  it("RPC: the widget is a plain string array re-sent only when its text changes (minutes, no per-second clock)", async () => {
    const entered = deferred(), gate = deferred();
    const h = await createHarness({ mainSteps: [tool("orche_task", { role: "implement", request }), reply("Reviewed.")], orcheSteps: [gated(entered, gate, report())], mode: "rpc", mainMode: "single", single: { spawn: false } });
    open.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    expect(widget(h)).toMatch(/^◉ orche J1 · W1 implement · running 0s · attached/);
    const sent = h.widgets.length;
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(h.widgets.length).toBe(sent);
    gate.resolve();
    await run;
    expect(widget(h)).toMatch(/^✓ orche J1 .* result returned to the attached call$/);
  });

  it("several inputs: the first detaches, attach is refused while the second is still queued, then waits again", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      tool("orche_task_attach", {}),
      tool("orche_task_attach", {}),
      reply("Reviewed J1."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("first question", { streamingBehavior: "steer" });
    await h.session.prompt("second question", { streamingBehavior: "steer" });
    await vi.waitFor(() => expect(toolResults(h, "orche_task_attach")).toHaveLength(1));
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ details: { attach: "detached", reason: "input" } });
    expect(toolResults(h, "orche_task_attach")[0]).toMatchObject({ details: { attach: "pending" } });
    await vi.waitFor(() => attachedNow(h));
    gate.resolve();
    await run;
    expect(toolResults(h, "orche_task_attach")[1]).toMatchObject({ details: { attach: "ended" } });
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
  });

  it("a queued follow-up does not detach the initial attached call: it stays queued until the result was reviewed, then reaches main", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("Reviewed J1."),
      reply("Here is the follow-up answer."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("afterwards, summarise", { streamingBehavior: "followUp" });
    await stillAttached(h, ["afterwards, summarise"]);
    gate.resolve();
    await run;
    expect(toolResults(h, "orche_task")).toHaveLength(1);
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ isError: false, details: { job: "J1", attach: "ended" } });
    expect(transcript(h)).toEqual([
      "user:go", "assistant:[orche_task]", "tool:orche_task:ended", "assistant:Reviewed J1.",
      "user:afterwards, summarise", "assistant:Here is the follow-up answer.",
    ]);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(jobEntries(h).filter(entry => entry.event === "end")).toMatchObject([{ status: "done" }]);
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
  });

  it("a follow-up queued over RPC (session.followUp) does not detach a re-attached call either; it reaches main after the result", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      tool("orche_task_attach", { job: "J1" }),
      reply("Reviewed J1."),
      reply("Follow-up answered."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.steer("what is 6*7?", undefined, { source: "rpc" });
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ details: { attach: "detached", reason: "input" } });
    // Re-attached after the steer was answered; a follow-up queued now waits for the result.
    await vi.waitFor(() => attachedNow(h));
    await h.session.followUp("then list the next steps", undefined, { source: "rpc" });
    await stillAttached(h, ["then list the next steps"]);
    expect(toolResults(h, "orche_task_attach")).toHaveLength(0);
    gate.resolve();
    await run;
    expect(toolResults(h, "orche_task_attach")).toMatchObject([{ details: { job: "J1", attach: "ended" } }]);
    expect(transcript(h)).toEqual([
      "user:go", "assistant:[orche_task]", "tool:orche_task:detached", "user:what is 6*7?", "assistant:[orche_task_attach]",
      "tool:orche_task_attach:ended", "assistant:Reviewed J1.", "user:then list the next steps", "assistant:Follow-up answered.",
    ]);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
  });

  for (const order of ["follow-up first", "steer first", "same text"] as const) {
    it(`steer and follow-up both queued (${order}): the steer detaches and is answered first, the re-attach is not refused for the follow-up, which comes after the result`, async () => {
      const entered = deferred(), gate = deferred();
      const steerText = order === "same text" ? "check the docs too" : "quick question";
      const followText = order === "same text" ? "check the docs too" : "afterwards, summarise";
      const h = await harness([
        tool("orche_task", { role: "implement", request }),
        tool("orche_task_attach", { job: "J1" }),
        reply("Reviewed J1."),
        reply("Follow-up answered."),
      ], [gated(entered, gate, report())]);
      const run = h.session.prompt("go");
      await entered.promise;
      await vi.waitFor(() => attachedNow(h));
      if (order === "steer first") {
        await h.session.prompt(steerText, { streamingBehavior: "steer" });
        await h.session.prompt(followText, { streamingBehavior: "followUp" });
      } else {
        await h.session.prompt(followText, { streamingBehavior: "followUp" });
        await h.session.prompt(steerText, { streamingBehavior: "steer" });
      }
      await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
      expect(toolResults(h, "orche_task")[0]).toMatchObject({ details: { attach: "detached", reason: "input" } });
      await vi.waitFor(() => attachedNow(h));
      await stillAttached(h, [followText]);
      gate.resolve();
      await run;
      expect(toolResults(h, "orche_task_attach")).toMatchObject([{ details: { attach: "ended" } }]);
      expect(transcript(h)).toEqual([
        "user:go", "assistant:[orche_task]", "tool:orche_task:detached", `user:${steerText}`, "assistant:[orche_task_attach]",
        "tool:orche_task_attach:ended", "assistant:Reviewed J1.", `user:${followText}`, "assistant:Follow-up answered.",
      ]);
      expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    });
  }

  it("a steer another extension transforms still counts as answered once delivered: the re-attach with a follow-up still queued waits", async () => {
    const entered = deferred(), gate = deferred();
    const transformer: ExtensionFactory = pi => {
      pi.on("input", event => event.streamingBehavior === "steer" ? { action: "transform", text: `[expanded] ${event.text}` } : undefined);
    };
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      tool("orche_task_attach", { job: "J1" }),
      reply("Reviewed J1."),
      reply("Follow-up answered."),
    ], [gated(entered, gate, report())], { extraExtensions: [transformer] });
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("afterwards, summarise", { streamingBehavior: "followUp" });
    await h.session.prompt("quick question", { streamingBehavior: "steer" });
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
    await vi.waitFor(() => attachedNow(h));
    await stillAttached(h, ["afterwards, summarise"]);
    gate.resolve();
    await run;
    expect(transcript(h)).toEqual([
      "user:go", "assistant:[orche_task]", "tool:orche_task:detached", "user:[expanded] quick question", "assistant:[orche_task_attach]",
      "tool:orche_task_attach:ended", "assistant:Reviewed J1.", "user:afterwards, summarise", "assistant:Follow-up answered.",
    ]);
  });

  it("only a follow-up queued: orche_task_attach on a detached (wait:false) job attaches instead of returning at once", async () => {
    const entered = deferred(), gate = deferred(), queuedUp = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      async () => { await queuedUp.promise; return tool("orche_task_attach", {}); },
      reply("Reviewed J1."),
      reply("Follow-up answered."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
    await h.session.prompt("afterwards, summarise", { streamingBehavior: "followUp" });
    queuedUp.resolve();
    await vi.waitFor(() => attachedNow(h));
    await stillAttached(h, ["afterwards, summarise"]);
    expect(toolResults(h, "orche_task_attach")).toHaveLength(0);
    gate.resolve();
    await run;
    expect(toolResults(h, "orche_task_attach")).toMatchObject([{ details: { attach: "ended" } }]);
    expect(transcript(h).slice(-3)).toEqual(["assistant:Reviewed J1.", "user:afterwards, summarise", "assistant:Follow-up answered."]);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
  });

  it("the worker's result and a follow-up in the same moment: the result reaches the attached call exactly once, the follow-up comes after it", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("Reviewed J1."),
      reply("Follow-up answered."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    gate.resolve();
    await h.session.prompt("afterwards, summarise", { streamingBehavior: "followUp" });
    await run;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(toolResults(h, "orche_task")).toMatchObject([{ details: { attach: "ended" } }]);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(jobEntries(h).filter(entry => entry.event === "end")).toHaveLength(1);
    expect(transcript(h).slice(-4)).toEqual(["tool:orche_task:ended", "assistant:Reviewed J1.", "user:afterwards, summarise", "assistant:Follow-up answered."]);
  });

  it("Esc (abort) detaches without cancelling: the job finishes and its result comes as a message", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("Reviewed J1 after Esc."),
    ], [gated(entered, gate, report())]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.abort();
    await run;
    await vi.waitFor(() => expect(widget(h)).toMatch(/^◌ orche J1 · W1 implement · running/));
    const result = toolResults(h, "orche_task")[0];
    expect(result).toMatchObject({ details: { attach: "detached", reason: "abort" } });
    expect(jobEntries(h).map(entry => entry.event)).toEqual(["start"]);
    gate.resolve();
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Reviewed J1 after Esc."), { timeout: 5000 });
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1);
    expect(jobEntries(h).filter(entry => entry.event === "end")).toMatchObject([{ status: "done" }]);
  });

  it("/orche cancel while attached returns the cancelled result to the call; /orche detach detaches and a later cancel comes as one message", async () => {
    const entered = deferred();
    const h = await harness([tool("orche_task", { role: "implement", request }), reply("Cancelled as asked.")], [untilAborted(entered)]);
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("/orche cancel");
    await run;
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ isError: true, details: { job: "J1", attach: "ended" } });
    expect(textOf(toolResults(h, "orche_task")[0])).toMatch(/cancel/i);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(jobEntries(h).filter(entry => entry.event === "end")).toMatchObject([{ status: "cancelled" }]);
    expect(widget(h)).toMatch(/^⊘ orche J1 · W1 implement · cancelled after/);

    const entered2 = deferred();
    const h2 = await harness([tool("orche_task", { role: "implement", request }), reply("J1 runs in the background."), reply("Noted the cancellation.")], [untilAborted(entered2)]);
    const run2 = h2.session.prompt("go");
    await entered2.promise;
    await vi.waitFor(() => attachedNow(h2));
    await h2.session.prompt("/orche detach");
    await run2;
    expect(toolResults(h2, "orche_task")[0]).toMatchObject({ details: { attach: "detached", reason: "command" } });
    expect(textOf(toolResults(h2, "orche_task")[0])).toContain("Do not attach again on your own");
    expect(h2.notifications.some(note => note.message.startsWith("orche J1 detached: it keeps running"))).toBe(true);
    await h2.session.prompt("/orche detach");
    expect(h2.notifications.at(-1)!.message).toBe("orche J1 is already detached; its result arrives as a message");
    await h2.session.prompt("/orche cancel");
    await vi.waitFor(() => expect(customMessages(h2, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(customMessages(h2, TASK_RESULT_TYPE)[0]!.content).toContain("· cancelled after");
    await vi.waitFor(() => expect(h2.session.getLastAssistantText()).toBe("Noted the cancellation."));
  });

  it("a session shutdown while attached returns the call, ends the job as interrupted and sends no message", async () => {
    const entered = deferred();
    const h = await harness([tool("orche_task", { role: "implement", request })], [untilAborted(entered)], { records: true });
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" } as never);
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(1));
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ details: { attach: "detached", reason: "shutdown" } });
    expect(jobEntries(h).filter(entry => entry.event === "end")).toMatchObject([{ job: "J1", status: "interrupted" }]);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(widget(h)).toBe("");
    await h.session.abort();
    await run.catch(() => undefined);
  });
});

describe("background orche_task jobs (wait:false)", () => {
  it("wait:false returns the job id at once, keeps main free, and delivers the result once as a message that starts main's next turn", async () => {
    const entered = deferred(), gate = deferred();
    let sawResult = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started J1; I will report when it is done."),
      context => { sawResult = textOf(context.messages.at(-1)); return reply("Reviewed J1: greeting checked."); },
    ], [gated(entered, gate, report())]);
    await h.session.prompt("check the greeting");
    await entered.promise;
    const started = toolResults(h, "orche_task");
    expect(started).toHaveLength(1);
    expect(textOf(started[0])).toContain("Started job J1: worker W1 implement");
    expect(textOf(started[0])).toContain("started with wait:false");
    expect(started[0]).toMatchObject({ isError: false, details: { job: "J1", worker: "W1", status: "running", async: true, attach: "detached", reason: "background" } });
    expect(h.session.getLastAssistantText()).toContain("Started J1");
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(widget(h)).toMatch(/^◌ orche J1/);
    gate.resolve();
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toContain("Reviewed J1"), { timeout: 5000 });
    const results = customMessages(h, TASK_RESULT_TYPE);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("Done: greeting checked");
    expect(sawResult).toContain("orche task result · J1");
    expect(jobEntries(h).map(entry => `${entry.event}:${"status" in entry ? entry.status : ""}`)).toEqual(["start:", "end:done"]);
  });

  it("injects a message into the running worker before its next request and reports it delivered", async () => {
    const entered = deferred(), gate = deferred();
    let workerSaw = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task_message", { message: "Also keep the trailing newline." }),
      reply("Sent to the worker."),
      reply("Reviewed."),
    ], [
      gated(entered, gate, tool("read", { path: "greeting.txt" })),
      context => { workerSaw = textOf(context.messages); return report(); },
    ]);
    await h.session.prompt("check the greeting");
    await entered.promise;
    await h.session.prompt("tell the worker to keep the newline");
    const sent = toolResults(h, "orche_task_message");
    expect(sent[0]).toMatchObject({ isError: false, details: { job: "J1", status: "queued", id: "M1" } });
    expect(textOf(sent[0])).toContain("before its next model request");
    gate.resolve();
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(workerSaw).toContain("Message from main while you work on this assignment · M1");
    expect(workerSaw).toContain("Also keep the trailing newline.");
    const result = customMessages(h, TASK_RESULT_TYPE)[0]!;
    expect(result.content).toContain("Messages from main: M1 delivered");
    expect((result.details.task as { injected: unknown[] }).injected).toMatchObject([{ id: "M1", status: "delivered" }]);
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Reviewed."));
  });

  it("a message queued while the worker is already reporting is withdrawn and reported undelivered, never carried over", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task_message", { message: "Late detail." }),
      reply("Sent."),
      reply("Reviewed; M1 must be resent."),
    ], [gated(entered, gate, report())]);
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("add a detail");
    gate.resolve();
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    const result = customMessages(h, TASK_RESULT_TYPE)[0]!;
    expect(result.content).toContain("Messages from main: M1 undelivered");
    expect(result.content).toContain("resend as a follow-up orche_task");
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toContain("resent"));
  });

  it("rejects a second task and messages without a running job; cancel delivers one cancelled result", async () => {
    const entered = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task", { role: "implement", request }),
      tool("orche_task_status", {}),
      tool("orche_task_status", { cancel: true }),
      reply("Cancelled."),
      reply("Noted the cancellation."),
      tool("orche_task_message", { message: "anything" }),
      tool("orche_task_message", { job: "J1", message: "anything" }),
      reply("Nothing is running."),
    ], [untilAborted(entered)]);
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("start another and then cancel");
    const second = toolResults(h, "orche_task")[1]!;
    expect(second).toMatchObject({ isError: true });
    expect(textOf(second)).toContain("Job J1 (W1, implement) is still running; one task runs at a time");
    expect(textOf(second)).toContain("orche_task_attach");
    expect(textOf(toolResults(h, "orche_task_status")[0])).toContain("J1 running");
    expect(textOf(toolResults(h, "orche_task_status")[0])).toContain("Detached: its result arrives as an orche-task-result message");
    expect(textOf(toolResults(h, "orche_task_status")[1])).toContain("J1 cancelled");
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(customMessages(h, TASK_RESULT_TYPE)[0]!.content).toContain("· cancelled after");
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Noted the cancellation."));
    await h.session.prompt("message the worker");
    expect(toolResults(h, "orche_task_message")[0]).toMatchObject({ isError: true });
    expect(textOf(toolResults(h, "orche_task_message")[0])).toContain("No running job");
    expect(textOf(toolResults(h, "orche_task_message")[1])).toContain("J1 is cancelled");
    expect(jobEntries(h).filter(entry => entry.event === "end")).toHaveLength(1);
  });

  it("errors before the worker ran still fail the tool call itself, and print mode keeps the blocking call", async () => {
    const h = await harness([tool("orche_task", { role: "explore", request: "x", worker: "W9" }), reply("ok")], []);
    await h.session.prompt("go");
    expect(toolResults(h, "orche_task")[0]).toMatchObject({ isError: true });
    expect(textOf(toolResults(h, "orche_task")[0])).toContain("Unknown worker W9");
    expect(jobEntries(h)).toEqual([]);
    const print = await createHarness({ mainSteps: [tool("orche_task", { role: "implement", request }), reply("reviewed")], orcheSteps: [report()], mode: "print", mainMode: "single", single: { spawn: false } });
    open.push(print);
    await print.session.prompt("go");
    expect(textOf(toolResults(print, "orche_task")[0])).toContain("Done: greeting checked");
    expect(customMessages(print, TASK_RESULT_TYPE)).toHaveLength(0);
  });

  it("wait:true and JSON mode block without a job (no widget, no message)", async () => {
    for (const [mode, args] of [["tui", { wait: true }], ["json", {}]] as const) {
      const blocking = await createHarness({ mainSteps: [tool("orche_task", { role: "implement", request, ...args }), reply("reviewed")], orcheSteps: [report()], mode, mainMode: "single", single: { spawn: false } });
      open.push(blocking);
      await blocking.session.prompt("go");
      expect(textOf(toolResults(blocking, "orche_task")[0])).toContain("Done: greeting checked");
      expect(toolResults(blocking, "orche_task")[0]).not.toMatchObject({ details: { attach: expect.anything() } });
      expect(customMessages(blocking, TASK_RESULT_TYPE)).toHaveLength(0);
      expect(widget(blocking)).toBe("");
    }
  });

  it("a session shutdown while a detached job runs ends it as interrupted in the session and the run record, without a message", async () => {
    const entered = deferred();
    const h = await harness([tool("orche_task", { role: "implement", request, wait: false }), reply("Started.")], [untilAborted(entered)], { records: true });
    await h.session.prompt("go");
    await entered.promise;
    const record = (toolResults(h, "orche_task")[0] as unknown as { details: { record: string } }).details.record;
    expect(JSON.parse(await readFile(join(record, "run.json"), "utf8"))).toMatchObject({ status: "running", owner: { pid: process.pid } });
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" } as never);
    expect(JSON.parse(await readFile(join(record, "run.json"), "utf8"))).toMatchObject({ status: "interrupted" });
    expect(jobEntries(h).filter(entry => entry.event === "end")).toMatchObject([{ job: "J1", status: "interrupted" }]);
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
  });
});
