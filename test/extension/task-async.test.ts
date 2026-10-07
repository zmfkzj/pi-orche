import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";
import { JOB_ENTRY_TYPE, TASK_RESULT_TYPE, type JobEntry } from "../../src/extension/jobs.js";

/**
 * Background orche_task (src/extension/jobs.ts) in a real TUI-mode session: the tool returns a job id while the worker keeps
 * running, main keeps the conversation, the result arrives once as a message that starts main's next turn, and main can inject
 * instructions into the running worker (orche_task_message) or cancel it (orche_task_status).
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
const customMessages = (h: Harness, type: string) => h.session.messages.filter(message => message.role === "custom" && (message as { customType?: string }).customType === type) as unknown as { content: string; details: Record<string, unknown> }[];
const toolResults = (h: Harness, name: string) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === name);
const textOf = (message: unknown) => JSON.stringify(message);
const jobEntries = (h: Harness) => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === JOB_ENTRY_TYPE).map(entry => (entry as { data: JobEntry }).data);

async function harness(mainSteps: FauxResponseStep[], orcheSteps: FauxResponseStep[], extra: { records?: boolean } = {}) {
  const h = await createHarness({ mainSteps, orcheSteps, mode: "tui", mainMode: "single", single: { spawn: false }, ...extra });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  return h;
}

describe("background orche_task jobs", () => {
  it("returns a job id at once, keeps main free, and delivers the result once as a message that starts main's next turn", async () => {
    const entered = deferred(), gate = deferred();
    let sawResult = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("Started J1; I will report when it is done."),
      context => { sawResult = textOf(context.messages.at(-1)); return reply("Reviewed J1: greeting checked."); },
    ], [gated(entered, gate, report())]);
    await h.session.prompt("check the greeting");
    await entered.promise;
    // The tool returned while the worker is still blocked in its first model call.
    const started = toolResults(h, "orche_task");
    expect(started).toHaveLength(1);
    expect(textOf(started[0])).toContain("Started job J1: worker W1 (implement");
    expect(textOf(started[0])).toContain("do not wait or poll");
    expect(started[0]).toMatchObject({ isError: false, details: { job: "J1", worker: "W1", status: "running", async: true } });
    expect(h.session.getLastAssistantText()).toContain("Started J1");
    expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(0);
    expect(jobEntries(h).map(entry => entry.event)).toEqual(["start"]);
    gate.resolve();
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toContain("Reviewed J1"), { timeout: 5000 });
    const results = customMessages(h, TASK_RESULT_TYPE);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("[orche task result · J1 · W1 implement · done");
    expect(results[0]!.content).toContain("Done: greeting checked");
    expect(results[0]!.details).toMatchObject({ job: "J1", worker: "W1", status: "done" });
    expect(sawResult).toContain("orche task result · J1");
    expect(jobEntries(h).map(entry => `${entry.event}:${"status" in entry ? entry.status : ""}`)).toEqual(["start:", "end:done"]);
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
  });

  it("injects a message into the running worker before its next request and reports it delivered", async () => {
    const entered = deferred(), gate = deferred();
    let workerSaw = "";
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
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
      tool("orche_task", { role: "implement", request }),
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
    // The worker got no extra turn for the withdrawn message (no faux response was consumed for it).
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
    await vi.waitFor(() => expect(h.session.getLastAssistantText()).toContain("resent"));
  });

  it("rejects a second task and messages without a running job; cancel delivers one cancelled result", async () => {
    const entered = deferred();
    const h = await harness([
      tool("orche_task", { role: "implement", request }),
      reply("Started."),
      tool("orche_task", { role: "implement", request }),
      tool("orche_task_status", {}),
      tool("orche_task_status", { cancel: true }),
      reply("Cancelled."),
      reply("Noted the cancellation."),
      tool("orche_task_message", { message: "anything" }),
      tool("orche_task_message", { job: "J1", message: "anything" }),
      reply("Nothing is running."),
    ], [async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted", { stopReason: "aborted" });
    }]);
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("start another and then cancel");
    const second = toolResults(h, "orche_task")[1]!;
    expect(second).toMatchObject({ isError: true });
    expect(textOf(second)).toContain("Job J1 (W1, implement) is still running; one task runs at a time");
    expect(textOf(toolResults(h, "orche_task_status")[0])).toContain("J1 running");
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

  it("/orche cancel stops a background job and delivers one cancelled result; wait:true and JSON mode block", async () => {
    const entered = deferred();
    const h = await harness([tool("orche_task", { role: "implement", request }), reply("Started."), reply("Noted.")], [async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted", { stopReason: "aborted" });
    }]);
    await h.session.prompt("go");
    await entered.promise;
    await h.session.prompt("/orche cancel");
    await vi.waitFor(() => expect(customMessages(h, TASK_RESULT_TYPE)).toHaveLength(1), { timeout: 5000 });
    expect(customMessages(h, TASK_RESULT_TYPE)[0]!.content).toContain("· cancelled after");
    expect(jobEntries(h).filter(entry => entry.event === "end")).toHaveLength(1);
    for (const [mode, args] of [["tui", { wait: true }], ["json", {}]] as const) {
      const blocking = await createHarness({ mainSteps: [tool("orche_task", { role: "implement", request, ...args }), reply("reviewed")], orcheSteps: [report()], mode, mainMode: "single", single: { spawn: false } });
      open.push(blocking);
      await blocking.session.prompt("go");
      expect(textOf(toolResults(blocking, "orche_task")[0])).toContain("Done: greeting checked");
      expect(customMessages(blocking, TASK_RESULT_TYPE)).toHaveLength(0);
    }
  });

  it("a session shutdown while a job runs ends it as interrupted in the session and the run record, without a message", async () => {
    const entered = deferred();
    const h = await harness([tool("orche_task", { role: "implement", request }), reply("Started.")], [async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted", { stopReason: "aborted" });
    }], { records: true });
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
