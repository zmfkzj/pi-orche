/**
 * Length-recovery benchmark (docs/length-recovery.md): the same scripted worker tasks under Pi's own behaviour (P0) and the
 * candidate recovery strategies, through the real stack: orche's AgentManager and session factory, Pi's AgentSession (its
 * compaction and overflow/length recovery included) and a deterministic faux provider. No paid model call is made.
 *
 * What it measures is the MECHANICS of each strategy against fixed model behaviours (does the worker deliver its report, how many
 * requests / tokens / compactions / simulated seconds it takes, does it end silently). The model behaviours are assumptions made
 * explicit in {@link MODELS}; nothing here measures how often a real model behaves like any of them, or answer quality.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage as reply, fauxProvider, fauxText as text, fauxThinking as thinking, fauxToolCall as call,
  InMemoryCredentialStore, type AssistantMessage, type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import type { LengthRecoveryOptions } from "../../src/pi/length-recovery.js";

/**
 * Candidate strategies. P0 is Pi's behaviour as orche had it before (compaction recovery + one generic report nudge); the shipped
 * default (src/pi/length-recovery.ts) is P2_nudge_stepdown_cap2, chosen from this benchmark (docs/length-recovery.md).
 */
export const STRATEGIES = {
  P0_pi_default: { mode: "off" },
  // Ours: next-step nudge, with or without a one-level thinking step-down on the last attempt, cap 3 or 2.
  P1_nudge: { mode: "nudge", maxConsecutive: 3, stepDownThinking: false },
  P2_nudge_stepdown: { mode: "nudge", maxConsecutive: 3, stepDownThinking: true },
  P2_nudge_stepdown_cap2: { mode: "nudge", maxConsecutive: 2, stepDownThinking: true },
  // Baselines from other agents (docs/length-recovery.md): a plain continuation message, and the identical request re-sent.
  P3_plain_continue: { mode: "continue", maxConsecutive: 3, stepDownThinking: false },
  P4_identical_resend: { mode: "resend", maxConsecutive: 3, stepDownThinking: false },
} satisfies Record<string, LengthRecoveryOptions>;
export type StrategyName = keyof typeof STRATEGIES;

const OUTPUT_CAP_TOKENS = 32_000;
/** Faux usage is estimated at four characters per token: this much thinking is a 32k-token output. */
const CAPPED_THINKING = "t".repeat(OUTPUT_CAP_TOKENS * 4);
const SUMMARY_PROMPT = "You are a context summarization assistant";
const NUDGE_MARK = "Reason only about the immediate next step";

interface Ctx { messages: unknown[]; systemPrompt?: string }
/** Pi's compaction summarizer call (its system prompt), which goes to the same provider. */
const isSummarizer = (context: Ctx) => context.systemPrompt?.startsWith(SUMMARY_PROMPT) === true || JSON.stringify(context.messages[0] ?? "").includes(SUMMARY_PROMPT);
const lastText = (context: Ctx) => JSON.stringify(context.messages.at(-1) ?? "");
const sawNudge = (context: Ctx) => lastText(context).includes(NUDGE_MARK);
const thinkingOnly = (): AssistantMessage => reply([thinking(CAPPED_THINKING)], { stopReason: "length" });
const act = (): AssistantMessage => reply([call("read", { path: "notes.txt" })], { stopReason: "toolUse" });
const report = (): AssistantMessage => reply([call("report_result", { kind: "answer", summary: "Found it: notes.txt says ok", data: { evidence: ["notes.txt:1"] } })], { stopReason: "toolUse" });
const summary = (): AssistantMessage => reply([text("## Goal\nAnswer the question.\n## Progress\nNothing yet.")]);

/**
 * Model behaviours (assumptions). Each returns the next answer from the request it gets. Once it has acted (read notes.txt) it
 * reports.
 * - `transient`: the first request overruns while thinking, every later one acts (a one-off sampling accident).
 * - `needs_nudge`: overruns while thinking until it is told to act on the next step only (an over-planning model).
 * - `needs_two_nudges`: like `needs_nudge`, but only the second next-step instruction works.
 * - `effort_bound`: overruns at thinking high or above, acts at medium or below (the overrun is a property of the effort level).
 * - `stubborn`: always overruns (nothing helps; the point is how each strategy ends).
 * - `partial_text`: the first answer is cut-off text, then it acts.
 * - `real_overflow`: the first request fails with a context-overflow error, the next one (after a compaction) acts.
 */
export const MODELS = ["transient", "needs_nudge", "needs_two_nudges", "effort_bound", "stubborn", "partial_text", "real_overflow"] as const;
export type ModelName = typeof MODELS[number];

