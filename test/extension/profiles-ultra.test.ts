/**
 * The merged single mode and model profiles, and ultra mode, through the real stack (WorkerPool, faux-model sessions, the extension).
 * No mode selects models: every delegating mode runs on the selected profile (`--profile`, default `default` = the top-level
 * `models`), and the former strong mode is single with the profile `strong` (also built from the legacy `models.strong-*` tiers).
 * ultra is the quality-first stage flow (src/orchestrator/ultra.ts). Unit-level ultra rules are in test/orchestrator/ultra.test.ts.
 * All model calls here are faux (no external API).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { assignmentPrompt, WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { blockedTools, delegationRules } from "../../src/extension/mode.js";
import { effortUsage, ORCHE_USAGE, oneShotUsage, parseOrcheCommand } from "../../src/extension/index.js";
import { formatModelTiers } from "../../src/extension/main-model.js";
import { completeOrcheArguments } from "../../src/extension/completions.js";
import { applyProfile, DEFAULT_MAIN_MODE, DEFAULT_PROFILE, findProfile, MAIN_MODES, parseRouteConfig, profileNames, profileTiers, UnknownProfileError } from "../../src/orchestration/routing.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { ADOPT_TOOL } from "../../src/orchestrator/ultra.js";
import { createHarness, tool } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
const temp: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says fixed.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "sh test/basis.sh" }];
const partial = [{ id: "R1", status: "partial", evidence: "not done yet" }];
const spawnVerifier = () => tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says fixed. Run your own checks." }] });
const verified = () => tool("report_result", { kind: "verify", summary: "greeting.txt is fine", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } });
const implemented = (split = true) => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: split ? { decision: "split", criteria: ["verification"], reason: "independent check" } : { decision: "none", reason: "small" } } });
const ultraBlocked = (stage = "exploration") => tool("report_result", { kind: "implement", summary: "Blocked before exploration", data: { status: "blocked", reason: "the user must decide the wording first", checklist: partial, ultra: { stage } } });
const tierProvider = (provider: string, id: string) => fauxProvider({ provider, models: [{ id, reasoning: true }] });

async function fixture(options: { models?: Record<string, unknown>; profiles?: Record<string, unknown>; routes?: Record<string, unknown>; single?: Record<string, unknown> } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: options.routes ?? {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", ...(options.models ? { models: options.models } : {}), ...(options.profiles ? { profiles: options.profiles } : {}), ...(options.single ? { single: options.single } : {}) }));
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-scratch-"));
  temp.push(scratchBase);
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, scratchBase });
  opened.push(pool);
  const mainFaux = tierProvider("main-reasoning", "current");
  h.runtime.registerNativeProvider(mainFaux.provider);
  const providers = { orch: tierProvider("tier-orch", "o1"), worker: tierProvider("tier-worker", "w1"), strong: tierProvider("strong-orch", "s1"), strongWorker: tierProvider("strong-worker", "sw1"), art: fauxProvider({ provider: "art", models: [{ id: "a1" }, { id: "a2" }] }) };
  for (const item of Object.values(providers)) h.runtime.registerNativeProvider(item.provider);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: mainFaux.getModel(), thinking: "high", ...args });
  return { h, pool, execute, mainFaux, ...providers };
}
/** The assignment message a worker received (its content; the timestamp differs between workers). */
const firstUser = (pool: WorkerPool, id: string) => JSON.stringify((pool.session(id).messages.find(message => message.role === "user") as { content?: unknown } | undefined)?.content);

