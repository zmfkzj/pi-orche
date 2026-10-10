/**
 * strong and ultra modes through the real stack (WorkerPool, faux-model sessions, the extension): strong is the single workflow on
 * `models.strong-orchestrator`/`models.strong-worker`; ultra is the quality-first stage flow (src/orchestrator/ultra.ts) on the same
 * strong tiers. Unit-level ultra rules are in test/orchestrator/ultra.test.ts. All model calls here are faux (no external API).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { assignmentPrompt, WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { blockedTools, delegationRules } from "../../src/extension/mode.js";
import { parseOrcheCommand } from "../../src/extension/index.js";
import { formatModelTiers } from "../../src/extension/main-model.js";
import { DEFAULT_MAIN_MODE, modeTiers, parseRouteConfig } from "../../src/orchestration/routing.js";
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

async function fixture(options: { models?: Record<string, unknown>; single?: Record<string, unknown> } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", ...(options.models ? { models: options.models } : {}), ...(options.single ? { single: options.single } : {}) }));
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-scratch-"));
  temp.push(scratchBase);
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, scratchBase });
  opened.push(pool);
  const mainFaux = tierProvider("main-reasoning", "current");
  h.runtime.registerNativeProvider(mainFaux.provider);
  const providers = { orch: tierProvider("tier-orch", "o1"), worker: tierProvider("tier-worker", "w1"), strong: tierProvider("strong-orch", "s1"), strongWorker: tierProvider("strong-worker", "sw1") };
  for (const item of Object.values(providers)) h.runtime.registerNativeProvider(item.provider);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: mainFaux.getModel(), thinking: "high", ...args });
  return { h, pool, execute, mainFaux, ...providers };
}
/** The assignment message a worker received (its content; the timestamp differs between workers). */
const firstUser = (pool: WorkerPool, id: string) => JSON.stringify((pool.session(id).messages.find(message => message.role === "user") as { content?: unknown } | undefined)?.content);

