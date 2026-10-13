import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";
import { JOB_ENTRY_TYPE, TASK_RESULT_TYPE, type JobEntry } from "../../src/extension/jobs.js";
import { APPROVE_QUEUED, CONFIRM_CANCEL, CONFIRM_MESSAGE, DECLINE_CANCEL, DECLINE_MESSAGE, DECLINE_QUEUED, MESSAGE_CONFIRM_MAX, QUEUE_MESSAGE_TYPE } from "../../src/extension/index.js";
import { BUSY_READ_TOOLS, guardBusyToolCall } from "../../src/extension/mode.js";

/**
 * Main while a background orche_task job runs (src/extension/index.ts, jobs.ts queue, mode.ts guardBusyToolCall), in a real TUI-mode
 * session: a steered question is answered by reading only (other tools are blocked until the job ends), and a new delegation needs
 * the user's approval in Pi's own dialog (`ctx.ui.select`); approved, it waits for the running job and starts only after it ended done.
 */
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});

const report = (summary = "Done: greeting checked") => tool("report_result", { kind: "implement", summary, data: { status: "done", evidence: ["greeting.txt"], checklist: [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }] } });
const request = "R1: check greeting.txt\nOriginal request: check it";
const second = "R1: check greeting.txt once more\nOriginal request: check it again";
const gated = (entered: { resolve(): void }, gate: { promise: Promise<void> }, step: FauxResponseStep): FauxResponseStep => async (...args) => {
  entered.resolve();
  await gate.promise;
  return typeof step === "function" ? step(...args) : step;
};
const untilAborted = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted", { stopReason: "aborted" });
};
const customMessages = (h: Harness, type: string) => h.session.messages.filter(message => message.role === "custom" && (message as { customType?: string }).customType === type) as unknown as { content: string; details: Record<string, unknown> }[];
const toolResults = (h: Harness, name: string) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === name) as unknown as { isError?: boolean; details?: Record<string, unknown> }[];
const textOf = (message: unknown) => JSON.stringify(message);
const jobEntries = (h: Harness) => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === JOB_ENTRY_TYPE).map(entry => (entry as { data: JobEntry }).data);
const events = (h: Harness) => jobEntries(h).map(entry => `${entry.event}:${entry.job}${"status" in entry ? `:${entry.status}` : ""}${"outcome" in entry ? `:${entry.outcome}` : ""}`);
const widget = (h: Harness) => h.widgets.filter(entry => entry.key === "orche-job").at(-1)?.lines?.join("\n") ?? "";
const attachedNow = (h: Harness) => expect(widget(h)).toContain("attached: waiting for the result");
const approve = (titles: string[]): Partial<ExtensionUIContext> => ({ select: async (title: string, options: string[]) => { titles.push(title); return options[0]; } });

async function harness(mainSteps: FauxResponseStep[], orcheSteps: FauxResponseStep[], extra: { ui?: Partial<ExtensionUIContext>; extraExtensions?: ExtensionFactory[]; noUi?: boolean } = {}) {
  const h = await createHarness({ mainSteps, orcheSteps, mode: "tui", mainMode: "single", single: { spawn: false }, ...extra });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  return h;
}

describe("the read-only window (guardBusyToolCall)", () => {
  it("allows reading, the orche tools and tools declared read-only that reach no other tools; blocks everything else", () => {
    for (const name of [...BUSY_READ_TOOLS, "orche_task", "orche_task_attach", "orche_task_status", "orche_task_message"]) expect(guardBusyToolCall(name, "J1")).toBeUndefined();
    expect(guardBusyToolCall("mcp__docs__search", "J1", { annotations: { readOnlyHint: true } })).toBeUndefined();
    for (const [name, info] of [
      ["bash", undefined], ["powershell", undefined], ["edit", undefined], ["write", undefined], ["ast_rewrite", undefined], ["diagnostics", undefined],
      ["browser_click", undefined], ["generate_image", { annotations: { readOnlyHint: false } }], ["mcp__x__delete", { annotations: { readOnlyHint: true, destructiveHint: true } }],
      ["codemode", { annotations: { readOnlyHint: true }, reachesTools: () => "all" as const }],
    ] as const) {
      const reason = guardBusyToolCall(name, "J1", info as never);
      expect(reason, name).toContain("Blocked while orche J1 runs (read-only window)");
      expect(reason).toContain("What you read may be its unfinished state");
    }
  });
});

