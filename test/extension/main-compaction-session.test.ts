import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type Context, type FauxResponseStep } from "@earendil-works/pi-ai";
import { MAIN_COMPACTION_RESUME_TYPE } from "../../src/extension/main-compaction.js";
import { JOB_ENTRY_TYPE, TASK_RESULT_TYPE, type JobEntry } from "../../src/extension/jobs.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool } from "../../src/extension/workers.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

/**
 * `mainCompaction` end to end: a real AgentSession (Pi SDK, faux models) with the whole pi-orche extension loaded as `pi` loads it
 * (single mode, the harness's user config), Pi's own compaction on with a small reserve (500) so that the ratio decides.
 * Each session first measures main's base context (system prompt, tools, delegation rules) with one short exchange on a 1M-window
 * model; the model under test is then registered at run time with a window chosen so that one big prompt or read lands at a
 * known share of it. That exchange also gives every compaction an earlier turn to summarize.
 */
const opened: { dispose(): Promise<void> }[] = [];
/** Pi's compaction_end events of the sessions under test (reason, aborted, errorMessage), for assertions and diagnostics. */
const compactionEnds: { reason: string; aborted: boolean; errorMessage?: string }[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  compactionEnds.length = 0;
});
let serial = 0;

const isSummary = (context: Context) => JSON.stringify(context).includes("context summarization assistant");
/** ~45 KB, ~11K tokens. */
const BIG_LINES = Array.from({ length: 450 }, (_, i) => `ROW-${i} ${"y".repeat(85)}`);
const bigText = BIG_LINES.join("\n");
const PROMPT = `Keep this for later:\n${bigText}`;
/** What one prompt / one read of big.txt adds to Pi's estimate (chars / 4; the read output carries a short anchor per line). */
const PROMPT_TOKENS = Math.ceil(PROMPT.length / 4);
const READ_TOKENS = Math.ceil((bigText.length + BIG_LINES.length * 12) / 4);
/** A second, smaller prompt (~3K tokens). */
const SECOND = `And this too:\n${Array.from({ length: 120 }, (_, i) => `NOTE-${i} ${"z".repeat(90)}`).join("\n")}`;
const SECOND_TOKENS = Math.ceil(SECOND.length / 4);
const PI_SETTINGS = { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1_000 } };

interface Recorded { requests: string[]; summaries: number }
type Script = (request: number, context: Context) => ReturnType<typeof reply>;
/** A faux main model: each request is recorded; a summary request answers SUMMARY, the rest follow `script`. */
function mainModel(id: string, contextWindow: number, script: Script) {
  const faux = fauxProvider({ provider: `main-ratio-${++serial}`, models: [{ id, contextWindow, maxTokens: 2_000 }] });
  const recorded: Recorded = { requests: [], summaries: 0 };
  const step: FauxResponseStep = context => {
    if (isSummary(context)) { recorded.summaries++; return reply("SUMMARY of the earlier turns"); }
    recorded.requests.push(JSON.stringify(context.messages));
    return script(recorded.requests.length, context);
  };
  faux.setResponses(Array(20).fill(step));
  return { faux, recorded, id };
}
type MainModel = ReturnType<typeof mainModel>;

async function useModel(h: Harness, entry: MainModel) {
  expect(await h.session.setModel(h.runtime.getModel(entry.faux.provider.id, entry.id)!)).not.toBe(false);
}
/** Registers `entry` in the running session's model registry (as a newly released model would appear) and switches to it. */
async function switchTo(h: Harness, entry: MainModel) {
  h.runtime.registerNativeProvider(entry.faux.provider);
  await useModel(h, entry);
}

async function mainSession(options: { settings?: Record<string, unknown>; mode?: "tui" | "rpc" | "print"; beforeCalibration?: (h: Harness) => Promise<void>; orcheSteps?: FauxResponseStep[] } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: options.orcheSteps ?? [], mode: options.mode ?? "tui", settings: options.settings ?? PI_SETTINGS, ...(options.orcheSteps ? { single: { spawn: false } } : {}) });
  opened.push(h);
  h.session.subscribe(event => { if (event.type === "compaction_end") compactionEnds.push({ reason: event.reason, aborted: event.aborted, ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}) }); });
  await writeFile(join(h.cwd, "big.txt"), bigText);
  await options.beforeCalibration?.(h);
  await switchTo(h, mainModel("probe-1m", 1_000_000, () => reply("ok")));
  await h.session.prompt("hi");
  await settled(h);
  const base = h.session.getContextUsage()?.tokens;
  expect(base).toBeGreaterThan(0);
  /** A window in which the base context plus `added` tokens uses `share` of it. */
  const windowFor = (added: number, share: number) => Math.round((base! + added) / share);
  return { h, base: base!, windowFor };
}

