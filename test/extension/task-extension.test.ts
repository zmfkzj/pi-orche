import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool, type TaskDetails, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheRunArgs } from "../../src/extension/controller.js";
import type { SessionLiveness } from "../../src/agent/liveness.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

/**
 * Activity-aware timeouts of orche_task (src/orchestration/run/extension.ts, used by WorkerPool.executeAssignment): one deadline per
 * assignment, `assignmentMs` as its base. When it expires while the worker is still active (WorkerPool.workerLiveness over
 * `activityWindowMs`) it is extended by `extensionMs`, at most `maxExtensions` times; idle, or with the budget used up, the task
 * times out as before and says why it was not extended. The caps here are a few hundred milliseconds; the verdicts come from the
 * real liveness tracker (a worker waiting for the model is active) or, where a verdict has to be exact, from a stubbed workerLiveness.
 */
const open: Harness[] = [];
const pools = new Set<WorkerPool>();
afterEach(async () => {
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});

const result = (summary = "Evidence found") => tool("report_result", { kind: "explore", summary });
/** A model request that does not answer until the task is aborted: the worker is "waiting for the model", which counts as active. */
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};
/** A model request that answers with a result once `release` resolves. */
const held = (entered: { resolve(): void }, release: { promise: Promise<void> }, summary = "Evidence found"): FauxResponseStep => async () => {
  entered.resolve();
  await release.promise;
  return result(summary);
};

const verdict = (active: boolean, detail: string): SessionLiveness => ({ id: "W1", role: "explore", state: active ? "tool" : "idle", active, detail });

async function fixture(steps: FauxResponseStep[], options: { limits: Record<string, number>; records?: boolean }) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: options.records ? {} : { enabled: false }, limits: options.limits }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  pools.add(pool);
  const lines: string[][] = [];
  const execute = (extra: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress">> = {}, signal?: AbortSignal) =>
    pool.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false, onProgress: progress => { lines.push([...progress]); }, ...extra, signal });
  return { h, pool, controller, execute, lines };
}
/** The distinct progress lines shown so far that announce an extension (every later update repeats them). */
const extensionLines = (lines: string[][]) => [...new Set(lines.flat().filter(line => line.startsWith("⏱")))];
const rejection = async (promise: Promise<unknown>): Promise<TaskFailedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TaskFailedError);
  return error as TaskFailedError;
};

