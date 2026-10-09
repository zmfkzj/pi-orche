import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runSpecialistSession, SpecialistError, type SpecialistDeadline } from "../../src/specialists/session.js";
import { resolveRunLimits } from "../../src/orchestration/limits.js";
import type { DeadlineExtension, WaitObservation } from "../../src/orchestration/run/extension.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * The activity-aware deadline of a specialist call (orche_spawn sub-workers), on fake timers: hours of simulated time, no real
 * waiting. The session's own events decide: a long tool that keeps reporting is extended 10, 20, ... 100 minutes; a silent one
 * is not; an explicit fixed extensionMs keeps fixed extensions; the caller's cancellation wins; no timer outlives the call.
 */
const MIN = 60_000;
const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
const report = { name: "report_answer", label: "Report answer", description: "Submit once.", parameters: Type.Object({ answer: Type.Integer() }) };

/** A long render: it reports progress every minute (a tool update) until `release` or until it is aborted; nothing is written. */
function renderTool() {
  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => { release = resolve; });
  const definition: ToolDefinition = {
    name: "render", label: "Render", description: "Renders for a long time.", parameters: Type.Object({}),
    execute: async (_id, _args, signal, onUpdate) => {
      const timer = setInterval(() => onUpdate?.({ content: [{ type: "text", text: "frame" }], details: {} }), MIN);
      try {
        await new Promise<void>(resolve => { void released.then(resolve); signal?.addEventListener("abort", () => resolve(), { once: true }); });
      } finally { clearInterval(timer); }
      return { content: [{ type: "text", text: "rendered" }], details: {} };
    },
  };
  return { definition, release: () => release() };
}

/** A model request that never answers until the call is aborted (no events at all: the session is silent). */
const silent: FauxResponseStep = async (_context, options) => {
  await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  return reply("aborted");
};

async function start(steps: FauxResponseStep[], deadline: Partial<SpecialistDeadline> & Pick<SpecialistDeadline, "limits">, options: { signal?: AbortSignal; customTools?: ToolDefinition[] } = {}) {
  const faux = await fauxRuntime(steps);
  const extensions: DeadlineExtension[] = [];
  const observations: WaitObservation[] = [];
  const promise = runSpecialistSession({
    actor: "W1.1", route: faux.route, runtime: faux.runtime, cwd: process.cwd(), instructions: "Work.", prompt: "Render it.",
    tools: (options.customTools ?? []).map(definition => definition.name), customTools: options.customTools ?? [], report, maxTurns: 10, timeoutMs: 1, signal: options.signal ?? new AbortController().signal,
    deadline: { onExtended: extension => extensions.push(extension), onObservation: observation => observations.push(observation), ...deadline },
  });
  const settled = promise.then(value => ({ value }), (error: unknown) => ({ error }));
  return { promise, settled, extensions, observations };
}

