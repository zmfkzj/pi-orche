import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  CLAUDE_NATIVE_PROVIDER_ID,
  claudeNativeModel,
  nativeClaudeRouteModel,
  nativeMessagesBaseUrl,
  registerClaudeNativeProvider,
  supportsClaudeNativeEffort,
} from "../../src/pi/claude-native.js";

const sourceModel: Model<Api> = {
  provider: "cliproxyapi", id: "claude-opus-5-5", name: "Claude Opus 5.5",
  api: "cliproxyapi-codex-responses" as Api, baseUrl: "http://127.0.0.1:8317/backend-api/",
  reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 },
  thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
} as Model<Api>;

function harness(available: Model<Api>[] = [sourceModel]) {
  const providers = new Map<string, Provider<Api>>();
  const source = { id: "cliproxyapi", name: "CLIProxyAPI" } as Provider<Api>;
  const originalStream = vi.fn((model: unknown) => ({ model }));
  const originalSimple = vi.fn((model: unknown) => ({ model }));
  const anthropic = {
    id: "anthropic", name: "Anthropic",
    stream: originalStream,
    streamSimple: originalSimple,
  } as unknown as Provider<Api>;
  providers.set("cliproxyapi", source);
  providers.set("anthropic", anthropic);
  let key: string | undefined = "first";
  const auth = vi.fn(async (_id: string) => key ? { auth: { apiKey: key }, source: "stored" } : undefined);
  const runtime = {
    getProvider: (id: string) => providers.get(id),
    getModels: (id: string) => id === "cliproxyapi" ? available : providers.get(id)?.getModels() ?? [],
    getModel: (id: string, modelId: string) => (id === "cliproxyapi" ? available : providers.get(id)?.getModels() ?? []).find(m => m.id === modelId),
    getAuth: auth,
    registerNativeProvider: (provider: Provider<Api>) => providers.set(provider.id, provider),
  } as unknown as ModelRuntime;
  return { runtime, providers, auth, setKey: (value: string | undefined) => { key = value; }, originalStream, originalSimple };
}

describe("CLIProxyAPI Claude native Messages transport", () => {
  it("selects known compatible models and rejects unsupported/future models", () => {
    for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5",
                      "claude-fable-5-2", "claude-fable-5-1", "claude-mythos-5-2", "claude-mythos-5-1",
                      "claude-opus-5-5[1m]"]) expect(supportsClaudeNativeEffort(id), id).toBe(true);
    for (const id of ["gpt-6.1-sol", "claude-sonnet-5", "claude-opus-4-6", "claude-opus-5-4",
                      "claude-fable-5", "claude-unknown-5-5", "my-claude-opus-5-5"]) expect(supportsClaudeNativeEffort(id), id).toBe(false);
  });

  it("maps only /backend-api to /v1/messages base, preserving reverse-proxy paths", () => {
    expect(nativeMessagesBaseUrl("http://127.0.0.1:8317/backend-api/")).toBe("http://127.0.0.1:8317");
    expect(nativeMessagesBaseUrl("https://gateway.example.com/team/backend-api")).toBe("https://gateway.example.com/team");
    for (const url of ["https://api.anthropic.com", "https://gateway.example.com/v1",
                       "http://name:password@localhost:8317/backend-api", "not a url",
                       "https://host.example/backend-api?secret=1"]) expect(nativeMessagesBaseUrl(url)).toBeUndefined();
  });

  it("retains model, tokens, pricing and thinking levels while replacing only transport metadata", () => {
    const native = claudeNativeModel(sourceModel)!;
    expect(native).toMatchObject({
      id: sourceModel.id, name: sourceModel.name, provider: CLAUDE_NATIVE_PROVIDER_ID,
      api: "anthropic-messages", baseUrl: "http://127.0.0.1:8317",
      contextWindow: sourceModel.contextWindow, maxTokens: sourceModel.maxTokens,
      cost: sourceModel.cost, thinkingLevelMap: sourceModel.thinkingLevelMap,
      compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
    });
    expect(claudeNativeModel({ ...sourceModel, id: "gpt-6.1-sol" })).toBeUndefined();
    expect(claudeNativeModel({ ...sourceModel, reasoning: false })).toBeUndefined();
    expect(claudeNativeModel({ ...sourceModel, baseUrl: "https://api.anthropic.com" })).toBeUndefined();
  });

  it("registers a worker-only native provider; GPT stays on the original CPA provider", async () => {
    const gpt = { ...sourceModel, id: "gpt-6.1-sol" };
    const h = harness([sourceModel, gpt]);
    expect(registerClaudeNativeProvider(h.runtime)).toBe(true);
    expect(registerClaudeNativeProvider(h.runtime)).toBe(true); // idempotent
    expect(h.providers.size).toBe(3);
    expect(nativeClaudeRouteModel(h.runtime, sourceModel)).toMatchObject({ provider: CLAUDE_NATIVE_PROVIDER_ID, api: "anthropic-messages" });
    expect(nativeClaudeRouteModel(h.runtime, sourceModel, false)).toBe(sourceModel);
    expect(nativeClaudeRouteModel(h.runtime, gpt)).toBe(gpt);
    const provider = h.providers.get(CLAUDE_NATIVE_PROVIDER_ID)!;
    expect(provider.getModels().map(m => m.id)).toEqual(["claude-opus-5-5"]);
    const native = provider.getModels()[0]!;
    provider.stream(native, { messages: [] } as never, {} as never);
    provider.streamSimple(native, { messages: [] } as never, {} as never);
    expect(h.originalStream).toHaveBeenCalledOnce();
    expect(h.originalSimple).toHaveBeenCalledOnce();
    expect(h.originalStream.mock.calls[0]![0]).toMatchObject({ api: "anthropic-messages" });
    expect(h.providers.get("cliproxyapi")).toBeDefined();
  });

  it("uses the existing CPA login on every request and never persists a token", async () => {
    const h = harness();
    registerClaudeNativeProvider(h.runtime);
    const provider = h.providers.get(CLAUDE_NATIVE_PROVIDER_ID)!;
    const resolver = provider.auth.apiKey!.resolve;
    const ctx = { env: async () => undefined, fileExists: async () => false };
    const signal = new AbortController().signal;
    expect((await resolver({ ctx, signal }))?.auth.apiKey).toBe("first");
    h.setKey("rotated");
    expect((await resolver({ ctx, signal }))?.auth.apiKey).toBe("rotated");
    h.setKey(undefined);
    expect(await resolver({ ctx, signal })).toBeUndefined();
    expect(h.auth).toHaveBeenCalledTimes(3);
  });

  it("stays untouched without a compatible Claude model or Anthropic provider", () => {
    const h = harness([{ ...sourceModel, id: "gpt-6.1-sol" }]);
    expect(registerClaudeNativeProvider(h.runtime)).toBe(false);
    expect(h.providers.has(CLAUDE_NATIVE_PROVIDER_ID)).toBe(false);
    const h2 = harness();
    h2.providers.delete("anthropic");
    expect(registerClaudeNativeProvider(h2.runtime)).toBe(false);
  });
});