describe("merged single mode and profiles: config, commands and texts", () => {
  it("modes: single, ultra, mdsd and direct; strong is no mode any more: mainMode \"strong\" is read as single with a warning", () => {
    expect(DEFAULT_MAIN_MODE).toBe("single");
    expect([...MAIN_MODES]).toEqual(["single", "ultra", "mdsd", "direct"]);
    expect(parseRouteConfig({ routes: {} }).mainMode).toBeUndefined();
    for (const mode of ["single", "ultra", "mdsd", "direct"]) expect(parseRouteConfig({ routes: {}, mainMode: mode }).mainMode).toBe(mode);
    const warnings: string[] = [];
    expect(parseRouteConfig({ routes: {}, mainMode: "strong" }, warnings)).toMatchObject({ mainMode: "single", legacyMainMode: "strong" });
    expect(warnings).toEqual(['config.mainMode "strong" was merged into "single": read as single with the profile "default" (no profile strong is defined); set mainMode to "single" and select a profile with /orche mode single --profile <name>.']);
    const withStrong: string[] = [];
    parseRouteConfig({ routes: {}, mainMode: "strong", profiles: { strong: { orchestrator: { model: "a/s" } } } }, withStrong);
    expect(withStrong[0]).toContain('read as single with the profile "strong";');
  });

  it("profiles: as many as needed, each overriding orchestrator, worker, advisor (null drops the top-level tier) and routes; default is reserved", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { orchestrator: { model: `prov/m${i}`, thinking: "low" } }]));
    const config = parseRouteConfig({ routes: {}, profiles: { ...many, fast: { orchestrator: { model: "a/o", thinking: "main" }, worker: null, advisor: { model: "main" }, routes: { "game-asset": { model: "art/a2" } } }, "한국어.v2": {} } });
    expect(profileNames(config.profiles)).toHaveLength(43);
    expect(profileNames(config.profiles)[0]).toBe(DEFAULT_PROFILE);
    expect(findProfile(config.profiles, "fast")).toEqual({ orchestrator: { model: "a/o", thinking: "main" }, worker: null, advisor: { model: "main" }, routes: { "game-asset": { model: "art/a2" } } });
    expect(findProfile(config.profiles, "p39")).toEqual({ orchestrator: { model: "prov/m39", thinking: "low" } });
    expect(findProfile(config.profiles, "한국어.v2")).toEqual({});
    // Inherited object members are no profiles; such a name is a profile only when the config defines it.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(findProfile(config.profiles, name)).toBeUndefined();
    expect(findProfile(parseRouteConfig({ routes: {}, profiles: JSON.parse('{"constructor": {"worker": {"model": "a/c"}}}') }).profiles, "constructor")).toEqual({ worker: { model: "a/c" } });
    expect(() => parseRouteConfig({ routes: {}, profiles: { default: {} } })).toThrow('config.profiles.default: "default" is reserved: the default profile is the top-level "models" and "routes"');
    expect(() => parseRouteConfig({ routes: {}, profiles: { "has space": {} } })).toThrow("config.profiles.has space: invalid profile name");
    expect(() => parseRouteConfig({ routes: {}, profiles: { "-x": {} } })).toThrow("invalid profile name");
    expect(() => parseRouteConfig({ routes: {}, profiles: { fast: { main: { model: "a/b" } } } })).toThrow("config.profiles.fast.main: unknown field (expected orchestrator, worker, advisor, routes; models.main is the Pi session's own model and is not part of a profile)");
    expect(() => parseRouteConfig({ routes: {}, profiles: { fast: { orchestrator: "a/b" } } })).toThrow("config.profiles.fast.orchestrator: expected route object");
    expect(() => parseRouteConfig({ routes: {}, profiles: { fast: { worker: { model: "a/b", thinking: "turbo" } } } })).toThrow("config.profiles.fast.worker.thinking: expected off");
    expect(() => parseRouteConfig({ routes: {}, profiles: { fast: { routes: { "game-asset": { model: "main" } } } } })).toThrow("config.profiles.fast.routes.game-asset.model: expected provider/modelId");
    expect(() => parseRouteConfig({ routes: {}, profiles: [] })).toThrow("config.profiles: expected object");
  });

  it("the legacy strong tiers load as the profile strong (worker unset: inherits the strong orchestrator, never models.worker), with a warning", () => {
    const warnings: string[] = [];
    const config = parseRouteConfig({ routes: {}, models: { orchestrator: { model: "a/o" }, worker: { model: "a/w" }, "strong-orchestrator": { model: "a/s", thinking: "xhigh" }, strongAdvisor: { model: "main" } } }, warnings);
    expect(config.models).toEqual({ orchestrator: { model: "a/o" }, worker: { model: "a/w" } });
    expect(findProfile(config.profiles, "strong")).toEqual({ orchestrator: { model: "a/s", thinking: "xhigh" }, worker: null, advisor: { model: "main" }, legacy: true });
    expect(warnings).toEqual(['config.models.{strong-orchestrator, strongAdvisor}: strong mode was merged into single; these tiers are read as the profile "strong" (profiles.strong), selected with --profile strong (e.g. /orche single --profile strong <PROMPT>; ultra and mdsd no longer pick them by themselves). Move them into "profiles": { "strong": { … } }.']);
    expect(profileTiers(config.models, config.profiles, "strong")).toEqual({ profile: "strong", orchestrators: [{ key: "profiles.strong.orchestrator", tier: { model: "a/s", thinking: "xhigh" } }, { key: "models.orchestrator", tier: { model: "a/o" } }], advisors: [{ key: "profiles.strong.advisor", tier: { model: "main" } }] });
    expect(findProfile(parseRouteConfig({ routes: {}, models: { strongWorker: { model: "a/sw" } } }).profiles, "strong")).toEqual({ worker: { model: "a/sw" }, legacy: true });
    expect(() => parseRouteConfig({ routes: {}, models: { "strong-worker": { model: "a/b" }, strongWorker: { model: "a/c" } } })).toThrow('"strong-worker" and "strongWorker" name the same tier');
    expect(() => parseRouteConfig({ routes: {}, models: { "strong-worker": { model: "a/b" } }, profiles: { strong: {} } })).toThrow("config.models.{strong-worker} and config.profiles.strong both define the profile \"strong\"");
    expect(() => parseRouteConfig({ routes: {}, models: { strong: { model: "a/b" } } })).toThrow("config.models.strong: unknown tier (expected main, orchestrator, worker, advisor;");
    expect(() => parseRouteConfig({ routes: {}, models: { "strong-orchestrator": "a/b" } })).toThrow("config.models.strong-orchestrator: expected route object");
    expect(parseRouteConfig({ routes: {}, models: { orchestrator: { model: "a/o" } } }).profiles).toBeUndefined();
  });

  it("profileTiers/applyProfile: profile tier, then the top-level tier, then inheritance; default is the top-level config unchanged; unknown names throw", () => {
    const models = { orchestrator: { model: "a/o" }, worker: { model: "a/w" }, advisor: { model: "a/v" } };
    const routes = parseRouteConfig({ routes: { "game-asset": { model: "art/a1" }, video: { model: "art/a1" } }, models, profiles: { fast: { orchestrator: { model: "b/o" } }, solo: { worker: null, advisor: null }, art: { routes: { "game-asset": { model: "art/a2", thinking: "low" } } } } });
    expect(profileTiers(models, routes.profiles)).toEqual({ profile: "default", orchestrators: [{ key: "models.orchestrator", tier: { model: "a/o" } }], worker: { key: "models.worker", tier: { model: "a/w" } }, advisors: [{ key: "models.advisor", tier: { model: "a/v" } }] });
    expect(profileTiers(models, routes.profiles, "default")).toEqual(profileTiers(models, routes.profiles));
    expect(profileTiers(models, routes.profiles, "fast")).toEqual({ profile: "fast", orchestrators: [{ key: "profiles.fast.orchestrator", tier: { model: "b/o" } }, { key: "models.orchestrator", tier: { model: "a/o" } }], worker: { key: "models.worker", tier: { model: "a/w" } }, advisors: [{ key: "models.advisor", tier: { model: "a/v" } }] });
    expect(profileTiers(models, routes.profiles, "solo")).toEqual({ profile: "solo", orchestrators: [{ key: "models.orchestrator", tier: { model: "a/o" } }], advisors: [] });
    expect(applyProfile(routes).config).toBe(routes);
    expect(applyProfile(routes, "fast").config).toBe(routes);
    const art = applyProfile(routes, "art").config;
    expect({ ...art.routes }).toEqual({ "game-asset": { model: "art/a2", thinking: "low" }, video: { model: "art/a1" } });
    expect({ ...routes.routes }).toEqual({ "game-asset": { model: "art/a1" }, video: { model: "art/a1" } }); // the config itself stays
    expect(() => profileTiers(models, routes.profiles, "nope")).toThrow(UnknownProfileError);
    expect(() => profileTiers(models, routes.profiles, "nope")).toThrow('Unknown profile "nope": orche.config.json defines "default", "fast", "solo", "art" ("default" is the top-level models).');
    expect(() => profileTiers(models, undefined, "constructor")).toThrow('Unknown profile "constructor"');
  });

  it("commands: --profile on the one-shot modes (default \"default\" when omitted), /orche mode <mode> --profile, the merged strong; bad input changes nothing", () => {
    expect(parseOrcheCommand("single fix the bug")).toEqual({ mode: "single", prompt: "fix the bug", profile: "default" });
    expect(parseOrcheCommand("ultra fix the bug")).toEqual({ mode: "ultra", prompt: "fix the bug", profile: "default" });
    expect(parseOrcheCommand("direct fix the bug")).toEqual({ mode: "direct", prompt: "fix the bug" });
    expect(parseOrcheCommand("single --profile fast fix the bug")).toEqual({ mode: "single", prompt: "fix the bug", profile: "fast" });
    expect(parseOrcheCommand("mdsd --profile=deep  why?")).toEqual({ mode: "mdsd", prompt: " why?", profile: "deep" });
    expect(parseOrcheCommand("single --profile default x")).toEqual({ mode: "single", prompt: "x", profile: "default" });
    expect(parseOrcheCommand("ultra --effort high --profile fast --summary-budget compact -- --profile is text\n  line 2")).toEqual({ mode: "ultra", prompt: "--profile is text\n  line 2", effort: "high", summaryBudget: "compact", profile: "fast" });
    expect(parseOrcheCommand("single --profile 한국어.v2 고쳐줘")).toEqual({ mode: "single", prompt: "고쳐줘", profile: "한국어.v2" });
    // The merged strong: single, the handler picks the profile strong (or default when the config defines none).
    expect(parseOrcheCommand("strong fix the bug")).toEqual({ mode: "single", prompt: "fix the bug", profile: "default", legacyStrong: true });
    expect(parseOrcheCommand("mode strong")).toEqual({ mode: "mode", value: "single", legacyStrong: true });
    expect(parseOrcheCommand("mode single")).toEqual({ mode: "mode", value: "single", profile: "default" });
    expect(parseOrcheCommand("mode ultra --profile fast")).toEqual({ mode: "mode", value: "ultra", profile: "fast" });
    expect(parseOrcheCommand("mode single --profile=fast")).toEqual({ mode: "mode", value: "single", profile: "fast" });
    expect(parseOrcheCommand("mode direct")).toEqual({ mode: "mode", value: "direct" });
    expect(parseOrcheCommand("mode")).toEqual({ mode: "mode" });
    for (const bad of ["ultra", "single --profile fast", "single --profile", "single --profile fast --profile slow x", "single --profile bad/name x", "direct --profile fast x", "strong --profile fast x", "mode single --profile", "mode single --profile a b", "mode direct --profile fast", "mode strong --profile fast", "mode turbo", "mode single --effort high", "workers --profile fast"]) expect(parseOrcheCommand(bad), bad).toBeUndefined();
    expect(effortUsage("single --profile")).toContain("orche single: --profile needs a profile name.");
    expect(effortUsage("single --profile fast --profile slow x")).toContain("orche single: --profile is given more than once");
    expect(effortUsage("single --profile bad/name x")).toContain('orche single: invalid --profile "bad/name"');
    expect(effortUsage("single --profile fast")).toContain("orche single: no prompt after --profile fast.");
    expect(effortUsage("direct --profile fast x")).toBe("orche direct: --profile applies to orche_task workers and direct mode runs none; use it with /orche single|ultra|mdsd. Nothing was sent.");
    expect(effortUsage("strong --profile fast x")).toContain("orche strong: strong mode was merged into single and already selects the profile \"strong\"; for another profile use /orche single --profile fast <PROMPT>.");
    expect(effortUsage("mode single --profile")).toContain("orche mode single: --profile needs a profile name.");
    expect(effortUsage("mode direct --profile fast")).toContain("orche mode direct: --profile applies to orche_task workers");
    expect(effortUsage("mode single --profile a b")).toContain("orche mode: --profile takes one profile name");
    expect(effortUsage("workers --profile fast")).toContain("orche: --profile belongs to a one-shot request");
    expect(oneShotUsage("strong")).toContain("strong mode was merged into single; it runs as /orche single --profile strong <PROMPT>");
    expect(oneShotUsage("ultra")).toContain("--profile <NAME> runs its workers on that model profile of orche.config.json, \"default\" when omitted");
    expect(ORCHE_USAGE).toContain("/orche single|ultra|mdsd|direct [--effort LEVEL] [--summary-budget BUDGET] [--profile NAME] <PROMPT> | /orche mode [single|ultra|mdsd|direct [--profile NAME]]");
    for (const mode of ["single", "ultra", "mdsd"] as const) expect(blockedTools(mode)).toEqual(["edit", "write", "ast_rewrite"]);
    // Completions: --profile with default and the config's profiles; never for direct.
    const values = completeOrcheArguments("single --", [], ["default", "fast"])!.map(item => item.value);
    expect(values).toEqual(expect.arrayContaining(["single --profile default ", "single --profile fast "]));
    expect(completeOrcheArguments("direct --", [], ["default", "fast"])!.map(item => item.value).filter(value => value.includes("--profile"))).toEqual([]);
    expect(completeOrcheArguments("mode single --", [], ["default", "fast"])!.map(item => item.value)).toEqual(["mode single --profile fast"]);
    expect(completeOrcheArguments("strong", [], [])).toBeNull();
  });

  it("main's rules: the default profile keeps the single text word for word; another profile adds one sentence and names its tier", () => {
    const single = delegationRules("single", { orchestratorModel: true });
    expect(delegationRules("single", { orchestratorModel: true, profile: "default", orchestratorKey: "models.orchestrator" })).toBe(single);
    const fast = delegationRules("single", { orchestratorModel: true, orchestratorKey: "profiles.fast.orchestrator", profile: "fast" });
    expect(fast).toContain("orche mode: single. Model profile: fast (profiles.fast in orche.config.json, selected with --profile): orche_task workers run on its orchestrator, worker and advisor models.");
    expect(fast.replace(/ Model profile: fast \([^)]*\): [^.]*\./, "").replace("(profiles.fast.orchestrator)", "(models.orchestrator)")).toBe(single);
    const ultra = delegationRules("ultra", { spawn: false });
    expect(ultra).toContain("orche mode: ultra (the single workflow with the quality-first ultra orchestration).");
    expect(ultra).not.toContain("strong");
    expect(ultra).toContain("The implement or answer worker is an ultra orchestrator");
    expect(ultra).toContain("Hand the whole task to ONE orche_task in ONE end-to-end assignment");
    expect(ultra).not.toContain("decides itself whether the task needs sub-workers");
  });

  it("the worker's prompt: one single prompt whatever the profile; ultra replaces the split decision with its stages", () => {
    const args = { role: "implement" as const, request, orchestrate: true };
    const ultra = assignmentPrompt({ ...args, mainMode: "ultra" }, []);
    expect(ultra).toContain("as its ultra orchestrator (Ultra mode below)");
    expect(ultra).not.toContain("decide whether to split");
    expect(assignmentPrompt({ ...args, mainMode: "single" }, [])).toContain("decide whether to split");
  });

  it("/orche models: the tiers of the profile in force, where each comes from, its fallbacks, and the defined profiles", () => {
    const view = { main: "p/m", thinking: "high", atStart: {}, advisor: true, mode: "single" };
    const config = parseRouteConfig({ routes: {}, models: { orchestrator: { model: "a/o" }, worker: { model: "a/w" } }, profiles: { deep: { orchestrator: { model: "a/s", thinking: "max" }, worker: null, advisor: { model: "a/v" } }, art: { routes: { video: { model: "art/a2" } } } } });
    const base = { ...view, tiers: config.models!, profiles: config.profiles! };
    const byDefault = formatModelTiers(base);
    expect(byDefault).toContain("; mode single; profile default):");
    expect(byDefault).toContain("- orchestrator (orche_task explore/answer/implement/verify): a/o (thinking: main's) — config models.orchestrator");
    expect(byDefault).toContain("- worker (orche_spawn sub-workers, the fresh verifier included): a/w (thinking: the orchestrator's) — config models.worker");
    expect(byDefault).toContain("- advisor (single.advisor on: one read-only plan review per orche_task explore/answer/implement/verify assignment): inherited from the orchestrator (a/o)");
    expect(byDefault).toContain("- profiles (select with --profile <name>; omitted: default): default (the top-level models); deep (orchestrator: a/s, worker: unset, advisor: a/v); art (routes: video)");
    const deep = formatModelTiers({ ...base, profile: "deep" });
    expect(deep).toContain("; mode single; profile deep):");
    expect(deep).toContain("- orchestrator (orche_task explore/answer/implement/verify): a/s max — config profiles.deep.orchestrator; unresolvable: models.orchestrator");
    expect(deep).toContain("- worker (orche_spawn sub-workers, the fresh verifier included): inherited from the orchestrator (a/s)");
    expect(deep).toContain("a/v (thinking: the orchestrator's) — config profiles.deep.advisor");
    expect(formatModelTiers({ ...base, profile: "art" })).toContain("- game-asset, video: their own routes (profiles.art.routes over the top-level routes)");
    const missing = formatModelTiers({ ...base, profile: "gone" });
    expect(missing).toContain("Profile gone is not defined: orche_task refuses it until it is defined or another profile is selected");
    expect(missing).toContain("config models.orchestrator");
    const legacy = parseRouteConfig({ routes: {}, models: { "strong-orchestrator": { model: "a/s" } } });
    expect(formatModelTiers({ ...view, tiers: legacy.models ?? {}, profiles: legacy.profiles!, profile: "strong" })).toContain("strong (orchestrator: a/s, worker: unset; from the former models.strong-* tiers)");
  });
});

