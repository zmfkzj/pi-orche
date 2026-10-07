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
 * - Ladder `step-down` (the default without the phase thinking policy): the last allowed recovery runs one supported thinking level
 *   lower (src/pi/thinking-state.ts; restored at the next delivered output): in the benchmark this was the only strategy that
 *   recovered an overrun bound to the effort level. The default thinking level is never lowered up front.
 * - Ladder `redecompose` (the phase thinking policy, src/pi/thinking-policy.ts; docs/thinking-policy.md): quality first, so the
 *   effort is NOT lowered. The first recovery asks for one next action (and the node's checkpoint); the second asks to split the
 *   running Task DAG node into smaller nodes (integration: one verification node per requirement, still at the baseline), or,
 *   without a plan, for one small concrete step. A split counts only when the policy accepts it (the node is no longer running and
 *   two or more new nodes appear), at most MAX_REDECOMPOSITIONS times per assignment.
 * - `partial_tool`: length stop with tool calls. Pi already fails the possibly truncated calls with synthetic results and the loop
 *   goes on; nothing is added here except bookkeeping (and the compaction is still cancelled without context pressure).
 * - Real context overflow (a provider overflow error, or a length stop under context pressure) is left to Pi's own
 *   compact-and-retry.
 *
 * The state is `exhausted` after `maxConsecutive` consecutive length stops, after `maxPerAssignment` length stops in one assignment
 * (a model that delivers a trivial tool call between overruns cannot reset the budget forever), with the `redecompose` ladder after
 * `maxWithoutProgress` length stops without progress evidence from the Task DAG (a newly finished node or an accepted split; a tool
 * call is not progress), or when no further split is allowed. The owner (src/agent/agent-manager.ts) then asks once for a report
 * with what the worker has and otherwise fails the assignment with an explicit output-limit error, never a silent end.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beginThinking, clearThinkingOverride, lowerThinkingForRecovery, thinkingStateOf } from "./thinking-state.js";
import { requestRedecompose, thinkingPolicyOf, type RedecomposeRequest } from "./thinking-policy.js";

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
  /**
   * Which recovery ladder to use when the session has no thinking policy (the policy's `lengthRecovery` wins): "step-down" (default)
   * or "redecompose" (no effort change; see the module comment).
   */
  ladder?: "step-down" | "redecompose";
  /** Length stops in one assignment before the state is exhausted, whatever came in between (default {@link DEFAULT_MAX_PER_ASSIGNMENT}). */
  maxPerAssignment?: number;
  /** `redecompose` ladder: length stops without Task DAG progress before the state is exhausted (default {@link DEFAULT_MAX_WITHOUT_PROGRESS}). */
  maxWithoutProgress?: number;
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
  /** Length stops since the assignment started. */
  assignmentStops: number;
  /** Length stops since the last progress evidence (the thinking policy's progress count; without a policy, delivered output). */
  sinceProgress: number;
  /** The thinking policy's progress count at the last length stop. */
  progressMark?: number;
}

/** Defaults chosen by the benchmark (experiments/length-recovery, docs/length-recovery.md): two recoveries, the last one a level lower. */
export const DEFAULT_MAX_CONSECUTIVE = 2;
export const DEFAULT_STEP_DOWN_THINKING = true;
export const DEFAULT_MAX_PER_ASSIGNMENT = 8;
export const DEFAULT_MAX_WITHOUT_PROGRESS = 4;
const TAIL_CHARS = 1500;

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

/** The continuation prompt for a recovered length stop. `checkpoint`: ask for the node checkpoint too (Task DAG checkpoints on). */
export function lengthNudge(pending: NonNullable<LengthRecoveryState["pending"]>, attempt: number, max: number, checkpoint = false): string {
  const head = `[pi-orche] Your previous response hit the output token limit (${pending.output} tokens)`;
  const node = checkpoint ? " When the running Task DAG node is finished, record its checkpoint with task_plan before going on." : "";
  if (pending.kind === "partial_text") {
    return `${head} and was cut off (recovery ${attempt}/${max}). It ended with:\n«…${pending.tail ?? ""}»\nContinue from exactly where it stopped without repeating earlier text. Keep the rest short; write large content to files in smaller pieces with tools, and call report_result when the work is done.${node}`;
  }
  return `${head} while still reasoning, before any text or tool call, so it was discarded (recovery ${attempt}/${max}). Do not re-plan the whole task. Reason only about the immediate next step, then call one tool now. Write large files or reports in several smaller pieces. If the work is finished, call report_result now with what you have.${node}`;
}

/** The `redecompose` ladder's last recovery: a smaller scope at the same effort (src/pi/thinking-policy.ts judges the split). */
export function redecomposeNudge(pending: NonNullable<LengthRecoveryState["pending"]>, attempt: number, max: number, request: Exclude<RedecomposeRequest, { kind: "exhausted" }>): string {
  const what = pending.kind === "partial_text" ? `and was cut off again (recovery ${attempt}/${max}); it ended with «…${(pending.tail ?? "").slice(-300)}»` : `again while still reasoning, before any text or tool call (recovery ${attempt}/${max})`;
  const head = `[pi-orche] Your previous response hit the output token limit (${pending.output} tokens) ${what}. The scope is too large for one response; your effort level stays the same.`;
  if (request.kind === "integrate") {
    return `${head} Split the integration now: call task_plan with one verification node per requirement id (phase "integrate", covering that id only)${request.node ? `, mark ${request.node} skipped` : ""}, then verify one requirement per response against the actual changes, diffs and check runs. Do not lower the bar: a requirement you cannot verify is reported unmet or partial.`;
  }
  if (request.kind === "step") {
    return `${head} Call task_plan now and split ${request.node ? `the running node ${request.node}` : "the next node"} into two or more smaller nodes${request.node ? ` (mark ${request.node} skipped, or done with its checkpoint for the part that is finished)` : ""}; then start the first of them with one tool call. Do not re-plan the rest of the Task DAG.`;
  }
  return `${head} Narrow the scope: do one small, concrete step now with one tool call (read one file region, run one check). If the remaining work cannot fit, call report_result with what you have and name what is not done; never present unverified work as done.`;
}

