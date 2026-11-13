/**
 * Completion wait (`pi --orche-completion-wait unbounded`, src/orchestration/completion-wait.ts): a per-invocation opt-in under
 * which orche_task assignments, their orche_spawn sub-workers and their advisor wait for the result instead of a deadline, while
 * every session without the flag keeps the finite deadlines. Caps here are a few hundred milliseconds with extensions OFF, so a
 * wait that survived them can only have survived because the deadline is gone; liveness is stubbed idle where it would matter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import type { SessionLiveness } from "../../src/agent/liveness.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { COMPLETION_WAIT_FLAG, COMPLETION_WAIT_LINE, CompletionWaitFlagError, parseCompletionWait, UNBOUNDED_WAIT_SEGMENT_MS, type CompletionWait } from "../../src/orchestration/completion-wait.js";
import { ExtendableDeadline, waitExtendable } from "../../src/orchestration/run/extension.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const idle: SessionLiveness = { id: "W1", role: "explore", state: "idle", active: false, detail: "idle, no output" };
/** A model request that answers `step` only after `ms` (silent meanwhile), or when aborted. */
const late = (ms: number, answer: () => ReturnType<typeof reply>): FauxResponseStep => async (_context, options) => {
  await new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); options?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
  return answer();
};
const explored = (summary = "Evidence found") => tool("report_result", { kind: "explore", summary });

async function fixture(options: { completionWait?: () => CompletionWait; limits?: Record<string, unknown>; single?: Record<string, unknown>; models?: Record<string, unknown> } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({
    routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single",
    ...(options.limits ? { limits: options.limits } : {}), ...(options.single ? { single: options.single } : {}), ...(options.models ? { models: options.models } : {}),
  }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, ...(options.completionWait ? { completionWait: options.completionWait } : {}) });
  opened.push(pool);
  const workerFaux = fauxProvider({ provider: "main-reasoning", models: [{ id: "current", reasoning: true }] });
  const advisorFaux = fauxProvider({ provider: "tier-advisor", models: [{ id: "a1", reasoning: true }] });
  h.runtime.registerNativeProvider(workerFaux.provider);
  h.runtime.registerNativeProvider(advisorFaux.provider);
  const execute = (args: Partial<TaskParameters> = {}, signal?: AbortSignal) =>
    pool.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false, mainMode: "single", model: workerFaux.getModel(), thinking: "high", ...args, ...(signal ? { signal } : {}) } as Parameters<WorkerPool["execute"]>[0]);
  return { h, pool, execute, workerFaux, advisorFaux };
}
const rejection = async (promise: Promise<unknown>): Promise<TaskFailedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TaskFailedError);
  return error as TaskFailedError;
};
/** Base 300 ms, no extensions: any wait past it survives only without a deadline. */
const tight = { assignmentMs: 300, maxExtensions: 0, observeMs: 100 };

describe("completion wait: the flag value", () => {
  it("absent means the finite deadlines; only \"unbounded\" opts in; anything else is refused instead of silently keeping deadlines", () => {
    expect(COMPLETION_WAIT_FLAG).toBe("orche-completion-wait");
    expect(parseCompletionWait(undefined)).toBe("deadline");
    expect(parseCompletionWait("unbounded")).toBe("unbounded");
    for (const bad of ["", "true", "forever", "0", true, "Unbounded"]) expect(() => parseCompletionWait(bad)).toThrow(CompletionWaitFlagError);
  });
});

