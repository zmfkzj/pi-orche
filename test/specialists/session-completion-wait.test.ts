import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep } from "@earendil-works/pi-ai";
import { runSpecialistSession, SpecialistError } from "../../src/specialists/session.js";
import { resolveRunLimits } from "../../src/orchestration/limits.js";
import type { WaitObservation } from "../../src/orchestration/run/extension.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * Completion wait of a specialist call (orche_spawn sub-workers and the plan advisor; src/orchestration/completion-wait.ts), on fake
 * timers: a session silent for 12 hours (past the default 9h40m ceiling and any idle/stall rule) is still waited for; its result
 * arrives; the caller's cancellation still ends it; no timer outlives the call. The same call without the flag times out.
 */
const MIN = 60_000;
const report = { name: "report_answer", label: "Report answer", description: "Submit once.", parameters: Type.Object({ answer: Type.Integer() }) };
/** Silent until `release`, then answers with the report; aborted by the call's signal. */
function silentUntilReleased() {
  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => { release = resolve; });
  const step: FauxResponseStep = async (_context, options) => {
    const aborted = await new Promise<boolean>(resolve => { void released.then(() => resolve(false)); options?.signal?.addEventListener("abort", () => resolve(true), { once: true }); });
    return aborted ? reply("aborted") : reply([call("report_answer", { answer: 42 })], { stopReason: "toolUse" });
  };
  return { step, release: () => release() };
}
async function start(step: FauxResponseStep, options: { unbounded?: boolean; deadline?: boolean; signal?: AbortSignal }) {
  const faux = await fauxRuntime([step]);
  const observations: WaitObservation[] = [];
  const promise = runSpecialistSession({
    actor: "W1.1", route: faux.route, runtime: faux.runtime, cwd: process.cwd(), instructions: "Work.", prompt: "Think.",
    tools: [], report, maxTurns: 10, timeoutMs: 10 * MIN, signal: options.signal ?? new AbortController().signal,
    ...(options.unbounded ? { unbounded: true } : {}),
    ...(options.deadline ? { deadline: { limits: resolveRunLimits(), onObservation: (observation: WaitObservation) => observations.push(observation) } } : {}),
  });
  return { promise, settled: promise.then(value => ({ value }), (error: unknown) => ({ error })), observations };
}
async function advance(settled: Promise<unknown>, totalMs: number): Promise<void> {
  let done = false;
  void settled.then(() => { done = true; });
  for (let step = 0; step < totalMs && !done; step += MIN) await vi.advanceTimersByTimeAsync(MIN);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("specialist session: completion wait", () => {
  it.each([
    ["the fixed cap (the advisor's 10 minutes)", false],
    ["the activity-aware deadline (sub-workers: 30 min base, 9h40m ceiling, idle refusal, stall stop)", true],
  ])("unbounded removes %s: silent for 12 h, then the report arrives", async (_name, deadline) => {
    const silent = silentUntilReleased();
    const run = await start(silent.step, { unbounded: true, deadline });
    await advance(run.settled, 12 * 60 * MIN);
    let finished = false;
    void run.settled.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    silent.release();
    await advance(run.settled, MIN);
    const { value } = await run.settled as { value: Awaited<typeof run.promise> };
    expect(value.value).toEqual({ answer: 42 });
    if (deadline) {
      expect(value.stats.deadline).toMatchObject({ unbounded: true, extensions: [] });
      expect(value.stats.deadline!.notExtended).toBeUndefined();
      // Observed every 5 minutes for 12 hours, idle, never stopped by it.
      expect(run.observations.length).toBeGreaterThanOrEqual(140);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("unbounded keeps cancellation (deadline: %s)", async deadline => {
    const silent = silentUntilReleased();
    const parent = new AbortController();
    setTimeout(() => parent.abort(new Error("user cancelled")), 11 * 60 * MIN);
    const run = await start(silent.step, { unbounded: true, deadline, signal: parent.signal });
    await advance(run.settled, 12 * 60 * MIN);
    const { error } = await run.settled as { error: SpecialistError };
    expect(error).toBeInstanceOf(SpecialistError);
    expect(error.cancelled).toBe(true);
    expect(error.message).toBe("W1.1: user cancelled");
    expect(Date.now()).toBe(11 * 60 * MIN);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [false, "W1.1: timed out after 600s"],
    [true, "W1.1: timed out after 1800s (not extended: no activity in the last 2m)"],
  ])("without the flag the same silent call times out as before (deadline: %s)", async (deadline, message) => {
    const silent = silentUntilReleased();
    const run = await start(silent.step, { deadline });
    await advance(run.settled, 12 * 60 * MIN);
    const { error } = await run.settled as { error: SpecialistError };
    expect(error.message).toBe(message);
    expect(error.cancelled).toBe(false);
  });
});
