import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, type AgentSession, type AgentSessionEvent, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { InheritedProviders } from "../../src/pi/inherit-providers.js";
import { createSession } from "../../src/pi/session-factory.js";

const roots: string[] = [];
const servers: Server[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { await session.abort(); session.dispose(); }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const event = (value: unknown, name?: string) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
const wire = (frames: Record<string, unknown>[], named = false) => ({
  body: frames.map(frame => event(frame, named ? String(frame.type) : undefined)).join(""), events: frames.length,
});
const completions = (args?: string) => wire([
  { id: "test", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: args === undefined ? { role: "assistant", content: "hello" } : { role: "assistant", tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "echo", arguments: args } }] }, finish_reason: null }] },
  { id: "test", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: args === undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
]);
const anthropic = (args?: string) => wire([
  { type: "message_start", message: { id: "test", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: args === undefined ? { type: "text", text: "" } : { type: "tool_use", id: "call_test", name: "echo", input: {} } },
  { type: "content_block_delta", index: 0, delta: args === undefined ? { type: "text_delta", text: "hello" } : { type: "input_json_delta", partial_json: args } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: args === undefined ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
], true);
const responses = (args?: string) => {
  const item = args === undefined
    ? { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }
    : { type: "function_call", id: "fc_test", call_id: "call_test", name: "echo", arguments: args, status: "completed" };
  return wire([
    { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: args === undefined ? { ...item, content: [] } : { ...item, arguments: "" } },
    ...(args === undefined ? [
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
    ] : [{ type: "response.function_call_arguments.delta", output_index: 0, delta: args }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
  ], true);
};
const google = (args?: string) => wire([
  { candidates: [{ content: { role: "model", parts: args === undefined ? [{ text: "hello" }] : [{ functionCall: { id: "call_test", name: "echo", args: JSON.parse(args) } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } },
]);
const cases = [
  { provider: "openai", api: "openai-completions", path: "/v1/chat/completions", response: completions, resultField: "tool_call_id" },
  { provider: "openai", api: "openai-responses", path: "/v1/responses", response: responses, resultField: "function_call_output" },
  { provider: "anthropic", api: "anthropic-messages", path: "/v1/messages", response: anthropic, resultField: "tool_result" },
  { provider: "google", api: "google-generative-ai", path: "streamGenerateContent", response: google, resultField: "functionResponse" },
] satisfies { provider: string; api: Api; path: string; response: (args?: string) => { body: string; events: number }; resultField: string }[];
type Fixture = (typeof cases)[number];
type Response = { body: string; status?: number; hold?: boolean };

/** Real Pi SDK + builtin HTTP/SSE adapters. Only an ephemeral loopback server receives requests. */
async function setup(fixture: Fixture, script: Response[], extensions: ExtensionFactory[] = []) {
  const root = await mkdtemp(join(tmpdir(), "orche-protocol-"));
  roots.push(root);
  const requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url!, headers: request.headers, body: JSON.parse(body) });
    const next = script[requests.length - 1] ?? { status: 400, body: '{"error":{"message":"Unexpected test request"}}' };
    response.writeHead(next.status ?? 200, { "Content-Type": next.status ? "application/json" : "text/event-stream", "X-Test-Response": String(requests.length) });
    if (next.hold) { response.flushHeaders(); response.write(next.body); }
    else response.end(next.body);
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
  const host = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, refreshOnCreate: false });
  // A different worker config must not retarget inherited credentials to another endpoint.
  const workerModels = join(root, "worker-models.json");
  await writeFile(workerModels, JSON.stringify({ providers: { [fixture.provider]: {
    baseUrl: "http://127.0.0.1:1", api: fixture.api, apiKey: "wrong-worker-key",
    models: [{ id: "test-model", headers: { "X-Worker-Only": "not-sent" } }],
  } } }));
  const child = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: workerModels, refreshOnCreate: false });
  const runtime = new InheritedProviders().sync(child, new ModelRegistry(host));
  const hooks = { context: 0, system: 0, payload: 0, headers: 0, modelHeaders: [] as unknown[], responses: [] as number[], raw: [] as unknown[] };
  const order: string[] = [];
  let executions = 0;
  let guards = 0;
  const session = await createSession({
    cwd: root, modelRuntime: runtime, route: { role: "test", model: `${fixture.provider}/test-model` }, instructions: "Answer briefly.", tools: ["echo"],
    customTools: [{ name: "echo", label: "echo", description: "Echo a value", parameters: Type.Object({ value: Type.String() }),
      async execute(_id, args) { executions++; return { content: [{ type: "text", text: `echo:${(args as { value: string }).value}` }], details: undefined }; } }],
    toolGuard: () => { guards++; return undefined; },
    extensionFactories: [pi => {
      pi.on("context", () => { hooks.context++; });
      pi.on("context_with_system", () => { hooks.system++; });
      pi.on("before_provider_request", event => {
        hooks.payload++; order.push("payload");
        const payload = event.payload as Record<string, unknown>;
        return fixture.provider === "google" ? { ...payload, config: { ...(payload.config as object), temperature: hooks.payload / 10 } } : { ...payload, test_marker: hooks.payload };
      });
      pi.on("before_provider_headers", event => {
        hooks.headers++; order.push("headers"); hooks.modelHeaders.push(event.headers["X-Model-Test"]);
        event.headers["X-Worker-Test"] = String(hooks.headers); event.headers["X-Model-Test"] = null;
      });
      pi.on("after_provider_response", event => { hooks.responses.push(event.status); order.push("response"); });
      pi.on("provider_stream_event", async event => { await Promise.resolve(); hooks.raw.push(event.data); order.push("raw"); });
    }, ...extensions],
  });
  sessions.push(session);
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => events.push(event));
  return { session, runtime, host, fixture, requests, hooks, order, events, responseHook: fixture.provider !== "google", executions: () => executions, guards: () => guards };
}
function assertHooks(h: Awaited<ReturnType<typeof setup>>, requests: number, raw: number, successful = requests) {
  expect(h.requests).toHaveLength(requests);
  expect(h.hooks).toMatchObject({ context: requests, system: requests, payload: requests, headers: requests });
  expect(h.hooks.modelHeaders).toEqual(Array(requests).fill("model"));
  // Pi 1.3's Google adapter has no onResponse; the other adapters invoke it only after successful HTTP setup.
  expect(h.hooks.responses).toEqual(h.responseHook ? Array(successful).fill(200) : []);
  expect(h.hooks.raw).toHaveLength(raw);
  for (const [index, request] of h.requests.entries()) {
    if (h.fixture.provider === "google") expect(request.body.generationConfig).toMatchObject({ temperature: (index + 1) / 10 });
    else expect(request.body.test_marker).toBe(index + 1);
    expect(request.headers["x-worker-test"]).toBe(String(index + 1));
    expect(request.headers["x-provider-test"]).toBe("provider");
    expect(request.headers["x-model-test"]).toBeUndefined();
    expect(request.headers["x-worker-only"]).toBeUndefined();
  }
}
const endings = (h: Awaited<ReturnType<typeof setup>>) => h.events.flatMap(event => event.type === "message_end" && event.message.role === "assistant" ? [event.message.stopReason] : []);
const settled = (h: Awaited<ReturnType<typeof setup>>) => h.events.filter(event => event.type === "agent_settled");

describe("Pi 1.3 builtin transports in inherited worker sessions (loopback, not live providers)", () => {
  it.each(cases)("$api preserves host auth/endpoint and exactly-once request hooks", async fixture => {
    const response = fixture.response();
    const h = await setup(fixture, [response, response]);
    await h.session.prompt("Say hello");
    expect(h.session.getLastAssistantText()).toBe("hello");
    assertHooks(h, 1, response.events);
    if (h.responseHook) {
      expect(h.order.indexOf("response")).toBeLessThan(h.order.indexOf("raw"));
      expect(h.order.indexOf("payload")).toBeLessThan(h.order.indexOf("response"));
      expect(h.order.indexOf("headers")).toBeLessThan(h.order.indexOf("response"));
    }
    expect(h.requests[0]!.url).toContain(fixture.path);
    const authHeader = fixture.provider === "anthropic" ? "x-api-key" : fixture.provider === "google" ? "x-goog-api-key" : "authorization";
    expect(h.requests[0]!.headers[authHeader]).toBe(fixture.provider === "openai" ? "Bearer test-only" : "test-only");
    expect(endings(h)).toEqual(["stop"]);
    expect(settled(h)).toHaveLength(1);
    // Also exercise direct runtime hooks; no AgentSession extension should be called a second time.
    const direct = { payload: 0, headers: 0, response: 0, raw: 0 };
    const modelHeaders: unknown[] = [];
    const result = await h.runtime.completeSimple(h.session.model!, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
      onPayload: payload => {
        direct.payload++;
        const body = payload as Record<string, unknown>;
        return fixture.provider === "google" ? { ...body, config: { ...(body.config as object), temperature: 0.75 } } : { ...body, direct_marker: true };
      },
      transformHeaders: headers => { direct.headers++; modelHeaders.push(headers["X-Model-Test"]); return { ...headers, "X-Model-Test": null, "X-Direct": "yes" }; },
      onResponse: () => { direct.response++; }, onProviderStreamEvent: async () => { direct.raw++; },
    });
    expect(result.stopReason).toBe("stop");
    expect(direct).toEqual({ payload: 1, headers: 1, response: h.responseHook ? 1 : 0, raw: response.events });
    expect(modelHeaders).toEqual(["model"]);
    expect(h.hooks.payload).toBe(1);
    if (fixture.provider === "google") expect(h.requests[1]!.body.generationConfig).toMatchObject({ temperature: 0.75 });
    else expect(h.requests[1]!.body.direct_marker).toBe(true);
    expect(h.requests[1]!.headers["x-model-test"]).toBeUndefined();
    expect(h.requests[1]!.headers["x-direct"]).toBe("yes");
  });

  it.each(cases)("$api completes a tool round-trip with one guard and execution", async fixture => {
    const call = fixture.response('{"value":"héllo"}');
    const final = fixture.response();
    const h = await setup(fixture, [call, final]);
    await h.session.prompt("Echo héllo then finish");
    assertHooks(h, 2, call.events + final.events);
    expect(h.executions()).toBe(1);
    expect(h.guards()).toBe(1);
    expect(endings(h)).toEqual(["toolUse", "stop"]);
    expect(settled(h)).toHaveLength(1);
    expect(JSON.stringify(h.requests[1]!.body)).toContain(fixture.resultField);
    expect(JSON.stringify(h.requests[1]!.body)).toContain("echo:héllo");
    expect(h.session.messages.filter(message => message.role === "toolResult")).toMatchObject([{ isError: false }]);
  });

  it.each(cases.filter(fixture => fixture.provider !== "google").flatMap(fixture =>
    ['{"value":"must-not-run"', '{"value":"must-not-run"}garbage', '[{"value":"must-not-run"}]'].map(args => ({ ...fixture, args })),
  ))("$api rejects malformed final tool JSON $args before any tool or guard executes", async fixture => {
    // Incomplete prefixes, trailing garbage and non-object JSON must not become executable calls.
    const call = fixture.response(fixture.args);
    const h = await setup(fixture, [call, fixture.response()]);
    await h.session.prompt("Try a malformed tool call");
    expect(h.executions()).toBe(0);
    expect(h.guards()).toBe(0);
    const results = h.session.messages.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toMatch(/JSON|arguments/i);
    expect(settled(h)).toHaveLength(1);
  });

  it.each(cases)("$api retries a transient HTTP error once and settles once", async fixture => {
    const response = fixture.response();
    const h = await setup(fixture, [{ status: 503, body: '{"error":{"message":"Service unavailable","type":"overloaded_error","code":503}}' }, response]);
    await h.session.prompt("Retry safely");
    assertHooks(h, 2, response.events, 1);
    expect(endings(h)).toEqual(["error", "stop"]);
    expect(h.events.filter(event => event.type === "auto_retry_start")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "auto_retry_end")).toHaveLength(1);
    expect(settled(h)).toHaveLength(1);
    expect(h.executions()).toBe(0);
  });

  it.each(cases)("$api stops after exhausting the single retry, with one final settle", async fixture => {
    const error = { status: 503, body: '{"error":{"message":"Service unavailable","type":"overloaded_error","code":503}}' };
    const h = await setup(fixture, [error, error]);
    await h.session.prompt("Fail within the retry budget");
    assertHooks(h, 2, 0, 0);
    expect(endings(h)).toEqual(["error", "error"]);
    expect(h.events.filter(event => event.type === "auto_retry_start")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "auto_retry_end")).toMatchObject([{ success: false }]);
    expect(settled(h)).toHaveLength(1);
    expect(h.executions()).toBe(0);
  });

  it.each(cases)("$api cancels during retry backoff without issuing the next request", async fixture => {
    const h = await setup(fixture, [{ status: 503, body: '{"error":{"message":"Service unavailable","type":"overloaded_error","code":503}}' }]);
    const retry = Promise.withResolvers<void>();
    h.session.subscribe(event => { if (event.type === "auto_retry_start") retry.resolve(); });
    const prompt = h.session.prompt("Cancel the retry");
    await retry.promise;
    await h.session.abort();
    await prompt;
    assertHooks(h, 1, 0, 0);
    expect(endings(h)).toEqual(["error"]);
    expect(h.events.filter(event => event.type === "auto_retry_end")).toHaveLength(1);
    expect(settled(h)).toHaveLength(1);
    expect(h.executions()).toBe(0);
  });

  it.each(cases)("$api cancels an in-flight stream without retry or duplicate terminal messages", async fixture => {
    const received = Promise.withResolvers<void>();
    const opening = fixture.response().body.split("\n\n")[0]! + "\n\n";
    const h = await setup(fixture, [{ body: opening, hold: true }], [pi => {
      pi.on("provider_stream_event", () => { received.resolve(); });
    }]);
    const prompt = h.session.prompt("Wait for cancellation");
    await received.promise;
    await h.session.abort();
    await prompt;
    assertHooks(h, 1, 1);
    expect(endings(h)).toEqual(["aborted"]);
    expect(settled(h)).toHaveLength(1);
    expect(h.events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
    expect(h.executions()).toBe(0);
    // Pi 1.3 lazyStream classifies pre-request aborts as error, not aborted; inheritance must match the host, without HTTP.
    const abort = new AbortController();
    abort.abort();
    const stream = h.runtime.streamSimple(h.session.model!, { messages: [] }, { signal: abort.signal });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    expect(events.filter(event => event.type === "done" || event.type === "error")).toMatchObject([{ type: "error", reason: "error" }]);
    const cancelled = await stream.result();
    const hostCancelled = await h.host.completeSimple(h.session.model!, { messages: [] }, { signal: abort.signal });
    expect(cancelled.stopReason).toBe(hostCancelled.stopReason);
    expect(cancelled.errorMessage).toBe(hostCancelled.errorMessage);
    expect(cancelled.errorMessage).toMatch(/abort/i);
    expect(h.requests).toHaveLength(1);
  });
});
