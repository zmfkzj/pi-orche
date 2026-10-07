/**
 * The single workflow's orchestrator end to end (docs/orchestrator.md): orche_task's implement worker decides whether to split,
 * runs sub-workers with orche_spawn in real faux-model sessions and reports its decision. Unit-level rules (planSpawn, the guard,
 * splitError) are in test/orchestrator/spawn.test.ts; this file checks the wiring through WorkerPool and the extension.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxProvider, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { ORCHESTRATOR_TEAM_LINE, SPLIT_JUDGMENT } from "../../src/orchestrator/instructions.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { readSplitLog } from "../../src/orchestrator/split-log.js";
import { createHarness, tool, type Harness } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = "Intent/Purpose: add two greeting files\nRequirements:\nR1: alpha.txt and beta.txt exist with the agreed text.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사 파일 두 개를 만들어줘.";
const checklist = [{ id: "R1", status: "met", evidence: "alpha.txt:1, beta.txt:1", verifiedBy: "cat alpha.txt beta.txt" }];
type Context = Parameters<FauxResponseFactory>[0];
const textOf = (context: Context) => JSON.stringify(context.messages);
const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;
const firstUser = (context: Context) => JSON.stringify(context.messages.find(message => message.role === "user"));
/** The sub-worker a context belongs to (its assignment names it), or undefined for the orchestrator. */
const subWorkerOf = (context: Context) => /You are sub-worker (W\d+\.\d+) \(\\"([^\\"]+)\\"\)/.exec(firstUser(context))?.[2];
/** A failed tool call of `name` in the context (an error result), if any. */
const toolErrorOf = (context: Context, name: string) => context.messages.find(message => message.role === "toolResult" && message.toolName === name && message.isError);

/**
 * One response factory for every model call of the task: orchestrator and sub-worker sessions share the faux queue in any
 * interleaving, so each call is answered by the script of the session it belongs to, at that session's turn.
 */
function scripted(count: number, scripts: Record<string, (turn: number, context: Context) => AssistantMessage | Promise<AssistantMessage>>): FauxResponseStep[] {
  const respond: FauxResponseFactory = context => {
    const name = subWorkerOf(context) ?? "orchestrator";
    const script = scripts[name];
    if (!script) throw new Error(`no script for ${name}`);
    return script(turnOf(context), context);
  };
  return Array.from({ length: count }, () => respond);
}

async function fixture(steps: FauxResponseStep[], options: { records?: boolean; single?: Record<string, unknown> } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, records: options.records ?? false, ...(options.single ? { single: options.single } : {}) });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  opened.push(pool);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", ...args });
  return { h, pool, execute };
}
const assignmentOf = (h: Harness, pool: WorkerPool) => JSON.stringify(pool.session("W1").messages.find(message => message.role === "user")) + h.cwd;

