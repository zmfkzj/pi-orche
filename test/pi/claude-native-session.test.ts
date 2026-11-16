import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { CLAUDE_NATIVE_PROVIDER_ID, registerClaudeNativeProvider } from "../../src/pi/claude-native.js";
import { fauxRuntime } from "../helpers/faux.js";

const sessions: Array<{ dispose(): void }> = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

describe("actual Pi worker session chooses native Claude without disturbing original CPA", () => {
  it("auto-routes a supported CPA Claude session, respects opt-out and leaves GPT unchanged", async () => {
    const { runtime, faux } = await fauxRuntime();
    const source: Model<Api> = {
      ...faux.getModel(), provider: "cliproxyapi", id: "claude-opus-5-5",
      api: "cliproxyapi-codex-responses" as Api,
      baseUrl: "http://127.0.0.1:8317/backend-api/", reasoning: true,
      contextWindow: 200000, maxTokens: 32000,
      thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    } as Model<Api>;
    const gpt = { ...source, id: "gpt-6.1-sol" };
    const original = faux.provider;
    const cpa: Provider<Api> = {
      id: "cliproxyapi", name: "CLIProxyAPI test",
      auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "ephemeral-in-memory-only" }, source: "test" }) } },
      getModels: () => [source, gpt],
      stream: (model, context, options) => original.stream(model, context, options),
      streamSimple: (model, context, options) => original.streamSimple(model, context, options),
    };
    runtime.registerNativeProvider(cpa);
    expect(registerClaudeNativeProvider(runtime)).toBe(true);
    const create = async (modelId: string, claudeNative = true) => {
      const session = await createSession({
        cwd: process.cwd(), modelRuntime: runtime, instructions: "test", tools: [],
        route: { role: "test", model: "cliproxyapi/" + modelId, thinking: "high" },
        claudeNative,
      });
      sessions.push(session);
      return session;
    };
    const native = await create("claude-opus-5-5");
    expect(native.model).toMatchObject({ provider: CLAUDE_NATIVE_PROVIDER_ID, api: "anthropic-messages", id: "claude-opus-5-5" });
    const disabled = await create("claude-opus-5-5", false);
    expect(disabled.model).toMatchObject({ provider: "cliproxyapi", api: "cliproxyapi-codex-responses" });
    const unchangedGPT = await create("gpt-6.1-sol");
    expect(unchangedGPT.model).toMatchObject({ provider: "cliproxyapi", api: "cliproxyapi-codex-responses", id: "gpt-6.1-sol" });
  });
});
