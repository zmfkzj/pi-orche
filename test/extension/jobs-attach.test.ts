import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskJobs, type AttachOutcome, type Job, type JobEntry } from "../../src/extension/jobs.js";
import { attachResult, jobWidgetLines } from "../../src/extension/job-view.js";
import type { WorkerPool } from "../../src/extension/workers.js";

/**
 * Attach/detach of a background job (jobs.ts) against a scripted pool: whichever of settle and detach happens first wins, and the
 * result is announced exactly once (attached call or message). Attaching and detaching never cancel the worker.
 */
interface Run { finish(text?: string): void; fail(error: Error): void; progress(lines: string[]): void; signal: AbortSignal }

function setup() {
  const runs: Run[] = [];
  const delivered: Job[] = [];
  const persisted: JobEntry[] = [];
  const changes: string[] = [];
  const pool = {
    execute(args: { signal: AbortSignal; onStarted(info: { worker: string; role: string }): void; onProgress?: (lines: string[]) => void }) {
      const { promise, resolve, reject } = Promise.withResolvers<{ text: string; details: Record<string, unknown> }>();
      args.signal.addEventListener("abort", () => reject(new Error("cancelled: aborted")), { once: true });
      runs.push({ finish: (text = "Done: ok") => resolve({ text, details: { status: "done" } }), fail: reject, progress: lines => args.onProgress?.(lines), signal: args.signal });
      args.onStarted({ worker: `W${runs.length}`, role: "implement" });
      return promise;
    },
  } as unknown as WorkerPool;
  const jobs = new TaskJobs({ pool: () => pool, persist: entry => persisted.push(entry), deliver: job => delivered.push(job), onChange: job => changes.push(`${job.id}:${job.status}:${jobs.attached === job ? "attached" : "detached"}`) });
  const start = (attach?: Parameters<TaskJobs["start"]>[2]) => jobs.start({ role: "implement", request: "R1: x" } as never, undefined, attach);
  return { jobs, runs, delivered, persisted, changes, start };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("TaskJobs attach/detach", () => {
  it("a job that ends while attached returns its result to the call and is never delivered as a message", async () => {
    const { jobs, runs, delivered, persisted, start } = setup();
    const updates: string[] = [];
    const { job, outcome } = await start({ onUpdate: j => updates.push(j.progress ?? "") });
    expect(jobs.attached).toBe(job);
    runs[0]!.progress(["W1 implement · 1 request"]);
    expect(updates).toEqual(["W1 implement · 1 request"]);
    runs[0]!.finish();
    const result = await outcome!;
    expect(result).toMatchObject({ kind: "ended", job: { id: "J1", status: "done", delivered: "tool" } });
    expect(delivered).toEqual([]);
    expect(jobs.attached).toBeUndefined();
    expect(persisted.map(entry => entry.event)).toEqual(["start", "end"]);
    expect(attachResult(result, "orche_task")).toMatchObject({ content: [{ type: "text", text: "Done: ok" }], details: { status: "done", job: "J1", attach: "ended" } });
    expect(attachResult(result, "orche_task_attach").content[0]!.text).toMatch(/^\[orche task result · J1 · W1 implement · done after/);
  });

  it("detach first: the worker keeps running and its result comes once as a message; a later detach is a no-op", async () => {
    const { jobs, runs, delivered, start } = setup();
    const { job, outcome } = await start({});
    expect(jobs.detach("input")).toBe(true);
    expect(await outcome!).toMatchObject({ kind: "detached", reason: "input" });
    expect(runs[0]!.signal.aborted).toBe(false);
    expect(job.status).toBe("running");
    expect(jobs.detach("input")).toBe(false);
    runs[0]!.finish();
    await job.done;
    expect(delivered.map(j => j.id)).toEqual(["J1"]);
    expect(job.delivered).toBe("message");
    // Attaching to the ended job does not deliver it again.
    expect(await jobs.attach("J1")).toMatchObject({ kind: "already-ended" });
    expect(delivered).toHaveLength(1);
  });

  it("each attach is its own attachment: a check that captured an earlier one sees that a re-attach to the same job is a different one", async () => {
    const { jobs, runs, start } = setup();
    await start({});
    const first = jobs.attachment;
    expect(first).toBeDefined();
    jobs.detach("abort");
    expect(jobs.attachment).toBeUndefined();
    const again = jobs.attach("J1", {});
    expect(jobs.attachment).toBeDefined();
    expect(jobs.attachment).not.toBe(first);
    runs[0]!.finish();
    expect(await again).toMatchObject({ kind: "ended" });
    expect(jobs.attachment).toBeUndefined();
  });

  it("settle and detach in the same tick: exactly one wins, in both orders", async () => {
    for (const order of ["settle-first", "detach-first"] as const) {
      const { jobs, runs, delivered, start } = setup();
      const { job, outcome } = await start({});
      runs[0]!.finish();
      if (order === "detach-first") jobs.detach("session-bus");
      else await job.done;
      const detachedLate = order === "settle-first" ? jobs.detach("session-bus") : undefined;
      const result: AttachOutcome = await outcome!;
      await job.done;
      const toTool = result.kind === "ended" ? 1 : 0;
      expect(toTool + delivered.length).toBe(1);
      if (order === "settle-first") { expect(result.kind).toBe("ended"); expect(detachedLate).toBe(false); }
      else { expect(result.kind).toBe("detached"); expect(delivered).toHaveLength(1); }
    }
  });

  it("an aborted call (Esc) detaches without cancelling; an abort after the result changes nothing", async () => {
    const { jobs, runs, delivered, start } = setup();
    const esc = new AbortController();
    const { job, outcome } = await start({ signal: esc.signal });
    esc.abort();
    expect(await outcome!).toMatchObject({ kind: "detached", reason: "abort" });
    expect(runs[0]!.signal.aborted).toBe(false);
    // Re-attach with a fresh call; its signal listener is gone once the result is in.
    const again = new AbortController();
    const second = jobs.attach("J1", { signal: again.signal });
    runs[0]!.finish();
    expect(await second).toMatchObject({ kind: "ended" });
    again.abort();
    expect(jobs.attached).toBeUndefined();
    expect(delivered).toEqual([]);
    expect(job.status).toBe("done");
  });

  it("refuses to attach while input is pending, to an unknown job or without jobs; a new attach replaces the old one", async () => {
    const { jobs, runs, start } = setup();
    expect(await jobs.attach(undefined)).toMatchObject({ kind: "none", text: "No orche task jobs in this session." });
    await start();
    expect(jobs.attached).toBeUndefined();
    expect(await jobs.attach("J1", { pending: () => true })).toMatchObject({ kind: "pending" });
    expect(await jobs.attach("J7")).toMatchObject({ kind: "none" });
    const first = jobs.attach(undefined);
    const second = jobs.attach("J1");
    expect(await first).toMatchObject({ kind: "detached", reason: "replaced" });
    runs[0]!.finish();
    expect(await second).toMatchObject({ kind: "ended" });
  });

  it("cancel while attached returns the cancelled result to the call; shutdown while attached detaches and interrupts the job silently", async () => {
    const a = setup();
    const { outcome } = await a.start({});
    expect(await a.jobs.cancel()).toContain("delivered to the attached tool call");
    expect(await outcome!).toMatchObject({ kind: "ended", job: { status: "cancelled" } });
    expect(a.delivered).toEqual([]);

    const b = setup();
    const started = await b.start({});
    b.jobs.dispose();
    expect(await started.outcome!).toMatchObject({ kind: "detached", reason: "shutdown" });
    expect(started.job.status).toBe("interrupted");
    expect(b.delivered).toEqual([]);
    expect(b.persisted.filter(entry => entry.event === "end")).toMatchObject([{ status: "interrupted" }]);
  });

  it("the widget tells running attached / detached apart and shows the end and where the result went", async () => {
    const { jobs, runs, changes, start } = setup();
    const { job } = await start({});
    runs[0]!.progress(["W1 implement · 3 requests · last tool: edit"]);
    const now = job.startedAt + 75_000;
    expect(jobWidgetLines(job, { attached: true, now })).toEqual([
      "◉ orche J1 · W1 implement · running 1m 15s · attached: waiting for the result (Esc detaches, /orche cancel stops it)",
      "  W1 implement · 3 requests · last tool: edit",
    ]);
    jobs.detach("command");
    expect(jobWidgetLines(job, { attached: false, now, coarse: true })[0]).toBe("◌ orche J1 · W1 implement · running 1m · detached: works in the background, the result arrives as a message (/orche cancel stops it)");
    runs[0]!.finish();
    await job.done;
    expect(jobWidgetLines(job, { attached: false })[0]).toMatch(/^✓ orche J1 · W1 implement · done after \d+s · result delivered as a message$/);
    expect(changes).toEqual(["J1:running:attached", "J1:running:attached", "J1:running:detached", "J1:done:detached"]);
    await tick();
  });

  describe("keepalive (main-cache.ts)", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("releases the attached call at keepaliveAt with reason keepalive; the worker keeps running and a re-attach gets the result", async () => {
      vi.useFakeTimers();
      const { jobs, runs, delivered, start } = setup();
      const { job, outcome } = await start({ keepaliveAt: Date.now() + 60_000 });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(jobs.attached).toBe(job);
      await vi.advanceTimersByTimeAsync(1_000);
      const released = await outcome!;
      expect(released).toMatchObject({ kind: "detached", reason: "keepalive" });
      expect(runs[0]!.signal.aborted).toBe(false);
      const result = attachResult(released, "orche_task");
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({ job: "J1", attach: "detached", reason: "keepalive" });
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toMatch(/^Keepalive for J1 \(worker W1 implement, running .*\): .*prompt cache.*Call orche_task_attach \{"job":"J1"\} now, as your only action and without any text\.$/);
      // Re-attach: a new keepalive of its own; the job ends first and its result goes to this call, never as a message.
      const again = jobs.attach("J1", { keepaliveAt: Date.now() + 60_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      runs[0]!.finish();
      expect(await again).toMatchObject({ kind: "ended" });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(delivered).toEqual([]);
      expect(job.delivered).toBe("tool");
    });

    it("each attach has its own timer: a re-attach resets it, and a replaced or detached attachment's timer releases nothing", async () => {
      vi.useFakeTimers();
      const { jobs, runs, start } = setup();
      const { outcome } = await start({ keepaliveAt: Date.now() + 60_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      jobs.detach("input");
      expect(await outcome!).toMatchObject({ reason: "input" });
      const second = jobs.attach("J1", { keepaliveAt: Date.now() + 60_000 });
      const secondAttachment = jobs.attachment;
      // The first timer (due at 60 s) must not release the second attach (due at 70 s).
      await vi.advanceTimersByTimeAsync(55_000);
      expect(jobs.attachment).toBe(secondAttachment);
      const third = jobs.attach("J1", {});
      expect(await second).toMatchObject({ kind: "detached", reason: "replaced" });
      // The replaced attach's timer is gone; the third has none.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(jobs.attached?.id).toBe("J1");
      runs[0]!.finish();
      expect(await third).toMatchObject({ kind: "ended" });
    });

    it("input waiting at that moment detaches as input; a job that ended first, cancel and shutdown leave nothing for the timer", async () => {
      vi.useFakeTimers();
      const a = setup();
      let waiting = false;
      const { outcome } = await a.start({ keepaliveAt: Date.now() + 1_000, pending: () => waiting });
      waiting = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome!).toMatchObject({ kind: "detached", reason: "input" });

      const b = setup();
      const ended = await b.start({ keepaliveAt: Date.now() + 1_000 });
      b.runs[0]!.finish();
      await ended.job.done;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await ended.outcome!).toMatchObject({ kind: "ended" });
      expect(b.delivered).toEqual([]);

      const c = setup();
      const cancelled = await c.start({ keepaliveAt: Date.now() + 1_000 });
      const cancel = c.jobs.cancel();
      await vi.advanceTimersByTimeAsync(5_000);
      await cancel;
      expect(await cancelled.outcome!).toMatchObject({ kind: "ended", job: { status: "cancelled" } });

      const d = setup();
      const shut = await d.start({ keepaliveAt: Date.now() + 1_000 });
      d.jobs.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await shut.outcome!).toMatchObject({ kind: "detached", reason: "shutdown" });
    });

    it("a keepalive before the end leaves the result to one message; a keepalive already past releases at once", async () => {
      vi.useFakeTimers();
      const { jobs, runs, delivered, start } = setup();
      const { job, outcome } = await start({ keepaliveAt: Date.now() + 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      runs[0]!.finish();
      await job.done;
      const result = await outcome!;
      expect(result).toMatchObject({ kind: "detached", reason: "keepalive" });
      expect(delivered.map(j => j.id)).toEqual(["J1"]);

      const late = setup();
      const past = await late.start({ keepaliveAt: Date.now() - 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(await past.outcome!).toMatchObject({ kind: "detached", reason: "keepalive" });
      expect(jobs.attached).toBeUndefined();
    });
  });
});
