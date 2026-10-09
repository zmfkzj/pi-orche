import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool } from "./harness.js";
import { latestLedgers, LEDGER_ENTRY_TYPE, replayLedgerEvents, type LedgerEvent } from "../../src/single/ledger.js";
import { deferred } from "../helpers/faux.js";

/**
 * A timed-out orche_task assignment of the single workflow (R2/R3 of the long-task timeout work): the timeout is not an unmet
 * result, the result says how to resume (same worker + task while it is retained), and the Task DAG checkpoint recorded before the
 * forced stop survives in the task ledger and reaches the worker that continues: the same worker, a new worker after a reload, and
 * the main summary.
 */
const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = (requirement: string) => `Intent/Purpose: improve greeting\nRequirements:\nR1: ${requirement}\nConstraints and non-goals: no commits.\nOriginal request\n인사말을 고쳐줘.`;
const report = (status: "met" | "partial" = "met") => tool("report_result", {
  kind: "implement", summary: "Evidence-backed result",
  data: { status: "done", checklist: [{ id: "R1", status, evidence: "greeting.txt:1", ...(status === "met" ? { verifiedBy: "node --test" } : {}) }] },
});
/** The Task DAG a worker records before it is stopped: one node done with its checkpoint, one still running. */
const plan = tool("task_plan", { nodes: [
  { id: "write", title: "Write the greeting", dependsOn: [], covers: ["R1"], status: "done", checkpoint: { result: "greeting.txt now says Hello", evidence: ["greeting.txt:1"], verification: "not_applicable" } },
  { id: "verify", title: "Verify the greeting", dependsOn: ["write"], covers: ["R1"], status: "running", phase: "integrate" },
] });
/** A model request that never answers until the task is stopped. */
const blocked = (entered?: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered?.resolve();
  await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  return reply("aborted");
};

async function fixture(steps: FauxResponseStep[], limits: Record<string, number>) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, single: { ledger: true } });
  opened.push(h);
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", single: { ledger: true }, limits }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const newPool = (saved: LedgerEvent[]) => {
    const pool = new WorkerPool({ controller, agentDir: h.agentDir, onLedgerEvent: event => saved.push(event) });
    opened.push(pool);
    return pool;
  };
  const saved: LedgerEvent[] = [];
  const pool = newPool(saved);
  const run = (target: WorkerPool, args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) =>
    target.execute({ role: "implement", request: request("greeting is correct"), cwd: h.cwd, projectTrusted: false, mainMode: "single", ...args });
  return { h, pool, saved, newPool, run };
}
const failure = async (promise: Promise<unknown>): Promise<TaskFailedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TaskFailedError);
  return error as TaskFailedError;
};
const state = (events: LedgerEvent[]) => replayLedgerEvents(JSON.parse(JSON.stringify(events)) as LedgerEvent[]);

