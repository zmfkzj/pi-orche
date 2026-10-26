/**
 * MDSD mode end to end through WorkerPool (docs/mdsd.md): a one-shot `mdsd` request's answer worker runs the search policy with
 * real faux-model sessions for the orchestrator, its explorers and a verifier — two diversified first-round paths plus one that is
 * stopped by its budget, an adaptive round that acts on the aggregation, verification, a rejected then accepted report — and the
 * next ordinary request runs without the MDSD tool set and gate. A second case exhausts the aggregate budget (every stage refused,
 * the orchestrator stopped, a forced report kept usable); a third cancels the task during a search round. The policy's rules
 * themselves are unit-tested in test/orchestrator/mdsd.test.ts. Deterministic: no real model.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { createHarness, tool } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
const temp: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Context = Parameters<FauxResponseFactory>[0];
const textOf = (context: Context) => JSON.stringify(context.messages);
const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;
const firstUser = (context: Context) => JSON.stringify(context.messages.find(message => message.role === "user"));
const subWorkerOf = (context: Context) => /You are sub-worker (W\d+\.\d+) \(\\"([^\\"]+)\\"\)/.exec(firstUser(context))?.[2];
const lastToolResult = (context: Context, name: string) => JSON.stringify([...context.messages].reverse().find(message => message.role === "toolResult" && message.toolName === name) ?? null);
function scripted(count: number, scripts: Record<string, (turn: number, context: Context) => AssistantMessage>): FauxResponseStep[] {
  const respond: FauxResponseFactory = context => {
    const name = subWorkerOf(context) ?? "orchestrator";
    const script = scripts[name];
    if (!script) throw new Error(`no script for ${name}`);
    return script(turnOf(context), context);
  };
  return Array.from({ length: count }, () => respond);
}
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  return out;
}

const MODELS = { orchestrator: { model: "tier-orch/o1" }, "strong-orchestrator": { model: "strong-orch/s1" } };
async function pool(mdsd: Record<string, unknown>) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.cwd, "STYLE.md"), "Greetings are lowercase.\n");
  await writeFile(join(h.cwd, "greeting.txt"), "Hello orche\n");
  await writeFile(join(h.cwd, "notes.md"), "The brand name keeps its capital.\n");
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", models: MODELS, mdsd }));
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-mdsd-"));
  temp.push(scratchBase);
  const workers = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir, scratchBase });
  opened.push(workers);
  const general = fauxProvider({ provider: "tier-orch", models: [{ id: "o1", reasoning: true }] });
  const strong = fauxProvider({ provider: "strong-orch", models: [{ id: "s1", reasoning: true }] });
  h.runtime.registerNativeProvider(general.provider);
  h.runtime.registerNativeProvider(strong.provider);
  const request = "Intent/Purpose: decide whether greeting.txt follows the style guide\nRequirements:\nR1: name every rule it breaks, with evidence.\nConstraints and non-goals: do not change files.\nOriginal request\ngreeting.txt가 스타일 가이드를 따르는지 판단해줘.";
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => workers.execute({ role: "answer", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", thinking: "off", ...args });
  return { h, workers, execute, general, strong, scratchBase };
}

const plan = { objective: "Decide whether greeting.txt follows the style guide and name every rule it breaks.", constraints: ["Do not change files."], success: ["Each broken rule has evidence."], rationale: "Rules, brand notes and other examples can each show a different breach." };
const strategies = {
  rules: { framing: "Work backward from the style guide's rules to what a greeting must satisfy.", operators: ["INVERT"], hypothesis_space: ["the guide requires lowercase greetings"], evidence_scope: ["STYLE.md"], method: ["list each rule", "derive what it implies"], reasoning: ["deduction"], direction: "backward", validation: ["constraint-check"] },
  attack: { framing: "Assume the current greeting is wrong and look for the evidence that shows it.", operators: ["CHALLENGE"], hypothesis_space: ["the greeting breaks the brand tone"], evidence_scope: ["greeting.txt", "brand notes in notes.md"], method: ["collect counterexamples"], reasoning: ["abduction"], direction: "cross-cutting", validation: ["falsification"] },
  analogy: { framing: "Compare with how other products greet.", operators: ["TRANSFER"], hypothesis_space: ["other products greet by name"], evidence_scope: ["examples directory"], method: ["compare greetings"], reasoning: ["comparison"], direction: "top-down", validation: ["comparison"] },
  settle: { framing: "Settle F1 by checking every line against the rule.", operators: ["VALIDATE"], hypothesis_space: ["F1 holds for every line"], evidence_scope: ["greeting.txt"], method: ["check each line"], reasoning: ["experiment"], direction: "bottom-up", validation: ["reproduction"], purpose: "exploit", targets: ["F1"] },
  unseen: { framing: "What did no path look at?", operators: ["EXPAND"], hypothesis_space: ["localisation files define another greeting"], evidence_scope: ["locales translations"], method: ["list locale files"], reasoning: ["induction"], direction: "bottom-up", validation: ["comparison"], purpose: "explore" },
};
const explorerReport = (findings: Record<string, unknown>[], extra: Record<string, unknown> = {}) => tool("report_result", <never>{
  kind: "answer", summary: `${findings.length} finding(s)`,
  data: { evidence: ["read the declared sources"], findings: findings.map(item => ({ evidence: ["seen in the file"], counter_evidence: [], uncertainty: "medium", ...item })), counter_evidence: [], uncertainty: "medium", explored_scope: ["the declared sources"], unexplored_scope: [], sources_used: ["the files read"], procedures: ["read", "compare"], ...extra },
});
const finalReport = (findings: Record<string, unknown>[], stop = { reason: "sufficient", basis: "the rule breach is verified" }) => tool("report_result", <never>{
  kind: "answer", summary: "greeting.txt breaks the lowercase rule",
  data: { evidence: ["W1.6 verified greeting.txt:1"], checklist: [{ id: "R1", status: stop.reason === "budget" ? "partial" : "met", evidence: "greeting.txt:1 against STYLE.md:1", ...(stop.reason === "budget" ? {} : { verifiedBy: "W1.6 (fresh verifier)" }) }], mdsd: { decision: "diversified", reason: "rules, brand notes and examples are separate evidence", objective: plan.objective, findings, explored_scope: ["STYLE.md", "greeting.txt", "notes.md"], unexplored_scope: ["examples directory (its path was stopped)"], stop } },
});

describe("mdsd mode through WorkerPool", () => {
  it("one-shot mdsd: diversified first round with a budget-stopped path, an adaptive round on the aggregation, verification, gate rejection then acceptance; the next plain request drops MDSD", async () => {
    const { workers, execute, general, strong, scratchBase } = await pool({ explorer: { requests: 2, minutes: 30, costUSD: 5, outputTokens: 100_000 } });
    const seen: Record<string, string> = {};
    strong.setResponses(scripted(60, {
      orchestrator: (turn, context) => {
        if (turn === 0) return tool(SPAWN_TOOL, { reason: "search", plan, workers: [
          { name: "rules", role: "answer", request: "Check the style guide's rules.", strategy: strategies.rules },
          { name: "attack", role: "answer", request: "Attack the greeting.", strategy: strategies.attack },
          { name: "analogy", role: "answer", request: "Compare with other products.", strategy: strategies.analogy },
        ] });
        if (turn === 1) {
          seen.round1 = lastToolResult(context, SPAWN_TOOL);
          return tool(SPAWN_TOOL, { reason: "search", adapt: { basis: ["F1", "D1"], reason: "F1 and F3 agree on greeting.txt:1 but the counter-evidence of F3 needs settling; nobody looked at locales" }, workers: [
            { name: "settle", role: "answer", request: "Settle F1.", strategy: strategies.settle },
            { name: "unseen", role: "answer", request: "Look where nobody looked.", strategy: strategies.unseen },
          ] });
        }
        if (turn === 2) { seen.round2 = lastToolResult(context, SPAWN_TOOL); return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: decide whether greeting.txt follows STYLE.md. Check greeting.txt:1 against the lowercase rule yourself." }] }); }
        const kept = [
          { id: "M1", claim: "greeting.txt:1 breaks the lowercase rule of STYLE.md", status: "confirmed", provenance: ["F1", "F3", "F4"], evidence: ["W1.6 verified it"], counter_evidence: ["notes.md keeps the brand name's capital, but 'Hello' is not the brand name"], uncertainty: "low" },
          { id: "M2", claim: "STYLE.md does not say whether punctuation is allowed", status: "unverified", provenance: ["F2"], evidence: [], counter_evidence: [], uncertainty: "high" },
        ];
        if (turn === 3) return finalReport(kept);
        seen.rejected = lastToolResult(context, "report_result");
        return finalReport([...kept, { id: "M3", claim: "No locale file overrides the greeting", status: "disputed", provenance: ["F5"], evidence: ["ls: no locales directory"], counter_evidence: [], uncertainty: "medium", dissent: "locales may be generated at build time; not checked" }]);
      },
      rules: turn => turn === 0 ? tool("read", { path: "STYLE.md" }) : explorerReport([
        { id: "f1", claim: "The guide requires lowercase greetings; greeting.txt:1 starts with a capital.", location: ["greeting.txt:1"], uncertainty: "low" },
        { id: "f2", claim: "STYLE.md does not say whether punctuation is allowed.", uncertainty: "high" },
      ], { unexplored_scope: ["punctuation rules in other documents"] }),
      attack: turn => turn === 0 ? tool("read", { path: "greeting.txt" }) : explorerReport([
        { id: "f1", claim: "greeting.txt:1 'Hello' is capitalised against the guide.", location: ["greeting.txt:1"], counter_evidence: ["notes.md keeps a capital for the brand name"] },
      ]),
      // Never reports: its session is stopped at 1.25 x its 2-request allocation, and its last text is kept as partial work.
      analogy: () => tool("read", { path: "notes.md" }),
      settle: turn => turn === 0 ? tool("read", { path: "greeting.txt" }) : explorerReport([{ id: "f1", claim: "Every line of greeting.txt checked: line 1 breaks the lowercase rule.", location: ["greeting.txt:1"], uncertainty: "low" }]),
      unseen: turn => turn === 0 ? tool("ls", { path: "." }) : explorerReport([{ id: "f1", claim: "No locale files exist, so nothing overrides the greeting." }]),
      check: () => tool("report_result", { kind: "verify", summary: "greeting.txt:1 is capitalised; STYLE.md requires lowercase", data: { passed: true, evidence: ["read greeting.txt:1: Hello orche", "read STYLE.md:1"], issues: [] } }),
    }));
    const result = await execute({ mainMode: "mdsd", oneShot: { session: "single" } });

    // The search policy's tool set: orche_spawn with strategy specs.
    const spawnSchema = JSON.stringify(workers.session("W1").getToolDefinition(SPAWN_TOOL)?.parameters);
    expect(spawnSchema).toContain('"strategy"');
    expect(spawnSchema).toContain('"adapt"');
    expect(result.details).toMatchObject({ worker: "W1", mode: "mdsd", model: "strong-orch/s1", requestMode: { mode: "mdsd", source: "one-shot", session: "single" } });
    // Round 1: the aggregation the orchestrator integrated (duplicates of F1/F3, the conflict, the gap) and the stopped path.
    expect(seen.round1).toContain("D1");
    expect(seen.round1).toContain("C1");
    expect(seen.round1).toContain("G1");
    expect(seen.round1).toContain("requests at 3/2 requests (1.25x the allocation)");
    expect(seen.round2).toContain("MDSD search round 2/3");
    expect(seen.rejected).toContain("unaccounted: F5=W1.5:f1");
    const mdsd = result.details.mdsd!;
    expect(mdsd).toMatchObject({ decision: "diversified", rounds: 2, strategies: 5, distinctSignatures: 5, verificationRounds: 1, gate: "passed" });
    expect(mdsd.explorers.map(item => [item.id, item.round, item.status, item.findings])).toEqual([["W1.1", 1, "done", 2], ["W1.2", 1, "done", 1], ["W1.3", 1, "failed", 0], ["W1.4", 2, "done", 1], ["W1.5", 2, "done", 1]]);
    expect(mdsd.explorers[2]).toMatchObject({ stoppedBy: "requests at 3/2 requests (1.25x the allocation)", files: 1 });
    expect(mdsd.explorers[0]).toMatchObject({ files: 1, allocated: { requests: 2 } });
    expect(mdsd.findings).toEqual({ explorers: 5, final: 3, byStatus: { confirmed: 1, unverified: 1, disputed: 1 }, dropped: 0, firstRoundOnly: 1, adaptiveOnly: 1, both: 1, orchestratorOnly: 0 });
    expect(mdsd.budget).toMatchObject({ spentRequests: expect.any(Number), inFlightUnknown: 0 });
    expect(mdsd.phases.map(item => item.phase)).toEqual(["planning", "search-1", "integration-1", "search-2", "integration-2", "verification-1", "after-verification-1"]);
    expect(result.text).toMatch(/MDSD: diversified; 2\/3 search round\(s\), 5 strategies \(5 distinct signatures\)/);
    expect(result.text).toContain("report gate passed");
    expect(result.text).not.toContain("Split:");
    // The complete round data is in the orchestrator's scratch directory.
    const files = (await filesUnder(scratchBase)).map(file => file.slice(file.lastIndexOf("/") + 1)).sort();
    expect(files).toEqual(expect.arrayContaining(["mdsd-W1-round-1.json", "mdsd-W1-round-1.md", "mdsd-W1-round-2.json", "mdsd-W1-round-2.md"]));
    const round1 = JSON.parse(await readFile((await filesUnder(scratchBase)).find(file => file.endsWith("mdsd-W1-round-1.json"))!, "utf8")) as { explorers: { id: string; partial?: string }[] };
    expect(round1.explorers.find(item => item.id === "W1.3")?.partial).toBeUndefined(); // no text, only tool calls: nothing to keep

    // The next ordinary request (session mode single) leaves mdsd: W1 is retired, a fresh worker has the plain tool set and no MDSD gate.
    const plainCalls: string[] = [];
    general.setResponses(Array.from({ length: 6 }, () => (context: Context) => { plainCalls.push(firstUser(context).slice(0, 300)); return tool("report_result", { kind: "answer", summary: "plain", data: { evidence: ["greeting.txt:1"], checklist: [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "read greeting.txt" }] } }); }));
    const later = await execute({ worker: "W1", mainMode: "single" });
    expect(later.details.worker).not.toBe("W1");
    expect(later.text).toContain("W1 retired: leaving mdsd mode drops the MDSD tool set");
    expect(later.text).not.toContain("MDSD:");
    expect(later.details.mdsd).toBeUndefined();
    expect(JSON.stringify(workers.session(later.details.worker!).getToolDefinition(SPAWN_TOOL)?.parameters)).not.toContain('"strategy"');
    expect(plainCalls).toHaveLength(1);
  });

  it("aggregate budget exhausted: the notice refuses every further stage, the stop forces a report that stays usable and is recorded", async () => {
    const { execute, strong } = await pool({ explorer: { requests: 2, minutes: 30, costUSD: 5, outputTokens: 100_000 }, total: { costUSD: 100, requests: 20 } });
    const seen: Record<string, string> = {};
    strong.setResponses(scripted(60, {
      orchestrator: (turn, context) => {
        const text = textOf(context);
        if (turn === 0) return tool(SPAWN_TOOL, { reason: "search", plan, workers: [
          { name: "rules", role: "answer", request: "Check the rules.", strategy: strategies.rules },
          { name: "attack", role: "answer", request: "Attack the greeting.", strategy: strategies.attack },
        ] });
        if (text.includes("The MDSD total budget is used up")) {
          return finalReport([{ id: "M1", claim: "greeting.txt:1 breaks the lowercase rule", status: "unverified", provenance: ["F1"], evidence: [], counter_evidence: [], uncertainty: "medium" }], { reason: "budget", basis: "stopped by mdsd.total" });
        }
        if (text.includes("No further orche_spawn call is admitted") && !seen.refused) {
          seen.refused = "pending";
          return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Check greeting.txt:1." }] });
        }
        if (seen.refused === "pending") seen.refused = lastToolResult(context, SPAWN_TOOL);
        // A noncompliant orchestrator keeps working after the notice: the stop ends its turn.
        return tool("read", { path: "greeting.txt" });
      },
      rules: turn => turn === 0 ? tool("read", { path: "STYLE.md" }) : explorerReport([{ id: "f1", claim: "greeting.txt:1 starts with a capital against the lowercase rule.", location: ["greeting.txt:1"] }]),
      attack: turn => turn === 0 ? tool("read", { path: "greeting.txt" }) : explorerReport([{ id: "f1", claim: "Hello is capitalised.", location: ["greeting.txt:3"] }]),
    }));
    const result = await execute({ mainMode: "mdsd" });
    expect(seen.refused).toContain("Refused (MDSD budget): the run reached its final-report allowance");
    const mdsd = result.details.mdsd!;
    expect(mdsd.budget).toMatchObject({ totalRequests: 20, noticed: expect.stringMatching(/^\$0 \/ 18 requests of \$100 \/ 20$/), stopped: expect.stringMatching(/^\$0 \/ 20 requests of \$100 \/ 20$/), exhausted: expect.stringContaining("final-report allowance") });
    // 20 at the stop, the request the stop cut short (counted, its usage as reported), the forced report: the bounded overshoot.
    expect(mdsd.budget.spentRequests).toBe(22);
    expect(mdsd.budget.overTotal).toMatch(/^spent \$0 \/ 22 requests of \$100 \/ 20/);
    expect(mdsd.gate).toBe("passed after the budget stop (1 explorer finding(s) left unaccounted)");
    expect(mdsd.verificationRounds).toBe(0);
    expect(result.text).toContain("STOPPED at $0 / 20 requests of $100 / 20");
  });

  it("cancelled during a search round: the task ends cancelled, the explorers' sessions are stopped and their partial state is reported", async () => {
    const { execute, strong } = await pool({ explorer: { requests: 5, minutes: 30, costUSD: 5, outputTokens: 100_000 } });
    const cancel = new AbortController();
    strong.setResponses(scripted(30, {
      orchestrator: () => tool(SPAWN_TOOL, { reason: "search", plan, workers: [
        { name: "rules", role: "answer", request: "Check the rules.", strategy: strategies.rules },
        { name: "attack", role: "answer", request: "Attack the greeting.", strategy: strategies.attack },
      ] }),
      rules: () => { cancel.abort(new Error("cancelled by user")); return tool("read", { path: "STYLE.md" }); },
      attack: () => tool("read", { path: "greeting.txt" }),
    }));
    const failure = await execute({ mainMode: "mdsd", signal: cancel.signal }).then(() => undefined, (error: unknown) => error as { message: string; details?: { status?: string; mdsd?: { explorers: { status: string }[] } } });
    expect(failure?.message).toMatch(/cancelled/);
    expect(failure?.details?.status).toBe("cancelled");
  });

  it("replication experiment: a pinned round runs once per model on two different providers, each cell with its own route and private scratch; verification stays on the orchestrator's model; one search round only", async () => {
    const pinnedRound = { plan, workers: [
      { name: "rules", role: "answer", request: "Recorded request: check the style guide's rules; probes under your scratch directory.", strategy: strategies.rules },
      { name: "attack", role: "answer", request: "Recorded request: attack the greeting.", strategy: strategies.attack },
    ] };
    const { execute, strong, h, scratchBase } = await pool({ maxRounds: 1, explorerScratch: true, explorer: { requests: 6, minutes: 30, costUSD: 5, outputTokens: 100_000 }, replication: { models: [{ model: "rep-a/a1" }, { model: "rep-b/b1" }], round: pinnedRound } });
    const repA = fauxProvider({ provider: "rep-a", models: [{ id: "a1", reasoning: true }] });
    const repB = fauxProvider({ provider: "rep-b", models: [{ id: "b1", reasoning: true }] });
    h.runtime.registerNativeProvider(repA.provider);
    h.runtime.registerNativeProvider(repB.provider);
    const served: string[] = [];
    const prompts: Record<string, string> = {};
    const results: Record<string, string> = {};
    const scratchOf = (context: Context) => /Use your scratch directory (\S+) for temporary files/.exec(firstUser(context))?.[1];
    /** The first user message's content only (its timestamp differs between sessions). */
    const promptOf = (context: Context) => JSON.stringify(context.messages.find(message => message.role === "user")?.content);
    const cells = (provider: string) => ({
      rules: (turn: number, context: Context) => {
        if (turn === 0) { served.push(`rules@${provider}`); prompts[`rules@${provider}`] = promptOf(context); return tool("write", { path: `${scratchOf(context)}/probe.txt`, content: `probe of ${provider}` }); }
        if (turn === 1) { results[`rules@${provider}:own`] = lastToolResult(context, "write"); return tool("write", { path: "STYLE.md", content: "changed" }); }
        results[`rules@${provider}:workspace`] = lastToolResult(context, "write");
        return explorerReport([{ id: "f1", claim: `greeting.txt:1 breaks the lowercase rule (seen on ${provider})`, location: ["greeting.txt:1"] }]);
      },
      attack: (turn: number, context: Context) => {
        if (turn === 0) { served.push(`attack@${provider}`); prompts[`attack@${provider}`] = promptOf(context); return tool("read", { path: "greeting.txt" }); }
        return explorerReport([{ id: "f1", claim: `Hello is capitalised (seen on ${provider})`, location: ["greeting.txt:1"] }]);
      },
    });
    repA.setResponses(scripted(10, cells("rep-a")));
    repB.setResponses(scripted(10, cells("rep-b")));
    const seen: Record<string, string> = {};
    strong.setResponses(scripted(30, {
      orchestrator: (turn, context) => {
        if (turn === 0) return tool(SPAWN_TOOL, { reason: "search", workers: [{ name: "rules", role: "answer", request: "pinned" }, { name: "attack", role: "answer", request: "pinned" }] });
        if (turn === 1) { seen.round1 = lastToolResult(context, SPAWN_TOOL); return tool(SPAWN_TOOL, { reason: "search", plan, adapt: { basis: ["F1"], reason: "once more" }, workers: [{ name: "settle", role: "answer", request: "Settle F1.", strategy: strategies.settle }, { name: "unseen", role: "answer", request: "Look elsewhere.", strategy: strategies.unseen }] }); }
        if (turn === 2) { seen.second = lastToolResult(context, SPAWN_TOOL); return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Check greeting.txt:1 against the lowercase rule of STYLE.md yourself." }] }); }
        return finalReport([{ id: "M1", claim: "greeting.txt:1 breaks the lowercase rule of STYLE.md", status: "confirmed", provenance: ["W1.1:f1", "W1.2:f1", "W1.3:f1", "W1.4:f1"], evidence: ["W1.5 verified it"], counter_evidence: [], uncertainty: "low" }]);
      },
      check: () => { served.push("check@strong-orch"); return tool("report_result", { kind: "verify", summary: "greeting.txt:1 is capitalised", data: { passed: true, evidence: ["read greeting.txt:1"], issues: [] } }); },
    }));
    const result = await execute({ mainMode: "mdsd", oneShot: { session: "single" } });

    // Each cell ran on its own provider, the verifier on the orchestrator's model (no substitution anywhere).
    expect(served.sort()).toEqual(["attack@rep-a", "attack@rep-b", "check@strong-orch", "rules@rep-a", "rules@rep-b"]);
    // The cells of one strategy got the pinned request (not "pinned") and the same brief: their prompts differ only in id and scratch path.
    const normal = (text: string) => text.replace(/W1\.\d/g, "W1.n").replace(/Use your scratch directory \S+ for/, "Use your scratch directory DIR for");
    expect(prompts["rules@rep-a"]).toContain("Recorded request: check the style guide's rules; probes under your scratch directory.");
    expect(normal(prompts["rules@rep-a"]!)).toBe(normal(prompts["rules@rep-b"]!));
    expect(normal(prompts["attack@rep-a"]!)).toBe(normal(prompts["attack@rep-b"]!));
    expect(prompts["rules@rep-a"]).not.toBe(prompts["rules@rep-b"]);
    // Own scratch writable through the file tool; the workspace stays read-only.
    expect(results["rules@rep-a:own"]).toContain('"toolName":"write"');
    expect(results["rules@rep-a:own"]).not.toContain("Blocked");
    expect(results["rules@rep-a:own"]).not.toContain('"isError":true');
    expect(results["rules@rep-b:workspace"]).toContain("read-only");
    const written = (await filesUnder(scratchBase)).filter(file => file.endsWith("probe.txt"));
    expect(written.map(file => file.split("/").at(-2)).sort()).toEqual(["W1.1", "W1.3"]);
    expect(await readFile(written.find(file => file.includes("/W1.3/"))!, "utf8")).toBe("probe of rep-b");
    // One measured search round: the second search call is refused before anything runs.
    expect(seen.round1).toContain("2 strategies x 2 models = 4 explorer cells");
    expect(seen.second).toContain("cap mdsd.maxRounds 1");
    const mdsd = result.details.mdsd!;
    expect(mdsd).toMatchObject({ decision: "diversified", rounds: 1, strategies: 2, distinctSignatures: 2, replication: { models: ["rep-a/a1", "rep-b/b1"], cells: 4, pinned: true }, verificationRounds: 1, gate: "passed" });
    expect(mdsd.explorers.map(item => [item.id, item.model, item.group, item.status])).toEqual([["W1.1", "rep-a/a1", "W1.1", "done"], ["W1.2", "rep-a/a1", "W1.2", "done"], ["W1.3", "rep-b/b1", "W1.1", "done"], ["W1.4", "rep-b/b1", "W1.2", "done"]]);
    expect(result.text).toContain("2 strategies (2 distinct signatures), each on 2 models: 4 explorer cells (pinned first round)");
  });

  it("replication with a model orche's runtime does not have: the assignment fails before any model call, naming it (no substitution)", async () => {
    const { execute, strong } = await pool({ replication: { models: [{ model: "strong-orch/s1" }, { model: "absent/model" }] } });
    let calls = 0;
    strong.setResponses(Array.from({ length: 3 }, () => () => { calls++; return tool("report_result", { kind: "answer", summary: "x" }); }));
    const failure = await execute({ mainMode: "mdsd" }).then(() => undefined, (error: unknown) => error as { message: string });
    expect(failure?.message).toContain("MDSD replication: absent/model is not available in orche's runtime (mdsd.replication.models); no other model is substituted.");
    expect(calls).toBe(0);
  });
});
