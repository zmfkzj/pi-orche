/**
 * Background orche_task jobs: `orche_task` starts a worker as a job (J1, …) that outlives the tool call. In an interactive or RPC
 * session the call then stays ATTACHED to the job: it waits like a blocking call and returns the job's result itself, unless
 * something DETACHES it first (new user input, a woken session-bus note, Esc/abort, `/orche detach`): then the call returns at
 * once, the worker keeps running, and the result reaches main later as an `orche-task-result` message that starts its next turn.
 * `orche_task_attach` attaches again to a running job. Attaching and detaching never start, restart or cancel a worker: only
 * `orche_task_status {cancel:true}` and `/orche cancel` do. Main can inject instructions into the running worker
 * (`orche_task_message`). One job runs at a time per session (the controller's activity slot, shared with `/orche cancel`).
 *
 * Queue: while a job runs, ONE further task the user explicitly approved (index.ts asks with Pi's own dialog, `ctx.ui.select`) may wait
 * for it (Q1, Q2, …). The slot is taken from the moment the dialog opens (`reserve`) until the queued task has started or was dropped.
 * It starts as a new background job (detached; its result arrives as a message) only after the job it waits for ended `done`; when
 * that job fails, is cancelled or interrupted, the queued task is dropped and announced once (`onQueue`), never started. Approving
 * never cancels, replaces or runs anything next to the running job.
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
import type { DelegatingMode } from "../orchestration/routing.js";

export const JOB_ENTRY_TYPE = "orche-job";
export const WORKER_ENTRY_TYPE = "orche-worker";
export const TASK_RESULT_TYPE = "orche-task-result";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

/** One `orche-job` session entry: the start of a job, or its end. Small; never sent to the model. */
export type JobEntry =
  | { event: "start"; job: string; role: string; worker: string; at: number; request: string; record?: string; sessionFile?: string; model?: string; thinking?: ThinkingLevel; requestMode?: DelegatingMode }
  | { event: "end"; job: string; worker?: string; at: number; status: Exclude<JobStatus, "running">; summary?: string; record?: string }
  /** A task the user approved to run after `after` ended (Q1, …). */
  | { event: "queue"; job: string; after: string; role: string; at: number; request: string; worker?: string }
  /** How a queued task ended: started as job `started`, or dropped (never started) for `reason`. */
  | { event: "queue-end"; job: string; at: number; outcome: "started" | "dropped"; started?: string; reason?: string };

/** The one task waiting for the running job: `asking` while the user's approval dialog is open, `queued` once approved, `starting` from the end of the job it waits for until it started or was dropped. */
export interface QueuedTask {
  id: string;
  /** The job it waits for. */
  after: string;
  role: string;
  request: string;
  worker?: string;
  state: "asking" | "queued" | "starting";
}

/** What became of a queued task (announced once). `source` of a drop: `result` (said in the result of the job it waited for),
 * `start` (it could not start after that result said it would), `cancel` (dropped on request before it started). */
export type QueueEvent =
  | { kind: "started"; task: QueuedTask; job: Job }
  | { kind: "dropped"; task: QueuedTask; reason: string; source: "result" | "start" | "cancel" };

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
  /** What became of the approved task that waited for this job: announced with its result. */
  queueNote?: string;
}

/** A tool result as orche_task returns it. */
export interface JobToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
}

/** Why an attached call stopped waiting while its job keeps running. */
export type DetachReason = "input" | "session-bus" | "abort" | "command" | "background" | "shutdown" | "replaced";

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
  /** A queued task started or was dropped (announced once; not after shutdown). */
  onQueue?: (event: QueueEvent) => void;
  /** Asked right before a queued task starts: a reason it must not start now (e.g. delegation was switched off), else undefined. */
  canStartQueued?: () => string | undefined;
}

