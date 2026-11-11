/**
 * A size budget for Pi's summary requests in orche sessions (docs/compaction.md "Summary budget").
 *
 * Pi's repeated compactions are iterative: each summary request carries the previous summary in `<previous-summary>` with
 * Pi's update rules ("PRESERVE all existing information from the previous summary", then add the new messages), and asks only
 * that each section be "concise". A long worker therefore wrote a larger summary at every compaction until one no longer fit in a
 * single response: research it-0139 (cliproxyapi/claude-fable-5-2, 1M window, max_output_tokens 128000) grew from 34k to 272k
 * characters over nine compactions (output 25k → 144k tokens of a history plus a turn-prefix request), then every threshold
 * check sent the same request again and Pi refused each cut-off answer ("generation hit the token cap and the summary is
 * incomplete"): six failures, about 16 minutes and up to the whole output limit each, with the context unchanged.
 *
 * So every summary request Pi sends through an orche session (recognised by output-cap.ts `withSummaryOutputCap`) gets one more
 * instruction block after Pi's own prompt: the whole summary must stay under a token budget (a quarter of the model's catalog
 * `maxTokens`, at most {@link SUMMARY_BUDGET_MAX}; {@link SUMMARY_BUDGET_UNKNOWN} without one), condensing older detail when the
 * previous summary is already larger, and, in task sessions, that orche's restored essentials (verbatim assignment, Task DAG with
 * its checkpoints, ledger: built from orche's state, never from the summary) need not be copied. When an answer still stops at the
 * output limit (`stopReason: "length"`), the session's budget level rises (the budget halves, down to {@link SUMMARY_BUDGET_MIN})
 * and the request is sent once more at once with the smaller budget; the session's later summaries keep that level, so the request
 * that was cut off is never repeated unchanged. A second cut-off answer is returned to Pi, which fails the compaction as before
 * (keeping the context); the next attempt starts from the raised level. Errors (provider failures such as a usage limit), aborts
 * and complete answers pass through untouched: only an output-limit stop is retried here.
 */
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type Message } from "@earendil-works/pi-ai";

/** Upper bound of the budget (tokens). */
export const SUMMARY_BUDGET_MAX = 32_000;
/** The share of the model's catalog `maxTokens` a summary may use. */
export const SUMMARY_BUDGET_SHARE = 0.25;
/** The budget of a model without a catalog `maxTokens`. */
export const SUMMARY_BUDGET_UNKNOWN = 16_000;
/** Lower bound of the budget after output-limit stops (tokens). */
export const SUMMARY_BUDGET_MIN = 4_096;

/** A summary answer that stopped at the output limit. */
export interface SummaryLengthStop {
  type: "summary_length_stop";
  model?: string;
  /** The budget the cut-off request asked for, and the one the next request asks for. */
  budgetTokens: number;
  nextBudgetTokens: number;
  /** Output tokens the provider reported for the cut-off answer, and the `max_output_tokens` orche sent with it (output-cap.ts;
   *  absent: none was sent, the provider's own limit applied). */
  outputTokens?: number;
  cap?: number;
  /** The request was sent once more right away (false: the second cut-off answer, returned to Pi). */
  retry: boolean;
}

interface BudgetState { level: number; onEvent?: (event: SummaryLengthStop) => void }
const states = new WeakMap<object, BudgetState>();
const stateOf = (session: object): BudgetState => {
  let state = states.get(session);
  if (!state) states.set(session, state = { level: 0 });
  return state;
};

/** The observer of a session's output-limit stops (an assignment start). The budget level is the session's and is kept. */
export function configureSummaryBudget(session: object, onEvent?: (event: SummaryLengthStop) => void): void {
  const state = stateOf(session);
  if (onEvent) state.onEvent = onEvent; else delete state.onEvent;
}

/** The session's current budget level (0: no output-limit stop yet). */
export function summaryBudgetLevel(session: object): number {
  return states.get(session)?.level ?? 0;
}

