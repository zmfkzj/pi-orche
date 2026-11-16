import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { registerClaudeNativeProvider, CLAUDE_NATIVE_PROVIDER_ID } from "../../src/pi/claude-native.js";
import { fauxRuntime } from "../helpers/faux.js";

const sessions: Array<{ dispose(): void }> = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});
const sse = (obj: Record<string, unknown>) => "event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n";

describe("native Claude HTTP wire (local CPA stand-in, no external credentials)", () => {
  it("sends CPA authentication, beta header and cache-safe effort messages", async () => {
    const observed: Array<{ path: string; beta: string; key: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      let input = "";
      for await (const chunk of req) input += chunk.toString();
      observed.push({
        path: req.url ?? "",
        beta: String(req.headers["anthropic-beta"] ?? ""),
        key: String(req.headers["x-api-key"] ?? ""),
        body: JSON.parse(input) as Record<string, unknown>,
      });
      const n = observed.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        sse({ type: "message_start", message: {
          id: "msg_local_" + n, type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }}),
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        sse({ type: "content_block_stop", index: 0 }),
        sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        sse({ type: "message_stop" }),
      ].join(""));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No loopback port");
    const root = "http://127.0.0.1:" + address.port;
    const { runtime, faux } = await fauxRuntime();
    const source: Model<Api> = {
      ...faux.getModel(), provider: "cliproxyapi", id: "claude-opus-5-5", api: "cliproxyapi-codex-responses" as Api,
      baseUrl: root + "/backend-api/", reasoning: true, contextWindow: 200000, maxTokens: 4096,
      thinkingLevelMap: { low: "low", high: "high", off: null },
    } as Model<Api>;
    const cpa: Provider<Api> = {
      id: "cliproxyapi", name: "local CPA",
      auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "local-test-token" }, source: "test" }) } },
      getModels: () => [source],
      stream: (model, context, options) => faux.provider.stream(model, context, options),
      streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
    };
    runtime.registerNativeProvider(cpa);
    expect(registerClaudeNativeProvider(runtime)).toBe(true);
    const session = await createSession({
      cwd: process.cwd(), modelRuntime: runtime, route: { role: "test", model: "cliproxyapi/claude-opus-5-5", thinking: "high" },
      instructions: "local wire-only test", tools: [],
    });
    sessions.push(session);
    expect(session.model?.provider).toBe(CLAUDE_NATIVE_PROVIDER_ID);
    await session.prompt("first");
    session.setThinkingLevel("low");
    await session.prompt("second");
    expect(observed).toHaveLength(2);
    expect(observed.every(x => x.path.startsWith("/v1/messages"))).toBe(true);
    expect(observed.every(x => x.key === "local-test-token")).toBe(true);
    expect(observed.every(x => x.beta.includes("mid-conversation-output-config-2026-07-01"))).toBe(true);
    expect(observed.map(x => (x.body.output_config as { effort: string }).effort)).toEqual(["low", "low"]);
    const last = observed.map(x => {
      const messages = x.body.messages as Array<{ role: string; output_config?: { effort?: string } }>;
      return messages.filter(item => item.role === "system" && item.output_config).at(-1)?.output_config?.effort;
    });
    expect(last).toEqual(["high", "low"]);
  }, 20000);
});
