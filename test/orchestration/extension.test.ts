import { describe, expect, it } from "vitest";
import { LivenessTracker, type Liveness, type SessionLiveness } from "../../src/agent/liveness.js";
import {
  ExtendableDeadline, asLiveness, describeNotExtended, extensionEvent, formatExtensionLine, formatExtensionProgress, formatExtensionSummary,
  waitExtendable, withNotExtended, type DeadlineExtension, type NotExtended,
} from "../../src/orchestration/run/extension.js";

/** A manual clock: nothing moves unless the test says so. */
function fakeClock(start = 0) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; }, set: (value: number) => { time = value; } };
}
const live = (...reasons: string[]): Liveness => ({ active: reasons.length > 0, reasons, sessions: [] });
const idle = (): Liveness => ({ active: false, reasons: [], sessions: [] });
const ACTIVE = live("W2 bash running 12m, cpu progressing", "coordinator streaming 5s ago");

/** Base 100, +50 per extension, 3 extensions, window 2 min, started at 0. */
function deadlineOf(clock: ReturnType<typeof fakeClock>, options: { overallMs?: number; extensionMs?: number; maxExtensions?: number } = {}) {
  return new ExtendableDeadline({ startedAt: 0, overallMs: 100, extensionMs: 50, maxExtensions: 3, activityWindowMs: 120_000, now: clock.now, ...options });
}
const notExtended = (result: ReturnType<ExtendableDeadline["tryExtend"]>): NotExtended => {
  if (result.extended) throw new Error("expected a refusal");
  return result;
};

