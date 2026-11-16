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
  compat?: { supportsMidConvoEffort?: boolean };
}

type Lock = { model: string; effort: string };
const locks = new WeakMap<object, Lock>();

const modelKey = (model: CacheEffortModel | undefined) =>
  model ? [model.provider ?? "", model.id ?? "", model.api ?? ""].join("/") : "";

export function supportsCachePreservingEffort(model: CacheEffortModel | undefined): boolean {
  if (!model || model.compat?.supportsMidConvoEffort !== true) return false;
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

export function observeEffortRequest(session: object, model: CacheEffortModel | undefined, sentEffort: string | undefined): void {
  if (!model || !sentEffort) return;
  const key = modelKey(model);
  const previous = locks.get(session);
  if (previous && previous.model !== key) locks.delete(session); // model switch: new cache namespace
  if (supportsCachePreservingEffort(model)) {
    locks.delete(session); // the provider, not orche, owns the effort history
    return;
  }
  if (!locks.has(session)) locks.set(session, { model: key, effort: sentEffort });
}

export function guardedThinkingLevel(session: object, model: CacheEffortModel | undefined, requested: string): string {
  const lock = locks.get(session);
  if (!lock || lock.model !== modelKey(model)) return requested;
  return lock.effort;
}

export function lockedEffort(session: object, model: CacheEffortModel | undefined): string | undefined {
  const lock = locks.get(session);
  return lock?.model === modelKey(model) ? lock.effort : undefined;
}
