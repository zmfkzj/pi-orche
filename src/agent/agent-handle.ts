import type { TSchema } from "@sinclair/typebox";
import type { SessionOptions } from "../pi/session-factory.js";
import type { SessionRecords } from "./records.js";
import type {
  NoteMessage,
  DeliveryReceipt,
  OrcheMessage,
} from "../messaging/message.js";
export interface ResultPayload {
  kind: string;
  summary: string;
  data?: unknown;
}
export interface Assignment {
  id: string;
  kind: string;
  prompt: string;
  epoch: number;
}
export interface Outcome {
  agentId: string;
  assignmentId: string;
  kind: string;
  status: "completed" | "superseded" | "stopped" | "no_result" | "failed";
  result?: ResultPayload;
  lastText?: string;
  error?: string;
  timestamp: number;
}
export interface AgentSnapshot {
  id: string;
  role: string;
  route: SessionOptions["route"];
  status: "idle" | "running" | "stopping" | "disposed";
  currentAssignment?: Assignment;
  completedAssignments: number;
  /** Assignment-local completed model requests (also counted with the budget disabled). */
  requestCount?: number;
  /** Session activity only: no prompt, tool arguments, or message content. */
  lastActivityAt?: number;
  lastToolName?: string;
  lastToolAt?: number;
}
/**
 * A worker tool execution as seen by the session's `tool_execution_start/end` and `agent_settled`
 * events. `start` carries the raw call arguments and `settled` means the session has no tool in
 * flight. This is delivered through {@link SpawnOptions.onToolExecution}, never through the public
 * {@link ManagerEvent} stream, which deliberately excludes tool arguments.
 */
export interface ToolExecutionEvent {
  phase: "start" | "end" | "settled";
  toolCallId?: string;
  toolName?: string;
  /** `start` only: the call's arguments, for owners that need a written path (never forwarded as an event). */
  args?: unknown;
  /** `end` only. */
  isError?: boolean;
}
export interface SpawnOptions extends SessionOptions {
  id: string;
  role: string;
  peerMessaging?: boolean;
  /** Cancels creation promptly; late SDK sessions are disposed without registration. */
  signal?: AbortSignal;
  /**
   * Observes this worker's tool executions (start, end, and the settle that proves nothing is
   * running any more). Invoked synchronously from the session event, before the manager's
   * closed/disposed guard, so ends are still seen while a run tears down. Errors and rejections
   * are swallowed: observers cannot alter the worker lifecycle.
   *
   * A promise returned for an `end` event IS awaited: the worker does not go on (no tool-result message, no next model request)
   * until it settles, or the assignment is stopped. This is how an observer takes a workspace snapshot at the tool boundary, before
   * anything the worker does next can be confused with the tool's own writes. Keep it short and bounded. `start` and `settled` are
   * never awaited.
   */
  onToolExecution?(event: ToolExecutionEvent): void | Promise<void>;
}
/** Contract for the `data` of a RESULT; `optional` also accepts an absent `data`. */
export interface ResultDataSchema {
  schema: TSchema;
  optional?: boolean;
}
export interface AgentManagerOptions {
  resultNudges?: number;
  /** RESULT `data` contracts by assignment kind, validated inside `report_result`. */
  resultSchemas?: Readonly<Record<string, ResultDataSchema>>;
  /** Rejected RESULTs a worker may correct per assignment before it fails (default 3). */
  resultSchemaRetries?: number;
  /**
   * Soft limit on model requests per assignment; 0 (default) disables it. Reaching it injects a
   * wrap-up notice; at 1.5x the turn is stopped and the worker is asked once to report what it
   * has; a few requests later without a RESULT the assignment fails.
   */
  requestBudget?: number;
  /**
   * Opt-in session records. `sessionTarget` is asked for every spawned worker that was not given a `sessionDir`/`sessionFile` itself
   * and persists its session as a regular pi JSONL; `onAgent` receives each worker's {@link AgentRecordEntry} once, when it is
   * disposed. Absent (the default): workers live in memory only. {@link AgentManager.agentRecord} works either way.
   */
  records?: SessionRecords;
}
export type ManagerEvent = { timestamp: number } & (
  | { type: "assignment_started"; agentId: string; assignment: Assignment }
  | { type: "assignment_nudged"; agentId: string; assignmentId: string; attempt: number }
  | { type: "result_rejected"; agentId: string; assignmentId: string; kind: string; attempt: number; errors: string }
  | { type: "request_budget"; agentId: string; assignmentId: string; requests: number; budget: number; action: "notice" | "stop" | "abort" }
  | { type: "assignment_outcome"; outcome: Outcome }
  | { type: "message_sent"; message: OrcheMessage }
  | {
      type: "message_delivered";
      message: OrcheMessage;
      receipt: DeliveryReceipt;
    }
  /** Tool start metadata only; arguments and output are deliberately excluded. */
  | { type: "tool_started"; agentId: string; assignmentId: string; toolName: string }
  | {
      type: "usage";
      agentId: string;
      assignmentId: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
);
export type WaitResult =
  | { type: "outcome"; outcome: Outcome }
  | { type: "message"; message: NoteMessage }
  | { type: "timeout" };
export interface AgentHandle {
  readonly id: string;
  assign(kind: string, prompt: string): Assignment;
  stop(): Promise<void>;
  get(): AgentSnapshot;
}