function behaviour(model: ModelName, contexts: string[], summarizer: { input: number; output: number }): FauxResponseFactory {
  let requests = 0;
  let nudges = 0;
  let acted = false;
  return (context, options) => {
    if (isSummarizer(context as Ctx)) {
      // Not reported through orche's usage events: estimated like the faux provider does (about 4 characters per token).
      const answer = summary();
      summarizer.input += Math.ceil(((context as Ctx).systemPrompt ?? "").length / 4 + JSON.stringify((context as Ctx).messages).length / 4);
      summarizer.output += Math.ceil(JSON.stringify(answer.content).length / 4);
      return answer;
    }
    contexts.push(JSON.stringify((context as Ctx).messages));
    requests++;
    if (acted) return report();
    const go = () => { acted = true; return act(); };
    switch (model) {
      case "transient": return requests === 1 ? thinkingOnly() : go();
      case "needs_nudge": return sawNudge(context as Ctx) ? go() : thinkingOnly();
      case "needs_two_nudges": if (sawNudge(context as Ctx)) nudges++; return nudges >= 2 ? go() : thinkingOnly();
      case "effort_bound": return ["high", "xhigh", "max"].includes(options?.reasoning ?? "") ? thinkingOnly() : go();
      case "stubborn": return thinkingOnly();
      case "partial_text": return requests === 1 ? reply([thinking("plan"), text("The answer starts with: notes.txt contains")], { stopReason: "length" }) : go();
      case "real_overflow": return requests === 1 ? reply([], { stopReason: "error", errorMessage: "prompt is too long: 1000500 tokens > 1000000 maximum" }) : go();
    }
  };
}

/**
 * ASSUMED prices and speeds for the cost/latency estimate. Prices: USD per million tokens at the Claude Opus 4/4.1 list prices
 * (input 15, output 75; cache write 1.25× and cache read 0.1× of input), the class of model in the observed sessions; not checked
 * against the current price list, and the proxy's real billing is unknown. Speeds: round numbers for a large reasoning model
 * (60 output tokens/s, 20k input tokens/s prefill, 1 s per request), not measured. Change them here; the counts do not depend on them.
 */
export const ASSUMPTIONS = {
  usdPerMInput: 15, usdPerMCacheRead: 1.5, usdPerMCacheWrite: 18.75, usdPerMOutput: 75,
  requestOverheadS: 1.0, outputTokensPerS: 60, inputTokensPerS: 20_000,
};

export interface RunResult {
  strategy: StrategyName;
  model: ModelName;
  /** The worker delivered its report (the task succeeded as far as the scripted model allows). */
  reported: boolean;
  outcome: string;
  error?: string;
  /** Model requests (faux provider calls), the compaction summarizer's included. */
  requests: number;
  /** Calls of Pi's compaction summarizer (same provider): faux calls minus the worker's own usage events. */
  summarizerCalls: number;
  /** Compactions that completed (orche's onCompact); a cancelled compaction calls no summarizer and is not counted. */
  compactions: number;
  lengthStops: number;
  /** Worker requests whose messages equal the previous request's (a re-sent identical request). */
  identicalResends: number;
  /** Worker input (uncached + cache write) and summarizer input, as the faux provider counts them (not a real tokenizer). */
  inputTokens: number;
  cacheReadTokens: number;
  /** Worker and summarizer output. */
  outputTokens: number;
  /** ESTIMATE from {@link ASSUMPTIONS}; not a bill. */
  estUSD: number;
  /** ESTIMATE from {@link ASSUMPTIONS}; not a measured latency (wallMs is the faux run's own time). */
  estSeconds: number;
  wallMs: number;
}

