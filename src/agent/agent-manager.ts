import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { schemaErrors } from "../orchestration/schema-errors.js";
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
  InjectedMessage,
  ManagerEvent,
  Outcome,
  ResultDataSchema,
  ResultPayload,
  SpawnOptions,
  SteerReceipt,
  ToolExecutionEvent,
  WaitResult,
} from "./agent-handle.js";
import { reportAgent, targetOf, type AgentRecordEntry, type SessionRecords } from "./records.js";
import { lengthRecoveryOf, resetLengthRecovery } from "../pi/length-recovery.js";
import { beginReportPhase } from "../pi/thinking-policy.js";
import { noteRequestLevel } from "../pi/thinking-state.js";
import { DEFAULT_LIVENESS_WINDOW_MS, LivenessTracker, isIdleHeartbeat, mergeLiveness, type Liveness, type SessionLiveness } from "./liveness.js";
/** Requests a forced final report may take after a budget stop before the assignment fails. */
export const BUDGET_GRACE_REQUESTS = 5;
/** Reports sent back to be rewritten (at the assignment's thinking level) before the assignment fails closed. */
export const MAX_REPORT_REWRITES = 2;
/** customType of a message main injected into a running worker ({@link AgentManager.steer}). */
export const MAIN_MESSAGE_TYPE = "pi-orche.main-message";
/** SDK abort is cooperative; never hold a session's activity slot indefinitely. */
export const WORKER_STOP_TIMEOUT_MS = 1000;
interface RetiredWorker {
  snapshot: AgentSnapshot;
  record: AgentRecordEntry;
  liveness: SessionLiveness;
}
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
  requestBudget: number;
  /** Budget ladder: none → noticed (wrap-up notice sent) → stopping (turn aborted) → final (forced report prompt). */
  budget: "none" | "noticed" | "stopping" | "final";
  /** Messages main injected into the current assignment ({@link AgentManager.steer}). */
  injected: InjectedMessage[];
  /** The output-limit recovery was exhausted and the worker was asked once for a report with what it has. */
  lengthReportPrompted: boolean;
  /** Reports sent back to be rewritten at the assignment's thinking level ({@link SpawnOptions.reviseResult}); not result retries. */
  rewrites: number;
  /** Length stops of the session before the current assignment (to count this assignment's). */
  lengthBefore: number;
  abort?: Promise<void>;
  unsubscribe: () => void;
  /** Records bookkeeping (see {@link AgentManager.agentRecord}); never read by the lifecycle itself. */
  stats: WorkerStats;
  /** Liveness of this worker's session (see liveness.ts), fed from the session subscription; never read by the lifecycle itself. */
  liveness: LivenessTracker;
  contextProjection?: SpawnOptions["contextProjection"];
  projectionOptions?: { enabled?: boolean; minClearTokens?: number };
  projectionAssignment?: Assignment;
  rebind(manager: AgentManager, overrides?: WorkerAdoptOptions): void;
}
interface WorkerStats {
  startedAt: number;
  /** Model requests over the worker's whole life (not reset per assignment). */
  requests: number;
  models: Record<string, number>;
  /** Summed duration of the finished assignments; the one in flight is added by `assignedAt`. */
  busyMs: number;
  assignedAt?: number;
  /** Outcome of the last finished assignment. */
  last?: { status: Outcome["status"]; error?: string };
  sessionFile?: string;
  reported: boolean;
}
/** Opaque, one-use ownership handle; detaching never disposes the session. */
export interface WorkerTransfer { readonly snapshot: AgentSnapshot }
export type WorkerAdoptOptions = Pick<Partial<SpawnOptions>, "id" | "role" | "toolGuard" | "writeFileGuard" | "onToolExecution" | "onContextWindow" | "contextProjection" | "validateResult" | "reviseResult">;
const detachedWorkers = new WeakMap<WorkerTransfer, Worker>();

