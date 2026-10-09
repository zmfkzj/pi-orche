import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executeSpawn, formatSpawn, type SpawnContext, type SpawnParameters } from "../../src/orchestrator/spawn.js";
import { createSubWorkerRunner } from "../../src/orchestrator/sub-worker.js";
import { resolveRunLimits, type RunLimits } from "../../src/orchestration/limits.js";
import { LivenessTracker } from "../../src/agent/liveness.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * orche_spawn sub-workers on the activity-aware deadline (the real runner and executeSpawn, a faux model, fake timers): each one
 * from its own start, by its own session; a sibling's failure stays its own; the orchestrator's end cancels them; deadline events
 * reach the status lines, the result and the outcome, but never the tool's partial output (the orchestrator's liveness).
 */
const MIN = 60_000;
const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
const roots: string[] = [];

function renderTool(releaseAt?: number): ToolDefinition {
  return {
    name: "render", label: "Render", description: "Renders for a long time.", parameters: Type.Object({}),
    execute: async (_id, _args, signal, onUpdate) => {
      const timer = setInterval(() => onUpdate?.({ content: [{ type: "text", text: "frame" }], details: {} }), MIN);
      try {
        await new Promise<void>(resolve => {
          if (releaseAt !== undefined) setTimeout(resolve, Math.max(0, releaseAt - Date.now()));
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally { clearInterval(timer); }
      return { content: [{ type: "text", text: "rendered" }], details: {} };
    },
  };
}

/** Both sub-workers share one faux provider: each response is chosen by the request it answers. */
const respond: FauxResponseFactory = async (context, options) => {
  const text = JSON.stringify(context.messages);
  const turns = context.messages.filter(message => message.role === "assistant").length;
  if (text.includes("Render the scene")) {
    return turns === 0 ? tool("render", {}) : tool("report_result", { kind: "game-asset", summary: "Scene rendered", data: { status: "done", outputs: [{ path: "assets/scene.png", type: "image", spec: "the scene" }], evidence: ["assets/scene.png"] } });
  }
  // The question sub-worker's model request never answers: its session is silent.
  await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  return reply("aborted");
};

async function setup(limits: RunLimits, render: ToolDefinition, signal?: AbortSignal) {
  const cwd = await mkdtemp(join(tmpdir(), "orche-subdeadline-"));
  roots.push(cwd);
  const faux = await fauxRuntime(Array.from({ length: 12 }, () => respond));
  const events = new Map<string, LivenessTracker>();
  let ids = 0;
  const context: SpawnContext = {
    orchestrator: "W1", nextId: () => `W1.${++ids}`, ...(signal ? { signal } : {}),
    runWorker: createSubWorkerRunner({
      orchestrator: "W1", cwd, runtime: faux.runtime, route: faux.route, routeSource: "orchestrator", thinkingSource: "orchestrator",
      specialistRoute: () => faux.route, imageTool: () => render, prompt: worker => worker.request, timeoutMs: 1, maxTurns: 10,
      deadline: { limits },
      onSessionEvent: (id, event) => { let tracker = events.get(id); if (!tracker) { tracker = new LivenessTracker({ id, role: "sub-worker" }); events.set(id, tracker); } tracker.observe(event); },
    }),
  };
  const updates: number[] = [];
  const progress: string[][] = [];
  context.onProgress = lines => { progress.push(lines); };
  return { context, events, updates, progress, onUpdate: () => { updates.push(Date.now()); } };
}

async function advance(promise: Promise<unknown>, totalMs: number): Promise<void> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let step = 0; step < totalMs && !done; step += MIN) await vi.advanceTimersByTimeAsync(MIN);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); vi.setSystemTime(0); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const both: SpawnParameters = { reason: "isolation", workers: [
  { name: "scene", role: "game-asset", request: "Render the scene into assets/.", files: ["assets/"] },
  { name: "question", role: "answer", request: "Answer the question about the engine." },
] };

describe("orche_spawn sub-workers: activity-aware deadline", () => {
  it("extends a rendering sub-worker by its own activity while its silent sibling times out alone; the outcome, result and status lines show it", async () => {
    const setupDone = await setup(resolveRunLimits(), renderTool(77 * MIN));
    const { context, events, updates, progress, onUpdate } = setupDone;
    let renderAliveAt50: boolean | undefined;
    setTimeout(() => { renderAliveAt50 = events.get("W1.1")?.session(Date.now()).active; }, 50 * MIN);
    const running = executeSpawn(context, both, undefined, onUpdate);
    await advance(running, 120 * MIN);
    const { details, text } = await running;
    const [scene, question] = details.workers;
    // The renderer: extended at 30 (+10m), 40 (+20m) and 60 (+30m) by its own render tool, done at 77 minutes.
    expect(scene).toMatchObject({ id: "W1.1", status: "done", deadline: { baseMs: 30 * MIN, hardLimitMs: 580 * MIN, maxExtensions: 10, extendedMs: 60 * MIN, observations: 15 } });
    expect(scene!.deadline!.extensions.map(extension => [Math.round(extension.elapsedMs / MIN), extension.extensionMs / MIN])).toEqual([[30, 10], [40, 20], [60, 30]]);
    expect(scene!.deadline!.extensions.every(extension => extension.reasons.every(reason => reason.startsWith("W1.1 render running")))).toBe(true);
    expect(scene!.deadline!.notExtended).toBeUndefined();
    // The silent sibling: not extended at its base expiry, failed by itself; the call itself did not fail.
    expect(question).toMatchObject({ id: "W1.2", status: "failed", error: "W1.2: timed out after 1800s (not extended: no activity in the last 2m)", deadline: { extensions: [], notExtended: { reason: "idle", message: "not extended: no activity in the last 2m" } } });
    expect(text).toBe(formatSpawn(details));
    expect(text).toContain("Deadline: base 30m, 3/10 extensions (+1h: +10m, +20m, +30m)");
    expect(text).toContain("Deadline: base 30m, 0/10 extensions; stopped: not extended: no activity in the last 2m");
    // Status lines carry the extensions and checks of each sub-worker.
    const flat = progress.flat();
    expect(flat.some(line => /^W1 → W1\.1 scene \(game-asset · .*\): last tool render · ext 1\/10 \(\+10m\): W1\.1 render running 30m/.test(line))).toBe(true);
    expect(flat.some(line => /^W1 → W1\.1 scene .*· ext 3 · check 1[0-4]: alive$/.test(line))).toBe(true);
    // The orchestrator's liveness sees the renderer's own session events (the parent merge), alive at 50 minutes.
    expect(renderAliveAt50).toBe(true);
    // Deadline events never produced partial tool output: between 2 and 76 minutes the only update is the sibling's end at 30 minutes,
    // although 3 extensions and 15 checks of the renderer happened in that time.
    expect(updates.filter(at => at > 2 * MIN && at < 76 * MIN)).toEqual([30 * MIN]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the orchestrator's end cancels its sub-workers at once, remaining extensions notwithstanding; 1-minute checks never count as its activity", async () => {
    const parent = new AbortController();
    const limits = resolveRunLimits({ observeMs: MIN });
    const { context, updates, progress, onUpdate } = await setup(limits, renderTool(), parent.signal);
    setTimeout(() => parent.abort(new Error("W1 timed out")), 50 * MIN);
    const running = executeSpawn(context, { reason: "isolation", workers: [both.workers[0]!] }, undefined, onUpdate);
    await advance(running, 100 * MIN);
    const { details } = await running;
    expect(details.workers[0]).toMatchObject({ status: "cancelled", error: "W1.1: W1 timed out", deadline: { extensions: [{ n: 1 }, { n: 2 }] } });
    expect(details.workers[0]!.deadline!.notExtended).toBeUndefined();
    expect(details.workers[0]!.deadline!.observations).toBeGreaterThanOrEqual(49);
    expect(progress.flat().some(line => / · check \d+: alive$/.test(line))).toBe(true);
    expect(updates.filter(at => at > 2 * MIN && at < 50 * MIN)).toEqual([]);
    expect(Date.now()).toBe(50 * MIN);
    expect(vi.getTimerCount()).toBe(0);
  });
});
