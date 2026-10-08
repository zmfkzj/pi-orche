import { describe, expect, it } from "vitest";
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
});