describe("main while a background job runs", () => {
  it("answers a steered question by reading; shell and tools without a read-only declaration are blocked; the worker keeps running; the window ends with the job", async () => {
    const entered = deferred(), gate = deferred();
    const extraTools: ExtensionFactory = pi => {
      pi.registerTool({ name: "peek", label: "peek", description: "declared read-only", parameters: Type.Object({}), annotations: { readOnlyHint: true }, execute: async () => ({ content: [{ type: "text", text: "peeked" }], details: {} }) });
      pi.registerTool({ name: "poke", label: "poke", description: "no hints", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "poked" }], details: {} }) });
    };
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      tool("read", { path: "greeting.txt" }),
      tool("bash", { command: "cat greeting.txt" }),
      tool("peek", {}),
      tool("poke", {}),
      tool("orche_task_attach", { job: "J1" }),
      reply("Reviewed J1."),
      tool("bash", { command: "cat greeting.txt" }),
      reply("hello world"),
    ], [gated(entered, gate, report())], { extraExtensions: [extraTools] });
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("what is in greeting.txt?", { streamingBehavior: "steer" });
    await vi.waitFor(() => expect(toolResults(h, "poke")).toHaveLength(1));
    await vi.waitFor(() => attachedNow(h));
    expect(textOf(toolResults(h, "read")[0])).toContain("hello world");
    expect(toolResults(h, "read")[0]!.isError).toBeFalsy();
    expect(toolResults(h, "bash")[0]).toMatchObject({ isError: true });
    expect(textOf(toolResults(h, "bash")[0])).toContain("Blocked while orche J1 runs (read-only window)");
    expect(textOf(toolResults(h, "peek")[0])).toContain("peeked");
    expect(textOf(toolResults(h, "poke")[0])).toContain("Blocked while orche J1 runs");
    expect(textOf(toolResults(h, "poke")[0])).not.toContain("poked");
    // The worker never stopped and nothing else was started.
    expect(events(h)).toEqual(["start:J1"]);
    gate.resolve();
    await run;
    expect(textOf(toolResults(h, "orche_task_attach")[0])).toContain("Done: greeting checked");
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    // The job ended: the session's own mode rules again (single: static shell inspection is allowed).
    await h.session.prompt("show it");
    expect(toolResults(h, "bash")[1]!.isError).toBeFalsy();
    expect(textOf(toolResults(h, "bash")[1])).toContain("hello world");
    expect(events(h)).toEqual(["start:J1", "end:J1:done"]);
  });

  it("approved in the dialog, a new request waits for the running job and starts as its own job after it ended done; each result arrives once", async () => {
    const entered = deferred(), gate = deferred();
    const titles: string[] = [];
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      tool("orche_task", { role: "implement", request: second, files: ["greeting.txt"] }),
      tool("orche_task_attach", { job: "J1" }),
      reply("Reviewed J1; Q1 starts now."),
      reply("Reviewed J2."),
    ], [gated(entered, gate, report()), report("Done: second check")], { ui: approve(titles) });
    const run = h.session.prompt("go");
    await entered.promise;
    await vi.waitFor(() => attachedNow(h));
    await h.session.prompt("also check it once more", { streamingBehavior: "steer" });
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(2));
    // The dialog says what runs, that it keeps running, what exactly is requested and what approving means.
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("Running now: J1 · W1 implement · R1: check greeting.txt");
    expect(titles[0]).toContain("It keeps running: approving does not cancel, pause or replace it.");
    expect(titles[0]).toContain("Requested (Q1): role implement · new worker · files: greeting.txt");
    expect(titles[0]).toContain("R1: check greeting.txt once more");
    expect(titles[0]).toContain("starts as its own background job only after J1 has finished successfully (done). It never runs at the same time as J1.");
    const queued = toolResults(h, "orche_task")[1]!;
    expect(queued).toMatchObject({ details: { approval: "approved", queued: "Q1", after: "J1" } });
    expect(queued.isError).toBeFalsy();
    expect(textOf(queued)).toContain("Queued Q1 with the user's approval");
    await vi.waitFor(() => attachedNow(h));
    expect(widget(h)).toContain("⧗ orche Q1 · implement · approved: starts after J1 has finished (done)");
    expect(events(h)).toEqual(["start:J1", "queue:Q1"]);
    gate.resolve();
    await run;
    const attached = toolResults(h, "orche_task_attach")[0]!;
    expect(textOf(attached)).toContain("Done: greeting checked");
    expect(textOf(attached)).toContain("Q1 (implement: R1: check greeting.txt once more), starts now as its own background job");
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    const result = customMessages(h, TASK_RESULT_TYPE)[0]!;
    expect(result.details).toMatchObject({ job: "J2", status: "done" });
    expect(result.content).toContain("Done: second check");
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Reviewed J2."));
    expect(events(h)).toEqual(["start:J1", "queue:Q1", "end:J1:done", "start:J2", "queue-end:Q1:started", "end:J2:done"]);
    expect(h.notifications.some(note => note.message.includes("Q1, the task you approved, started as J2"))).toBe(true);
    expect(customMessages(h, QUEUE_MESSAGE_TYPE)).toHaveLength(0);
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("wait:true is gated too; a queued task is dropped, never started, when the job it waits for is cancelled; the result says so once", async () => {
    const entered = deferred();
    const titles: string[] = [];
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started J1."),
      tool("orche_task", { role: "implement", request: second, wait: true }),
      reply("Queued."),
      tool("orche_task", { role: "implement", request: "R1: a third\nOriginal request: third" }),
      reply("Only one waits."),
      reply("J1 was cancelled; Q1 did not start."),
    ], [untilAborted(entered)], { ui: approve(titles) });
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("and this one, blocking");
    expect(titles).toHaveLength(1);
    expect(toolResults(h, "orche_task")[1]).toMatchObject({ details: { approval: "approved", queued: "Q1" } });
    // At most one approved task waits: a further request is refused without asking.
    await h.session.prompt("and a third");
    expect(titles).toHaveLength(1);
    expect(toolResults(h, "orche_task")[2]).toMatchObject({ details: { approval: "not-approved", reason: "slot-taken", queued: "Q1" } });
    await h.session.prompt("/orche cancel");
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    const result = customMessages(h, TASK_RESULT_TYPE)[0]!;
    expect(result.details).toMatchObject({ job: "J1", status: "cancelled" });
    expect(result.content).toContain("Q1 (implement: R1: check greeting.txt once more), is dropped and will not start: J1 ended cancelled");
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("J1 was cancelled; Q1 did not start."));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events(h)).toEqual(["start:J1", "queue:Q1", "end:J1:cancelled", "queue-end:Q1:dropped"]);
    expect(h.notifications.some(note => note.message.includes("Q1, the task you approved") && note.message.includes("was dropped and did not start"))).toBe(true);
    expect(customMessages(h, QUEUE_MESSAGE_TYPE)).toHaveLength(0);
  });

  it("no answer, a failing dialog and no UI delegate nothing; the slot is free again afterwards", async () => {
    const entered = deferred();
    const answers: (() => Promise<string | undefined>)[] = [async () => undefined, async () => { throw new Error("client went away"); }, async () => DECLINE_QUEUED];
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task", { role: "implement", request: second }),
      reply("Not answered."),
      tool("orche_task", { role: "implement", request: second }),
      reply("Dialog failed."),
      tool("orche_task", { role: "implement", request: second }),
      reply("Declined."),
      tool("orche_task_status", {}),
      reply("Status."),
    ], [untilAborted(entered)], { ui: { select: async () => answers.shift()!() } });
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("another");
    await h.session.prompt("another");
    await h.session.prompt("another");
    const results = toolResults(h, "orche_task").slice(1);
    expect(results.map(result => result.details?.reason)).toEqual(["no-answer", "dialog-error", "declined"]);
    expect(results[0]!.isError).toBeFalsy();
    expect(results[1]).toMatchObject({ isError: true });
    expect(textOf(results[1])).toContain("the approval dialog failed (client went away)");
    await h.session.prompt("status?");
    expect(textOf(toolResults(h, "orche_task_status")[0])).not.toContain("Queued:");
    expect(events(h)).toEqual(["start:J1"]);
    await h.session.prompt("/orche cancel");

    const noUi = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task", { role: "implement", request: second }),
      reply("No UI."),
    ], [untilAborted(deferred())], { noUi: true });
    await noUi.session.prompt("go");
    await vi.waitFor(() => expect(events(noUi)).toEqual(["start:J1"]));
    await noUi.session.prompt("another");
    expect(toolResults(noUi, "orche_task")[1]).toMatchObject({ details: { approval: "not-approved", reason: "no-ui", job: "J1" } });
    expect(events(noUi)).toEqual(["start:J1"]);
    await noUi.session.prompt("/orche cancel");
  });

  it("approved after the job ended done while the dialog was open: the request starts now in that call", async () => {
    const entered = deferred(), gate = deferred(), asked = deferred(), answer = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task", { role: "implement", request: second }),
      reply("Reviewed J1 and J2."),
      reply("Reviewed J1 from the message."),
    ], [gated(entered, gate, report()), report("Done: second check")], { ui: { select: async (_title: string, options: string[]) => { asked.resolve(); await answer.promise; return options[0]; } } });
    await h.session.prompt("go");
    await entered.promise;
    const run = h.session.prompt("another");
    await asked.promise;
    gate.resolve();
    await vi.waitFor(() => expect(events(h)).toEqual(["start:J1", "end:J1:done"]));
    answer.resolve();
    await run;
    const started = toolResults(h, "orche_task")[1]!;
    expect(started).toMatchObject({ details: { job: "J2", attach: "ended" } });
    expect(textOf(started)).toContain("Done: second check");
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(customMessages(h, TASK_RESULT_TYPE)[0]!.details).toMatchObject({ job: "J1" });
    expect(events(h)).toEqual(["start:J1", "end:J1:done", "start:J2", "end:J2:done"]);
  });

  it("Esc while the user is asked approves nothing, even when the user picks approve afterwards", async () => {
    const entered = deferred(), asked = deferred(), pick = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task", { role: "implement", request: second }),
      tool("orche_task_status", {}),
      reply("Status."),
    ], [untilAborted(entered)], { ui: { select: async (_title: string, options: string[]) => { asked.resolve(); await pick.promise; return options[0]; } } });
    await h.session.prompt("go");
    await entered.promise;
    const run = h.session.prompt("another");
    await asked.promise;
    // Pi aborts the turn's signal at once and waits for the running tool call; the user picks approve only afterwards.
    const aborting = h.session.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    pick.resolve();
    await aborting;
    await run.catch(() => undefined);
    await vi.waitFor(() => expect(toolResults(h, "orche_task")).toHaveLength(2));
    expect(toolResults(h, "orche_task")[1]).toMatchObject({ details: { approval: "not-approved", reason: "aborted" } });
    expect(events(h)).toEqual(["start:J1"]);
    await h.session.prompt("status?");
    expect(textOf(toolResults(h, "orche_task_status")[0])).not.toContain("Queued:");
    await h.session.prompt("/orche cancel");
  });

  it("a queued task does not start once delegation was switched off (direct mode): main is told once; direct mode keeps its shell meanwhile", async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task", { role: "implement", request: second }),
      reply("Queued."),
      tool("bash", { command: "cat greeting.txt" }),
      reply("direct read it"),
      reply("Reviewed J1."),
      reply("Told the user Q1 did not start."),
    ], [gated(entered, gate, report())], { ui: approve([]) });
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("another");
    expect(toolResults(h, "orche_task")[1]).toMatchObject({ details: { approval: "approved", queued: "Q1" } });
    await h.session.prompt("/orche mode direct");
    // Direct mode is the user's choice to work directly: the read-only window does not apply there.
    await h.session.prompt("show the file");
    expect(toolResults(h, "bash")[0]!.isError).toBeFalsy();
    expect(textOf(toolResults(h, "bash")[0])).toContain("hello world");
    gate.resolve();
    await vi.waitFor(() => expect(customMessages(h, QUEUE_MESSAGE_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(customMessages(h, QUEUE_MESSAGE_TYPE)[0]!.content).toContain("did not start: delegation is off now (orche mode direct)");
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("Told the user Q1 did not start."));
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1);
    expect(events(h)).toEqual(["start:J1", "queue:Q1", "end:J1:done", "queue-end:Q1:dropped"]);
  });

  it("a queued task the previous session left behind is dropped at the next session start and announced once", async () => {
    const h = await harness([reply("noted")], []);
    const at = Date.now() - 60_000;
    for (const entry of [
      { event: "start", job: "J1", role: "implement", worker: "W1", at, request: "first" },
      { event: "queue", job: "Q1", after: "J1", role: "implement", at, request: "second" },
      { event: "end", job: "J1", worker: "W1", at, status: "interrupted", summary: "interrupted: the pi session shut down while the worker was running" },
    ] satisfies JobEntry[]) h.session.sessionManager.appendCustomEntry(JOB_ENTRY_TYPE, entry);
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" } as never);
    const notice = h.notifications.filter(note => note.message.includes("Q1 (implement: second; it was to start after J1)"));
    expect(notice).toHaveLength(1);
    expect(events(h).at(-1)).toBe("queue-end:Q1:dropped");
    // Main hears it with its next run, once.
    await h.session.prompt("hi");
    expect(textOf(h.session.messages)).toContain("did not start before the previous pi session ended");
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" } as never);
    expect(h.notifications.filter(note => note.message.includes("Q1 (implement: second"))).toHaveLength(1);
    expect(events(h).filter(entry => entry === "queue-end:Q1:dropped")).toHaveLength(1);
  });

  it("RPC sessions get the same dialog through Pi's extension UI (title, options, timeout); a dialog that times out approves nothing", async () => {
    const entered = deferred();
    const seen: { title: string; options: string[]; timeout?: number; signal: boolean }[] = [];
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "implement", request, wait: false }), reply("Started."), tool("orche_task", { role: "implement", request: second }), reply("Timed out.")],
      orcheSteps: [untilAborted(entered)], mode: "rpc", mainMode: "single", single: { spawn: false }, extension: { approvalTimeoutMs: 50 },
      // As Pi's RPC mode answers a dialog nobody answered: undefined once its timeout has passed.
      ui: { select: (title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }) => { seen.push({ title, options, ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}), signal: !!opts?.signal }); return new Promise(resolve => setTimeout(() => resolve(undefined), opts?.timeout)); } },
    });
    open.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("another");
    expect(seen).toMatchObject([{ options: [APPROVE_QUEUED, DECLINE_QUEUED], timeout: 50, signal: true }]);
    expect(seen[0]!.title).toContain("no answer within");
    expect(toolResults(h, "orche_task")[1]).toMatchObject({ details: { approval: "not-approved", reason: "no-answer" } });
    expect(events(h)).toEqual(["start:J1"]);
    await h.session.prompt("/orche cancel");
  });

  it("orche_task_message reaches the running worker only after the user confirmed the full message in a dialog; declined, unanswered, failing or too long, nothing reaches it", async () => {
    const entered = deferred(), gate = deferred();
    let workerSaw = "";
    const titles: string[] = [];
    const answers: ((options: string[]) => Promise<string | undefined>)[] = [
      async options => options[1],
      async () => undefined,
      async () => { throw new Error("client went away"); },
      async options => options[0],
    ];
    const long = `Also do this: ${"x".repeat(MESSAGE_CONFIRM_MAX)}`;
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task_message", { message: "NEW TASK: also rewrite the README" }),
      reply("Declined."),
      tool("orche_task_message", { message: "NEW TASK: also rewrite the README" }),
      reply("No answer."),
      tool("orche_task_message", { message: "NEW TASK: also rewrite the README" }),
      reply("Dialog failed."),
      tool("orche_task_message", { message: long }),
      reply("Too long."),
      tool("orche_task_message", { message: "Keep the trailing newline." }),
      reply("Sent."),
      reply("Reviewed."),
    ], [
      gated(entered, gate, tool("read", { path: "greeting.txt" })),
      context => { workerSaw = textOf(context.messages); return report(); },
    ], { ui: { select: async (title: string, options: string[]) => { titles.push(title); return answers.shift()!(options); } } });
    await h.session.prompt("go");
    await entered.promise;
    for (let i = 0; i < 5; i++) await h.session.prompt(`message ${i}`);
    const results = toolResults(h, "orche_task_message");
    expect(results.map(result => result.details?.reason ?? result.details?.status)).toEqual(["declined", "no-answer", "dialog-error", "too-long", "queued"]);
    expect(textOf(results[0])).toContain("Not sent: the user declined. J1 keeps running with its task unchanged. If this is a new task, delegate it with orche_task");
    expect(results[2]).toMatchObject({ isError: true });
    expect(textOf(results[3])).toContain(`more than the ${MESSAGE_CONFIRM_MAX} the user can confirm in full`);
    // Four dialogs (not for the too-long one); each shows the full message and what sending does not mean.
    expect(titles).toHaveLength(4);
    expect(titles[0]).toContain("orche: send this to the worker of J1?");
    expect(titles[0]).toContain("Message, in full (it is added to that worker's CURRENT task, mid-run):\nNEW TASK: also rewrite the README\n");
    expect(titles[0]).toContain("Sending does not approve a new task");
    expect(titles[3]).toContain("Keep the trailing newline.");
    gate.resolve();
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    // Only the confirmed message reached the worker, once.
    expect(workerSaw).not.toContain("NEW TASK");
    expect(workerSaw).not.toContain("xxxxxxxxxx");
    expect(workerSaw.split("Keep the trailing newline.").length - 1).toBe(1);
    const result = customMessages(h, TASK_RESULT_TYPE)[0]!;
    expect(result.content).toContain("Messages from main: M1 delivered");
    expect((result.details.task as { injected: unknown[] }).injected).toHaveLength(1);
    expect(events(h)).toEqual(["start:J1", "end:J1:done"]);
  });

  it("without a UI, or interrupted with Esc while asked, nothing is sent or cancelled", async () => {
    const noUi = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task_message", { message: "NEW TASK" }),
      tool("orche_task_status", { cancel: true }),
      reply("No UI."),
    ], [untilAborted(deferred())], { noUi: true });
    await noUi.session.prompt("go");
    await vi.waitFor(() => expect(events(noUi)).toEqual(["start:J1"]));
    await noUi.session.prompt("message and cancel");
    expect(toolResults(noUi, "orche_task_message")[0]).toMatchObject({ details: { approval: "not-approved", reason: "no-ui", control: "message" } });
    expect(toolResults(noUi, "orche_task_status")[0]).toMatchObject({ details: { approval: "not-approved", reason: "no-ui", control: "cancel" } });
    expect(events(noUi)).toEqual(["start:J1"]);
    await noUi.session.prompt("/orche cancel");
    await vi.waitFor(() => expect(events(noUi)).toEqual(["start:J1", "end:J1:cancelled"]));

    const entered = deferred(), asked = deferred(), pick = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task_message", { message: "NEW TASK" }),
    ], [untilAborted(entered)], { ui: { select: async (_title: string, options: string[]) => { asked.resolve(); await pick.promise; return options[0]; } } });
    await h.session.prompt("go");
    await entered.promise;
    const run = h.session.prompt("message it");
    await asked.promise;
    const aborting = h.session.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    pick.resolve();
    await aborting;
    await run.catch(() => undefined);
    await vi.waitFor(() => expect(toolResults(h, "orche_task_message")).toHaveLength(1));
    expect(toolResults(h, "orche_task_message")[0]).toMatchObject({ details: { approval: "not-approved", reason: "aborted" } });
    expect(events(h)).toEqual(["start:J1"]);
    await h.session.prompt("/orche cancel");
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(customMessages(h, TASK_RESULT_TYPE)[0]!.content).not.toContain("Messages from main");
  });

  for (const kind of ["message", "cancel"] as const) {
    it(`a ${kind} confirmed for J1 after J1 ended and the approved Q1 started as J2 reaches nothing: J2 is neither messaged nor cancelled`, async () => {
      const entered = deferred(), gate = deferred(), asked = deferred(), pick = deferred(), j2 = deferred();
      const control = kind === "message" ? tool("orche_task_message", { message: "Keep the trailing newline." }) : tool("orche_task_status", { cancel: true });
      const h = await harness([
        tool("orche_task", { role: "implement", request, wait: false }),
        reply("Started."),
        tool("orche_task", { role: "implement", request: second }),
        reply("Queued."),
        control,
        reply("Refused."),
        reply("Reviewed J1."),
        reply("J2 cancelled by the user."),
      ], [gated(entered, gate, report()), untilAborted(j2)], {
        ui: {
          select: async (title: string, options: string[]) => {
            if (title.startsWith("orche: approve one more")) return options[0];
            asked.resolve();
            await pick.promise;
            return options[0];
          },
        },
      });
      await h.session.prompt("go");
      await entered.promise;
      await h.session.prompt("another");
      const run = h.session.prompt("now control it");
      await asked.promise;
      gate.resolve();
      await j2.promise;
      expect(events(h)).toEqual(["start:J1", "queue:Q1", "end:J1:done", "start:J2", "queue-end:Q1:started"]);
      pick.resolve();
      await run;
      const refused = toolResults(h, kind === "message" ? "orche_task_message" : "orche_task_status")[0]!;
      expect(refused).toMatchObject({ details: { approval: "not-approved", reason: "job-ended", job: "J1", control: kind } });
      expect(textOf(refused)).toContain("this confirmation is not reused for another job");
      // J2 keeps running untouched until the user stops it.
      expect(events(h)).toEqual(["start:J1", "queue:Q1", "end:J1:done", "start:J2", "queue-end:Q1:started"]);
      await h.session.prompt("/orche cancel");
      await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(2), { timeout: 5000 });
      const j2Result = customMessages(h, TASK_RESULT_TYPE).find(message => message.details.job === "J2")!;
      expect(j2Result.content).not.toContain("Messages from main");
      expect(events(h).at(-1)).toBe("end:J2:cancelled");
    });
  }

  it("cancel through orche_task_status needs the user's confirmation; declined, the job keeps running", async () => {
    const entered = deferred();
    const titles: string[] = [];
    const answers = [DECLINE_CANCEL, CONFIRM_CANCEL];
    const h = await harness([
      tool("orche_task", { role: "implement", request, wait: false }),
      reply("Started."),
      tool("orche_task_status", { cancel: true }),
      reply("Kept."),
      tool("orche_task_status", { cancel: true }),
      reply("Cancelled."),
      reply("Noted."),
    ], [untilAborted(entered)], { ui: { select: async (title: string) => { titles.push(title); return answers.shift(); } } });
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("cancel it");
    expect(toolResults(h, "orche_task_status")[0]).toMatchObject({ details: { approval: "not-approved", reason: "declined", control: "cancel" } });
    expect(events(h)).toEqual(["start:J1"]);
    await h.session.prompt("really cancel it");
    expect(titles[1]).toContain("orche: cancel J1?");
    await vi.waitFor(() => expect(events(h)).toEqual(["start:J1", "end:J1:cancelled"]));
    expect(CONFIRM_MESSAGE).not.toBe(DECLINE_MESSAGE);
  });

  it("the approve answer is the exact option only", () => {
    expect(APPROVE_QUEUED).not.toBe(DECLINE_QUEUED);
    expect(APPROVE_QUEUED).toMatch(/^Approve: /);
  });
});