describe("profiles through the worker pool: the profile governs the orchestrator, its sub-workers, the advisor and the routes", () => {
  it("a profile's orchestrator and worker run the assignment and its sub-workers; models.orchestrator/worker are not used", async () => {
    const { execute, strong, strongWorker, orch, worker } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "tier-worker/w1" } }, profiles: { deep: { orchestrator: { model: "strong-orch/s1", thinking: "low" }, worker: { model: "strong-worker/sw1", thinking: "minimal" } } } });
    strong.setResponses([spawnVerifier(), implemented()]);
    strongWorker.setResponses([verified()]);
    const result = await execute({ profile: "deep" });
    expect(strong.getPendingResponseCount() + strongWorker.getPendingResponseCount()).toBe(0);
    expect(orch.state.callCount + worker.state.callCount).toBe(0);
    expect(result.details).toMatchObject({ model: "strong-orch/s1", thinking: "low", modelSource: "config", profile: "deep", modelTier: "profiles.deep.orchestrator" });
    expect(result.details.mode).toBeUndefined();
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["strong-worker/sw1", "minimal", "config"]]);
    expect(result.text).toContain("Profile: deep (orchestrator: profiles.deep.orchestrator; sub-workers: profiles.deep.worker)");
    expect(result.text).toContain("Split: verification — independent check"); // the single flow, unchanged
  });

  it("no profile and --profile default run exactly on the top-level models (the baseline defaults), without a Profile line", async () => {
    const { execute, orch, worker, strong } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "tier-worker/w1", thinking: "low" } }, profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } } });
    for (const args of [{}, { profile: "default" }]) {
      orch.setResponses([spawnVerifier(), implemented()]);
      worker.setResponses([verified()]);
      const result = await execute(args);
      expect(orch.getPendingResponseCount() + worker.getPendingResponseCount(), JSON.stringify(args)).toBe(0);
      expect(result.details).toMatchObject({ model: "tier-orch/o1", thinking: "high", modelSource: "config", profile: "default", modelTier: "models.orchestrator" });
      expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["tier-worker/w1", "low", "config"]]);
      expect(result.text).not.toContain("Profile:");
      expect(result.text).not.toContain("Mode:");
    }
    expect(strong.state.callCount).toBe(0);
    // Without any models config the default profile inherits main, as before.
    const bare = await fixture();
    bare.mainFaux.setResponses([implemented(false)]);
    expect((await bare.execute()).details).toMatchObject({ model: "main-reasoning/current", modelSource: "main", profile: "default" });
  });

  it("precedence: a profile without a worker keeps models.worker; worker null inherits the profile's orchestrator; an unresolvable profile tier falls back to the top-level tier, then main", async () => {
    const keep = await fixture({ models: { worker: { model: "tier-worker/w1", thinking: "low" } }, profiles: { deep: { orchestrator: { model: "strong-orch/s1" } }, solo: { orchestrator: { model: "strong-orch/s1" }, worker: null } } });
    keep.strong.setResponses([spawnVerifier(), implemented()]);
    keep.worker.setResponses([verified()]);
    expect((await keep.execute({ profile: "deep" })).details.spawned?.map(item => [item.model, item.modelSource])).toEqual([["tier-worker/w1", "config"]]);
    keep.strong.setResponses([spawnVerifier(), verified(), implemented()]);
    const solo = await keep.execute({ profile: "solo" });
    expect(solo.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["strong-orch/s1", "high", "orchestrator"]]);
    expect(solo.text).toContain("sub-workers: the orchestrator's model");
    const fallback = await fixture({ models: { orchestrator: { model: "tier-orch/o1" } }, profiles: { deep: { orchestrator: { model: "nowhere/s" } }, empty: {} } });
    fallback.orch.setResponses([implemented(false), implemented(false)]);
    const unresolvable = await fallback.execute({ profile: "deep" });
    expect(unresolvable.details.warnings).toEqual(["Warning: profiles.deep.orchestrator nowhere/s is unresolvable in orche's runtime; falling back to models.orchestrator tier-orch/o1."]);
    expect(unresolvable.details).toMatchObject({ model: "tier-orch/o1", modelTier: "models.orchestrator", profile: "deep" });
    expect((await fallback.execute({ profile: "empty" })).details).toMatchObject({ model: "tier-orch/o1", modelTier: "models.orchestrator", profile: "empty" });
    const main = await fixture({ profiles: { deep: { orchestrator: { model: "nowhere/s" } } } });
    main.mainFaux.setResponses([implemented(false)]);
    const inherited = await main.execute({ profile: "deep" });
    expect(inherited.details).toMatchObject({ model: "main-reasoning/current", modelSource: "main", profile: "deep" });
    expect(inherited.text).toContain("Profile: deep (orchestrator: main's model");
  });

  it("the legacy strong tiers as profile strong: the sub-workers inherit the strong orchestrator, never models.worker (as strong mode did)", async () => {
    const { execute, strong, worker } = await fixture({ models: { worker: { model: "tier-worker/w1", thinking: "low" }, "strong-orchestrator": { model: "strong-orch/s1" } } });
    strong.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute({ profile: "strong" });
    expect(strong.getPendingResponseCount()).toBe(0);
    expect(worker.state.callCount).toBe(0);
    expect(result.details).toMatchObject({ model: "strong-orch/s1", thinking: "high", modelSource: "config", thinkingSource: "main", profile: "strong", modelTier: "profiles.strong.orchestrator" });
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["strong-orch/s1", "high", "orchestrator"]]);
  });

  it("an unknown profile fails before any worker starts, naming the defined profiles and where the selection came from", async () => {
    const { pool, execute, orch } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" } }, profiles: { deep: {} } });
    await expect(execute({ profile: "nope" })).rejects.toThrow('Unknown profile "nope" (the session\'s profile (/orche mode <mode> --profile);');
    await expect(execute({ profile: "nope", oneShot: { session: "single" } })).rejects.toThrow('Unknown profile "nope" (the one-shot request\'s --profile;');
    await expect(execute({ profile: "nope" })).rejects.toThrow('orche.config.json defines "default", "deep"');
    expect(pool.list()).toEqual([]);
    expect(orch.state.callCount).toBe(0);
  });

  it("one workflow whatever the profile: the same assignment prompt, tools and system prompt; only the model differs", async () => {
    const { pool, execute, orch, strong } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" } }, profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } } });
    orch.setResponses([implemented(false)]);
    strong.setResponses([implemented(false)]);
    await execute();
    await execute({ profile: "deep" });
    const normalize = (text: string) => text.replaceAll("W2", "W1").replaceAll("T2", "T1");
    expect(normalize(firstUser(pool, "W2"))).toBe(firstUser(pool, "W1"));
    expect(pool.session("W2").getActiveToolNames()).toEqual(pool.session("W1").getActiveToolNames());
    expect(normalize(pool.session("W2").systemPrompt)).toBe(pool.session("W1").systemPrompt);
    expect([pool.session("W1").model?.id, pool.session("W2").model?.id]).toEqual(["o1", "s1"]);
  });

  it("a profile's routes: an orche_task specialist and an orche_spawn specialist sub-worker run on them; a reused specialist is replaced when its route changes", async () => {
    const { execute, orch, art, pool } = await fixture({ routes: { "game-asset": { model: "art/a1" } }, models: { orchestrator: { model: "tier-orch/o1" } }, profiles: { art: { routes: { "game-asset": { model: "art/a2" } } } } });
    const sprite = () => [
      tool("write", { path: "assets/sprite.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }),
      tool("report_result", { kind: "game-asset", summary: "sprite made", data: { status: "done", outputs: [{ path: "assets/sprite.svg", type: "image/svg+xml", spec: "16x16" }], evidence: ["file assets/sprite.svg"] } }),
    ];
    const models: string[] = [];
    art.setResponses([...sprite(), ...sprite(), ...sprite()].map((step): FauxResponseStep => (_context, _options, _state, model) => { models.push(model.id); return step; }));
    const top = await execute({ role: "game-asset", files: ["assets/"] });
    expect(top.details).toMatchObject({ worker: "W1", model: "art/a1", modelSource: "route" });
    const reused = await execute({ role: "game-asset", files: ["assets/"], worker: "W1", profile: "art" });
    expect(reused.details).toMatchObject({ worker: "W2", model: "art/a2", retired: ["W1"] });
    expect(reused.text).toContain("W1 retired: profile art routes game-asset to art/a2 (profile default: art/a1); a fresh worker continues, briefed from W1's transcript.");
    orch.setResponses([
      tool(SPAWN_TOOL, { reason: "isolation", workers: [{ name: "sprites", role: "game-asset", request: "Make assets/sprite.svg, a 16x16 SVG.", files: ["assets/"] }] }),
      tool("report_result", { kind: "implement", summary: "Sprite from the specialist", data: { status: "done", checklist, split: { decision: "split", criteria: ["isolation"], reason: "game art needs the specialist" } } }),
    ]);
    const spawned = await execute({ profile: "art" });
    expect(spawned.details.spawned?.map(item => [item.role, item.model, item.modelSource])).toEqual([["game-asset", "art/a2", "route"]]);
    expect(models).toEqual(["a1", "a1", "a2", "a2", "a2", "a2"]);
    expect(pool.list().map(item => item.id)).toEqual(["W2", "W3"]);
  });
});

