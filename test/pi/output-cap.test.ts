/**
 * The explicit output budget of Claude requests through CLIProxyAPI (src/pi/output-cap.ts): the decision rules, and the real payload
 * a provider receives from an orche session (AgentManager, orche's session factory, Pi's `before_provider_request` → `onPayload`),
 * for a Claude model and for a GPT model on the same proxy path. Plus the tool-result references of the evidence ledger and the cap
 * fields of a length stop. A faux provider stands in for the proxy: sending the field is tested, not what the upstream does with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxProvider, fauxThinking as thinking, fauxToolCall as call, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { decideOutputCap, configureOutputCap, MIN_OUTPUT_CAP } from "../../src/pi/output-cap.js";
import { parseOutputCapConfig } from "../../src/extension/config.js";
import { beginThinkingPolicy, PHASE_THINKING_POLICY } from "../../src/pi/thinking-policy.js";
import type { LengthRecoveryEvent } from "../../src/pi/length-recovery.js";

const CLAUDE = { provider: "cliproxyapi", id: "claude-opus-5-5", api: "cliproxyapi-codex-responses", contextWindow: 1_000_000, maxTokens: 128_000 };
const payload = (extra: Record<string, unknown> = {}) => ({ model: "x", instructions: "be brief", input: [{ role: "user", content: "hi" }], reasoning: { effort: "high" }, ...extra });

describe("the output budget decision", () => {
  it("Claude through CLIProxyAPI gets the catalog maxTokens; everything else is left alone", () => {
    expect(decideOutputCap(CLAUDE, payload())).toEqual({ cap: 128_000, source: "catalog", model: "cliproxyapi/claude-opus-5-5" });
    expect(decideOutputCap({ ...CLAUDE, id: "bts/claude-opus-5-5" }, payload())).toMatchObject({ cap: 128_000 });
    expect(decideOutputCap({ ...CLAUDE, id: "gpt-5.5" }, payload())).toMatchObject({ source: "out-of-scope" });
    expect(decideOutputCap({ ...CLAUDE, api: "anthropic-messages" }, payload())).toMatchObject({ source: "out-of-scope" });
    expect(decideOutputCap({ ...CLAUDE, maxTokens: 0 }, payload())).toMatchObject({ source: "none" });
    expect(decideOutputCap(CLAUDE, payload(), { mode: "off" })).toMatchObject({ source: "disabled" });
  });
  it("precedence: the request's own value, a per-model rule (or off), the config tokens, the catalog", () => {
    expect(decideOutputCap(CLAUDE, payload({ max_output_tokens: 9000 }), { mode: "auto", tokens: 64_000 })).toMatchObject({ cap: 9000, source: "payload" });
    expect(decideOutputCap(CLAUDE, payload(), { mode: "auto", tokens: 64_000, models: [{ model: "cliproxyapi/claude-opus-5-*", tokens: 100_000 }] })).toMatchObject({ cap: 100_000, source: "config-model" });
    expect(decideOutputCap(CLAUDE, payload(), { mode: "auto", tokens: 64_000, models: [{ model: "cliproxyapi/claude-opus-5-5", tokens: "off" }] })).toMatchObject({ source: "none" });
    expect(decideOutputCap(CLAUDE, payload(), { mode: "auto", tokens: 64_000, models: [{ model: "other/*", tokens: 2048 }] })).toMatchObject({ cap: 64_000, source: "config" });
  });
  it("clamped to the context room; left out when the room is below the minimum", () => {
    const small = { ...CLAUDE, contextWindow: 200_000, maxTokens: 64_000 };
    const big = payload({ input: [{ role: "user", content: "x".repeat(3 * 180_000) }] }); // ~180k tokens by the conservative estimate
    const decision = decideOutputCap(small, big);
    expect(decision).toMatchObject({ source: "catalog", clamped: true });
    expect(decision.cap).toBeLessThan(20_000);
    expect(decision.cap).toBeGreaterThanOrEqual(MIN_OUTPUT_CAP);
    expect(decideOutputCap(small, payload({ input: [{ role: "user", content: "x".repeat(3 * 197_000) }] }))).toMatchObject({ source: "context-tight" });
  });
  it("config: auto/off strings, objects, and refused values", () => {
    expect(parseOutputCapConfig("off")).toEqual({ mode: "off" });
    expect(parseOutputCapConfig({ tokens: 64_000, models: [{ model: "cliproxyapi/claude-haiku-*", tokens: "off" }] })).toEqual({ mode: "auto", tokens: 64_000, models: [{ model: "cliproxyapi/claude-haiku-*", tokens: "off" }] });
    expect(() => parseOutputCapConfig({ tokens: 100 })).toThrow(/outputCap.tokens: expected an integer from 1024/);
    expect(() => parseOutputCapConfig({ models: [{ model: "claude", tokens: 5000 }] })).toThrow(/models\[0\]\.model/);
    expect(() => parseOutputCapConfig({ max: 1 })).toThrow(/unknown field max/);
  });
});

describe("through a real orche session (Pi before_provider_request → onPayload)", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

  async function start(modelId: string, steps: FauxResponseFactory[], options: { lengthEvents?: LengthRecoveryEvent[]; policy?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "orche-cap-"));
    await writeFile(join(dir, "notes.txt"), "ok\n");
    const faux = fauxProvider({ provider: `cap-${Math.random().toString(36).slice(2, 8)}`, api: "cliproxyapi-codex-responses", models: [
      { id: "claude-opus-5-5", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "gpt-5.5", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
    ] });
    faux.setResponses(steps);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const manager = new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas });
    cleanup.push(async () => { await manager.disposeWithin(2_000).catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
    await manager.spawn({ id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model: `${faux.provider.id}/${modelId}`, thinking: "high" }, instructions: "worker", peerMessaging: false,
      tools: [...WORKER_TOOL_NAMES], ...(options.lengthEvents ? { lengthRecovery: { onEvent: (event: LengthRecoveryEvent) => options.lengthEvents!.push(event) } } : {}) });
    const decisions: unknown[] = [];
    configureOutputCap(manager.session("W1"), undefined, decision => decisions.push(decision));
    if (options.policy) beginThinkingPolicy(manager.session("W1"), PHASE_THINKING_POLICY);
    manager.assign("W1", "answer", "Assignment: answer. What does notes.txt say?");
    const waited = await manager.wait("W1", 15_000);
    return { waited, decisions };
  }
  /** A step that sends a Codex-like body through Pi's payload hook, as pi-ai's Codex Responses provider does, and records the result. */
  const sending = (seen: Record<string, unknown>[], then: () => ReturnType<typeof reply>): FauxResponseFactory => (async (_context, options, _state, model) => {
    const body = { model: model.id, instructions: "x", input: [{ role: "user", content: [{ type: "input_text", text: "q" }] }], reasoning: { effort: options?.reasoning ?? "none", summary: "auto" }, stream: true };
    seen.push(((await options?.onPayload?.(body, model)) ?? body) as Record<string, unknown>);
    return then();
  }) as FauxResponseFactory;
  const report = () => reply([call("report_result", { kind: "answer", summary: "ok", data: { evidence: ["notes.txt:1"] } })], { stopReason: "toolUse" });

  it("a Claude model on the proxy path: every request carries max_output_tokens = the catalog maxTokens", async () => {
    const seen: Record<string, unknown>[] = [];
    const { waited, decisions } = await start("claude-opus-5-5", [sending(seen, () => reply([call("read", { path: "notes.txt" })], { stopReason: "toolUse" })), sending(seen, report)]);
    expect(waited).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(seen.map(body => body.max_output_tokens)).toEqual([128_000, 128_000]);
    expect(seen[0]!.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(decisions).toEqual([expect.objectContaining({ cap: 128_000, source: "catalog" })]);
  });
  it("a GPT model on the same proxy path: the request is not touched", async () => {
    const seen: Record<string, unknown>[] = [];
    const { decisions } = await start("gpt-5.5", [sending(seen, report)]);
    expect(seen[0]).not.toHaveProperty("max_output_tokens");
    expect(decisions).toEqual([expect.objectContaining({ source: "out-of-scope" })]);
  });
  it("a length stop records the budget sent and whether the output reached it (here: no, the cap was elsewhere)", async () => {
    const seen: Record<string, unknown>[] = [];
    const events: LengthRecoveryEvent[] = [];
    await start("claude-opus-5-5", [sending(seen, () => reply([thinking("t".repeat(32_000 * 4))], { stopReason: "length" })), sending(seen, report)], { lengthEvents: events });
    expect(events[0]).toMatchObject({ kind: "thinking_only", outputCap: 128_000, capSource: "catalog", atCap: false });
  });
  it("tool results carry [orche ref Tn] when the assignment links evidence", async () => {
    const lasts: string[] = [];
    const record: FauxResponseFactory = context => { lasts.push(JSON.stringify(context.messages.at(-1))); return reply([call("read", { path: "notes.txt" })], { stopReason: "toolUse" }); };
    await start("claude-opus-5-5", [record, record, (context => { lasts.push(JSON.stringify(context.messages.at(-1))); return report(); }) as FauxResponseFactory], { policy: true });
    expect(lasts[1]).toContain("[orche ref T1]");
    expect(lasts[2]).toContain("[orche ref T2]");
  });
});
