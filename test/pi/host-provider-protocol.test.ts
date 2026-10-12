import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { InheritedProviders } from "../../src/pi/inherit-providers.js";
import { createSession } from "../../src/pi/session-factory.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const event = (value: unknown, name?: string) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
const cases = [
  {
    provider: "openai", api: "openai-completions", path: "/v1/chat/completions",
    response: event({ id: "test", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] }) +
      event({ id: "test", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + "data: [DONE]\n\n",
  },
  {
    provider: "anthropic", api: "anthropic-messages", path: "/v1/messages",
    response: event({ type: "message_start", message: { id: "test", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }, "message_start") +
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }, "content_block_delta") +
      event({ type: "content_block_stop", index: 0 }, "content_block_stop") +
      event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, "message_delta") +
      event({ type: "message_stop" }, "message_stop"),
  },
  {
    provider: "google", api: "google-generative-ai", path: "streamGenerateContent",
    response: event({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }),
  },
];

describe("Pi builtin transports in worker sessions", () => {
  it.each(cases)("streams $provider via the host runtime with custom endpoints and per-request hooks", async fixture => {
    const root = await mkdtemp(join(tmpdir(), "orche-protocol-"));
    roots.push(root);
    const requests: { url: string; headers: Record<string, unknown> }[] = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url!, headers: request.headers });
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(fixture.response);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test address");
    const modelsPath = join(root, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { [fixture.provider]: {
      baseUrl: `http://127.0.0.1:${address.port}${fixture.provider === "openai" ? "/v1" : ""}`,
      api: fixture.api, apiKey: "test-only", headers: { "X-Provider-Test": "provider" },
      models: [{ id: "test-model", contextWindow: 32000, maxTokens: 256, headers: { "X-Model-Test": "model" } }],
    } } }));
    const host = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath });
    // A different worker config must not retarget inherited credentials to another endpoint.
    const workerModels = join(root, "worker-models.json");
    await writeFile(workerModels, JSON.stringify({ providers: { [fixture.provider]: {
      baseUrl: "http://127.0.0.1:1", api: fixture.api, apiKey: "wrong-worker-key",
      models: [{ id: "test-model", headers: { "X-Worker-Only": "not-sent" } }],
    } } }));
    const child = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: workerModels, refreshOnCreate: false });
    const registry = new ModelRegistry(host);
    const runtime = new InheritedProviders().sync(child, registry);
    const session = await createSession({ cwd: root, modelRuntime: runtime, route: { role: "test", model: `${fixture.provider}/test-model` }, instructions: "Answer briefly.", tools: [] });
    try {
      await session.prompt("Say hello");
      expect(session.getLastAssistantText()).toBe("hello");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain(fixture.path);
      expect(requests[0]!.headers["x-provider-test"]).toBe("provider");
      expect(requests[0]!.headers["x-model-test"]).toBe("model");
      expect(requests[0]!.headers["x-worker-only"]).toBeUndefined();
      // Worker request hooks, cancellation and header deletion reach Pi unchanged and run once.
      let payloads = 0;
      let transforms = 0;
      const model = runtime.getModel(fixture.provider, "test-model")!;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
        onPayload: payload => { payloads++; return payload; },
        transformHeaders: headers => { transforms++; const result: Record<string, string> = { ...headers, "X-Worker-Test": "worker" }; delete result["X-Model-Test"]; return result; },
      });
      expect(result.stopReason).toBe("stop");
      expect(payloads).toBe(1);
      expect(transforms).toBe(1);
      expect(requests[1]!.headers["x-worker-test"]).toBe("worker");
      expect(requests[1]!.headers["x-model-test"]).toBeUndefined();
      const abort = new AbortController();
      abort.abort();
      await runtime.completeSimple(model, { messages: [] }, { signal: abort.signal });
      expect(requests).toHaveLength(2);
    } finally { session.dispose(); }
  });
});
