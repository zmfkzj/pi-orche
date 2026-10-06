/**
 * The three model tiers (docs/orchestrator.md 12): `models.main` (the Pi session), `models.orchestrator` (the single workflow's
 * standard-role worker) and `models.worker` (its orche_spawn sub-workers). Unset tiers inherit; specialists keep their routes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { delegationRules } from "../../src/extension/mode.js";
import { applyMainModel, formatModelTiers } from "../../src/extension/main-model.js";
import { parseRouteConfig, RouteConfigError } from "../../src/orchestration/routing.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { readSplitLog } from "../../src/orchestrator/split-log.js";
import { createHarness, tool, type Harness } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says hello.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘. 독립 검증도 해줘.";
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
const spawnVerifier = () => tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] });
const verified = () => tool("report_result", { kind: "verify", summary: "greeting.txt says hello", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } });
const implemented = (split = true) => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: split ? { decision: "split", criteria: ["verification"], reason: "the user asked for an independent check" } : { decision: "none", reason: "small" } } });
/** Tier providers: reasoning models so that a thinking level other than off is kept. */
const tierProvider = (provider: string, id: string) => fauxProvider({ provider, models: [{ id, reasoning: true }] });

async function fixture(options: { models?: Record<string, unknown>; routes?: Record<string, unknown>; records?: boolean } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [], records: options.records ?? false });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const records = options.records ? {} : { enabled: false };
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: options.routes ?? {}, default: { model: h.orche.route.model }, records, mainMode: "single", ...(options.models ? { models: options.models } : {}) }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  opened.push(pool);
  // Main's current model at the hand-off: a reasoning model, so that main's thinking (high) is what the orchestrator inherits.
  const mainFaux = tierProvider("main-reasoning", "current");
  h.runtime.registerNativeProvider(mainFaux.provider);
  const mainModel = mainFaux.getModel();
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: mainModel, thinking: "high", ...args });
  return { h, pool, execute, mainFaux, main: `${mainModel.provider}/${mainModel.id}` };
}
const runJson = async (record: string) => JSON.parse(await readFile(join(record, "run.json"), "utf8")) as { assignment: Record<string, unknown>; outcome: Record<string, unknown> };
const recordsRoot = (h: Harness) => join(h.agentDir, "orche", "records");
/** The system prompt the model received (as in mode.test.ts). */
const systemOf = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.find(message => message.role === "system"));

describe("model tiers: config", () => {
  it("parses models.main/orchestrator/worker like routes and rejects what a route rejects", () => {
    const parsed = parseRouteConfig({ routes: {}, default: { model: "p/m" }, models: { main: { model: "a/main", thinking: "high" }, orchestrator: { model: "b/orch", extendedContext: true }, worker: { model: "c/work", thinking: "low" } } });
    expect(parsed.models).toEqual({ main: { model: "a/main", thinking: "high" }, orchestrator: { model: "b/orch", extendedContext: true }, worker: { model: "c/work", thinking: "low" } });
    expect(() => parseRouteConfig({ routes: {}, models: { planner: { model: "a/b" } } })).toThrow(RouteConfigError);
    expect(() => parseRouteConfig({ routes: {}, models: { planner: { model: "a/b" } } })).toThrow("config.models.planner: unknown tier");
    expect(() => parseRouteConfig({ routes: {}, models: { worker: { model: "a/b", thinking: "huge" } } })).toThrow("config.models.worker.thinking");
    expect(() => parseRouteConfig({ routes: {}, models: { orchestrator: { model: "a/b", role: "x" } } })).toThrow("config.models.orchestrator: unknown route field");
    expect(() => parseRouteConfig({ routes: {}, models: { main: { model: "no-slash" } } })).toThrow("config.models.main.model: expected provider/modelId");
    expect(() => parseRouteConfig({ routes: {}, models: [] })).toThrow("config.models: expected object");
  });
  it("without models nothing changes: no models key, main's hand-off rule word for word", () => {
    expect(parseRouteConfig({ routes: {}, default: { model: "p/m" } })).not.toHaveProperty("models");
    for (const spawn of [true, false]) {
      expect(delegationRules("single", { spawn, orchestratorModel: false })).toBe(delegationRules("single", { spawn }));
      expect(delegationRules("single", { spawn })).toContain("Standard roles inherit main's CURRENT model and thinking at hand-off and compact above 50% context");
    }
    const configured = delegationRules("single", { orchestratorModel: true });
    expect(configured).toContain("Standard roles run on the orchestrator model configured in the orche config (models.orchestrator), not on main's model, and compact above 50% context");
    expect(configured).not.toContain("inherit main's CURRENT model");
    expect(delegationRules("direct", { orchestratorModel: true })).toBe(delegationRules("direct"));
  });
});