describe("ExtendableDeadline", () => {
  it("exposes the overall deadline (startedAt + base + extensions) and bounds remaining(cap) by it", () => {
    const clock = fakeClock(1_000);
    const deadline = new ExtendableDeadline({ overallMs: 100, extensionMs: 50, maxExtensions: 3, now: clock.now });
    expect(deadline.startedAt).toBe(1_000);
    expect(deadline.overallDeadline).toBe(1_100);
    expect(deadline.overallCapMs).toBe(100);
    expect(deadline.hardLimitMs).toBe(250);
    expect(deadline.remaining(40)).toBe(40);
    clock.advance(90);
    expect(deadline.remaining(40)).toBe(10); // the overall deadline binds
    expect(deadline.remaining(0)).toBe(0);
    clock.advance(30);
    expect(deadline.remaining(40)).toBe(0); // never negative
    expect(deadline.overallRemainingMs()).toBe(0);
  });

  it("(e) remaining(cap), the caps and the overall remainder all follow the extended deadline", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    clock.set(100);
    expect(deadline.remaining(1_000)).toBe(0);
    const result = deadline.tryExtend({ scope: "overall", stage: "implement backlog", liveness: ACTIVE });
    expect(result).toMatchObject({ extended: true, fresh: true, n: 1, max: 3, newDeadline: 150 });
    expect(deadline.overallDeadline).toBe(150);
    expect(deadline.overallCapMs).toBe(150);
    expect(deadline.overallRemainingMs()).toBe(50);
    expect(deadline.remaining(1_000)).toBe(50);
    expect(deadline.remaining(20)).toBe(20);
    clock.set(140);
    expect(deadline.remaining(1_000)).toBe(10);
    // The base cap is untouched: it is where the first extension came from.
    expect(deadline.baseOverallMs).toBe(100);
  });

  it("extends by extensionMs when active and returns {extended, n, max, newDeadline, reasons}", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    clock.set(100);
    const result = deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE });
    expect(result).toMatchObject({ extended: true, fresh: true, n: 1, max: 3, newDeadline: 150, reasons: ACTIVE.reasons });
    expect(deadline.used).toBe(1);
    expect(deadline.left).toBe(2);
    expect(deadline.extensions).toEqual([{
      n: 1, max: 3, scope: "overall", stage: "run", extensionMs: 50, at: 100, elapsedMs: 100,
      previousDeadline: 100, newDeadline: 150, overallDeadline: 150, overallExtended: true, reasons: ACTIVE.reasons,
    }]);
  });

  it("(b) does not extend an idle run: reason idle, nothing consumed, the deadline stays", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    clock.set(100);
    const result = notExtended(deadline.tryExtend({ scope: "overall", stage: "run", liveness: idle() }));
    expect(result).toMatchObject({ extended: false, reason: "idle", n: 0, max: 3, windowMs: 120_000, message: "not extended: no activity in the last 2m" });
    expect(deadline.used).toBe(0);
    expect(deadline.overallDeadline).toBe(100);
    expect(deadline.extensions).toEqual([]);
    // A later check with activity is still granted: idle consumed nothing.
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ extended: true, n: 1 });
  });

  it("(c) grants at most maxExtensions, then refuses with reason budget; the deadline is a hard cap", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    for (const n of [1, 2, 3]) {
      clock.set(deadline.overallDeadline);
      expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ extended: true, fresh: true, n, max: 3 });
    }
    expect(deadline.overallDeadline).toBe(250);
    expect(deadline.exhausted).toBe(true);
    clock.set(250);
    const refused = notExtended(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE }));
    expect(refused).toMatchObject({ reason: "budget", n: 3, max: 3, message: "extension budget 3/3 used" });
    expect(deadline.overallDeadline).toBe(250);
    expect(deadline.used).toBe(3);
    // Idle or active, the budget answer is the same.
    expect(notExtended(deadline.tryExtend({ scope: "overall", stage: "run", liveness: idle() })).reason).toBe("budget");
    expect(deadline.hardLimitMs).toBe(250);
  });

  it("(d) a phase cap extended past the overall deadline extends both, counted once", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const phase = deadline.phase(80, "Coordinator decision"); // phase deadline 80, overall 100
    expect(phase.deadline).toBe(80);
    expect(phase.effectiveDeadline).toBe(80);
    expect(phase.scope).toBe("phase");
    clock.set(80);
    const result = phase.extend(ACTIVE);
    expect(result).toMatchObject({ extended: true, fresh: true, n: 1, max: 3, newDeadline: 130 });
    expect(result.extended && result.extension?.overallExtended).toBe(true);
    expect(phase.deadline).toBe(130); // 80 + 50
    expect(deadline.overallDeadline).toBe(150); // 100 + 50: it would have cut the phase at 100
    expect(deadline.used).toBe(1); // ONE extension of the budget, not two
    expect(deadline.extensions).toHaveLength(1);
    expect(deadline.extensions[0]).toMatchObject({ scope: "phase", stage: "Coordinator decision", previousDeadline: 80, newDeadline: 130, overallDeadline: 150, overallExtended: true });
    expect(phase.effectiveDeadline).toBe(130);
    expect(phase.currentCapMs).toBe(130);
    expect(phase.remainingMs()).toBe(50);
  });

  it("(d) a phase cap that stays inside the overall deadline leaves the overall deadline alone", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock, { overallMs: 1_000 });
    const phase = deadline.phase(10, "Exploration plan");
    clock.set(10);
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: true, n: 1, newDeadline: 60 });
    expect(deadline.overallDeadline).toBe(1_000);
    expect(deadline.extensions[0]).toMatchObject({ scope: "phase", overallExtended: false, overallDeadline: 1_000 });
    expect(deadline.used).toBe(1);
  });

  it("(d) the overall deadline binding a phase extends the overall deadline, and the phase cap (a share of it) moves along", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const phase = deadline.phase(500, "implement outcomes"); // would outlast the overall deadline
    expect(phase.scope).toBe("overall");
    expect(phase.effectiveDeadline).toBe(100);
    expect(phase.effectiveCapMs).toBe(100);
    clock.set(100);
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: true, n: 1, newDeadline: 150 });
    expect(deadline.extensions[0]).toMatchObject({ scope: "overall", stage: "implement outcomes" });
    expect(deadline.overallDeadline).toBe(150);
    expect(phase.deadline).toBe(550); // 500 + 50: the cap of the phase moved with the overall deadline
    expect(phase.scope).toBe("overall");
    expect(phase.effectiveDeadline).toBe(150);
    expect(phase.remainingMs()).toBe(50);
  });

  it("(d) a phase cap that falls just after the overall deadline (the default: assignment cap = overall cap, started a little later) does not cost a second extension", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    clock.set(10);
    const phase = deadline.phase(100, "implement outcomes"); // deadline 110, overall 100
    clock.set(100);
    expect(phase.scope).toBe("overall");
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ extended: true, fresh: true, n: 1, newDeadline: 150 });
    expect(phase.deadline).toBe(160);
    // The phase's own cap (110) passes while the overall deadline has been moved: nothing to extend.
    clock.set(110);
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: false, n: 1, newDeadline: 150 });
    expect(deadline.used).toBe(1);
    // It is the overall deadline that binds again, 40 ms later.
    clock.set(150);
    expect(phase.scope).toBe("overall");
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: true, n: 2, newDeadline: 200 });
    expect(phase.deadline).toBe(210);
  });

  it("(d) a phase created after the overall deadline moved is not moved by that", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    clock.set(100);
    deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE });
    const phase = deadline.phase(30, "Redirect");
    expect(phase.deadline).toBe(130);
    clock.set(130);
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: true, n: 2, newDeadline: 180 });
    expect(phase.deadline).toBe(180);
    expect(deadline.overallDeadline).toBe(200); // 180 reaches past 150, so the overall deadline moved by one extension with it
  });

  it("(d) phase and overall expiring together are one extension that moves both", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const phase = deadline.phase(100, "Redirect");
    clock.set(100);
    expect(phase.scope).toBe("phase");
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: true, n: 1, newDeadline: 150 });
    expect(phase.deadline).toBe(150);
    expect(deadline.overallDeadline).toBe(150);
    expect(deadline.used).toBe(1);
  });

  it("(d) a phase and the overall deadline expiring together cost one extension whichever timer is asked first", () => {
    for (const phaseFirst of [true, false]) {
      const clock = fakeClock();
      const deadline = deadlineOf(clock);
      const phase = deadline.phase(100, "Redirect");
      clock.set(100);
      const askPhase = () => phase.extend(ACTIVE);
      const askOverall = () => deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE });
      const [first, second] = phaseFirst ? [askPhase(), askOverall()] : [askOverall(), askPhase()];
      expect(first).toMatchObject({ extended: true, fresh: true, n: 1, newDeadline: 150 });
      expect(second).toMatchObject({ extended: true, fresh: false, n: 1, newDeadline: 150 });
      expect(deadline.used).toBe(1);
      expect(deadline.overallDeadline).toBe(150);
      expect(phase.deadline).toBe(150);
    }
  });

  it("(d) the budget is shared: phases and the overall deadline draw from the same three extensions", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock, { overallMs: 1_000 });
    const a = deadline.phase(10, "a");
    clock.set(10);
    expect(a.extend(ACTIVE)).toMatchObject({ n: 1 });
    const b = deadline.phase(10, "b");
    clock.set(20);
    expect(b.extend(ACTIVE)).toMatchObject({ n: 2 });
    clock.set(1_000);
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ n: 3, newDeadline: 1_050 });
    const c = deadline.phase(10, "c", 1_000);
    clock.set(1_010);
    expect(notExtended(c.extend(ACTIVE))).toMatchObject({ reason: "budget", message: "extension budget 3/3 used" });
    expect(c.deadline).toBe(1_010);
  });

  it("two timers on the same expiry extend once: the second finds the deadline already moved", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const phase = deadline.phase(500, "implement outcomes");
    clock.set(100);
    // The run-level timer and the phase timer fire in the same millisecond.
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ extended: true, fresh: true, n: 1 });
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: false, n: 1, newDeadline: 150 });
    expect(deadline.used).toBe(1);
    // Same with an explicit expired deadline (a caller that cannot trust the clock).
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE, expired: 100 })).toMatchObject({ extended: true, fresh: false, newDeadline: 150 });
    expect(deadline.used).toBe(1);
  });

  it("a timer that fires before the deadline is not due: nothing is consumed", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    clock.set(99);
    expect(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE })).toMatchObject({ extended: true, fresh: false, newDeadline: 100 });
    expect(deadline.used).toBe(0);
    const phase = deadline.phase(50, "p", 0);
    clock.set(49);
    expect(phase.extend(ACTIVE)).toMatchObject({ extended: true, fresh: false, newDeadline: 50 });
    expect(deadline.used).toBe(0);
  });

  it("disabled (maxExtensions 0 or extensionMs 0): reason disabled and nothing to say in messages", () => {
    for (const options of [{ maxExtensions: 0 }, { extensionMs: 0 }]) {
      const clock = fakeClock();
      const deadline = deadlineOf(clock, options);
      clock.set(100);
      const refused = notExtended(deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE }));
      expect(refused.reason).toBe("disabled");
      expect(refused.message).toBeUndefined();
      expect(withNotExtended("overall timeout", refused)).toBe("overall timeout");
      expect(deadline.enabled).toBe(false);
      expect(deadline.hardLimitMs).toBe(100);
      expect(deadline.overallDeadline).toBe(100);
    }
  });

  it("builds from RunLimits: a run uses overallMs, an assignment uses assignmentMs as its base", () => {
    const clock = fakeClock(10);
    const limits = { overallMs: 1_800_000, assignmentMs: 600_000, extensionMs: 1_800_000, maxExtensions: 3, activityWindowMs: 120_000 };
    const run = ExtendableDeadline.fromLimits(limits, { now: clock.now });
    expect(run).toMatchObject({ startedAt: 10, baseOverallMs: 1_800_000, extensionMs: 1_800_000, maxExtensions: 3, activityWindowMs: 120_000 });
    expect(run.overallDeadline).toBe(1_800_010);
    expect(run.hardLimitMs).toBe(1_800_000 + 3 * 1_800_000);
    const task = ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs, startedAt: 5, now: clock.now });
    expect(task.overallDeadline).toBe(600_005);
  });
});