describe("strong/ultra: config, commands and texts", () => {
  it("parses the modes and the strong tiers (kebab-case or camelCase, not both); the default mode stays single", () => {
    expect(DEFAULT_MAIN_MODE).toBe("single");
    expect(parseRouteConfig({ routes: {} }).mainMode).toBeUndefined();
    for (const mode of ["single", "strong", "ultra", "direct"]) expect(parseRouteConfig({ routes: {}, mainMode: mode }).mainMode).toBe(mode);
    const config = parseRouteConfig({ routes: {}, models: { "strong-orchestrator": { model: "a/s", thinking: "xhigh" }, strongWorker: { model: "main" } } });
    expect(config.models).toEqual({ "strong-orchestrator": { model: "a/s", thinking: "xhigh" }, "strong-worker": { model: "main" } });
    expect(() => parseRouteConfig({ routes: {}, models: { "strong-worker": { model: "a/b" }, strongWorker: { model: "a/c" } } })).toThrow('"strong-worker" and "strongWorker" name the same tier');
    expect(() => parseRouteConfig({ routes: {}, models: { strong: { model: "a/b" } } })).toThrow("unknown tier (expected main, orchestrator, worker, advisor, strong-orchestrator, strong-worker)");
    expect(() => parseRouteConfig({ routes: {}, models: { "strong-orchestrator": "a/b" } })).toThrow("config.models.strong-orchestrator: expected route object");
  });

  it("modeTiers: single uses orchestrator/worker; strong and ultra use the strong tiers with models.orchestrator as the only fallback", () => {
    const tiers = { orchestrator: { model: "a/o" }, worker: { model: "a/w" }, "strong-orchestrator": { model: "a/s" } };
    expect(modeTiers(tiers, "single")).toEqual({ orchestrators: [{ key: "orchestrator", tier: { model: "a/o" } }], worker: { key: "worker", tier: { model: "a/w" } }, workerKey: "worker" });
    for (const mode of ["strong", "ultra"] as const) expect(modeTiers(tiers, mode)).toEqual({ orchestrators: [{ key: "strong-orchestrator", tier: { model: "a/s" } }, { key: "orchestrator", tier: { model: "a/o" } }], workerKey: "strong-worker" });
    expect(modeTiers({ worker: { model: "a/w" } }, "strong")).toEqual({ orchestrators: [], workerKey: "strong-worker" });
  });

  it("commands: one-turn /orche strong|ultra, /orche mode strong|ultra; the tool set of every delegating mode blocks edits", () => {
    expect(parseOrcheCommand("strong fix the bug")).toEqual({ mode: "strong", prompt: "fix the bug" });
    expect(parseOrcheCommand("ultra fix the bug")).toEqual({ mode: "ultra", prompt: "fix the bug" });
    expect(parseOrcheCommand("mode ultra")).toEqual({ mode: "mode", value: "ultra" });
    expect(parseOrcheCommand("ultra")).toBeUndefined();
    expect(parseOrcheCommand("mode turbo")).toBeUndefined();
    for (const mode of ["single", "strong", "ultra"] as const) expect(blockedTools(mode)).toEqual(["edit", "write", "ast_rewrite"]);
  });

  it("main's rules: strong is single word for word except the mode sentence and the tier name; ultra keeps the hand-off and adds its rule", () => {
    const single = delegationRules("single", { orchestratorModel: true });
    const strong = delegationRules("strong", { orchestratorModel: true, orchestratorKey: "strong-orchestrator" });
    expect(strong.replace(/^orche mode: strong \([^)]*\)\./, "orche mode: single.").replace("(models.strong-orchestrator)", "(models.orchestrator)")).toBe(single);
    const ultra = delegationRules("ultra", { spawn: false });
    expect(ultra).toContain("The implement or answer worker is an ultra orchestrator");
    expect(ultra).toContain("Hand the whole task to ONE orche_task in ONE end-to-end assignment");
    expect(ultra).not.toContain("decides itself whether the task needs sub-workers");
  });

  it("the worker's prompt: strong is the single prompt; ultra replaces the split decision with its stages", () => {
    const args = { role: "implement" as const, request, orchestrate: true };
    expect(assignmentPrompt({ ...args, mainMode: "strong" }, [])).toBe(assignmentPrompt({ ...args, mainMode: "single" }, []));
    expect(assignmentPrompt({ role: "answer", request, mainMode: "strong" }, [])).toBe(assignmentPrompt({ role: "answer", request, mainMode: "single" }, []));
    const ultra = assignmentPrompt({ ...args, mainMode: "ultra" }, []);
    expect(ultra).toContain("as its ultra orchestrator (Ultra mode below)");
    expect(ultra).not.toContain("decide whether to split");
  });

  it("/orche models names the strong tiers, their fallbacks and which tiers the mode uses", () => {
    const view = { main: "p/m", thinking: "high", atStart: {}, advisor: false };
    const unset = formatModelTiers({ ...view, mode: "strong", tiers: { orchestrator: { model: "a/o" }, worker: { model: "a/w" } } });
    expect(unset).toContain("- strong-orchestrator (strong and ultra modes, in place of the orchestrator): unset: falls back to models.orchestrator (a/o (thinking: main's))");
    expect(unset).toContain("- strong-worker (strong and ultra modes, in place of the worker): inherited from the strong orchestrator (a/o); models.worker does not apply");
    expect(unset).toContain("Mode strong: orche_task workers run on the strong tiers above");
    const set = formatModelTiers({ ...view, mode: "single", tiers: { "strong-orchestrator": { model: "a/s", thinking: "max" }, "strong-worker": { model: "a/sw" } } });
    expect(set).toContain("- strong-orchestrator (strong and ultra modes, in place of the orchestrator): a/s max — config models.strong-orchestrator");
    expect(set).toContain("- strong-worker (strong and ultra modes, in place of the worker): a/sw (thinking: the strong orchestrator's) — config models.strong-worker");
    expect(set).toContain("- worker (orche_spawn sub-workers, the fresh verifier included): inherited from the orchestrator (p/m)");
    expect(set).not.toContain("Mode single:");
  });
});