describe("profile switching, ultra and worker reuse", () => {
  it("default -> deep switches the reused worker's model; crossing the ultra boundary replaces the worker, briefed from the old one", async () => {
    const { pool, execute, orch, strong } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" } }, profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } } });
    orch.setResponses([implemented(false)]);
    expect((await execute()).details.model).toBe("tier-orch/o1");
    strong.setResponses([implemented(false)]);
    const switched = await execute({ profile: "deep", worker: "W1" });
    expect(switched.details).toMatchObject({ worker: "W1", model: "strong-orch/s1", profile: "deep" });
    expect(switched.text).toContain("Note: W1 switched from profile default to deep for this assignment: it runs on strong-orch/s1 (profiles.deep.orchestrator).");
    strong.setResponses([ultraBlocked()]);
    const ultra = await execute({ mainMode: "ultra", profile: "deep", worker: "W1" });
    expect(ultra.details).toMatchObject({ worker: "W2", status: "blocked", mode: "ultra", profile: "deep", model: "strong-orch/s1", retired: ["W1"] });
    expect(ultra.text).toContain("W1 retired: ultra mode needs the ultra tool set (orche_spawn stages, orche_adopt); a fresh worker continues, briefed from W1's transcript.");
    expect(ultra.text).toContain("Note: W2 continues the work of W1 in ultra mode");
    expect(ultra.text).toContain("Mode: ultra; Profile: deep (orchestrator: profiles.deep.orchestrator");
    expect(firstUser(pool, "W2")).toContain("## Handover: you (W2) continue the work of worker W1");
    expect(firstUser(pool, "W2")).toContain("Ultra mode (quality first");
    expect(pool.session("W2").getActiveToolNames()).toEqual(expect.arrayContaining([SPAWN_TOOL, ADOPT_TOOL]));
    orch.setResponses([implemented(false)]);
    const back = await execute({ worker: "W2" });
    expect(back.details).toMatchObject({ worker: "W3", model: "tier-orch/o1", retired: ["W2"] });
    expect(back.text).toContain("W2 retired: leaving ultra mode drops the ultra tool set");
    expect(pool.session("W3").getActiveToolNames()).not.toContain(ADOPT_TOOL);
    expect(firstUser(pool, "W3")).not.toContain("Ultra mode");
  });
});

