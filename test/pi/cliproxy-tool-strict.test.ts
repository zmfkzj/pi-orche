/**
 * Function tools of orche's own sessions on CLIProxyAPI Responses models publish `strict: null` (src/pi/cliproxy-tool-strict.ts), as
 * pi-cliproxyapi-provider's payload adapter does for main's session. Without it Pi omits `strict` (the provider sets
 * `supportsStrictMode: false`), the proxy compiles the tools as strict schemas, and every optional argument becomes required: GPT
 * workers then filled `parent`, `to`, `symbol`, `offset`/`limit` with placeholders that the tools rejected. A faux provider stands in
 * for the proxy: the payload sent is tested, not what the upstream does with it. All tool names and values here are synthetic.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxProvider, fauxToolCall as call, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { cliproxyToolStrictPayload } from "../../src/pi/cliproxy-tool-strict.js";

/** Pi's own Responses tool conversion for a provider without strict mode support: the `strict` field is left out. */
const piTools = () => convertResponsesTools([
  { name: "sample_tool", description: "synthetic", parameters: Type.Object({ path: Type.String(), extra: Type.Optional(Type.String()) }) },
  { name: "other_tool", description: "synthetic", parameters: Type.Object({ value: Type.Optional(Type.Number()) }) },
] as never, { supportsStrictMode: false }) as unknown as Record<string, unknown>[];

describe("cliproxyToolStrictPayload", () => {
  const gpt = { provider: "cliproxyapi", api: "openai-responses" };
  it("Pi's conversion without strict mode support really omits the field (the precondition of the fix)", () => {
    expect(piTools().every(tool => !("strict" in tool))).toBe(true);
  });
  it("sets strict:null on every function tool without a strict field, leaving the rest of the payload as it was", () => {
    const payload = { model: "m", input: [], tools: piTools() };
    const out = cliproxyToolStrictPayload(payload, gpt) as typeof payload;
    expect(out.tools.map(tool => tool.strict)).toEqual([null, null]);
    expect(out.tools.map(({ strict: _s, ...rest }) => rest)).toEqual(payload.tools);
    expect(out.input).toBe(payload.input);
    expect(payload.tools.every(tool => !("strict" in tool))).toBe(true);
  });
  it("keeps an explicit strict value and non-function tools; returns undefined when nothing changes", () => {
    const tools = [{ type: "function", name: "a", strict: true }, { type: "function", name: "b", strict: null }, { type: "custom", name: "c" }];
    expect(cliproxyToolStrictPayload({ tools }, gpt)).toBeUndefined();
  });
  it("applies only to the CLIProxyAPI provider on a Responses API", () => {
    const payload = () => ({ tools: piTools() });
    expect(cliproxyToolStrictPayload(payload(), { provider: "other", api: "openai-responses" })).toBeUndefined();
    expect(cliproxyToolStrictPayload(payload(), { provider: "cliproxyapi", api: "anthropic-messages" })).toBeUndefined();
    expect(cliproxyToolStrictPayload(payload(), undefined)).toBeUndefined();
    expect(cliproxyToolStrictPayload({ input: [] }, gpt)).toBeUndefined();
    expect((cliproxyToolStrictPayload(payload(), { provider: "CLIProxyAPI", api: "cliproxyapi-codex-responses" }) as { tools: { strict: unknown }[] }).tools[0]!.strict).toBeNull();
  });
});

describe("through a real orche worker session (Pi before_provider_request → onPayload)", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

  async function run(provider: string, api: string, modelId: string) {
    const dir = await mkdtemp(join(tmpdir(), "orche-strict-"));
    await writeFile(join(dir, "notes.txt"), "ok\n");
    const faux = fauxProvider({ provider, api, models: [{ id: modelId, reasoning: true, contextWindow: 272_000, maxTokens: 128_000 }] });
    const seen: Record<string, unknown>[] = [];
    const sending: FauxResponseFactory = (async (_context, options, _state, model) => {
      const body = { model: model.id, input: [{ role: "user", content: "q" }], tools: piTools(), stream: true };
      seen.push(((await options?.onPayload?.(body, model)) ?? body) as Record<string, unknown>);
      return reply([call("report_result", { kind: "answer", summary: "ok", data: { evidence: ["notes.txt:1"] } })], { stopReason: "toolUse" });
    }) as FauxResponseFactory;
    faux.setResponses([sending]);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const manager = new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas });
    cleanup.push(async () => { await manager.disposeWithin(2_000).catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
    await manager.spawn({ id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model: `${faux.provider.id}/${modelId}`, thinking: "high" }, instructions: "worker", peerMessaging: false, tools: [...WORKER_TOOL_NAMES] });
    manager.assign("W1", "answer", "Assignment: answer. What does notes.txt say?");
    const waited = await manager.wait("W1", 15_000);
    return { waited, seen };
  }

  it("a GPT model on CLIProxyAPI Responses: every function tool of the request carries strict:null", async () => {
    const { waited, seen } = await run("cliproxyapi", "openai-responses", "gpt-synthetic");
    expect(waited).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    const tools = seen[0]!.tools as Record<string, unknown>[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(tool => tool.strict === null)).toBe(true);
  });
  it("another provider on the same API: the tools are left as Pi built them", async () => {
    const { seen } = await run("other-responses", "openai-responses", "gpt-synthetic");
    expect((seen[0]!.tools as Record<string, unknown>[]).every(tool => !("strict" in tool))).toBe(true);
  });
});