describe("model tiers: orchestrator and worker", () => {
  it("no models (regression): the orchestrator runs on main's model and thinking, its sub-workers on the orchestrator's; recorded as main/orchestrator", async () => {
    const { h, execute, main, mainFaux } = await fixture({ records: true });
    mainFaux.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute();
    expect(result.details).toMatchObject({ model: main, thinking: "high", modelSource: "main" });
    expect(result.details.warnings).toBeUndefined();
    expect(result.details.spawned?.map(worker => [worker.model, worker.thinking, worker.modelSource])).toEqual([[main, "high", "orchestrator"]]);
    const run = await runJson(result.details.record!);
    expect(run.assignment).toMatchObject({ model: main, thinking: "high", modelSource: "main" });
    expect(run.outcome).toMatchObject({ model: main, thinking: "high", modelSource: "main" });
    expect((run as unknown as { agents: Record<string, unknown>[] }).agents).toContainEqual(expect.objectContaining({ id: "W1.1", model: main, modelSource: "orchestrator" }));
    expect(await readSplitLog(recordsRoot(h))).toEqual([expect.objectContaining({ model: main, modelSource: "main", workerModels: [{ model: main, source: "orchestrator" }] })]);
  });
  it("models.orchestrator only: the orchestrator runs on it with its thinking; sub-workers inherit it", async () => {
    const orchestrator = tierProvider("tier-orch", "o1");
    const { h, pool, execute } = await fixture({ models: { orchestrator: { model: "tier-orch/o1", thinking: "low" } } });
    h.runtime.registerNativeProvider(orchestrator.provider);
    orchestrator.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute();
    expect(orchestrator.getPendingResponseCount()).toBe(0);
    expect(result.details).toMatchObject({ model: "tier-orch/o1", thinking: "low", modelSource: "config" });
    expect(pool.session("W1").model?.id).toBe("o1");
    expect(result.details.spawned?.map(worker => [worker.model, worker.thinking, worker.modelSource])).toEqual([["tier-orch/o1", "low", "orchestrator"]]);
    // A later hand-off to the same worker stays on the configured model, whatever main runs on.
    orchestrator.setResponses([implemented(false)]);
    expect((await execute({ worker: "W1", thinking: "minimal" })).details).toMatchObject({ model: "tier-orch/o1", thinking: "low", modelSource: "config" });
  });
  it("models.worker only: the orchestrator inherits main; sub-workers run on models.worker with the orchestrator's thinking", async () => {
    const worker = tierProvider("tier-worker", "w1");
    const { h, execute, main, mainFaux } = await fixture({ models: { worker: { model: "tier-worker/w1" } } });
    h.runtime.registerNativeProvider(worker.provider);
    mainFaux.setResponses([spawnVerifier(), implemented()]);
    worker.setResponses([verified()]);
    const result = await execute();
    expect(worker.getPendingResponseCount()).toBe(0);
    expect(result.details).toMatchObject({ model: main, thinking: "high", modelSource: "main" });
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["tier-worker/w1", "high", "config"]]);
  });
  it("an unresolvable configured model warns visibly and falls back to inheritance; run.json and the split log say so", async () => {
    const { h, execute, main, mainFaux } = await fixture({ records: true, models: { orchestrator: { model: "nowhere/orch" }, worker: { model: "nowhere/work", thinking: "low" } } });
    mainFaux.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute();
    expect(result.details).toMatchObject({ model: main, thinking: "high", modelSource: "main" });
    const warnings = [
      "Warning: models.orchestrator nowhere/orch is unresolvable in orche's runtime; inheriting main's model instead.",
      "Warning: models.worker nowhere/work is unresolvable in orche's runtime; sub-workers inherit the orchestrator's model instead.",
    ];
    expect(result.details.warnings).toEqual(warnings);
    for (const warning of warnings) expect(result.text).toContain(warning);
    // The warnings come right after the result's header line, inside what the collapsed tool block shows.
    expect(result.text.split("\n").slice(0, 3)).toEqual([expect.stringMatching(/^orche task W1 /), ...warnings]);
    expect(result.details.spawned?.map(item => [item.model, item.modelSource])).toEqual([[main, "orchestrator"]]);
    const run = await runJson(result.details.record!);
    expect(run.assignment).toMatchObject({ model: main, modelSource: "main" });
    expect(run.outcome).toMatchObject({ model: main, modelSource: "main", warnings });
    expect(await readSplitLog(recordsRoot(h))).toEqual([expect.objectContaining({ model: main, modelSource: "main", workerModels: [{ model: main, source: "orchestrator" }] })]);
  });
  it("specialists keep their routes: an orche_task video worker and a game-asset sub-worker ignore models", async () => {
    const orchestrator = tierProvider("tier-orch", "o1");
    const worker = tierProvider("tier-worker", "w1");
    const specialist = fauxProvider({ provider: "specialist-art", models: [{ id: "artist" }] });
    const { h, execute } = await fixture({ routes: { "game-asset": { model: "specialist-art/artist" } }, models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "tier-worker/w1" } } });
    for (const provider of [orchestrator, worker, specialist]) h.runtime.registerNativeProvider(provider.provider);
    h.orche.faux.setResponses([tool("report_result", { kind: "video", summary: "blocked", data: { status: "blocked", outputs: [] } })]);
    const video = await execute({ role: "video" });
    expect(video.details).toMatchObject({ model: h.orche.route.model, thinking: "off", modelSource: "route" });
    orchestrator.setResponses([
      tool(SPAWN_TOOL, { reason: "isolation", workers: [{ name: "sprites", role: "game-asset", request: "Make assets/sprite.svg, a 16x16 SVG.", files: ["assets/"] }] }),
      tool("report_result", { kind: "implement", summary: "Sprite from the specialist", data: { status: "done", checklist, split: { decision: "split", criteria: ["isolation"], reason: "game art needs the specialist" } } }),
    ]);
    specialist.setResponses([
      tool("write", { path: "assets/sprite.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }),
      tool("report_result", { kind: "game-asset", summary: "sprite made", data: { status: "done", outputs: [{ path: "assets/sprite.svg", type: "image/svg+xml", spec: "16x16" }], evidence: ["file assets/sprite.svg"] } }),
    ]);
    const implement = await execute();
    expect(specialist.getPendingResponseCount()).toBe(0);
    expect(worker.getPendingResponseCount()).toBe(0);
    expect(implement.details).toMatchObject({ model: "tier-orch/o1", modelSource: "config" });
    expect(implement.details.spawned?.map(item => [item.role, item.model, item.modelSource])).toEqual([["game-asset", "specialist-art/artist", "route"]]);
  });
});