describe("strong: the single workflow on the strong tiers", () => {
  it("both strong tiers set: the orchestrator and its sub-workers run on them; models.orchestrator/worker are not used", async () => {
    const { execute, strong, strongWorker } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "tier-worker/w1" }, "strong-orchestrator": { model: "strong-orch/s1", thinking: "low" }, strongWorker: { model: "strong-worker/sw1", thinking: "minimal" } } });
    strong.setResponses([spawnVerifier(), implemented()]);
    strongWorker.setResponses([verified()]);
    const result = await execute({ mainMode: "strong" });
    expect(strong.getPendingResponseCount() + strongWorker.getPendingResponseCount()).toBe(0);
    expect(result.details).toMatchObject({ model: "strong-orch/s1", thinking: "low", modelSource: "config", mode: "strong", modelTier: "strong-orchestrator" });
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["strong-worker/sw1", "minimal", "config"]]);
    expect(result.text).toContain("Mode: strong (orchestrator: models.strong-orchestrator; sub-workers: models.strong-worker)");
    expect(result.text).toContain("Split: verification — independent check"); // the single flow, unchanged
  });

  it("strong-worker unset: sub-workers inherit the strong orchestrator (with phase thinking unchanged), never models.worker", async () => {
    const { execute, strong } = await fixture({ models: { worker: { model: "tier-worker/w1", thinking: "low" }, "strong-orchestrator": { model: "strong-orch/s1" } } });
    strong.setResponses([spawnVerifier(), verified(), implemented()]);
    const result = await execute({ mainMode: "strong" });
    expect(strong.getPendingResponseCount()).toBe(0);
    expect(result.details).toMatchObject({ model: "strong-orch/s1", thinking: "high", modelSource: "config", thinkingSource: "main" });
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.modelSource])).toEqual([["strong-orch/s1", "high", "orchestrator"]]);
    expect(result.text).toContain("sub-workers: the orchestrator's model");
  });

  it("strong-orchestrator unset falls back to models.orchestrator, then to main; an unresolvable one says so and falls back", async () => {
    const one = await fixture({ models: { orchestrator: { model: "tier-orch/o1" } } });
    one.orch.setResponses([implemented(false)]);
    expect((await one.execute({ mainMode: "strong" })).details).toMatchObject({ model: "tier-orch/o1", modelSource: "config", modelTier: "orchestrator" });
    const two = await fixture();
    two.mainFaux.setResponses([implemented(false)]);
    const inherited = await two.execute({ mainMode: "strong" });
    expect(inherited.details).toMatchObject({ model: "main-reasoning/current", modelSource: "main", mode: "strong" });
    expect(inherited.details.modelTier).toBeUndefined();
    expect(inherited.text).toContain("Mode: strong (orchestrator: main's model");
    const three = await fixture({ models: { "strong-orchestrator": { model: "nowhere/s" }, orchestrator: { model: "tier-orch/o1" } } });
    three.orch.setResponses([implemented(false)]);
    const fallback = await three.execute({ mainMode: "strong" });
    expect(fallback.details.warnings).toEqual(["Warning: models.strong-orchestrator nowhere/s is unresolvable in orche's runtime; falling back to models.orchestrator tier-orch/o1."]);
    expect(fallback.details).toMatchObject({ model: "tier-orch/o1", modelTier: "orchestrator" });
  });

  it("single ignores the strong tiers (unchanged result text, no mode fields)", async () => {
    const { execute, orch } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, "strong-orchestrator": { model: "strong-orch/s1" }, "strong-worker": { model: "strong-worker/sw1" } } });
    orch.setResponses([implemented(false)]);
    const result = await execute();
    expect(result.details).toMatchObject({ model: "tier-orch/o1", modelSource: "config" });
    expect(result.details.mode).toBeUndefined();
    expect(result.text).not.toContain("Mode:");
  });

  it("strong ≡ single: the same assignment prompt, tools and system prompt; only the model differs", async () => {
    const { pool, execute, orch, strong } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, "strong-orchestrator": { model: "strong-orch/s1" } } });
    orch.setResponses([implemented(false)]);
    strong.setResponses([implemented(false)]);
    await execute();
    await execute({ mainMode: "strong" });
    const normalize = (text: string) => text.replaceAll("W2", "W1").replaceAll("T2", "T1");
    expect(normalize(firstUser(pool, "W2"))).toBe(firstUser(pool, "W1"));
    expect(pool.session("W2").getActiveToolNames()).toEqual(pool.session("W1").getActiveToolNames());
    expect(normalize(pool.session("W2").systemPrompt)).toBe(pool.session("W1").systemPrompt);
    expect([pool.session("W1").model?.id, pool.session("W2").model?.id]).toEqual(["o1", "s1"]);
  });
});