describe("orche_task timeout: resume with the same worker and the persisted checkpoint", () => {
  it("persists the checkpoint recorded before a forced timeout, says how to resume, and briefs the SAME worker with it", async () => {
    const { h, pool, saved, run } = await fixture([plan, blocked()], { assignmentMs: 400, maxExtensions: 0 });
    const error = await failure(run(pool));
    expect(error.failure).toMatchObject({ status: "timeout" });
    // The checkpoint was persisted when task_plan was accepted, before the stop: a `plan` ledger event.
    const planEvents = saved.filter(event => event.event === "plan");
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0]).toMatchObject({ taskId: "T1", assignment: 1, worker: "W1", nodes: [
      { id: "write", status: "done", covers: ["R1"], checkpoint: { result: "greeting.txt now says Hello", verification: "not_applicable", evidence: ["greeting.txt:1"] } },
      { id: "verify", status: "running", phase: "integrate" },
    ] });
    expect(pool.ledger("T1")?.plan).toMatchObject({ assignment: 1, worker: "W1" });
    // The result: the checkpoint and how to resume (same worker + task), without overstating how long the worker is kept.
    const lines = error.message.split("\n");
    expect(lines).toContain("Checkpoint at the timeout: Task DAG 1/2 nodes done; not done: verify (running); every accepted task_plan of it is persisted in task ledger T1. Only what task_plan recorded survives a worker that is gone; nothing after its last accepted call.");
    const resume = lines.find(line => line.startsWith("Resume:"))!;
    expect(resume).toContain("a timeout is not an unmet result and does not count towards the 2-consecutive-unmet rule");
    expect(resume).toMatch(/W1 stays idle with its context until about \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \(idle expiry 30 min\), unless it is retired earlier/);
    expect(resume).toContain('Continue with orche_task worker "W1" and task "T1"');
    expect(resume).toContain('Once W1 is gone, pass task "T1": a new worker is briefed from the task ledger and its last recorded Task DAG');
    expect(error.details.resume).toEqual({ worker: "W1", task: "T1", retainedUntil: expect.any(Number), checkpoint: { assignment: 1, worker: "W1", done: 1, total: 2, remaining: ["verify (running)"] } });
    expect(error.details.resume!.retainedUntil - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(pool.list()).toMatchObject([{ id: "W1", status: "idle" }]);
    expect(pool.ledgerSummary()).toContain("Task DAG a1 (W1): 1/2 done");

    // The same worker continues the same task: its prompt starts with the resume block and the recorded checkpoint.
    let prompt = "";
    h.orche.faux.setResponses([context => { prompt = JSON.stringify(context.messages); return report(); }]);
    const resumed = await run(pool, { worker: "W1", task: "T1", request: request("greeting is correct (finish the remaining verification)") });
    expect(resumed.details).toMatchObject({ worker: "W1", task: "T1" });
    expect(resumed.details.continuedFrom).toBeUndefined();
    expect(prompt).toContain("## Resuming task T1 after a timeout");
    expect(prompt).toContain("Your assignment a1 of task T1 was stopped by its time limit");
    expect(prompt).toContain("1/2 nodes done");
    expect(prompt).toContain("- running verify {integrate}: Verify the greeting (R1)");
    expect(prompt).toContain("- done write [not_applicable]: Write the greeting (R1) — greeting.txt now says Hello [greeting.txt:1]");
  });

  it("a reloaded session restores the checkpoint from the session entries and briefs the NEW worker that takes the task over", async () => {
    const { h, pool, saved, newPool, run } = await fixture([plan, blocked()], { assignmentMs: 400, maxExtensions: 0 });
    await failure(run(pool));
    // The session entries as Pi stores them (custom entries), replayed after a reload.
    const restored = latestLedgers(saved.map(data => ({ type: "custom", customType: LEDGER_ENTRY_TYPE, data: JSON.parse(JSON.stringify(data)) as unknown })));
    expect(restored[0]?.plan).toMatchObject({ assignment: 1, worker: "W1", nodes: [{ id: "write", status: "done" }, { id: "verify", status: "running" }] });
    const reloadedSaves: LedgerEvent[] = [];
    const reloaded = newPool(reloadedSaves);
    reloaded.restoreLedgers(restored);
    let prompt = "";
    h.orche.faux.setResponses([context => { prompt = JSON.stringify(context.messages); return report(); }]);
    const result = await run(reloaded, { task: "T1" });
    expect(result.details).toMatchObject({ worker: "W2", task: "T1", continuedFrom: "W1" });
    expect(prompt).toContain("## Continuing task T1");
    expect(prompt).toContain("Its last assignment a1 was stopped by the time limit, not by an unmet result.");
    expect(prompt).toContain("Resume from the last recorded Task DAG in the ledger below");
    expect(prompt).toContain("Last recorded Task DAG of task (assignment a1, worker W1");
    expect(prompt).toContain("greeting.txt now says Hello");
    expect(state([...saved, ...reloadedSaves]).get("T1")).toMatchObject({ assignments: 2, primary: { worker: "W2" } });
  });

  it("a timeout neither counts towards nor resets the 2-consecutive-unmet streak; a reported unmet result still does", async () => {
    const entered = deferred();
    const { h, pool, run } = await fixture([report("partial")], { assignmentMs: 1_000, maxExtensions: 0 });
    expect((await run(pool)).text).not.toContain("consecutive assignments");
    // A timeout between two partial reports: no note at the timeout, and the streak is still 1 afterwards.
    h.orche.faux.setResponses([blocked(entered)]);
    const timedOut = await failure(run(pool, { worker: "W1", task: "T1" }));
    expect(timedOut.message).not.toContain("consecutive assignments");
    h.orche.faux.setResponses([report("partial")]);
    const second = await run(pool, { worker: "W1", task: "T1" });
    expect(second.text).toContain("Note: R1 unmet in 2 consecutive assignments of W1");
  });

  it("two timeouts in a row never produce the new-worker note", async () => {
    const { h, pool, run } = await fixture([blocked()], { assignmentMs: 300, maxExtensions: 0 });
    await failure(run(pool));
    h.orche.faux.setResponses([blocked()]);
    const again = await failure(run(pool, { worker: "W1", task: "T1" }));
    expect(again.message).not.toContain("NEW worker");
    expect(again.message).toContain('Continue with orche_task worker "W1" and task "T1"');
    h.orche.faux.setResponses([report("partial")]);
    expect((await run(pool, { worker: "W1", task: "T1" })).text).not.toContain("consecutive assignments");
  });
});