/** Until Pi is idle with no compaction and `until` holds, twice in a row (the extension's 0 ms timers have run). */
async function settled(h: Harness, until: () => boolean = () => true, timeoutMs = 5_000) {
  const start = Date.now();
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (h.session.isIdle && !h.session.isCompacting && until()) {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (h.session.isIdle && !h.session.isCompacting && until()) return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`session did not settle: usage=${JSON.stringify(h.session.getContextUsage())} entries=${JSON.stringify(entries(h).map(entry => [entry.type, entry.customType ?? entry.message?.role, entry.message?.stopReason, JSON.stringify(entry.message?.content ?? "").slice(0, 50)]))} notes=${JSON.stringify(h.notifications.map(note => note.message.slice(0, 120)))} compactionEnds=${JSON.stringify(compactionEnds)}`);
    }
  }
}
const entries = (h: Harness) => h.session.sessionManager.getBranch() as unknown as { type: string; customType?: string; message?: { role: string; toolName?: string; stopReason?: string; content?: unknown } }[];
const compactions = (h: Harness) => entries(h).filter(entry => entry.type === "compaction");
const resumeNotes = (h: Harness) => entries(h).filter(entry => entry.type === "custom_message" && entry.customType === MAIN_COMPACTION_RESUME_TYPE);
const toolRuns = (h: Harness, name: string) => entries(h).filter(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === name);
const lastText = (h: Harness) => JSON.stringify(entries(h).filter(entry => entry.message?.role === "assistant").at(-1)?.message?.content ?? "");
const errorResponses = (h: Harness) => entries(h).filter(entry => entry.message?.role === "assistant" && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted"));

describe("mainCompaction (main session, full extension)", () => {
  it("mid-run: a tool loop above 80% compacts once, the response continues and finishes, no tool runs twice", async () => {
    const { h, windowFor } = await mainSession();
    const main = mainModel("main", windowFor(READ_TOKENS, 0.88), (request, context) => {
      if (request === 1) return tool("read", { path: "big.txt" });
      // The continuation: the note is there and the big tool output is summarized away.
      const text = JSON.stringify(context.messages);
      expect(text).toContain("[orche] Main's context passed the mainCompaction limit");
      expect(text).not.toContain("ROW-200 ");
      return reply("done after compaction");
    });
    await switchTo(h, main);
    await h.session.prompt("Read big.txt and tell me what it holds.");
    await settled(h, () => lastText(h).includes("done after compaction"));
    expect(compactions(h)).toHaveLength(1);
    expect(compactionEnds).toEqual([{ reason: "manual", aborted: false }]);
    expect(main.recorded.summaries).toBeGreaterThanOrEqual(1);
    expect(resumeNotes(h)).toHaveLength(1);
    expect(toolRuns(h, "read")).toHaveLength(1);
    expect(main.recorded.requests).toHaveLength(2);
    // The interrupted request never reached the provider: one aborted response is all the abort leaves.
    expect(errorResponses(h)).toHaveLength(1);
    expect(h.notifications.some(note => note.message.includes("above mainCompaction 80%") && note.message.includes("continues after the summary"))).toBe(true);
  });

  it("a one-shot /orche request is never interrupted: it finishes in its own mode, then main compacts while idle", async () => {
    const { h, windowFor } = await mainSession();
    const main = mainModel("main", windowFor(READ_TOKENS, 0.88), request => request === 1 ? tool("read", { path: "big.txt" }) : reply("one-shot done"));
    await switchTo(h, main);
    await h.session.prompt("/orche direct Read big.txt and summarize it.");
    await settled(h, () => compactions(h).length > 0);
    expect(lastText(h)).toContain("one-shot done");
    expect(main.recorded.requests).toHaveLength(2);
    expect(errorResponses(h)).toHaveLength(0);
    expect(resumeNotes(h)).toHaveLength(0);
    expect(toolRuns(h, "read")).toHaveLength(1);
    expect(compactionEnds).toEqual([{ reason: "manual", aborted: false }]);
    // The one-shot override ended with its run, not with a compaction abort.
    expect(h.statuses.filter(status => status.key === "orche-mode").at(-1)?.text).toBe("orche: single");
  });

  it("at a run's end: the run that takes main above 80% is compacted while idle, without a continuation, and only once", async () => {
    const { h, windowFor } = await mainSession();
    // PROMPT alone stays below 80%; SECOND takes main to ~88% at the end of the second run.
    const main = mainModel("main", windowFor(PROMPT_TOKENS + SECOND_TOKENS, 0.88), () => reply("noted"));
    await switchTo(h, main);
    await h.session.prompt(PROMPT);
    await settled(h);
    expect(compactions(h)).toHaveLength(0);
    await h.session.prompt(SECOND);
    await settled(h, () => compactions(h).length > 0);
    expect(compactions(h)).toHaveLength(1);
    expect(compactionEnds).toEqual([{ reason: "manual", aborted: false }]);
    expect(resumeNotes(h)).toHaveLength(0);
    expect(errorResponses(h)).toHaveLength(0);
    expect(main.recorded.requests).toHaveLength(2);
    // The next prompt starts from the summary (the big prompt is summarized away): no new compaction.
    await h.session.prompt("And now?");
    await settled(h);
    expect(compactions(h)).toHaveLength(1);
    expect(main.recorded.requests.at(-1)).not.toContain("ROW-200 ");
  });

  it("loop guard: when Pi's summary leaves main above 80% (it keeps the latest big message verbatim), the ratio does not compact again", async () => {
    const { h, windowFor } = await mainSession();
    const window = windowFor(PROMPT_TOKENS, 0.88);
    const main = mainModel("main", window, () => reply("noted"));
    await switchTo(h, main);
    await h.session.prompt(PROMPT);
    await settled(h, () => compactions(h).length > 0);
    expect(compactions(h)).toHaveLength(1);
    for (const prompt of ["And now?", "Once more."]) {
      await h.session.prompt(prompt);
      await settled(h);
    }
    expect(h.session.getContextUsage()!.tokens!).toBeGreaterThan(window * 0.8);
    expect(compactions(h)).toHaveLength(1);
    expect(compactionEnds).toHaveLength(1);
  });

  it("below 80% nothing compacts (and Pi's own threshold is not reached either)", async () => {
    const { h, windowFor } = await mainSession();
    const main = mainModel("main", windowFor(PROMPT_TOKENS, 0.7), () => reply("noted"));
    await switchTo(h, main);
    await h.session.prompt(PROMPT);
    await settled(h);
    expect(compactions(h)).toHaveLength(0);
    expect(main.recorded.summaries).toBe(0);
  });

  it("the threshold follows the current model: a model registered at run time, then a switch to a smaller window while idle", async () => {
    const { h, windowFor } = await mainSession();
    const wide = mainModel("released-today", windowFor(PROMPT_TOKENS, 0.4), () => reply("noted"));
    const narrow = mainModel("narrow", windowFor(PROMPT_TOKENS, 0.88), () => reply("noted"));
    await switchTo(h, wide);
    await h.session.prompt(PROMPT);
    await settled(h);
    expect(compactions(h)).toHaveLength(0); // 40% of the new model's window
    await switchTo(h, narrow);
    await settled(h, () => compactions(h).length > 0);
    expect(compactions(h)).toHaveLength(1); // 88% of the smaller one
    expect(narrow.recorded.summaries).toBeGreaterThanOrEqual(1); // summarized by the current model, as /compact does
    expect(wide.recorded.summaries).toBe(0);
  });

  it("mainCompaction false leaves Pi's own settings alone; a trusted project file wins over the user file", async () => {
    const { h, windowFor } = await mainSession({
      beforeCalibration: async h => {
        const user = JSON.parse(await readFile(join(h.agentDir, "orche.config.json"), "utf8")) as Record<string, unknown>;
        await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ ...user, mainCompaction: false }));
        await h.session.reload();
      },
    });
    const main = mainModel("main", windowFor(PROMPT_TOKENS, 0.88), () => reply("noted"));
    await switchTo(h, main);
    await h.session.prompt(PROMPT);
    await settled(h);
    expect(compactions(h)).toHaveLength(0);
    // A trusted project config is used as a whole: its mainCompaction (the default ratio) applies again.
    await mkdir(join(h.cwd, ".pi"), { recursive: true });
    await writeFile(join(h.cwd, ".pi", "orche.config.json"), JSON.stringify({ routes: {}, records: { enabled: false }, mainMode: "single", mainCompaction: { usageRatio: 0.8 } }));
    expect(h.session.settingsManager.isProjectTrusted()).toBe(true);
    await h.session.reload();
    await h.session.prompt("One more line.");
    await settled(h, () => compactions(h).length > 0);
    expect(compactions(h)).toHaveLength(1);
  });

  it("an untrusted project file is ignored (the user's mainCompaction false applies)", async () => {
    const { h, windowFor } = await mainSession({
      beforeCalibration: async h => {
        const user = JSON.parse(await readFile(join(h.agentDir, "orche.config.json"), "utf8")) as Record<string, unknown>;
        await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ ...user, mainCompaction: false }));
        await mkdir(join(h.cwd, ".pi"), { recursive: true });
        await writeFile(join(h.cwd, ".pi", "orche.config.json"), JSON.stringify({ routes: {}, records: { enabled: false }, mainMode: "single", mainCompaction: true }));
        h.session.settingsManager.setProjectTrusted(false);
        await h.session.reload();
      },
    });
    const main = mainModel("main", windowFor(PROMPT_TOKENS, 0.88), () => reply("noted"));
    await switchTo(h, main);
    await h.session.prompt(PROMPT);
    await settled(h);
    expect(compactions(h)).toHaveLength(0);
  });

  it("Pi's compaction.enabled false turns the ratio off too; print mode keeps Pi's own behaviour only", async () => {
    const off = await mainSession({ settings: { compaction: { enabled: false } } });
    const offMain = mainModel("main", off.windowFor(PROMPT_TOKENS, 0.88), () => reply("noted"));
    await switchTo(off.h, offMain);
    await off.h.session.prompt(PROMPT);
    await settled(off.h);
    expect(compactions(off.h)).toHaveLength(0);
    const print = await mainSession({ mode: "print" });
    const printMain = mainModel("main", print.windowFor(PROMPT_TOKENS, 0.88), () => reply("noted"));
    await switchTo(print.h, printMain);
    await print.h.session.prompt(PROMPT);
    await settled(print.h);
    expect(compactions(print.h)).toHaveLength(0);
  });

  it("an earlier Pi threshold (a reserve above 20% of the window) still compacts first, natively and without interrupting", async () => {
    const { h, windowFor } = await mainSession();
    const window = windowFor(READ_TOKENS, 0.88);
    // Pi's own reserve of 30% → Pi compacts above 70%, before the 80% ratio; the ratio leaves that turn to Pi.
    h.session.settingsManager.applyOverrides({ compaction: { reserveTokens: Math.round(window * 0.3) } });
    const main = mainModel("main", window, request => request === 1 ? tool("read", { path: "big.txt" }) : reply("done"));
    await switchTo(h, main);
    await h.session.prompt("Read big.txt.");
    await settled(h, () => lastText(h).includes("done"));
    // Only Pi's own threshold acts: mid-run before the next request (no interruption), and again after the run while its 70% is
    // still crossed (Pi keeps the big tool result verbatim at the first cut). The ratio never adds a compaction of its own.
    expect(compactionEnds.length).toBeGreaterThanOrEqual(1);
    expect(compactionEnds.every(end => end.reason === "threshold" && !end.aborted)).toBe(true);
    expect(compactions(h)).toHaveLength(compactionEnds.length);
    expect(resumeNotes(h)).toHaveLength(0);
    expect(errorResponses(h)).toHaveLength(0);
    expect(toolRuns(h, "read")).toHaveLength(1);
  });

  it("the user cancelling the summary stops the interrupted response for good (no continuation, no retry)", async () => {
    const { h, windowFor } = await mainSession();
    const main = mainModel("main", windowFor(READ_TOKENS, 0.88), () => reply("unused"));
    let requests = 0;
    main.faux.setResponses(Array(10).fill((async (context, options) => {
      if (isSummary(context)) {
        // Held until the user's Esc (Pi aborts the compaction) arrives.
        await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); options?.signal?.addEventListener("abort", () => resolve(), { once: true }); setTimeout(resolve, 3_000); });
        return reply("late summary");
      }
      requests++;
      return requests === 1 ? tool("read", { path: "big.txt" }) : reply("should not run");
    }) as FauxResponseStep));
    h.session.subscribe(event => { if (event.type === "compaction_start") setTimeout(() => h.session.abortCompaction(), 10); });
    await switchTo(h, main);
    await h.session.prompt("Read big.txt.");
    await settled(h, () => compactionEnds.length > 0);
    expect(compactionEnds).toEqual([{ reason: "manual", aborted: true }]);
    expect(compactions(h)).toHaveLength(0);
    expect(resumeNotes(h)).toHaveLength(0);
    expect(requests).toBe(1);
    // Not retried at the next boundary either (only new user input re-arms it).
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(compactionEnds).toHaveLength(1);
  });
});