describe("completion wait: waitExtendable without a deadline", () => {
  it("re-arms segments, never extends, refuses or stalls, and returns the result; the default wait times out at the same expiry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const deadline = () => ExtendableDeadline.fromLimits({ overallMs: 1000, extensionMs: 1000, maxExtensions: 0, activityWindowMs: 1000 });
    const segments: number[] = [];
    let calls = 0;
    const wait = async (ms: number): Promise<{ type: "timeout" } | { type: "outcome"; value: number }> => { segments.push(ms); await sleep(ms); return ++calls < 4 ? { type: "timeout" } : { type: "outcome", value: 42 }; };
    const observations: boolean[] = [];
    const unbounded = deadline();
    const running = waitExtendable({ deadline: unbounded, wait, stage: "W1", liveness: () => idle, unbounded: true, observeEveryMs: 60_000, onObservation: observation => observations.push(observation.alive) });
    await vi.advanceTimersByTimeAsync(4 * UNBOUNDED_WAIT_SEGMENT_MS);
    await expect(running).resolves.toEqual({ type: "outcome", value: 42 });
    expect(segments).toEqual(Array(4).fill(UNBOUNDED_WAIT_SEGMENT_MS));
    expect(unbounded.used).toBe(0);
    // Idle the whole time, observed every minute for 20 minutes: reported, never a stop.
    expect(observations.length).toBeGreaterThanOrEqual(19);
    expect(observations.every(alive => !alive)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    calls = 0;
    const finite = waitExtendable({ deadline: deadline(), wait, stage: "W1", liveness: () => idle });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(finite).resolves.toMatchObject({ type: "timeout" });
  });

  it("the caller's signal still ends an unbounded wait at once", async () => {
    const abort = new AbortController();
    const running = waitExtendable({ deadline: ExtendableDeadline.fromLimits({ overallMs: 10, extensionMs: 0, maxExtensions: 0, activityWindowMs: 10 }), wait: () => new Promise<{ type: "timeout" }>(() => undefined), stage: "W1", liveness: () => idle, unbounded: true });
    setTimeout(() => abort.abort(), 20);
    const result = await Promise.race([running, sleep(10).then(() => "pending")]);
    expect(result).toBe("pending");
    const ended = waitExtendable({ deadline: ExtendableDeadline.fromLimits({ overallMs: 10, extensionMs: 0, maxExtensions: 0, activityWindowMs: 10 }), wait: () => new Promise<{ type: "timeout" }>(() => undefined), stage: "W1", liveness: () => idle, unbounded: true, signal: abort.signal });
    await expect(ended).resolves.toEqual({ type: "aborted" });
  });
});

describe("completion wait: orche_task assignments", () => {
  it("opt-in: a silent, idle worker past the base cap (extensions off) is not stopped; its result arrives and says why", async () => {
    const { pool, execute, workerFaux } = await fixture({ completionWait: () => "unbounded", limits: tight });
    vi.spyOn(pool, "workerLiveness").mockImplementation(() => idle);
    workerFaux.setResponses([late(1500, () => explored("Evidence after a long silence"))]);
    const started = Date.now();
    const { text, details } = await execute();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(details.status).toBe("completed");
    expect(text).toContain("Evidence after a long silence");
    expect(text).toContain(COMPLETION_WAIT_LINE);
    expect(details.completionWait).toBe("unbounded");
    expect(details.deadline).toBeUndefined();
    expect(details.extensions ?? []).toEqual([]);
    expect(details.notExtended).toBeUndefined();
    // Observed (every 100 ms) while it waited, never stopped by it.
    expect(details.observations?.count).toBeGreaterThanOrEqual(5);
  });

  it("default (no flag): the same worker times out at the base cap, as before", async () => {
    const { pool, execute, workerFaux } = await fixture({ limits: tight });
    vi.spyOn(pool, "workerLiveness").mockImplementation(() => idle);
    workerFaux.setResponses([late(1500, () => explored())]);
    const error = await rejection(execute());
    expect(error.message).toMatch(/^Worker W1 timed out after 300ms/);
    expect(error.details?.completionWait).toBeUndefined();
    expect(error.details?.deadline).toMatchObject({ baseMs: 300 });
  });

  it("opt-in keeps cancellation: the caller's abort cancels the waiting worker", async () => {
    const { execute, workerFaux } = await fixture({ completionWait: () => "unbounded", limits: tight });
    const entered = deferred();
    workerFaux.setResponses([async (_context, options) => { entered.resolve(); await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true })); return reply("aborted"); }]);
    const abort = new AbortController();
    const running = execute({}, abort.signal);
    await entered.promise;
    await sleep(600);
    abort.abort();
    const error = await rejection(running);
    expect(error.message).toBe("cancelled");
    expect(error.failure).toMatchObject({ kind: "cancelled", status: "cancelled" });
    expect(error.details).toMatchObject({ worker: "W1", status: "cancelled", completionWait: "unbounded" });
  });

  it("opt-in keeps real failures: a worker whose model fails ends failed, not waited on", async () => {
    const { execute, workerFaux } = await fixture({ completionWait: () => "unbounded", limits: tight });
    workerFaux.setResponses(Array.from({ length: 6 }, () => reply("", { stopReason: "error", errorMessage: "provider exploded" })));
    const error = await rejection(execute());
    expect(error.failure).not.toMatchObject({ kind: "cancelled" });
    expect(error.details.status).not.toBe("cancelled");
    expect(error.message).not.toMatch(/timed out/);
  });

  it("an invalid flag value fails the assignment before any worker starts (no silent finite fallback)", async () => {
    const { execute, workerFaux } = await fixture({ completionWait: () => parseCompletionWait("forever"), limits: tight });
    workerFaux.setResponses([explored()]);
    await expect(execute()).rejects.toThrow(/--orche-completion-wait: expected "unbounded"/);
    expect(workerFaux.getPendingResponseCount()).toBe(1);
  });

  it("no idle-expiry retirement between assignments, with or without the completion wait (workers live for the session)", async () => {
    const run = async (completionWait?: () => CompletionWait) => {
      const h = await createHarness({ mainSteps: [], orcheSteps: [explored()] });
      opened.push(h);
      execFileSync("git", ["init", "-q"], { cwd: h.cwd });
      const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
      const pool = new WorkerPool({ controller, agentDir: h.agentDir, ...(completionWait ? { completionWait } : {}) });
      opened.push(pool);
      await pool.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false });
      await sleep(400);
      return pool.list().map(worker => worker.id);
    };
    expect(await run(() => "unbounded")).toEqual(["W1"]);
    expect(await run()).toEqual(["W1"]);
  });
});

