/**
 * `--effort <LEVEL>` of a one-shot `/orche <mode> <PROMPT>` (docs/orchestrator.md 14.5): the grammar and its feedback, the level the
 * request's orche_task assignments run at (what the provider receives, after Pi's clamp) and how tiers, children and later assignments
 * relate to it, and direct mode, where main itself runs the request at it. Models are faux providers (no external API).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { busyRefusal, EFFORT_LEVELS, effortUsage, ORCHE_USAGE, oneShotUsage, parseOrcheCommand } from "../../src/extension/index.js";
import { completeOrcheArguments, orcheCompletions } from "../../src/extension/completions.js";
import { MODE_ENTRY_TYPE } from "../../src/extension/mode.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { MAIN_MODES } from "../../src/orchestration/routing.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";
import { summaryBudgetProfile } from "../../src/pi/summary-budget.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); });

/** Reasoning faux models (a level other than off is kept, `xhigh`/`max` clamp to `high`) or a model without reasoning (always off). */
const tierProvider = (provider: string, id: string, reasoning = true) => fauxProvider({ provider, models: [{ id, reasoning }] });
/** A step that records the thinking level the provider received for its request (`options.reasoning`; absent = off). */
const observed = (seen: string[], step: FauxResponseStep): FauxResponseFactory => (context, options, state, model) => {
  seen.push(options?.reasoning ?? "off");
  return typeof step === "function" ? step(context, options, state, model) : step;
};
const answered = (summary: string) => tool("report_result", { kind: "answer", summary, data: { evidence: ["greeting.txt:1"] } });
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says hello.\nOriginal request\n인사말을 고쳐줘. 독립 검증도 해줘.";
const spawnVerifier = () => tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] });
const verified = () => tool("report_result", { kind: "verify", summary: "greeting.txt says hello", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } });
const implemented = (split = true) => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: split ? { decision: "split", criteria: ["verification"], reason: "the user asked for an independent check" } : { decision: "none", reason: "small" } } });
const runJson = async (record: string) => JSON.parse(await readFile(join(record, "run.json"), "utf8")) as { assignment: Record<string, unknown>; outcome: Record<string, unknown> };
const ONE_SHOT = { session: "single" as const };