/**
 * A background orche_task result that arrives while main's automatic compaction is pending: two barriers, the summary request
 * held open and the worker released through its gate meanwhile. Pi itself would start the result's turn beside the summary.
 */
describe("mainCompaction and background task results", () => {
  const workerReport = tool("report_result", { kind: "answer", summary: "greeting.txt says hello world", data: { evidence: ["greeting.txt:1"] } });
  /** ~11K tokens of assistant text: the run that started the job ends above 80%, its tool turn stayed below. */
  const bigReply = `Started J1. Meanwhile, the data you asked about:\n${bigText}`;
  const REPLY_TOKENS = Math.ceil(bigReply.length / 4);
  const taskResults = (h: Harness) => entries(h).filter(entry => entry.type === "custom_message" && entry.customType === TASK_RESULT_TYPE);
  const jobEnded = (h: Harness) => entries(h).some(entry => entry.type === "custom" && entry.customType === JOB_ENTRY_TYPE && (entry as unknown as { data: JobEntry }).data.event === "end");

  async function scenario() {
    const workerEntered = deferred(), workerGate = deferred(), summaryEntered = deferred(), summaryGate = deferred();
    const { h, windowFor } = await mainSession({
      orcheSteps: [async () => { workerEntered.resolve(); await workerGate.promise; return workerReport; }],
    });
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    /** Main requests (not summaries) and whether Pi was compacting when each was made: never, if nothing overlaps. */
    const mainRequests: { compacting: boolean; text: string }[] = [];
    let summaries = 0;
    const faux = fauxProvider({ provider: `main-ratio-${++serial}`, models: [{ id: "main", contextWindow: windowFor(REPLY_TOKENS + 300, 0.88), maxTokens: 2_000 }] });
    faux.setResponses(Array(10).fill((async (context, options) => {
      if (isSummary(context)) {
        summaries++;
        summaryEntered.resolve();
        await new Promise<void>(resolve => { summaryGate.promise.then(() => resolve()); options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
        return reply("SUMMARY of the earlier turns");
      }
      mainRequests.push({ compacting: h.session.isCompacting, text: JSON.stringify(context.messages) });
      if (mainRequests.length === 1) return tool("orche_task", { role: "answer", request: "What does greeting.txt say?", wait: false });
      if (mainRequests.length === 2) return reply(bigReply);
      return reply("Reviewed J1: greeting checked.");
    }) as FauxResponseStep));
    h.runtime.registerNativeProvider(faux.provider);
    expect(await h.session.setModel(h.runtime.getModel(faux.provider.id, "main")!)).not.toBe(false);
    await h.session.prompt("Check the greeting in the background.");
    await workerEntered.promise;
    // The run ended above 80%: the automatic compaction is pending, its summary request held open.
    await summaryEntered.promise;
    expect(h.session.isCompacting).toBe(true);
    expect(mainRequests).toHaveLength(2);
    // The worker finishes now; orche delivers its result (the job-end notice says so) while the compaction still runs.
    workerGate.resolve();
    await vi.waitFor(() => expect(jobEnded(h) && h.notifications.some(note => note.message.includes("its result was delivered as a message"))).toBe(true), { timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.session.isCompacting).toBe(true);
    expect(h.session.isStreaming).toBe(false);
    expect(mainRequests).toHaveLength(2);
    expect(taskResults(h)).toHaveLength(0);
    return { h, mainRequests, summaryGate, summaries: () => summaries };
  }

  it("the result is held until the compaction returned, then delivered once and consumed by one run (no overlap)", async () => {
    const { h, mainRequests, summaryGate, summaries } = await scenario();
    summaryGate.resolve();
    await settled(h, () => lastText(h).includes("Reviewed J1"));
    expect(compactionEnds).toEqual([{ reason: "manual", aborted: false }]);
    expect(compactions(h)).toHaveLength(1);
    expect(summaries()).toBeGreaterThanOrEqual(1); // Pi may summarize a split turn's prefix separately (same compaction)
    expect(taskResults(h)).toHaveLength(1);
    expect(mainRequests).toHaveLength(3);
    expect(mainRequests.every(request => !request.compacting)).toBe(true);
    expect(mainRequests[2]!.text).toContain("orche task result · J1");
    expect(mainRequests[2]!.text).toContain("SUMMARY of the earlier turns");
    expect(errorResponses(h)).toHaveLength(0);
    // Nothing else follows: one result, one run.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mainRequests).toHaveLength(3);
    expect(taskResults(h)).toHaveLength(1);
  });

  it("Esc during that summary: the held result is shown once without starting a turn; the next prompt sees it", async () => {
    const { h, mainRequests, summaryGate } = await scenario();
    h.session.abortCompaction();
    await settled(h, () => compactionEnds.length > 0 && taskResults(h).length > 0);
    expect(compactionEnds).toEqual([{ reason: "manual", aborted: true }]);
    expect(compactions(h)).toHaveLength(0);
    expect(taskResults(h)).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mainRequests).toHaveLength(2);
    expect(resumeNotes(h)).toHaveLength(0);
    // New input re-arms the ratio: the next idle check may compact again, so the summary model answers from now on.
    summaryGate.resolve();
    await h.session.prompt("What came back?");
    await settled(h, () => mainRequests.length === 3);
    expect(mainRequests[2]!.text).toContain("orche task result · J1");
    expect(taskResults(h)).toHaveLength(1);
  });
});

describe("workers are unchanged by mainCompaction", () => {
  it("a single-mode worker keeps its 50% policy and never gets main's ratio handling", async () => {
    const { h } = await mainSession();
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const pool = new WorkerPool({ controller, agentDir: h.agentDir });
    opened.push(pool);
    const worker = fauxProvider({ provider: `worker-ratio-${++serial}`, models: [{ id: "w", contextWindow: 40_000, maxTokens: 4_096 }] });
    h.runtime.registerNativeProvider(worker.provider);
    let step = 0;
    worker.setResponses(Array(20).fill((context => {
      if (isSummary(context)) return reply("SUMMARY");
      step++;
      return step <= 2 ? tool("read", { path: "big.txt" }) : tool("report_result", { kind: "answer", summary: "big.txt holds rows", data: { evidence: ["big.txt"] } });
    }) as FauxResponseStep));
    const result = await pool.execute({ role: "answer", request: "What does big.txt hold?", cwd: h.cwd, projectTrusted: false, mainMode: "single", model: worker.getModel() });
    expect(result.text).toContain("big.txt holds rows");
    const session = pool.session("W1");
    expect(session.settingsManager.getCompactionSettings(session.model)).toMatchObject({ enabled: true, reserveTokens: 20_000 });
    const branch = session.sessionManager.getBranch() as unknown as { type: string; customType?: string }[];
    // The worker compacted natively at its own 50% (two ~11K reads in a 40K window), never through main's ratio path.
    expect(branch.filter(entry => entry.type === "compaction").length).toBeGreaterThanOrEqual(1);
    expect(branch.some(entry => entry.type === "custom_message" && entry.customType === MAIN_COMPACTION_RESUME_TYPE)).toBe(false);
  });
});
