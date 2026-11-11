import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, fauxToolCall as call, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession, type CompactionEvent, type CompactionStats, type TaskCompaction } from "../../src/pi/session-factory.js";
import { parseWorkerCompaction, resolveCompaction } from "../../src/pi/compaction-policy.js";
import { composeEssentials, renderReference, renderWorkLog } from "../../src/pi/compaction-state.js";
import { evidenceLedgerOf } from "../../src/pi/tool-evidence.js";
import { createSubWorkerRunner, subWorkerCompaction } from "../../src/orchestrator/sub-worker.js";
import { configureSummaryBudget, type SummaryLengthStop } from "../../src/pi/summary-budget.js";

/**
 * Worker compaction with the real Pi SDK (AgentSession, native compaction, session JSONL) and a faux model: the absolute policy,
 * the preflight (transcript reference, essentials, loop guard) with its fallback to the stable policy, failures, the post-success
 * restore, retrieval of an original tool result by its call id, and orche_spawn sub-workers.
 */
const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "orche-worker-compaction-")); roots.push(root); return root; }
const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
/** Pi's summary requests (history and split-turn prefix) run under the summarization system prompt. */
const isSummary = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.filter(message => message.role === "system")).includes("context summarization assistant");

async function runtimeWith(window: number, maxTokens = 4096) {
  const faux = fauxProvider({ provider: `wc-${Math.random().toString(36).slice(2, 8)}`, models: [{ id: "m", contextWindow: window, maxTokens }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  return { faux, runtime, route: { role: "test", model: `${faux.provider.id}/m`, thinking: "off" as const } };
}

/** A worker-like task compaction: verbatim request + work log + reference (extended) or the request alone (basic). */
function workerCompaction(policyValue: unknown, request: string, sink: { stats: CompactionStats[]; events: CompactionEvent[] }, options: { extended?: boolean; essentials?: () => string } = {}): TaskCompaction {
  const settings = parseWorkerCompaction(policyValue);
  return {
    essentials: options.essentials ?? (({ session, reference }) => composeEssentials([
      { name: "request", text: `Requirements checklist and original request, verbatim:\n${request}`, required: true },
      ...(options.extended ? [{ name: "work-log", text: renderWorkLog(evidenceLedgerOf(session)) }, { name: "reference", text: renderReference(reference, "kept 30 days"), required: true }] : []),
    ])),
    onCompact: stats => sink.stats.push(stats),
    onEvent: event => sink.events.push(event),
    policy: model => resolveCompaction(settings, { contextWindow: model.contextWindow, model: `${model.provider}/${model.id}`, role: "implement" }),
    retrieval: !!options.extended,
  };
}

/** Three reads of a ~11k-token file, then "done"; the summarizer answers SUMMARY (or `summary()`). */
function script(summary: () => ReturnType<typeof reply> = () => reply("SUMMARY"), reads = 3): FauxResponseStep {
  let step = 0;
  return context => {
    if (isSummary(context)) return summary();
    return step++ < reads ? tool("read", { path: "large.txt" }) : reply("done");
  };
}
const LARGE = Array.from({ length: 90 }, (_, index) => `LINE-${index} ${"x".repeat(490)}`).join("\n");

describe("workerCompaction with the real SDK", () => {
  it("absolute trigger compacts early; essentials restore the request, work log and a checked transcript reference; the original result is re-readable by its call id after the session is gone", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(200_000);
    f.faux.setResponses(Array(20).fill(script()));
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    const file = join(cwd, "sessions", "w.jsonl");
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", sessionFile: file,
      taskCompaction: workerCompaction({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000, essentials: "extended" }, "R1: read large.txt\nOriginal request\nRead it.", sink, { extended: true }) });
    disposers.push(() => session.dispose());
    expect(session.settingsManager.getCompactionSettings(session.model)).toMatchObject({ enabled: true, reserveTokens: 200_000 - 16_384, keepRecentTokens: 2_000 });
    await session.prompt("Read large.txt three times.");
    expect(session.getLastAssistantText()).toBe("done");
    expect(sink.stats.length).toBeGreaterThan(0);
    const first = sink.stats[0]!;
    expect(first).toMatchObject({ reason: "threshold", policy: "absolute", triggerTokens: 16_384, early: true, reference: "valid", essentialsMissing: [] });
    expect(first.essentialsSections).toEqual(["request", "work-log", "reference"]);
    expect(first.tokensBefore).toBeGreaterThan(16_384);
    const restored = JSON.stringify(session.messages.filter(message => message.role === "custom"));
    expect(restored).toContain("Assignment in progress at compaction time");
    expect(restored).toContain(`your own transcript ${file}`);
    const callId = evidenceLedgerOf(session).calls[0]!.toolCallId;
    expect(restored).toContain(`call ${callId}`);
    session.dispose();
    // A new worker (or a resumed one) finds the original tool result in the transcript by the call id the essentials named.
    const lines = (await readFile(file, "utf8")).split("\n").filter(line => line.includes(callId));
    expect(lines.some(line => line.includes('"role":"toolResult"') && line.includes("LINE-0 "))).toBe(true);
    expect((await readFile(file, "utf8"))).toContain('"type":"compaction"');
  });

  it("refuses an early compaction whose transcript reference is unavailable (in-memory session), falls back to the stable policy and keeps the context", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(200_000);
    f.faux.setResponses(Array(20).fill(script()));
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test",
      taskCompaction: workerCompaction({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000, essentials: "extended" }, "R1: read", sink, { extended: true }) });
    disposers.push(() => session.dispose());
    await session.prompt("Read large.txt three times.");
    expect(session.getLastAssistantText()).toBe("done");
    expect(sink.stats).toHaveLength(0);
    expect(sink.events).toEqual([expect.objectContaining({ type: "compaction_cancelled", reason: "threshold", cause: "reference_invalid", fallback: "stable" })]);
    expect(session.settingsManager.getCompactionSettings(session.model)).toMatchObject({ reserveTokens: 100_000 });
    expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("LINE-0 ");
  });

  it("loop guard: an early compaction that leaves too little room is not repeated; the stable policy takes over", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(200_000);
    f.faux.setResponses(Array(30).fill(script(undefined, 5)));
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    const bulky = "ESSENTIAL ".repeat(6_500);
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", sessionFile: join(cwd, "s.jsonl"),
      taskCompaction: workerCompaction({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000 }, "R1", sink, { essentials: () => bulky }) });
    disposers.push(() => session.dispose());
    await session.prompt("Read large.txt five times.");
    expect(session.getLastAssistantText()).toBe("done");
    expect(sink.stats).toHaveLength(1);
    expect(sink.stats[0]!.tokensAfter).toBeGreaterThan(16_384 - 2_457);
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "compaction_cancelled", cause: "loop_guard", fallback: "stable" }));
    expect(session.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
  });

  it("a failed summary is reported as compaction_failed and the original context stays", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(200_000);
    f.faux.setResponses(Array(30).fill(script(() => reply("", { stopReason: "error", errorMessage: "summary provider down" }))));
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", sessionFile: join(cwd, "s.jsonl"),
      taskCompaction: workerCompaction({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000 }, "R1", sink) });
    disposers.push(() => session.dispose());
    await session.prompt("Read large.txt three times.");
    expect(sink.stats).toHaveLength(0);
    expect(sink.events.some(event => event.type === "compaction_failed" && event.reason === "threshold")).toBe(true);
    expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("LINE-0 ");
  });

  it("summary budget in a task session: threshold summaries are told the essentials are restored; after a cut-off summary the next threshold compaction asks for less, and the essentials come back verbatim", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(200_000, 128_000);
    const prompts: string[] = [];
    let summaries = 0;
    // The first threshold compaction's history summary is cut off twice (the re-send included): Pi fails it and keeps the context.
    f.faux.setResponses(Array(40).fill(script(() => (summaries++ < 2 ? reply("PARTIAL", { stopReason: "length" }) : reply("SUMMARY")), 6)).map(step => ((context: Parameters<Exclude<FauxResponseStep, { role: string }>>[0], ...rest: unknown[]) => {
      if (isSummary(context)) prompts.push(JSON.stringify(context.messages.at(-1)));
      return (step as (...args: unknown[]) => ReturnType<typeof reply>)(context, ...rest);
    }) as FauxResponseStep));
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    const request = "R1: read large.txt\nOriginal request\nRead it six times.";
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", sessionFile: join(cwd, "s.jsonl"),
      taskCompaction: workerCompaction({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000 }, request, sink) });
    disposers.push(() => session.dispose());
    const stops: SummaryLengthStop[] = [];
    configureSummaryBudget(session, event => stops.push(event));
    await session.prompt("Read large.txt six times.");
    expect(session.getLastAssistantText()).toBe("done");
    const budgets = prompts.map(prompt => Number(/under about ([\d,]+) tokens/.exec(prompt)?.[1]?.replace(/,/g, "")));
    expect(budgets.length).toBeGreaterThan(2);
    expect(budgets.slice(0, 2)).toEqual([32_000, 16_000]); // the cut-off request and its immediate re-send
    expect(budgets.slice(2).every(budget => budget <= 8_000)).toBe(true); // later threshold compactions never repeat it
    expect(prompts.filter(prompt => prompt.includes("stopped at the response limit"))).toHaveLength(1);
    for (const prompt of prompts) expect(prompt).toContain('A message that starts with \\"Assignment in progress at compaction time (superseded by any later Assignment message)\\" is restored verbatim');
    expect(stops.map(stop => stop.retry)).toEqual([true, false]);
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "compaction_failed", reason: "threshold", errorMessage: expect.stringContaining("generation hit the token cap") }));
    expect(sink.stats.length).toBeGreaterThan(0);
    const compactions = session.sessionManager.getEntries().filter(entry => entry.type === "compaction");
    expect(compactions.every(entry => !entry.summary.includes("PARTIAL"))).toBe(true);
    // The assignment is restored verbatim from orche's state after every successful compaction, whatever the summary says.
    const restored = session.messages.filter(message => message.role === "custom").map(message => JSON.stringify(message));
    expect(restored.at(-1)).toContain(JSON.stringify(`Assignment in progress at compaction time (superseded by any later Assignment message):\nRequirements checklist and original request, verbatim:\n${request}`).slice(1, -1));
  });

  it("an essentials callback that fails after the compaction restores the text checked before it and records the error", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(200_000);
    f.faux.setResponses(Array(20).fill(script(undefined, 2)));
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    let calls = 0;
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", sessionFile: join(cwd, "s.jsonl"),
      taskCompaction: workerCompaction({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000 }, "R1", sink, { essentials: () => { if (calls++ % 2 === 1) throw new Error("ledger unavailable"); return "R1: PREFLIGHT ESSENTIALS"; } }) });
    disposers.push(() => session.dispose());
    await session.prompt("Read large.txt twice.");
    expect(sink.stats[0]).toMatchObject({ essentialsError: "ledger unavailable", essentialsChars: "R1: PREFLIGHT ESSENTIALS".length });
    expect(JSON.stringify(session.messages)).toContain("R1: PREFLIGHT ESSENTIALS");
  });

  it("stable default: the same session settings as before (50% of the window) and no preflight refusal", async () => {
    const f = await runtimeWith(200_000);
    const sink = { stats: [] as CompactionStats[], events: [] as CompactionEvent[] };
    const session = await createSession({ cwd: await temp(), route: f.route, modelRuntime: f.runtime, tools: [], instructions: "test", taskCompaction: workerCompaction("window-ratio", "R1", sink) });
    disposers.push(() => session.dispose());
    expect(session.settingsManager.getCompactionSettings(session.model)).toMatchObject({ enabled: true, reserveTokens: 100_000, keepRecentTokens: 20_000 });
    const plain = await createSession({ cwd: await temp(), route: f.route, modelRuntime: f.runtime, tools: [], instructions: "test" });
    disposers.push(() => plain.dispose());
    expect(plain.settingsManager.getCompactionSettings(plain.model).enabled).toBe(false);
  });
});

