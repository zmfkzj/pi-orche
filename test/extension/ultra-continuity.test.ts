/**
 * Continuity of interrupted ultra work through the real WorkerPool / orche_task path (faux models; real git, Pi sessions, candidate copies).
 *
 * The historical loss (results/ultra-ab/main/runs/sqlfluff__sqlfluff-7615/B/r1 and r2): an ultra implement assignment reached its
 * candidates, hit the time cap, and main continued with the same worker exactly as the result's Resume line said (`worker "W1"`). With
 * `single.ledger` off (the study's orcheConfig and the default) nothing identified the continuation, so it started a fresh ultra run:
 * 0 rounds, no candidates, no basis, and the report gate rejected the remembered candidates as unknown. Ultra assignments now keep the
 * task-ledger identity whatever `single.ledger` says: `task` continues the run (same worker: candidates, copies, basis, adoptions),
 * omitting it starts a new task with fresh stages. Unit rules of UltraRun are in test/orchestrator/ultra.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool, type TaskDetails } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { ADOPT_TOOL } from "../../src/orchestrator/ultra.js";
import type { LedgerEvent } from "../../src/single/ledger.js";
import { createHarness, tool } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
const temp: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true });
});

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says fixed.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const continuation = "Intent/Purpose: continue the greeting fix stopped by the time cap; finish only the remaining stages.\nRequirements:\nR1: greeting.txt says fixed.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const otherTask = "Intent/Purpose: fix the farewell\nRequirements:\nR1: farewell.txt says goodbye.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n작별 인사를 고쳐줘.";
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "sh test/basis.sh" }];
const partial = [{ id: "R1", status: "partial", evidence: "not done yet" }];
/** The time cap of an assignment that is meant to stop: long enough for the work before the stop, never extended. */
const CAPPED = { assignmentMs: 3_000, maxExtensions: 0 };
const OPEN = { assignmentMs: 120_000, maxExtensions: 0 };

type Context = Parameters<FauxResponseFactory>[0];
type Options = Parameters<FauxResponseFactory>[1];
type Script = (turn: number, context: Context, options: Options) => AssistantMessage | Promise<AssistantMessage>;
/** The messages of the assignment in progress: a reused worker's session still holds its earlier assignments. */
const current = (context: Context) => context.messages.slice(context.messages.map(message => message.role).lastIndexOf("user") + 1);
const turnOf = (context: Context) => current(context).filter(message => message.role === "assistant").length;
const subWorkerOf = (context: Context) => /You are sub-worker (W\d+\.\d+) \(\\"([^\\"]+)\\"\)/.exec(JSON.stringify(context.messages.find(message => message.role === "user")))?.[2];
/** The tool results of the assignment in progress: tool name, ref and text, in order. */
const resultsOf = (context: Context) => current(context).filter(message => message.role === "toolResult").map(message => {
  const text = JSON.stringify((message as { content?: unknown }).content);
  return { tool: (message as { toolName?: string }).toolName ?? "", ref: /\[orche ref (T\d+)/.exec(text)?.[1] ?? "", text, error: !!(message as { isError?: boolean }).isError };
});
/** Every model request goes to the script of its session: the orchestrator, or a sub-worker by its name. */
function scripted(scripts: Record<string, Script>, count = 40): FauxResponseStep[] {
  const respond: FauxResponseFactory = (context, options) => {
    const name = subWorkerOf(context) ?? "orchestrator";
    const script = scripts[name];
    if (!script) throw new Error(`no script for ${name}`);
    return script(turnOf(context), context, options);
  };
  return Array.from({ length: count }, () => respond);
}
/** A model request that runs until its session is stopped (the time cap); `entered` marks that the work reached it. */
const untilStopped = async (options: Options, entered: () => void): Promise<AssistantMessage> => {
  entered();
  const signal = options?.signal;
  await new Promise<void>(resolve => { if (!signal || signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
  return reply("stopped");
};

const exploration = () => tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh: exits 0 only when greeting.txt contains fixed.", files: ["test/"] }, { name: "cause", role: "answer", request: "Why does greeting.txt not say fixed? Hypotheses with a falsification check." }] });
const candidates = (second = "cand-b") => tool(SPAWN_TOOL, { reason: "candidates", workers: [{ name: "cand-a", role: "implement", request: "Approach A: rewrite greeting.txt to say fixed.", files: ["greeting.txt"] }, { name: second, role: "implement", request: "Approach B: append a line to greeting.txt.", files: ["greeting.txt"] }] });
const verification = () => tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "red", role: "verify", request: "Original request: greeting.txt says fixed. Find counterexamples." }] });
const blocked = (stage: string, reason = "the test stops here") => tool("report_result", { kind: "implement", summary: `Stopped at ${stage}`, data: { status: "blocked", reason, checklist: partial, ultra: { stage } } });
const SUB_WORKERS: Record<string, Script> = {
  basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "test/basis.sh checks R1", data: { status: "done", evidence: ["sh test/basis.sh -> exit 1 on the current code"] } }),
  cause: () => tool("report_result", { kind: "answer", summary: "greeting.txt says hello, not fixed (greeting.txt:1)", data: { evidence: ["greeting.txt:1"] } }),
  "cand-a": turn => turn === 0 ? tool("write", { path: "greeting.txt", content: "fixed\n" }) : tool("report_result", { kind: "implement", summary: "greeting.txt now says fixed", data: { status: "done", evidence: ["sh test/basis.sh -> exit 0"] } }),
  "cand-b": turn => turn === 0 ? tool("write", { path: "greeting.txt", content: "hello\nbroken\n" }) : tool("report_result", { kind: "implement", summary: "appended a line", data: { status: "done", evidence: [] } }),
  red: () => tool("report_result", { kind: "verify", summary: "no counterexample found", data: { passed: true, evidence: ["sh test/basis.sh -> 0"], issues: [] } }),
};