/** One worker task under one strategy and one model behaviour. */
export async function runScenario(strategy: StrategyName, model: ModelName, options: { thinking?: "medium" | "high"; timeoutMs?: number; /** Recovery options instead of the strategy's (e.g. `{}`: the shipped defaults). */ recovery?: LengthRecoveryOptions } = {}): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "orche-length-bench-"));
  await writeFile(join(dir, "notes.txt"), "ok\n");
  const faux = fauxProvider({ provider: `bench-${strategy}-${model}-${Math.random().toString(36).slice(2, 8)}`, models: [{ id: "opus-like", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 }] });
  /** The worker requests' message lists, to count requests re-sent unchanged (the summarizer's are not included). */
  const contexts: string[] = [];
  const summarizer = { input: 0, output: 0 };
  const script = behaviour(model, contexts, summarizer);
  faux.setResponses(Array.from({ length: 60 }, () => script));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const manager = new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas });
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
  const lengthStops = { count: 0 };
  let compactions = 0;
  manager.subscribe(event => {
    if (event.type === "usage") { usage.requests++; usage.input += event.input; usage.cacheRead += event.cacheRead; usage.cacheWrite += event.cacheWrite; usage.output += event.output; }
  });
  const started = Date.now();
  try {
    await manager.spawn({
      id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model: `${faux.provider.id}/opus-like`, thinking: options.thinking ?? "high" },
      instructions: "You are a worker.", peerMessaging: false,
      // Single-workflow workers compact (and so take Pi's overflow/length recovery path); the essentials go back after each.
      taskCompaction: { essentials: () => "R1: answer from notes.txt", onCompact: () => { compactions++; } },
      lengthRecovery: { ...(options.recovery ?? STRATEGIES[strategy]), onEvent: event => { if (event.action === "observed") lengthStops.count++; } },
    });
    // A 40k-token context: far from the 1M window, as in the observed sessions.
    manager.assign("W1", "answer", `Assignment: answer. What does notes.txt say?\n\nContext:\n${"background ".repeat(14_000)}`);
    const waited = await manager.wait("W1", options.timeoutMs ?? 20_000);
    const outcome = waited.type === "outcome" ? waited.outcome : undefined;
    const summarizerCalls = Math.max(0, faux.state.callCount - usage.requests);
    const input = usage.input + summarizer.input, output = usage.output + summarizer.output;
    const estUSD = (input * ASSUMPTIONS.usdPerMInput + usage.cacheRead * ASSUMPTIONS.usdPerMCacheRead + usage.cacheWrite * ASSUMPTIONS.usdPerMCacheWrite + output * ASSUMPTIONS.usdPerMOutput) / 1e6;
    const estSeconds = faux.state.callCount * ASSUMPTIONS.requestOverheadS + output / ASSUMPTIONS.outputTokensPerS + (input + usage.cacheWrite) / ASSUMPTIONS.inputTokensPerS;
    return {
      strategy, model, reported: outcome?.status === "completed" && !!outcome.result, outcome: outcome?.status ?? waited.type,
      ...(outcome?.error ? { error: outcome.error.slice(0, 200) } : {}),
      requests: faux.state.callCount, summarizerCalls, compactions, lengthStops: lengthStops.count,
      identicalResends: contexts.filter((messages, index) => index > 0 && messages === contexts[index - 1]).length,
      inputTokens: input + usage.cacheWrite, cacheReadTokens: usage.cacheRead, outputTokens: output,
      estUSD: Math.round(estUSD * 100) / 100, estSeconds: Math.round(estSeconds), wallMs: Date.now() - started,
    };
  } finally {
    await manager.disposeWithin(2_000).catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Every strategy × model behaviour, `repeat` times (the behaviours are deterministic; repeats check that runs are stable). */
export async function runMatrix(options: { repeat?: number; strategies?: readonly StrategyName[]; models?: readonly ModelName[] } = {}): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let round = 0; round < (options.repeat ?? 1); round++) {
    for (const strategy of options.strategies ?? Object.keys(STRATEGIES) as StrategyName[]) {
      for (const model of options.models ?? MODELS) results.push(await runScenario(strategy, model));
    }
  }
  return results;
}

/** Markdown table: one row per strategy × model (first repeat), plus per-strategy totals. */
export function formatMatrix(results: readonly RunResult[]): string {
  const rows = results.map(r => `| ${r.strategy} | ${r.model} | ${r.reported ? "yes" : "no"} | ${r.outcome}${r.error ? ` (${r.error.slice(0, 60)})` : ""} | ${r.requests} | ${r.summarizerCalls} | ${r.compactions} | ${r.lengthStops} | ${r.identicalResends} | ${r.outputTokens} | ${r.inputTokens} | ${r.estUSD.toFixed(2)} | ${r.estSeconds} |`);
  const strategies = [...new Set(results.map(r => r.strategy))];
  const totals = strategies.map(name => {
    const mine = results.filter(r => r.strategy === name);
    const sum = (key: keyof RunResult) => mine.reduce((total, r) => total + (r[key] as number), 0);
    return `| ${name} | ${mine.filter(r => r.reported).length}/${mine.length} | ${mine.filter(r => !r.reported && !r.error).length} | ${sum("requests")} | ${sum("compactions")} | ${sum("outputTokens")} | ${sum("estUSD").toFixed(2)} | ${sum("estSeconds")} |`;
  });
  return [
    "| strategy | model behaviour | reported | outcome | requests | summarizer | compactions | length stops | identical resends | output tok | input tok | est. $ | est. s |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "| strategy | reported | silent ends (no report, no error) | requests | compactions | output tok | est. $ | est. s |",
    "|---|---|---|---|---|---|---|---|",
    ...totals,
  ].join("\n");
}
