import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  AgentSession,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession } from "../pi/session-factory.js";
import { SessionAdapter } from "../pi/session-adapter.js";
import { WORKER_TOOL_NAMES } from "../tools/index.js";
import { MessageRouter } from "../messaging/message-router.js";
import type {
  DeliveryReceipt,
  NoteMessage,
  OrcheMessage,
} from "../messaging/message.js";
import type {
  AgentManagerOptions,
  AgentHandle,
  AgentSnapshot,
  Assignment,
  ManagerEvent,
  Outcome,
  ResultDataSchema,
  ResultPayload,
  SpawnOptions,
  ToolExecutionEvent,
  WaitResult,
} from "./agent-handle.js";
/** Requests a forced final report may take after a budget stop before the assignment fails. */
export const BUDGET_GRACE_REQUESTS = 5;
interface Worker {
  snapshot: AgentSnapshot;
  adapter: SessionAdapter;
  epoch: number;
  nudges: number;
  runAssignment?: Assignment;
  result?: ResultPayload;
  failure?: string;
  /** RESULTs rejected by the kind's data contract during the current assignment. */
  rejections: number;
  /** Set once the rejections exceed the retry cap; the assignment then fails. */
  resultFailure?: string;
  /** Model requests of the current assignment, for the soft request budget. */
  requests: number;
  /** Budget ladder: none → noticed (wrap-up notice sent) → stopping (turn aborted) → final (forced report prompt). */
  budget: "none" | "noticed" | "stopping" | "final";
  abort?: Promise<void>;
  unsubscribe: () => void;
}
export class AgentManager {
  private readonly workers = new Map<string, Worker>();
  private readonly listeners = new Set<(event: ManagerEvent) => void>();
  private readonly wake = new Set<() => void>();
  private readonly outcomes: Outcome[] = [];
  private readonly inbox: NoteMessage[] = [];
  private readonly router = new MessageRouter(
    (id) => id === "main" || this.workers.has(id),
    (message) => this.deliver(message),
  );
  private modelRuntime: Promise<ModelRuntime> | undefined;
  private readonly resultNudges: number;
  private readonly resultSchemas: Readonly<Record<string, ResultDataSchema>>;
  private readonly resultSchemaRetries: number;
  private readonly requestBudget: number;
  private readonly closed = new AbortController();
  private readonly pendingSpawns = new Set<string>();
  /** One-way fence: prevents new assignments, prompts and manager tool side effects. */
  close(reason: unknown = "Agent manager closed"): void {
    if (!this.closed.signal.aborted) this.closed.abort(reason);
    for (const wake of [...this.wake]) wake();
  }
  private assertOpen(signal?: AbortSignal): void {
    if (this.closed.signal.aborted || signal?.aborted) {
      const error = new Error(String(this.closed.signal.reason ?? signal?.reason ?? "Aborted"));
      error.name = "AbortError";
      throw error;
    }
  }
  constructor(modelRuntime?: ModelRuntime, options: AgentManagerOptions = {}) {
    this.resultNudges = options.resultNudges ?? 1;
    if (!Number.isSafeInteger(this.resultNudges) || this.resultNudges < 0)
      throw new Error("resultNudges must be a nonnegative safe integer");
    this.resultSchemas = options.resultSchemas ?? {};
    this.resultSchemaRetries = options.resultSchemaRetries ?? 3;
    if (!Number.isSafeInteger(this.resultSchemaRetries) || this.resultSchemaRetries < 0)
      throw new Error("resultSchemaRetries must be a nonnegative safe integer");
    this.requestBudget = options.requestBudget ?? 0;
    if (!Number.isSafeInteger(this.requestBudget) || this.requestBudget < 0)
      throw new Error("requestBudget must be a nonnegative safe integer");
    this.modelRuntime = modelRuntime ? Promise.resolve(modelRuntime) : undefined;
  }
  async spawn(options: SpawnOptions): Promise<AgentHandle> {
    this.assertOpen(options.signal);
    if (options.id === "main" || this.workers.has(options.id) || this.pendingSpawns.has(options.id))
      throw new Error(`Reserved or duplicate agent id: ${options.id}`);
    let worker: Worker;
    const report: ToolDefinition = {
      name: "report_result",
      label: "Report result",
      description:
        "Complete the current assignment. First result wins. Call alone, not alongside other tools.",
      parameters: Type.Object({
        kind: Type.String(),
        summary: Type.String(),
        data: Type.Optional(Type.Unknown()),
      }),
      execute: async (_id, args) => {
        if (
          this.closed.signal.aborted || options.signal?.aborted ||
          !worker.snapshot.currentAssignment ||
          worker.snapshot.status !== "running" ||
          worker.result ||
          worker.resultFailure
        )
          return {
            content: [
              {
                type: "text",
                text: "Result rejected: assignment inactive or already reported",
              },
            ],
            details: { accepted: false },
            isError: true,
            terminate: true,
          };
        const payload = args as ResultPayload;
        const contract = this.resultSchemas[worker.snapshot.currentAssignment.kind];
        if (payload.kind !== worker.snapshot.currentAssignment.kind)
          return this.rejectResult(worker, `Expected RESULT kind "${worker.snapshot.currentAssignment.kind}"; received "${payload.kind}"`, contract);
        const errors = contract ? resultDataErrors(contract, payload.data) : undefined;
        if (errors) return this.rejectResult(worker, errors, contract!);
        worker.result = payload;
        return {
          content: [
            { type: "text", text: "Result accepted; assignment complete" },
          ],
          details: { accepted: true },
          terminate: true,
        };
      },
    };
    const send: ToolDefinition = {
      name: "send_message",
      label: "Send NOTE",
      description:
        "Send information to a peer or main without interrupting its tools.",
      parameters: Type.Object({
        to: Type.String(),
        content: Type.String(),
        signal: Type.Optional(
          Type.Object({
            kind: Type.String(),
            cause: Type.Optional(Type.String()),
            evidence: Type.Optional(Type.Unknown()),
            confidence: Type.Optional(Type.Number()),
            data: Type.Optional(Type.Unknown()),
          }),
        ),
      }),
      execute: async (_id, args) => {
        if (this.closed.signal.aborted || options.signal?.aborted) return {
          content: [{ type: "text", text: "NOTE rejected: manager or worker creation cancelled" }],
          details: { accepted: false }, isError: true,
        };
        const payload = args as {
          to: string;
          content: string;
          signal?: NoteMessage["signal"];
        };
        const receipt = await this.send({
          id: randomUUID(),
          from: options.id,
          type: "note",
          ...payload,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          details: receipt,
          isError: receipt.status === "rejected",
        };
      },
    };
    const tools = [
      ...(options.tools ?? WORKER_TOOL_NAMES),
      "report_result",
      ...(options.peerMessaging === false ? [] : ["send_message"]),
    ];
    this.pendingSpawns.add(options.id);
    const signal = options.signal
      ? AbortSignal.any([this.closed.signal, options.signal]) : this.closed.signal;
    const creation = (async () => {
      const modelRuntime = options.modelRuntime ?? await (this.modelRuntime ??= ModelRuntime.create());
      this.assertOpen(signal);
      const session = await createSession({
        ...options, modelRuntime, tools,
        customTools: [...(options.customTools ?? []), report, ...(options.peerMessaging === false ? [] : [send])],
        instructions: `${options.instructions}\nComplete assignments with report_result.${options.peerMessaging === false ? "" : " Send peers information using send_message."} NOTES are informational, not new assignments.`,
      });
      if (signal.aborted) {
        session.dispose();
        this.assertOpen(signal);
      }
      return session;
    })();
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const error = new Error(String(signal.reason ?? "Aborted"));
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    let session: AgentSession;
    try {
      session = await Promise.race([creation, cancelled]);
      // Cancellation can win between creation resolution and this continuation.
      if (signal.aborted) { session.dispose(); this.assertOpen(signal); }
    } finally {
      signal.removeEventListener("abort", onAbort);
      // Keep ids reserved while an uncooperative creation is still in flight.
      void creation.then(() => this.pendingSpawns.delete(options.id), () => this.pendingSpawns.delete(options.id));
    }
    const adapter = new SessionAdapter(session);
    worker = {
      snapshot: {
        id: options.id,
        role: options.role,
        route: options.route,
        status: "idle",
        completedAssignments: 0,
      },
      adapter,
      epoch: 0,
      nudges: 0,
      rejections: 0,
      requests: 0,
      budget: "none",
      unsubscribe: () => {},
    };
    worker.unsubscribe = adapter.subscribe((event) => {
      // Tool tracking comes first: an end or settle must still be seen while the manager closes,
      // otherwise the observer would think a tool is running forever. Arguments go to this callback
      // only, never into the public event stream.
      if (options.onToolExecution) {
        if (event.type === "tool_execution_start") notifyTool(options, { phase: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        else if (event.type === "tool_execution_end") notifyTool(options, { phase: "end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        else if (event.type === "agent_settled") notifyTool(options, { phase: "settled" });
      }
      if (this.closed.signal.aborted || worker.snapshot.status === "disposed") return;
      worker.snapshot.lastActivityAt = Date.now();
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        worker.snapshot.lastToolName = event.toolName;
        worker.snapshot.lastToolAt = Date.now();
        if (event.type === "tool_execution_start" && worker.runAssignment) {
          this.emit({ type: "tool_started", timestamp: Date.now(), agentId: options.id, assignmentId: worker.runAssignment.id, toolName: event.toolName });
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const assignment = worker.runAssignment;
        if (assignment) {
          const u = event.message.usage;
          // The request ended by our own budget stop is not a model failure and not a further request.
          const ownAbort = worker.budget === "stopping" || (worker.budget === "final" && worker.resultFailure !== undefined);
          const budgetAborted = ownAbort && (event.message.stopReason === "error" || event.message.stopReason === "aborted");
          worker.failure =
            event.message.stopReason === "error" && !budgetAborted
              ? (event.message.errorMessage ?? "Model error")
              : undefined;
          const reporting = event.message.content.some(part => part.type === "toolCall" && part.name === "report_result");
          if (!budgetAborted) this.trackBudget(worker, assignment, reporting);
          this.emit({
            type: "usage", timestamp: Date.now(), agentId: options.id, assignmentId: assignment.id,
            model: `${event.message.provider}/${event.message.model}`,
            input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
          });
        }
      } else if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-orche.note"
      ) {
        const message = event.message.details as NoteMessage;
        this.emit({
          type: "message_delivered",
          timestamp: Date.now(),
          message,
          receipt: { id: message.id, status: "delivered", mode: "context" },
        });
      } else if (event.type === "agent_settled") {
        worker.runAssignment = undefined;
        const assignment = worker.snapshot.currentAssignment;
        const failed = Boolean(worker.failure ?? worker.resultFailure);
        const reportable = assignment && worker.snapshot.status === "running" && !worker.result && !failed;
        if (reportable && worker.budget === "stopping") {
          worker.budget = "final";
          this.runAssignment(worker, assignment, `Your request budget for assignment ${assignment.kind} is exhausted and your turn was stopped. Call report_result alone now with what you have: partial findings are fine; for implement/fix use data.status "blocked" with the reason if the work is unfinished.`);
        } else if (reportable && worker.nudges < this.resultNudges) {
          worker.nudges++;
          this.emit({ type: "assignment_nudged", timestamp: Date.now(), agentId: options.id, assignmentId: assignment.id, attempt: worker.nudges });
          this.runAssignment(worker, assignment, `You ended without calling report_result for assignment ${assignment.kind}. Call report_result alone now with your result.`);
        } else {
          this.finalize(worker, failed ? "failed" : worker.result ? "completed" : "no_result");
        }
      }
    });
    this.workers.set(options.id, worker);
    return {
      id: options.id,
      assign: (kind, prompt) => this.assign(options.id, kind, prompt),
      stop: () => this.stop(options.id),
      get: () => this.get(options.id),
    };
  }
  assign(agentId: string, kind: string, prompt: string): Assignment {
    this.assertOpen();
    const w = this.require(agentId);
    if (w.snapshot.status !== "idle")
      throw new Error(`Agent ${agentId} is ${w.snapshot.status}`);
    const assignment = { id: randomUUID(), kind, prompt, epoch: ++w.epoch };
    w.snapshot.currentAssignment = assignment;
    w.runAssignment = assignment;
    w.snapshot.status = "running";
    w.result = undefined;
    w.failure = undefined;
    w.nudges = 0;
    w.rejections = 0;
    w.resultFailure = undefined;
    w.requests = 0;
    w.budget = "none";
    w.snapshot.requestCount = 0;
    w.snapshot.lastActivityAt = Date.now();
    w.snapshot.lastToolName = undefined;
    w.snapshot.lastToolAt = undefined;
    this.emit({
      type: "assignment_started",
      timestamp: Date.now(),
      agentId,
      assignment,
    });
    this.runAssignment(w, assignment, prompt);
    return assignment;
  }
  private runAssignment(w: Worker, assignment: Assignment, prompt: string): void {
    void Promise.resolve().then(async () => {
      await w.adapter.session.waitForIdle();
      if (
        this.closed.signal.aborted ||
        w.snapshot.currentAssignment !== assignment ||
        w.snapshot.status !== "running"
      )
        return;
      w.runAssignment = assignment;
      try {
        await w.adapter.run(prompt);
      } catch (error) {
        if (w.snapshot.currentAssignment === assignment) {
          w.failure = String(error);
          this.finalize(w, "failed");
        }
      }
    }).catch(error => {
      if (w.snapshot.currentAssignment === assignment && !this.closed.signal.aborted) {
        w.failure = String(error);
        this.finalize(w, "failed");
      }
    });
  }
  /**
   * Soft request budget (after OMP's task budgets): a wrap-up notice at the budget, a stopped
   * turn plus one forced report prompt at 1.5x, and a failed assignment if that prompt still
   * runs on for {@link BUDGET_GRACE_REQUESTS} more requests without a RESULT.
   */
  private trackBudget(w: Worker, assignment: Assignment, reporting: boolean): void {
    w.snapshot.requestCount = ++w.requests;
    if (!this.requestBudget) return;
    const budget = this.requestBudget;
    const stopAt = Math.ceil(budget * 1.5);
    const emit = (action: "notice" | "stop" | "abort") => this.emit({
      type: "request_budget", timestamp: Date.now(), agentId: w.snapshot.id,
      assignmentId: assignment.id, requests: w.requests, budget, action,
    });
    if (w.budget === "none" && w.requests >= budget) {
      w.budget = "noticed";
      emit("notice");
      void w.adapter.notice(`You have used ${w.requests} model requests on this assignment (soft budget ${budget}). Wrap up now: finish the current step and call report_result alone. At ${stopAt} requests your turn is stopped and you must report what you have.`).catch(() => undefined);
    } else if (w.budget === "noticed" && w.requests >= stopAt && !w.result && !reporting) {
      // A request that already calls report_result is allowed to land instead of being aborted.
      w.budget = "stopping";
      emit("stop");
      void w.adapter.abort().catch(() => undefined);
    } else if (w.budget === "final" && w.requests >= stopAt + BUDGET_GRACE_REQUESTS && !w.result && !w.resultFailure && !reporting) {
      w.resultFailure = `Request budget exhausted after ${w.requests} requests without a RESULT`;
      emit("abort");
      void w.adapter.abort().catch(() => undefined);
    }
  }
  /** Resolves once an in-flight interruption of `agentId` (stop/redirect abort) has settled. */
  async settle(agentId: string): Promise<void> {
    await this.require(agentId).abort?.catch(() => undefined);
  }
  send(message: OrcheMessage): Promise<DeliveryReceipt> {
    if (this.closed.signal.aborted) return Promise.resolve({ id: message.id, status: "rejected", mode: "context", reason: "Agent manager closed" });
    return this.router.send(message);
  }
  private async deliver(message: OrcheMessage): Promise<DeliveryReceipt> {
    if (this.closed.signal.aborted) return { id: message.id, status: "rejected", mode: "context", reason: "Agent manager closed" };
    this.emit({ type: "message_sent", timestamp: Date.now(), message });
    if (message.type === "note") {
      if (message.to === "main") {
        this.inbox.push(message);
        const receipt: DeliveryReceipt = {
          id: message.id,
          status: "delivered",
          mode: "inbox",
        };
        this.emit({
          type: "message_delivered",
          timestamp: Date.now(),
          message,
          receipt,
        });
        return receipt;
      }
      const w = this.require(message.to);
      if (w.snapshot.status === "disposed")
        return {
          id: message.id,
          status: "rejected",
          mode: "context",
          reason: "Agent disposed",
        };
      await w.adapter.note(message);
      return { id: message.id, status: "delivered", mode: "context" };
    }
    const w = this.require(message.to);
    const mode = message.type === "stop" ? "abort" : "abort-prompt";
    if (w.snapshot.status === "disposed")
      return {
        id: message.id,
        status: "rejected",
        mode,
        reason: "Agent disposed",
      };
    await this.interrupt(w, message.type === "stop" ? "stopped" : "superseded");
    if (message.type === "redirect")
      this.assign(message.to, message.kind, message.prompt);
    const receipt: DeliveryReceipt = {
      id: message.id,
      status: "delivered",
      mode,
    };
    this.emit({
      type: "message_delivered",
      timestamp: Date.now(),
      message,
      receipt,
    });
    return receipt;
  }
  async stop(agentId: string): Promise<void> {
    await this.interrupt(this.require(agentId), "stopped");
  }
  private async interrupt(
    w: Worker,
    status: "stopped" | "superseded",
  ): Promise<void> {
    if (w.abort) {
      await w.abort;
      return;
    }
    if (w.snapshot.status === "idle" || w.snapshot.status === "disposed")
      return;
    w.snapshot.status = "stopping";
    ++w.epoch;
    this.finalize(w, w.result ? "completed" : status, false);
    const pending = w.adapter.abort();
    w.abort = pending;
    try {
      await pending;
    } finally {
      w.abort = undefined;
      w.runAssignment = undefined;
      if (this.get(w.snapshot.id).status !== "disposed") w.snapshot.status = "idle";
    }
  }
  private finalize(w: Worker, status: Outcome["status"], idle = true): void {
    const a = w.snapshot.currentAssignment;
    if (!a) return;
    const outcome: Outcome = {
      agentId: w.snapshot.id,
      assignmentId: a.id,
      kind: a.kind,
      status,
      timestamp: Date.now(),
      ...(w.result ? { result: w.result } : {}),
      ...(status === "no_result" ? { lastText: w.adapter.lastText } : {}),
      ...(w.failure ?? w.resultFailure ? { error: w.failure ?? w.resultFailure } : {}),
    };
    w.snapshot.currentAssignment = undefined;
    w.snapshot.completedAssignments++;
    if (idle && w.snapshot.status !== "stopping") w.snapshot.status = "idle";
    w.result = undefined;
    w.failure = undefined;
    w.resultFailure = undefined;
    this.outcomes.push(outcome);
    this.emit({
      type: "assignment_outcome",
      timestamp: outcome.timestamp,
      outcome,
    });
  }
  /**
   * Reject a wrong-kind RESULT or invalid `data`, sharing one assignment-local retry cap.
   * Rejections do not terminate the turn, so the worker corrects in place; past the retry cap
   * the turn ends and the assignment fails with the last validation errors.
   */
  private rejectResult(w: Worker, errors: string, contract?: ResultDataSchema) {
    const assignment = w.snapshot.currentAssignment!;
    w.rejections++;
    this.emit({
      type: "result_rejected", timestamp: Date.now(), agentId: w.snapshot.id,
      assignmentId: assignment.id, kind: assignment.kind, attempt: w.rejections, errors,
    });
    const remaining = this.resultSchemaRetries - w.rejections + 1;
    if (remaining <= 0) {
      w.resultFailure = `Invalid ${assignment.kind} RESULT after ${w.rejections} attempts: ${errors}`;
      return {
        content: [{ type: "text" as const, text: `Result rejected: ${errors}. No attempts remain; the assignment failed.` }],
        details: { accepted: false, errors },
        isError: true,
        terminate: true,
      };
    }
    const shape = contract ? ` Expected data: ${contract.optional ? "omitted, or " : ""}${JSON.stringify(contract.schema)}.` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Result rejected: ${errors}.${shape} Correct it and call report_result alone again (${remaining} attempt${remaining === 1 ? "" : "s"} left).`,
      }],
      details: { accepted: false, errors },
      isError: true,
    };
  }
  async wait(
    target: string | string[] | "any" = "any",
    timeoutMs = 30000,
  ): Promise<WaitResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error("wait timeout must be finite and nonnegative");
    const take = (): WaitResult | undefined => {
      const index = this.outcomes.findIndex(
        (o) =>
          target === "any" ||
          (Array.isArray(target)
            ? target.includes(o.agentId)
            : target === o.agentId),
      );
      if (index >= 0)
        return { type: "outcome", outcome: this.outcomes.splice(index, 1)[0]! };
      const message = target === "any" ? this.inbox.shift() : undefined;
      return message ? { type: "message", message } : undefined;
    };
    const available = take();
    if (available) return available;
    if (this.closed.signal.aborted) return { type: "timeout" };
    const { promise, resolve } = Promise.withResolvers<WaitResult>();
    const onWake = () => {
      const result = take() ?? (this.closed.signal.aborted ? { type: "timeout" as const } : undefined);
      if (result) {
        clearTimeout(timer);
        this.wake.delete(onWake);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      this.wake.delete(onWake);
      resolve({ type: "timeout" });
    }, timeoutMs);
    this.wake.add(onWake);
    onWake();
    return promise;
  }
  get(id: string): AgentSnapshot {
    const s = this.require(id).snapshot;
    return {
      ...s,
      route: { ...s.route },
      currentAssignment: s.currentAssignment
        ? { ...s.currentAssignment }
        : undefined,
    };
  }
  list(): AgentSnapshot[] {
    return [...this.workers.keys()].map((id) => this.get(id));
  }
  subscribe(listener: (event: ManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Observers cannot alter worker lifecycle. */
      }
    }
    for (const wake of [...this.wake]) wake();
  }
  private require(id: string): Worker {
    const w = this.workers.get(id);
    if (!w) throw new Error(`Unknown agent: ${id}`);
    return w;
  }
  session(id: string): AgentSession {
    return this.require(id).adapter.session;
  }
  /**
   * Fence the manager and dispose every registered session immediately. Wait at most timeoutMs
   * for owned abort promises, observing late rejections. Pending ids mean SDK abort did not
   * settle (including still-pending spawn ids); synchronous JS/dispose cannot be forcibly interrupted in-process.
   */
  async disposeWithin(timeoutMs: number): Promise<{ pendingWorkerIds: string[] }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("dispose timeout must be finite and nonnegative");
    this.close();
    const pending = new Set<string>();
    const waits: Promise<void>[] = [];
    for (const w of this.workers.values()) {
      if (w.snapshot.status === "disposed") continue;
      const id = w.snapshot.id;
      pending.add(id);
      const abort = w.abort ?? Promise.resolve().then(() => w.adapter.abort());
      w.unsubscribe();
      // Invalidate promptly, even when abort never settles.
      this.finalize(w, w.result ? "completed" : "stopped", false);
      w.adapter.dispose();
      w.snapshot.status = "disposed";
      waits.push(abort.then(() => { pending.delete(id); }, () => { pending.delete(id); }));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(waits),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    return { pendingWorkerIds: [...new Set([...pending, ...this.pendingSpawns])] };
  }
  async dispose(agentId?: string): Promise<void> {
    for (const w of agentId ? [this.require(agentId)] : this.workers.values()) {
      await this.stop(w.snapshot.id);
      w.unsubscribe();
      w.adapter.dispose();
      w.snapshot.status = "disposed";
    }
  }
}
/** Deliver a tool execution to the spawn-time observer; it can neither throw into nor await the session. */
function notifyTool(options: SpawnOptions, event: ToolExecutionEvent): void {
  try {
    const pending = options.onToolExecution?.(event);
    if (pending) void Promise.resolve(pending).catch(() => undefined);
  } catch {
    /* Observers cannot alter worker lifecycle. */
  }
}
/** Validation errors of a RESULT's `data`, or undefined when it satisfies the contract. */
function resultDataErrors(contract: ResultDataSchema, data: unknown): string | undefined {
  // Strict-mode providers send an omitted optional argument as null.
  if ((data === undefined || data === null) && contract.optional) return undefined;
  if (Value.Check(contract.schema, data)) return undefined;
  const errors = [...Value.Errors(contract.schema, data)].slice(0, 8).map(error => `${error.path || "/"}: ${error.message}`);
  return errors.length ? errors.join("; ") : "invalid data";
}