async function advance(settled: Promise<unknown>, totalMs: number): Promise<void> {
  let done = false;
  void settled.then(() => { done = true; });
  for (let step = 0; step < totalMs && !done; step += MIN) await vi.advanceTimersByTimeAsync(MIN);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("specialist session: activity-aware deadline", () => {
  it("defaults: a long render that keeps reporting is extended 10, 20, ... 100 minutes and stops at 580 minutes (budget)", async () => {
    const render = renderTool();
    const { settled, extensions, observations } = await start([tool("render", {}), reply("done")], { limits: resolveRunLimits() }, { customTools: [render.definition] });
    await advance(settled, 600 * MIN);
    const { error } = await settled as { error: SpecialistError };
    expect(error).toBeInstanceOf(SpecialistError);
    expect(error.cancelled).toBe(false);
    expect(error.message).toBe("W1.1: timed out after 34800s (extension budget 10/10 used)");
    expect(extensions.map(extension => extension.extensionMs / MIN)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(extensions.map(extension => Math.round(extension.elapsedMs / MIN))).toEqual([30, 40, 60, 90, 130, 180, 240, 310, 390, 480]);
    expect(extensions[0]!.reasons[0]).toMatch(/^W1\.1 render running 30m, update (\d+s|1m) ago$/);
    expect(error.stats.deadline).toMatchObject({ baseMs: 30 * MIN, hardLimitMs: 580 * MIN, maxExtensions: 10, notExtended: { reason: "budget", message: "extension budget 10/10 used" } });
    expect(error.stats.deadline!.extensions).toHaveLength(10);
    // Observed every 5 minutes, also inside the 100-minute extension; the render wrote nothing and recorded no progress.
    expect(observations.length).toBeGreaterThanOrEqual(115);
    expect(new Set(observations.slice(1).map((observation, index) => observation.at - observations[index]!.at))).toEqual(new Set([5 * MIN]));
    expect(observations.every(observation => observation.alive && observation.progress === "unknown")).toBe(true);
    expect(error.stats.deadline!.observations).toBe(observations.length);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an explicit fixed extensionMs keeps fixed extensions (30 min + 10 x 30 min = 5 h 30 min)", async () => {
    const render = renderTool();
    const { settled, extensions } = await start([tool("render", {}), reply("done")], { limits: resolveRunLimits({ extensionMs: 30 * MIN }) }, { customTools: [render.definition] });
    await advance(settled, 400 * MIN);
    const { error } = await settled as { error: SpecialistError };
    expect(error.message).toBe("W1.1: timed out after 19800s (extension budget 10/10 used)");
    expect(extensions.map(extension => extension.extensionMs / MIN)).toEqual(Array(10).fill(30));
    expect(error.stats.deadline).toMatchObject({ hardLimitMs: 330 * MIN });
  });

  it("a silent session is not extended at the base expiry (idle), with the base as its time", async () => {
    const { settled, extensions } = await start([silent], { limits: resolveRunLimits() });
    await advance(settled, 60 * MIN);
    const { error } = await settled as { error: SpecialistError };
    expect(error.message).toBe("W1.1: timed out after 1800s (not extended: no activity in the last 2m)");
    expect(error.cancelled).toBe(false);
    expect(extensions).toEqual([]);
    expect(error.stats.deadline).toMatchObject({ notExtended: { reason: "idle" } });
    expect(Date.now()).toBe(30 * MIN);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes normally inside an extension, reporting what it got; maxExtensions 0 and observeMs 0 keep the plain base cap", async () => {
    const render = renderTool();
    setTimeout(() => render.release(), 47 * MIN);
    const done = await start([tool("render", {}), tool("report_answer", { answer: 42 })], { limits: resolveRunLimits() }, { customTools: [render.definition] });
    await advance(done.settled, 60 * MIN);
    const { value } = await done.settled as { value: Awaited<typeof done.promise> };
    expect(value.value).toEqual({ answer: 42 });
    expect(value.stats.deadline).toMatchObject({ extensions: [{ n: 1, extensionMs: 10 * MIN }, { n: 2, extensionMs: 20 * MIN }], observations: 9 });
    expect(value.stats.deadline!.notExtended).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    const capped = renderTool();
    const plain = await start([tool("render", {}), reply("done")], { limits: resolveRunLimits({ maxExtensions: 0, observeMs: 0 }) }, { customTools: [capped.definition] });
    await advance(plain.settled, 60 * MIN);
    const { error } = await plain.settled as { error: SpecialistError };
    expect(error.message).toBe("W1.1: timed out after 1800s");
    expect(plain.extensions).toEqual([]);
    expect(plain.observations).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops an extension when the session goes silent for 2 consecutive checks (stalled)", async () => {
    // The render reports until 40 minutes, then hangs silently (an update-less tool past its 10-minute bound).
    let quiet = false;
    const hang: ToolDefinition = {
      name: "render", label: "Render", description: "Hangs.", parameters: Type.Object({}),
      execute: async (_id, _args, signal, onUpdate) => {
        const timer = setInterval(() => { if (!quiet) onUpdate?.({ content: [{ type: "text", text: "frame" }], details: {} }); }, MIN);
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
        clearInterval(timer);
        return { content: [{ type: "text", text: "stopped" }], details: {} };
      },
    };
    setTimeout(() => { quiet = true; }, 40 * MIN + 30_000);
    const { settled, extensions } = await start([tool("render", {}), reply("done")], { limits: resolveRunLimits() }, { customTools: [hang] });
    await advance(settled, 200 * MIN);
    const { error } = await settled as { error: SpecialistError };
    // Granted at 30 (10 min) and 40 (20 min, the last update at 40 is in the window); silent checks at 45 and 50 end it.
    expect(extensions.map(extension => extension.extensionMs / MIN)).toEqual([10, 20]);
    expect(error.message).toBe("W1.1: timed out after 3000s (stopped during extension 2/10: no activity in 2 consecutive checks 5m apart)");
    expect(error.stats.deadline).toMatchObject({ notExtended: { reason: "stalled", checks: 2 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the caller's cancellation wins over remaining extensions (cancelled, not a timeout) and clears every timer", async () => {
    const render = renderTool();
    const parent = new AbortController();
    setTimeout(() => parent.abort(new Error("W1 timed out")), 50 * MIN);
    const { settled, extensions } = await start([tool("render", {}), reply("done")], { limits: resolveRunLimits() }, { signal: parent.signal, customTools: [render.definition] });
    await advance(settled, 100 * MIN);
    const { error } = await settled as { error: SpecialistError };
    expect(error.cancelled).toBe(true);
    expect(error.message).toBe("W1.1: W1 timed out");
    expect(extensions).toHaveLength(2);
    expect(error.stats.deadline!.notExtended).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