async function fixture(single: Record<string, unknown> = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.cwd, "greeting.txt"), "hello\n");
  /** orche.config.json as in the study (experiments/ultra-ab/protocol.ts orcheConfig: single.ledger false, spawn on, no advisor), with the next assignment's limits. */
  const configure = (limits: Record<string, number>) => writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", single: { ledger: false, spawn: true, advisor: false, ...single }, limits }));
  await configure(OPEN);
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-continuity-"));
  temp.push(scratchBase);
  const ledgerEvents: LedgerEvent[] = [];
  // A generous stop bound (test seam): the stop at the time cap waits for an orche_spawn call it cut short to record its round, and a
  // slow machine must not turn that into a retired worker.
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir, scratchBase, stopTimeoutMs: 20_000, onLedgerEvent: event => ledgerEvents.push(event) });
  opened.push(pool);
  // The orchestrator inherits main's model (no tiers configured); its sub-workers inherit the orchestrator's: one faux model for all.
  const faux = fauxProvider({ provider: "main-reasoning", models: [{ id: "current", reasoning: true }] });
  h.runtime.registerNativeProvider(faux.provider);
  /** An orche_task call as main makes it in a one-shot `/orche ultra` request of a single-mode session (the study's runs). */
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "ultra", oneShot: { session: "single" }, model: faux.getModel(), thinking: "high", ...args });
  return { h, pool, faux, execute, configure, ledgerEvents };
}
const failure = async (promise: Promise<unknown>): Promise<TaskFailedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TaskFailedError);
  return error as TaskFailedError;
};
/** The result of an assignment that may end either way: its details and text. */
const settled = (promise: Promise<{ text: string; details: TaskDetails }>) => promise.then(result => result, (error: unknown) => {
  if (error instanceof TaskFailedError) return { text: error.message, details: error.details };
  throw error;
});
const lineOf = (text: string, head: string) => text.split("\n").find(line => line.startsWith(head)) ?? "";
/** How main continues a timed-out assignment: exactly as its Resume line says (the worker, and the task when the line names one). */
const resumeArgs = (text: string): { worker?: string; task?: string } => {
  const [, worker, task] = /Continue with orche_task worker "(W\d+)"(?: and task "(T\d+)")?/.exec(lineOf(text, "Resume:")) ?? [];
  return { ...(worker ? { worker } : {}), ...(task ? { task } : {}) };
};
const copyOf = (details: TaskDetails, id: string) => details.spawned?.find(item => item.id === id)?.workspace ?? `(no copy of ${id})`;
const exists = (path: string) => stat(path).then(() => true, () => false);
const stateOf = (details: TaskDetails) => {
  const ultra = details.ultra;
  return ultra ? { stage: ultra.stage, carried: ultra.carried ?? false, explorationRounds: ultra.explorationRounds, candidateRounds: ultra.candidateRounds, protectedBasis: ultra.protectedBasis, candidates: ultra.candidates.map(item => `${item.id} ${item.status}`), adoptions: ultra.adoptions, verificationRounds: ultra.verificationRounds, gate: ultra.gate } : undefined;
};
/** The orchestrator's assignment that stops at the time cap after its candidates round finished (the historical run's point). */
const stopAfterCandidates = (reached: () => void): Record<string, Script> => ({ ...SUB_WORKERS, orchestrator: (turn, _context, options) => turn === 0 ? exploration() : turn === 1 ? candidates() : untilStopped(options, reached) });

