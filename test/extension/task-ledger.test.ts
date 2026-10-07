import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { latestLedgers, LEDGER_ENTRY_TYPE, replayLedgerEvents, type LedgerEvent, type TaskLedger } from "../../src/single/ledger.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = (requirement: string, original = "인사말을 고쳐줘.") => `Intent/Purpose: improve greeting\nRequirements:\nR1: ${requirement}\nConstraints and non-goals: no commits.\nOriginal request\n${original}`;
const ambiguity = { id: "R1", readings: ["Hello", "Hi"], chosen: "Hello" };
const report = (status: "met" | "partial" = "met", ambiguities?: (typeof ambiguity)[]) => tool("report_result", {
  kind: "implement", summary: "Evidence-backed result",
  data: { status: "done", checklist: [{ id: "R1", status, evidence: "greeting.txt:1", ...(status === "met" ? { verifiedBy: "node --test" } : {}) }], ...(ambiguities ? { ambiguities } : {}) },
});
const state = (events: LedgerEvent[]) => replayLedgerEvents(JSON.parse(JSON.stringify(events)) as LedgerEvent[]);

async function fixture(steps: FauxResponseStep[], ledger: boolean, poolOptions: { idleTtlMs?: number } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, taskContext: { minClearTokens: 0 }, ...(ledger ? { single: { ledger: true } } : {}) });
  opened.push(h);
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const newPool = (saved: LedgerEvent[]) => {
    const pool = new WorkerPool({ controller, agentDir: h.agentDir, onLedgerEvent: event => saved.push(event), ...poolOptions });
    opened.push(pool);
    return pool;
  };
  const saved: LedgerEvent[] = [];
  const pool = newPool(saved);
  const run = (target: WorkerPool, args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) =>
    target.execute({ role: "implement", request: request("greeting is correct"), cwd: h.cwd, projectTrusted: false, mainMode: "single", ...args });
  return { h, pool, saved, newPool, run };
}
const writeConfig = (h: Harness, single?: { ledger: boolean }) =>
  writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", ...(single ? { single } : {}) }));