describe("orchestrator: no split (the default)", () => {
  it("does the work itself, reports data.split none and has orche_spawn available", async () => {
    const { h, pool, execute } = await fixture([
      tool("write", { path: "alpha.txt", content: "alpha\n" }),
      tool("write", { path: "beta.txt", content: "beta\n" }),
      tool("report_result", { kind: "implement", summary: "Wrote both files", data: { status: "done", checklist, split: { decision: "none", reason: "two tiny coupled edits; splitting costs more than it saves" } } }),
    ]);
    const result = await execute();
    expect(pool.session("W1").getActiveToolNames()).toContain(SPAWN_TOOL);
    expect(assignmentOf(h, pool)).toContain("Orchestration: you are the orchestrator of this task");
    // Not told it works alone (read as a ban on sub-workers in evaluation v2), in the assignment or the system prompt.
    expect(assignmentOf(h, pool)).toContain(ORCHESTRATOR_TEAM_LINE);
    expect(assignmentOf(h, pool)).not.toContain("You work alone");
    expect(pool.session("W1").systemPrompt).toContain("you start sub-workers only with orche_spawn");
    expect(pool.session("W1").systemPrompt).not.toContain("You work alone");
    expect(JSON.stringify(pool.session("W1").messages)).toContain(JSON.stringify(SPLIT_JUDGMENT).slice(1, 200));
    expect(result.details.split).toEqual({ decision: "none", reason: "two tiny coupled edits; splitting costs more than it saves" });
    expect(result.details.spawned).toBeUndefined();
    expect(result.text).toContain("Split: none — two tiny coupled edits; splitting costs more than it saves");
    expect(result.text).not.toContain("Sub-workers:");
    expect(await readFile(join(h.cwd, "alpha.txt"), "utf8")).toBe("alpha\n");
  });

  it("accepts a report without data.split when nothing was spawned", async () => {
    const { execute } = await fixture([tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist } })]);
    const result = await execute();
    expect(result.details.split).toBeUndefined();
    expect(result.text).toContain("Split: none (not reported)");
  });

  it("single.spawn false keeps the earlier single worker: no orche_spawn, no orchestration text, no Split line", async () => {
    const { h, pool, execute } = await fixture([tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist } })], { single: { spawn: false } });
    const result = await execute();
    expect(pool.session("W1").getActiveToolNames()).not.toContain(SPAWN_TOOL);
    expect(assignmentOf(h, pool)).not.toContain("Orchestration:");
    expect(assignmentOf(h, pool)).toContain("You work alone; there are no peers or backlog.");
    expect(pool.session("W1").systemPrompt).toContain("You work alone: there are no peer workers.");
    expect(result.text).not.toContain("Split:");
  });

  it("only implement and answer are orchestrators: an explore worker's orche_spawn is refused", async () => {
    let refused = "";
    const { pool, execute } = await fixture([
      tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "a", role: "answer", request: "x" }, { name: "b", role: "answer", request: "y" }] }),
      context => { refused = JSON.stringify(toolErrorOf(context, SPAWN_TOOL)); return tool("report_result", { kind: "explore", summary: "Found it", data: { evidence: ["greeting.txt:1"] } }); },
    ]);
    const result = await execute({ role: "explore", request: "Where is the greeting?" });
    expect(pool.session("W1").getActiveToolNames()).toContain(SPAWN_TOOL); // registered once per single-workflow session
    expect(refused).toContain("available only to the orchestrator");
    expect(result.text).not.toContain("Split:");
  });
});

