/**
 * Background orche_task jobs: `orche_task` starts a worker and returns at once; the result reaches the main session later as a
 * message that starts its next turn. Meanwhile main keeps talking with the user, can inject instructions into the running worker
 * (`orche_task_message`) and can look at or cancel the job (`orche_task_status`). One job runs at a time per session (the
 * controller's activity slot, shared with `/orche cancel`).
 *
 * Exactly-once delivery: every job ends in exactly one terminal state (done | failed | cancelled | interrupted), recorded once as an
 * `orche-job` session entry and announced once. A job that was running when the session shut down (reload, exit, session switch)
 * ends as `interrupted` in its entry and its run record; one found running at the next session start (a crash) is closed then and
 * announced to main once. Worker ids and job ids are never reused within a session branch.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { formatDuration } from "../agent/liveness.js";
import { TaskFailedError, type GoneWorker, type TaskDetails, type TaskStartedInfo, type WorkerPool } from "./workers.js";

export const JOB_ENTRY_TYPE = "orche-job";
export const WORKER_ENTRY_TYPE = "orche-worker";
export const TASK_RESULT_TYPE = "orche-task-result";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

/** One `orche-job` session entry: the start of a job, or its end. Small; never sent to the model. */
export type JobEntry =
  | { event: "start"; job: string; role: string; worker: string; at: number; request: string; record?: string; sessionFile?: string; model?: string; thinking?: ThinkingLevel }
  | { event: "end"; job: string; worker?: string; at: number; status: Exclude<JobStatus, "running">; summary?: string; record?: string };

export interface Job {
  id: string;
  role: string;
  request: string;
  worker?: string;
  model?: string;
  thinking?: ThinkingLevel;
  record?: string;
  sessionFile?: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  /** The last progress line of the worker. */
  progress?: string;
  /** The final result as delivered (text for the model and its details). */
  result?: { text: string; isError: boolean; details?: TaskDetails };
  abort: AbortController;
  done: Promise<void>;
  /** Set once the terminal state is recorded and announced: never twice. */
  settled: boolean;
}

export interface JobDeps {
  pool: () => WorkerPool;
  /** Persist one entry (pi.appendEntry). Best effort. */
  persist: (entry: JobEntry) => void;
  /** Hand the final result to the main session (pi.sendMessage with a turn trigger). */
  deliver: (job: Job) => void;
  /** Status line of the running job in the UI (undefined clears it). */
  status?: (line: string | undefined) => void;
}

type StartArgs = Parameters<WorkerPool["execute"]>[0];

