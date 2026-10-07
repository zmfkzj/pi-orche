/**
 * Background orche_task jobs: `orche_task` starts a worker as a job (J1, …) that outlives the tool call. In an interactive or RPC
 * session the call then stays ATTACHED to the job: it waits like a blocking call and returns the job's result itself, unless
 * something DETACHES it first (new user input, a woken session-bus note, Esc/abort, `/orche detach`): then the call returns at
 * once, the worker keeps running, and the result reaches main later as an `orche-task-result` message that starts its next turn.
 * `orche_task_attach` attaches again to a running job. Attaching and detaching never start, restart or cancel a worker: only
 * `orche_task_status {cancel:true}` and `/orche cancel` do. Main can inject instructions into the running worker
 * (`orche_task_message`). One job runs at a time per session (the controller's activity slot, shared with `/orche cancel`).
 *
 * Exactly-once delivery: every job ends in exactly one terminal state (done | failed | cancelled | interrupted), recorded once as an
 * `orche-job` session entry and announced once: to the attached tool call when one waits for it (`delivered: "tool"`), otherwise
 * as one message (`delivered: "message"`). Settling and detaching are synchronous, so exactly one of them wins a race. A job that
 * was running when the session shut down (reload, exit, session switch) ends as `interrupted` in its entry and its run record; one
 * found running at the next session start (a crash) is closed then and announced to main once. Worker ids and job ids are never
 * reused within a session branch.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { formatDuration } from "../agent/liveness.js";
import { TaskFailedError, type GoneWorker, type TaskDetails, type TaskStartedInfo, type WorkerPool } from "./workers.js";
import type { RunTiming } from "./progress.js";

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
  /** The newest progress lines of the worker and the timing of its assignment (for an attached call's live block and the widget). */
  lines?: readonly string[];
  timing?: RunTiming;
  /** The final result as delivered (text for the model and its details). */
  result?: { text: string; isError: boolean; details?: TaskDetails };
  /** The final result exactly as a blocking orche_task returns it (what an attached call returns). */
  toolResult?: JobToolResult;
  /** Where the terminal result went: to the attached tool call or as one message (unset while running and for restored jobs). */
  delivered?: "tool" | "message";
  abort: AbortController;
  done: Promise<void>;
  /** Set once the terminal state is recorded and announced: never twice. */
  settled: boolean;
}

/** A tool result as orche_task returns it. */
export interface JobToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
}

/** Why an attached call stopped waiting while its job keeps running. */
export type DetachReason = "input" | "followUp" | "session-bus" | "abort" | "command" | "background" | "shutdown" | "replaced";

/** How an attach ended. */
export type AttachOutcome =
  /** The job ended while attached: its result goes to this call (never as a message). */
  | { kind: "ended"; job: Job }
  /** Detached: the job keeps running; its result comes as a message unless a later attach takes it. */
  | { kind: "detached"; job: Job; reason: DetachReason }
  /** The job had already ended: its result was (or is about to be) delivered as a message. */
  | { kind: "already-ended"; job: Job }
  /** Input is waiting for main: no attach now. */
  | { kind: "pending"; job: Job }
  /** No such job. */
  | { kind: "none"; text: string };

export interface AttachOptions {
  /** Aborting it (Esc, RPC abort) detaches; it never cancels the job once the worker has its assignment. */
  signal?: AbortSignal;
  /** Whether input is already waiting for main (user prompts queued, a woken peer note not yet delivered): then do not attach. */
  pending?: () => boolean;
  /** Called on every progress/timing change of the attached job. */
  onUpdate?: (job: Job) => void;
}

interface Waiter {
  job: Job;
  options: AttachOptions;
  settle: (outcome: AttachOutcome) => void;
  promise: Promise<AttachOutcome>;
}

export interface JobDeps {
  pool: () => WorkerPool;
  /** Persist one entry (pi.appendEntry). Best effort. */
  persist: (entry: JobEntry) => void;
  /** Hand the final result to the main session (pi.sendMessage with a turn trigger). */
  deliver: (job: Job) => void;
  /** A job changed: started, progress, attached, detached or ended (status widget). */
  onChange?: (job: Job) => void;
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
  /** The one tool call attached to a running job, if any. */
  private waiter: Waiter | undefined;

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

  /** The job a tool call is attached to, if any. */
  get attached(): Job | undefined {
    return this.waiter?.job;
  }