type Context = Parameters<FauxResponseFactory>[0];
const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;
const subWorkerOf = (context: Context) => /You are sub-worker (W\d+\.\d+) \(\\"([^\\"]+)\\"\)/.exec(JSON.stringify(context.messages.find(message => message.role === "user")))?.[2];
/** The tool results of a session so far: tool name, ref and text, in order. */
const resultsOf = (context: Context) => context.messages.filter(message => message.role === "toolResult").map(message => {
  const text = JSON.stringify((message as { content?: unknown }).content);
  return { tool: (message as { toolName?: string }).toolName ?? "", ref: /\[orche ref (T\d+)/.exec(text)?.[1] ?? "", text, error: !!(message as { isError?: boolean }).isError };
});
function scripted(count: number, scripts: Record<string, (turn: number, context: Context) => AssistantMessage>): FauxResponseStep[] {
  const respond: FauxResponseFactory = context => {
    const name = subWorkerOf(context) ?? "orchestrator";
    const script = scripts[name];
    if (!script) throw new Error(`no script for ${name}`);
    return script(turnOf(context), context);
  };
  return Array.from({ length: count }, () => respond);
}

describe("ultra: end to end (faux models)", () => {
  it("runs on the selected profile (no mode picks models: without --profile the top-level models); single.spawn false is overridden with a visible note", async () => {
    const { execute, strong, orch } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "tier-worker/w1" } }, profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } }, single: { spawn: false } });
    orch.setResponses([ultraBlocked()]);
    const plain = await execute({ mainMode: "ultra" });
    expect(plain.details).toMatchObject({ model: "tier-orch/o1", mode: "ultra", profile: "default", modelTier: "models.orchestrator", status: "blocked" });
    expect(plain.text).toContain("Mode: ultra; Profile: default (orchestrator: models.orchestrator");
    strong.setResponses([ultraBlocked()]);
    const result = await execute({ mainMode: "ultra", profile: "deep" });
    expect(result.details).toMatchObject({ model: "strong-orch/s1", mode: "ultra", profile: "deep", modelTier: "profiles.deep.orchestrator", status: "blocked" });
    expect(result.details.ultra).toMatchObject({ stage: "exploration", candidateRounds: 0 });
    expect(result.text).toContain("Note: single.spawn: false does not apply in ultra mode");
    expect(result.text).toContain("Ultra: stage exploration; exploration 0/2 round(s)");
  });

  it("implement: exploration -> isolated candidates -> evaluation -> adoption -> review -> integration, with the gate rejecting a failed-check selection", async () => {
    const seen: Record<string, string> = {};
    let gateRejection = "";
    const { h, mainFaux, execute } = await fixture();
    await writeFile(join(h.cwd, "greeting.txt"), "hello\n");
    const workspaceOf = (context: Context, name: string) => new RegExp(`${name} \\(implement[\\s\\S]*?Workspace \\(candidate copy\\): ([^\\\\;]+?)(?:\\\\n|;|")`).exec(JSON.stringify(context.messages))?.[1];
    mainFaux.setResponses(scripted(19, {
      orchestrator: (turn, context) => {
        const results = resultsOf(context);
        const bash = results.filter(item => item.tool === "bash");
        const ultra = (selection: string) => ({
          stage: "complete", criteria: ["greeting.txt contains fixed (test/basis.sh)"], hypotheses: [{ claim: "greeting.txt lacks the word", verdict: "supported", evidence: [bash[0]!.ref] }],
          candidates: [{ id: "W1.3", verdict: "chosen", reason: "passes the basis", evidence: [bash[0]!.ref] }, { id: "W1.4", verdict: "rejected", reason: "fails the basis", evidence: [bash[1]!.ref] }],
          selection: { chosen: "W1.3", reason: "the only candidate passing the protected basis", evidence: [selection] }, review: [], integration: { evidence: [bash[2]?.ref ?? ""] },
        });
        switch (turn) {
          case 0: return tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh: exits 0 only when greeting.txt contains fixed.", files: ["test/"] }, { name: "cause", role: "answer", request: "Why does greeting.txt not say fixed? Hypotheses with a falsification check." }] });
          case 1: return tool("write", { path: "greeting.txt", content: "fixed by the orchestrator\n" });
          case 2: seen.ownWrite = results.at(-1)!.text; return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A: rewrite greeting.txt to say fixed.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B: append a line to greeting.txt.", files: ["greeting.txt"] }] });
          case 3: seen.wsA = workspaceOf(context, "cand-a") ?? ""; seen.wsB = workspaceOf(context, "cand-b") ?? ""; seen.mainDuring = "checked"; return tool("bash", { command: `cd '${seen.wsA}' && sh test/basis.sh` });
          case 4: return tool("bash", { command: `cd '${seen.wsB}' && sh test/basis.sh` });
          case 5: return tool(ADOPT_TOOL, { candidate: "W1.3" });
          case 6: seen.adopt = results.at(-1)!.text; return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "red", role: "verify", request: "Original request: greeting.txt says fixed. Find counterexamples." }] });
          case 7: return tool("bash", { command: "sh test/basis.sh" });
          case 8: return tool("report_result", { kind: "implement", summary: "Adopted W1.3", data: { status: "done", checklist, ultra: ultra(bash[1]!.ref) } });
          case 9: gateRejection = results.at(-1)!.text; return tool("report_result", { kind: "implement", summary: "Adopted W1.3 after evaluating both candidates", data: { status: "done", checklist, ultra: ultra(`${bash[0]!.ref} sh test/basis.sh -> exit 0`) } });
          default: throw new Error(`orchestrator turn ${turn}`);
        }
      },
      basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "test/basis.sh checks R1", data: { status: "done", evidence: ["sh test/basis.sh -> exit 1 on the current code"] } }),
      cause: () => tool("report_result", { kind: "answer", summary: "greeting.txt says hello, not fixed (greeting.txt:1)", data: { evidence: ["greeting.txt:1"] } }),
      "cand-a": (turn, context) => {
        if (turn === 0) { seen.candPrompt = JSON.stringify(context.messages.find(message => message.role === "user")); return tool("write", { path: "greeting.txt", content: "fixed\n" }); }
        if (turn === 1) return tool("write", { path: "test/basis.sh", content: "true\n" });
        seen.basisBlocked = resultsOf(context).at(-1)!.text;
        return tool("report_result", { kind: "implement", summary: "greeting.txt now says fixed", data: { status: "done", evidence: ["sh test/basis.sh -> exit 0"] } });
      },
      "cand-b": turn => turn === 0 ? tool("write", { path: "greeting.txt", content: "hello\nbroken\n" }) : tool("report_result", { kind: "implement", summary: "appended a line", data: { status: "done", evidence: [] } }),
      red: () => tool("report_result", { kind: "verify", summary: "no counterexample found", data: { passed: true, evidence: ["sh test/basis.sh -> 0"], issues: [] } }),
    }));
    const result = await execute({ mainMode: "ultra" });

    expect(mainFaux.getPendingResponseCount()).toBe(0);
    // The orchestrator cannot implement in the workspace before an adoption; a candidate cannot change the protected basis.
    expect(seen.ownWrite).toContain("Blocked (ultra): the implementation happens in candidates");
    expect(seen.basisBlocked).toContain("protected verification basis");
    expect(seen.candPrompt).toContain("Ultra candidate: you are one of several independent candidates");
    expect(seen.wsA).toContain(join("W1", "ultra", "W1.3"));
    expect(seen.adopt).toContain("Adopted W1.3 into the workspace: 1 file(s): greeting.txt");
    // The gate refused a selection that cited the failed check of the other candidate.
    expect(gateRejection).toContain("Ultra report gate:");
    expect(gateRejection).toContain("successful checks you ran in W1.3's workspace");
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("fixed\n");
    expect(await readFile(join(h.cwd, "test", "basis.sh"), "utf8")).toBe("grep -q fixed greeting.txt\n");
    expect(result.details).toMatchObject({ status: "done", mode: "ultra" });
    expect(result.details.ultra).toMatchObject({ stage: "complete", explorationRounds: 1, candidateRounds: 1, adoptions: ["W1.3"], verificationRounds: 1, gate: "passed", protectedBasis: ["test/basis.sh"] });
    expect(result.details.spawned?.map(item => [item.id, item.name, item.reason, item.status])).toEqual([
      ["W1.1", "basis", "exploration", "done"], ["W1.2", "cause", "exploration", "done"], ["W1.3", "cand-a", "candidates", "done"], ["W1.4", "cand-b", "candidates", "done"], ["W1.5", "red", "verification", "passed"],
    ]);
    expect(result.details.spawned?.find(item => item.id === "W1.3")?.changes).toEqual(["greeting.txt"]);
    expect(result.text).toContain("Ultra: stage complete; exploration 1/2 round(s), candidates 1/2 round(s) (W1.3 done adopted, W1.4 done), verification 1/2 round(s); report gate passed");
    expect(result.text).not.toContain("Split:");
  });

  it("integrity through the real hooks: changes made by shell after a check (in a copy or in the workspace) are caught at adoption and at the report", async () => {
    const seen: Record<string, string> = {};
    const { h, mainFaux, execute } = await fixture();
    await writeFile(join(h.cwd, "greeting.txt"), "hello\n");
    const copyOf = (context: Context, name: string) => new RegExp(`${name} \\(implement[\\s\\S]*?Workspace \\(candidate copy\\): ([^\\\\;]+?)(?:\\\\n|;|")`).exec(JSON.stringify(context.messages))?.[1] ?? "";
    mainFaux.setResponses(scripted(23, {
      orchestrator: (turn, context) => {
        const results = resultsOf(context);
        const bash = results.filter(item => item.tool === "bash");
        const last = results.at(-1)?.text ?? "";
        const report = (selection: string, integration: string) => tool("report_result", { kind: "implement", summary: "Adopted W1.3", data: { status: "done", checklist, ultra: {
          stage: "complete", criteria: ["greeting.txt contains fixed (test/basis.sh)"],
          candidates: [{ id: "W1.3", verdict: "chosen", reason: "passes the basis", evidence: [selection] }, { id: "W1.4", verdict: "rejected", reason: "fails the basis", evidence: [bash[3]!.ref] }],
          selection: { chosen: "W1.3", reason: "the only candidate passing the protected basis", evidence: [selection] }, review: [], integration: { evidence: [integration] },
        } } });
        switch (turn) {
          case 0: return tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh: exits 0 only when greeting.txt contains fixed.", files: ["test/"] }, { name: "cause", role: "answer", request: "Why does greeting.txt not say fixed?" }] });
          case 1: return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A: rewrite greeting.txt to say fixed.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B: append a line to greeting.txt.", files: ["greeting.txt"] }] });
          case 2: seen.a = copyOf(context, "cand-a"); seen.b = copyOf(context, "cand-b"); return tool("bash", { command: `cd '${seen.a}' && sh test/basis.sh` });
          case 3: return tool("bash", { command: `printf 'later\\n' >> '${seen.a}/greeting.txt'` }); // the copy changes after its check
          case 4: return tool(ADOPT_TOOL, { candidate: "W1.3" });
          case 5: seen.adoptRefused = last; return tool("bash", { command: `cd '${seen.a}' && sh test/basis.sh` });
          case 6: return tool("bash", { command: `cd '${seen.b}' && sh test/basis.sh` });
          case 7: return tool(ADOPT_TOOL, { candidate: "W1.3" });
          case 8: seen.adopted = last; return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "red", role: "verify", request: "Original request: greeting.txt says fixed. Find counterexamples." }] });
          case 9: return tool("bash", { command: "sh test/basis.sh" });
          case 10: return tool("bash", { command: "printf 'edited by shell\\n' >> greeting.txt" }); // the workspace changes after the check
          case 11: return report(bash[2]!.ref, bash[4]!.ref);
          case 12: seen.integrationRefused = last; return tool("bash", { command: "sh test/basis.sh" });
          case 13: return report(bash[0]!.ref, bash[6]!.ref); // a selection check that saw the copy before it changed
          case 14: seen.selectionRefused = last; return report(bash[2]!.ref, bash[6]!.ref);
          default: throw new Error(`orchestrator turn ${turn}`);
        }
      },
      basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "test/basis.sh checks R1", data: { status: "done", evidence: ["sh test/basis.sh"] } }),
      cause: () => tool("report_result", { kind: "answer", summary: "greeting.txt says hello (greeting.txt:1)", data: { evidence: ["greeting.txt:1"] } }),
      "cand-a": turn => turn === 0 ? tool("write", { path: "greeting.txt", content: "fixed\n" }) : tool("report_result", { kind: "implement", summary: "fixed", data: { status: "done", evidence: ["sh test/basis.sh -> 0"] } }),
      "cand-b": turn => turn === 0 ? tool("write", { path: "greeting.txt", content: "hello\nbroken\n" }) : tool("report_result", { kind: "implement", summary: "appended", data: { status: "done", evidence: [] } }),
      red: () => tool("report_result", { kind: "verify", summary: "no counterexample found", data: { passed: true, evidence: ["sh test/basis.sh -> 0"], issues: [] } }),
    }));
    const result = await execute({ mainMode: "ultra" });
    expect(mainFaux.getPendingResponseCount()).toBe(0);
    expect(seen.adoptRefused).toContain("W1.3's copy is not what your checks in it");
    expect(seen.adopted).toContain("Adopted W1.3 into the workspace: 1 file(s): greeting.txt");
    expect(seen.integrationRefused).toContain("the workspace now differs from what your integration checks");
    expect(seen.selectionRefused).toContain("did not evaluate the content of W1.3 that was adopted");
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("fixed\nlater\nedited by shell\n");
    expect(result.details).toMatchObject({ status: "done", mode: "ultra" });
    expect(result.details.ultra).toMatchObject({ stage: "complete", adoptions: ["W1.3"], gate: "passed" });
  });

  it("dependency directories: candidates write their private copies; the workspace, siblings and the earlier candidate stay unchanged", async () => {
    const { h, mainFaux, execute } = await fixture();
    await writeFile(join(h.cwd, ".gitignore"), "node_modules/\n.venv/\n");
    await mkdir(join(h.cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(h.cwd, "node_modules", "pkg", "index.js"), "orig\n");
    await mkdir(join(h.cwd, ".venv", "bin"), { recursive: true });
    await writeFile(join(h.cwd, ".venv", "bin", "pip"), `#!${h.cwd}/.venv/bin/python\n`);
    mainFaux.setResponses(scripted(14, {
      orchestrator: turn => {
        switch (turn) {
          case 0: return tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh for R1.", files: ["test/"] }, { name: "cause", role: "answer", request: "Hypotheses for R1." }] });
          case 1: return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A for greeting.txt, installing in the copy by shell.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B, patching a dependency file.", files: ["greeting.txt", "node_modules/"] }] });
          case 2: return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "fix-a", role: "implement", request: "Fix W1.3.", files: ["greeting.txt"], from: "W1.3" }, { name: "cand-c", role: "implement", request: "Approach C.", files: ["greeting.txt"] }] });
          default: return tool("report_result", { kind: "implement", summary: "Stopped after the candidates", data: { status: "blocked", reason: "test stops here", checklist: partial, ultra: { stage: "evaluation" } } });
        }
      },
      basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "basis", data: { status: "done" } }),
      cause: () => tool("report_result", { kind: "answer", summary: "cause", data: { evidence: ["greeting.txt:1"] } }),
      "cand-a": turn => turn === 0 ? tool("bash", { command: "printf 'A\\n' >> node_modules/pkg/index.js && printf 'A\\n' >> .venv/bin/pip" }) : tool("report_result", { kind: "implement", summary: "A", data: { status: "done" } }),
      "cand-b": turn => turn === 0 ? tool("write", { path: "node_modules/pkg/index.js", content: "B\n" }) : tool("report_result", { kind: "implement", summary: "B", data: { status: "done" } }),
      "fix-a": turn => turn === 0 ? tool("bash", { command: "printf 'F\\n' >> node_modules/pkg/index.js" }) : tool("report_result", { kind: "implement", summary: "F", data: { status: "done" } }),
      "cand-c": () => tool("report_result", { kind: "implement", summary: "C", data: { status: "done" } }),
    }));
    const result = await execute({ mainMode: "ultra" });
    expect(result.details).toMatchObject({ status: "blocked", mode: "ultra" });
    const copy = (id: string) => result.details.spawned!.find(item => item.id === id)!.workspace!;
    expect(result.details.spawned?.map(item => [item.id, item.status])).toEqual([["W1.1", "done"], ["W1.2", "done"], ["W1.3", "done"], ["W1.4", "done"], ["W1.5", "done"], ["W1.6", "done"]]);
    expect(await readFile(join(h.cwd, "node_modules", "pkg", "index.js"), "utf8")).toBe("orig\n");
    expect(await readFile(join(h.cwd, ".venv", "bin", "pip"), "utf8")).toBe(`#!${h.cwd}/.venv/bin/python\n`);
    expect(await readFile(join(copy("W1.3"), "node_modules", "pkg", "index.js"), "utf8")).toBe("orig\nA\n");
    expect(await readFile(join(copy("W1.3"), ".venv", "bin", "pip"), "utf8")).toBe(`#!${copy("W1.3")}/.venv/bin/python\nA\n`);
    expect(await readFile(join(copy("W1.4"), "node_modules", "pkg", "index.js"), "utf8")).toBe("B\n");
    expect(await readFile(join(copy("W1.5"), "node_modules", "pkg", "index.js"), "utf8")).toBe("orig\nA\nF\n");
    expect(await readFile(join(copy("W1.6"), "node_modules", "pkg", "index.js"), "utf8")).toBe("orig\n");
    expect(result.text).not.toContain("Isolation breach");
  });

  it("fail-closed links: a dependency link chained through a tracked link to a writable place outside refuses the candidates before any runs", async () => {
    let refused = "";
    const outside = await mkdtemp(join(tmpdir(), "orche-outside-"));
    temp.push(outside);
    await writeFile(join(outside, "shared.js"), "shared\n");
    const { h, mainFaux, execute } = await fixture();
    await writeFile(join(h.cwd, ".gitignore"), "node_modules/\n");
    await symlink(outside, join(h.cwd, "bridge"));
    await mkdir(join(h.cwd, "node_modules"), { recursive: true });
    await symlink(join(h.cwd, "bridge", "shared.js"), join(h.cwd, "node_modules", "chained"));
    mainFaux.setResponses(scripted(6, {
      orchestrator: (turn, context) => {
        if (turn === 0) return tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh for R1.", files: ["test/"] }, { name: "cause", role: "answer", request: "Hypotheses for R1." }] });
        if (turn === 1) return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A for greeting.txt.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B.", files: ["greeting.txt"] }] });
        refused = resultsOf(context).at(-1)!.text;
        return tool("report_result", { kind: "implement", summary: "Blocked: candidate copies cannot be isolated", data: { status: "blocked", reason: "bridge links outside the workspace", checklist: partial, ultra: { stage: "candidates" } } });
      },
      basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "basis", data: { status: "done" } }),
      cause: () => tool("report_result", { kind: "answer", summary: "cause", data: { evidence: ["greeting.txt:1"] } }),
    }));
    const result = await execute({ mainMode: "ultra" });
    expect(refused).toContain("Refused: the candidate copies could not be made (links in the candidate copy lead outside it");
    expect(refused).toContain("bridge");
    expect(result.details).toMatchObject({ status: "blocked" });
    expect(result.details.spawned?.map(item => item.id)).toEqual(["W1.1", "W1.2"]);
    expect(result.details.ultra).toMatchObject({ candidateRounds: 0 });
    expect(await readFile(join(outside, "shared.js"), "utf8")).toBe("shared\n");
  });

  it("answer (read-only): no adoption, stage order enforced, an incomplete answer must list what is missing", async () => {
    let adopt = "", early = "", rejected = "";
    const { mainFaux, execute } = await fixture();
    mainFaux.setResponses(scripted(4, {
      orchestrator: (turn, context) => {
        const last = resultsOf(context).at(-1)?.text ?? "";
        if (turn === 0) return tool(ADOPT_TOOL, { candidate: "W1.1" });
        if (turn === 1) { adopt = last; return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "a", role: "answer", request: "angle A" }, { name: "b", role: "answer", request: "angle B" }] }); }
        if (turn === 2) { early = last; return tool("report_result", { kind: "answer", summary: "Partial answer", data: { evidence: ["greeting.txt:1"], checklist: partial, ultra: { stage: "exploration" } } }); }
        rejected = last;
        return tool("report_result", { kind: "answer", summary: "Partial answer", data: { evidence: ["greeting.txt:1"], checklist: partial, ultra: { stage: "exploration" }, unresolved: ["no independent exploration ran"] } });
      },
    }));
    const result = await execute({ mainMode: "ultra", role: "answer", request: "Why does greeting.txt say hello?\nR1: name the cause." });
    expect(adopt).toContain("refused in a read-only (answer) assignment");
    expect(early).toContain("candidates come after an exploration round");
    expect(rejected).toContain("an incomplete ultra answer lists what is missing in data.unresolved");
    expect(result.details).toMatchObject({ mode: "ultra", role: "answer" });
    expect(result.details.ultra).toMatchObject({ stage: "exploration", candidateRounds: 0, gate: "accepted as incomplete (stopped at exploration)" });
  });
});