describe("model tiers: main (the Pi session)", () => {
  const fresh = [{ type: "model_change" }, { type: "thinking_level_change" }];
  const fake = (branch: { type: string }[], options: { found?: boolean; auth?: boolean; id?: string } = {}) => {
    const model = { provider: "tier-main", id: options.id ?? "m1", contextWindow: 200_000 };
    const pi = { setModel: vi.fn(async () => options.auth ?? true), setThinkingLevel: vi.fn(), getThinkingLevel: vi.fn(() => "low" as const) };
    const ctx = { modelRegistry: { find: vi.fn(() => options.found === false ? undefined : model) }, sessionManager: { getBranch: () => branch } };
    return { pi, ctx: ctx as unknown as Parameters<typeof applyMainModel>[1], model };
  };
  it("applies the model and thinking once on a fresh session at startup or /new", async () => {
    for (const reason of ["startup", "new"]) {
      const { pi, ctx, model } = fake(fresh);
      const result = await applyMainModel(pi as never, ctx, reason, { model: "tier-main/m1", thinking: "low" }, ["node", "pi"]);
      expect(pi.setModel).toHaveBeenCalledWith(model);
      expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
      expect(result).toEqual({ applied: { model: "tier-main/m1", thinking: "low", contextWindow: 200_000 }, warnings: [] });
    }
  });
  it("keeps the session's own choice: resumed, forked or reloaded sessions, a history, a model or thinking change, command-line flags", async () => {
    const cases: [string, { type: string }[], string[], RegExp][] = [
      ["resume", fresh, [], /resumed/], ["fork", fresh, [], /forked/], ["reload", fresh, [], /reloaded/],
      ["startup", [...fresh, { type: "message" }], [], /own history/],
      ["startup", [...fresh, { type: "model_change" }], [], /own history or model choice/],
      ["startup", [...fresh, { type: "thinking_level_change" }], [], /model choice/],
      ["startup", fresh, ["--model", "other/x"], /command line chose the model \(--model\)/],
      ["new", fresh, ["--thinking", "high"], /--thinking/],
    ];
    for (const [reason, branch, flags, skipped] of cases) {
      const { pi, ctx } = fake(branch);
      const result = await applyMainModel(pi as never, ctx, reason, { model: "tier-main/m1", thinking: "low" }, ["node", "pi", ...flags]);
      expect(result.applied).toBeUndefined();
      expect(result.skipped).toMatch(skipped);
      expect(pi.setModel).not.toHaveBeenCalled();
      expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    }
  });
  it("warns and keeps the session's model when models.main is not in Pi's list or has no credentials; no models.main does nothing", async () => {
    const missing = fake(fresh, { found: false });
    expect(await applyMainModel(missing.pi as never, missing.ctx, "startup", { model: "tier-main/m1" }, [])).toMatchObject({ warnings: ["orche: models.main tier-main/m1 is not in Pi's model list (see /model); keeping the session's model."] });
    const locked = fake(fresh, { auth: false });
    expect(await applyMainModel(locked.pi as never, locked.ctx, "startup", { model: "tier-main/m1", thinking: "high" }, [])).toMatchObject({ warnings: ["orche: models.main tier-main/m1 has no configured credentials; keeping the session's model."] });
    expect(locked.pi.setThinkingLevel).not.toHaveBeenCalled();
    const none = fake(fresh);
    expect(await applyMainModel(none.pi as never, none.ctx, "startup", undefined, [])).toEqual({ warnings: [] });
    expect(none.pi.setModel).not.toHaveBeenCalled();
  });
  it("extendedContext gives main the same larger window as orche's workers", async () => {
    const { pi, ctx } = fake(fresh, { id: "gpt-6.1-sol" });
    const result = await applyMainModel(pi as never, ctx, "startup", { model: "tier-main/gpt-6.1-sol", extendedContext: true }, []);
    expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-6.1-sol", contextWindow: 922_000 }));
    expect(result.applied?.contextWindow).toBe(922_000);
  });
});

