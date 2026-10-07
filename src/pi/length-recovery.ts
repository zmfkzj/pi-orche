/**
 * Output-limit ("length") recovery for orche worker sessions.
 *
 * Pi treats an assistant message with `stopReason: "length"` whose `usage.output` is below the model's catalog `maxTokens` as a
 * *recoverable overflow*: it omits the attempt from the context, compacts and retries once per prompt (pi-ai
 * `isRecoverableLength`, pi-coding-agent `AgentSession._checkCompaction`). That is right when a context-clamped request limit cut
 * the answer, and wrong when the cap sits elsewhere (a proxy capping output at 32000 tokens while the catalog says 128000) or when
 * the model spent the whole output budget on reasoning: shrinking the INPUT cannot raise an OUTPUT cap. In real worker sessions this
 * produced repeated compactions of a 30-60k context in a 1M window, thinking-only truncations every time, and workers that ended
 * without their report (docs/length-recovery.md has the transcripts, the survey of other agents and the benchmark).
 *
 * The three cases are told apart per assistant message:
 * - `thinking_only`: length stop with no text and no tool call. Without context pressure the compaction is cancelled
 *   (`session_before_compact` → `{ cancel: true }`; Pi still omits the attempt from the context) and, when the run is about to
 *   settle, one continuation is requested (`agent_before_settle` → a nudge entry + `continue: true`) telling the model to reason
 *   only about the next step and act. Capped by `maxConsecutive`; any delivered text or tool call resets the count.
 * - `partial_text`: length stop with text but no tool call. Same, but the nudge quotes the tail of the cut text so the work is
 *   not lost (Pi may have omitted the attempt) and asks to continue from there without repeating.
 * - The last allowed recovery runs one thinking level lower (restored at the next delivered output): in the benchmark this was the
 *   only strategy that recovered an overrun bound to the effort level, at no cost in the other cases. The default thinking level is
 *   never lowered up front.
 * - `partial_tool`: length stop with tool calls. Pi already fails the possibly truncated calls with synthetic results and the loop
 *   goes on; nothing is added here except bookkeeping (and the compaction is still cancelled without context pressure).
 * - Real context overflow (a provider overflow error, or a length stop under context pressure) is left to Pi's own
 *   compact-and-retry.
 *
 * After `maxConsecutive` consecutive length stops the state is `exhausted`; the owner (src/agent/agent-manager.ts) then asks once
 * for a report with what the worker has and otherwise fails the assignment with an explicit output-limit error, never a silent end.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type LengthStopKind = "thinking_only" | "partial_text" | "partial_tool";
/**
 * `nudge`: cancel useless compactions and continue with a next-step nudge (default). Benchmark baselines only:
 * `continue`: cancel and continue with a plain "Continue." message (the generic continuation nudge of Cline/Roo/OpenHands-style
 * agents); `resend`: cancel and re-send the same request with nothing added (Codex CLI and Gemini CLI re-send the identical request,
 * though as a transport retry with backoff); `off`: Pi's own behaviour.
 */
export type LengthRecoveryMode = "nudge" | "continue" | "resend" | "off";

export interface LengthRecoveryOptions {
  mode?: LengthRecoveryMode;
  /** Consecutive length stops recovered before the state is exhausted (default {@link DEFAULT_MAX_CONSECUTIVE}). */
  maxConsecutive?: number;
  /**
   * Lower the thinking level by one step for the LAST recovery attempt only, restored at the next delivered text or tool call or
   * at the next assignment (default {@link DEFAULT_STEP_DOWN_THINKING}). The session's level is never lowered before that, and a
   * level at `minimal` or below is left alone.
   */
  stepDownThinking?: boolean;
  /** Called for every length stop and every recovery decision (records, benchmark). Must not throw. */
  onEvent?: (event: LengthRecoveryEvent) => void;
}

export interface LengthRecoveryEvent {
  type: "length_stop";
  timestamp: number;
  kind: LengthStopKind;
  output: number;
  contextTokens: number;
  /** What was done about it. */
  action: "observed" | "compaction_cancelled" | "continued" | "exhausted" | "left_to_pi";
  consecutive: number;
  total: number;
}