describe("completion wait: nested work of the assignment", () => {
  const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
  const request = "Intent/Purpose: fix the greeting\nR1: greeting.txt says hello.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
  const plan = () => tool("task_plan", { nodes: [{ id: "fix", title: "Fix greeting", dependsOn: [], covers: ["R1"], status: "running" }] });

  it("an orche_spawn sub-worker silent past the base cap (extensions off) is waited for, and reports without a deadline stop", async () => {
    const { execute, workerFaux } = await fixture({ completionWait: () => "unbounded", limits: { assignmentMs: 500, maxExtensions: 0, observeMs: 100 } });
    const final = tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: { decision: "split", criteria: ["verification"], reason: "asked" } } });
    const steps: FauxResponseStep[] = [
      plan(),
      tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] }),
      late(1500, () => tool("report_result", { kind: "verify", summary: "ok", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } })),
      final, final,
    ];
    workerFaux.setResponses(Array.from({ length: 5 }, () => (async (context, ...rest) => { const step = steps.shift()!; return typeof step === "function" ? step(context, ...rest) : step; }) as FauxResponseStep));
    const result = await execute({ role: "implement", request });
    expect(result.details.status).toBe("done");
    expect(result.details.spawned).toHaveLength(1);
    expect(result.details.spawned![0]).toMatchObject({ status: "passed" });
    expect(result.details.spawned![0]!.deadline).toMatchObject({ unbounded: true });
    expect(result.details.spawned![0]!.deadline?.notExtended).toBeUndefined();
  });

  it("the plan advisor is not cut by its wall-clock bound: notes that come after it are still delivered and processed", async () => {
    const { execute, workerFaux, advisorFaux } = await fixture({ completionWait: () => "unbounded", limits: { assignmentMs: 600, maxExtensions: 0 }, single: { advisor: true }, models: { advisor: { model: "tier-advisor/a1", thinking: "low" } } });
    // The advisor's bound would be min(10 min, assignmentMs / 2) = 300 ms: its notes come after 1.2 s.
    advisorFaux.setResponses([late(1200, () => tool("report_result", { advice: "Check the trailing newline.", evidence: ["read greeting.txt"] }))]);
    const applied = { decision: "applied", reason: "Kept the trailing newline." };
    const reported = (advice?: typeof applied) => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: { decision: "none", criteria: [], reason: "small" }, ...(advice ? { advice } : {}) } });
    workerFaux.setResponses([plan(), reported(), reported(applied)]);
    const result = await execute({ role: "implement", request });
    expect(result.details.status).toBe("done");
    expect(result.details.advisor).toMatchObject({ status: "processed" });
    expect(result.details.advisor?.error).toBeUndefined();
  });
});

describe("completion wait: the CLI flag of a real session", () => {
  const harness = async (flags?: Record<string, string>) => {
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt" }), reply("relayed")],
      orcheSteps: [explored()],
      ...(flags ? { flags } : {}),
    });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await h.session.prompt("delegate");
    const result = h.session.messages.find(message => message.role === "toolResult" && (message as unknown as { toolName?: string }).toolName === "orche_task") as unknown as { content: { text?: string }[]; details?: Record<string, unknown> };
    return { text: result.content.map(part => part.text ?? "").join("\n"), details: result.details ?? {} };
  };
  it(`--${COMPLETION_WAIT_FLAG} unbounded reaches orche_task of that session only; a session without it keeps its deadline`, async () => {
    const on = await harness({ [COMPLETION_WAIT_FLAG]: "unbounded" });
    expect(on.text).toContain(COMPLETION_WAIT_LINE);
    expect(on.details.completionWait).toBe("unbounded");
    expect(on.details.deadline).toBeUndefined();
    const off = await harness();
    expect(off.text).not.toContain("Completion wait");
    expect(off.details.completionWait).toBeUndefined();
    expect(off.details.deadline).toMatchObject({ baseMs: 30 * 60_000, maxExtensions: 10 });
  });
});
