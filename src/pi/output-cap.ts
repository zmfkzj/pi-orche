/**
 * Explicit output budget for Claude models behind CLIProxyAPI (docs/length-recovery.md "Output cap").
 *
 * Pi's Codex Responses request (pi-ai `openai-codex-responses`, which @router-for-me/pi-cliproxyapi-provider reuses as api
 * `cliproxyapi-codex-responses`) never sends `max_output_tokens`. CLIProxyAPI's Responses → Claude translator then fills Claude's
 * required `max_tokens` with its own default of 32000 (internal/translator/claude/openai/responses/claude_openai-responses_request.go,
 * 8.0.16 a2976eb8 and 8.0.20), whatever the model allows; a request that sends `max_output_tokens` gets that value instead (a cap of 64
 * really ended at 64 tokens, `incomplete: max_output_tokens`). Long reasoning at high effort was cut at exactly 32000 tokens.
 *
 * This module adds `max_output_tokens` to such requests through Pi's `before_provider_request` hook of orche's own sessions only (never
 * main's session, never another provider or a non-Claude model: GPT models on the same proxy path keep the request untouched).
 * The budget, first match wins:
 * 1. a `max_output_tokens` the request already has (someone set it explicitly) is kept;
 * 2. `outputCap.models`: the first `provider/id` pattern that matches (a number, or "off" for no field);
 * 3. `outputCap.tokens`;
 * 4. the model's catalog `maxTokens` (Pi metadata); none: nothing is sent (the proxy default stays).
 * It is then clamped to the context room (window minus a conservative estimate of the request minus a reserve); when the room is
 * below {@link MIN_OUTPUT_CAP} the field is left out (the proxy default and Pi's overflow handling decide, as before).
 *
 * Pi's summary requests (compaction's history and turn-prefix summaries, branch summaries) do not pass through that hook: Pi sends
 * them through the session's stream function without `onPayload` (Pi 1.5.0-1.5.2 `core/compaction/compaction.js`
 * `completeSummarization`), so the proxy default applied to them. {@link withSummaryOutputCap} gives them the same budget through the
 * session's own runtime view, recognising them by Pi's own summary request shape; every other request is left as it was. Their
 * decisions carry `request: "summary"`.
 *
 * Sending the field is not the same as the model producing more than 32000 tokens: that the upstream API accepts and honours a larger
 * value is a property of the proxy and the provider, observed only as far as docs/length-recovery.md says.
 */