describe("waitExtendable (orche_task)", () => {
  type Wait = { type: "outcome"; outcome: string } | { type: "message" } | { type: "timeout" };
  const timeout: Wait = { type: "timeout" };

  /** A fake manager.wait: a scripted list of results; a timeout moves the clock by the `ms` it was asked to wait. */
  function script(clock: ReturnType<typeof fakeClock>, results: Wait[]) {
    const asked: number[] = [];
    const wait = async (ms: number): Promise<Wait> => {
      asked.push(ms);
      const next = results.shift() ?? timeout;
      if (next.type === "timeout") clock.advance(ms);
      return next;
    };
    return { wait, asked };
  }

  it("returns the result of a wait that finishes before the deadline", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const { wait, asked } = script(clock, [{ type: "outcome", outcome: "done" }]);
    const result = await waitExtendable({ deadline, wait, liveness: () => ACTIVE, stage: "assignment W1" });
    expect(result).toEqual({ type: "outcome", outcome: "done" });
    expect(asked).toEqual([100]);
    expect(deadline.used).toBe(0);
  });

  it("(f) extends while the worker is active, then returns the outcome that arrives in the extension window", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const extended: DeadlineExtension[] = [];
    const { wait, asked } = script(clock, [timeout, timeout, { type: "outcome", outcome: "late" }]);
    const probes: Array<[number, number]> = [];
    const result = await waitExtendable({
      deadline, wait, stage: "assignment W1", onExtended: extension => extended.push(extension),
      liveness: (now, windowMs) => { probes.push([now, windowMs]); return ACTIVE; },
    });
    expect(result).toEqual({ type: "outcome", outcome: "late" });
    expect(asked).toEqual([100, 50, 50]); // the base, then one extension window each
    expect(probes).toEqual([[100, 120_000], [150, 120_000]]); // the verdict is read at each expiry over the activity window
    expect(extended.map(({ n, max, scope, stage, newDeadline, reasons }) => ({ n, max, scope, stage, newDeadline, reasons }))).toEqual([
      { n: 1, max: 3, scope: "assignment", stage: "assignment W1", newDeadline: 150, reasons: ACTIVE.reasons },
      { n: 2, max: 3, scope: "assignment", stage: "assignment W1", newDeadline: 200, reasons: ACTIVE.reasons },
    ]);
    expect(deadline.used).toBe(2);
  });

  it("(b) times out when the worker is idle at the deadline, with the reason", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const { wait, asked } = script(clock, []);
    const extended: DeadlineExtension[] = [];
    const result = await waitExtendable({ deadline, wait, liveness: () => idle(), stage: "assignment W1", onExtended: extension => extended.push(extension) });
    expect(result).toMatchObject({ type: "timeout", notExtended: { extended: false, reason: "idle", message: "not extended: no activity in the last 2m" } });
    expect(asked).toEqual([100]);
    expect(extended).toEqual([]);
    expect(deadline.used).toBe(0);
  });

  it("(c) times out after the third extension with the budget reason", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const { wait, asked } = script(clock, []);
    const extended: number[] = [];
    const result = await waitExtendable({ deadline, wait, liveness: () => ACTIVE, stage: "assignment W1", onExtended: extension => extended.push(extension.n) });
    expect(result).toMatchObject({ type: "timeout", notExtended: { reason: "budget", n: 3, max: 3, message: "extension budget 3/3 used" } });
    expect(asked).toEqual([100, 50, 50, 50]);
    expect(extended).toEqual([1, 2, 3]);
    expect(clock.now()).toBe(250); // base + 3 extensions, never more
  });

  it("goes idle in an extension window: timeout with the idle reason, extensions kept", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const { wait } = script(clock, []);
    let reads = 0;
    const result = await waitExtendable({ deadline, wait, liveness: () => (++reads === 1 ? ACTIVE : idle()), stage: "assignment W1" });
    expect(result).toMatchObject({ type: "timeout", notExtended: { reason: "idle", n: 1 } });
    expect(deadline.used).toBe(1);
  });

  it("(f) reads a single worker's verdict (workerLiveness) and treats an unknown worker as idle", async () => {
    const worker: SessionLiveness = { id: "W1", role: "implementer", state: "tool", active: true, detail: "bash running 12m, output 20s ago" };
    expect(asLiveness(worker)).toEqual({ active: true, reasons: ["W1 bash running 12m, output 20s ago"], sessions: [worker] });
    expect(asLiveness({ ...worker, active: false })).toMatchObject({ active: false, reasons: [] });
    expect(asLiveness(undefined)).toEqual({ active: false, reasons: [], sessions: [] });

    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const extended: DeadlineExtension[] = [];
    const { wait } = script(clock, [timeout, { type: "outcome", outcome: "ok" }]);
    await waitExtendable({ deadline, wait, liveness: () => worker, stage: "assignment W1", onExtended: extension => extended.push(extension) });
    expect(extended[0]?.reasons).toEqual(["W1 bash running 12m, output 20s ago"]);

    const goneClock = fakeClock();
    expect(await waitExtendable({ deadline: deadlineOf(goneClock), wait: script(goneClock, []).wait, liveness: () => undefined, stage: "x" })).toMatchObject({ type: "timeout", notExtended: { reason: "idle" } });
  });

  it("(g) a signal that is already aborted returns at once without waiting", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const controller = new AbortController();
    controller.abort();
    let waits = 0;
    const result = await waitExtendable({ deadline, signal: controller.signal, wait: () => { waits++; return new Promise<Wait>(() => {}); }, liveness: () => ACTIVE, stage: "s" });
    expect(result).toEqual({ type: "aborted" });
    expect(waits).toBe(0);
  });

  it("(g) cancellation during the first wait returns immediately, though the wait never answers", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const controller = new AbortController();
    let waits = 0;
    const pending = waitExtendable({ deadline, signal: controller.signal, wait: () => { waits++; return new Promise<Wait>(() => {}); }, liveness: () => ACTIVE, stage: "s" });
    await Promise.resolve();
    expect(waits).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ type: "aborted" });
    expect(deadline.used).toBe(0);
  });

  it("(g) cancellation inside an extension window returns immediately and never waits out the window", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const controller = new AbortController();
    const asked: number[] = [];
    // The first wait times out (the deadline); the second is the extension window and would last 50 ms more, but never answers here.
    const wait = (ms: number): Promise<Wait> => {
      asked.push(ms);
      if (asked.length === 1) { clock.advance(ms); return Promise.resolve(timeout); }
      return new Promise<Wait>(() => {});
    };
    const extended: DeadlineExtension[] = [];
    const pending = waitExtendable({ deadline, signal: controller.signal, wait, liveness: () => ACTIVE, stage: "s", onExtended: extension => extended.push(extension) });
    for (let i = 0; i < 10 && asked.length < 2; i++) await Promise.resolve();
    expect(asked).toEqual([100, 50]);
    expect(extended).toHaveLength(1);
    controller.abort();
    expect(await pending).toEqual({ type: "aborted" });
    expect(deadline.used).toBe(1);
  });

  it("(g) cancellation that arrives together with the expiry wins over extending", async () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock);
    const controller = new AbortController();
    const result = await waitExtendable({
      deadline, signal: controller.signal, liveness: () => ACTIVE, stage: "s",
      wait: async ms => { clock.advance(ms); controller.abort(); return timeout; },
    });
    expect(result).toEqual({ type: "aborted" });
    expect(deadline.used).toBe(0); // no extension was spent on a cancelled wait
  });

  it("lets a failing wait propagate and ignores an observer that throws", async () => {
    const clock = fakeClock();
    await expect(waitExtendable({ deadline: deadlineOf(clock), wait: () => Promise.reject(new Error("manager gone")), liveness: () => ACTIVE, stage: "s" })).rejects.toThrow("manager gone");
    await expect(waitExtendable({ deadline: deadlineOf(clock), signal: new AbortController().signal, wait: () => Promise.reject(new Error("manager gone")), liveness: () => ACTIVE, stage: "s" })).rejects.toThrow("manager gone");
    const observed = fakeClock();
    const deadline = deadlineOf(observed);
    const { wait } = script(observed, [timeout, { type: "outcome", outcome: "ok" }]);
    const result = await waitExtendable({ deadline, wait, liveness: () => ACTIVE, stage: "s", onExtended: () => { throw new Error("observer"); } });
    expect(result).toEqual({ type: "outcome", outcome: "ok" });
    expect(deadline.used).toBe(1);
  });

  it("uses the real clock by default: a short real wait is extended once and then completes", async () => {
    const deadline = new ExtendableDeadline({ overallMs: 15, extensionMs: 15, maxExtensions: 1, activityWindowMs: 1_000 });
    const sleep = (ms: number) => new Promise<Wait>(resolve => setTimeout(() => resolve(timeout), ms));
    let calls = 0;
    const result = await waitExtendable({ deadline, wait: ms => (++calls === 2 ? Promise.resolve({ type: "outcome", outcome: "ok" } as Wait) : sleep(ms)), liveness: () => ACTIVE, stage: "s" });
    expect(result).toEqual({ type: "outcome", outcome: "ok" });
    expect(deadline.used).toBe(1);
  });
});

