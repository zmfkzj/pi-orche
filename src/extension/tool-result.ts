import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { WorkspaceChange } from "../orchestration/workspace.js";
import { formatOutcome, type OrcheOutcome, type OrcheRunDetails } from "./controller.js";

/**
 * Error tool results that keep their structured `details`.
 *
 * Pi's SDK has two ways to fail a tool call, and only one of them can carry details:
 *  - `throw` from `execute()`: the agent loop turns the message into a result with `details: {}`
 *    (pi-agent-core dist/agent-loop.js `executePreparedToolCall` catch -> `createErrorToolResult`), so every structured
 *    fact the tool knew (model routes, request counts, durations, cleanup, workspace) is lost from the transcript.
 *  - return `{ content, details, isError: true }`: `AgentToolResult.isError` ("Report a failure without throwing. The
 *    model sees `content` as an error result, like a thrown error, but `details` and `structuredContent` are kept",
 *    pi-agent-core dist/types.d.ts) is read as `result.isError === true` (agent-loop.js `executePreparedToolCall`) and
 *    `details` is copied into the persisted tool-result message (agent-loop.js `createToolResultMessage`).
 *
 * Use {@link errorToolResult} once a tool has produced an outcome (a worker or run actually ran) that is reported as
 * failed, blocked or cancelled. Keep plain `throw`s for errors before any outcome exists: argument validation, an
 * unknown worker, a busy controller, a run that crashed without a report.
 */

/** How a call that did run ended unsuccessfully. */
export type ToolFailureKind = "failed" | "blocked" | "cancelled";

/**
 * Compact failure summary stored as `details.failure` of an error result, so a reader of the transcript (or the
 * model, through the details) sees why the call is an error without re-parsing the text.
 */
export interface ToolFailure {
  kind: ToolFailureKind;
  /** The activity's own status word (`failed` for a run, `blocked`/`failed` for a task, ...). */
  status: string;
  /** One bounded line: the failure summary or cancellation reason. */
  reason: string;
  /** The cancellation came from the user (`/orche cancel`) rather than the tool's abort signal. */
  cancelledByUser?: true;
}

/** A tool result flagged as an error that still carries `details` (all of the caller's details plus `failure`). */
export type ErrorToolResult<D extends object, F extends ToolFailure = ToolFailure> = AgentToolResult<D & { failure: F }> & { isError: true };

/** Longest `ToolFailure.reason`. */
export const FAILURE_REASON_CHARS = 300;
/** Longest list (changed files, violations) copied into a failure summary; the remainder is only counted. */
export const FAILURE_LIST_ENTRIES = 50;

/**
 * Error result for a call that ran and failed: `content` is `text` (what the model reads, identical to what a thrown
 * error would have shown) and `details` is a copy of `details` with the `failure` summary added. `failure` is a reserved
 * key of `details`. The result is `isError: true`, so the model sees an error exactly as for a thrown error.
 */
export function errorToolResult<D extends object, F extends ToolFailure>(text: string, details: D, failure: F): ErrorToolResult<D, F> {
  return { content: [{ type: "text", text }], details: { ...details, failure }, isError: true };
}

/** First non-empty line of `text`, whitespace collapsed and cut to `max` characters (marked with an ellipsis). */
export function failureReason(text: string, max: number = FAILURE_REASON_CHARS): string {
  const line = text.split("\n").map(part => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `ToolFailure` of an orche_run that failed or was cancelled, with what the transcript needs to understand it. */
export interface RunFailure extends ToolFailure {
  rootCause?: string;
  /** Ownership violations (at most {@link FAILURE_LIST_ENTRIES}). */
  violations?: Array<{ agentId: string; file: string; via?: "workspace"; created?: true }>;
  /** Workspace changes from the run's git snapshots; absent outside a git work tree. Lists are capped and `omitted` counts the rest. */
  workspace?: {
    baseline: string;
    /** Run-attributed changes. */
    changes: WorkspaceChange[];
    /** Changes made by somebody else during the run (never to be restored), with the reason. */
    external: Array<WorkspaceChange & { reason: string }>;
    omitted?: number;
  };
}

/** The failure summary of a run outcome that is not `done`, or that the user cancelled. */
export function runFailureOf(outcome: OrcheOutcome): RunFailure {
  const { report, details } = outcome;
  const cancelled = details.cancelled;
  const failure: RunFailure = {
    kind: cancelled ? "cancelled" : "failed",
    status: report.status,
    reason: outcome.cancelledByUser ? "cancelled by user" : cancelled ? "cancelled" : failureReason(report.summary),
    ...(outcome.cancelledByUser ? { cancelledByUser: true as const } : {}),
    ...(report.rootCause ? { rootCause: failureReason(report.rootCause) } : {}),
  };
  let omitted = 0;
  const cap = <T>(list: readonly T[] | undefined): T[] => {
    const items = [...(list ?? [])];
    omitted += Math.max(0, items.length - FAILURE_LIST_ENTRIES);
    return items.slice(0, FAILURE_LIST_ENTRIES);
  };
  if (report.ownershipViolations?.length) failure.violations = cap(report.ownershipViolations).map(({ agentId, file, via, created }) => ({ agentId, file, ...(via ? { via } : {}), ...(created ? { created } : {}) }));
  if (report.workspace) {
    const changes = cap(report.workspace.changes).map(({ path, status }) => ({ path, status }));
    const external = cap(report.workspace.external).map(({ path, status, reason }) => ({ path, status, reason }));
    failure.workspace = { baseline: report.workspace.baseline, changes, external, ...(omitted ? { omitted } : {}) };
  }
  return failure;
}

/**
 * The orche_run tool result for a run that ended `failed` or was cancelled by the user: an error to the model with the
 * same text as ever (`cancelled by user` first for `/orche cancel`, then {@link formatOutcome}, which includes the
 * "Result from failed run" section) and `outcome.details` plus `failure` as details.
 */
export function runErrorResult(outcome: OrcheOutcome): ErrorToolResult<OrcheRunDetails, RunFailure> {
  const text = formatOutcome(outcome);
  return errorToolResult(outcome.cancelledByUser ? `cancelled by user\n\n${text}` : text, outcome.details, runFailureOf(outcome));
}
