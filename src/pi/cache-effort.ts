/**
 * Fail-closed effort policy for transports that cannot keep a cached prefix while changing top-level effort.
 *
 * Pi and the CLIProxyAPI Pi provider already implement the proper protocol when
 * model.compat.supportsMidConvoEffort is advertised. Do NOT inject another
 * configuration_update: that would duplicate/reorder provider-owned history.
 *
 * For a Responses->Claude route, CPA currently has no lossless mapping to the
 * Anthropic Messages API's effort-only system messages. A model lacking the
 * capability must keep its first sent effort for its existing session; creating
 * fake effort markers would only claim to change effort while losing cache.
 *
 * This protects eligibility, NOT a cache-hit guarantee (TTL, prefix content,
 * breakpoints, routing, credentials, and upstream evictions remain external).
 */
import type { EffortModel } from "./effort-mapping.js";

export interface CacheEffortModel extends EffortModel {
  /** Pi uses a discriminated union of API compat schemas, not all of which
   * declare this optional capability. Treat it as unknown until checked. */
  compat?: unknown;
}

type Lock = { model: string; effort: string };
const locks = new WeakMap<object, Lock>();
/** Native Anthropic effort-only markers are legal only on genuine user turns.
 * Keep the previous marker during tool-result-only turns and apply a requested
 * level on the next new user message. */
interface ClaudeTurn { model: string; effort: string; userTurns: number }
const claudeTurns = new WeakMap<object, ClaudeTurn>();
const nativeClaude = (model: CacheEffortModel | undefined) =>
  model?.api === "anthropic-messages" && supportsCachePreservingEffort(model);


const modelKey = (model: CacheEffortModel | undefined) =>
  model ? [model.provider ?? "", model.id ?? "", model.api ?? ""].join("/") : "";

export function supportsCachePreservingEffort(model: CacheEffortModel | undefined): boolean {
  const compat = model?.compat;
  if (!model || !compat || typeof compat !== "object" ||
      !("supportsMidConvoEffort" in compat) || compat.supportsMidConvoEffort !== true) return false;
  const id = (model.id ?? "").toLowerCase();
  // CPA advertises this flag from its /v1/models catalog only when the
  // upstream supports configuration_update; its Codex adapter owns the wire.
  if (model.api === "cliproxyapi-codex-responses") return /^gpt-6(?:\.\d+)?-(?:astra|sol|luna|terra)(?:$|-)/.test(id);
  if (model.api === "openai-responses") return /^gpt-6(?:\.\d+)?-(?:astra|sol|luna|terra)(?:$|-)/.test(id);
  // Pi's Anthropic Messages adapter injects and replays per-message effort
  // markers and supplies the beta header; the Codex adapter does not.
  if (model.api === "anthropic-messages") return /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:5(?:[-.]|$))/.test(id);
  return false;
}

/** Limit the lock to provider paths where an effort change can invalidate a prompt cache.
 * Gemini and local backends must retain their normal thinking controls. */
export function needsCacheEffortProtection(model: CacheEffortModel | undefined): boolean {
  return !!model && [
    "cliproxyapi-codex-responses", "openai-responses",
    "openai-codex-responses", "azure-openai-responses", "anthropic-messages",
  ].includes(model.api ?? "");
}

export function observeEffortRequest(session: object, model: CacheEffortModel | undefined, sentEffort: string | undefined): void {
  if (!model || !sentEffort) return;
  const key = modelKey(model);
  const previous = locks.get(session);
  if (previous && previous.model !== key) locks.delete(session); // model switch: new cache namespace
  if (supportsCachePreservingEffort(model) || !needsCacheEffortProtection(model)) {
    locks.delete(session); // the provider owns effort history, or caching is out of scope
    if (nativeClaude(model)) {
      const saved = claudeTurns.get(session);
      if (!saved || saved.model !== key) claudeTurns.set(session, { model: key, effort: sentEffort, userTurns: 0 });
    } else claudeTurns.delete(session);
    return;
  }
  claudeTurns.delete(session);
  if (!locks.has(session)) locks.set(session, { model: key, effort: sentEffort });
}

export function guardedThinkingLevel(session: object, model: CacheEffortModel | undefined, requested: string, reason?: string): string {
  const native = claudeTurns.get(session);
  if (native && native.model === modelKey(model)) {
    // Switching between disabled and adaptive thinking changes a top-level
    // cache key, so never do it in an existing conversation.
    if (requested !== native.effort && (requested === "off" || native.effort === "off")) return native.effort;
    // Anthropic per-message effort markers can follow tool results, but do
    // NOT affect that tool-only response. Pi would otherwise record the lower
    // requested level as the response's actual level and later replay a wrong
    // historical marker. A new assignment supplies an actual user input and
    // is the safe boundary for an effective effort change.
    if (reason !== "assignment start") return native.effort;
  }
  const lock = locks.get(session);
  if (!lock || lock.model !== modelKey(model)) return requested;
  return lock.effort;
}

export function lockedEffort(session: object, model: CacheEffortModel | undefined, requested?: string): string | undefined {
  const native = claudeTurns.get(session);
  if (native?.model === modelKey(model) && requested !== undefined &&
      requested !== native.effort && (requested === "off" || native.effort === "off")) return native.effort;
  const lock = locks.get(session);
  return lock?.model === modelKey(model) ? lock.effort : undefined;
}


/** True only for an ordinary user message carrying actual user content, not tool_result-only output. */
function realUserMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const msg = value as { role?: unknown; content?: unknown };
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return msg.content.length > 0;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(part => !part || typeof part !== "object" || (part as { type?: unknown }).type !== "tool_result");
}

/**
 * Preserve the cached Anthropic prefix through tool-result-only turns.
 * Pi emits per-message effort markers when compat.supportsMidConvoEffort is
 * true, but the Anthropic beta permits a NEW marker only after a real user
 * input. After a tool result, replace the trailing marker's value with the
 * last actually sent effort (do not rewrite old messages). The requested
 * effort can take effect at the next genuine user turn.
 *
 * Returns an adjusted payload, or undefined when no change is needed.
 * The provider owns both the beta header and the historic effort markers.
 */
export function preserveAnthropicToolLoopEffort(
  session: object, model: CacheEffortModel | undefined, payload: unknown,
): unknown {
  if (!nativeClaude(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as { messages?: unknown };
  if (!Array.isArray(body.messages) || !body.messages.length) return undefined;
  const count = body.messages.filter(realUserMessage).length;
  const tail = body.messages.at(-1);
  if (!tail || typeof tail !== "object") return undefined;
  const last = tail as { role?: unknown; output_config?: unknown };
  if (last.role !== "system" || !last.output_config || typeof last.output_config !== "object") return undefined;
  const config = last.output_config as { effort?: unknown };
  const requested = config.effort;
  if (typeof requested !== "string" || !requested) return undefined;
  const key = modelKey(model);
  const state = claudeTurns.get(session);
  if (!state || state.model !== key || count < state.userTurns) {
    claudeTurns.set(session, { model: key, effort: requested, userTurns: count });
    return undefined;
  }
  if (requested === state.effort || count > state.userTurns) {
    state.effort = requested;
    state.userTurns = count;
    return undefined;
  }
  return {
    ...body,
    messages: [
      ...body.messages.slice(0, -1),
      { ...last, output_config: { ...config, effort: state.effort } },
    ],
  };
}
