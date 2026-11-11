/**
 * The explicit output budget of Claude requests through CLIProxyAPI (src/pi/output-cap.ts): the decision rules, and the real payload
 * a provider receives from an orche session (AgentManager, orche's session factory, Pi's `before_provider_request` → `onPayload`),
 * for a Claude model and for a GPT model on the same proxy path. Plus the tool-result references of the evidence ledger and the cap
 * fields of a length stop, and Pi's summary requests (compaction), which reach the provider without Pi's payload hook. A faux provider
 * stands in for the proxy: sending the field is tested, not what the upstream does with it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { ModelRuntime, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxProvider, fauxThinking as thinking, fauxToolCall as call, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { streamSimple as codexStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { decideOutputCap, configureOutputCap, lastOutputCap, MIN_OUTPUT_CAP, summarySystemPrompt, type OutputCapDecision, type OutputCapSettings } from "../../src/pi/output-cap.js";
import { configureSummaryBudget, summaryBudgetLevel, summaryBudgetTokens, SUMMARY_BUDGET_MAX, SUMMARY_BUDGET_MIN, SUMMARY_BUDGET_UNKNOWN, type SummaryLengthStop } from "../../src/pi/summary-budget.js";
import { createSession } from "../../src/pi/session-factory.js";
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

describe("Pi's summary requests (compaction) through orche's session factory", () => {
  const sessions: AgentSession[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const session of sessions.splice(0)) session.dispose();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  // Distinct catalog maxima on the proxy path, and a GPT model on the same path.
  const MODELS = [
    { id: "claude-opus-5-5", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: "claude-fable-5-2", reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000 },
    { id: "claude-haiku-5-1", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
    { id: "gpt-5.5", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
  ];
  type Seen = { label: "turn" | "summary"; cache?: string; body: Record<string, unknown> };
  type Env = Awaited<ReturnType<typeof setup>>;
  /** A Codex-like body of the request's real context, sent through the request's payload hook as pi-ai's Codex Responses provider does. */
  const step = (seen: Seen[], label: Seen["label"], text: string, extra: Record<string, unknown> = {}): FauxResponseFactory => (async (context, options, _state, model) => {
    const body = { model: model.id, instructions: "x", input: context.messages, reasoning: { effort: options?.reasoning ?? "none", summary: "auto" }, stream: true, ...extra };
    seen.push({ label, ...(options?.cacheRetention ? { cache: options.cacheRetention } : {}), body: ((await options?.onPayload?.(body, model)) ?? body) as Record<string, unknown> });
    return reply(text);
  }) as FauxResponseFactory;

  async function setup() {
    const cwd = await mkdtemp(join(tmpdir(), "orche-cap-summary-"));
    roots.push(cwd);
    const faux = fauxProvider({ provider: `sum-${Math.random().toString(36).slice(2, 8)}`, api: "cliproxyapi-codex-responses", models: MODELS });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    return { cwd, faux, runtime };
  }
  /** An orche session (createSession) with an unrelated extension that counts Pi's before_provider_request payloads and keeps the
   *  `ctx.modelRegistry` Pi gives extensions (built on the session's runtime). */
  async function open(env: Env, modelId: string, settings?: OutputCapSettings) {
    const hooks: Record<string, unknown>[] = [];
    let registry: ExtensionContext["modelRegistry"] | undefined;
    const session = await createSession({
      cwd: env.cwd, route: { role: "test", model: `${env.faux.provider.id}/${modelId}`, thinking: "high" }, tools: [], instructions: "Answer briefly.", modelRuntime: env.runtime,
      extensionFactories: [pi => { pi.on("before_provider_request", (event, ctx) => { registry = ctx.modelRegistry; hooks.push(event.payload as Record<string, unknown>); }); }],
    });
    sessions.push(session);
    const decisions: OutputCapDecision[] = [];
    configureOutputCap(session, settings, decision => decisions.push(decision));
    return { session, hooks, decisions, name: `${env.faux.provider.id}/${modelId}`, registry: () => registry };
  }
  /** Two turns, then a manual compaction that keeps only the last answer: Pi sends a history summary and a turn-prefix summary. */
  async function compact(env: Env, session: AgentSession, options: { first?: string; extra?: Record<string, unknown> } = {}) {
    const seen: Seen[] = [];
    env.faux.setResponses([step(seen, "turn", "First answer"), step(seen, "turn", "Second answer"), step(seen, "summary", "History summary", options.extra), step(seen, "summary", "Turn prefix summary", options.extra)]);
    await session.prompt(options.first ?? "First question");
    await session.prompt("Second question");
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    const result = await session.compact();
    expect(result.summary).toContain("History summary");
    expect(result.summary).toContain("Turn prefix summary");
    expect(seen.map(entry => entry.label)).toEqual(["turn", "turn", "summary", "summary"]);
    expect(seen.map(entry => entry.cache === "none")).toEqual([false, false, true, true]); // Pi's summaries disable cache writes
    return seen;
  }
  const caps = (seen: Seen[]) => seen.map(entry => entry.body.max_output_tokens);
  /** Two turns, then the session's compaction keeping only the last answer, with the shared runtime's getAuth calls counted around it. */
  async function compactCountingAuth(env: Env, session: AgentSession) {
    const seen: Seen[] = [];
    env.faux.setResponses([step(seen, "turn", "a"), step(seen, "turn", "b"), step(seen, "summary", "c"), step(seen, "summary", "d")]);
    await session.prompt("First question");
    await session.prompt("Second question");
    const getAuth = vi.spyOn(env.runtime, "getAuth");
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    await session.compact();
    const calls = getAuth.mock.calls.length;
    return { seen, calls };
  }

  it("every summary request (history and turn prefix) carries the catalog budget; ordinary requests and Pi's hook are unchanged", async () => {
    const env = await setup();
    const { session, hooks, decisions, name } = await open(env, "claude-opus-5-5");
    const seen = await compact(env, session);
    expect(caps(seen)).toEqual([128_000, 128_000, 128_000, 128_000]);
    expect(seen.map(entry => entry.body.reasoning)).toEqual(Array(4).fill({ effort: "high", summary: "auto" }));
    // Pi's before_provider_request ran for the two turns only (after orche's cap, as before): no hook is replayed for summaries.
    expect(hooks.map(payload => payload.max_output_tokens)).toEqual([128_000, 128_000]);
    expect(decisions).toEqual([{ cap: 128_000, source: "catalog", model: name }, { cap: 128_000, source: "catalog", model: name, request: "summary" }]);
    expect(lastOutputCap(session)).toEqual({ cap: 128_000, source: "catalog", model: name }); // the ordinary record stays the turn's
  });

  it("summary auth is still resolved inside each summary request only: Pi's stream function keeps its runtime identity", async () => {
    const env = await setup();
    const { session } = await open(env, "claude-opus-5-5");
    const { seen, calls } = await compactCountingAuth(env, session);
    expect(caps(seen)).toEqual([128_000, 128_000, 128_000, 128_000]);
    // One per summary request (ModelRuntime.prepareRequest). A replaced stream function would make Pi pre-resolve summary auth too.
    expect(calls).toBe(2);
  });

  it("a reused session: the next assignment's settings and a model switch apply to its next compactions", async () => {
    const env = await setup();
    const { session } = await open(env, "claude-opus-5-5");
    expect(caps(await compact(env, session))).toEqual([128_000, 128_000, 128_000, 128_000]);
    const decisions: OutputCapDecision[] = [];
    configureOutputCap(session, { mode: "auto", tokens: 96_000 }, decision => decisions.push(decision));
    expect(caps(await compact(env, session))).toEqual([96_000, 96_000, 96_000, 96_000]);
    configureOutputCap(session, undefined, decision => decisions.push(decision));
    await session.setModel(env.runtime.getModel(env.faux.provider.id, "claude-fable-5-2")!);
    expect(caps(await compact(env, session))).toEqual([64_000, 64_000, 64_000, 64_000]);
    expect(decisions.map(decision => [decision.cap, decision.source, decision.model, decision.request])).toEqual([
      [96_000, "config", `${env.faux.provider.id}/claude-opus-5-5`, undefined], [96_000, "config", `${env.faux.provider.id}/claude-opus-5-5`, "summary"],
      [64_000, "catalog", `${env.faux.provider.id}/claude-fable-5-2`, undefined], [64_000, "catalog", `${env.faux.provider.id}/claude-fable-5-2`, "summary"],
    ]);
  });

  it.each([
    ["claude-fable-5-2", undefined, 64_000, "catalog"],
    ["claude-haiku-5-1", undefined, 32_000, "catalog"],
    ["claude-opus-5-5", { mode: "auto", tokens: 96_000 }, 96_000, "config"],
    ["claude-opus-5-5", { mode: "auto", tokens: 96_000, models: [{ model: "*/claude-opus-*", tokens: 100_000 }] }, 100_000, "config-model"],
    ["claude-opus-5-5", { mode: "auto", models: [{ model: "*/claude-opus-*", tokens: "off" }] }, undefined, "none"],
    ["claude-opus-5-5", { mode: "off" }, undefined, "disabled"],
    ["gpt-5.5", undefined, undefined, "out-of-scope"],
  ] as [string, OutputCapSettings | undefined, number | undefined, OutputCapDecision["source"]][])("%s with %j: summaries get %s (%s), like the turns", async (modelId, settings, cap, source) => {
    const env = await setup();
    const { session, decisions } = await open(env, modelId, settings);
    const seen = await compact(env, session);
    if (cap === undefined) for (const entry of seen) expect(entry.body).not.toHaveProperty("max_output_tokens");
    else expect(caps(seen)).toEqual([cap, cap, cap, cap]);
    expect(decisions.map(decision => [decision.source, decision.cap, decision.request])).toEqual([[source, cap, undefined], [source, cap, "summary"]]);
  });

  it("a summary payload that already has max_output_tokens keeps it", async () => {
    const env = await setup();
    const { session, decisions } = await open(env, "claude-opus-5-5");
    const seen = await compact(env, session, { extra: { max_output_tokens: 9000 } });
    expect(caps(seen)).toEqual([128_000, 128_000, 9000, 9000]);
    expect(decisions.at(-1)).toMatchObject({ cap: 9000, source: "payload", request: "summary" });
  });

  it("a summary is clamped to the context room its own payload leaves", async () => {
    const env = await setup();
    const { session, decisions } = await open(env, "claude-haiku-5-1"); // 200k window, 32k catalog maximum
    const seen = await compact(env, session, { first: "x".repeat(3 * 170_000) }); // ~170k tokens by the conservative estimate
    const history = seen[2]!.body.max_output_tokens as number;
    expect(history).toBeLessThan(32_000);
    expect(history).toBeGreaterThanOrEqual(MIN_OUTPUT_CAP);
    expect(seen[3]!.body.max_output_tokens).toBe(32_000); // the turn-prefix summary does not carry the long first message
    expect(decisions.filter(decision => decision.request === "summary")).toEqual([
      expect.objectContaining({ cap: history, source: "catalog", clamped: true }), expect.objectContaining({ cap: 32_000, source: "catalog" }),
    ]);
  });

  it("a branch summary (tree navigation with a summary) carries the budget too", async () => {
    const env = await setup();
    const { session, decisions, name } = await open(env, "claude-fable-5-2");
    const seen: Seen[] = [];
    env.faux.setResponses([step(seen, "turn", "First answer"), step(seen, "turn", "Second answer"), step(seen, "summary", "Branch summary")]);
    await session.prompt("First question");
    await session.prompt("Second question");
    const first = session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
    expect((await session.navigateTree(first.id, { summarize: true })).cancelled).toBe(false);
    expect(seen.map(entry => entry.cache === "none")).toEqual([false, false, true]);
    expect(caps(seen)).toEqual([64_000, 64_000, 64_000]);
    expect(decisions).toEqual([{ cap: 64_000, source: "catalog", model: name }, { cap: 64_000, source: "catalog", model: name, request: "summary" }]);
  });

  it("summary-only and session-local: other sessions, the runtime itself, and direct requests not in Pi's summary shape are untouched", async () => {
    const env = await setup();
    const off = await open(env, "claude-opus-5-5", { mode: "off" });
    const on = await open(env, "claude-opus-5-5");
    for (const entry of await compact(env, off.session)) expect(entry.body).not.toHaveProperty("max_output_tokens");
    expect(caps(await compact(env, on.session))).toEqual([128_000, 128_000, 128_000, 128_000]);
    const model = env.runtime.getModel(env.faux.provider.id, "claude-opus-5-5")!;
    const user = { role: "user" as const, content: "hi", timestamp: Date.now() };
    const prompt = await summarySystemPrompt(); // read from Pi's own summarizer
    expect(prompt).toMatch(/summarization/);
    const plain = { messages: [user] };
    const summaryShaped = { messages: [{ role: "system" as const, content: prompt!, timestamp: 0 }, user] };
    const seen: Seen[] = [];
    env.faux.setResponses(["a", "b", "c", "d", "e", "f", "g"].map(text => step(seen, "summary", text)));
    let own = 0;
    await env.runtime.streamSimple(model, summaryShaped, { cacheRetention: "none" }).result(); // the runtime itself
    await on.session.modelRuntime.streamSimple(model, plain).result(); // an ordinary hookless request
    await on.session.modelRuntime.streamSimple(model, plain, { cacheRetention: "none" }).result(); // cache-free is not a summary
    await on.session.modelRuntime.streamSimple(model, summaryShaped).result(); // Pi's prompt without Pi's summary options
    await on.session.modelRuntime.streamSimple(model, summaryShaped, { cacheRetention: "none", maxTokens: 5000 }).result();
    await on.session.modelRuntime.streamSimple(model, summaryShaped, { cacheRetention: "none", onPayload: () => { own++; return undefined; } }).result();
    await on.session.modelRuntime.streamSimple(model, summaryShaped, { cacheRetention: "none" }).result(); // Pi's summary shape
    expect(caps(seen)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 128_000]);
    expect(own).toBe(1);
    expect(on.session.modelRuntime.getModel(env.faux.provider.id, "claude-opus-5-5")).toBe(model); // other methods are the runtime's
  });

  it("an extension's own request through ctx.modelRegistry keeps its prior payload: no budget, no summary decision", async () => {
    const env = await setup();
    const { session, decisions, name, registry } = await open(env, "claude-opus-5-5");
    const seen: Seen[] = [];
    env.faux.setResponses([step(seen, "turn", "Answer"), step(seen, "summary", "x"), step(seen, "summary", "y")]);
    await session.prompt("First question");
    const model = registry()!.find(env.faux.provider.id, "claude-opus-5-5")!;
    const context = { systemPrompt: "Classify the request.", messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    await registry()!.streamSimple(model, context).result();
    await registry()!.streamSimple(model, context, { cacheRetention: "none" }).result();
    expect(caps(seen)).toEqual([128_000, undefined, undefined]);
    expect(decisions).toEqual([{ cap: 128_000, source: "catalog", model: name }]);
  });

  /** The text of a summary request's last user message (Pi's prompt plus orche's budget note). */
  const promptOf = (context: { messages: { role: string; content: unknown }[] }) => JSON.stringify(context.messages.filter(message => message.role === "user").at(-1)?.content ?? "");
  type Sent = { prompt: string; cap: unknown };
  /** A summary answer that records its prompt and the payload's cap; `stop`: the stop reason of the answer. */
  const answer = (sent: Sent[], text: string, stop: "stop" | "length" | "error" = "stop", errorMessage?: string): FauxResponseFactory => (async (context, options, _state, model) => {
    const body = { model: model.id, instructions: "x", input: context.messages, stream: true };
    const sentBody = ((await options?.onPayload?.(body, model)) ?? body) as Record<string, unknown>;
    sent.push({ prompt: promptOf(context as never), cap: sentBody.max_output_tokens });
    return { ...reply(text, { stopReason: stop, ...(errorMessage ? { errorMessage } : {}) }), usage: { input: 10, output: stop === "length" ? 128_000 : 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }) as FauxResponseFactory;
  /** Two turns, then a manual compaction keeping only the last answer, with the given summary answers (history first). */
  async function compactWith(env: Env, session: AgentSession, summaries: FauxResponseFactory[]) {
    env.faux.setResponses([reply("First answer"), reply("Second answer"), ...summaries]);
    await session.prompt("First question");
    await session.prompt("Second question");
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    return session.compact().then(result => ({ ok: true as const, summary: result.summary }), (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
  }
  const budgetOf = (prompt: string) => Number(/under about ([\d,]+) tokens/.exec(prompt)?.[1]?.replace(/,/g, ""));

  it("summary budget: both summary requests (history, turn prefix) carry the budget note after Pi's prompt; turns do not", async () => {
    const env = await setup();
    const { session } = await open(env, "claude-opus-5-5");
    const sent: Sent[] = [];
    const turns: string[] = [];
    const turn = (text: string): FauxResponseFactory => (context => { turns.push(promptOf(context as never)); return reply(text); }) as FauxResponseFactory;
    env.faux.setResponses([turn("First answer"), turn("Second answer"), answer(sent, "History summary"), answer(sent, "Turn prefix summary")]);
    await session.prompt("First question");
    await session.prompt("Second question");
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    const result = await session.compact();
    expect(result.summary).toContain("History summary");
    expect(result.summary).not.toContain("orche summary budget"); // the note is in the request, never in the stored summary
    expect(sent).toHaveLength(2);
    for (const entry of sent) {
      expect(entry.prompt).toContain("orche summary budget (takes precedence over any instruction to preserve everything)");
      expect(budgetOf(entry.prompt)).toBe(SUMMARY_BUDGET_MAX); // min(32000, 128000 / 4)
      expect(entry.prompt).not.toContain("stopped at the response limit");
      expect(entry.prompt).not.toContain("is restored verbatim"); // not a task session: nothing is restored
      expect(entry.cap).toBe(128_000); // the output cap is unchanged
    }
    expect(sent[0]!.prompt.indexOf("orche summary budget")).toBeGreaterThan(sent[0]!.prompt.indexOf("<conversation>"));
    for (const prompt of turns) expect(prompt).not.toContain("orche summary budget");
    expect(summaryBudgetTokens({ maxTokens: 64_000 })).toBe(16_000);
    expect(summaryBudgetTokens({})).toBe(SUMMARY_BUDGET_UNKNOWN);
    expect(summaryBudgetTokens({ maxTokens: 128_000 }, 10)).toBe(SUMMARY_BUDGET_MIN);
  });

  it("summary budget: a cut-off summary is sent once more at once with half the budget; the compaction succeeds and the stop is recorded", async () => {
    const env = await setup();
    const { session } = await open(env, "claude-opus-5-5");
    const stops: SummaryLengthStop[] = [];
    configureSummaryBudget(session, event => stops.push(event));
    const sent: Sent[] = [];
    const result = await compactWith(env, session, [answer(sent, "PARTIAL HISTORY", "length"), answer(sent, "Short history"), answer(sent, "Turn prefix summary")]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.summary).toContain("Short history");
    expect(result.summary).not.toContain("PARTIAL HISTORY"); // a cut-off answer never becomes the checkpoint
    expect(sent.map(entry => budgetOf(entry.prompt))).toEqual([32_000, 16_000, 16_000]);
    expect(sent[1]!.prompt).toContain("The previous attempt at this summary stopped at the response limit and was discarded");
    expect(sent[2]!.prompt).not.toContain("stopped at the response limit"); // the turn prefix is a fresh request at the raised level
    expect(sent.map(entry => entry.cap)).toEqual([128_000, 128_000, 128_000]);
    expect(stops).toEqual([{ type: "summary_length_stop", model: `${env.faux.provider.id}/claude-opus-5-5`, budgetTokens: 32_000, nextBudgetTokens: 16_000, outputTokens: expect.any(Number), cap: 128_000, retry: true }]);
    expect(summaryBudgetLevel(session)).toBe(1);
  });

  it("summary budget: exhaustion fails the compaction as Pi did (no partial checkpoint), and the next compaction never repeats the cut-off request", async () => {
    const env = await setup();
    const { session } = await open(env, "claude-opus-5-5");
    const stops: SummaryLengthStop[] = [];
    configureSummaryBudget(session, event => stops.push(event));
    const sent: Sent[] = [];
    const failed = await compactWith(env, session, [answer(sent, "PARTIAL 1", "length"), answer(sent, "PARTIAL 2", "length")]);
    expect(failed).toEqual({ ok: false, error: expect.stringContaining("generation hit the token cap") });
    expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
    expect(stops.map(stop => [stop.budgetTokens, stop.nextBudgetTokens, stop.retry])).toEqual([[32_000, 16_000, true], [16_000, 8_000, false]]);
    // The next compaction (e.g. the next threshold check) starts at the raised level: a smaller request, not the same one again.
    const ok = await compactWith(env, session, [answer(sent, "History summary"), answer(sent, "Turn prefix summary")]);
    expect(ok).toMatchObject({ ok: true });
    expect(sent.map(entry => budgetOf(entry.prompt))).toEqual([32_000, 16_000, 8_000, 8_000]);
    expect(stops).toHaveLength(2);
    // Session-local: another session on the same runtime starts at the ordinary budget.
    const other = await open(env, "claude-opus-5-5");
    const fresh: Sent[] = [];
    expect(await compactWith(env, other.session, [answer(fresh, "H"), answer(fresh, "T")])).toMatchObject({ ok: true });
    expect(fresh.map(entry => budgetOf(entry.prompt))).toEqual([32_000, 32_000]);
    // A reused session keeps its level across assignments (its oversized summary is still there); only the observer changes.
    configureSummaryBudget(session, undefined);
    expect(summaryBudgetLevel(session)).toBe(2);
  });

  it("summary budget: a provider error (usage limit) and an abort are not output-limit stops: no re-send, no record, level unchanged", async () => {
    const env = await setup();
    const { session } = await open(env, "claude-opus-5-5");
    const stops: SummaryLengthStop[] = [];
    configureSummaryBudget(session, event => stops.push(event));
    session.settingsManager.applyOverrides({ retry: { enabled: false } });
    const sent: Sent[] = [];
    const failed = await compactWith(env, session, [answer(sent, "", "error", "You have hit your ChatGPT usage limit.")]);
    expect(failed).toEqual({ ok: false, error: expect.stringContaining("You have hit your ChatGPT usage limit.") });
    expect(failed.ok ? "" : failed.error).not.toContain("token cap");
    expect(sent).toHaveLength(1);
    expect(stops).toEqual([]);
    expect(summaryBudgetLevel(session)).toBe(0);
    // Abort: an aborted summary request passes through as aborted: not re-sent, not recorded.
    const model = env.runtime.getModel(env.faux.provider.id, "claude-opus-5-5")!;
    const prompt = await summarySystemPrompt();
    const controller = new AbortController();
    const aborted: Sent[] = [];
    env.faux.setResponses([async (...args: Parameters<FauxResponseFactory>) => { controller.abort(); return answer(aborted, "PARTIAL", "length")(...args); }, answer(aborted, "never")] as FauxResponseFactory[]);
    const context = { messages: [{ role: "system" as const, content: prompt!, timestamp: 0 }, { role: "user" as const, content: [{ type: "text" as const, text: "summarize" }], timestamp: 0 }] };
    const message = await session.modelRuntime.streamSimple(model, context, { cacheRetention: "none", signal: controller.signal }).result();
    expect(aborted).toHaveLength(1);
    expect(message.stopReason).toBe("aborted");
    expect(stops).toEqual([]);
    expect(summaryBudgetLevel(session)).toBe(0);
  });


  it("the real Codex Responses request body of a compaction carries the budget (body builder, no network)", async () => {
    const env = await setup();
    const bodies: Record<string, unknown>[] = [];
    const frames = (text: string) => [
      { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_test", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
    // Captures the serialized body pi-ai's Codex Responses provider would send, and answers with Responses SSE.
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body as string | Uint8Array;
      const zstd = new Headers(init?.headers).get("content-encoding") === "zstd";
      bodies.push(JSON.parse(typeof raw === "string" ? raw : Buffer.from(zstd ? zstdDecompressSync(raw) : raw).toString("utf8")));
      return new Response(frames(`answer ${bodies.length}`), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.signature`;
    // The proxy provider reuses this module under api `cliproxyapi-codex-responses`; the model keeps that api here too.
    const viaCodex: FauxResponseFactory = (async (context, options, _state, model) =>
      codexStreamSimple({ ...model, baseUrl: "http://codex.invalid" } as never, context, { ...options, apiKey: token, transport: "sse", fetch } as never).result()) as FauxResponseFactory;
    for (const settings of [undefined, { mode: "off" } as OutputCapSettings]) {
      bodies.length = 0;
      const { session } = await open(env, "claude-opus-5-5", settings);
      env.faux.setResponses([viaCodex, viaCodex, viaCodex, viaCodex]);
      await session.prompt("First question");
      await session.prompt("Second question");
      session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
      expect((await session.compact()).summary).toContain("answer 3");
      expect(bodies).toHaveLength(4);
      expect(bodies[2]!.instructions).not.toBe(bodies[0]!.instructions); // Pi's summarization prompt
      expect(bodies[2]!.reasoning).toEqual(bodies[0]!.reasoning);
      expect(bodies[0]).toHaveProperty("prompt_cache_key");
      expect(bodies[2]).not.toHaveProperty("prompt_cache_key"); // summaries keep their one-off cache routing
      // Off: the real body has no max_output_tokens at all (Pi's maxTokens is not serialized); auto: every request has the budget.
      expect(bodies.map(body => body.max_output_tokens)).toEqual(settings ? [undefined, undefined, undefined, undefined] : [128_000, 128_000, 128_000, 128_000]);
    }
  });
});