  private changed(job: Job): void {
    try { this.deps.onChange?.(job); } catch { /* the UI may be gone */ }
  }

  /** Register the attached call of `job` (synchronously: a settle right after sees it). */
  private wait(job: Job, options: AttachOptions): Waiter {
    if (this.waiter) this.detach("replaced");
    const outcome = Promise.withResolvers<AttachOutcome>();
    const onAbort = () => { if (this.waiter === waiter) this.detach("abort"); };
    const waiter: Waiter = {
      job, options, promise: outcome.promise,
      settle: result => { options.signal?.removeEventListener("abort", onAbort); outcome.resolve(result); },
    };
    this.waiter = waiter;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.changed(job);
    if (options.signal?.aborted) onAbort();
    return waiter;
  }

  /**
   * Attach to a running job (the named one, else the running one): resolves when it ends (its result is then this call's, never a
   * message) or when something detaches the call (the job keeps running). Never attaches when the job has ended, when there is no
   * job, or when input is already waiting for main (`options.pending`).
   */
  attach(id: string | undefined, options: AttachOptions = {}): Promise<AttachOutcome> {
    const job = id ? this.jobs.get(id) : this.running ?? [...this.jobs.values()].at(-1);
    if (!job) return Promise.resolve({ kind: "none", text: id ? `Unknown job ${id}; known jobs: ${[...this.jobs.keys()].join(", ") || "none"}.` : "No orche task jobs in this session." });
    if (job.status !== "running" || job.settled) return Promise.resolve({ kind: "already-ended", job });
    if (this.disposed) return Promise.resolve({ kind: "detached", job, reason: "shutdown" });
    if (options.pending?.()) return Promise.resolve({ kind: "pending", job });
    return this.wait(job, options).promise;
  }