describe("model tiers: through the extension", () => {
  async function harness(models: Record<string, unknown> | undefined, mainSteps: FauxResponseStep[] = []) {
    const tiers = { main: tierProvider("tier-main", "m1"), orchestrator: tierProvider("tier-orch", "o1"), worker: tierProvider("tier-worker", "w1") };
    const other = tierProvider("user-pick", "u1");
    const h = await createHarness({ mainSteps, orcheSteps: [], inheritMainModel: true, records: true, ...(models ? { models } : {}), providers: [...Object.values(tiers), other].map(item => ({ provider: item.provider })) });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    return { h, tiers, other };
  }
  const modelsText = async (h: Harness) => {
    const before = h.notifications.length;
    await h.session.prompt("/orche models");
    return h.notifications.slice(before).map(item => item.message).join("\n");
  };
  it("all three set: main starts on models.main, hands off to models.orchestrator, whose sub-worker runs on models.worker", async () => {
    const { h, tiers } = await harness({ main: { model: "tier-main/m1", thinking: "medium" }, orchestrator: { model: "tier-orch/o1", thinking: "low" }, worker: { model: "tier-worker/w1", thinking: "minimal" } });
    expect(`${h.session.model?.provider}/${h.session.model?.id}`).toBe("tier-main/m1");
    expect(h.session.thinkingLevel).toBe("medium");
    tiers.main.setResponses([tool("orche_task", { role: "implement", request }), reply("reviewed")]);
    tiers.orchestrator.setResponses([spawnVerifier(), implemented()]);
    tiers.worker.setResponses([verified()]);
    await h.session.prompt("fix the greeting and check it independently");
    for (const tier of Object.values(tiers)) expect(tier.getPendingResponseCount()).toBe(0);
    const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "orche_task");
    expect(result).toMatchObject({ details: { model: "tier-orch/o1", thinking: "low", modelSource: "config", spawned: [expect.objectContaining({ model: "tier-worker/w1", thinking: "minimal", modelSource: "config" })] } });
    expect(await readSplitLog(join(h.agentDir, "orche", "records"))).toEqual([expect.objectContaining({ model: "tier-orch/o1", modelSource: "config", workerModels: [{ model: "tier-worker/w1", source: "config" }] })]);
    const run = await runJson((result as unknown as { details: { record: string } }).details.record);
    expect(run.assignment).toMatchObject({ model: "tier-orch/o1", thinking: "low", modelSource: "config" });
    expect(run.outcome).toMatchObject({ model: "tier-orch/o1", modelSource: "config" });
    expect((run as unknown as { agents: Record<string, unknown>[] }).agents).toContainEqual(expect.objectContaining({ id: "W1.1", role: "verify", model: "tier-worker/w1", thinking: "minimal", modelSource: "config" }));
    const text = await modelsText(h);
    expect(text).toContain("- main: tier-main/m1 medium — config models.main (applied at session start)");
    expect(text).toContain("- orchestrator (orche_task explore/answer/implement/verify): tier-orch/o1 low — config models.orchestrator");
    expect(text).toContain("- worker (orche_spawn sub-workers, the fresh verifier included): tier-worker/w1 minimal — config models.worker");
    expect(text).toContain("- game-asset, video: their own routes (models does not apply)");
  });
  it("a model the user picks during the session stays: no hand-off, prompt or reload puts models.main back", async () => {
    const { h, other } = await harness({ main: { model: "tier-main/m1", thinking: "medium" } });
    expect(h.session.model?.id).toBe("m1");
    await h.session.setModel(other.getModel());
    h.session.setThinkingLevel("high");
    other.setResponses([reply("hello")]);
    await h.session.prompt("hi");
    expect(h.session.model?.id).toBe("u1");
    await h.session.reload();
    expect(`${h.session.model?.provider}/${h.session.model?.id}`).toBe("user-pick/u1");
    expect(h.session.thinkingLevel).toBe("high");
    const text = await modelsText(h);
    expect(text).toContain("- main: user-pick/u1 high — Pi (models.main tier-main/m1 not applied: the session was reloaded and keeps its own model)");
    expect(text).toContain("- orchestrator (orche_task explore/answer/implement/verify): inherited from main (user-pick/u1 high)");
  });
  it("no models: the session keeps Pi's model and /orche models says every tier inherits", async () => {
    const { h } = await harness(undefined);
    const main = `${h.main.faux.provider.id}/${h.main.faux.getModel().id}`;
    expect(`${h.session.model?.provider}/${h.session.model?.id}`).toBe(main);
    const text = await modelsText(h);
    expect(text).toContain(`- main: ${main} off — Pi (no models.main)`);
    expect(text).toContain(`- orchestrator (orche_task explore/answer/implement/verify): inherited from main (${main} off)`);
    expect(text).toContain(`- worker (orche_spawn sub-workers, the fresh verifier included): inherited from the orchestrator (${main})`);
    expect(h.notifications.filter(item => item.type === "warning")).toEqual([]);
  });
  it("models.main that Pi does not know is a visible warning and the session keeps its model", async () => {
    const { h } = await harness({ main: { model: "nowhere/m" } });
    expect(h.session.model?.provider).toBe(h.main.faux.provider.id);
    expect(h.notifications).toContainEqual({ message: "orche: models.main nowhere/m is not in Pi's model list (see /model); keeping the session's model.", type: "warning" });
  });
  it("formatModelTiers: a tier without thinking inherits it; direct mode names models.main only", () => {
    const text = formatModelTiers({ main: "p/m", thinking: "high", mode: "direct", tiers: { orchestrator: { model: "b/o" }, worker: { model: "c/w", extendedContext: true } }, atStart: {} });
    expect(text).toContain("- orchestrator (orche_task explore/answer/implement/verify): b/o (thinking: main's) — config models.orchestrator");
    expect(text).toContain("- worker (orche_spawn sub-workers, the fresh verifier included): c/w (thinking: the orchestrator's), extended context — config models.worker");
    expect(text).toContain("Direct mode: main does the work itself; only models.main applies.");
  });
});