describe("--effort: grammar and feedback", () => {
  it("parses --effort LEVEL and --effort=LEVEL right after the mode word for every mode and level; the prompt after ONE delimiter stays verbatim", () => {
    for (const mode of MAIN_MODES) for (const effort of EFFORT_LEVELS) {
      expect(parseOrcheCommand(`${mode} --effort ${effort} fix the bug`)).toEqual({ mode, prompt: "fix the bug", effort });
      expect(parseOrcheCommand(`${mode} --effort=${effort} fix the bug`)).toEqual({ mode, prompt: "fix the bug", effort });
    }
    const prompt = '  fix "src/a b.ts"\n\t- keep \'quotes\' / slashes --effort low\n trailing \t\n';
    expect(parseOrcheCommand(`ultra --effort xhigh ${prompt}`)).toEqual({ mode: "ultra", prompt, effort: "xhigh" });
    expect(parseOrcheCommand(`strong --effort max\n${prompt}`)).toEqual({ mode: "strong", prompt, effort: "max" });
    // Whitespace before the option (and between it and its level) only separates; after the level one character delimits as after the mode word.
    expect(parseOrcheCommand("  single   --effort\tlow  two spaces")).toEqual({ mode: "single", prompt: " two spaces", effort: "low" });
    expect(parseOrcheCommand("direct\n--effort off\nline one\nline two")).toEqual({ mode: "direct", prompt: "line one\nline two", effort: "off" });
  });

  it("without a leading --effort the prompt is exactly what it was before: dash text, mid-prompt options and look-alikes are prompt text", () => {
    for (const rest of ["explain --effort high", "-- fix it", "--efforts are fine", "--effort-level high", "--effortless", "  -x --effort low", "/orche single --effort low"]) {
      expect(parseOrcheCommand(`single ${rest}`)).toEqual({ mode: "single", prompt: rest });
      expect(parseOrcheCommand(`single ${rest}`)).not.toHaveProperty("effort");
    }
    expect(parseOrcheCommand("single fix the bug")).toEqual({ mode: "single", prompt: "fix the bug" });
  });

  it("-- after the level ends the options, so the prompt itself may start with --effort or --", () => {
    expect(parseOrcheCommand("single --effort low -- --effort is a CLI flag")).toEqual({ mode: "single", prompt: "--effort is a CLI flag", effort: "low" });
    expect(parseOrcheCommand("single --effort=low --\n-- keep  this")).toEqual({ mode: "single", prompt: "-- keep  this", effort: "low" });
    expect(parseOrcheCommand("single --effort low --  two")).toEqual({ mode: "single", prompt: " two", effort: "low" });
    expect(parseOrcheCommand("single --effort low   -- --x")).toEqual({ mode: "single", prompt: "--x", effort: "low" });
  });

  it("an unusable --effort starts nothing and says what is wrong and what to type; other failures keep their usage", () => {
    const cases: [string, string][] = [
      ["single --effort", "orche single: --effort needs a level. Valid values: off, minimal, low, medium, high, xhigh, max"],
      ["single --effort=   fix", "orche single: --effort needs a level."],
      ["strong --effort HIGH fix", 'orche strong: invalid --effort "HIGH". Valid values: off, minimal, low, medium, high, xhigh, max'],
      ["ultra --effort turbo fix it", 'orche ultra: invalid --effort "turbo".'],
      ["single --effort high,fix", 'orche single: invalid --effort "high,fix".'],
      ["ultra --effort high", "orche ultra: no prompt after --effort high. Usage: /orche ultra --effort <LEVEL> <PROMPT>"],
      ["mdsd --effort=max \n\t ", "orche mdsd: no prompt after --effort max."],
      ["direct --effort low --", "orche direct: no prompt after --effort low."],
      ["single --effort high --effort low fix", 'orche single: --effort is given more than once; give it once. To start the prompt itself with "--effort", put -- before the prompt: /orche single --effort high -- <PROMPT>.'],
      ["--effort high single fix", "orche: --effort belongs to a one-shot request, right after its mode word: /orche single|strong|ultra|mdsd|direct --effort <LEVEL> <PROMPT>"],
      ["mode ultra --effort high", "/orche mode and the other subcommands do not take it."],
      ["workers --effort=low", "orche: --effort belongs to a one-shot request"],
    ];
    for (const [input, message] of cases) {
      expect(parseOrcheCommand(input), input).toBeUndefined();
      expect(effortUsage(input), input).toContain(message);
      expect(effortUsage(input), input).toContain("Nothing was sent.");
    }
    for (const input of ["", "ultra", "single   ", "fix it", "mode turbo", "stop"]) expect(effortUsage(input), input).toBeUndefined();
    // Prompts that merely mention --effort parse, so effortUsage is never asked about them.
    expect(parseOrcheCommand("single explain --effort high")).toBeDefined();
  });

  it("help texts name the option: the usage line, the one-shot usage and the command description", () => {
    expect(ORCHE_USAGE).toContain("Usage: /orche single|strong|ultra|mdsd|direct [--effort LEVEL] <PROMPT> |");
    expect(oneShotUsage("ultra")).toContain("Usage: /orche ultra [--effort LEVEL] <PROMPT>:");
    expect(oneShotUsage("ultra")).toContain("--effort off|minimal|low|medium|high|xhigh|max sets the reasoning effort its workers start at");
  });

  it("completions: <mode> -- offers <mode> --effort <level> for every level; a plain <mode> stays a free prompt; each candidate parses with a prompt", () => {
    const values = (prefix: string) => completeOrcheArguments(prefix)?.map(item => item.value) ?? null;
    expect(values("single --")).toEqual(EFFORT_LEVELS.map(level => `single --effort ${level} `));
    expect(values("strong --effort h")).toEqual(["strong --effort high "]);
    expect(values("ultra --effort=")).toBeNull();
    expect(values("single ")).toBeNull();
    expect(values("single --effort high ")).toBeNull();
    expect(values("single --effort high fix")).toBeNull();
    expect(orcheCompletions().some(item => item.value.includes("--effort"))).toBe(false);
    for (const mode of MAIN_MODES) for (const value of values(`${mode} --`)!) expect(parseOrcheCommand(`${value}do it`)).toMatchObject({ mode, prompt: "do it" });
  });
});

