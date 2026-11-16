/**
 * Claude-native Messages transport for workers whose selected model is a
 * CLIProxyAPI Claude model. GPT and other models keep the existing Codex/Responses
 * provider unchanged.
 *
 * The alias is worker-runtime-local. It borrows the registered Anthropic API
 * implementation and resolves the EXISTING CLIProxyAPI credentials at request
 * time; no credentials are copied to files, exposed in logs, or registered in
 * the main Pi session. It is intentionally not a fork of CLIProxyAPI.
 *
 * Only explicitly known per-message-effort models are eligible. A model without
 * those semantics continues through the original provider with its cache
 * protection intact. Native transport does not guarantee an upstream cache hit.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

export const CPA_PROVIDER_ID = "cliproxyapi";
export const CLAUDE_NATIVE_PROVIDER_ID = "cliproxyapi-claude-native";
const CPA_CODEX_API = "cliproxyapi-codex-responses";

/** Anthropic per-message effort supported models (2026-11-16). Full model
 * ids only, except the catalog's optional [1m] context window suffix. */
export function supportsClaudeNativeEffort(id: string): boolean {
  const normalized = id.toLowerCase();
  return /^claude-(?:opus-5(?:[-.]5)?|sonnet-5[-.]5|haiku-5[-.]5|fable-5[-.][12]|mythos-5[-.][12])(?:\[1m\])?$/.test(normalized);
}

/** CLIProxyAPI Pi provider serves Codex on /backend-api; the Claude Messages
 * API lives on /v1/messages at the same root. Respect reverse-proxy prefixes.
 * Refuse other endpoint shapes rather than sending an API key to a guessed URL. */
export function nativeMessagesBaseUrl(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const url = new URL(sourceUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/backend-api")) return undefined;
    url.pathname = path.slice(0, -"/backend-api".length) || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Build the same upstream model and costs with the native wire protocol.
 * Do not transplant OpenAI compatibility flags into Anthropic's adapter. */
export function claudeNativeModel(source: Model<Api>): Model<"anthropic-messages"> | undefined {
  if (source.provider !== CPA_PROVIDER_ID || source.api !== CPA_CODEX_API ||
      !supportsClaudeNativeEffort(source.id) || !source.reasoning) return undefined;
  const baseUrl = nativeMessagesBaseUrl(source.baseUrl);
  if (!baseUrl) return undefined;
  const { compat: _compat, ...rest } = source;
  return {
    ...rest,
    provider: CLAUDE_NATIVE_PROVIDER_ID,
    api: "anthropic-messages",
    baseUrl,
    compat: {
      supportsMidConvoEffort: true,
      forceAdaptiveThinking: true,
    },
  } as Model<"anthropic-messages">;
}

/** Register an alias in the worker's isolated model runtime only. Provider
 * callbacks delegate to Pi's own Anthropic implementation. The source auth is
 * looked up on EVERY request, preserving login/refresh and request-time policy.
 * There is no additional credential store and no direct Anthropic API key. */
export function registerClaudeNativeProvider(runtime: ModelRuntime): boolean {
  if (runtime.getProvider(CLAUDE_NATIVE_PROVIDER_ID)) return true;
  const anthropic = runtime.getProvider("anthropic");
  if (!anthropic || !runtime.getProvider(CPA_PROVIDER_ID)) return false;
  const models = () => runtime.getModels(CPA_PROVIDER_ID)
    .map(model => claudeNativeModel(model))
    .filter((model): model is Model<"anthropic-messages"> => model !== undefined);
  if (!models().length) return false;

  const provider: Provider<"anthropic-messages"> = {
    id: CLAUDE_NATIVE_PROVIDER_ID,
    name: "Claude via CLIProxyAPI (Messages)",
    auth: {
      apiKey: {
        name: "Existing CLIProxyAPI login",
        resolve: async ({ signal }) => {
          // The source may be inherited from the host Pi session; resolve it
          // through the supplied runtime view, not through auth.json directly.
          const existing = await runtime.getAuth(CPA_PROVIDER_ID, { signal });
          const apiKey = existing?.auth.apiKey;
          if (!apiKey) return undefined;
          return { auth: { apiKey }, source: "Existing CLIProxyAPI login" };
        },
      },
    },
    getModels: models,
    stream: (model, context, options) => anthropic.stream(model, context, options),
    streamSimple: (model, context, options) => anthropic.streamSimple(model, context, options),
  };
  runtime.registerNativeProvider(provider);
  return true;
}

/** Resolve only real provider aliases already registered in this runtime.
 * No silent route switch when CPA / native Messages is unavailable. */
export function nativeClaudeRouteModel(runtime: ModelRuntime, model: Model<Api>, enabled = true): Model<Api> {
  return enabled && model.provider === CPA_PROVIDER_ID && model.api === CPA_CODEX_API
    ? runtime.getModel(CLAUDE_NATIVE_PROVIDER_ID, model.id) ?? model
    : model;
}