const shortRequest = (request: string) => {
  const line = request.split("\n").find(text => text.trim() && !/^(Intent|#)/i.test(text.trim())) ?? request;
  return line.trim().slice(0, 160);
};

export class TaskJobs {
  private readonly jobs = new Map<string, Job>();
  private nextJob = 1;
  private disposed = false;

  constructor(private readonly deps: JobDeps) {}

  /** The running job, if any. */
  get running(): Job | undefined {
    return [...this.jobs.values()].find(job => job.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /**
   * Rebuild from the session's `orche-job` / `orche-worker` entries (session start, reload, resume). Jobs that started but never
   * ended belonged to a process that is gone: they end now as `interrupted` (persisted, so this happens once) and are returned for
   * one notice to main. Returns the gone workers and every worker id used, for the pool.
   */
  restore(jobEntries: readonly JobEntry[], workerEntries: readonly GoneWorker[]): { interrupted: Job[]; gone: GoneWorker[]; usedWorkerIds: string[] } {
    this.jobs.clear();
    const starts = new Map<string, Extract<JobEntry, { event: "start" }>>();
    const ends = new Map<string, Extract<JobEntry, { event: "end" }>>();
    for (const entry of jobEntries) {
      if (entry.event === "start") starts.set(entry.job, entry); else ends.set(entry.job, entry);
      const n = /^J(\d+)$/.exec(entry.job)?.[1];
      if (n) this.nextJob = Math.max(this.nextJob, Number(n) + 1);
    }
    const gone = new Map(workerEntries.map(worker => [worker.id, { ...worker }]));
    const interrupted: Job[] = [];
    const now = Date.now();
    for (const [id, start] of starts) {
      const end = ends.get(id);
      const job: Job = {
        id, role: start.role, request: start.request, worker: start.worker, startedAt: start.at, status: end?.status ?? "interrupted",
        ...(start.model ? { model: start.model } : {}), ...(start.thinking ? { thinking: start.thinking } : {}),
        ...(start.record ?? end?.record ? { record: start.record ?? end?.record } : {}), ...(start.sessionFile ? { sessionFile: start.sessionFile } : {}),
        finishedAt: end?.at ?? now, abort: new AbortController(), done: Promise.resolve(), settled: true,
        ...(end?.summary ? { result: { text: end.summary, isError: end.status !== "done" } } : {}),
      };
      this.jobs.set(id, job);
      if (!end) {
        const reason = "the pi process that ran it ended without a clean shutdown (crash or kill)";
        interrupted.push(job);
        this.deps.persist({ event: "end", job: id, worker: start.worker, at: now, status: "interrupted", summary: `interrupted: ${reason}`, ...(start.record ? { record: start.record } : {}) });
        if (!gone.has(start.worker)) gone.set(start.worker, { id: start.worker, role: start.role, reason, at: now, ...(start.sessionFile ? { sessionFile: start.sessionFile } : {}), ...(start.record ? { record: start.record } : {}) });
      }
      // A worker that ran a job and has no gone entry was live when its session ended without a clean shutdown.
      const endReason = end?.status === "interrupted" && end.summary ? end.summary.replace(/^interrupted: /, "") : "the pi session that owned it ended";
      if (!gone.has(start.worker)) gone.set(start.worker, { id: start.worker, role: start.role, reason: endReason, at: end?.at ?? now, ...(start.sessionFile ? { sessionFile: start.sessionFile } : {}), ...(start.record ?? end?.record ? { record: start.record ?? end?.record } : {}), ...(end?.summary ? { summary: end.summary } : {}) });
    }
    return { interrupted, gone: [...gone.values()], usedWorkerIds: [...new Set([...starts.values()].map(start => start.worker))] };
  }

  /**
   * Start a job: resolves with the job once its worker has the assignment, or rejects with the error that stopped it before that
   * (unknown worker, bad grant, busy session, startup failure: nothing ran, nothing is announced). Everything after the start is
   * announced through `deliver` exactly once.
   */
  async start(args: Omit<StartArgs, "signal" | "onStarted">, startSignal?: AbortSignal): Promise<Job> {
    if (this.disposed) throw new Error("orche jobs are shut down");
    const running = this.running;
    if (running) throw new Error(`Job ${running.id} (${running.worker ?? "worker starting"}, ${running.role}) is still running; one task runs at a time. Its result will arrive as a message: keep talking with the user meanwhile, add instructions with orche_task_message, or stop it with orche_task_status {"job":"${running.id}","cancel":true}.`);
    const abort = new AbortController();
    const id = `J${this.nextJob++}`;
    const started = Promise.withResolvers<TaskStartedInfo>();
    const job: Job = { id, role: args.role, request: shortRequest(args.request), startedAt: Date.now(), status: "running", abort, done: Promise.resolve(), settled: false };
    let didStart = false;
    const execution = this.deps.pool().execute({
      ...args,
      signal: abort.signal,
      onStarted: info => {
        didStart = true;
        Object.assign(job, { worker: info.worker, ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}), ...(info.record ? { record: info.record } : {}), ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}) });
        this.jobs.set(id, job);
        this.deps.persist({ event: "start", job: id, role: args.role, worker: info.worker, at: job.startedAt, request: job.request, ...(info.record ? { record: info.record } : {}), ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}), ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}) });
        started.resolve(info);
      },
      onProgress: (lines, timing) => {
        if (lines.length) job.progress = lines.at(-1);
        if (job.status === "running") this.deps.status?.(lines.length ? `${id} ${lines.at(-1)}` : undefined);
        args.onProgress?.(lines, timing);
      },
    });
    job.done = execution.then(
      result => this.settle(job, "done", { text: result.text, isError: false, details: result.details }),
      error => {
        if (!didStart) { started.reject(error); return; }
        if (error instanceof TaskFailedError) {
          this.settle(job, error.failure.kind === "cancelled" ? "cancelled" : "failed", { text: error.message, isError: true, details: error.details });
        } else {
          const text = error instanceof Error ? error.message : String(error);
          this.settle(job, /^cancelled/.test(text) ? "cancelled" : "failed", { text, isError: true });
        }
      },
    );
    // The tool call that starts the job may be aborted before the worker has its assignment: then the job is cancelled too.
    const onAbort = () => { if (!didStart) abort.abort(); };
    startSignal?.addEventListener("abort", onAbort, { once: true });
    if (startSignal?.aborted) onAbort();
    try { await started.promise; } finally { startSignal?.removeEventListener("abort", onAbort); }
    return job;
  }

  /** Record the terminal state once and announce it (not after shutdown: the session that would read it is gone). */
  private settle(job: Job, status: Exclude<JobStatus, "running">, result: NonNullable<Job["result"]>): void {
    if (job.settled) return;
    job.settled = true;
    job.status = status;
    job.finishedAt = Date.now();
    job.result = result;
    this.deps.status?.(undefined);
    const summary = result.details?.status && status === "done" ? `${result.details.status}: ${result.text.split("\n").find(line => line.trim() && !line.startsWith("orche task") && !line.startsWith("Model:")) ?? ""}` : result.text.split("\n")[0];
    this.deps.persist({ event: "end", job: job.id, ...(job.worker ? { worker: job.worker } : {}), at: job.finishedAt, status, summary: (summary ?? "").slice(0, 300), ...(job.record ? { record: job.record } : {}) });
    if (!this.disposed) {
      try { this.deps.deliver(job); } catch { /* the entry above still records the end */ }
    }
  }

  /** The job a tool call names, or the running/most recent one. */
  private pick(id?: string): Job | undefined {
    if (id) return this.jobs.get(id);
    return this.running ?? [...this.jobs.values()].at(-1);
  }

  /** A short status of one job (or the running/last one), for orche_task_status. Never waits. */
  status(id: string | undefined, liveness?: (worker: string) => string | undefined): string {
    const job = this.pick(id);
    if (!job) return id ? `Unknown job ${id}; known jobs: ${[...this.jobs.keys()].join(", ") || "none"}.` : "No orche task jobs in this session.";
    const now = Date.now();
    const head = `${job.id} ${job.status} · ${job.worker ?? "?"} ${job.role}${job.model ? ` · ${job.model}${job.thinking ? ` · thinking ${job.thinking}` : ""}` : ""} · ${job.status === "running" ? `running ${formatDuration(now - job.startedAt)}` : `took ${formatDuration((job.finishedAt ?? now) - job.startedAt)}`}`;
    const lines = [head, `Request: ${job.request}`];
    if (job.status === "running") {
      if (job.progress) lines.push(`Progress: ${job.progress}`);
      const live = job.worker ? liveness?.(job.worker) : undefined;
      if (live) lines.push(`Liveness: ${live}`);
      lines.push("The result arrives as an orche-task-result message when the job ends; there is no need to check again.");
    } else if (job.result) {
      lines.push(`Result (already delivered as a message): ${job.result.text.split("\n").slice(0, 6).join(" ").slice(0, 600)}`);
    }
    if (job.record) lines.push(`Record: ${job.record}`);
    const others = [...this.jobs.values()].filter(other => other !== job).slice(-5).map(other => `${other.id} ${other.status} (${other.worker ?? "?"} ${other.role})`);
    if (others.length) lines.push(`Other jobs: ${others.join(", ")}`);
    return lines.join("\n");
  }

  /** Cancel the running job (or the named one). Resolves once its end is recorded; the cancelled result is announced as a message too. */
  async cancel(id?: string): Promise<string> {
    const job = this.pick(id);
    if (!job) return id ? `Unknown job ${id}.` : "No running job to cancel.";
    if (job.status !== "running") return `${job.id} is not running (${job.status}).`;
    job.abort.abort();
    await Promise.race([job.done, new Promise(resolve => setTimeout(resolve, 15_000).unref())]);
    return job.settled ? `${job.id} cancelled; its final (cancelled) result is delivered as a message.` : `${job.id}: cancellation requested; its result will arrive as a message.`;
  }

  /** Inject a message into the running job's worker. */
  message(id: string | undefined, text: string): { ok: boolean; text: string; details: Record<string, unknown> } {
    const job = id ? this.jobs.get(id) : this.running;
    if (!job) return { ok: false, text: id ? `Unknown job ${id}.` : "No running job: send the message as a new orche_task instead (pass worker to reuse its context).", details: { status: "rejected" } };
    if (job.status !== "running" || !job.worker) return { ok: false, text: `${job.id} is ${job.status}; send the message as a follow-up orche_task to ${job.worker ?? "a worker"} instead.`, details: { job: job.id, status: "rejected" } };
    const receipt = this.deps.pool().inject(job.worker, text);
    if (receipt.status === "rejected") return { ok: false, text: `Not delivered to ${job.worker}: ${receipt.reason}.`, details: { job: job.id, ...receipt } };
    return {
      ok: true,
      text: `Queued ${receipt.id} for ${job.worker} (${job.id}): it reaches the worker after its current tool calls, before its next model request. The job's result lists whether it was delivered; a message the worker could not read before reporting is marked undelivered and should then be sent as a follow-up orche_task.`,
      details: { job: job.id, ...receipt },
    };
  }

  /**
   * Session shutdown: running jobs end as `interrupted` (persisted now, not announced: the session that would read it is going
   * away). The pool's own disposal closes their run records the same way.
   */
  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || job.settled) continue;
      job.settled = true;
      job.status = "interrupted";
      job.finishedAt = Date.now();
      job.result = { text: "interrupted: the pi session shut down while the worker was running", isError: true };
      try { this.deps.persist({ event: "end", job: job.id, ...(job.worker ? { worker: job.worker } : {}), at: job.finishedAt, status: "interrupted", summary: job.result.text, ...(job.record ? { record: job.record } : {}) }); } catch { /* best effort */ }
      job.abort.abort();
    }
    this.disposed = true;
  }
}

/** The message content main receives when a job ends: a one-line header, then the result exactly as a blocking orche_task returns it. */
export function jobResultContent(job: Job): string {
  const header = `[orche task result · ${job.id} · ${job.worker ?? "?"} ${job.role} · ${job.status} after ${formatDuration((job.finishedAt ?? Date.now()) - job.startedAt)}]`;
  const guidance = job.status === "done"
    ? "Review it as the single-workflow rules say and report to the user."
    : job.status === "cancelled" ? "The job was cancelled; tell the user what was done so far." : "The job did not complete; tell the user and decide with them whether to retry (same worker for a follow-up).";
  return `${header}\n${job.result?.text ?? ""}\n\n${guidance}`;
}