describe("orchestrator: parallel split", () => {
  it("runs the sub-workers at the same time on the orchestrator's model, keeps each in its own files and blocks spawning below depth 1", async () => {
    const main = fauxProvider({ provider: "main-reasoning", models: [{ id: "big", reasoning: true }] });
    let entered = 0;
    let release!: () => void;
    const together = new Promise<void>(resolve => { release = resolve; });
    let concurrent = false;
    const seen: Record<string, string> = {};
    const orchestratorTurns: string[] = [];
    const steps = scripted(8, {
      orchestrator: (turn, context) => {
        orchestratorTurns.push(textOf(context));
        if (turn === 0) return tool(SPAWN_TOOL, { reason: "parallelism", workers: [
          { name: "alpha", role: "implement", request: "Create alpha.txt containing alpha. Acceptance: cat alpha.txt prints alpha.", files: ["alpha.txt"] },
          { name: "beta", role: "implement", request: "Create beta.txt containing beta. Acceptance: cat beta.txt prints beta.", files: ["beta.txt"] },
        ] });
        return tool("report_result", { kind: "implement", summary: "Both files written by sub-workers; checked them", data: { status: "done", checklist, split: { decision: "split", criteria: ["parallelism"], reason: "two independent files" } } });
      },
      alpha: async (turn, context) => {
        if (turn === 0) {
          if (++entered === 2) release();
          concurrent = await Promise.race([together.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000))]);
          return tool("write", { path: "beta.txt", content: "alpha was here\n" });
        }
        if (turn === 1) { seen.alphaBlocked = JSON.stringify(toolErrorOf(context, "write")); return tool("write", { path: "alpha.txt", content: "alpha\n" }); }
        return tool("report_result", { kind: "implement", summary: "alpha.txt written", data: { status: "done", evidence: ["cat alpha.txt"] } });
      },
      beta: async (turn, context) => {
        if (turn === 0) {
          seen.betaPrompt = firstUser(context);
          if (++entered === 2) release();
          await Promise.race([together, new Promise(resolve => setTimeout(resolve, 5_000))]);
          return tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "x", role: "answer", request: "x" }, { name: "y", role: "answer", request: "y" }] });
        }
        if (turn === 1) { seen.betaSpawn = JSON.stringify(toolErrorOf(context, SPAWN_TOOL)); return tool("write", { path: "beta.txt", content: "beta\n" }); }
        return tool("report_result", { kind: "implement", summary: "beta.txt written", data: { status: "done", evidence: ["cat beta.txt"] } });
      },
    });
    main.setResponses(steps);
    const { h, execute } = await fixture([], { records: true });
    h.runtime.registerNativeProvider(main.provider);
    const result = await execute({ model: main.getModel("big")!, thinking: "high" });

    expect(concurrent).toBe(true);
    expect(main.getPendingResponseCount()).toBe(0);
    expect(await readFile(join(h.cwd, "alpha.txt"), "utf8")).toBe("alpha\n");
    expect(await readFile(join(h.cwd, "beta.txt"), "utf8")).toBe("beta\n");
    // File conflicts: a sibling's file is blocked for the sub-worker that does not own it.
    expect(seen.alphaBlocked).toContain("beta.txt");
    // Depth 1: a sub-worker has no orche_spawn (the call fails), and its assignment says so.
    expect(seen.betaSpawn).toContain(SPAWN_TOOL);
    expect(seen.betaPrompt).toContain("You cannot spawn workers");
    expect(seen.betaPrompt).toContain("You work alone on this assignment.");
    expect(seen.betaPrompt).not.toContain("Orchestration: you are the orchestrator");
    // The orchestrator got every report back and owns the result.
    expect(orchestratorTurns[1]).toContain("alpha.txt written");
    expect(orchestratorTurns[1]).toContain("You own the result");
    expect(result.details.model).toBe("main-reasoning/big");
    expect(result.details.split).toEqual({ decision: "split", criteria: ["parallelism"], reason: "two independent files" });
    expect(result.details.spawned?.map(worker => [worker.id, worker.name, worker.role, worker.reason, worker.status, worker.model, worker.thinking, worker.files])).toEqual([
      ["W1.1", "alpha", "implement", "parallelism", "done", "main-reasoning/big", "high", ["alpha.txt"]],
      ["W1.2", "beta", "implement", "parallelism", "done", "main-reasoning/big", "high", ["beta.txt"]],
    ]);
    expect(result.details.spawned?.map(worker => worker.changes)).toEqual([["alpha.txt"], ["beta.txt"]]);
    expect(result.text).toContain("Split: parallelism — two independent files");
    expect(result.text).toMatch(/Sub-workers: W1\.1 alpha \(implement, parallelism; main-reasoning\/big · thinking high\): done; W1\.2 beta \(implement, parallelism; main-reasoning\/big · thinking high\): done — \d+ requests/);
    // The orchestrator's own model line, right below the result's header line (no model warning here).
    expect(result.text.split("\n")[1]).toBe("Model: main-reasoning/big · thinking high");
    expect(result.details.models).toEqual({ "main-reasoning/big": 2 });
    expect(result.text).not.toContain("Warning (orche_spawn)");
    // The record lists the sub-workers next to the orchestrator and logs the spawn.
    const record = result.details.record!;
    expect(await readFile(join(record, "events.jsonl"), "utf8")).toContain('"type":"spawn"');
    const run = JSON.parse(await readFile(join(record, "run.json"), "utf8")) as { agents: { id: string }[]; outcome: { split?: unknown } };
    expect(run.agents.map(agent => agent.id)).toEqual(expect.arrayContaining(["W1", "W1.1", "W1.2"]));
    expect(run.outcome.split).toEqual({ decision: "split", criteria: ["parallelism"], reason: "two independent files" });
    // The split log (docs/orchestrator.md 11): one line for the assignment under the records root, outside the pruned run directories.
    const log = await readSplitLog(dirname(dirname(record)));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ role: "implement", orchestrator: true, decision: "split", reported: true, criteria: ["parallelism"], subWorkers: 2, status: "done", model: "main-reasoning/big", record });
    expect(log[0]!.subRequests).toBe(result.details.spawned!.reduce((sum, worker) => sum + worker.requests, 0));
    expect(JSON.stringify(log[0])).not.toContain("alpha.txt");
  });

  it("refuses overlapping ownership before any sub-worker starts", async () => {
    let refused = "";
    const { execute } = await fixture([
      tool(SPAWN_TOOL, { reason: "parallelism", workers: [
        { name: "a", role: "implement", request: "x", files: ["src/"] }, { name: "b", role: "implement", request: "y", files: ["src/b.ts"] },
      ] }),
      context => { refused = JSON.stringify(toolErrorOf(context, SPAWN_TOOL)); return tool("report_result", { kind: "implement", summary: "Did it myself", data: { status: "done", checklist, split: { decision: "none", reason: "coupled" } } }); },
    ]);
    const result = await execute();
    expect(refused).toContain("Owned files overlap");
    expect(result.details.spawned).toBeUndefined();
  });
});