describe("formatting (j)", () => {
  const first: DeadlineExtension = {
    n: 1, max: 3, scope: "overall", stage: "implement backlog", extensionMs: 1_800_000, at: 1_800_000, elapsedMs: 1_800_000,
    previousDeadline: 1_800_000, newDeadline: 3_600_000, overallDeadline: 3_600_000, overallExtended: true,
    reasons: ["W2 bash running 12m, cpu progressing", "coordinator streaming"],
  };

  it("progress line: ⏱ timeout extended n/max (+30m): reasons", () => {
    expect(formatExtensionProgress(first)).toBe("⏱ timeout extended 1/3 (+30m): W2 bash running 12m, cpu progressing; coordinator streaming");
    expect(formatExtensionProgress({ ...first, n: 3, extensionMs: 90_000 })).toBe("⏱ timeout extended 3/3 (+1m30s): W2 bash running 12m, cpu progressing; coordinator streaming");
    expect(formatExtensionProgress({ ...first, reasons: [] })).toBe("⏱ timeout extended 1/3 (+30m): still active");
  });

  it("progress line shows at most four reasons and counts the rest", () => {
    const reasons = ["W1 a", "W2 b", "W3 c", "W4 d", "W5 e", "W6 f"];
    expect(formatExtensionProgress({ ...first, reasons })).toBe("⏱ timeout extended 1/3 (+30m): W1 a; W2 b; W3 c; W4 d; +2 more");
    expect(formatExtensionProgress({ ...first, reasons }, 6)).toContain("W6 f");
  });

  it("uses the reasons liveness produces for a real session", () => {
    const tracker = new LivenessTracker({ id: "W2", role: "implementer" });
    tracker.observe({ type: "agent_start" }, 1_000);
    tracker.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" }, 1_000);
    tracker.observe({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [], details: { heartbeat: { type: "bash_heartbeat", seq: 1, at: 1_000, elapsedMs: 0, outputBytes: 0, newOutput: false, cpuMs: 900, procAvailable: true, progressing: true } } } }, 1_000);
    const verdict = tracker.liveness(1_000 + 20_000, 120_000);
    expect(verdict.active).toBe(true);
    const line = formatExtensionProgress({ ...first, reasons: verdict.reasons });
    expect(line).toMatch(/^⏱ timeout extended 1\/3 \(\+30m\): W2 bash running 20s, cpu\/io activity 20s ago/);
  });

  it("explains a missing extension in one line", () => {
    const base = { n: 0, max: 3, windowMs: 120_000 };
    expect(describeNotExtended({ ...base, reason: "idle" })).toBe("not extended: no activity in the last 2m");
    expect(describeNotExtended({ ...base, reason: "idle", windowMs: 45_000 })).toBe("not extended: no activity in the last 45s");
    expect(describeNotExtended({ ...base, n: 3, reason: "budget" })).toBe("extension budget 3/3 used");
    expect(describeNotExtended({ ...base, reason: "disabled" })).toBeUndefined();
    expect(withNotExtended("Worker W1 timed out after 1800000ms", { ...base, reason: "idle" })).toBe("Worker W1 timed out after 1800000ms (not extended: no activity in the last 2m)");
    expect(withNotExtended("Worker W1 timed out after 1800000ms", { ...base, n: 3, reason: "budget" })).toBe("Worker W1 timed out after 1800000ms (extension budget 3/3 used)");
    expect(withNotExtended("Worker W1 timed out", undefined)).toBe("Worker W1 timed out");
  });

  it("final report summary lists the extensions used and why the last one was refused", () => {
    expect(formatExtensionSummary([], { maxExtensions: 3, extensionMs: 1_800_000 })).toEqual([]);
    const second: DeadlineExtension = { ...first, n: 2, scope: "phase", stage: "Coordinator decision", at: 5_400_000, elapsedMs: 5_400_000, overallExtended: true, reasons: ["coordinator streaming 3s ago"] };
    expect(formatExtensionSummary([first, second], { maxExtensions: 3, extensionMs: 1_800_000 })).toEqual([
      "Timeout extensions: 2/3 used (+30m each)",
      "  1/3 at 30m, overall \"implement backlog\": W2 bash running 12m, cpu progressing; coordinator streaming",
      "  2/3 at 1h30m, phase \"Coordinator decision\" (overall extended too): coordinator streaming 3s ago",
    ]);
    expect(formatExtensionSummary([first], { maxExtensions: 3, extensionMs: 1_800_000, notExtended: { reason: "idle", n: 1, max: 3, windowMs: 120_000 } })[0])
      .toBe("Timeout extensions: 1/3 used (+30m each); not extended: no activity in the last 2m");
    expect(formatExtensionSummary([], { maxExtensions: 3, notExtended: { reason: "idle", n: 0, max: 3, windowMs: 120_000 } })).toEqual(["Timeout extensions: 0/3 used; not extended: no activity in the last 2m"]);
    expect(formatExtensionSummary([], { maxExtensions: 0, notExtended: { reason: "disabled", n: 0, max: 0, windowMs: 120_000 } })).toEqual([]);
    expect(formatExtensionLine(first)).toBe("1/3 at 30m, overall \"implement backlog\": W2 bash running 12m, cpu progressing; coordinator streaming");
  });

  it("the deadline writes its own summary", () => {
    const clock = fakeClock();
    const deadline = deadlineOf(clock, { overallMs: 1_800_000, extensionMs: 1_800_000 });
    expect(deadline.summary()).toEqual([]);
    clock.set(1_800_000);
    deadline.tryExtend({ scope: "overall", stage: "run", liveness: ACTIVE });
    expect(deadline.summary()).toEqual([
      "Timeout extensions: 1/3 used (+30m each)",
      "  1/3 at 30m, overall \"run\": W2 bash running 12m, cpu progressing; coordinator streaming 5s ago",
    ]);
    expect(deadline.summary(notExtended({ extended: false, reason: "idle", n: 1, max: 3, windowMs: 120_000, message: undefined })).at(0))
      .toBe("Timeout extensions: 1/3 used (+30m each); not extended: no activity in the last 2m");
  });

  it("builds the deadline_extended run event", () => {
    expect(extensionEvent(first)).toEqual({
      type: "deadline_extended", timestamp: 1_800_000, scope: "overall", stage: "implement backlog", extension: 1, maxExtensions: 3,
      extensionMs: 1_800_000, newDeadline: 3_600_000, reasons: ["W2 bash running 12m, cpu progressing", "coordinator streaming"],
    });
    const event = extensionEvent(first);
    (event.reasons as string[]).length = 0;
    expect(first.reasons).toHaveLength(2); // the record is not aliased
  });
});