const states = new WeakMap<object, LengthRecoveryState>();

/** The recovery state of a worker session (a fresh state for a session without the extension). */
export function lengthRecoveryOf(session: object): LengthRecoveryState {
  let state = states.get(session);
  if (!state) states.set(session, state = { consecutive: 0, total: 0, continued: 0, cancelledCompactions: 0, exhausted: false, assignmentStops: 0, sinceProgress: 0 });
  return state;
}

/**
 * Start over at an assignment boundary: the counts, the exhaustion and a pending stop belong to the previous assignment. The thinking
 * level goes back to the assignment's baseline (src/pi/thinking-state.ts): a level the owner set for this assignment wins over a
 * step-down left from the previous one.
 */
export function resetLengthRecovery(session: object): void {
  const state = lengthRecoveryOf(session);
  if (typeof (session as { setThinkingLevel?: unknown }).setThinkingLevel === "function") beginThinking(session as never);
  else thinkingStateOf(session).override = undefined;
  state.consecutive = 0;
  state.exhausted = false;
  state.pending = undefined;
  state.assignmentStops = 0;
  state.sinceProgress = 0;
  state.progressMark = undefined;
}

/** Event handlers of the length-recovery extension for one session (wired into a Pi `Extension` by the session factory). */
export function lengthRecoveryHandlers(getSession: () => AgentSession | undefined, options: LengthRecoveryOptions = {}) {
  const mode = options.mode ?? "nudge";
  const max = Math.max(1, Math.floor(options.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE));
  const perAssignment = Math.max(max + 1, Math.floor(options.maxPerAssignment ?? DEFAULT_MAX_PER_ASSIGNMENT));
  const withoutProgress = Math.max(max, Math.floor(options.maxWithoutProgress ?? DEFAULT_MAX_WITHOUT_PROGRESS));
  const state = () => {
    const session = getSession();
    return session ? lengthRecoveryOf(session) : undefined;
  };
  const policy = () => {
    const session = getSession();
    return session ? thinkingPolicyOf(session) : undefined;
  };
  const ladder = () => policy()?.settings.lengthRecovery ?? options.ladder ?? "step-down";
  const emit = (current: LengthRecoveryState, kind: LengthStopKind, output: number, contextTokens: number, action: LengthRecoveryEvent["action"]) => {
    try { options.onEvent?.({ type: "length_stop", timestamp: Date.now(), kind, output, contextTokens, action, consecutive: current.consecutive, total: current.total }); } catch { /* observers cannot change recovery */ }
  };
  const restoreThinking = () => {
    const session = getSession();
    if (session) clearThinkingOverride(session);
  };
  const exhaust = (current: LengthRecoveryState, pending: NonNullable<LengthRecoveryState["pending"]>) => {
    current.exhausted = true;
    emit(current, pending.kind, pending.output, pending.contextTokens, "exhausted");
    return undefined;
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
        if (text.trim() || toolCalls) {
          current.consecutive = 0; current.pending = undefined; restoreThinking();
          // Without a Task DAG policy, delivered output is the only progress signal there is.
          if (!policy()) current.sinceProgress = 0;
        }
        return;
      }
      current.total++;
      current.consecutive++;
      current.assignmentStops++;
      const progress = policy()?.progress;
      if (progress !== undefined && progress !== current.progressMark) { current.progressMark = progress; current.sinceProgress = 0; }
      current.sinceProgress++;
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
      const quality = ladder() === "redecompose";
      if (current.consecutive > max || current.assignmentStops > perAssignment || (quality && current.sinceProgress > withoutProgress)) return exhaust(current, pending);
      const details = { kind: pending.kind, output: pending.output, attempt: current.consecutive, max };
      const last = current.consecutive === max;
      let content: string;
      if (quality && last && mode === "nudge") {
        const session = getSession();
        const request = session ? requestRedecompose(session) : { kind: "no-plan" as const };
        if (request.kind === "exhausted") return exhaust(current, pending);
        content = redecomposeNudge(pending, current.consecutive, max, request);
      } else {
        if (!quality && last && (options.stepDownThinking ?? DEFAULT_STEP_DOWN_THINKING)) {
          // One level lower among the levels the model supports (Pi would clamp an unsupported one back up), never to `off`.
          const session = getSession();
          if (session) lowerThinkingForRecovery(session);
        }
        content = lengthNudge(pending, current.consecutive, max, !!policy()?.settings.checkpoints && !!policy()?.plan);
      }
      current.continued++;
      emit(current, pending.kind, pending.output, pending.contextTokens, "continued");
      if (mode === "resend") return { continue: true };
      if (mode === "continue") return { entries: [{ type: "custom_message" as const, customType: "pi-orche.length-recovery", content: "Continue.", display: true, details }], continue: true };
      return { entries: [{ type: "custom_message" as const, customType: "pi-orche.length-recovery", content, display: true, details }], continue: true };
    },
  };
}