describe("ultra: resume", () => {
  it("the same worker continuing the same task keeps the ultra state (rounds, basis, candidates); a new task starts afresh", async () => {
    const { mainFaux, execute } = await fixture({ single: { ledger: true } });
    const blocked = (stage: string) => tool("report_result", { kind: "implement", summary: `Stopped at ${stage}`, data: { status: "blocked", reason: "time is up for this round", checklist: partial, ultra: { stage } } });
    mainFaux.setResponses(scripted(5, {
      orchestrator: turn => turn === 0
        ? tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh for R1.", files: ["test/"] }, { name: "cause", role: "answer", request: "Hypotheses for R1." }] })
        : blocked("candidates"),
      basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "basis written", data: { status: "done" } }),
      cause: () => tool("report_result", { kind: "answer", summary: "greeting.txt:1 says hello", data: { evidence: ["greeting.txt:1"] } }),
    }));
    const first = await execute({ mainMode: "ultra" });
    expect(first.details).toMatchObject({ task: "T1", status: "blocked" });
    expect(first.details.ultra).toMatchObject({ explorationRounds: 1, protectedBasis: ["test/basis.sh"] });
    mainFaux.setResponses([blocked("candidates")]);
    const resumed = await execute({ mainMode: "ultra", worker: "W1", task: "T1" });
    expect(resumed.details.ultra).toMatchObject({ explorationRounds: 1, protectedBasis: ["test/basis.sh"], carried: true });
    expect(resumed.text).toContain("continued from the previous assignment of this task");
    mainFaux.setResponses([blocked("exploration")]);
    const other = await execute({ mainMode: "ultra", worker: "W1" });
    expect(other.details.ultra).toMatchObject({ explorationRounds: 0, protectedBasis: [] });
    expect(other.details.ultra?.carried).toBeUndefined();
  });

  it("a continuation numbers its sub-workers after the earlier assignments': a fix from the incumbent never takes its id or deletes its copy, and the incumbent is adoptable after a new check", async () => {
    const { h, mainFaux, execute } = await fixture({ single: { ledger: true } });
    await writeFile(join(h.cwd, "greeting.txt"), "hello\n");
    const blocked = (stage: string) => tool("report_result", { kind: "implement", summary: `Stopped at ${stage}`, data: { status: "blocked", reason: "time is up for this assignment", checklist: partial, ultra: { stage } } });
    const seen: Record<string, string> = {};
    const scripts = {
      basis: (turn: number) => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "basis written", data: { status: "done" } }),
      cause: () => tool("report_result", { kind: "answer", summary: "greeting.txt:1 says hello", data: { evidence: ["greeting.txt:1"] } }),
      "cand-a": (turn: number) => turn === 0 ? tool("write", { path: "greeting.txt", content: "fixed incumbent\n" }) : tool("report_result", { kind: "implement", summary: "A", data: { status: "done" } }),
      "cand-b": (turn: number) => turn === 0 ? tool("write", { path: "greeting.txt", content: "broken\n" }) : tool("report_result", { kind: "implement", summary: "B", data: { status: "done" } }),
      "fix-a": (turn: number) => turn === 0 ? tool("write", { path: "greeting.txt", content: "fixed by the fix\n" }) : tool("report_result", { kind: "implement", summary: "F", data: { status: "done" } }),
      "cand-c": () => tool("report_result", { kind: "implement", summary: "C", data: { status: "done" } }),
    };
    mainFaux.setResponses(scripted(5, { ...scripts, orchestrator: turn => turn === 0 ? tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh for R1.", files: ["test/"] }, { name: "cause", role: "answer", request: "Hypotheses for R1." }] }) : blocked("candidates") }));
    const first = await execute({ mainMode: "ultra" });
    expect(first.details.spawned?.map(item => item.id)).toEqual(["W1.1", "W1.2"]);
    mainFaux.setResponses(scripted(6, { ...scripts, orchestrator: turn => turn === 2 ? tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A for greeting.txt.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B.", files: ["greeting.txt"] }] }) : blocked("evaluation") }));
    const second = await execute({ mainMode: "ultra", worker: "W1", task: "T1" });
    expect(second.details.spawned?.map(item => item.id)).toEqual(["W1.3", "W1.4"]);
    const incumbent = second.details.spawned!.find(item => item.id === "W1.3")!.workspace!;
    mainFaux.setResponses(scripted(7, { ...scripts, orchestrator: (turn, context) => {
      if (turn === 4) return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "fix-a", role: "implement", request: "Fix W1.3 from its failure evidence.", files: ["greeting.txt"], from: "W1.3" }, { name: "cand-c", role: "implement", request: "Approach C.", files: ["greeting.txt"] }] });
      if (turn === 5) return tool("bash", { command: `cd '${incumbent}' && sh test/basis.sh` });
      if (turn === 6) return tool(ADOPT_TOOL, { candidate: "W1.3" });
      seen.adopt = resultsOf(context).at(-1)!.text;
      return blocked("review");
    } }));
    const third = await execute({ mainMode: "ultra", worker: "W1", task: "T1" });
    expect(mainFaux.getPendingResponseCount()).toBe(0);
    expect(third.details.spawned?.map(item => [item.id, item.name, item.status])).toEqual([["W1.5", "fix-a", "done"], ["W1.6", "cand-c", "done"]]);
    expect(third.details.ultra).toMatchObject({ carried: true, candidateRounds: 2 });
    expect(third.details.ultra?.candidates.map(item => [item.id, item.status])).toEqual([["W1.3", "done"], ["W1.4", "done"], ["W1.5", "done"], ["W1.6", "done"]]);
    expect(await readFile(join(incumbent, "greeting.txt"), "utf8")).toBe("fixed incumbent\n");
    expect(await readFile(join(third.details.spawned![0]!.workspace!, "greeting.txt"), "utf8")).toBe("fixed by the fix\n");
    expect(seen.adopt).toContain("Adopted W1.3 into the workspace: 1 file(s): greeting.txt");
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("fixed incumbent\n");
  });
});