import { generateSummary, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { isCliproxyClaude, modelMatches, type EffortModel } from "./effort-mapping.js";
import { budgetedSummary } from "./summary-budget.js";

export interface OutputCapRule {
  /** `provider/id` with `*` wildcards. */
  model: string;
  tokens: number | "off";
}

export interface OutputCapSettings {
  /** auto (default): send an explicit budget in the scope above; off: never touch the request. */
  mode: "auto" | "off";
  /** A fixed budget instead of the catalog maxTokens (still clamped to the context room). */
  tokens?: number;
  /** Per-model budgets, first match wins, before `tokens`. */
  models?: OutputCapRule[];
}

export const DEFAULT_OUTPUT_CAP: Readonly<OutputCapSettings> = { mode: "auto" };
/** Below this much room the field is left out. */
export const MIN_OUTPUT_CAP = 4096;
/** Room kept free of the window besides the request estimate. */
export const OUTPUT_CAP_RESERVE = 2048;
/** CLIProxyAPI's Responses → Claude default, for the records' comparison. */
export const PROXY_DEFAULT_OUTPUT = 32000;

export interface CapModel extends EffortModel {
  contextWindow?: number;
  maxTokens?: number;
}

export interface OutputCapDecision {
  /** The `max_output_tokens` the request carries after this module (undefined: none). */
  cap?: number;
  /** payload: the request had it; config-model: an outputCap.models rule; config: outputCap.tokens; catalog: the model's maxTokens;
   * none: no budget known or rule "off"; out-of-scope: not a Claude model on the CLIProxyAPI path; disabled: outputCap.mode off;
   * context-tight: less room than {@link MIN_OUTPUT_CAP}. */
  source: "payload" | "config-model" | "config" | "catalog" | "none" | "out-of-scope" | "disabled" | "context-tight";
  /** The request clamped the budget to the context room. */
  clamped?: boolean;
  model?: string;
  /** summary: a summary request Pi sends without its payload hook ({@link withSummaryOutputCap}); absent for ordinary requests. */
  request?: "summary";
}

/** Conservative token estimate of a Responses payload: 1 token per 3 characters of its JSON (overestimates for code and prose). */
export function estimatePayloadTokens(payload: Record<string, unknown>): number {
  let chars = 0;
  for (const key of ["instructions", "input", "tools"]) if (payload[key] !== undefined) chars += JSON.stringify(payload[key]).length;
  return Math.ceil(chars / 3);
}

/** The budget for one request (pure; see the module comment). */
export function decideOutputCap(model: CapModel | undefined, payload: Record<string, unknown>, settings: OutputCapSettings = DEFAULT_OUTPUT_CAP): OutputCapDecision {
  const name = model ? `${model.provider ?? ""}/${model.id ?? ""}` : undefined;
  const base = name ? { model: name } : {};
  if (settings.mode === "off") return { source: "disabled", ...base };
  if (!isCliproxyClaude(model)) return { source: "out-of-scope", ...base };
  const existing = payload.max_output_tokens;
  if (typeof existing === "number" && Number.isFinite(existing) && existing > 0) return { cap: existing, source: "payload", ...base };
  const rule = settings.models?.find(entry => modelMatches(model, entry.model));
  let wanted: number | undefined;
  let source: OutputCapDecision["source"];
  if (rule) { wanted = rule.tokens === "off" ? undefined : rule.tokens; source = "config-model"; }
  else if (settings.tokens !== undefined) { wanted = settings.tokens; source = "config"; }
  else { wanted = model?.maxTokens && model.maxTokens > 0 ? model.maxTokens : undefined; source = "catalog"; }
  if (wanted === undefined) return { source: "none", ...base };
  const window = model?.contextWindow;
  if (window && window > 0) {
    const room = Math.floor(window - estimatePayloadTokens(payload) - OUTPUT_CAP_RESERVE);
    if (room < MIN_OUTPUT_CAP) return { source: "context-tight", ...base };
    if (wanted > room) return { cap: room, source, clamped: true, ...base };
  }
  return { cap: Math.floor(wanted), source, ...base };
}

interface CapState {
  settings: OutputCapSettings;
  last?: OutputCapDecision;
  /** The last summary decision, kept apart so summaries never change what {@link lastOutputCap} reports for ordinary requests. */
  lastSummary?: OutputCapDecision;
  onDecision?: (decision: OutputCapDecision) => void;
}
const states = new WeakMap<object, CapState>();

/** The settings of a session's next requests (an assignment start); `onDecision` sees every decision that differs from the last. */
export function configureOutputCap(session: object, settings: OutputCapSettings | undefined, onDecision?: (decision: OutputCapDecision) => void): void {
  states.set(session, { settings: settings ?? { ...DEFAULT_OUTPUT_CAP }, ...(onDecision ? { onDecision } : {}) });
}

/** The last decision of the session (the length recovery's records). */
export function lastOutputCap(session: object): OutputCapDecision | undefined {
  return states.get(session)?.last;
}

/** Decide one request of `session`, report a decision that differs from the last one of its kind, and return the payload with the
 *  budget (undefined: leave it). */
function applyOutputCap(session: object, model: CapModel | undefined, payload: unknown, summary: boolean): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  let state = states.get(session);
  if (!state) states.set(session, state = { settings: { ...DEFAULT_OUTPUT_CAP } });
  const body = payload as Record<string, unknown>;
  const decided = decideOutputCap(model, body, state.settings);
  const decision: OutputCapDecision = summary ? { ...decided, request: "summary" } : decided;
  const last = summary ? state.lastSummary : state.last;
  const changed = !last || last.cap !== decision.cap || last.source !== decision.source || last.model !== decision.model;
  if (summary) state.lastSummary = decision; else state.last = decision;
  if (changed) { try { state.onDecision?.(decision); } catch { /* observers cannot change the request */ } }
  if (decision.cap === undefined || decision.source === "payload") return undefined;
  return { ...body, max_output_tokens: decision.cap };
}

/** Pi `before_provider_request` handler for one orche session: returns the payload with the budget, or undefined to leave it. */
export function outputCapHandler(getSession: () => { model?: CapModel } | undefined) {
  return (event: { payload: unknown }): unknown => {
    const session = getSession();
    if (!session) return undefined;
    let model: CapModel | undefined;
    try { model = session.model; } catch { model = undefined; }
    return applyOutputCap(session, model, event.payload, false);
  };
}

