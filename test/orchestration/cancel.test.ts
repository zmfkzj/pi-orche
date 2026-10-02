import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import type { RunLimits } from "../../src/orchestration/limits.js";

afterEach(() => vi.restoreAllMocks());
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "edit", owner: "A1", files: ["core.mjs"], status: "pending" };

async function run(steps: FauxResponseStep[], controller: AbortController, events: RunEvent[] = [], limits?: Partial<RunLimits>) {
  const dir = await mkdtemp(join(tmpdir(), "orche-cancel-"));
  const f = await fauxRuntime(steps);
  try {
    return await runOrchestrated({ problem: "edit core", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, signal: controller.signal, sink: event => events.push(event), limits });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RunOptions.signal", () => {
  it("cancels a run while a worker is mid-turn: failed report, every session disposed, no later spawns", async () => {
    const entered = deferred();
    const blockedWorker: FauxResponseStep = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
      return reply("stopped") as AssistantMessage;
    };
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const running = run([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "edit" }),
      decision({ type: "assign", tasks: [task] }),
      tool("read", { path: "nonexistent.txt" }),
      blockedWorker,
    ], controller, events);
    await entered.promise;
    controller.abort();
    const report = await running;
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    expect(report.cancellation).toMatchObject({
      scope: "cancelled", phase: "EXECUTE", stage: "implement backlog", elapsedMs: expect.any(Number), timestamp: expect.any(Number),
      configuredCapMs: 1800000, effectiveCapMs: expect.any(Number),
      workers: expect.arrayContaining([
        expect.objectContaining({ id: "A1", status: "running", kind: "implement", taskId: "change", assignmentId: expect.any(String), requestCount: 1, lastToolName: "read", lastToolAt: expect.any(Number), lastActivityAt: expect.any(Number) }),
        expect.objectContaining({ id: "V1", status: "idle" }),
      ]),
    });
    expect(report.timeouts).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_started", agentId: "A1", toolName: "read" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "worker_activity", agentId: "A1", kind: "implement", requestCount: 1, lastToolName: "read" }));
    expect(dispose).toHaveBeenCalledTimes(3); // coordinator, worker A1, verifier V1
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "failed", summary: "cancelled" });
  });

  it("overall timeout during implementation includes task, assignment and last tool activity", async () => {
    const events: RunEvent[] = [];
    const blocked: FauxResponseStep = async (_context, options) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("stopped");
    };
    const report = await run([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "edit" }),
      decision({ type: "assign", tasks: [task] }),
      tool("read", { path: "nonexistent.txt" }), blocked,
    ], new AbortController(), events, { overallMs: 250, assignmentMs: 1000, decisionMs: 1000, maxExtensions: 0 });
    expect(report.summary).toContain("overall timeout at implement backlog");
    expect(report.timeouts?.[0]).toMatchObject({ scope: "overall", workers: expect.arrayContaining([expect.objectContaining({
      id: "A1", taskId: "change", kind: "implement", assignmentId: expect.any(String), requestCount: 1,
      lastToolName: "read", lastToolAt: expect.any(Number), lastActivityAt: expect.any(Number),
    })]) });
    expect(events.filter(e => e.type === "run_finished")).toHaveLength(1);
  });

  it("an already-aborted signal returns a cancelled report without creating any session", async () => {
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const controller = new AbortController();
    controller.abort();
    const report = await run([], controller);
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    expect(report.cancellation).toMatchObject({ scope: "cancelled", stage: "startup/runtime", phase: "EXPLORE", workers: [] });
    expect(dispose).not.toHaveBeenCalled();
  });
});