describe("ultra continuity: an interrupted ultra assignment continued by the same worker", () => {
  it("(1) the historical loss: single.ledger off, time cap after the candidates; the continuation the Resume line names keeps the stages and completes them", async () => {
    const { h, faux, execute, configure } = await fixture();
    let reached = false;
    await configure(CAPPED);
    faux.setResponses(scripted(stopAfterCandidates(() => { reached = true; })));
    const first = await failure(execute());
    expect(reached).toBe(true); // the cap hit after exploration and candidates finished, as in the study run
    expect(first.failure).toMatchObject({ status: "timeout" });
    expect(stateOf(first.details)).toMatchObject({ stage: "evaluation", explorationRounds: 1, candidateRounds: 1, protectedBasis: ["test/basis.sh"], candidates: ["W1.3 done", "W1.4 done"] });
    // Request mode is unchanged by the task identity: the one-shot request keeps ultra within its run, later turns follow the session.
    expect(first.message).toContain('Request mode: ultra (one-shot /orche ultra; the session stays in single). After this request, assignments to W1 (worker "W1") run in the session\'s mode; to continue in ultra, the user repeats /orche ultra <PROMPT>.');
    const copies = { a: copyOf(first.details, "W1.3"), b: copyOf(first.details, "W1.4") };
    const args = resumeArgs(first.message);

    // Main continues as the Resume line says, within the same one-shot request (the study's continuation): re-check both carried
    // candidates in their copies, adopt the passing one, review it, check the workspace and report.
    await configure(OPEN);
    const seen: Record<string, string> = {};
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: (turn, context) => {
      const results = resultsOf(context);
      const bash = results.filter(item => item.tool === "bash");
      switch (turn) {
        case 0: return tool("bash", { command: `cd '${copies.a}' && sh test/basis.sh` });
        case 1: return tool("bash", { command: `cd '${copies.b}' && sh test/basis.sh` });
        case 2: return tool(ADOPT_TOOL, { candidate: "W1.3" });
        case 3: seen.adopt = results.at(-1)!.text; return verification();
        case 4: return tool("bash", { command: "sh test/basis.sh" });
        case 5: return tool("report_result", { kind: "implement", summary: "Adopted W1.3 after re-checking both carried candidates", data: { status: "done", checklist, ultra: {
          stage: "complete", criteria: ["greeting.txt contains fixed (test/basis.sh)"],
          candidates: [{ id: "W1.3", verdict: "chosen", reason: "passes the protected basis", evidence: [bash[0]?.ref ?? ""] }, { id: "W1.4", verdict: "failed", reason: "fails the protected basis", evidence: [bash[1]?.ref ?? ""] }],
          selection: { chosen: "W1.3", reason: "the only candidate passing the protected basis", evidence: [bash[0]?.ref ?? ""] }, review: [], integration: { evidence: [bash[2]?.ref ?? ""] },
        } } });
        default: seen.gate = results.at(-1)!.text; return blocked("evaluation", "the report gate rejected the continuation's report");
      }
    } }));
    const copiesBefore = { a: await exists(copies.a), b: await exists(copies.b) };
    const resumed = await settled(execute({ ...args, request: continuation }));

    // One comparison, so that a failure shows everything the continuation saw (on the code before the fix: no task in the Resume
    // line, a fresh run of 0 rounds and no candidates, the adoption refused as unknown, the gate rejecting the candidates as unknown).
    expect({
      resumeArgs: args,
      ultraResume: lineOf(first.message, "Ultra resume:"),
      copiesBefore,
      adopt: seen.adopt ?? "(no adoption attempted)",
      gateRejection: seen.gate ?? null,
      status: resumed.details.status,
      state: stateOf(resumed.details),
      workspace: await readFile(join(h.cwd, "greeting.txt"), "utf8"),
    }).toEqual({
      resumeArgs: { worker: "W1", task: "T1" },
      ultraResume: expect.stringContaining('continue in W1\'s next ultra assignment of that task (worker "W1", task "T1"'),
      copiesBefore: { a: true, b: true },
      adopt: expect.stringContaining("Adopted W1.3 into the workspace: 1 file(s): greeting.txt"),
      gateRejection: null,
      status: "done",
      state: { stage: "complete", carried: true, explorationRounds: 1, candidateRounds: 1, protectedBasis: ["test/basis.sh"], candidates: ["W1.3 done", "W1.4 done"], adoptions: ["W1.3"], verificationRounds: 1, gate: "passed" },
      workspace: "fixed\n",
    });
    expect(resumed.details).toMatchObject({ worker: "W1", task: "T1", mode: "ultra", requestMode: { mode: "ultra", source: "one-shot" } });
    expect(resumed.details.retired).toBeUndefined();
    expect(resumed.text).toContain("continued from the previous assignment of this task");
  }, 30_000);

  it("(1b) the continuation's own first checks count for a carried candidate: evidence refs restart per assignment, the carried spawn refs do not gate them", async () => {
    // single.ledger on, where the state was always carried: this isolates the stale-ref part of a continuation (UltraRun's carried
    // candidates restart at spawn ref 0, src/orchestrator/ultra.ts constructor) on the WorkerPool path.
    const { faux, execute } = await fixture({ ledger: true });
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: turn => turn === 0 ? exploration() : turn === 1 ? candidates() : blocked("evaluation") }));
    const first = await execute();
    expect(first.details).toMatchObject({ task: "T1", status: "blocked" });
    const copy = copyOf(first.details, "W1.3");
    const seen: Record<string, string> = {};
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: (turn, context) => {
      if (turn === 0) return tool("bash", { command: `cd '${copy}' && sh test/basis.sh` }); // T1 here; W1.3's round was T2 of the last assignment
      if (turn === 1) return tool(ADOPT_TOOL, { candidate: "W1.3" });
      seen.adopt = resultsOf(context).at(-1)!.text;
      return blocked("review");
    } }));
    const resumed = await execute({ worker: "W1", task: "T1", request: continuation });
    expect(seen.adopt).toContain("Adopted W1.3 into the workspace: 1 file(s): greeting.txt");
    expect(stateOf(resumed.details)).toMatchObject({ carried: true, adoptions: ["W1.3"] });
  }, 30_000);

  it("(2) contrast: with single.ledger on (the existing task identity) the same flow already carried the state", async () => {
    const { faux, execute, configure } = await fixture({ ledger: true });
    let reached = false;
    await configure(CAPPED);
    faux.setResponses(scripted(stopAfterCandidates(() => { reached = true; })));
    const first = await failure(execute());
    expect(reached).toBe(true);
    expect(resumeArgs(first.message)).toEqual({ worker: "W1", task: "T1" });
    await configure(OPEN);
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: () => blocked("evaluation", "the contrast stops before the checks") }));
    const resumed = await execute({ ...resumeArgs(first.message), request: continuation });
    expect(resumed.details).toMatchObject({ worker: "W1", task: "T1", status: "blocked" });
    expect(stateOf(resumed.details)).toMatchObject({ carried: true, explorationRounds: 1, candidateRounds: 1, protectedBasis: ["test/basis.sh"], candidates: ["W1.3 done", "W1.4 done"] });
    expect(await exists(copyOf(first.details, "W1.3"))).toBe(true);
  }, 30_000);

  it("(3) a different task on the same worker (no task passed) starts fresh: no carried exploration, basis or candidates; its own run clears the earlier copies", async () => {
    const { faux, execute } = await fixture();
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: turn => turn === 0 ? exploration() : turn === 1 ? candidates() : blocked("evaluation") }));
    const first = await execute();
    expect(first.details).toMatchObject({ worker: "W1", status: "blocked" });
    const copies = [copyOf(first.details, "W1.3"), copyOf(first.details, "W1.4")];
    const seen: Record<string, string> = {};
    faux.setResponses(scripted({
      farewell: turn => turn === 0 ? tool("write", { path: "test/farewell.sh", content: "grep -q goodbye farewell.txt\n" }) : tool("report_result", { kind: "implement", summary: "test/farewell.sh checks R1", data: { status: "done" } }),
      why: () => tool("report_result", { kind: "answer", summary: "farewell.txt is missing", data: { evidence: ["ls"] } }),
      orchestrator: (turn, context) => {
        if (turn === 0) return tool(ADOPT_TOOL, { candidate: "W1.3" });
        if (turn === 1) { seen.adopt = resultsOf(context).at(-1)!.text; return tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "farewell", role: "implement", request: "Write test/farewell.sh: exits 0 only when farewell.txt says goodbye.", files: ["test/"] }, { name: "why", role: "answer", request: "Why does farewell.txt not say goodbye?" }] }); }
        return blocked("candidates", "the different task stops after its exploration");
      },
    }));
    const other = await execute({ worker: "W1", request: otherTask });
    expect(other.details).toMatchObject({ worker: "W1", status: "blocked" });
    if (first.details.task) expect(other.details.task).not.toBe(first.details.task); // a new task id, never the earlier one
    expect(seen.adopt).toContain("Unknown implementation candidate W1.3; candidates: none.");
    expect(stateOf(other.details)).toMatchObject({ carried: false, explorationRounds: 1, candidateRounds: 0, protectedBasis: ["test/farewell.sh"], candidates: [], adoptions: [] });
    // A fresh run's first use of the copies directory (its basis snapshot) removed the earlier task's copies: nothing stale remains.
    expect(await Promise.all(copies.map(exists))).toEqual([false, false]);
    // One carried ultra state per worker, its latest task's: the earlier task, continued now, starts afresh too (its copies are gone).
    if (first.details.task) {
      faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: () => blocked("exploration") }));
      const back = await execute({ worker: "W1", task: first.details.task, request: continuation });
      expect(stateOf(back.details)).toMatchObject({ carried: false, explorationRounds: 0, candidates: [] });
    }
  }, 30_000);

  it("(4) a time cap during a candidates round: the unfinished candidate is not done, and the continuation neither adopts nor counts it", async () => {
    const { faux, execute, configure } = await fixture();
    let reached = false;
    await configure(CAPPED);
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: turn => turn === 0 ? exploration() : candidates("cand-slow"), "cand-slow": (_turn, _context, options) => untilStopped(options, () => { reached = true; }) }));
    const first = await failure(execute());
    expect(reached).toBe(true); // the cap hit while cand-slow was still running
    expect(first.failure).toMatchObject({ status: "timeout" });
    expect(first.details.spawned?.map(item => `${item.id} ${item.name} ${item.status}`)).toEqual(["W1.1 basis done", "W1.2 cause done", "W1.3 cand-a done", "W1.4 cand-slow cancelled"]);
    expect(stateOf(first.details)).toMatchObject({ candidateRounds: 1, candidates: ["W1.3 done", "W1.4 cancelled"] });
    const copy = copyOf(first.details, "W1.3");

    await configure(OPEN);
    const seen: Record<string, string> = {};
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: (turn, context) => {
      const results = resultsOf(context);
      if (turn === 0) return tool(ADOPT_TOOL, { candidate: "W1.4" });
      if (turn === 1) { seen.adopt = results.at(-1)!.text; return tool("bash", { command: `cd '${copy}' && sh test/basis.sh` }); }
      if (turn === 2) {
        const check = results.at(-1)!.ref;
        return tool("report_result", { kind: "implement", summary: "W1.3 is the only candidate", data: { status: "done", checklist, ultra: {
          stage: "complete", criteria: ["greeting.txt contains fixed (test/basis.sh)"],
          candidates: [{ id: "W1.3", verdict: "chosen", reason: "passes the protected basis", evidence: [check] }, { id: "W1.4", verdict: "failed", reason: "it was cut short by the time cap" }],
          selection: { chosen: "W1.3", reason: "the only finished candidate", evidence: [check] }, review: [], integration: { evidence: [check] },
        } } });
      }
      seen.gate = results.at(-1)!.text;
      return blocked("candidates", "only one candidate finished before the time cap");
    } }));
    const resumed = await settled(execute({ ...resumeArgs(first.message), request: continuation }));
    expect({ adopt: seen.adopt ?? "", gate: seen.gate ?? "", state: stateOf(resumed.details) }).toEqual({
      adopt: expect.stringContaining("W1.4 did not finish with a report (status cancelled); it cannot be adopted."),
      gate: expect.stringContaining("two or more candidates with a report are required (1 so far)"),
      state: expect.objectContaining({ carried: true, candidateRounds: 1, candidates: ["W1.3 done", "W1.4 cancelled"], adoptions: [] }),
    });
    expect(resumed.details.status).toBe("blocked");
  }, 30_000);
});

