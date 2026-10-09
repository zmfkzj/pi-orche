import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Liveness } from "../../src/agent/liveness.js";
import { resolveRunLimits } from "../../src/orchestration/limits.js";
import {
  ExtendableDeadline, describeProgress, formatExtensionSummary, formatObservation, waitExtendable,
  type DeadlineExtension, type ProgressSample, type WaitObservation,
} from "../../src/orchestration/run/extension.js";

/**
 * The linear extension schedule (10, 20, ... 100 minutes after a 30-minute base: 580 minutes at most) and the observer of
 * waitExtendable, on fake timers: hours of simulated time, no real waiting. The observer samples at a fixed period whatever the
 * length of the current extension, ends an extension only after consecutive observations without any sign of life, and never
 * because no progress was recorded.
 */
const MIN = 60_000;
const live = (...reasons: string[]): Liveness => ({ active: reasons.length > 0, reasons, sessions: [] });
const ACTIVE = live("W1 bash running 40m, cpu/io activity 5s ago");
type Wait = { type: "timeout" } | { type: "outcome"; outcome: string };
/** `manager.wait(id, ms)` on fake timers: a timeout once `ms` passed. */
const timerWait = (ms: number) => new Promise<Wait>(resolve => setTimeout(() => resolve({ type: "timeout" }), ms));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

async function runFor<T>(promise: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  void promise.finally(() => { settled = true; });
  for (let step = 0; step < ms && !settled; step += MIN) await vi.advanceTimersByTimeAsync(MIN);
  return promise;
}

describe("linear extension schedule (defaults)", () => {
  it("grants 10, 20, ... 100 minutes after the 30-minute base and stops at 580 minutes = 9 h 40 min", async () => {
    const limits = resolveRunLimits();
    const deadline = ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs });
    expect(deadline.hardLimitMs).toBe(580 * MIN);
    const granted: DeadlineExtension[] = [];
    const result = await runFor(waitExtendable<Wait>({ deadline, wait: timerWait, liveness: () => ACTIVE, stage: "W1 implement", onExtended: extension => granted.push(extension) }), 600 * MIN);
    expect(granted.map(extension => extension.extensionMs / MIN)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    // The first extension happens when the 30-minute base expires; each next one when the previous extension ends.
    expect(granted.map(extension => extension.elapsedMs / MIN)).toEqual([30, 40, 60, 90, 130, 180, 240, 310, 390, 480]);
    expect(result).toMatchObject({ type: "timeout", notExtended: { reason: "budget", n: 10, max: 10, message: "extension budget 10/10 used" } });
    expect(Date.now()).toBe(580 * MIN);
    expect(deadline.overallCapMs).toBe(580 * MIN);
    expect(deadline.summary()[0]).toBe("Timeout extensions: 10/10 used (+10m, +20m … +1h40m), +9h10m in total");
    expect(deadline.summary()[1]).toMatch(/^ {2}1\/10 at 30m \(\+10m\), assignment "W1 implement": W1 bash running 40m/);
    expect(deadline.summary()[10]).toMatch(/^ {2}10\/10 at 8h \(\+1h40m\), assignment/);
  });

  it("an explicit fixed extensionMs keeps the old schedule (30 min base + 10 × 30 min = 5 h 30 min)", async () => {
    const limits = resolveRunLimits({ extensionMs: 30 * MIN });
    const deadline = ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs });
    const granted: number[] = [];
    await runFor(waitExtendable<Wait>({ deadline, wait: timerWait, liveness: () => ACTIVE, stage: "s", onExtended: extension => granted.push(extension.extensionMs / MIN) }), 400 * MIN);
    expect(granted).toEqual(Array(10).fill(30));
    expect(Date.now()).toBe(330 * MIN);
    expect(formatExtensionSummary(deadline.extensions, { maxExtensions: 10, extensionMs: deadline.extensionMs, extensionStepMs: deadline.extensionStepMs })[0]).toBe("Timeout extensions: 10/10 used (+30m each), +5h in total");
  });

  it("a phase cap and the overall deadline expiring together spend ONE extension of the scheduled length", () => {
    let now = 0;
    const deadline = new ExtendableDeadline({ startedAt: 0, overallMs: 100, extensionMs: 10, extensionStepMs: 10, maxExtensions: 3, activityWindowMs: 120_000, now: () => now });
    const phase = deadline.phase(100, "assignment", 0);
    now = 100;
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: true, n: 1, newDeadline: 110 });
    // The overall timer of the same instant finds the deadline already moved: nothing more is spent.
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE, expired: 100 })).toMatchObject({ extended: true, fresh: false, n: 1, newDeadline: 110 });
    expect(deadline.used).toBe(1);
    now = 110;
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ extended: true, fresh: true, n: 2, newDeadline: 130 });
    expect(phase.deadline).toBe(130);
    now = 130;
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ n: 3, newDeadline: 160 });
    expect(deadline.hardLimitMs).toBe(160);
    expect(deadline.extensions.map(extension => extension.extensionMs)).toEqual([10, 20, 30]);
  });
});

