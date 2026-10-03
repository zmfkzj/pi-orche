import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { OrcheOutcome } from "../../src/extension/controller.js";
import { errorToolResult, FAILURE_LIST_ENTRIES, failureReason, runErrorResult, runFailureOf } from "../../src/extension/tool-result.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.dispose();
});
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const created = await createHarness(...args);
  open.push(created);
  return created;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface ToolResultMessage { role: "toolResult"; toolName: string; isError: boolean; content: { type: string; text: string }[]; details?: Record<string, any> }
/** The persisted orche_run result message: what the session transcript keeps. */
const runResults = (h: Harness): ToolResultMessage[] =>
  h.session.messages.flatMap(message => message.role === "toolResult" && message.toolName === "orche_run" ? [message as unknown as ToolResultMessage] : []);
const textOf = (message: ToolResultMessage) => message.content.map(part => part.text).join("\n");
const blockedUntilAbort = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
  return reply("aborted") as AssistantMessage;
};

describe("orche_run failures keep their structured details", () => {
  it("a failed run is an error result with the same text and non-empty details", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "do the impossible" }), reply("noted")],
      orcheSteps: [
        decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" }),
        tool("report_result", { kind: "answer", summary: "PRESERVED_ANALYSIS: greeting.txt says hello world.", data: { evidence: ["greeting.txt"] } }),
        decision({ type: "fail", reason: "coordinator gave up" }),
      ],
    });
    await h.session.prompt("go");
    const [result, ...rest] = runResults(h);
    expect(rest).toEqual([]);
    expect(result!.isError).toBe(true);
    // Same model-facing text as the thrown error had.
    const text = textOf(result!);
    expect(text).toMatch(/^orche FAILED \(answer, \d+s; /);
    expect(text).toContain("coordinator gave up");
    expect(text).toContain("Result from failed run (may be incomplete):\nPRESERVED_ANALYSIS: greeting.txt says hello world.");
    // The orchestration details survive.
    expect(Object.keys(result!.details ?? {})).not.toHaveLength(0);
    expect(result!.details).toMatchObject({
      status: "failed", taskClass: "answer", cancelled: false,
      config: expect.stringContaining("orche.config.json"),
      requests: expect.any(Number), tasks: expect.any(Number),
      models: { coordinator: expect.any(Object) },
      failure: { kind: "failed", status: "failed", reason: "coordinator gave up" },
    });
    expect(result!.details!.requests).toBeGreaterThan(0);
    expect(result!.details!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(result!.details!.models)).toContain("coordinator");
    expect(result!.details!.failure.cancelledByUser).toBeUndefined();
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("a failed run in a git work tree also keeps the workspace changes and the violations", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "set the value" }), reply("noted")],
      orcheSteps: [
        decision({ type: "classify", taskClass: "change", workerCount: 2, language: "en", reason: "explicit ownership" }),
        decision({ type: "assign", tasks: [{ id: "change", description: "set value", owner: "A1", files: ["core.mjs"], status: "pending" }] }),
        tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
        tool("bash", { command: "echo stray > stray.txt && echo changed > other.mjs" }),
        tool("report_result", { kind: "implement", summary: "set value to 1", data: { status: "done" } }),
        tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
        decision({ type: "complete", summary: "Value changed from 0 to 1 and verified." }),
      ],
    });
    await writeFile(join(h.cwd, "core.mjs"), "export const value = 0;\n");
    await writeFile(join(h.cwd, "other.mjs"), "export const other = 0;\n");
    git(h.cwd, "init", "-q");
    git(h.cwd, "add", "-A");
    git(h.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result!)).toContain("Decomposition failure: 2 ownership violations");
    expect(textOf(result!)).toContain("Result from failed run (may be incomplete):\nValue changed from 0 to 1 and verified.");
    const failure = result!.details!.failure;
    expect(failure).toMatchObject({ kind: "failed", status: "failed", reason: expect.stringContaining("ownership violations") });
    expect(failure.violations.map((violation: { file: string }) => violation.file).sort()).toEqual(["other.mjs", "stray.txt"]);
    expect(failure.workspace.baseline).toMatch(/^[0-9a-f]{40}$/);
    expect(failure.workspace.changes.map((change: { path: string }) => change.path)).toContain("core.mjs");
    expect(result!.details).toMatchObject({ status: "failed", taskClass: "change", requests: expect.any(Number) });
  });

  it("a run cancelled with /orche cancel is an error result with the cancellation diagnostics in its details", async () => {
    const entered = deferred();
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "long job" }), reply("understood")],
      orcheSteps: [blockedUntilAbort(entered)],
    });
    const turn = h.session.prompt("delegate");
    await entered.promise;
    await h.session.prompt("/orche cancel");
    await turn;
    const [result] = runResults(h);
    expect(result!.isError).toBe(true);
    const text = textOf(result!);
    expect(text).toMatch(/^cancelled by user\n\norche CANCELLED by user \(\d+s; /);
    expect(text).toContain("Cancelled at EXPLORE after");
    expect(Object.keys(result!.details ?? {})).not.toHaveLength(0);
    expect(result!.details).toMatchObject({
      status: "failed", cancelled: true, durationMs: expect.any(Number), requests: expect.any(Number),
      models: expect.any(Object), config: expect.any(String),
      cancellation: { phase: "EXPLORE" },
      failure: { kind: "cancelled", status: "failed", reason: "cancelled by user", cancelledByUser: true },
    });
    expect(result!.details!.cleanup).toEqual({ incomplete: false, pending: [] });
  });

  it("a run cancelled by aborting the main turn is an error result that is not marked as user-cancelled", async () => {
    const entered = deferred();
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "long job" })],
      orcheSteps: [blockedUntilAbort(entered)],
    });
    const turn = h.session.prompt("delegate");
    await entered.promise;
    await h.session.abort();
    await turn;
    const [result] = runResults(h);
    expect(result!.isError).toBe(true);
    expect(textOf(result!)).toContain("cancelled");
    expect(textOf(result!)).toMatch(/^orche CANCELLED \(\d+s; /);
    expect(result!.details).toMatchObject({
      status: "failed", cancelled: true, requests: expect.any(Number), cleanup: { incomplete: false, pending: [] },
      cancellation: { phase: "EXPLORE" }, failure: { kind: "cancelled", status: "failed", reason: "cancelled" },
    });
    expect(result!.details!.failure.cancelledByUser).toBeUndefined();
  });

  it("an over-long failed result is spilled by the tool_result hook but stays an error with its details", async () => {
    const long = Array.from({ length: 400 }, (_, index) => `analysis line ${index}`).join("\n");
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("noted")],
      orcheSteps: [
        decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" }),
        tool("report_result", { kind: "answer", summary: long, data: { evidence: ["greeting.txt"] } }),
        decision({ type: "fail", reason: "coordinator gave up" }),
      ],
    });
    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result!.isError).toBe(true);
    expect(textOf(result!)).toContain("Output truncated");
    expect(result!.details).toMatchObject({ status: "failed", requests: expect.any(Number), failure: { kind: "failed", reason: "coordinator gave up" } });
  });

  it("a finished run stays a success without a failure summary", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")],
      orcheSteps: answerScript("TOOL_RESULT_ANSWER"),
    });
    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result!.isError).toBe(false);
    expect(textOf(result!)).toContain("TOOL_RESULT_ANSWER");
    expect(result!.details).toMatchObject({ status: "done", cancelled: false });
    expect(result!.details).not.toHaveProperty("failure");
  });

  it("argument validation errors stay plain errors: no run starts and there are no orchestration details", async () => {
    const h = await harness({
      mainSteps: [tool("orche_run", { request: "" }), reply("noted")],
      orcheSteps: [],
    });
    await h.session.prompt("go");
    const [result] = runResults(h);
    expect(result!.isError).toBe(true);
    expect(result!.details ?? {}).not.toHaveProperty("failure");
    expect(result!.details ?? {}).not.toHaveProperty("requests");
    expect(h.orche.faux.state.callCount).toBe(0);
  });
});