describe("--summary-budget: grammar", () => {
  it("parses with or without --effort, in any order, each once; -- ends the options; the old --thinking-policy is prompt text", () => {
    expect(parseOrcheCommand("strong --summary-budget compact fix it")).toEqual({ mode: "strong", prompt: "fix it", summaryBudget: "compact" });
    expect(parseOrcheCommand("strong --effort=max --summary-budget=compact fix it")).toEqual({ mode: "strong", prompt: "fix it", effort: "max", summaryBudget: "compact" });
    expect(parseOrcheCommand("ultra --summary-budget standard\t--effort low -- --effort is text")).toEqual({ mode: "ultra", prompt: "--effort is text", effort: "low", summaryBudget: "standard" });
    expect(parseOrcheCommand("strong --thinking-policy=phase fix")).toEqual({ mode: "strong", prompt: "--thinking-policy=phase fix" });
    const cases: [string, string][] = [
      ["strong --summary-budget tiny fix", 'orche strong: invalid --summary-budget "tiny". Valid values: standard, compact'],
      ["strong --summary-budget", "orche strong: --summary-budget needs a value."],
      ["strong --summary-budget compact --summary-budget standard x", "orche strong: --summary-budget is given more than once; give it once."],
      ["strong --effort max --summary-budget compact", "orche strong: no prompt after --effort max --summary-budget compact."],
      ["direct --summary-budget compact fix", "orche direct: --summary-budget applies to orche_task workers and direct mode runs none"],
      ["mode strong --summary-budget compact", "orche: --summary-budget belongs to a one-shot request"],
    ];
    for (const [input, message] of cases) {
      expect(parseOrcheCommand(input), input).toBeUndefined();
      expect(effortUsage(input), input).toContain(message);
      expect(effortUsage(input), input).toContain("Nothing was sent.");
    }
  });
});

/** A WorkerPool on a real Pi model runtime (faux providers), its config written as given. */
async function fixture(config: { models?: Record<string, unknown>; routes?: Record<string, unknown>; single?: Record<string, unknown>; default?: Record<string, unknown>; records?: boolean } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [], records: config.records ?? false });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({
    routes: config.routes ?? {}, default: config.default ?? { model: h.orche.route.model }, records: config.records ? {} : { enabled: false }, mainMode: "single",
    ...(config.models ? { models: config.models } : {}), ...(config.single ? { single: config.single } : {}),
  }));
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir });
  opened.push(pool);
  // Main's model at the hand-off: a reasoning model on high.
  const mainFaux = tierProvider("main-reasoning", "current");
  h.runtime.registerNativeProvider(mainFaux.provider);
  const register = (...providers: ReturnType<typeof tierProvider>[]) => { for (const provider of providers) h.runtime.registerNativeProvider(provider.provider); };
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: mainFaux.getModel(), thinking: "high", ...args });
  return { h, pool, execute, register, mainFaux };
}