export interface LengthRecoveryState {
  /** Length stops since the last delivered text/tool call. */
  consecutive: number;
  /** All length stops of the session. */
  total: number;
  /** Continuations requested by this module. */
  continued: number;
  /** Compactions cancelled by this module. */
  cancelledCompactions: number;
  /** The cap was reached: the owner must get a report or fail the assignment explicitly. */
  exhausted: boolean;
  /** The last length stop, still waiting for its recovery decision. */
  pending?: { kind: LengthStopKind; output: number; contextTokens: number; tail?: string };
  /** The thinking level to restore after a step-down. */
  restoreThinking?: string;
}

/** Defaults chosen by the benchmark (experiments/length-recovery, docs/length-recovery.md): two recoveries, the last one a level lower. */
export const DEFAULT_MAX_CONSECUTIVE = 2;
export const DEFAULT_STEP_DOWN_THINKING = true;
const TAIL_CHARS = 1500;
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface MessageLike {
  role?: string;
  stopReason?: string;
  content?: unknown;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

const parts = (message: MessageLike): { type?: string; text?: string }[] =>
  Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : [];

/** Text and tool calls the message delivered (thinking alone delivers nothing). */
export function delivered(message: MessageLike): { text: string; toolCalls: number } {
  const content = parts(message);
  return {
    text: content.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text!).join(""),
    toolCalls: content.filter(part => part.type === "toolCall").length,
  };
}

/** The kind of a length stop, or undefined for any other message. */
export function classifyLengthStop(message: MessageLike): LengthStopKind | undefined {
  if (message.role !== "assistant" || message.stopReason !== "length") return undefined;
  const { text, toolCalls } = delivered(message);
  if (toolCalls) return "partial_tool";
  return text.trim() ? "partial_text" : "thinking_only";
}

