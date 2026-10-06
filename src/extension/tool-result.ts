import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { withRecordLine } from "./controller.js";

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

/**
 * Error result for a call that ran and failed: `content` is `text` (what the model reads, identical to what a thrown
 * error would have shown) and `details` is a copy of `details` with the `failure` summary added. `failure` is a reserved
 * key of `details`. The result is `isError: true`, so the model sees an error exactly as for a thrown error.
 *
 * Records: when `details.record` (the record directory, see records.ts) is set, `content` ends with the one line
 * `Record: <dir>` (unless `text` already says it), so a failed or cancelled call can be traced
 * to its transcripts exactly like a successful one.
 */
export function errorToolResult<D extends object, F extends ToolFailure>(text: string, details: D, failure: F): ErrorToolResult<D, F> {
  const record = (details as { record?: unknown }).record;
  const shown = typeof record === "string" && record && !text.includes(`Record: ${record}`) ? withRecordLine(text, record) : text;
  return { content: [{ type: "text", text: shown }], details: { ...details, failure }, isError: true };
}

/** First non-empty line of `text`, whitespace collapsed and cut to `max` characters (marked with an ellipsis). */
export function failureReason(text: string, max: number = FAILURE_REASON_CHARS): string {
  const line = text.split("\n").map(part => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