describe("orchestrator: independent verification", () => {
  it("starts a fresh read-only verifier without the orchestrator's context and requires the split decision to name it", async () => {
    const seen: Record<string, string> = {};
    const steps = scripted(6, {
      orchestrator: (turn, context) => {
        if (turn === 0) return tool("write", { path: "greeting.txt", content: "hello orche\n" });
        if (turn === 1) return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello orche. Changed: greeting.txt. Run your own checks." }] });
        if (turn === 2) return tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: { decision: "none", reason: "small" } } });
        seen.repair = textOf(context);
        return tool("report_result", { kind: "implement", summary: "Done and independently verified", data: { status: "done", checklist, split: { decision: "split", criteria: ["verification"], reason: "the user asked for an independent review" } } });
      },
      check: (turn, context) => {
        if (turn === 0) { seen.verifier = textOf(context); return tool("write", { path: "greeting.txt", content: "verifier edit\n" }); }
        seen.blocked = JSON.stringify(toolErrorOf(context, "write"));
        return tool("report_result", { kind: "verify", summary: "greeting.txt says hello orche", data: { passed: true, evidence: ["cat greeting.txt: hello orche"], issues: [] } });
      },
    });
    const { h, execute } = await fixture(steps);
    const result = await execute({ request: `${request}\nThe user asks for an independent review.`, context: "SECRET-ORCHESTRATOR-NOTE: built it by hand" });
    expect(seen.verifier).toContain("You have not seen how the work was done");
    expect(seen.verifier).toContain("Independent read-only review");
    expect(seen.verifier).not.toContain("SECRET-ORCHESTRATOR-NOTE");
    expect(seen.verifier).not.toContain("Orchestration: you are the orchestrator");
    expect(seen.blocked).toBeTruthy();
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("hello orche\n");
    expect(seen.repair).toContain('data.split.decision must be \\"split\\"');
    expect(result.details.spawned?.map(worker => [worker.name, worker.role, worker.reason, worker.status])).toEqual([["check", "verify", "verification", "passed"]]);
    expect(result.text).toContain("Split: verification — the user asked for an independent review");
    expect(result.text).toMatch(/W1\.1 check \(verify, verification; [^ ]+\/[^ ]+ · thinking off\): passed/);
  });

  it("refuses a verification round past the cap, requires data.unresolved, and says so in the result; main can raise the cap", async () => {
    const verify = () => tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] });
    const split = { decision: "split", criteria: ["verification"], reason: "the user asked for review rounds" };
    const seen: Record<string, string> = {};
    const steps = scripted(12, {
      orchestrator: (turn, context) => {
        if (turn <= 2) return verify();
        if (turn === 3) { seen.refused = JSON.stringify(toolErrorOf(context, SPAWN_TOOL)); return tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split } }); }
        seen.repair = textOf(context);
        return tool("report_result", { kind: "implement", summary: "Done; one review finding left open", data: { status: "done", checklist, split, unresolved: ["check: greeting.txt lacks a trailing newline (greeting.txt:1)"] } });
      },
      check: () => tool("report_result", { kind: "verify", summary: "one finding", data: { passed: false, evidence: ["cat greeting.txt"], issues: ["no trailing newline"] } }),
    });
    const { execute } = await fixture(steps);
    const result = await execute({ request: `${request}\nThe user asks for independent review.` });
    expect(seen.refused).toContain("already ran 2 verification rounds (the cap is 2");
    expect(seen.refused).toContain("run the project checks yourself");
    expect(seen.repair).toContain("data.unresolved is required: a further verification round was refused (cap 2)");
    expect(result.details.spawned).toHaveLength(2);
    expect(result.text).toContain("Verification cap: 2 verification rounds ran (cap 2); 1 further round was refused.");
    expect(result.text).toContain("unresolved: [\"check: greeting.txt lacks a trailing newline (greeting.txt:1)\"]");
  });

  it("verificationRounds raises the cap for one assignment and is named in its prompt", async () => {
    let assignment = "";
    const steps = scripted(10, {
      orchestrator: (turn, context) => {
        if (turn === 0) assignment = firstUser(context);
        if (turn <= 2) return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: x. Run your own checks." }] });
        return tool("report_result", { kind: "implement", summary: "Done after three reviews", data: { status: "done", checklist, split: { decision: "split", criteria: ["verification"], reason: "three review rounds requested" } } });
      },
      check: () => tool("report_result", { kind: "verify", summary: "ok", data: { passed: true, evidence: ["checked"], issues: [] } }),
    });
    const { execute } = await fixture(steps);
    const result = await execute({ verificationRounds: 3 });
    expect(assignment).toContain("Verification rounds for this assignment: at most 3");
    expect(result.details.spawned).toHaveLength(3);
    expect(result.text).not.toContain("Verification cap:");
  });
});