describe("single-workflow task ledger", () => {
  it("is off by default: no ledger, no task id, task ignored with a note, and unknown workers stay errors", async () => {
    const { pool, saved, run } = await fixture([report(), report()], false);
    const result = await run(pool);
    expect(result.details.task).toBeUndefined();
    expect(result.text).not.toContain("Task ledger");
    expect((await run(pool, { worker: "W1", task: "T1" })).text).toContain("Note: task T1 ignored: task ledgers apply to single-workflow standard roles with single.ledger on.");
    expect(saved).toEqual([]);
    await expect(run(pool, { worker: "W9" })).rejects.toThrow("Unknown worker W9");
    await expect(run(pool, { worker: "W9", task: "T1" })).rejects.toThrow("Unknown worker W9");
  });

  it("continues a task only when task is passed: reusing a worker without it starts a new task", async () => {
    const { pool, saved, run } = await fixture([report("partial", [ambiguity]), report("met"), report("met")], true);
    const first = await run(pool);
    expect(first.details.task).toBe("T1");
    expect(first.text).toContain('Task ledger T1, assignment 1: pass task "T1" for a follow-up of this task');
    expect(saved.map(event => event.event)).toEqual(["create", "handoff", "result"]);
    const followUp = await run(pool, { worker: "W1", task: "T1", request: request("greeting is correct for every locale", "모든 로케일에서 인사말을 고쳐줘.") });
    expect(followUp.details).toMatchObject({ worker: "W1", task: "T1" });
    expect(followUp.details.continuedFrom).toBeUndefined();
    const other = await run(pool, { worker: "W1", request: request("farewell is correct", "작별 인사도 고쳐줘.") });
    expect(other.details).toMatchObject({ worker: "W1", task: "T2" });
    const ledgers = state(saved);
    const t1 = ledgers.get("T1")!;
    expect(t1.assignments).toBe(2);
    expect(t1.requirements.map(item => [item.assignment, item.id, item.status])).toEqual([[1, "R1", "partial"], [2, "R1", "met"]]);
    expect(t1.decisions).toMatchObject([{ assignment: 1, id: "R1", chosen: "Hello", by: "worker" }]);
    expect(t1.originalRequests.map(item => item.text)).toEqual(["인사말을 고쳐줘.", "모든 로케일에서 인사말을 고쳐줘."]);
    expect(ledgers.get("T2")).toMatchObject({ assignments: 1, originalRequests: [{ assignment: 1, text: "작별 인사도 고쳐줘." }], decisions: [] });
    // Events, not snapshots: nothing larger than one hand-off is ever written.
    expect(Math.max(...saved.map(event => JSON.stringify(event).length))).toBeLessThan(1_000);
    await expect(run(pool, { worker: "W1", task: "T7" })).rejects.toThrow("Unknown task T7; known tasks: T1, T2");
  });

  it("gives the task's ledger back to a worker when it compacts, next to the verbatim assignment", async () => {
    const { h, pool, run } = await fixture([], true);
    const faux = fauxProvider({ provider: "ledger-compact", models: [{ id: "small", contextWindow: 32_000, maxTokens: 4096 }] });
    h.runtime.registerNativeProvider(faux.provider);
    await writeFile(join(h.cwd, "large.txt"), Array(90).fill("x".repeat(500)).join("\n"));
    faux.setResponses([report("partial", [ambiguity])]);
    await run(pool, { model: faux.getModel() });
    let step = 0;
    let checked = false;
    const scripted: FauxResponseStep = context => {
      if (JSON.stringify(context.messages.find(message => message.role === "system")).includes("You are a context summarization assistant")) return reply("COMPACTION_SUMMARY");
      if (step++ < 3) return tool("read", { path: "large.txt" });
      const messages = JSON.stringify(context.messages);
      expect(messages).toContain("Assignment in progress at compaction time (superseded by any later Assignment message)");
      expect(messages).toContain("Task ledger T1: state across 2 assignment(s)");
      expect(messages).toContain("- a1 R1 [partial] greeting is correct");
      expect(messages).toContain("chose \\\"Hello\\\" over \\\"Hi\\\"");
      checked = true;
      return report();
    };
    faux.setResponses(Array(12).fill(scripted));
    const result = await run(pool, { worker: "W1", task: "T1", model: faux.getModel(), request: request("greeting is correct everywhere") });
    expect(result.details.compactions?.count).toBeGreaterThan(0);
    expect(checked).toBe(true);
  });

  it("continues a restored task whose worker is gone with a new worker briefed from the ledger", async () => {
    const { h, pool, saved, newPool, run } = await fixture([report("partial", [ambiguity])], true);
    await run(pool);
    const restoredSaves: LedgerEvent[] = [];
    const reloaded = newPool(restoredSaves);
    reloaded.restoreLedgers([...state(saved).values()]);
    expect(reloaded.ledgerSummary()).toContain("T1 · W1 (gone)");
    await expect(run(reloaded, { worker: "W1" })).rejects.toThrow('W1 last worked on task T1: pass task "T1" (and omit worker) to continue it');
    await expect(run(reloaded, { worker: "W5", task: "T1" })).rejects.toThrow("Unknown worker W5");
    h.orche.faux.setResponses([context => {
      const messages = JSON.stringify(context.messages);
      expect(messages).toContain("## Continuing task T1");
      expect(messages).toContain("W1 is no longer live");
      expect(messages).toContain("- R1 [partial] greeting is correct");
      return report();
    }]);
    const result = await run(reloaded, { task: "T1" });
    expect(result.details).toMatchObject({ worker: "W2", task: "T1", continuedFrom: "W1" });
    expect(result.text).toContain("Note: W2 took task T1 over from W1 (not live), briefed from its task ledger.");
    expect(state([...saved, ...restoredSaves]).get("T1")).toMatchObject({ assignments: 2, primary: { worker: "W2" } });
  });

  it("hands a task to a new worker while the old one is live", async () => {
    const { h, pool, run } = await fixture([report("partial")], true);
    await run(pool);
    h.orche.faux.setResponses([context => { expect(JSON.stringify(context.messages)).toContain("W1 handed it over to you"); return report(); }]);
    const handed = await run(pool, { task: "T1" });
    expect(handed.details).toMatchObject({ worker: "W2", task: "T1", continuedFrom: "W1" });
    expect(handed.text).toContain("Note: W2 took task T1 over from W1, briefed from its task ledger.");
  });

  it("continues a task after its idle worker expired, and not once the ledger is off", async () => {
    const { h, pool, run } = await fixture([report(), report(), report()], true, { idleTtlMs: 5 });
    await run(pool);
    await vi.waitFor(() => expect(pool.list()).toEqual([]), { timeout: 2000 });
    const continued = await run(pool, { worker: "W1", task: "T1" });
    expect(continued.details).toMatchObject({ worker: "W2", task: "T1", continuedFrom: "W1" });
    await vi.waitFor(() => expect(pool.list()).toEqual([]), { timeout: 2000 });
    await writeConfig(h);
    // Without the ledger the gone worker is still known to the pool: a new worker continues, briefed from its transcript.
    const handed = await run(pool, { worker: "W2", task: "T1" });
    expect(handed.details).toMatchObject({ worker: "W3", continuedFrom: "W2" });
    expect(handed.text).toContain("Note: task T1 ignored");
    expect(handed.text).toContain("W2 was gone (idle expiry");
  });

  it("names the task in failed results, so the main session can retry the same task", async () => {
    const { pool, run } = await fixture([reply("I will not report"), reply("Still no report")], true);
    await expect(run(pool)).rejects.toThrow('Task ledger T1, assignment 1: pass task "T1"');
  });

  it("the extension persists ledger events outside the model context and restores them", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [report()], single: { ledger: true } });
    opened.push(h);
    const original = WorkerPool.prototype.execute;
    vi.spyOn(WorkerPool.prototype, "execute").mockImplementation(function (this: WorkerPool, args) { opened.push(this); return original.call(this, args); });
    h.main.faux.setResponses([tool("orche_task", { role: "implement", request: request("greeting is correct") }), reply("reviewed")]);
    await h.session.prompt("delegate this");
    const entries = h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === LEDGER_ENTRY_TYPE);
    expect(entries.map(entry => (entry as { data: LedgerEvent }).data.event)).toEqual(["create", "handoff", "result"]);
    expect(JSON.stringify(h.session.messages)).not.toContain("Task ledger T1: state");
    const restored: TaskLedger[] = latestLedgers(h.session.sessionManager.getBranch() as never);
    expect(restored).toMatchObject([{ taskId: "T1", assignments: 1, requirements: [{ id: "R1", status: "met" }] }]);
  });
});