describe("orche_spawn sub-worker compaction", () => {
  async function runSub(compaction: unknown) {
    const cwd = await temp();
    await writeFile(join(cwd, "large.txt"), LARGE);
    const f = await runtimeWith(40_000);
    let step = 0;
    let restored = "";
    const respond: FauxResponseStep = context => {
      if (isSummary(context)) return reply("SUMMARY");
      if (step++ < 3) return tool("read", { path: "large.txt" });
      restored = JSON.stringify(context.messages);
      return tool("report_result", { kind: "answer", summary: "read it", data: { checklist: [{ id: "R1", status: "met", evidence: "large.txt:1", verifiedBy: "read large.txt" }] } });
    };
    f.faux.setResponses(Array(20).fill(respond));
    const runner = createSubWorkerRunner({
      orchestrator: "W1", cwd, runtime: f.runtime, route: f.route, routeSource: "orchestrator", thinkingSource: "orchestrator",
      specialistRoute: () => f.route, prompt: worker => `SUBTASK ${worker.request}`, timeoutMs: 60_000, maxTurns: 20, sessionFile: id => join(cwd, "sessions", `${id}.jsonl`),
      ...(compaction ? { compaction: parseWorkerCompaction(compaction) } : {}),
    });
    const outcome = await runner({ id: "W1.1", name: "reader", role: "answer", request: "R1: read large.txt and report", reason: "parallelism" }, [], new AbortController().signal, () => {});
    return { outcome, restored };
  }

  it("off by default: no compaction field and no compaction (a long sub-worker keeps Pi's disabled compaction, as before)", async () => {
    const { outcome } = await runSub(undefined);
    expect(outcome.compactions).toBeUndefined();
  });

  it("with workerCompaction.subWorkers the sub-worker compacts by its role's policy and gets back only its own assignment, work log and transcript", async () => {
    const { outcome, restored } = await runSub({ policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000, essentials: "extended", subWorkers: true });
    expect(outcome.status).toBe("done");
    expect(outcome.compactions).toBeGreaterThan(0);
    expect(restored).toContain("Your sub-worker assignment, verbatim");
    expect(restored).toContain("SUBTASK R1: read large.txt and report");
    expect(restored).toContain("W1.1.jsonl");
    expect(restored).not.toContain("Messages from main");
  });

  it("subWorkerCompaction essentials hold the sub-worker's prompt only (basic) and require the reference when extended", () => {
    const counters = { compactions: 0, cancelled: 0, failed: 0 };
    const basic = subWorkerCompaction(parseWorkerCompaction({ subWorkers: true }), "PROMPT", counters);
    const result = basic.essentials({ session: {} as never }) as { text: string; sections: string[]; missing: string[] };
    expect(result.sections).toEqual(["request"]);
    expect(basic.retrieval).toBe(false);
    const extended = subWorkerCompaction(parseWorkerCompaction({ subWorkers: true, essentials: "extended" }), "PROMPT", counters);
    expect((extended.essentials({ session: {} as never }) as { missing: string[] }).missing).toEqual(["reference"]);
  });
});