  /** Detach the attached call (if any): it returns at once, the job keeps running. True when a call was attached. */
  detach(reason: DetachReason): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = undefined;
    waiter.settle({ kind: "detached", job: waiter.job, reason });
    this.changed(waiter.job);
    return true;
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
   * announced exactly once: to the attached call, or through `deliver`. With `attach`, the call is attached from the moment the
   * worker has its assignment (no gap in which a fast result could slip out as a message); `outcome` then resolves like
   * {@link TaskJobs.attach}.
   */
  async start(args: Omit<StartArgs, "signal" | "onStarted">, startSignal?: AbortSignal, attach?: AttachOptions): Promise<{ job: Job; outcome?: Promise<AttachOutcome> }> {
    if (this.disposed) throw new Error("orche jobs are shut down");
    const running = this.running;
    if (running) throw new Error(`Job ${running.id} (${running.worker ?? "worker starting"}, ${running.role}) is still running; one task runs at a time. Attach to it with orche_task_attach {"job":"${running.id}"} to wait for its result, add instructions with orche_task_message, or stop it with orche_task_status {"job":"${running.id}","cancel":true}.`);
    const abort = new AbortController();
    const id = `J${this.nextJob++}`;
    const started = Promise.withResolvers<TaskStartedInfo>();
    const job: Job = { id, role: args.role, request: shortRequest(args.request), startedAt: Date.now(), status: "running", abort, done: Promise.resolve(), settled: false };
    let didStart = false;
    let waiter: Waiter | undefined;
    const execution = this.deps.pool().execute({
      ...args,
      signal: abort.signal,
      onStarted: info => {
        didStart = true;
        Object.assign(job, { worker: info.worker, ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}), ...(info.record ? { record: info.record } : {}), ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}) });
        this.jobs.set(id, job);
        this.deps.persist({ event: "start", job: id, role: args.role, worker: info.worker, at: job.startedAt, request: job.request, ...(info.record ? { record: info.record } : {}), ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}), ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}) });
        if (attach) waiter = this.wait(job, attach); else this.changed(job);
        started.resolve(info);
      },
      onTiming: (timing, lines) => {
        job.timing = timing;
        if (lines.length) { job.lines = lines; job.progress = lines.at(-1); }
        this.progressed(job);
        args.onTiming?.(timing, lines);
      },
      onProgress: (lines, timing) => {
        if (lines.length) { job.lines = lines; job.progress = lines.at(-1); }
        if (timing) job.timing = timing;
        this.progressed(job);
        args.onProgress?.(lines, timing);
      },
    });
    job.done = execution.then(
      result => this.settle(job, "done", { text: result.text, isError: false, details: result.details }),
      error => {
        if (!didStart) { started.reject(error); return; }
        if (error instanceof TaskFailedError) {
          this.settle(job, error.failure.kind === "cancelled" ? "cancelled" : "failed", { text: error.message, isError: true, details: error.details }, error.toolResult() as unknown as JobToolResult);
        } else {
          const text = error instanceof Error ? error.message : String(error);
          this.settle(job, /^cancelled/.test(text) ? "cancelled" : "failed", { text, isError: true }, { content: [{ type: "text", text }], details: {}, isError: true });
        }
      },
    );
    // The tool call that starts the job may be aborted before the worker has its assignment: then the job is cancelled too.
    const onAbort = () => { if (!didStart) abort.abort(); };
    startSignal?.addEventListener("abort", onAbort, { once: true });
    if (startSignal?.aborted) onAbort();
    try { await started.promise; } finally { startSignal?.removeEventListener("abort", onAbort); }
    return { job, ...(waiter ? { outcome: waiter.promise } : {}) };
  }

  /** A progress/timing change of a running job: the attached call's live block and the widget. */
  private progressed(job: Job): void {
    if (job.status !== "running") return;
    if (this.waiter?.job === job) {
      try { this.waiter.options.onUpdate?.(job); } catch { /* the call's UI may be gone */ }
    }
    this.changed(job);
  }

  /**
   * Record the terminal state once and announce it once: to the attached call when one waits for this job, else as a message (not
   * after shutdown: the session that would read it is gone).
   */
  private settle(job: Job, status: Exclude<JobStatus, "running">, result: NonNullable<Job["result"]>, toolResult?: JobToolResult): void {
    if (job.settled) return;
    job.settled = true;
    job.status = status;
    job.finishedAt = Date.now();
    job.result = result;
    job.toolResult = toolResult ?? { content: [{ type: "text", text: result.text }], details: { ...(result.details ?? {}) }, ...(result.isError ? { isError: true } : {}) };
    const summary = result.details?.status && status === "done" ? `${result.details.status}: ${result.text.split("\n").find(line => line.trim() && !line.startsWith("orche task") && !line.startsWith("Model:")) ?? ""}` : result.text.split("\n")[0];
    this.deps.persist({ event: "end", job: job.id, ...(job.worker ? { worker: job.worker } : {}), at: job.finishedAt, status, summary: (summary ?? "").slice(0, 300), ...(job.record ? { record: job.record } : {}) });
    const waiter = this.waiter?.job === job ? this.waiter : undefined;
    if (waiter) {
      this.waiter = undefined;
      job.delivered = "tool";
      waiter.settle({ kind: "ended", job });
    } else if (!this.disposed) {
      job.delivered = "message";
      try { this.deps.deliver(job); } catch { /* the entry above still records the end */ }
    }
    this.changed(job);
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
      lines.push(this.waiter?.job === job ? "A tool call is attached to it and returns its result." : "Detached: its result arrives as an orche-task-result message when it ends; orche_task_attach waits for it once you have nothing else to answer. There is no need to check status again.");
    } else if (job.result) {
      lines.push(`Result (already delivered ${job.delivered === "tool" ? "to the attached tool call" : "as a message"}): ${job.result.text.split("\n").slice(0, 6).join(" ").slice(0, 600)}`);
    }
    if (job.record) lines.push(`Record: ${job.record}`);
    const others = [...this.jobs.values()].filter(other => other !== job).slice(-5).map(other => `${other.id} ${other.status} (${other.worker ?? "?"} ${other.role})`);
    if (others.length) lines.push(`Other jobs: ${others.join(", ")}`);
    return lines.join("\n");
  }

  /** Cancel the running job (or the named one). Resolves once its end is recorded; the cancelled result is announced once too (attached call or message). */
  async cancel(id?: string): Promise<string> {
    const job = this.pick(id);
    if (!job) return id ? `Unknown job ${id}.` : "No running job to cancel.";
    if (job.status !== "running") return `${job.id} is not running (${job.status}).`;
    job.abort.abort();
    await Promise.race([job.done, new Promise(resolve => setTimeout(resolve, 15_000).unref())]);
    return job.settled ? `${job.id} cancelled; its final (cancelled) result is delivered ${job.delivered === "tool" ? "to the attached tool call" : "as a message"}.` : `${job.id}: cancellation requested; its result will arrive as a message.`;
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
    this.detach("shutdown");
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