describe("--effort: the request's orche_task assignments", () => {
  it("replaces the orchestrator tier's own level for the request only; the provider receives it; a later assignment of the same worker runs at the tier's level again", async () => {
    const orchestrator = tierProvider("tier-orch", "o1");
    const { execute, register, h } = await fixture({ records: true, models: { orchestrator: { model: "tier-orch/o1", thinking: "high" } } });
    register(orchestrator);
    const seen: string[] = [];
    orchestrator.setResponses([observed(seen, implemented(false)), observed(seen, implemented(false))]);
    const first = await execute({ oneShot: { ...ONE_SHOT, effort: "low" } });
    expect(first.details).toMatchObject({ worker: "W1", model: "tier-orch/o1", thinking: "low", thinkingSource: "effort", requestMode: { mode: "single", source: "one-shot", effort: "low" } });
    expect(first.text).toContain("Effort: low (one-shot /orche single --effort low): W1 runs at low; sub-workers and the advisor follow it unless their models tier sets a level of its own. Later requests, and this worker's or task's continuations, run at the usual levels.");
    expect((await runJson(first.details.record!)).assignment).toMatchObject({ thinking: "low", thinkingSource: "effort", requestMode: { effort: "low" } });
    const later = await execute({ worker: "W1" });
    expect(later.details).toMatchObject({ worker: "W1", thinking: "high", thinkingSource: "config" });
    expect(later.details.requestMode).toBeUndefined();
    expect(later.text).not.toContain("Effort:");
    expect(seen).toEqual(["low", "high"]);
    expect(h.notifications).toEqual([]);
  });

  it("bypasses the implicit floor (an explicit choice may lower) and raises above main; omitted, nothing changes (regression)", async () => {
    const { execute, mainFaux } = await fixture();
    const seen: string[] = [];
    mainFaux.setResponses([observed(seen, implemented(false)), observed(seen, implemented(false)), observed(seen, implemented(false))]);
    // Main lowered to low, floor high: an inheriting orchestrator runs high; --effort minimal runs minimal, --effort xhigh clamps to high.
    const floored = await execute({ thinking: "low", inheritedThinking: "high" });
    expect(floored.details).toMatchObject({ thinking: "high", thinkingSource: "main" });
    expect(floored.details.requestMode).toBeUndefined();
    const lowered = await execute({ thinking: "low", inheritedThinking: "high", oneShot: { ...ONE_SHOT, effort: "minimal" } });
    expect(lowered.details).toMatchObject({ thinking: "minimal", thinkingSource: "effort" });
    const raised = await execute({ thinking: "low", inheritedThinking: "high", oneShot: { ...ONE_SHOT, effort: "xhigh" } });
    expect(raised.details).toMatchObject({ thinking: "high", thinkingSource: "effort", requestMode: { effort: "xhigh" } });
    expect(raised.text).toContain("Effort: xhigh (one-shot /orche single --effort xhigh): W3 runs at high (the nearest level its model supports);");
    expect(seen).toEqual(["high", "minimal", "high"]);
  });

  it("a model without reasoning runs off whatever the effort, and the result says so", async () => {
    const plain = tierProvider("plain", "p1", false);
    const { execute, register } = await fixture({ models: { orchestrator: { model: "plain/p1" } } });
    register(plain);
    plain.setResponses([implemented(false)]);
    const result = await execute({ oneShot: { ...ONE_SHOT, effort: "max" } });
    expect(result.details).toMatchObject({ model: "plain/p1", thinking: "off", thinkingSource: "effort" });
    expect(result.text).toContain("W1 runs at off (the nearest level its model supports)");
  });

  it("children: sub-workers inheriting the orchestrator and tiers naming main's thinking take the effort; a tier's own level stays", async () => {
    for (const [workerTier, expected] of [
      [undefined, ["tier-orch/o1", "low", "orchestrator"]],
      [{ model: "tier-worker/w1", thinking: "main" }, ["tier-worker/w1", "low", "config:main"]],
      [{ model: "tier-worker/w1", thinking: "medium" }, ["tier-worker/w1", "medium", "config"]],
    ] as const) {
      const orchestrator = tierProvider("tier-orch", "o1");
      const worker = tierProvider("tier-worker", "w1");
      const { execute, register } = await fixture({ models: { orchestrator: { model: "tier-orch/o1", thinking: "high" }, ...(workerTier ? { worker: workerTier } : {}) } });
      register(orchestrator, worker);
      const seen: string[] = [];
      orchestrator.setResponses([spawnVerifier(), ...(workerTier ? [] : [observed(seen, verified())]), implemented()]);
      worker.setResponses(workerTier ? [observed(seen, verified())] : []);
      const result = await execute({ oneShot: { ...ONE_SHOT, effort: "low" } });
      expect(result.details).toMatchObject({ thinking: "low", thinkingSource: "effort" });
      expect(result.details.spawned?.map(item => [item.model, item.thinking, item.thinkingSource])).toEqual([expected]);
      expect(seen).toEqual([expected[1]]);
    }
  });

  it("the plan advisor: thinking \"main\" takes the effort, its own level stays (strong mode on the strong tiers)", async () => {
    for (const [advisor, expected] of [[{ model: "tier-adv/a1", thinking: "main" }, "minimal"], [{ model: "tier-adv/a1", thinking: "max" }, "max"]] as const) {
      const orchestrator = tierProvider("tier-orch", "o1");
      const adv = tierProvider("tier-adv", "a1");
      const { execute, register } = await fixture({ records: true, single: { advisor: true }, models: { "strong-orchestrator": { model: "tier-orch/o1", thinking: "max" }, "strong-advisor": advisor } });
      register(orchestrator, adv);
      orchestrator.setResponses([implemented(false)]);
      const result = await execute({ mainMode: "strong", oneShot: { ...ONE_SHOT, effort: "minimal" } });
      expect(result.details).toMatchObject({ mode: "strong", thinking: "minimal", thinkingSource: "effort" });
      expect((await runJson(result.details.record!)).assignment).toMatchObject({ advisor: { model: "tier-adv/a1", thinking: expected } });
    }
  });

  it("a reused worker whose route is kept (a specialist, or main without a model) is back on its own level after the request", async () => {
    const art = tierProvider("tier-art", "v1");
    const { execute, register } = await fixture({ routes: { video: { model: "tier-art/v1", thinking: "medium" } } });
    register(art);
    const seen: string[] = [];
    const blocked = () => tool("report_result", { kind: "video", summary: "blocked", data: { status: "blocked", outputs: [] } });
    const cancel = new AbortController();
    const cancelled: FauxResponseFactory = async (_context, options) => {
      seen.push(options?.reasoning ?? "off");
      setTimeout(() => cancel.abort(), 0);
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted", { stopReason: "aborted" });
    };
    art.setResponses([observed(seen, blocked()), observed(seen, blocked()), cancelled, observed(seen, blocked())]);
    expect((await execute({ role: "video" })).details).toMatchObject({ worker: "W1", thinking: "medium", thinkingSource: "route" });
    const specialist = await execute({ role: "video", worker: "W1", oneShot: { ...ONE_SHOT, effort: "high" } });
    expect(specialist.details).toMatchObject({ worker: "W1", thinking: "high", thinkingSource: "effort" });
    expect(specialist.text).toContain("Effort: high (one-shot /orche single --effort high): W1 runs at high. Later requests, and this worker's or task's continuations, run at the usual levels.");
    // A cancelled effort assignment carries nothing over either: the next one without it starts from W1's own level.
    await expect(execute({ role: "video", worker: "W1", signal: cancel.signal, oneShot: { ...ONE_SHOT, effort: "minimal" } })).rejects.toThrow();
    expect((await execute({ role: "video", worker: "W1" })).details).toMatchObject({ worker: "W1", thinking: "medium", thinkingSource: "route" });
    expect(seen).toEqual(["medium", "high", "minimal", "medium"]);
    // Main without a model: the standard worker keeps its own route and level the same way.
    const kept = await fixture({ default: { model: "tier-orch/o1", thinking: "medium" } });
    const orchestrator = tierProvider("tier-orch", "o1");
    kept.register(orchestrator);
    const levels: string[] = [];
    orchestrator.setResponses([observed(levels, implemented(false)), observed(levels, implemented(false)), observed(levels, implemented(false))]);
    await kept.execute({ model: undefined });
    await kept.execute({ model: undefined, worker: "W1", oneShot: { ...ONE_SHOT, effort: "low" } });
    expect((await kept.execute({ model: undefined, worker: "W1" })).details).toMatchObject({ worker: "W1", thinking: "medium" });
    expect(levels).toEqual(["medium", "low", "medium"]);
  });

  it("is not kept by a task: continuing the request's task (single.ledger) runs at the usual level; a bad value from an SDK caller is ignored", async () => {
    const orchestrator = tierProvider("tier-orch", "o1");
    const { execute, register, pool } = await fixture({ single: { ledger: true }, models: { orchestrator: { model: "tier-orch/o1", thinking: "medium" } } });
    register(orchestrator);
    orchestrator.setResponses([implemented(false), implemented(false), implemented(false)]);
    const first = await execute({ oneShot: { ...ONE_SHOT, effort: "high" } });
    expect(first.details).toMatchObject({ task: "T1", thinking: "high", thinkingSource: "effort" });
    await pool.stop("W1");
    const continued = await execute({ task: "T1" });
    expect(continued.details).toMatchObject({ task: "T1", worker: "W2", thinking: "medium", thinkingSource: "config" });
    const bogus = await execute({ oneShot: { ...ONE_SHOT, effort: "turbo" as never } });
    expect(bogus.details).toMatchObject({ thinking: "medium", thinkingSource: "config" });
    expect(bogus.details.requestMode).not.toHaveProperty("effort");
  });

  it("--summary-budget compact: the request's worker session uses the compact profile; the next assignment of the same worker is standard; a bogus value is ignored", async () => {
    const orchestrator = tierProvider("tier-orch", "o1");
    const { execute, register, pool, h } = await fixture({ records: true, models: { orchestrator: { model: "tier-orch/o1", thinking: "high" } } });
    register(orchestrator);
    orchestrator.setResponses([implemented(false), implemented(false), implemented(false)]);
    const profiles: string[] = [];
    const profile = () => summaryBudgetProfile((pool as unknown as { manager: { session(id: string): object } }).manager.session("W1"));
    const first = await execute({ oneShot: { ...ONE_SHOT, summaryBudget: "compact" } });
    profiles.push(profile());
    expect(first.details).toMatchObject({ summaryBudget: "compact", requestMode: { source: "one-shot", summaryBudget: "compact" } });
    expect((await runJson(first.details.record!)).outcome).toMatchObject({ summaryBudget: "compact" });
    const later = await execute({ worker: "W1" });
    profiles.push(profile());
    expect(later.details.summaryBudget).toBeUndefined();
    const bogus = await execute({ worker: "W1", oneShot: { ...ONE_SHOT, summaryBudget: "tiny" as never } });
    profiles.push(profile());
    expect(bogus.details.summaryBudget).toBeUndefined();
    expect(profiles).toEqual(["compact", "standard", "standard"]);
    expect(h.notifications).toEqual([]);
  });
});