describe("error result builder", () => {
  const baseOutcome = (overrides: Partial<OrcheOutcome["report"]> = {}, cancelledByUser = false): OrcheOutcome => ({
    report: {
      status: "failed", summary: "first line of the failure\nsecond line", tasks: [], startedAt: 1000, finishedAt: 3500,
      taskClass: "change", answer: "partial", answerFromFailedRun: true, ...overrides,
    },
    text: "first line of the failure\nsecond line",
    source: { kind: "user", path: "/agent/orche.config.json" },
    cancelledByUser,
    details: {
      status: "failed", taskClass: "change", durationMs: 2500, config: "test config", ignoredConfigs: [], tasks: 0, requests: 3, inputTokens: 10,
      outputTokens: 5, advisorRequests: 0, models: { coordinator: { "p/m": 3 } }, contextWindows: {}, cancelled: cancelledByUser, progress: ["line"],
      ...(overrides.cleanup ? { cleanup: overrides.cleanup } : {}),
    },
  });

  it("errorToolResult marks the result as an error, keeps the text and adds the failure to a copy of the details", () => {
    const details = { model: "p/m", requests: 2 };
    const failure = { kind: "blocked" as const, status: "blocked", reason: "needs input" };
    const result = errorToolResult("the text", details, failure);
    expect(result).toEqual({ content: [{ type: "text", text: "the text" }], details: { model: "p/m", requests: 2, failure }, isError: true });
    expect(details).toEqual({ model: "p/m", requests: 2 });
  });

  it("failureReason takes the first non-empty line, collapses whitespace and bounds the length", () => {
    expect(failureReason("\n\n  first   line \nsecond")).toBe("first line");
    expect(failureReason("x".repeat(500)).length).toBe(300);
    expect(failureReason("x".repeat(500)).endsWith("…")).toBe(true);
    expect(failureReason("")).toBe("");
  });

  it("runErrorResult keeps outcome.details, the cleanup and a bounded workspace/violation summary", () => {
    const many = Array.from({ length: FAILURE_LIST_ENTRIES + 7 }, (_, index) => ({ path: `f${index}.ts`, status: "modified" as const }));
    const outcome = baseOutcome({
      cleanup: { incomplete: true, pending: ["providers"] }, rootCause: "the root cause\nmore",
      ownershipViolations: [{ agentId: "A1", file: "x.ts", via: "workspace", created: true }],
      workspace: { baseline: "abc123", changes: many, external: [{ path: "ext.ts", status: "added", reason: "another session" }] },
    });
    const result = runErrorResult(outcome);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect(result.details).toMatchObject({ ...outcome.details, requests: 3, durationMs: 2500, cleanup: { incomplete: true, pending: ["providers"] } });
    expect(result.details.failure).toMatchObject({
      kind: "failed", status: "failed", reason: "first line of the failure", rootCause: "the root cause",
      violations: [{ agentId: "A1", file: "x.ts", via: "workspace", created: true }],
      workspace: { baseline: "abc123", external: [{ path: "ext.ts", status: "added", reason: "another session" }], omitted: 7 },
    });
    expect(result.details.failure.workspace!.changes).toHaveLength(FAILURE_LIST_ENTRIES);
    expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
  });

  it("runFailureOf distinguishes user cancellation, tool-abort cancellation and plain failure", () => {
    expect(runFailureOf(baseOutcome({ summary: "cancelled" }, true))).toEqual({ kind: "cancelled", status: "failed", reason: "cancelled by user", cancelledByUser: true });
    const aborted = baseOutcome({ summary: "cancelled" });
    aborted.details = { ...aborted.details, cancelled: true };
    expect(runFailureOf(aborted)).toEqual({ kind: "cancelled", status: "failed", reason: "cancelled" });
    expect(runFailureOf(baseOutcome())).toEqual({ kind: "failed", status: "failed", reason: "first line of the failure" });
  });

  it("runErrorResult prefixes the text with 'cancelled by user' only for /orche cancel", () => {
    const user = baseOutcome({ summary: "cancelled" }, true);
    expect((runErrorResult(user).content[0] as { text: string }).text).toMatch(/^cancelled by user\n\norche CANCELLED by user /);
    expect((runErrorResult(baseOutcome()).content[0] as { text: string }).text).toMatch(/^orche FAILED /);
  });
});
