import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, FauxResponseFactory } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import type { SessionLiveness } from "../../src/agent/liveness.js";
import { createHarness, tool } from "./harness.js";

/**
 * The assignment's liveness includes its orche_spawn sub-workers (their own session events), so a long sub-worker keeps the
 * orchestrator's assignment alive even when the orchestrator itself only waits in orche_spawn. Observed through the periodic
 * observation (limits.observeMs) with the orchestrator's own verdict forced to idle.
 */
const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = "Intent/Purpose: answer two questions\nRequirements:\nR1: both answers are given.\nConstraints and non-goals: read-only.\nOriginal request\n두 질문에 답해줘.";
type Context = Parameters<FauxResponseFactory>[0];
const firstUser = (context: Context) => JSON.stringify(context.messages.find(message => message.role === "user"));
const subWorkerOf = (context: Context) => /You are sub-worker (W\d+\.\d+)/.exec(firstUser(context))?.[1];
const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;

describe("orche_task liveness counts the orche_spawn sub-workers", () => {
  it("an orchestrator waiting in orche_spawn is alive while its sub-workers work, and the observation names them", async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const respond: FauxResponseFactory = async context => {
      const sub = subWorkerOf(context);
      if (sub) {
        await released; // a long model request of the sub-worker
        return tool("report_result", { kind: "answer", summary: `${sub} answered`, data: { evidence: ["notes.txt:1"] } }) as AssistantMessage;
      }
      if (turnOf(context) === 0) return tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "first", role: "answer", request: "Answer question one." }, { name: "second", role: "answer", request: "Answer question two." }] }) as AssistantMessage;
      return tool("report_result", { kind: "answer", summary: "Both answered", data: { evidence: ["W1.1", "W1.2"], checklist: [{ id: "R1", status: "met", evidence: "both sub-worker reports" }], split: { decision: "split", criteria: ["parallelism"], reason: "two independent questions" } } }) as AssistantMessage;
    };
    const h = await createHarness({ mainSteps: [], orcheSteps: Array.from({ length: 6 }, () => respond) });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", limits: { assignmentMs: 20_000, observeMs: 100 } }));
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const pool = new WorkerPool({ controller, agentDir: h.agentDir });
    opened.push(pool);
    // The orchestrator's own session looks idle: only its sub-workers can make the assignment alive.
    vi.spyOn(pool, "workerLiveness").mockImplementation((id: string): SessionLiveness => ({ id, role: "analyst", state: "idle", active: false, detail: "idle" }));
    const lines: string[] = [];
    const running = pool.execute({ role: "answer", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", onProgress: progress => { lines.push(...progress); } });
    await vi.waitFor(() => expect(lines.some(line => /^⏱ check \d+ at \d+s: alive \(W1\.[12] request in flight/.test(line))).toBe(true), { timeout: 10_000 });
    release();
    const result = await running;
    expect(result.details.status).toBe("completed");
    expect(result.details.spawned?.map(worker => worker.status)).toEqual(["done", "done"]);
    expect(result.details.observations).toMatchObject({ everyMs: 100 });
    expect(result.details.observations!.count).toBeGreaterThan(0);
    // Each sub-worker ran on this assignment's resolved limits (base assignmentMs, the default linear schedule).
    for (const worker of result.details.spawned ?? []) expect(worker.deadline).toMatchObject({ baseMs: 20_000, maxExtensions: 10, hardLimitMs: 20_000 + 550 * 60_000, extensions: [] });
  });

  it("a timed-out orchestrator cancels its running sub-workers at once, whatever extensions they have left", async () => {
    const aborted = new Set<string>();
    const respond: FauxResponseFactory = async (context, options) => {
      const sub = subWorkerOf(context);
      if (sub) {
        // A sub-worker whose request runs until it is cancelled.
        await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
        aborted.add(sub);
        return { ...tool("report_result", { kind: "answer", summary: "late" }), stopReason: "aborted" } as AssistantMessage;
      }
      return tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "first", role: "answer", request: "Answer question one." }, { name: "second", role: "answer", request: "Answer question two." }] }) as AssistantMessage;
    };
    const h = await createHarness({ mainSteps: [], orcheSteps: Array.from({ length: 6 }, () => respond) });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    // No extensions for the orchestrator: it times out at its base while its sub-workers (the same limits) are still busy.
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", limits: { assignmentMs: 1_500, maxExtensions: 0 } }));
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const pool = new WorkerPool({ controller, agentDir: h.agentDir });
    opened.push(pool);
    const error = await pool.execute({ role: "answer", request, cwd: h.cwd, projectTrusted: false, mainMode: "single" }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toMatch(/^Worker W1 timed out after 1500ms/);
    await vi.waitFor(() => expect([...aborted].sort()).toEqual(["W1.1", "W1.2"]), { timeout: 5_000 });
  });
});