/** The extension in a real session; the workers' orchestrator tier (thinking high) is a reasoning faux provider. */
async function session(options: { mainSteps: FauxResponseStep[]; workerSteps?: FauxResponseStep[]; mode?: "tui"; ui?: Parameters<typeof createHarness>[0]["ui"] }) {
  const h = await createHarness({ mainSteps: options.mainSteps, orcheSteps: [], models: { orchestrator: { model: "tier-orch/o1", thinking: "high" } }, mainMode: "single", ...(options.mode ? { mode: options.mode } : {}), ...(options.ui ? { ui: options.ui } : {}) });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const worker = tierProvider("tier-orch", "o1");
  worker.setResponses(options.workerSteps ?? []);
  h.orche.runtime.registerNativeProvider(worker.provider);
  return { h, worker };
}
const toolResults = (h: Harness) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === "orche_task");
const notes = (h: Harness) => h.notifications.map(note => note.message);
const modeStatus = (h: Harness) => h.statuses.filter(status => status.key === "orche-mode").map(status => status.text);
const userTextOf = (context: Parameters<FauxResponseFactory>[0]) => {
  const content = (context.messages.filter(message => message.role === "user").at(-1) as { content: unknown }).content;
  return typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("");
};
const modeEntries = (h: Harness) => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === MODE_ENTRY_TYPE);

