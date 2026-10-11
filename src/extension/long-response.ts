/**
 * The main session's long-response watch (docs/orchestrator.md 15).
 *
 * One main response that runs for many minutes without a tool call or visible text is the main model working out the task
 * (often the implementation) before it acts. Some provider paths end a single response at about 15 minutes ("stream closed
 * before response.completed"); Pi then retries the same request from the same context, which can run into the same cut-off
 * again. Two minimal interventions, both advisory:
 *
 * 1. While a response streams: after `warnAfterMs` without a tool call or text, notify the USER once for that response. Pi cannot
 *    change a response that is already streaming, so this only tells the user what is happening (Esc stops it).
 * 2. After such a response ended with an error (stopReason `error`, at least `failureAfterMs` long, no tool call, no text): every
 *    later model request of the main session gets a request-local note (`guidance`, added by the `context` handler) asking main to
 *    keep the analysis short and hand off early, until a response completes (stop, toolUse, length) or the user aborts. Pi's own
 *    auto-retry (settings `retry`) is neither cancelled nor delayed: the note changes what the retry asks for, not whether it runs.
 *
 * The watch covers the time an assistant message streams (message_start .. message_end) only: tool calls, orche_task jobs and
 * the attached wait are outside it. State is per extension instance (one per Pi session) and reset on session start/shutdown.
 */
import type { MainMode } from "../orchestration/routing.js";

/** Notify the user when one response has streamed this long without a tool call or text. */
export const LONG_RESPONSE_WARN_MS = 10 * 60_000;
/** A response that failed after at least this long without a tool call or text arms the note for the next requests. */
export const LONG_RESPONSE_FAILURE_MS = 10 * 60_000;
/** `customType` of the request-local note (never stored in the session). */
export const LONG_RESPONSE_GUIDANCE_TYPE = "orche-long-response";

export interface LongResponseOptions { warnAfterMs?: number; failureAfterMs?: number; now?: () => number }
interface MessageLike { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; timestamp?: number; durationMs?: number }
type Notify = (message: string, type: "info" | "warning") => void;

/** A tool call or non-blank text in the content: the response is acting or answering, not only reasoning. */
export function hasVisibleOutput(content: unknown): boolean {
  if (!Array.isArray(content)) return typeof content === "string" && /\S/.test(content);
  return content.some(block => {
    const part = block as { type?: string; text?: unknown };
    return part.type === "toolCall" || part.type === "text" && typeof part.text === "string" && /\S/.test(part.text);
  });
}
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
const COMPLETED: readonly string[] = ["stop", "toolUse", "length"];

export class LongResponseWatch {
  private readonly warnAfterMs: number;
  private readonly failureAfterMs: number;
  private readonly now: () => number;
  private streaming: { message: MessageLike; origin: number; visible: boolean; timer?: ReturnType<typeof setTimeout> } | undefined;
  private failed: { durationMs: number; error: string; failures: number } | undefined;

  constructor(private readonly mode: () => MainMode, private readonly notify: Notify, options: LongResponseOptions = {}) {
    this.warnAfterMs = options.warnAfterMs ?? LONG_RESPONSE_WARN_MS;
    this.failureAfterMs = options.failureAfterMs ?? LONG_RESPONSE_FAILURE_MS;
    this.now = options.now ?? Date.now;
  }

  /** A long failure is pending: the next requests carry the note. */
  get armed(): boolean { return !!this.failed; }

  messageStart(message: MessageLike): void {
    if (message.role !== "assistant") return;
    this.stopTimer();
    const now = this.now();
    // The request started at message.timestamp (pi-ai AssistantMessage); a missing or future one counts from now.
    const origin = typeof message.timestamp === "number" && message.timestamp <= now ? message.timestamp : now;
    const streaming: NonNullable<LongResponseWatch["streaming"]> = { message, origin, visible: hasVisibleOutput(message.content) };
    this.streaming = streaming;
    if (streaming.visible) return;
    streaming.timer = setTimeout(() => this.warn(streaming), Math.max(0, this.warnAfterMs - (now - origin)));
    streaming.timer.unref?.();
  }