describe("modes and profiles through the extension", () => {
  it("/orche mode <mode> [--profile]: persisted with its profile, shown, survives a reload; an unknown profile changes nothing; edits blocked like single", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], mainMode: "ultra", profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } } });
    opened.push(h);
    const notes = () => h.notifications.map(note => note.message);
    const status = () => h.statuses.filter(item => item.key === "orche-mode").at(-1)?.text;
    await h.session.prompt("/orche mode");
    expect(notes().at(-1)).toContain("orche mode: ultra · profile default (config ");
    expect(h.session.getActiveToolNames()).not.toContain("edit");
    expect(h.session.getActiveToolNames()).toContain("orche_task");
    await h.session.prompt("/orche mode single --profile deep");
    expect(notes().at(-1)).toBe("orche mode: single · profile deep (saved in this session)");
    expect(status()).toBe("orche: single · profile deep");
    const entries = () => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "orche-mode").map(entry => (entry as { data?: unknown }).data);
    expect(entries()).toEqual([{ mode: "single", profile: "deep" }]);
    await h.session.prompt("/orche mode single --profile nope");
    expect(notes().at(-1)).toBe('orche mode single: Unknown profile "nope" (' + join(h.agentDir, "orche.config.json") + '): orche.config.json defines "default", "deep" ("default" is the top-level models). Define it under "profiles" or select another with --profile <name>. Nothing was changed.');
    expect(entries()).toEqual([{ mode: "single", profile: "deep" }]);
    await h.session.reload();
    await h.session.prompt("/orche mode");
    expect(notes().at(-1)).toBe("orche mode: single · profile deep (set with /orche mode in this session)");
    expect(status()).toBe("orche: single · profile deep");
    // Omitting --profile selects default again.
    await h.session.prompt("/orche mode ultra");
    expect(notes().at(-1)).toBe("orche mode: ultra · profile default (saved in this session)");
    expect(entries().at(-1)).toEqual({ mode: "ultra", profile: "default" });
    expect(h.session.getActiveToolNames()).not.toContain("write");
    await h.session.prompt("/orche mode direct");
    expect(notes().at(-1)).toBe("orche mode: direct (saved in this session)");
    expect(h.session.getActiveToolNames()).toContain("edit");
    expect(h.session.getActiveToolNames()).not.toContain("orche_task");
  });

  it("the session's profile governs plain turns; a one-shot request without --profile runs on default, with --profile on that profile; an unknown one sends nothing", async () => {
    const answered = (summary: string) => tool("report_result", { kind: "answer", summary, data: { evidence: ["greeting.txt:1"] } });
    const task = () => tool("orche_task", { role: "answer", request: "Inspect greeting.txt without changing files" });
    const h = await createHarness({
      mainSteps: [task(), reply("plain done"), task(), reply("one-shot default done"), task(), reply("one-shot deep done")],
      orcheSteps: [answered("on the default route")],
      profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } },
    });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    const deep = tierProvider("strong-orch", "s1");
    h.orche.runtime.registerNativeProvider(deep.provider);
    deep.setResponses([answered("on deep (session)"), answered("on deep (one-shot)")]);
    const results = () => h.session.messages.filter(message => message.role === "toolResult" && (message as { toolName?: string }).toolName === "orche_task").map(message => (message as { details?: { model?: string; profile?: string; requestMode?: unknown } }).details);
    await h.session.prompt("/orche mode single --profile deep");
    await h.session.prompt("inspect it");
    expect(results().at(-1)).toMatchObject({ model: "strong-orch/s1", profile: "deep" });
    // --profile omitted in a one-shot request: default (the top-level models; here the default route), not the session's deep.
    await h.session.prompt("/orche single inspect it again");
    expect(results().at(-1)).toMatchObject({ model: h.orche.route.model, profile: "default", requestMode: { mode: "single", profile: "default", sessionProfile: "deep", source: "one-shot" } });
    await h.session.prompt("/orche single --profile=deep and once more");
    expect(results().at(-1)).toMatchObject({ model: "strong-orch/s1", profile: "deep" });
    const calls = h.main.faux.state.callCount;
    await h.session.prompt("/orche ultra --profile nope fix it");
    expect(h.notifications.at(-1)?.message).toContain('orche ultra: Unknown profile "nope" (');
    expect(h.notifications.at(-1)?.message).toContain("Nothing was sent.");
    expect(h.main.faux.state.callCount).toBe(calls);
    expect(h.statuses.filter(item => item.key === "orche-mode").at(-1)?.text).toBe("orche: single · profile deep");
    expect(deep.getPendingResponseCount()).toBe(0);
  });

  it("a saved profile the config no longer defines: /orche models says so and orche_task refuses it instead of running on another model", async () => {
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "answer", request: "Inspect greeting.txt" }), reply("refused")],
      orcheSteps: [],
      profiles: { deep: { orchestrator: { model: "strong-orch/s1" } } },
    });
    opened.push(h);
    await h.session.prompt("/orche mode single --profile deep");
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single" }));
    await h.session.prompt("/orche models");
    expect(h.notifications.at(-1)?.message).toContain("Profile deep is not defined: orche_task refuses it");
    await h.session.prompt("inspect it");
    const result = JSON.stringify(h.session.messages.findLast(message => message.role === "toolResult"));
    expect(result).toContain('Unknown profile \\"deep\\" (the session\'s profile (/orche mode <mode> --profile)');
    expect(h.orche.faux.state.callCount).toBe(0);
  });

  it("the merged strong: mainMode \"strong\", a saved strong choice and /orche mode strong are single with the profile strong (default when none is defined)", async () => {
    const legacy = await createHarness({ mainSteps: [], orcheSteps: [], mainMode: "strong", models: { "strong-orchestrator": { model: "strong-orch/s1" } } });
    opened.push(legacy);
    const notes = (h: typeof legacy) => h.notifications.map(note => note.message);
    expect(notes(legacy).some(note => note.includes('config.mainMode "strong" was merged into "single": read as single with the profile "strong";'))).toBe(true);
    expect(notes(legacy).some(note => note.includes("these tiers are read as the profile \"strong\""))).toBe(true);
    await legacy.session.prompt("/orche mode");
    expect(notes(legacy).at(-1)).toContain("orche mode: single · profile strong (config ");
    // A session that saved the removed mode: restored as single with the profile strong.
    legacy.session.sessionManager.appendCustomEntry("orche-mode", { mode: "strong" });
    await legacy.session.reload();
    await legacy.session.prompt("/orche mode");
    expect(notes(legacy).at(-1)).toBe("orche mode: single · profile strong (set with /orche mode in this session)");
    await legacy.session.prompt("/orche mode strong");
    expect(notes(legacy).at(-2)).toBe('orche: strong mode was merged into single; mode strong runs as single with the profile "strong". Next time: /orche mode single --profile <NAME>.');
    expect(notes(legacy).at(-1)).toBe("orche mode: single · profile strong (saved in this session)");
    const none = await createHarness({ mainSteps: [], orcheSteps: [], mainMode: "strong" });
    opened.push(none);
    await none.session.prompt("/orche mode");
    expect(notes(none).at(-1)).toContain("orche mode: single · profile default (config ");
    await none.session.prompt("/orche mode strong");
    expect(notes(none).at(-2)).toContain('mode strong runs as single with the profile "default" (orche.config.json defines no profile strong)');
  });
});