/** The budget (tokens) for `model` at `level`. */
export function summaryBudgetTokens(model: { maxTokens?: number } | undefined, level = 0): number {
  const max = model?.maxTokens;
  const base = max && max > 0 ? Math.min(SUMMARY_BUDGET_MAX, Math.floor(max * SUMMARY_BUDGET_SHARE)) : SUMMARY_BUDGET_UNKNOWN;
  return Math.max(SUMMARY_BUDGET_MIN, Math.floor(base / 2 ** level));
}

/** The instruction block appended to a summary request. `restoredLabel`: the heading of the essentials orche restores verbatim. */
export function summaryBudgetNote(tokens: number, options: { retry?: boolean; restoredLabel?: string } = {}): string {
  const lines = [
    "orche summary budget (takes precedence over any instruction to preserve everything):",
    ...(options.retry ? ["- The previous attempt at this summary stopped at the response limit and was discarded. Write a much shorter summary now."] : []),
    `- Keep the whole summary under about ${tokens.toLocaleString("en-US")} tokens (about ${(tokens * 3).toLocaleString("en-US")} characters). It must fit well within one response, and the next compaction folds it into the next summary.`,
    "- If the previous summary or the new messages are larger, condense: merge finished work into short lines, drop superseded, repeated or already-resolved detail, and keep the exact paths, identifiers, numbers and error messages the next steps need.",
    "- Keep the current state, open problems, blockers and next steps complete.",
    ...(options.restoredLabel ? [`- A message that starts with "${options.restoredLabel}" is restored verbatim after this summary from the task's own records: do not copy its content; one line that points to it is enough.`] : []),
  ];
  return lines.join("\n");
}

/** `context` with `note` appended to its last user message (a copy; Pi's context is not changed). */
export function withSummaryNote(context: Context, note: string): Context {
  const index = context.messages.map(message => message.role).lastIndexOf("user");
  if (index < 0) return context;
  const user = context.messages[index] as Extract<Message, { role: "user" }>;
  const content = typeof user.content === "string" ? [{ type: "text" as const, text: user.content }] : user.content;
  const messages = [...context.messages];
  messages[index] = { ...user, content: [...content, { type: "text", text: note }] };
  return { ...context, messages };
}

/**
 * One summary request of `session` with the budget: `send` sends a context (the summary request with orche's other options) and
 * returns its stream. The returned stream relays the events of every attempt; its result is the last attempt's.
 */
export function budgetedSummary(session: object, model: { provider?: string; id?: string; maxTokens?: number }, context: Context,
  send: (context: Context) => AssistantMessageEventStream, options: { signal?: AbortSignal; restoredLabel?: string; cap?: () => number | undefined } = {}): AssistantMessageEventStream {
  const state = stateOf(session);
  const out = createAssistantMessageEventStream();
  const name = model.provider !== undefined || model.id !== undefined ? `${model.provider ?? ""}/${model.id ?? ""}` : undefined;
  const attempt = async (retry: boolean): Promise<void> => {
    const budget = summaryBudgetTokens(model, state.level);
    const stream = send(withSummaryNote(context, summaryBudgetNote(budget, { retry, ...(options.restoredLabel ? { restoredLabel: options.restoredLabel } : {}) })));
    let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
    for await (const event of stream) {
      if (event.type === "done" || event.type === "error") { terminal = event; break; }
      out.push(event);
    }
    const final: AssistantMessage = terminal ? (terminal.type === "done" ? terminal.message : terminal.error) : await stream.result();
    if (final.stopReason === "length") {
      state.level++;
      const again = !retry && !options.signal?.aborted;
      const cap = options.cap?.();
      try {
        state.onEvent?.({ type: "summary_length_stop", ...(name ? { model: name } : {}), budgetTokens: budget, nextBudgetTokens: summaryBudgetTokens(model, state.level),
          ...(final.usage ? { outputTokens: final.usage.output } : {}), ...(cap !== undefined ? { cap } : {}), retry: again });
      } catch { /* observers cannot change the request */ }
      if (again) return attempt(true);
    }
    if (terminal) { out.push(terminal); out.end(); } else out.end(final);
  };
  attempt(false).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: "unknown", provider: model.provider ?? "unknown", model: model.id ?? "unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage: message, timestamp: Date.now() } as AssistantMessage });
    out.end();
  });
  return out;
}