type StartArgs = Parameters<WorkerPool["execute"]>[0];
/** What a queued task starts with: the orche_task arguments as the user approved them (no tool call, so no signal or progress callbacks). */
export type QueueArgs = Omit<StartArgs, "signal" | "onStarted" | "onTiming" | "onProgress">;
/** The queue slot: the task and the snapshot it starts with. */
export interface Next { task: QueuedTask; args: QueueArgs }

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
  /** The one task waiting for the running job (see the file comment). */
  private next: Next | undefined;
  private nextQueue = 1;

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

  /** The task waiting for the running job (asking, queued or starting), if any: a copy. */
  get queued(): QueuedTask | undefined {
    return this.next ? { ...this.next.task } : undefined;
  }

  /**
   * Take the one queue slot for a task that would wait for `after` (the running job) while the user is asked; a string says why
   * not (the slot is taken, the job is not running, shut down). `args` is the snapshot that starts later, exactly as approved.
   */
  reserve(after: Job, args: QueueArgs): QueuedTask | string {
    if (this.disposed) return "orche jobs are shut down";
    const taken = this.next?.task;
    if (taken) return `${taken.id} (${taken.role}: ${taken.request}) ${taken.state === "asking" ? "is waiting for the user's approval" : taken.state === "queued" ? `already waits for ${taken.after}` : "is starting"}; at most one task waits for the running job.`;
    if (after.status !== "running" || after.settled) return `${after.id} is not running (${after.status})`;
    const task: QueuedTask = { id: `Q${this.nextQueue++}`, after: after.id, role: args.role, request: shortRequest(args.request), ...(args.worker ? { worker: args.worker } : {}), state: "asking" };
    this.next = { task, args };
    return { ...task };
  }

  /**
   * The user approved the reserved task `id`. While its job still runs it is queued behind it (`queued`); when that job ended
   * while the user was asked, the slot is freed and the ended job is returned (`ended`): the caller decides. `gone`: the
   * reservation no longer exists (session shut down or replaced).
   */
  approve(id: string): { queued: QueuedTask } | { ended: Job } | { gone: true } {
    const next = this.next;
    if (this.disposed || !next || next.task.id !== id || next.task.state !== "asking") return { gone: true };
    const after = this.jobs.get(next.task.after);
    if (!after || after.status !== "running" || after.settled) {
      this.next = undefined;
      return after ? { ended: after } : { gone: true };
    }
    next.task.state = "queued";
    this.deps.persist({ event: "queue", job: id, after: after.id, role: next.task.role, at: Date.now(), request: next.task.request, ...(next.task.worker ? { worker: next.task.worker } : {}) });
    this.changed(after);
    return { queued: { ...next.task } };
  }

  /** Give the reserved slot back: the user did not approve (declined, dismissed, timed out, the dialog failed). */
  withdraw(id: string): void {
    if (this.next?.task.id === id && this.next.task.state === "asking") this.next = undefined;
  }

  /** Drop the queued task `id` (never started): announced once. A string says why not. */
  cancelQueued(id: string): string {
    const next = this.next;
    if (!next || next.task.id !== id) return `No queued task ${id}.`;
    if (next.task.state !== "queued") return `${id} is ${next.task.state === "asking" ? "waiting for the user's approval" : "starting"}; it cannot be dropped now.`;
    this.drop(next, "it was cancelled before it started", "cancel");
    return `${id} dropped: it will not start.`;
  }

  /** The queued task ends without starting: recorded and announced once. */
  private drop(next: Next, reason: string, source: "result" | "start" | "cancel"): void {
    if (this.next !== next) return;
    this.next = undefined;
    if (next.task.state !== "asking") this.deps.persist({ event: "queue-end", job: next.task.id, at: Date.now(), outcome: "dropped", reason });
    const after = this.jobs.get(next.task.after);
    if (after) this.changed(after);
    if (next.task.state === "asking" || this.disposed) return;
    try { this.deps.onQueue?.({ kind: "dropped", task: { ...next.task }, reason, source }); } catch { /* the UI may be gone */ }
  }

  /** The job a queued task waits for has ended: start the task when that job is done, else drop it (never started). */
  private startNext(prev: Job): void {
    const next = this.next;
    if (!next || next.task.after !== prev.id || next.task.state !== "queued") return;
    if (prev.status !== "done") {
      this.drop(next, `${prev.id} ended ${prev.status}, not done; the approval covered running it only after ${prev.id} completed`, "result");
      return;
    }
    next.task.state = "starting";
    // After this settle has returned: the job's own result goes out first, and the activity slot it held is free.
    setTimeout(() => { void this.launch(next); }, 0);
  }

  private async launch(next: Next): Promise<void> {
    if (this.next !== next || this.disposed) return;
    let refused: string | undefined;
    try { refused = this.deps.canStartQueued?.(); } catch (error) { refused = error instanceof Error ? error.message : String(error); }
    if (refused) { this.drop(next, refused, "start"); return; }
    try {
      const { job } = await this.start(next.args, undefined, undefined, next);
      if (this.next !== next) return;
      this.next = undefined;
      this.deps.persist({ event: "queue-end", job: next.task.id, at: Date.now(), outcome: "started", started: job.id });
      this.changed(job);
      if (!this.disposed) try { this.deps.onQueue?.({ kind: "started", task: { ...next.task }, job }); } catch { /* the UI may be gone */ }
    } catch (error) {
      this.drop(next, `it could not start: ${error instanceof Error ? error.message : String(error)}`, "start");
    }
  }

  /** The job a tool call is attached to, if any. */
  get attached(): Job | undefined {
    return this.waiter?.job;
  }

  /** The current attachment (opaque; a new attach, even to the same job, is a different one): a deferred detach checks it is still the same. */
  get attachment(): object | undefined {
    return this.waiter;
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
   * one notice to main. A queued task that neither started nor was dropped never starts after the session that queued it ended:
   * it is dropped now (persisted, once) and returned for the same notice. Returns the gone workers and every worker id used, for the pool.
   */
  restore(jobEntries: readonly JobEntry[], workerEntries: readonly GoneWorker[]): { interrupted: Job[]; droppedQueue: QueuedTask[]; gone: GoneWorker[]; usedWorkerIds: string[] } {
    this.jobs.clear();
    this.next = undefined;
    const starts = new Map<string, Extract<JobEntry, { event: "start" }>>();
    const ends = new Map<string, Extract<JobEntry, { event: "end" }>>();
    const queues = new Map<string, Extract<JobEntry, { event: "queue" }>>();
    const queueEnds = new Set<string>();
    for (const entry of jobEntries) {
      if (entry.event === "queue") queues.set(entry.job, entry);
      else if (entry.event === "queue-end") queueEnds.add(entry.job);
      else if (entry.event === "start") starts.set(entry.job, entry);
      else if (entry.event === "end") ends.set(entry.job, entry);
      const n = /^J(\d+)$/.exec(entry.job)?.[1];
      if (n) this.nextJob = Math.max(this.nextJob, Number(n) + 1);
      const q = /^Q(\d+)$/.exec(entry.job)?.[1];
      if (q) this.nextQueue = Math.max(this.nextQueue, Number(q) + 1);
    }
    const droppedQueue: QueuedTask[] = [];
    for (const [id, queued] of queues) {
      if (queueEnds.has(id)) continue;
      droppedQueue.push({ id, after: queued.after, role: queued.role, request: queued.request, ...(queued.worker ? { worker: queued.worker } : {}), state: "queued" });
      this.deps.persist({ event: "queue-end", job: id, at: Date.now(), outcome: "dropped", reason: "the pi session that queued it ended before it started" });
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
    return { interrupted, droppedQueue, gone: [...gone.values()], usedWorkerIds: [...new Set([...starts.values()].map(start => start.worker))] };
  }

  /**
   * Start a job: resolves with the job once its worker has the assignment, or rejects with the error that stopped it before that
   * (unknown worker, bad grant, busy session, startup failure: nothing ran, nothing is announced). Everything after the start is
   * announced exactly once: to the attached call, or through `deliver`. With `attach`, the call is attached from the moment the
   * worker has its assignment (no gap in which a fast result could slip out as a message); `outcome` then resolves like
   * {@link TaskJobs.attach}.
   */
  async start(args: Omit<StartArgs, "signal" | "onStarted">, startSignal?: AbortSignal, attach?: AttachOptions, queued?: Next): Promise<{ job: Job; outcome?: Promise<AttachOutcome> }> {
    if (this.disposed) throw new Error("orche jobs are shut down");
    const running = this.running;
    if (running) throw new Error(`Job ${running.id} (${running.worker ?? "worker starting"}, ${running.role}) is still running; one task runs at a time. Attach to it with orche_task_attach {"job":"${running.id}"} to wait for its result, add instructions with orche_task_message, or stop it with orche_task_status {"job":"${running.id}","cancel":true}.`);
    // The approved queued task has the next turn; only it may start while it is starting.
    if (this.next?.task.state === "starting" && this.next !== queued) throw new Error(`The approved queued task ${this.next.task.id} (${this.next.task.role}: ${this.next.task.request}) is starting now; one task runs at a time.`);
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
        this.deps.persist({ event: "start", job: id, role: args.role, worker: info.worker, at: job.startedAt, request: job.request, ...(info.record ? { record: info.record } : {}), ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}), ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}), ...(info.requestMode ? { requestMode: info.requestMode } : {}) });
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
    // An approved task waiting for this job: what becomes of it goes with this result, once (attached call or message).
    const next = this.next?.task.after === job.id && this.next.task.state === "queued" ? this.next.task : undefined;
    if (next) job.queueNote = status === "done"
      ? `The task the user approved to run after ${job.id}, ${next.id} (${next.role}: ${next.request}), starts now as its own background job; its result arrives as an orche-task-result message. Review this result first.`
      : `The task the user approved to run after ${job.id}, ${next.id} (${next.role}: ${next.request}), is dropped and will not start: ${job.id} ended ${status}, and the approval covered running it only after ${job.id} completed. Tell the user; delegate it again only when they ask.`;
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
    this.startNext(job);
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
    const next = this.next?.task;
    if (next) lines.push(`Queued: ${next.id} (${next.role}: ${next.request}) ${next.state === "asking" ? "is waiting for the user's approval" : next.state === "queued" ? `was approved by the user and starts after ${next.after} ends done (dropped if it fails or is cancelled)` : "is starting"}.`);
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
    // A queued task never starts after its session: left without a queue-end entry, the next session start drops it and says so once (restore).
    this.next = undefined;
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
  return `${header}\n${job.result?.text ?? ""}\n\n${guidance}${job.queueNote ? `\n\n${job.queueNote}` : ""}`;
}