describe("--effort through the extension", () => {
  it.each([["blocking call", undefined], ["background job (TUI)", "tui"]] as const)("/orche single --effort low <PROMPT> (%s): the prompt reaches main verbatim, the worker runs at low, main and later requests at their usual levels", async (_label, mode) => {
    const prompt = "  Inspect greeting.txt --effort high stays text\n";
    let userText = "";
    const seen: string[] = [];
    const { h, worker } = await session({
      mainSteps: [
        context => { userText = userTextOf(context); return tool("orche_task", { role: "answer", request: "Inspect greeting.txt" }); }, reply("done"),
        tool("orche_task", { role: "answer", request: "Inspect it again", worker: "W1" }), reply("done again"),
      ],
      workerSteps: [observed(seen, answered("inspected at the request's effort")), observed(seen, answered("inspected at the tier's level"))],
      ...(mode ? { mode } : {}),
    });
    await h.session.prompt(`/orche single --effort low ${prompt}`);
    await h.session.agent.waitForIdle();
    expect(userText).toBe(prompt);
    const first = JSON.stringify(toolResults(h)[0]);
    expect(first).toContain("Effort: low (one-shot /orche single --effort low): W1 runs at low");
    expect(toolResults(h)[0]).toMatchObject({ details: { thinking: "low", thinkingSource: "effort", requestMode: { effort: "low" } } });
    expect(notes(h)).toContain("orche single: this request's orche_task assignments start at effort low (each worker's model may clamp it; the result shows the level used). Main keeps its own thinking (off); later requests use the usual levels.");
    expect(modeStatus(h)).toContain("orche: single (one-turn single, effort low)");
    expect(modeStatus(h).at(-1)).toBe("orche: single");
    await h.session.prompt("Inspect it once more with W1");
    await h.session.agent.waitForIdle();
    expect(toolResults(h)[1]).toMatchObject({ details: { worker: "W1", thinking: "high", thinkingSource: "config" } });
    expect(JSON.stringify(toolResults(h)[1])).not.toContain("Effort:");
    expect(seen).toEqual(["low", "high"]);
    expect(worker.getPendingResponseCount()).toBe(0);
    expect(h.session.thinkingLevel).toBe("off");
    expect(modeEntries(h)).toEqual([]);
  });

  it("a task the request queued for after a running job keeps the request's effort when it starts after the request ended", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const { h, worker } = await session({
      mode: "tui",
      ui: { select: async (_title: string, options: string[]) => options[0] },
      mainSteps: [
        tool("orche_task", { role: "answer", request: "J1: inspect greeting.txt", wait: false }),
        tool("orche_task", { role: "answer", request: "Q1: inspect greeting.txt again" }),
        reply("J1 runs, Q1 queued"), reply("J1 reported"), reply("J2 reported"), reply("spare"),
      ],
      workerSteps: [observed(seen, async () => { await gate.promise; return answered("J1 done"); }), observed(seen, answered("Q1 done"))],
    });
    await h.session.prompt("/orche single --effort minimal inspect it twice");
    expect(modeStatus(h).at(-1)).toBe("orche: single");
    gate.resolve();
    await vi.waitFor(() => expect(worker.getPendingResponseCount()).toBe(0), { timeout: 5000 });
    await vi.waitFor(() => expect(h.session.messages.filter(message => (message as { customType?: string }).customType === "orche-task-result").length).toBe(2), { timeout: 5000 });
    await h.session.agent.waitForIdle();
    expect(seen).toEqual(["minimal", "minimal"]);
    const results = h.session.messages.filter(message => (message as { customType?: string }).customType === "orche-task-result") as { details?: { task?: { thinking?: string; requestMode?: { effort?: string } } } }[];
    for (const result of results) expect(result.details?.task).toMatchObject({ thinking: "minimal", requestMode: { effort: "minimal" } });
  });

  it("an unusable --effort through the command: the message, no turn, no mode or thinking change", async () => {
    const { h } = await session({ mainSteps: [reply("MUST NOT RUN")] });
    for (const input of ["/orche single --effort turbo fix", "/orche ultra --effort high", "/orche --effort high single fix", "/orche mode strong --effort low"]) await h.session.prompt(input);
    expect(notes(h)).toEqual([effortUsage("single --effort turbo fix"), effortUsage("ultra --effort high"), effortUsage("--effort high single fix"), effortUsage("mode strong --effort low")]);
    expect(h.main.faux.state.callCount).toBe(0);
    expect(modeEntries(h)).toEqual([]);
    expect(h.session.thinkingLevel).toBe("off");
    expect(modeStatus(h).at(-1)).toBe("orche: single");
    // The command's help (Pi's command list) names the option.
    expect(h.session.extensionRunner.getCommand("orche")!.description).toContain("/orche <mode> --effort <off|minimal|low|medium|high|xhigh|max> <prompt>: the same request at that reasoning effort");
  });

  it("busy: /orche <mode> --effort is refused like any one-shot request, never queued without its effort", async () => {
    const entered = deferred();
    const gate = deferred();
    const { h } = await session({ mainSteps: [async () => { entered.resolve(); await gate.promise; return reply("first done"); }] });
    const first = h.session.prompt("first");
    await entered.promise;
    await h.session.prompt("/orche strong --effort max second");
    expect(notes(h).at(-1)).toBe(busyRefusal("strong", "single"));
    gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(1);
  });
});