describe("(f) orche_task: the assignment wait is extended while the worker is active", () => {
  it("extends the wait of a worker that is still waiting for the model, and the task completes after the extension", async () => {
    const entered = deferred(), release = deferred();
    const { execute, lines } = await fixture([held(entered, release, "Evidence after the extension")], { limits: { assignmentMs: 200, extensionMs: 1000, maxExtensions: 2 } });
    const running = execute();
    await entered.promise;
    // The base deadline (200 ms) passes with the worker still waiting for its model request: extended, not timed out.
    await vi.waitFor(() => expect(extensionLines(lines).length).toBeGreaterThan(0), { timeout: 5000 });
    release.resolve();
    const { text, details } = await running;
    expect(details.status).toBe("completed");
    expect(text).toContain("Evidence after the extension");
    expect(details.extensions).toHaveLength(1);
    expect(details.extensions![0]).toMatchObject({ n: 1, max: 2, scope: "assignment", stage: "W1 explore", extensionMs: 1000, overallExtended: true });
    expect(details.extensions![0]!.reasons).toEqual([expect.stringMatching(/^W1 request in flight \d+s, no output yet$/)]);
    expect(details).not.toHaveProperty("notExtended");
  });

  it("stops after maxExtensions: the budget is a hard cap, with the budget reason, and the worker is idle again", async () => {
    const entered = deferred();
    const { pool, execute } = await fixture([blocked(entered)], { limits: { assignmentMs: 100, extensionMs: 100, maxExtensions: 2 } });
    const error = await rejection(execute());
    const [headline, ...history] = error.message.split("\n");
    // base 100 ms + 2 extensions of 100 ms; the reason it was not extended a third time is in the first line.
    expect(headline).toBe("Worker W1 timed out after 300ms (extension budget 2/2 used)");
    expect(history[0]).toBe("Timeout extensions: 2/2 used (+0s each)");
    expect(history).toHaveLength(3);
    expect(history[1]).toMatch(/^ {2}1\/2 at \d+s, assignment "W1 explore": W1 request in flight/);
    expect(history[2]).toMatch(/^ {2}2\/2 at \d+s, assignment "W1 explore": W1 request in flight/);
    expect(error.failure).toEqual({ kind: "failed", status: "timeout", reason: "Worker W1 timed out after 300ms (extension budget 2/2 used)" });
    expect(error.details).toMatchObject({ worker: "W1", status: "timeout", notExtended: { reason: "budget", message: "extension budget 2/2 used" } });
    expect(error.details.extensions).toHaveLength(2);
    expect(pool.list()[0]?.status).toBe("idle");
  });

  it("times out an idle worker at the base deadline and says that there was no activity in the activity window", async () => {
    const entered = deferred();
    const { pool, execute, lines } = await fixture([blocked(entered)], { limits: { assignmentMs: 150, extensionMs: 1000, maxExtensions: 3 } });
    const liveness = vi.spyOn(pool, "workerLiveness").mockImplementation(() => verdict(false, "idle, last signal 3m ago"));
    const error = await rejection(execute());
    expect(error.message).toBe("Worker W1 timed out after 150ms (not extended: no activity in the last 2m)");
    expect(error.failure).toEqual({ kind: "failed", status: "timeout", reason: "Worker W1 timed out after 150ms (not extended: no activity in the last 2m)" });
    expect(error.details).toMatchObject({ status: "timeout", notExtended: { reason: "idle", message: "not extended: no activity in the last 2m" } });
    expect(error.details).not.toHaveProperty("extensions");
    expect(extensionLines(lines)).toEqual([]);
    // The verdict was asked once, for this worker, over the configured activity window (2 minutes by default).
    expect(liveness).toHaveBeenCalledTimes(1);
    expect(liveness).toHaveBeenCalledWith("W1", expect.any(Number), 120_000);
    expect(pool.list()[0]?.status).toBe("idle");
  });

  it("asks over the configured activityWindowMs, and an extended worker that then goes idle times out with the extended cap and the history", async () => {
    const entered = deferred();
    const { pool, execute, lines } = await fixture([blocked(entered)], { limits: { assignmentMs: 150, extensionMs: 1000, maxExtensions: 3, activityWindowMs: 45_000 } });
    const liveness = vi.spyOn(pool, "workerLiveness")
      .mockImplementationOnce(() => verdict(true, "bash running 12m, cpu progressing"))
      .mockImplementation(() => verdict(false, "idle, last signal 1m ago"));
    const error = await rejection(execute());
    const [headline, ...history] = error.message.split("\n");
    expect(headline).toBe("Worker W1 timed out after 1150ms (not extended: no activity in the last 45s)"); // 150 base + 1000 extension
    expect(history[0]).toBe("Timeout extensions: 1/3 used (+1s each)");
    expect(history[1]).toMatch(/^ {2}1\/3 at \d+s, assignment "W1 explore": W1 bash running 12m, cpu progressing$/);
    expect(error.details).toMatchObject({ notExtended: { reason: "idle" }, extensions: [{ n: 1, max: 3 }] });
    expect(liveness).toHaveBeenCalledTimes(2);
    for (const call of liveness.mock.calls) expect(call).toEqual(["W1", expect.any(Number), 45_000]);
    expect(extensionLines(lines)).toEqual(["⏱ timeout extended 1/3 (+1s): W1 bash running 12m, cpu progressing"]);
  });

  it("with maxExtensions 0 nothing is extended and the message is the plain timeout", async () => {
    const entered = deferred();
    const { execute, lines } = await fixture([blocked(entered)], { limits: { assignmentMs: 150, maxExtensions: 0 } });
    const error = await rejection(execute());
    expect(error.message).toBe("Worker W1 timed out after 150ms");
    expect(error.details).toMatchObject({ status: "timeout" });
    expect(error.details).not.toHaveProperty("extensions");
    expect(error.details).not.toHaveProperty("notExtended");
    expect(extensionLines(lines)).toEqual([]);
  });
});

describe("(g) orche_task: cancellation wins over an extension", () => {
  it("cancelling during an extension window ends the task at once, not at the extended deadline", async () => {
    const entered = deferred();
    // The extension window is a minute long: a cancel that waited for it would blow the test's timeout.
    const { pool, execute, lines } = await fixture([blocked(entered)], { limits: { assignmentMs: 100, extensionMs: 60_000, maxExtensions: 3 } });
    const abort = new AbortController();
    const running = execute({}, abort.signal);
    await entered.promise;
    await vi.waitFor(() => expect(extensionLines(lines).length).toBe(1), { timeout: 5000 }); // now inside the extension window
    const cancelledAt = Date.now();
    abort.abort();
    const error = await rejection(running);
    expect(Date.now() - cancelledAt).toBeLessThan(5000);
    expect(error.message).toBe("cancelled");
    expect(error.failure).toMatchObject({ kind: "cancelled", status: "cancelled" });
    expect(error.details).toMatchObject({ worker: "W1", status: "cancelled", extensions: [{ n: 1, max: 3 }] });
    expect(pool.list()[0]?.status).toBe("idle");
  });

  it("/orche cancel during an extension window is 'cancelled by user' at once, and the worker is reusable", async () => {
    const entered = deferred();
    const { controller, pool, execute, lines } = await fixture([blocked(entered), result("Reused after the cancellation")], { limits: { assignmentMs: 100, extensionMs: 60_000, maxExtensions: 3 } });
    const running = rejection(execute());
    await entered.promise;
    await vi.waitFor(() => expect(extensionLines(lines).length).toBe(1), { timeout: 5000 });
    const cancelledAt = Date.now();
    expect(controller.cancel()).toBe(true);
    const error = await running;
    expect(Date.now() - cancelledAt).toBeLessThan(5000);
    expect(error.message).toBe("cancelled by user");
    expect(error.failure).toEqual({ kind: "cancelled", status: "cancelled", reason: "cancelled by user", cancelledByUser: true });
    expect(pool.list()[0]?.status).toBe("idle");
    // The extension window did not leave anything behind: the next assignment of the same worker has its own deadline and completes.
    const next = await execute({ worker: "W1" });
    expect(next.text).toContain("Reused after the cancellation");
  });
});