describe("mode switching and worker reuse", () => {
  it("single -> strong switches the reused worker's model; crossing the ultra boundary replaces the worker, briefed from the old one", async () => {
    const { pool, execute, orch, strong } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, "strong-orchestrator": { model: "strong-orch/s1" } } });
    orch.setResponses([implemented(false)]);
    expect((await execute()).details.model).toBe("tier-orch/o1");
    strong.setResponses([implemented(false)]);
    const switched = await execute({ mainMode: "strong", worker: "W1" });
    expect(switched.details).toMatchObject({ worker: "W1", model: "strong-orch/s1", mode: "strong" });
    expect(switched.text).toContain("Note: W1 switched from single to strong mode for this assignment: it runs on strong-orch/s1 (models.strong-orchestrator).");
    strong.setResponses([ultraBlocked()]);
    const ultra = await execute({ mainMode: "ultra", worker: "W1" });
    expect(ultra.details).toMatchObject({ worker: "W2", status: "blocked", mode: "ultra", model: "strong-orch/s1", retired: ["W1"] });
    expect(ultra.text).toContain("W1 retired: ultra mode needs the ultra tool set (orche_spawn stages, orche_adopt); a fresh worker continues, briefed from W1's transcript.");
    expect(ultra.text).toContain("Note: W2 continues the work of W1 in ultra mode");
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
  it("runs on the strong tiers; single.spawn false is overridden with a visible note", async () => {
    const { execute, strong } = await fixture({ models: { orchestrator: { model: "tier-orch/o1" }, worker: { model: "tier-worker/w1" }, "strong-orchestrator": { model: "strong-orch/s1" } }, single: { spawn: false } });
    strong.setResponses([ultraBlocked()]);
    const result = await execute({ mainMode: "ultra" });
    expect(result.details).toMatchObject({ model: "strong-orch/s1", mode: "ultra", modelTier: "strong-orchestrator", status: "blocked" });
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
          case 1: return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A, installing in the copy by shell.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B, patching a dependency file.", files: ["greeting.txt", "node_modules/"] }] });
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
        if (turn === 1) return tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B.", files: ["greeting.txt"] }] });
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
    mainFaux.setResponses(scripted(6, { ...scripts, orchestrator: turn => turn === 2 ? tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Approach B.", files: ["greeting.txt"] }] }) : blocked("evaluation") }));
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

describe("strong/ultra through the extension", () => {
  it("/orche mode strong|ultra: persisted, shown, edits blocked like single", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], mainMode: "strong" });
    opened.push(h);
    const notes = () => h.notifications.map(note => note.message);
    await h.session.prompt("/orche mode");
    expect(notes().at(-1)).toContain("orche mode: strong (config ");
    expect(h.session.getActiveToolNames()).not.toContain("edit");
    expect(h.session.getActiveToolNames()).toContain("orche_task");
    await h.session.prompt("/orche mode ultra");
    expect(notes().at(-1)).toBe("orche mode: ultra (saved in this session)");
    await h.session.reload();
    await h.session.prompt("/orche mode");
    expect(notes().at(-1)).toBe("orche mode: ultra (set with /orche mode in this session)");
    expect(h.session.getActiveToolNames()).not.toContain("write");
    await h.session.prompt("/orche mode direct");
    expect(h.session.getActiveToolNames()).toContain("edit");
    expect(h.session.getActiveToolNames()).not.toContain("orche_task");
  });
});