/** A direct session whose main model reasons (models.main applies it at session start, thinking medium). */
async function directSession(mainSteps: FauxResponseStep[]) {
  const main = tierProvider("tier-main", "m1");
  const h = await createHarness({ mainSteps: [], orcheSteps: [], mainMode: "direct", models: { main: { model: "tier-main/m1", thinking: "medium" } }, providers: [{ provider: main.provider }] });
  opened.push(h);
  main.setResponses(mainSteps);
  return { h, main };
}
const thinkingEntries = (h: Harness) => h.session.sessionManager.getBranch().filter(entry => entry.type === "thinking_level_change").map(entry => (entry as { thinkingLevel?: string }).thinkingLevel);

describe("--effort in direct mode: main runs the request at it", () => {
  it("main's request goes out at the effort; afterwards main is back on its level, also for the next turn; Pi's default is untouched", async () => {
    const { h, main } = await directSession([]);
    expect(h.session.thinkingLevel).toBe("medium");
    const defaultLevel = h.session.settingsManager.getDefaultThinkingLevel();
    const seen: string[] = [];
    main.setResponses([observed(seen, reply("edited at high")), observed(seen, reply("next turn"))]);
    await h.session.prompt("/orche direct --effort high fix the greeting");
    expect(notes(h)).toContain("orche direct: main runs this request at thinking high; back to medium when it ends.");
    expect(h.session.thinkingLevel).toBe("medium");
    await h.session.prompt("and now?");
    expect(seen).toEqual(["high", "medium"]);
    expect(h.session.settingsManager.getDefaultThinkingLevel()).toBe(defaultLevel);
    // Recorded in the session like /thinking: the change and the way back.
    expect(thinkingEntries(h).slice(-2)).toEqual(["high", "medium"]);
  });

  it("clamps to main's model; an aborted request restores too; a level the user picks during the run stays", async () => {
    const { h, main } = await directSession([]);
    const seen: string[] = [];
    main.setResponses([observed(seen, reply("clamped"))]);
    await h.session.prompt("/orche direct --effort max fix it");
    expect(notes(h)).toContain("orche direct: main runs this request at thinking high (--effort max: the nearest level main's model supports); back to medium when it ends.");
    expect(seen).toEqual(["high"]);
    expect(h.session.thinkingLevel).toBe("medium");
    const entered = deferred();
    main.setResponses([async (_context, options) => {
      seen.push(options?.reasoning ?? "off");
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("aborted", { stopReason: "aborted" });
    }]);
    const run = h.session.prompt("/orche direct --effort low fix it slowly");
    await entered.promise;
    await h.session.abort();
    await run;
    expect(seen.at(-1)).toBe("low");
    expect(h.session.thinkingLevel).toBe("medium");
    main.setResponses([async context => { h.session.setThinkingLevel("minimal"); void context; return reply("user picked minimal"); }]);
    await h.session.prompt("/orche direct --effort xhigh fix");
    expect(h.session.thinkingLevel).toBe("minimal");
  });
});