const mainError = 'config.models.main: "main" (inherit main\'s model) is for models.orchestrator and models.worker; models.main is the Pi session\'s own model (omit it to keep Pi\'s model)';
describe('model tiers: { "model": "main" } (main\'s model, named in the config)', () => {
  it("parses in models.orchestrator and models.worker with or without thinking; models.main, a bare string, extendedContext and routes reject it", () => {
    expect(parseRouteConfig({ routes: {}, models: { orchestrator: { model: "main" }, worker: { model: "main", thinking: "medium" } } }).models)
      .toEqual({ orchestrator: { model: "main" }, worker: { model: "main", thinking: "medium" } });
    for (const main of [{ model: "main" }, { model: "main", thinking: "high" }, "main"]) expect(() => parseRouteConfig({ routes: {}, models: { main } })).toThrow(mainError);
    expect(() => parseRouteConfig({ routes: {}, models: { orchestrator: "main" } })).toThrow('config.models.orchestrator: expected route object; write { "model": "main" } to inherit main\'s model');
    expect(() => parseRouteConfig({ routes: {}, models: { worker: { model: "main", extendedContext: true } } })).toThrow('config.models.worker.extendedContext: not with model "main" (main\'s model is inherited with main\'s context window)');
    expect(() => parseRouteConfig({ routes: {}, models: { worker: { model: "main", thinking: "huge" } } })).toThrow("config.models.worker.thinking: expected off, minimal, low, medium, high, xhigh, max");
    expect(() => parseRouteConfig({ routes: {}, models: { orchestrator: { model: "main", role: "x" } } })).toThrow("config.models.orchestrator: unknown route field");
    // Only the tiers know "main": a route or the default still needs provider/modelId.
    expect(() => parseRouteConfig({ routes: { analyst: { model: "main" } } })).toThrow("config.routes.analyst.model: expected provider/modelId");
    expect(() => parseRouteConfig({ routes: {}, default: { model: "main" } })).toThrow("config.default.model: expected provider/modelId");
  });
  it('orchestrator "main": exactly what an unset tier does (main\'s current model and thinking, sub-workers on it), recorded as config:main', async () => {
    const { h, execute, main, mainFaux } = await fixture({ records: true, models: { orchestrator: { model: "main" } } });
    mainFaux.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute();
    expect(mainFaux.getPendingResponseCount()).toBe(0);
    expect(result.details).toMatchObject({ model: main, thinking: "high", modelSource: "config:main" });
    expect(result.details.warnings).toBeUndefined();
    expect(result.details.spawned?.map(worker => [worker.model, worker.thinking, worker.modelSource])).toEqual([[main, "high", "orchestrator"]]);
    const run = await runJson(result.details.record!);
    expect(run.assignment).toMatchObject({ model: main, thinking: "high", modelSource: "config:main" });
    expect(run.outcome).toMatchObject({ model: main, thinking: "high", modelSource: "config:main" });
    expect(await readSplitLog(recordsRoot(h))).toEqual([expect.objectContaining({ model: main, modelSource: "config:main", workerModels: [{ model: main, source: "orchestrator" }] })]);
    // main's CURRENT model and thinking: the next hand-off moves the same worker to what main runs on then.
    const next = tierProvider("main-next", "later");
    h.runtime.registerNativeProvider(next.provider);
    next.setResponses([implemented(false)]);
    expect((await execute({ worker: "W1", model: next.getModel(), thinking: "minimal" })).details).toMatchObject({ worker: "W1", model: "main-next/later", thinking: "minimal", modelSource: "config:main" });
    expect(next.getPendingResponseCount()).toBe(0);
  });
  it('worker "main" next to another orchestrator model: sub-workers run on main\'s model and thinking, not the orchestrator\'s', async () => {
    const orchestrator = tierProvider("tier-orch", "o1");
    const { h, execute, main, mainFaux } = await fixture({ records: true, models: { orchestrator: { model: "tier-orch/o1", thinking: "low" }, worker: { model: "main" } } });
    h.runtime.registerNativeProvider(orchestrator.provider);
    orchestrator.setResponses([spawnVerifier(), implemented()]);
    mainFaux.setResponses([verified()]);
    const result = await execute();
    expect(orchestrator.getPendingResponseCount()).toBe(0);
    expect(mainFaux.getPendingResponseCount()).toBe(0);
    expect(result.details).toMatchObject({ model: "tier-orch/o1", thinking: "low", modelSource: "config" });
    expect(result.details.warnings).toBeUndefined();
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([[main, "high", "config:main"]]);
    const run = await runJson(result.details.record!) as Awaited<ReturnType<typeof runJson>> & { agents: Record<string, unknown>[] };
    expect(run.agents).toContainEqual(expect.objectContaining({ id: "W1.1", role: "verify", model: main, thinking: "high", modelSource: "config:main" }));
    expect(await readSplitLog(recordsRoot(h))).toEqual([expect.objectContaining({ model: "tier-orch/o1", modelSource: "config", workerModels: [{ model: main, source: "config:main" }] })]);
  });
  it('"main" with thinking: main\'s model with the tier\'s thinking, for the orchestrator and its sub-workers, whatever main\'s thinking is', async () => {
    const { execute, main, mainFaux } = await fixture({ models: { orchestrator: { model: "main", thinking: "low" }, worker: { model: "main", thinking: "minimal" } } });
    mainFaux.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute();
    expect(result.details).toMatchObject({ model: main, thinking: "low", modelSource: "config:main" });
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([[main, "minimal", "config:main"]]);
    mainFaux.setResponses([implemented(false)]);
    expect((await execute({ worker: "W1", thinking: "medium" })).details).toMatchObject({ model: main, thinking: "low", modelSource: "config:main" });
  });
  it('when orche\'s runtime cannot resolve main\'s model, "main" falls back like an unset tier, with visible warnings', async () => {
    const ghost = tierProvider("ghost", "g1").getModel(); // main's model, never registered in orche's runtime
    // models.worker "main": the orchestrator's model instead.
    const orchestrator = tierProvider("tier-orch", "o1");
    const first = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "main" } } });
    first.h.runtime.registerNativeProvider(orchestrator.provider);
    orchestrator.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await first.execute({ model: ghost });
    const warning = 'Warning: models.worker "main": main\'s model ghost/g1 is unresolvable in orche\'s runtime; sub-workers inherit the orchestrator\'s model instead.';
    expect(result.details.warnings).toEqual([warning]);
    expect(result.text).toContain(warning);
    expect(result.details).toMatchObject({ model: "tier-orch/o1", modelSource: "config" });
    expect(result.details.spawned?.map(item => [item.model, item.modelSource])).toEqual([["tier-orch/o1", "orchestrator"]]);
    // models.orchestrator "main": the configured route, with the same warning as without models.
    for (const models of [undefined, { orchestrator: { model: "main" } }]) {
      const { h, execute } = await fixture(models ? { models } : {});
      h.orche.faux.setResponses([implemented(false)]);
      const { details } = await execute({ model: ghost });
      expect(details).toMatchObject({ model: h.orche.route.model, modelSource: "route", warnings: [`Warning: main model ghost/g1 is unresolvable in orche's runtime; falling back to configured route ${h.orche.route.model}.`] });
    }
  });
  it("formatModelTiers: main's model named in the config, with and without thinking; an unset worker under it inherits main's model", () => {
    const text = formatModelTiers({ main: "p/m", thinking: "high", mode: "single", tiers: { orchestrator: { model: "main" } }, atStart: {} });
    expect(text).toContain('- orchestrator (orche_task explore/answer/implement/verify): main\'s model and thinking (p/m high) — config models.orchestrator "main"');
    expect(text).toContain("- worker (orche_spawn sub-workers, the fresh verifier included): inherited from the orchestrator (p/m)");
    const thinking = formatModelTiers({ main: "p/m", thinking: "high", mode: "single", tiers: { orchestrator: { model: "o/x" }, worker: { model: "main", thinking: "low" } }, atStart: {} });
    expect(thinking).toContain('- worker (orche_spawn sub-workers, the fresh verifier included): main\'s model (p/m) with thinking low — config models.worker "main"');
  });
});

