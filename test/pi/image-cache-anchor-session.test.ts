import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { IMAGE_CONTEXT_LIMITS, OMITTED_TOOL_IMAGE } from "../../src/pi/image-context.js";

const roots: string[] = [], servers: Server[] = [], sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { await session.abort(); session.dispose(); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=";
const sse = (frames: Record<string, unknown>[]) => frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
const reply = (n: number, done: boolean) => sse([
  { type: "message_start", message: { id: `m${n}`, type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: done ? { type: "text", text: "" } : { type: "tool_use", id: `toolu_${n}`, name: "observe", input: {} } },
  { type: "content_block_delta", index: 0, delta: done ? { type: "text_delta", text: "done" } : { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]);
const LIMIT_ERROR = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "A maximum of 4 blocks with cache_control may be provided. Found 5." } });

type Block = { type: string; tool_use_id?: string; cache_control?: unknown; content?: unknown };
type Body = { system?: Block[]; tools?: Block[]; messages: { role: string; content: Block[] | string }[] };
/** Wire blocks in prompt order without markers (markers move; the cached content must not). */
const blocks = (body: Body) => body.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).map(b => JSON.stringify({ role: m.role, ...b, cache_control: undefined })));
const markers = (body: Body) => [...(body.system ?? []), ...(body.tools ?? []), ...body.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])].filter(b => b.cache_control).length;
/** Position of the anchor: a marked block before the last message (Pi marks only the last message's last block). */
const anchorAt = (body: Body) => {
  let position = 0;
  for (const [index, message] of body.messages.entries()) for (const block of Array.isArray(message.content) ? message.content : [{} as Block]) {
    if (block.cache_control && index < body.messages.length - 1) return position;
    position++;
  }
  return undefined;
};

async function setup(script: { status?: number; body: string }[]) {
  const root = await mkdtemp(join(tmpdir(), "orche-cache-anchor-")); roots.push(root);
  const bodies: Body[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    const next = script[bodies.length - 1] ?? { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"unexpected request"}}' };
    response.writeHead(next.status ?? 200, { "Content-Type": next.status ? "application/json" : "text/event-stream" });
    response.end(next.body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { anthropic: {
    baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages", apiKey: "test-only",
    models: [{ id: "test-model", input: ["text", "image"], contextWindow: 200_000, maxTokens: 256 }],
  } } }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, refreshOnCreate: false });
  const session = await createSession({
    cwd: root, modelRuntime: runtime, route: { role: "test", model: "anthropic/test-model" }, instructions: "Observe until done.", tools: ["observe"],
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, maxAgentDelayMs: 1, provider: { maxRetries: 0, maxRetryDelayMs: 1 } },
    customTools: [{ name: "observe", label: "observe", description: "Screenshot", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "screen" }, { type: "image", data: png, mimeType: "image/png" }], details: undefined }) }],
  });
  sessions.push(session);
  return { session, bodies };
}

describe("image cache anchor on worker requests through Pi's Anthropic transport (loopback)", () => {
  it("anchors before the oldest kept screenshot, so every prune leaves the cached prefix up to the previous anchor unchanged", async () => {
    const turns = IMAGE_CONTEXT_LIMITS.maxImages * 2 + 2;
    const { session, bodies } = await setup(Array.from({ length: turns + 1 }, (_, n) => ({ body: reply(n, n === turns) })));
    await session.prompt("Observe the screen repeatedly");
    expect(bodies).toHaveLength(turns + 1);
    let prunes = 0;
    bodies.forEach((body, n) => {
      expect(markers(body)).toBeLessThanOrEqual(4);
      // Request n carries n screenshots. Before the first prune the oldest kept one is the first result (nothing before it
      // to anchor); from the first prune on there is always a result before the oldest kept one.
      expect(anchorAt(body) !== undefined).toBe(n > IMAGE_CONTEXT_LIMITS.maxImages);
      if (n === 0) return;
      const before = blocks(bodies[n - 1]!), after = blocks(body);
      let common = 0;
      while (common < before.length && before[common] === after[common]) common++;
      if (common < before.length) {
        prunes++;
        expect(JSON.stringify(body)).toContain(OMITTED_TOOL_IMAGE);
        const previousAnchor = anchorAt(bodies[n - 1]!);
        if (previousAnchor !== undefined) expect(common).toBeGreaterThan(previousAnchor);
      }
    });
    expect(prunes).toBe(2);
  });

  it("stops anchoring in the session after the provider rejects the marker budget", async () => {
    const failing = IMAGE_CONTEXT_LIMITS.maxImages + 2;
    const script = [...Array.from({ length: failing }, (_, n) => ({ body: reply(n, false) })), { status: 400, body: LIMIT_ERROR }, { body: reply(failing + 1, false) }, { body: reply(failing + 2, true) }];
    const { session, bodies } = await setup(script);
    await session.prompt("Observe").catch(() => undefined);
    expect(bodies).toHaveLength(failing + 1);
    expect(anchorAt(bodies[failing]!)).toBeDefined();
    expect(anchorAt(bodies[failing - 1]!)).toBeDefined();
    await session.prompt("Continue");
    expect(bodies).toHaveLength(failing + 3);
    for (const body of bodies.slice(failing + 1)) { expect(anchorAt(body)).toBeUndefined(); expect(markers(body)).toBeGreaterThan(0); }
  });
});