describe("(j) orche_task: extensions are reported in progress, result, details and the record", () => {
  it("shows the extension in the progress lines (ahead of the live status line), the result text, the details, run.json and events.jsonl", async () => {
    const entered = deferred(), release = deferred();
    const { execute, lines } = await fixture([held(entered, release, "Reported after an extension")], { limits: { assignmentMs: 200, extensionMs: 1000, maxExtensions: 3 }, records: true });
    const running = execute();
    await entered.promise;
    await vi.waitFor(() => expect(extensionLines(lines).length).toBeGreaterThan(0), { timeout: 5000 });
    release.resolve();
    const { text, details } = await running;

    // Progress: `⏱ timeout extended 1/3 (+1s): <why it is active>`, kept in later progress updates, with the live status line last.
    expect(extensionLines(lines)[0]).toMatch(/^⏱ timeout extended 1\/3 \(\+1s\): W1 request in flight \d+s, no output yet$/);
    const withExtension = lines.filter(update => update.some(line => line.startsWith("⏱")));
    expect(withExtension.length).toBeGreaterThan(0);
    for (const update of withExtension) expect(update.at(-1)).toMatch(/^W1 explore · \d+ requests/);
    expect(lines.at(-1)).toEqual([]); // the final clear still happens

    // Result text and details.
    expect(text).toContain("Timeout extensions: 1/3 used (+1s each)");
    expect(text).toMatch(/\n {2}1\/3 at \d+s, assignment "W1 explore": W1 request in flight/);
    expect(text.indexOf("Timeout extensions")).toBeLessThan(text.indexOf("Workers: "));
    expect(details.extensions).toHaveLength(1);
    expect(details.extensions![0]).toMatchObject({ n: 1, max: 3, scope: "assignment", extensionMs: 1000 });

    // The record: the extension list in run.json, the event in events.jsonl.
    const record = details.record!;
    const run = JSON.parse(readFileSync(join(record, "run.json"), "utf8")) as Record<string, unknown> & { extensions: TaskDetails["extensions"] };
    expect(run).toMatchObject({ kind: "task", status: "done", extensions: [{ n: 1, max: 3, scope: "assignment", stage: "W1 explore", extensionMs: 1000 }] });
    const events = readFileSync(join(record, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({ type: "deadline_extended", scope: "assignment", stage: "W1 explore", extension: 1, maxExtensions: 3, extensionMs: 1000, reasons: [expect.stringMatching(/^W1 request in flight/)] })]);
    expect(events[0]!.newDeadline).toEqual(expect.any(Number));
  });

  it("a task that never needed an extension reports nothing about them and leaves no events file", async () => {
    const { execute, lines } = await fixture([result()], { limits: { assignmentMs: 5000 }, records: true });
    const { text, details } = await execute();
    expect(text).not.toContain("Timeout extensions");
    expect(details).not.toHaveProperty("extensions");
    expect(details).not.toHaveProperty("notExtended");
    expect(extensionLines(lines)).toEqual([]);
    expect(() => readFileSync(join(details.record!, "events.jsonl"), "utf8")).toThrow(/ENOENT/);
    expect(JSON.parse(readFileSync(join(details.record!, "run.json"), "utf8"))).not.toHaveProperty("extensions");
  });

  it("the failed task's tool result keeps the extension history and the reason in its details", async () => {
    const entered = deferred();
    const { execute } = await fixture([blocked(entered)], { limits: { assignmentMs: 100, extensionMs: 100, maxExtensions: 1 }, records: true });
    const error = await rejection(execute());
    const toolResult = error.toolResult();
    expect(toolResult.isError).toBe(true);
    expect(toolResult.details).toMatchObject({ status: "timeout", extensions: [{ n: 1, max: 1 }], notExtended: { reason: "budget" }, failure: { kind: "failed", status: "timeout" } });
    expect(toolResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Worker W1 timed out after 200ms (extension budget 1/1 used)") });
    const run = JSON.parse(readFileSync(join(error.details.record!, "run.json"), "utf8")) as Record<string, unknown>;
    expect(run).toMatchObject({ status: "failed", extensions: [{ n: 1 }], notExtended: { reason: "budget", message: "extension budget 1/1 used" } });
  });
});