export class AgentManager {
  private readonly workers = new Map<string, Worker>();
  private readonly retired = new Map<string, RetiredWorker>();
  private readonly workerIds = new Set<string>();
  private readonly listeners = new Set<(event: ManagerEvent) => void>();
  private readonly wake = new Set<() => void>();
  private readonly outcomes: Outcome[] = [];
  private readonly inbox: NoteMessage[] = [];
  private readonly router = new MessageRouter(
    (id) => id === "main" || this.workerIds.has(id),
    (message) => this.deliver(message),
  );
  private modelRuntime: Promise<ModelRuntime> | undefined;
  private readonly resultNudges: number;
  private readonly resultSchemas: Readonly<Record<string, ResultDataSchema>>;
  private readonly resultSchemaRetries: number;
  private requestBudget: number;
  private readonly stopTimeoutMs: number;
  private readonly records: SessionRecords | undefined;
  private readonly closed = new AbortController();
  private readonly pendingSpawns = new Set<string>();
  private messageSerial = 0;
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
  constructor(modelRuntime?: ModelRuntime, options: AgentManagerOptions & { stopTimeoutMs?: number } = {}) {
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
    this.stopTimeoutMs = options.stopTimeoutMs ?? WORKER_STOP_TIMEOUT_MS;
    if (!Number.isFinite(this.stopTimeoutMs) || this.stopTimeoutMs < 0)
      throw new Error("stopTimeoutMs must be finite and nonnegative");
    this.records = options.records;
    this.modelRuntime = modelRuntime ? Promise.resolve(modelRuntime) : undefined;
  }
  /** Refresh the next assignment's quota when session limits are reloaded. */
  setRequestBudget(budget: number): void {
    if (!Number.isSafeInteger(budget) || budget < 0)
      throw new Error("requestBudget must be a nonnegative safe integer");
    this.requestBudget = budget;
  }
  async spawn(options: SpawnOptions): Promise<AgentHandle> {
    let owner: AgentManager = this;
    options = { ...options };
    this.assertOpen(options.signal);
    if (options.id === "main" || this.workerIds.has(options.id) || this.pendingSpawns.has(options.id))
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
          owner.closed.signal.aborted || options.signal?.aborted ||
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
        // A report written below the assignment's thinking level is discarded and rewritten at it (not a result retry).
        const rewrite = options.reviseResult?.();
        if (rewrite) return owner.rewriteResult(worker, rewrite);
        let payload = args as ResultPayload;
        // Models sometimes send `data` as a JSON string of the object: parse it (validation still runs on the parsed value).
        if (typeof payload.data === "string" && /^\s*[{[]/.test(payload.data)) {
          try { payload = { ...payload, data: JSON.parse(payload.data) as unknown }; } catch { /* left as is; validation reports it */ }
        }
        const contract = owner.resultSchemas[worker.snapshot.currentAssignment.kind];
        if (payload.kind !== worker.snapshot.currentAssignment.kind)
          return owner.rejectResult(worker, `Expected RESULT kind "${worker.snapshot.currentAssignment.kind}"; received "${payload.kind}"`, contract);
        const errors = contract ? resultDataErrors(contract, payload.data) : undefined;
        if (errors) return owner.rejectResult(worker, errors, contract!);
        const workflowError = options.validateResult?.(payload.kind, payload.data);
        if (workflowError) return owner.rejectResult(worker, workflowError, contract ?? { schema: Type.Unknown(), optional: true });
        worker.result = payload;
        // Messages from main still queued now would reach the worker after its result: withdraw them (the outcome lists them).
        owner.withdrawInjected(worker);
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
        if (owner.closed.signal.aborted || options.signal?.aborted) return {
          content: [{ type: "text", text: "NOTE rejected: manager or worker creation cancelled" }],
          details: { accepted: false }, isError: true,
        };
        const payload = args as {
          to: string;
          content: string;
          signal?: NoteMessage["signal"];
        };
        const receipt = await owner.send({
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
    // Opt-in persistence: the records hook decides where this worker's session goes unless the caller already did.
    const target = options.sessionFile || options.sessionDir ? undefined : targetOf(this.records, { id: options.id, role: options.role, kind: "worker" });
    this.pendingSpawns.add(options.id);
    // Output-limit recovery events go into the manager's stream, tagged with the assignment they belong to.
    const lengthEvents = options.lengthRecovery?.onEvent;
    options.lengthRecovery = { ...options.lengthRecovery, onEvent: event => {
      try { lengthEvents?.(event); } catch { /* observers cannot change recovery */ }
      if (owner.closed.signal.aborted || !worker || worker.snapshot.status === "disposed") return;
      owner.emit({ ...event, agentId: worker.snapshot.id, ...(worker.snapshot.currentAssignment ? { assignmentId: worker.snapshot.currentAssignment.id } : {}) });
    } };
    const signal = options.signal
      ? AbortSignal.any([this.closed.signal, options.signal]) : this.closed.signal;
    const creation = (async () => {
      const modelRuntime = options.modelRuntime ?? await (this.modelRuntime ??= ModelRuntime.create());
      this.assertOpen(signal);
      const session = await createSession({
        ...options, ...target, modelRuntime, tools,
        toolGuard: (name, input) => options.toolGuard?.(name, input),
        writeFileGuard: (file, signal) => options.writeFileGuard
          ? options.writeFileGuard(file, signal)
          : options.toolGuard ? "Directory ast_rewrite requires a per-file write guard in a guarded session" : undefined,
        onContextWindow: info => options.onContextWindow?.(info),
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
    // The spawn signal governs creation only; pooled sessions outlive their first task.
    options.signal = undefined;
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
      contextProjection: options.contextProjection,
      epoch: 0,
      nudges: 0,
      rejections: 0,
      requests: 0,
      requestBudget: this.requestBudget,
      budget: "none",
      injected: [],
      lengthReportPrompted: false,
      rewrites: 0,
      lengthBefore: 0,
      unsubscribe: () => {},
      stats: { startedAt: Date.now(), requests: 0, models: {}, busyMs: 0, sessionFile: session.sessionFile, reported: false },
      // The state changes go into the manager's event stream, but not once the manager is closed or the worker disposed.
      liveness: new LivenessTracker({
        id: options.id, role: options.role, ...(options.toolTimeoutsMs ? { toolTimeoutsMs: options.toolTimeoutsMs } : {}),
        onChange: event => { if (!owner.closed.signal.aborted && worker.snapshot.status !== "disposed") owner.emit(event); },
      }),
      rebind: (manager, overrides = {}) => {
        owner = manager;
        options = { ...options, signal: undefined, toolGuard: undefined, writeFileGuard: undefined, onToolExecution: undefined, onContextWindow: undefined, contextProjection: undefined, ...overrides };
        options.id = overrides.id ?? worker.snapshot.id;
        worker.snapshot.id = options.id;
        worker.snapshot.role = overrides.role ?? worker.snapshot.role;
        worker.contextProjection = overrides.contextProjection;
        worker.liveness = new LivenessTracker({ id: options.id, role: worker.snapshot.role, onChange: event => { if (!owner.closed.signal.aborted) owner.emit(event); } });
      },
    };
    // The end of a tool is observed through the Agent's own listener, not the session listener below: the Agent awaits its listeners,
    // in order, before it goes on (tool-result message, next model request), so an observer that returns a promise (the workspace
    // tracker's closing snapshot) holds the worker back until it settled. It runs right after the session's own handling of the same
    // event. The wait is cut short when the run is aborted or the manager closes. A session without an Agent (a test double) falls
    // back to the plain, unawaited notification below.
    const unsubscribeEnds = options.onToolExecution && session.agent
      ? session.agent.subscribe(async (event, runSignal) => {
          if (event.type !== "tool_execution_end") return;
          await until(notifyTool(options, { phase: "end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }), runSignal, owner.closed.signal);
        })
      : undefined;
    const unsubscribeSession = adapter.subscribe((event) => {
      // Tool tracking comes first: an end or settle must still be seen while the manager closes,
      // otherwise the observer would think a tool is running forever. Arguments go to this callback
      // only, never into the public event stream.
      if (options.onToolExecution) {
        if (event.type === "tool_execution_start") void notifyTool(options, { phase: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        else if (event.type === "tool_execution_end" && !unsubscribeEnds) void notifyTool(options, { phase: "end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        else if (event.type === "agent_settled") void notifyTool(options, { phase: "settled" });
      }
      // Requests are counted for the records even while the manager closes: the cost of a cancelled run is the point.
      if (event.type === "message_end" && event.message.role === "assistant") {
        worker.stats.requests++;
        const model = `${event.message.provider}/${event.message.model}`;
        worker.stats.models[model] = (worker.stats.models[model] ?? 0) + 1;
      }
      // Liveness is fed before the closed/disposed guard too, so the tracker never believes in a tool that already ended. Its state
      // changes are published through `onChange` above (silenced once the manager is closed). A heartbeat of a process that is alive
      // but idle is not activity: it must not refresh `lastActivityAt` below.
      worker.liveness.observe(event);
      if (owner.closed.signal.aborted || worker.snapshot.status === "disposed") return;
      if (!isIdleHeartbeat(event)) worker.snapshot.lastActivityAt = Date.now();
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        worker.snapshot.lastToolName = event.toolName;
        worker.snapshot.lastToolAt = Date.now();
        if (event.type === "tool_execution_start" && worker.runAssignment) {
          owner.emit({ type: "tool_started", timestamp: Date.now(), agentId: options.id, assignmentId: worker.runAssignment.id, toolName: event.toolName });
        }
      }
      // The thinking level this request runs at, for the report-effort check (src/pi/thinking-policy.ts reportRewriteReason).
      if (event.type === "message_start" && event.message.role === "assistant") noteRequestLevel(session);
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
          if (!budgetAborted) owner.trackBudget(worker, assignment, reporting);
          owner.emit({
            type: "usage", timestamp: Date.now(), agentId: options.id, assignmentId: assignment.id,
            model: `${event.message.provider}/${event.message.model}`,
            input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
            ...(typeof u.cost?.total === "number" ? { costUSD: u.cost.total } : {}),
          });
        }
      } else if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === MAIN_MESSAGE_TYPE) {
        const id = (event.message.details as { id?: unknown } | undefined)?.id;
        const message = worker.injected.find(item => item.id === id);
        if (message && message.status === "queued") {
          message.status = worker.result ? "late" : "delivered";
          message.deliveredAt = Date.now();
          const assignment = worker.snapshot.currentAssignment;
          if (assignment) owner.emit({ type: "injected_message", timestamp: Date.now(), agentId: options.id, assignmentId: assignment.id, id: message.id, status: message.status });
        }
      } else if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-orche.note"
      ) {
        const message = event.message.details as NoteMessage;
        owner.emit({
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
        const length = lengthRecoveryOf(session);
        // Every report prompt of the runtime runs at the assignment's thinking level: the report phase starts before its request.
        const reportPhase = (reason: string) => { try { beginReportPhase(session, reason); } catch { /* the level stays; a report below it is sent back */ } };
        if (reportable && worker.budget === "stopping") {
          worker.budget = "final";
          reportPhase("forced report (request budget)");
          owner.runAssignment(worker, assignment, `Your request budget for assignment ${assignment.kind} is exhausted and your turn was stopped. Call report_result alone now with what you have: partial findings are fine; for implement/fix use data.status "blocked" with the reason if the work is unfinished.`);
        } else if (reportable && length.exhausted && !worker.lengthReportPrompted) {
          // Output-limit recovery is used up (src/pi/length-recovery.ts): one forced report instead of the generic nudge.
          worker.lengthReportPrompted = true;
          reportPhase("forced report (output limit)");
          owner.runAssignment(worker, assignment, `Your last ${length.consecutive} responses hit the output token limit, mostly while reasoning, and produced nothing usable. Do not plan or reason at length now. Call report_result alone immediately with what you have: partial findings are fine, but name what is verified and what is not, and never report unverified or failed work as done; for implement/fix use data.status "blocked" with the reason if the work is unfinished.`);
        } else if (reportable && length.exhausted) {
          worker.failure = `Output limit: ${length.consecutive} consecutive responses hit the model's output token limit (mostly while reasoning) and no result was reported. Re-assign with a narrower request, or a lower thinking level for this worker.`;
          owner.finalize(worker, "failed");
        } else if (reportable && worker.nudges < owner.resultNudges) {
          worker.nudges++;
          reportPhase("report nudge");
          owner.emit({ type: "assignment_nudged", timestamp: Date.now(), agentId: options.id, assignmentId: assignment.id, attempt: worker.nudges });
          owner.runAssignment(worker, assignment, `You ended without calling report_result for assignment ${assignment.kind}. Call report_result alone now with your result.`);
        } else {
          owner.finalize(worker, failed ? "failed" : worker.result ? "completed" : "no_result");
        }
      }
    });
    worker.unsubscribe = () => { unsubscribeEnds?.(); unsubscribeSession(); };
    this.workers.set(options.id, worker);
    this.workerIds.add(options.id);
    return {
      id: options.id,
      assign: (kind, prompt) => this.assign(options.id, kind, prompt),
      stop: () => this.stop(options.id),
      get: () => this.get(options.id),
    };
  }
  assign(agentId: string, kind: string, prompt: string, projectionOptions?: { enabled?: boolean; minClearTokens?: number }): Assignment {
    this.assertOpen();
    const w = this.require(agentId);
    if (w.snapshot.status !== "idle")
      throw new Error(`Agent ${agentId} is ${w.snapshot.status}`);
    const assignment = { id: randomUUID(), kind, prompt, epoch: ++w.epoch };
    w.projectionOptions = projectionOptions;
    w.snapshot.currentAssignment = assignment;
    w.runAssignment = assignment;
    w.snapshot.status = "running";
    w.result = undefined;
    w.failure = undefined;
    w.nudges = 0;
    w.rejections = 0;
    w.resultFailure = undefined;
    w.requests = 0;
    w.requestBudget = this.requestBudget;
    w.budget = "none";
    w.injected = [];
    w.lengthReportPrompted = false;
    w.rewrites = 0;
    resetLengthRecovery(w.adapter.session);
    w.lengthBefore = lengthRecoveryOf(w.adapter.session).total;
    w.snapshot.requestCount = 0;
    w.snapshot.lastActivityAt = Date.now();
    w.stats.assignedAt = Date.now();
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
        if (w.contextProjection && w.projectionAssignment !== assignment) {
          // Exact append position of the impending first user prompt; context excludes only system messages.
          const messages = w.adapter.session.agent.state.messages.filter(message => message.role !== "system");
          const plan = w.contextProjection.beginAssignment(messages, messages.length, w.projectionOptions);
          w.projectionAssignment = assignment;
          if (plan.stats.results) this.emit({ type: "context_cleared", timestamp: Date.now(), agentId: w.snapshot.id, assignmentId: assignment.id, contextCleared: plan.stats });
        }
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
    if (!w.requestBudget) return;
    const budget = w.requestBudget;
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
  /**
   * Inject a message from main into the assignment `agentId` is running (Pi steering: it reaches the model after the current tool
   * calls, before the next request; while no request runs it is appended to the context at once). Rejected when the worker is not
   * running an assignment, has already reported, or is being stopped: such a message would land in the next assignment, or nowhere.
   * Grants and scope never change through a message; it is text for the model only. `options.source: "advisor"` marks the plan
   * advisor's notes (single.advisor), and `options.content` replaces main's framing with the caller's own.
   */
  steer(agentId: string, text: string, options: { source?: "advisor"; content?: (id: string) => string } = {}): SteerReceipt {
    const w = this.workers.get(agentId);
    const reject = (reason: string): SteerReceipt => ({ status: "rejected", agentId, reason });
    if (this.closed.signal.aborted) return reject("the worker pool is shutting down");
    if (!w || w.snapshot.status === "disposed") return reject(`${agentId} is not a live worker`);
    const assignment = w.snapshot.currentAssignment;
    if (w.snapshot.status !== "running" || !assignment) return reject(`${agentId} is not running an assignment; send a new orche_task to it instead`);
    if (w.result || w.resultFailure) return reject(`${agentId} has already reported its result for this assignment; send the message as a follow-up orche_task instead`);
    if (w.budget === "stopping" || w.budget === "final") return reject(`${agentId} is being stopped (request budget); send the message as a follow-up orche_task instead`);
    if (!text.trim()) return reject("empty message");
    const id = `M${++this.messageSerial}`;
    const message: InjectedMessage = { id, text, queuedAt: Date.now(), status: "queued", ...(options.source ? { source: options.source } : {}) };
    w.injected.push(message);
    const session = w.adapter.session;
    const content = options.content?.(id) ?? `[Message from main while you work on this assignment · ${id}]\n${text}\n(Take it into account from now on. It refines this assignment; it does not replace it unless it says so, and it grants no new permissions.)`;
    this.emit({ type: "injected_message", timestamp: Date.now(), agentId, assignmentId: assignment.id, id, status: "queued" });
    void session.sendCustomMessage({ customType: MAIN_MESSAGE_TYPE, content, display: true, details: { id, assignmentId: assignment.id } }, session.isStreaming ? { deliverAs: "steer" } : { triggerTurn: false })
      .catch(() => { if (message.status === "queued") message.status = "undelivered"; });
    return { status: "queued", id, agentId, assignmentId: assignment.id };
  }
  /** Copies of the messages injected into `agentId`'s current assignment, with their delivery status so far (empty when unknown). */
  injected(agentId: string): InjectedMessage[] {
    return (this.workers.get(agentId)?.injected ?? []).map(message => ({ ...message }));
  }
  /** Withdraw injected messages that did not reach the worker yet; they are reported `undelivered`, never carried into a later assignment. */
  private withdrawInjected(w: Worker): void {
    const queued = w.injected.filter(message => message.status === "queued");
    if (!queued.length) return;
    // Only orche queues steering messages in a worker session (NOTEs and notices wait as end-of-turn custom messages instead).
    try { w.adapter.session.clearQueue(); } catch { /* a disposed session has no queue */ }
    const assignment = w.snapshot.currentAssignment;
    for (const message of queued) {
      message.status = "undelivered";
      if (assignment) this.emit({ type: "injected_message", timestamp: Date.now(), agentId: w.snapshot.id, assignmentId: assignment.id, id: message.id, status: "undelivered" });
    }
  }
  /** Resolves once an in-flight interruption of `agentId` (stop/redirect abort) has settled. */
  async settle(agentId: string): Promise<void> {
    if (this.retired.has(agentId)) return;
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
      if (this.retired.has(message.to)) return { id: message.id, status: "rejected", mode: "context", reason: "Agent disposed" };
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
    if (this.retired.has(message.to)) return { id: message.id, status: "rejected", mode: message.type === "stop" ? "abort" : "abort-prompt", reason: "Agent disposed" };
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
    if (this.retired.has(agentId)) return;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.resolve().then(() => w.adapter.abort());
    const bounded = Promise.race([
      pending,
      new Promise<void>(resolve => { timer = setTimeout(() => { this.retireWorker(w); resolve(); }, this.stopTimeoutMs); }),
    ]);
    w.abort = bounded;
    try {
      await bounded;
    } finally {
      clearTimeout(timer);
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
    this.withdrawInjected(w);
    if (w.injected.length) outcome.injected = w.injected.map(message => ({ ...message }));
    const length = lengthRecoveryOf(w.adapter.session);
    if (length.total > w.lengthBefore) outcome.lengthStops = { count: length.total - w.lengthBefore, exhausted: length.exhausted };
    if (w.stats.assignedAt !== undefined) w.stats.busyMs += Math.max(0, outcome.timestamp - w.stats.assignedAt);
    w.stats.assignedAt = undefined;
    w.stats.last = { status, ...(outcome.error ? { error: outcome.error } : {}) };
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
   * Send a report back to be rewritten ({@link SpawnOptions.reviseResult}): the discarded report is never accepted, and the rewrite
   * is not one of the result retries. Fail-closed: a further rewrite request after {@link MAX_REPORT_REWRITES} means the owner could
   * not make the next request run as required; the assignment then fails with that reason instead of accepting the report.
   */
  private rewriteResult(w: Worker, reason: string) {
    const assignment = w.snapshot.currentAssignment!;
    w.rewrites++;
    this.emit({ type: "result_rewrite", timestamp: Date.now(), agentId: w.snapshot.id, assignmentId: assignment.id, kind: assignment.kind, attempt: w.rewrites, reason });
    if (w.rewrites > MAX_REPORT_REWRITES) {
      w.resultFailure = `Report not accepted: ${reason.split(";")[0]}, again after ${MAX_REPORT_REWRITES} rewrites (the required thinking level could not be applied)`;
      return {
        content: [{ type: "text" as const, text: `Result rejected: ${w.resultFailure}. The assignment failed.` }],
        details: { accepted: false, errors: w.resultFailure },
        isError: true,
        terminate: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Result not accepted yet: ${reason}.` }],
      details: { accepted: false, rewrite: true },
      isError: true,
    };
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
    const s = (this.retired.get(id) ?? this.require(id)).snapshot;
    return {
      ...s,
      route: { ...s.route },
      currentAssignment: s.currentAssignment
        ? { ...s.currentAssignment }
        : undefined,
    };
  }
  list(): AgentSnapshot[] {
    return [...this.workerIds].map((id) => this.get(id));
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
  setContextProjection(id: string, projector: NonNullable<SpawnOptions["contextProjection"]>): void {
    const worker = this.require(id);
    if (worker.snapshot.status !== "idle") throw new Error(`Agent ${id} is not idle`);
    worker.contextProjection = projector;
    worker.projectionAssignment = undefined;
  }
  /** Transfer only settled, idle workers; the caller becomes responsible for adopting them. */
  detach(id: string): WorkerTransfer {
    const worker = this.require(id);
    if (worker.snapshot.status !== "idle" || worker.abort) throw new Error(`Agent ${id} is not idle`);
    this.reportOnce(worker);
    this.workers.delete(id);
    this.workerIds.delete(id);
    const transfer = { snapshot: this.snapshotOf(worker) };
    detachedWorkers.set(transfer, worker);
    return transfer;
  }
  adopt(transfer: WorkerTransfer, options: WorkerAdoptOptions = {}): AgentSnapshot {
    this.assertOpen();
    const worker = detachedWorkers.get(transfer);
    if (!worker) throw new Error("Worker transfer already adopted or invalid");
    const id = options.id ?? worker.snapshot.id;
    if (id === "main" || this.workerIds.has(id) || this.pendingSpawns.has(id)) throw new Error(`Reserved or duplicate agent id: ${id}`);
    worker.rebind(this, { ...options, id });
    worker.stats.reported = false;
    this.workers.set(id, worker);
    this.workerIds.add(id);
    detachedWorkers.delete(transfer);
    return this.get(id);
  }
  private snapshotOf(worker: Worker): AgentSnapshot {
    return { ...worker.snapshot, route: { ...worker.snapshot.route } };
  }
  /**
   * Manifest entry of one worker (never throws for a known id): who it is, which model it was routed to and which models actually
   * answered, how many requests it made over its whole life, how long it worked and how its last assignment ended. Available
   * whether or not records are enabled; `sessionFile` is set only for a persisted session.
   */
  agentRecord(id: string): AgentRecordEntry {
    const retired = this.retired.get(id);
    if (retired) return { ...retired.record, models: { ...retired.record.models } };
    const w = this.require(id);
    const { stats, snapshot } = w;
    const running = snapshot.status === "running" || snapshot.status === "stopping";
    return {
      id: snapshot.id,
      role: snapshot.role,
      kind: "worker",
      model: snapshot.route.model,
      ...(snapshot.route.thinking ? { thinking: snapshot.route.thinking } : {}),
      requests: stats.requests,
      models: { ...stats.models },
      durationMs: stats.busyMs + (stats.assignedAt !== undefined ? Math.max(0, Date.now() - stats.assignedAt) : 0),
      startedAt: stats.startedAt,
      status: running ? "running" : stats.last?.status ?? "idle",
      assignments: snapshot.completedAssignments,
      ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}),
      ...(stats.last?.error ? { error: stats.last.error } : {}),
    };
  }
  /**
   * Liveness of one worker (see liveness.ts): is it still actively working? A worker with no assignment, or a disposed one, is `idle`
   * and never active, whatever its last events said. Throws for an unknown id, like {@link get}.
   */
  workerLiveness(id: string, now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS): SessionLiveness {
    const retired = this.retired.get(id);
    if (retired) return { ...retired.liveness };
    const w = this.require(id);
    return w.liveness.session(now, windowMs, { idle: !w.snapshot.currentAssignment || w.snapshot.status === "disposed" });
  }
  /**
   * Aggregate liveness of the workers (all of them, or only `ids`; unknown ids are ignored; disposed workers are left out): `active`
   * when any worker with an assignment had model output, a tool event, tool output or a progressing bash heartbeat within `windowMs`
   * or is within the bounds of a request or tool in flight. Read-only: it changes no timeout or state.
   */
  liveness(now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS, ids?: readonly string[]): Liveness {
    const parts: Liveness[] = [];
    for (const w of this.workers.values()) {
      if (w.snapshot.status === "disposed" || (ids && !ids.includes(w.snapshot.id))) continue;
      parts.push(w.liveness.liveness(now, windowMs, { idle: !w.snapshot.currentAssignment }));
    }
    return mergeLiveness(...parts);
  }
  /** {@link agentRecord} of every worker ever spawned here (disposed ones included), in spawn order. */
  agentRecords(): AgentRecordEntry[] {
    return [...this.workerIds].map(id => this.agentRecord(id));
  }
  /** Hand a worker's entry to `records.onAgent` once, after its session is disposed. */
  private reportOnce(w: Worker): void {
    if (w.stats.reported) return;
    w.stats.reported = true;
    if (this.records?.onAgent) reportAgent(this.records, this.agentRecord(w.snapshot.id));
  }
  /** Only small status/record data survives disposal; no adapter, session or callback closures. */
  private retireWorker(w: Worker): void {
    if (this.retired.has(w.snapshot.id)) return;
    w.unsubscribe();
    this.finalize(w, w.result ? "completed" : "stopped", false);
    w.adapter.dispose();
    w.snapshot.status = "disposed";
    this.reportOnce(w);
    this.retired.set(w.snapshot.id, { snapshot: this.snapshotOf(w), record: this.agentRecord(w.snapshot.id), liveness: w.liveness.session(Date.now(), DEFAULT_LIVENESS_WINDOW_MS, { idle: true }) });
    this.workers.delete(w.snapshot.id);
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
      const adapter = w.adapter;
      const abort = w.abort ?? Promise.resolve().then(() => adapter.abort());
      this.retireWorker(w);
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
    if (agentId && this.retired.has(agentId)) return;
    for (const w of agentId ? [this.require(agentId)] : [...this.workers.values()]) {
      await this.stop(w.snapshot.id);
      this.retireWorker(w);
    }
  }
}
/**
 * Deliver a tool execution to the spawn-time observer; it can neither throw into the session nor reject. The returned promise (when
 * the observer returned one) settles when the observer's does; only the caller decides whether anything waits for it.
 */
function notifyTool(options: SpawnOptions, event: ToolExecutionEvent): Promise<void> | undefined {
  try {
    const pending = options.onToolExecution?.(event);
    return pending ? Promise.resolve(pending).catch(() => undefined) : undefined;
  } catch {
    /* Observers cannot alter worker lifecycle. */
    return undefined;
  }
}
/** Wait for `pending`, but not past the first of `signals` to abort. */
function until(pending: Promise<void> | undefined, ...signals: AbortSignal[]): Promise<void> {
  if (!pending || signals.some(signal => signal.aborted)) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => { for (const signal of signals) signal.removeEventListener("abort", done); resolve(); };
    for (const signal of signals) signal.addEventListener("abort", done, { once: true });
    void pending.then(done);
  });
}
/** Validation errors of a RESULT's `data`, or undefined when it satisfies the contract. */
function resultDataErrors(contract: ResultDataSchema, data: unknown): string | undefined {
  // Strict-mode providers send an omitted optional argument as null.
  if ((data === undefined || data === null) && contract.optional) return undefined;
  if (Value.Check(contract.schema, data)) return undefined;
  const errors = schemaErrors(contract.schema, data);
  return errors.length ? errors.join("; ") : "invalid data";
}