describe('model tiers: { "model": "main" } through the extension', () => {
  async function harness(models: Record<string, unknown> | undefined) {
    const tiers = { main: tierProvider("tier-main", "m1"), orchestrator: tierProvider("tier-orch", "o1") };
    const h = await createHarness({ mainSteps: [], orcheSteps: [], inheritMainModel: true, records: true, ...(models ? { models } : {}), providers: Object.values(tiers).map(item => ({ provider: item.provider })) });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    return { h, tiers };
  }
  const modelsText = async (h: Harness) => {
    const before = h.notifications.length;
    await h.session.prompt("/orche models");
    return h.notifications.slice(before).map(item => item.message).join("\n");
  };
  it('orchestrator on its own model, worker "main": the verifier runs on main\'s model (models.main) with main\'s thinking', async () => {
    const { h, tiers } = await harness({ main: { model: "tier-main/m1", thinking: "medium" }, orchestrator: { model: "tier-orch/o1", thinking: "low" }, worker: { model: "main" } });
    expect(`${h.session.model?.provider}/${h.session.model?.id}`).toBe("tier-main/m1");
    // tier-main serves main's hand-off, then the verifier (on main's model), then main's review.
    let system = "";
    tiers.main.setResponses([context => { system = systemOf(context); return tool("orche_task", { role: "implement", request }); }, verified(), reply("reviewed")]);
    tiers.orchestrator.setResponses([spawnVerifier(), implemented()]);
    await h.session.prompt("fix the greeting and check it independently");
    for (const tier of Object.values(tiers)) expect(tier.getPendingResponseCount()).toBe(0);
    const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "orche_task");
    expect(result).toMatchObject({ details: { model: "tier-orch/o1", thinking: "low", modelSource: "config", spawned: [expect.objectContaining({ model: "tier-main/m1", thinking: "medium", modelSource: "config:main" })] } });
    expect(await readSplitLog(join(h.agentDir, "orche", "records"))).toEqual([expect.objectContaining({ model: "tier-orch/o1", modelSource: "config", workerModels: [{ model: "tier-main/m1", source: "config:main" }] })]);
    expect(await modelsText(h)).toContain('- worker (orche_spawn sub-workers, the fresh verifier included): main\'s model and thinking (tier-main/m1 medium) — config models.worker "main"');
    // A model of the orchestrator's own: main's hand-off rule says so.
    expect(system).toContain("Standard roles run on the orchestrator model configured in the orche config (models.orchestrator), not on main's model,");
    expect(system).not.toContain("Standard roles inherit main's CURRENT model");
  });
  it('orchestrator "main": /orche models shows it from the config and main keeps the earlier hand-off sentence', async () => {
    const { h } = await harness({ orchestrator: { model: "main" } });
    const main = `${h.main.faux.provider.id}/${h.main.faux.getModel().id}`;
    let system = "";
    h.main.faux.setResponses([context => { system = systemOf(context); return reply("hello"); }]);
    await h.session.prompt("hi");
    expect(system).toContain("Standard roles inherit main's CURRENT model and thinking at hand-off and compact above 50% context");
    expect(system).not.toContain("models.orchestrator");
    const text = await modelsText(h);
    expect(text).toContain(`- orchestrator (orche_task explore/answer/implement/verify): main's model and thinking (${main} off) — config models.orchestrator "main"`);
    expect(text).toContain(`- worker (orche_spawn sub-workers, the fresh verifier included): inherited from the orchestrator (${main})`);
    expect(h.notifications.filter(item => item.type === "warning")).toEqual([]);
  });
  it('models.main "main" is a config error shown at session start; the session keeps Pi\'s model', async () => {
    const { h } = await harness({ main: { model: "main" } });
    expect(h.session.model?.provider).toBe(h.main.faux.provider.id);
    expect(h.notifications).toContainEqual({ message: `orche: ${mainError}; using the default mode single`, type: "warning" });
    // orche_task reads the same file: the hand-off fails with the error instead of guessing.
    const { execute } = await fixture({ models: { main: { model: "main" } } });
    await expect(execute()).rejects.toThrow(mainError);
  });
});