describe("orchestrator: isolation", () => {
  it("runs a game-asset specialist on its own route inside its own files", async () => {
    const specialist = fauxProvider({ provider: "specialist-art", models: [{ id: "artist" }] });
    specialist.setResponses([
      tool("write", { path: "assets/sprite.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }),
      tool("report_result", { kind: "game-asset", summary: "sprite made", data: { status: "done", outputs: [{ path: "assets/sprite.svg", type: "image/svg+xml", spec: "16x16" }], evidence: ["file assets/sprite.svg"] } }),
    ]);
    const { h, execute } = await fixture([
      tool(SPAWN_TOOL, { reason: "isolation", workers: [{ name: "sprites", role: "game-asset", request: "Make assets/sprite.svg, a 16x16 SVG.", files: ["assets/"] }] }),
      tool("report_result", { kind: "implement", summary: "Sprite from the specialist; wired nothing else", data: { status: "done", checklist, split: { decision: "split", criteria: ["isolation"], reason: "game art needs the game-asset specialist" } } }),
    ]);
    h.runtime.registerNativeProvider(specialist.provider);
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: { "game-asset": { model: "specialist-art/artist" } }, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single" }));
    const result = await execute();
    expect(specialist.getPendingResponseCount()).toBe(0);
    expect(await readFile(join(h.cwd, "assets/sprite.svg"), "utf8")).toContain("<svg");
    expect(result.details.model).toBe(h.orche.route.model);
    expect(result.details.spawned?.map(worker => [worker.name, worker.role, worker.reason, worker.status, worker.model])).toEqual([["sprites", "game-asset", "isolation", "done", "specialist-art/artist"]]);
    expect(result.text).toContain("Split: isolation — game art needs the game-asset specialist");
  });
});

describe("removed single settings", () => {
  it("still start the session: they are ignored and the user is warned", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], single: { pipeline: "v2", mainReview: "evidence", investigation: { critic: "auto" } } });
    opened.push(h);
    const warnings = h.notifications.filter(note => note.type === "warning").map(note => note.message);
    expect(warnings.join("\n")).toMatch(/config\.single\.\{pipeline, mainReview, investigation\} were removed .* ignored/);
    expect(h.session.getActiveToolNames()).toContain("orche_task");
  });
});
