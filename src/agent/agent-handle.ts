import type { TSchema } from "@sinclair/typebox";
import type { SessionOptions } from "../pi/session-factory.js";
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
export interface SpawnOptions extends SessionOptions {
  id: string;
  role: string;
  peerMessaging?: boolean;
  /** Cancels creation promptly; late SDK sessions are disposed without registration. */
  signal?: AbortSignal;
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