describe("ultra continuity: what does not change", () => {
  const done = () => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: { decision: "none", reason: "small" } } });
  const mdsdBlocked = () => tool("report_result", { kind: "implement", summary: "Blocked before any search", data: { status: "blocked", reason: "the test stops here", checklist: partial, mdsd: { decision: "single-path", reason: "one file", objective: "fix the greeting", findings: [], explored_scope: ["greeting.txt"], unexplored_scope: [], stop: { reason: "blocked", basis: "the test stops here" } } } });
  const explored = () => tool("report_result", { kind: "explore", summary: "greeting.txt:1 says hello", data: { cause: "greeting.txt:1", evidence: ["greeting.txt:1"] } });

  it("(5) single, strong and mdsd (and a non-orchestrating ultra role) keep no task ledger without single.ledger, and task stays ignored", async () => {
    const { faux, execute, ledgerEvents } = await fixture();
    const plain = { oneShot: undefined };
    faux.setResponses([done()]);
    const single = await execute({ ...plain, mainMode: "single" });
    faux.setResponses([done()]);
    const strong = await execute({ ...plain, mainMode: "strong" });
    faux.setResponses([mdsdBlocked()]);
    const mdsd = await execute({ ...plain, mainMode: "mdsd" });
    faux.setResponses([explored()]);
    const explore = await execute({ ...plain, role: "explore" });
    faux.setResponses([done()]);
    const singleWithTask = await execute({ ...plain, mainMode: "single", task: "T1" });
    faux.setResponses([done()]);
    const strongWithTask = await execute({ ...plain, mainMode: "strong", task: "T1" });
    for (const result of [single, strong, mdsd, explore, singleWithTask, strongWithTask]) {
      expect(result.details.task).toBeUndefined();
      expect(result.text).not.toContain("Task ledger");
    }
    // (an explore report has no data.status: its status is the outcome's, "completed")
    expect([single, strong, mdsd, explore].map(result => [result.details.mode, result.details.status, result.details.ultra])).toEqual([[undefined, "done", undefined], ["strong", "done", undefined], ["mdsd", "blocked", undefined], ["ultra", "completed", undefined]]);
    for (const result of [singleWithTask, strongWithTask]) expect(result.text).toContain("Note: task T1 ignored: task ledgers apply to single-workflow standard roles with single.ledger on.");
    expect(ledgerEvents).toEqual([]);
  }, 30_000);

  it("(5b) only an ultra orchestrator keeps the task identity without single.ledger; single and strong passing that task id still ignore it", async () => {
    const { faux, execute, ledgerEvents } = await fixture();
    const plain = { oneShot: undefined };
    faux.setResponses([blocked("exploration")]);
    const ultra = await execute({ ...plain });
    expect(ultra.details.task).toBe("T1");
    expect(ultra.text).toContain('Task ledger T1, assignment 1: pass task "T1" for a follow-up of this task');
    expect(ledgerEvents.map(event => event.event)).toEqual(["create", "handoff", "result"]);
    faux.setResponses([done()]);
    const singleWithTask = await execute({ ...plain, mainMode: "single", task: "T1" });
    faux.setResponses([done()]);
    const strongWithTask = await execute({ ...plain, mainMode: "strong", task: "T1" });
    for (const result of [singleWithTask, strongWithTask]) {
      expect(result.details.task).toBeUndefined();
      expect(result.text).toContain("Note: task T1 ignored: task ledgers apply to single-workflow standard roles with single.ledger on.");
    }
    expect(ledgerEvents).toHaveLength(3);
  }, 30_000);

  it("(R) request mode: within the one-shot request the continuation stays ultra; a later plain turn passing the task runs in the session's mode without single.ledger (docs 14.5)", async () => {
    const { faux, execute } = await fixture();
    faux.setResponses(scripted({ ...SUB_WORKERS, orchestrator: turn => turn === 0 ? exploration() : blocked("candidates") }));
    const first = await execute();
    faux.setResponses([blocked("candidates")]);
    const same = await execute({ worker: "W1", ...(first.details.task ? { task: first.details.task } : {}), request: continuation });
    expect(same.details).toMatchObject({ worker: "W1", mode: "ultra", requestMode: { mode: "ultra", source: "one-shot" } });
    faux.setResponses([done()]);
    const later = await execute({ oneShot: undefined, mainMode: "single", worker: "W1", task: "T1", request: continuation });
    expect(later.details).toMatchObject({ worker: "W2", retired: ["W1"], continuedFrom: "W1" });
    expect(later.details.mode).toBeUndefined();
    expect(later.details.requestMode).toBeUndefined();
    expect(later.text).toContain("Note: task T1 ignored");
    expect(later.text).toContain("W1 retired: leaving ultra mode drops the ultra tool set");
  }, 30_000);
});