  messageUpdate(message: MessageLike): void {
    const streaming = this.streaming;
    if (message.role !== "assistant" || !streaming || streaming.visible) return;
    streaming.message = message;
    if (!hasVisibleOutput(message.content)) return;
    streaming.visible = true;
    this.stopTimer();
  }

  messageEnd(message: MessageLike): void {
    if (message.role !== "assistant") return;
    const origin = this.streaming?.origin;
    this.stopTimer();
    this.streaming = undefined;
    if (message.stopReason === "aborted") { this.failed = undefined; return; }
    if (message.stopReason && COMPLETED.includes(message.stopReason)) { this.failed = undefined; return; }
    if (message.stopReason !== "error" || hasVisibleOutput(message.content)) return;
    const now = this.now();
    const durationMs = Math.max(message.durationMs ?? 0, origin !== undefined ? now - origin : 0, typeof message.timestamp === "number" && message.timestamp <= now ? now - message.timestamp : 0);
    // A short error (rate limit, connection refused) says nothing about the analysis: it neither arms nor clears the note.
    if (durationMs < this.failureAfterMs) return;
    const error = (message.errorMessage ?? "unknown error").replace(/\s+/g, " ").slice(0, 160);
    const failures = (this.failed?.failures ?? 0) + 1;
    this.failed = { durationMs, error, failures };
    if (failures === 1) this.notify(`orche: main's response ran ${minutes(durationMs)} without a tool call and failed (${error}). If Pi retries it, orche adds a note to the retry asking main to keep the analysis short and ${isDelegating(this.mode()) ? "hand the task to orche_task early" : "work in short steps"}; the retry itself is not blocked or delayed (Esc stops it).`, "warning");
  }

  /** The run settled: an abort ends the episode; otherwise a pending failure stays for the user's next request. */
  settled(aborted: boolean): void {
    this.stopTimer();
    this.streaming = undefined;
    if (aborted) this.failed = undefined;
  }

  reset(): void {
    this.stopTimer();
    this.streaming = undefined;
    this.failed = undefined;
  }

  /** The request-local note for the next model request, while a long failure is pending. */
  guidance(): string | undefined {
    const failed = this.failed;
    if (!failed) return undefined;
    const head = `[orche] Your previous response in this session ran ${minutes(failed.durationMs)} without a tool call and ended with an error (${failed.error})${failed.failures > 1 ? `; this happened ${failed.failures} times in a row` : ""}. A single response that long can be cut off by the provider, so do not repeat that analysis.`;
    return isDelegating(this.mode())
      ? `${head} If the request needs work, call orche_task now: state the goals, constraints, success criteria and the user's original request, and pass anything still undecided (formulas, data structures, protocol details, detailed test design) as open decisions for the worker. Do not drop or change any requirement the user stated. If it is a short question, answer it briefly.`
      : `${head} Work in short steps: start with a tool call now and keep each response short. If it is a short question, answer it briefly.`;
  }

  private warn(streaming: NonNullable<LongResponseWatch["streaming"]>): void {
    if (this.streaming !== streaming || streaming.visible) return;
    streaming.timer = undefined;
    const delegating = isDelegating(this.mode());
    this.notify(`orche: main has been generating one response for ${minutes(this.now() - streaming.origin)} without a tool call or text${delegating ? " (it may be designing the task instead of handing it off)" : ""}. Some provider paths end a single response at about 15 min, and a response already streaming cannot be changed. To save the time, press Esc and ask main to ${delegating ? "hand the task to orche_task now with goals, constraints and success criteria" : "continue in short steps with tool calls"}.`, "warning");
  }

  private stopTimer(): void {
    if (this.streaming?.timer) clearTimeout(this.streaming.timer);
    if (this.streaming) this.streaming.timer = undefined;
  }
}

const isDelegating = (mode: MainMode) => mode !== "direct";