/** The system prompt of a request: Pi's normalized leading system message, else `systemPrompt`. */
function systemPromptOf(context: Context): string | undefined {
  const first = context.messages[0];
  return first?.role === "system" ? getSystemMessageText(first) : context.systemPrompt;
}

let piSummaryPrompt: Promise<string | undefined> | undefined;
/**
 * Pi's summarization system prompt (`SUMMARIZATION_SYSTEM_PROMPT` of `core/compaction/utils.js`, shared by compaction's history and
 * turn-prefix summaries and by branch summaries; Pi does not export it). Read once from Pi's own exported `generateSummary`, given a
 * local stream function that captures the request and answers it: no request leaves the process. Undefined when this Pi no longer
 * calls the stream function that way; summaries then keep the proxy default (as before this view), which the tests would show.
 */
export function summarySystemPrompt(): Promise<string | undefined> {
  return piSummaryPrompt ??= (async () => {
    let prompt: string | undefined;
    const answer = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;
    const capture = (_model: unknown, context: Context) => { prompt = systemPromptOf(context); return { result: async () => answer }; };
    try { await generateSummary([], { reasoning: false } as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, capture as never); }
    catch { /* the prompt was read before Pi looked at the answer */ }
    return prompt;
  })();
}

/**
 * One session's view of `runtime` that gives Pi's summary requests the budget of {@link outputCapHandler}, and only them. The view is
 * the session's `modelRuntime`, so it serves Pi's SDK stream function (agent-loop requests, which carry Pi's `onPayload`, and
 * summaries, which carry none), Pi's cache warmer (`maxTokens: 1`), and anything holding `session.modelRuntime` or an extension's
 * `ctx.modelRegistry` (Pi builds that registry on the session's runtime). A `streamSimple` call is a summary only in Pi's own summary
 * shape: Pi's summarization system prompt ({@link summarySystemPrompt}), `cacheRetention: "none"` (Pi's `completeSummarization`),
 * no `onPayload` and no explicit `maxTokens`. Only such a call gets an `onPayload` that applies {@link decideOutputCap} with the
 * session's settings and the model of that request (the provider's callback model, the routed one when Pi routes a virtual model;
 * else the requested one). Every other call (agent-loop turns, extension and direct requests, Pi's bug-report summary with its own
 * prompt and `maxTokens`), and every other method, is the runtime itself (bound to it). Nothing global changes: other sessions on
 * the same runtime and the runtime itself are untouched. Pi gets this view as the session's `modelRuntime`, so its stream function
 * stays the one it marked as resolving auth through that runtime (summaries are not pre-authenticated, as before), and no other
 * extension hook is replayed for summaries.
 * Every summary request also gets orche's summary budget ({@link budgetedSummary}, summary-budget.ts): an instruction appended to
 * Pi's prompt, and one immediate re-send with a halved budget when the answer stops at the output limit. `restoredLabel` names the
 * essentials heading a task session restores verbatim after each compaction (undefined: none).
 */
export async function withSummaryOutputCap(runtime: ModelRuntime, getSession: () => object | undefined, options: { restoredLabel?: () => string | undefined } = {}): Promise<ModelRuntime> {
  const summaryPrompt = await summarySystemPrompt();
  const isSummary = (context: Context, options: Parameters<ModelRuntime["streamSimple"]>[2]) =>
    summaryPrompt !== undefined && options?.cacheRetention === "none" && !options.onPayload && options.maxTokens === undefined
    && systemPromptOf(context) === summaryPrompt;
  const streamSimple: ModelRuntime["streamSimple"] = (model, context, requestOptions) => {
    const session = getSession();
    if (!session || !isSummary(context, requestOptions)) return runtime.streamSimple(model, context, requestOptions);
    // The summary budget (summary-budget.ts) adds its instruction and re-sends a cut-off answer once; every attempt gets the cap.
    const restoredLabel = options.restoredLabel?.();
    return budgetedSummary(session, model, context, budgeted => runtime.streamSimple(model, budgeted, {
      ...requestOptions,
      onPayload: (payload, payloadModel) => applyOutputCap(session, (payloadModel ?? model) as CapModel, payload, true),
    }), { ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}), ...(restoredLabel ? { restoredLabel } : {}), cap: () => states.get(session)?.lastSummary?.cap });
  };
  return new Proxy(runtime, {
    get(target, key) {
      const value = key === "streamSimple" ? streamSimple : Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