describe("observer of waitExtendable: fixed period, independent of the extension length", () => {
  it("observes every 5 minutes through all 580 minutes, also inside the 100-minute extension, and leaves no timer behind", async () => {
    const limits = resolveRunLimits();
    const deadline = ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs });
    const observations: WaitObservation[] = [];
    const result = await runFor(waitExtendable<Wait>({
      deadline, wait: timerWait, liveness: () => ACTIVE, stage: "s", observeEveryMs: limits.observeMs, onObservation: observation => observations.push(observation),
    }), 600 * MIN);
    expect(result).toMatchObject({ type: "timeout", notExtended: { reason: "budget" } });
    const times = observations.map(observation => observation.at / MIN);
    // One check every 5 minutes from 5 min on: the period does not grow with the extensions.
    expect(times.slice(0, 5)).toEqual([5, 10, 15, 20, 25]);
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(new Set(gaps)).toEqual(new Set([5]));
    expect(observations.length).toBeGreaterThanOrEqual(115);
    // Inside the last extension (100 minutes, from 480 to 580): twenty checks, as many as in any other 100 minutes.
    expect(observations.filter(observation => observation.at > 480 * MIN && observation.at <= 580 * MIN).length).toBeGreaterThanOrEqual(19);
    expect(observations.filter(observation => observation.at > 30 * MIN && observation.at <= 130 * MIN).length).toBe(20);
    expect(observations.every(observation => observation.alive && observation.inactiveStreak === 0)).toBe(true);
    expect(observations.find(observation => observation.at === 35 * MIN)).toMatchObject({ inExtension: true, extensionsUsed: 1 });
    expect(observations[0]).toMatchObject({ n: 1, inExtension: false, extensionsUsed: 0, progress: "unknown" });
    // The observer's timer is gone once the wait returned.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends an extension after 2 consecutive checks without any sign of life; inactivity in the base window does not", async () => {
    const deadline = ExtendableDeadline.fromLimits(resolveRunLimits(), { baseMs: 30 * MIN });
    // Silent between 5 and 25 minutes (the base window), active through the first extension (30 -> 40), silent from 41 minutes on,
    // inside the second extension (40 -> 60): the stall ends it at the 2nd silent check (50), ten minutes before that extension would end.
    const liveness = () => {
      const minute = Date.now() / MIN;
      return minute >= 26 && minute < 41 ? ACTIVE : live();
    };
    const observations: WaitObservation[] = [];
    const result = await runFor(waitExtendable<Wait>({ deadline, wait: timerWait, liveness, stage: "s", observeEveryMs: 5 * MIN, onObservation: observation => observations.push(observation) }), 200 * MIN);
    expect(result).toMatchObject({ type: "timeout", notExtended: { reason: "stalled", n: 2, max: 10, checks: 2, everyMs: 5 * MIN, message: "stopped during extension 2/10: no activity in 2 consecutive checks 5m apart" } });
    // Five silent checks in the base window did not end it.
    expect(observations.filter(observation => !observation.inExtension && !observation.alive)).toHaveLength(5);
    expect(deadline.used).toBe(2);
    expect(Date.now()).toBe(50 * MIN);
    expect(observations.at(-1)).toMatchObject({ at: 50 * MIN, alive: false, inExtension: true, inactiveStreak: 2 });
    // The observer stopped with the wait: no further checks; only the abandoned wait's own timer was left, and it just fires.
    const seen = observations.length;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(observations).toHaveLength(seen);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a long quiet build with no recorded progress is never stopped for it; progress evidence is reported apart from liveness", async () => {
    const deadline = ExtendableDeadline.fromLimits(resolveRunLimits({ maxExtensions: 3 }), { baseMs: 30 * MIN });
    let sample: ProgressSample = { evidence: 0, activity: "Task DAG 0/4 done, 1 tool call, 6 compactions" };
    setTimeout(() => { sample = { evidence: 1, lastEvidenceAt: Date.now(), last: "node build done (1/4)", activity: "Task DAG 1/4 done, 2 tool calls, 6 compactions" }; }, 12 * MIN);
    const observations: WaitObservation[] = [];
    const granted: DeadlineExtension[] = [];
    const result = await runFor(waitExtendable<Wait>({
      deadline, wait: timerWait, liveness: () => ACTIVE, stage: "s", observeEveryMs: 5 * MIN, progress: () => sample,
      onObservation: observation => observations.push(observation), onExtended: extension => granted.push(extension),
    }), 120 * MIN);
    // 30 + 10 + 20 + 30 = 90 minutes: the budget, not the missing progress, ended it.
    expect(result).toMatchObject({ type: "timeout", notExtended: { reason: "budget" } });
    expect(Date.now()).toBe(90 * MIN);
    expect(observations.find(observation => observation.at === 5 * MIN)).toMatchObject({ alive: true, progress: "none", progressDetail: "none recorded yet; Task DAG 0/4 done, 1 tool call, 6 compactions; not a stop reason" });
    expect(observations.find(observation => observation.at === 15 * MIN)).toMatchObject({ alive: true, progress: "evidence", progressDetail: "1 new since last check (last: node build done (1/4), 3m ago); Task DAG 1/4 done, 2 tool calls, 6 compactions" });
    expect(observations.find(observation => observation.at === 85 * MIN)).toMatchObject({ alive: true, progress: "none", progressDetail: expect.stringMatching(/^none recorded for 1h13m \(last: node build done/) });
    expect(formatObservation(observations.find(observation => observation.at === 85 * MIN)!)).toMatch(/^⏱ check 17 at 1h25m: alive \(W1 bash running 40m, cpu\/io activity 5s ago\) · progress: none recorded for 1h13m/);
    // Extension records carry the progress statement next to the liveness reasons.
    expect(granted[0]!.progress).toMatch(/^none recorded for 18m \(last: node build done \(1\/4\), 18m ago\)/);
  });

  it("describes progress against the previous evidence count", () => {
    expect(describeProgress(undefined, undefined, 0)).toEqual({ state: "unknown", detail: "no probe" });
    expect(describeProgress({ evidence: 3, lastEvidenceAt: 0, last: "node a done" }, undefined, 40_000)).toEqual({ state: "evidence", detail: "3 new so far (last: node a done, 40s ago)" });
    expect(describeProgress({ evidence: 3, lastEvidenceAt: 0, last: "node a done" }, 3, 25 * MIN)).toEqual({ state: "none", detail: "none recorded for 25m (last: node a done, 25m ago); not a stop reason" });
  });
});
