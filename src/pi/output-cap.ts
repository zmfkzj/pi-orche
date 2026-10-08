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
 * Sending the field is not the same as the model producing more than 32000 tokens: that the upstream API accepts and honours a larger
 * value is a property of the proxy and the provider, observed only as far as docs/length-recovery.md says.
 */
import { isCliproxyClaude, modelMatches, type EffortModel } from "./effort-mapping.js";

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

/** Pi `before_provider_request` handler for one orche session: returns the payload with the budget, or undefined to leave it. */
export function outputCapHandler(getSession: () => { model?: CapModel } | undefined) {
  return (event: { payload: unknown }): unknown => {
    const session = getSession();
    if (!session || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
    let state = states.get(session);
    if (!state) states.set(session, state = { settings: { ...DEFAULT_OUTPUT_CAP } });
    const payload = event.payload as Record<string, unknown>;
    let model: CapModel | undefined;
    try { model = session.model; } catch { model = undefined; }
    const decision = decideOutputCap(model, payload, state.settings);
    const changed = !state.last || state.last.cap !== decision.cap || state.last.source !== decision.source || state.last.model !== decision.model;
    state.last = decision;
    if (changed) { try { state.onDecision?.(decision); } catch { /* observers cannot change the request */ } }
    if (decision.cap === undefined || decision.source === "payload") return undefined;
    return { ...payload, max_output_tokens: decision.cap };
  };
}