/** Input-side tokens of the request that produced `message`. */
export function contextTokensOf(message: MessageLike): number {
  const usage = message.usage ?? {};
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * Whether the context, not the output cap, is the problem: the request filled 85% of the window, or the request plus the output
 * reached the window minus a 16k reserve. Unknown window: assume pressure (leave it to Pi).
 */
export function underContextPressure(contextTokens: number, output: number, contextWindow: number | undefined): boolean {
  if (!contextWindow || contextWindow <= 0) return true;
  return contextTokens >= contextWindow * 0.85 || contextTokens + output >= contextWindow - Math.min(16_384, contextWindow * 0.1);
}

/** The continuation prompt for a recovered length stop. */
export function lengthNudge(pending: NonNullable<LengthRecoveryState["pending"]>, attempt: number, max: number): string {
  const head = `[pi-orche] Your previous response hit the output token limit (${pending.output} tokens)`;
  if (pending.kind === "partial_text") {
    return `${head} and was cut off (recovery ${attempt}/${max}). It ended with:\n«…${pending.tail ?? ""}»\nContinue from exactly where it stopped without repeating earlier text. Keep the rest short; write large content to files in smaller pieces with tools, and call report_result when the work is done.`;
  }
  return `${head} while still reasoning, before any text or tool call, so it was discarded (recovery ${attempt}/${max}). Do not re-plan the whole task. Reason only about the immediate next step, then call one tool now. Write large files or reports in several smaller pieces. If the work is finished, call report_result now with what you have.`;
}

const states = new WeakMap<object, LengthRecoveryState>();

/** The recovery state of a worker session (a fresh state for a session without the extension). */
export function lengthRecoveryOf(session: object): LengthRecoveryState {
  let state = states.get(session);
  if (!state) states.set(session, state = { consecutive: 0, total: 0, continued: 0, cancelledCompactions: 0, exhausted: false });
  return state;
}

/** Start over at an assignment boundary: the count, the exhaustion and a pending stop belong to the previous assignment. */
export function resetLengthRecovery(session: object): void {
  const state = lengthRecoveryOf(session);
  if (state.restoreThinking !== undefined) {
    try { (session as { setThinkingLevel?: (level: never) => void }).setThinkingLevel?.(state.restoreThinking as never); } catch { /* best effort */ }
    state.restoreThinking = undefined;
  }
  state.consecutive = 0;
  state.exhausted = false;
  state.pending = undefined;
}

/** Event handlers of the length-recovery extension for one session (wired into a Pi `Extension` by the session factory). */
export function lengthRecoveryHandlers(getSession: () => AgentSession | undefined, options: LengthRecoveryOptions = {}) {
  const mode = options.mode ?? "nudge";
  const max = Math.max(1, Math.floor(options.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE));
  const state = () => {
    const session = getSession();
    return session ? lengthRecoveryOf(session) : undefined;
  };
  const emit = (current: LengthRecoveryState, kind: LengthStopKind, output: number, contextTokens: number, action: LengthRecoveryEvent["action"]) => {
    try { options.onEvent?.({ type: "length_stop", timestamp: Date.now(), kind, output, contextTokens, action, consecutive: current.consecutive, total: current.total }); } catch { /* observers cannot change recovery */ }
  };
  const restoreThinking = (current: LengthRecoveryState) => {
    if (current.restoreThinking === undefined) return;
    const session = getSession();
    try { session?.setThinkingLevel(current.restoreThinking as never); } catch { /* best effort */ }
    current.restoreThinking = undefined;
  };
  return {
    message_end: (event: { message: MessageLike }) => {
      const current = state();
      if (!current) return;
      const message = event.message;
      if (message.role !== "assistant") return;
      const kind = classifyLengthStop(message);
      if (!kind) {
        if (message.stopReason === "error" || message.stopReason === "aborted") return;
        const { text, toolCalls } = delivered(message);
        if (text.trim() || toolCalls) { current.consecutive = 0; current.pending = undefined; restoreThinking(current); }
        return;
      }
      current.total++;
      current.consecutive++;
      const output = message.usage?.output ?? 0;
      const contextTokens = contextTokensOf(message);
      const { text } = delivered(message);
      current.pending = { kind, output, contextTokens, ...(kind === "partial_text" ? { tail: text.slice(-TAIL_CHARS) } : {}) };
      emit(current, kind, output, contextTokens, "observed");
    },
    session_before_compact: (event: { reason?: string; willRetry?: boolean }) => {
      const current = state();
      if (!current?.pending || event.reason !== "overflow" || !event.willRetry) return undefined;
      if (mode === "off") { emit(current, current.pending.kind, current.pending.output, current.pending.contextTokens, "left_to_pi"); return undefined; }
      const window = getSession()?.model?.contextWindow;
      const { kind, output, contextTokens } = current.pending;
      if (underContextPressure(contextTokens, output, window)) {
        emit(current, kind, output, contextTokens, "left_to_pi");
        current.pending = undefined; // a real overflow: Pi compacts and retries
        return undefined;
      }
      current.cancelledCompactions++;
      emit(current, kind, output, contextTokens, "compaction_cancelled");
      return { cancel: true };
    },
    agent_before_settle: (event: { outcome?: string }) => {
      const current = state();
      if (!current?.pending || event.outcome === "aborted") return undefined;
      const pending = current.pending;
      current.pending = undefined;
      // Pi's own behaviour, untouched (the benchmark's baseline): length stops are only counted.
      if (mode === "off") return undefined;
      // Pi keeps running a length stop with tool calls on its own; it only reaches here if the run is ending anyway.
      if (current.consecutive > max) {
        current.exhausted = true;
        emit(current, pending.kind, pending.output, pending.contextTokens, "exhausted");
        return undefined;
      }
      current.continued++;
      if ((options.stepDownThinking ?? DEFAULT_STEP_DOWN_THINKING) && current.consecutive === max) {
        const session = getSession();
        const level = session?.thinkingLevel;
        const index = level ? THINKING_ORDER.indexOf(level) : -1;
        if (session && index > 1) {
          current.restoreThinking = level;
          try { session.setThinkingLevel(THINKING_ORDER[index - 1] as never); } catch { current.restoreThinking = undefined; }
        }
      }
      emit(current, pending.kind, pending.output, pending.contextTokens, "continued");
      if (mode === "resend") return { continue: true };
      if (mode === "continue") return { entries: [{ type: "custom_message" as const, customType: "pi-orche.length-recovery", content: "Continue.", display: true, details: { kind: pending.kind, output: pending.output, attempt: current.consecutive, max } }], continue: true };
      return {
        entries: [{ type: "custom_message" as const, customType: "pi-orche.length-recovery", content: lengthNudge(pending, current.consecutive, max), display: true, details: { kind: pending.kind, output: pending.output, attempt: current.consecutive, max } }],
        continue: true,
      };
    },
  };
}
