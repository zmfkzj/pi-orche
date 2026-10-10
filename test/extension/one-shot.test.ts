/**
 * One-shot `/orche strong <PROMPT>` and `/orche ultra <PROMPT>` (docs/orchestrator.md 14.5): the command grammar, the request mode that
 * the assignments of that request run in and that only a provable continuation keeps (its task with ledgers; never a reused worker),
 * the request boundary of its run (held-back follow-ups and job results, the prompt main sees per request, unattributable messages),
 * the session's own mode left unchanged, and the busy/usage paths. Models are faux providers (no external API); git, files and Pi
 * sessions are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, getCurrentSystemPrompt, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { busyRefusal, oneShotUsage, ORCHE_USAGE, parseOrcheCommand } from "../../src/extension/index.js";
import { MODE_ENTRY_TYPE } from "../../src/extension/mode.js";
import { JOB_ENTRY_TYPE, TaskJobs, type JobEntry } from "../../src/extension/jobs.js";
import { createLedger, latestLedgers, LEDGER_ENTRY_TYPE, recordHandoff } from "../../src/single/ledger.js";
import { ADOPT_TOOL } from "../../src/orchestrator/ultra.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

const opened: { dispose(): Promise<void> }[] = [];
const temp: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true });
});

const answered = (summary: string) => tool("report_result", { kind: "answer", summary, data: { evidence: ["greeting.txt:1"] } });
const ultraBlocked = () => tool("report_result", { kind: "implement", summary: "Stopped before exploration", data: { status: "blocked", reason: "the test stops here", ultra: { stage: "exploration" } } });
const tierProvider = (provider: string, id: string, responses: FauxResponseStep[] = []) => {
  const faux = fauxProvider({ provider, models: [{ id, reasoning: true }] });
  faux.setResponses(responses);
  return faux;
};
const MODELS = { orchestrator: { model: "tier-orch/o1" }, "strong-orchestrator": { model: "strong-orch/s1" } };

describe("one-shot commands: grammar, usage and refusals", () => {
  it("parses /orche strong|ultra <PROMPT> verbatim: one whitespace character delimits; the prompt's own leading/trailing whitespace, lines, quotes and slashes survive", () => {
    const prompt = 'fix "src/a b.ts"  and\n  keep  \'quotes\' / slashes\\n\n\n- item: /orche mode direct';
    for (const mode of ["strong", "ultra"] as const) {
      expect(parseOrcheCommand(`${mode} ${prompt}`)).toEqual({ mode, prompt });
      // Only the delimiter (one space, tab or line break after the mode word) is syntax; everything after it is the prompt.
      expect(parseOrcheCommand(`  ${mode}\n${prompt}  \n`)).toEqual({ mode, prompt: `${prompt}  \n` });
      expect(parseOrcheCommand(`${mode}   keep me  \n`)).toEqual({ mode, prompt: "  keep me  \n" });
      expect(parseOrcheCommand(`${mode}\t\tindented\n\t- item\t`)).toEqual({ mode, prompt: "\tindented\n\t- item\t" });
      expect(parseOrcheCommand(`${mode} /not-a-command "x" `)).toEqual({ mode, prompt: '/not-a-command "x" ' });
    }
    // Neither a missing prompt, a whitespace-only one, a literal "strong/ultra", nor another case starts work; existing commands keep their grammar.
    for (const input of ["strong", "ultra", "strong   ", "ultra \n\t ", "strong/ultra fix it", "Strong fix", "ultrafix", "mode ultra now"]) expect(parseOrcheCommand(input)).toBeUndefined();
    expect(parseOrcheCommand("mode ultra")).toEqual({ mode: "mode", value: "ultra" });
    // single and direct use the same grammar (verbatim prompt after one delimiter).
    expect(parseOrcheCommand("single fix the bug")).toEqual({ mode: "single", prompt: "fix the bug" });
    expect(parseOrcheCommand("single  fix the bug ")).toEqual({ mode: "single", prompt: " fix the bug " });
    expect(parseOrcheCommand("direct fix it")).toEqual({ mode: "direct", prompt: "fix it" });
    expect(parseOrcheCommand("direct \n")).toBeUndefined();
    expect(parseOrcheCommand("stop W1")).toEqual({ mode: "stop", worker: "W1" });
  });

  it("explains the one-shot usage for a mode without a prompt; busy refusals say why it is not queued and what to do", () => {
    expect(oneShotUsage("ultra")).toBe("Usage: /orche ultra <PROMPT>: runs it with the quality-first ultra orchestration on the strong model tiers for this one request (the prompt may span lines). The session's mode does not change; /orche mode ultra switches it.");
    expect(oneShotUsage(" strong \n ")).toContain("Usage: /orche strong <PROMPT>: delegates it to one worker on the strong model tiers (models.strong-orchestrator, models.strong-worker)");
    // single and direct keep the general usage line they always had.
    for (const input of ["", "   ", "workers now", "Ultra", "strong fix", "single", "direct "]) expect(oneShotUsage(input)).toBeUndefined();
    expect(busyRefusal("ultra", "single")).toBe("orche ultra: refused. The agent is busy, and a one-shot /orche ultra request starts only when the session is idle, so that its run and its workers use ultra mode (it runs it with the quality-first ultra orchestration on the strong model tiers); a queued turn would lose that. Send it again when the current run has ended, or switch the session with /orche mode ultra.");
    // The same mode as the session's is refused too (its explicit choice is not dropped); the plain prompt queues as before.
    expect(busyRefusal("strong", "strong")).toContain('Send it again when the current run has ended, or send the prompt without "/orche strong" to queue it as an ordinary follow-up in the session\'s mode (strong).');
  });
});

/** A WorkerPool on the harness's runtime with the general and strong tier providers (faux). */
async function pool(options: { single?: Record<string, unknown> } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single", models: MODELS, ...(options.single ? { single: options.single } : {}) }));
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-scratch-"));
  temp.push(scratchBase);
  const events: unknown[] = [];
  const gone: unknown[] = [];
  const workers = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir, scratchBase, onLedgerEvent: event => events.push(event), onWorkerGone: worker => gone.push(worker) });
  opened.push(workers);
  const general = tierProvider("tier-orch", "o1");
  const strong = tierProvider("strong-orch", "s1");
  h.runtime.registerNativeProvider(general.provider);
  h.runtime.registerNativeProvider(strong.provider);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => workers.execute({ role: "answer", request: "Inspect greeting.txt without changing files", cwd: h.cwd, projectTrusted: false, mainMode: "single", thinking: "off", ...args });
  return { h, workers, execute, general, strong, events, gone };
}

describe("one-shot request mode: the request's assignments run in it; only a provable continuation keeps it", () => {
  it("without task ledgers a worker is not a request: reusing the one-shot's worker later runs in the session's mode; within the request it stays", async () => {
    const { execute, general, strong } = await pool();
    strong.setResponses([answered("first"), answered("same request")]);
    general.setResponses([answered("later, another request"), answered("fresh")]);
    const first = await execute({ mainMode: "strong", oneShot: { session: "single" } });
    expect(first.details).toMatchObject({ worker: "W1", model: "strong-orch/s1", mode: "strong", requestMode: { mode: "strong", source: "one-shot", session: "single" } });
    expect(first.text).toContain('Request mode: strong (one-shot /orche strong; the session stays in single). After this request, assignments to W1 (worker "W1") run in the session\'s mode; to continue in strong, the user repeats /orche strong <PROMPT>.');
    // Still the one-shot request (its run): W1 keeps strong.
    const same = await execute({ worker: "W1", mainMode: "strong", oneShot: { session: "single" } });
    expect(same.details).toMatchObject({ worker: "W1", model: "strong-orch/s1", requestMode: { source: "one-shot" } });
    // A later turn in the session's mode reusing W1: nothing proves it is the same request, so it runs in single.
    const later = await execute({ worker: "W1" });
    expect(later.details).toMatchObject({ worker: "W1", model: "tier-orch/o1" });
    expect(later.details.requestMode).toBeUndefined();
    expect(later.details.mode).toBeUndefined();
    expect(later.text).toContain("Note: W1 switched from strong to single mode for this assignment");
    expect(later.text).not.toContain("Request mode");
    const fresh = await execute();
    expect(fresh.details).toMatchObject({ worker: "W2", model: "tier-orch/o1" });
    expect(fresh.details.requestMode).toBeUndefined();
    expect(strong.getPendingResponseCount() + general.getPendingResponseCount()).toBe(0);
  });

  it("an ultra request's worker: another explicit /orche ultra continues it as ultra; a plain later reuse leaves ultra (fresh worker in the session's mode)", async () => {
    const { workers, execute, general, strong } = await pool();
    strong.setResponses([ultraBlocked(), ultraBlocked()]);
    general.setResponses([answered("single again")]);
    await execute({ role: "implement", mainMode: "ultra", oneShot: { session: "single" } });
    const again = await execute({ role: "implement", worker: "W1", mainMode: "ultra", oneShot: { session: "single" } });
    expect(again.details).toMatchObject({ worker: "W1", mode: "ultra", status: "blocked", requestMode: { mode: "ultra", source: "one-shot" } });
    expect(again.details.retired).toBeUndefined();
    expect(workers.session("W1").getActiveToolNames()).toContain(ADOPT_TOOL);
    const plain = await execute({ worker: "W1" });
    expect(plain.details).toMatchObject({ worker: "W2", model: "tier-orch/o1", retired: ["W1"] });
    expect(plain.details.requestMode).toBeUndefined();
    expect(strong.getPendingResponseCount() + general.getPendingResponseCount()).toBe(0);
  });

  it("task ledger: the task is the request: its continuation keeps the mode (also on a new worker), another task on the pinned worker does not", async () => {
    const { workers, execute, strong, general, events } = await pool({ single: { ledger: true } });
    strong.setResponses([answered("first"), answered("taken over"), answered("T1 again on W2")]);
    general.setResponses([answered("T2 in the session's mode"), answered("T2 continued")]);
    const first = await execute({ mainMode: "strong", oneShot: { session: "single" } });
    expect(first.details).toMatchObject({ task: "T1", requestMode: { source: "one-shot" } });
    expect(first.text).toContain('Task T1 keeps strong for its continuations (task "T1"); other tasks run in the session\'s mode.');
    await workers.stop("W1");
    const taken = await execute({ task: "T1" });
    expect(taken.details).toMatchObject({ worker: "W2", task: "T1", model: "strong-orch/s1", requestMode: { mode: "strong", source: "task", by: "T1" } });
    // W2 now works for T1 (strong); a NEW task on W2 is another request: the session's mode, and W2's pin is gone.
    const other = await execute({ worker: "W2" });
    expect(other.details).toMatchObject({ worker: "W2", task: "T2", model: "tier-orch/o1" });
    expect(other.details.requestMode).toBeUndefined();
    expect(other.text).toContain("Note: W2 switched from strong to single mode for this assignment");
    const unpinned = await execute({ worker: "W2", task: "T2" });
    expect(unpinned.details).toMatchObject({ task: "T2", model: "tier-orch/o1" });
    expect(unpinned.details.requestMode).toBeUndefined();
    const back = await execute({ worker: "W2", task: "T1" });
    expect(back.details).toMatchObject({ task: "T1", model: "strong-orch/s1", requestMode: { source: "task", by: "T1" } });
    expect(strong.getPendingResponseCount() + general.getPendingResponseCount()).toBe(0);
    const handoffs = events.filter(event => (event as { event: string }).event === "handoff") as { taskId: string; requestMode?: string }[];
    expect(handoffs.map(event => [event.taskId, event.requestMode])).toEqual([["T1", "strong"], ["T1", "strong"], ["T2", undefined], ["T2", undefined], ["T1", "strong"]]);
    const replayed = latestLedgers(events.map(data => ({ type: "custom", customType: LEDGER_ENTRY_TYPE, data })));
    expect(replayed.map(ledger => [ledger.taskId, ledger.requestMode])).toEqual([["T1", "strong"], ["T2", undefined]]);
  });

  it("without task ledgers a gone worker's successor (handover, also after a restart) runs in the session's mode; the job start only records the mode", async () => {
    const { workers, execute, strong, general, gone } = await pool();
    strong.setResponses([answered("first")]);
    general.setResponses([answered("handed over")]);
    await execute({ mainMode: "strong", oneShot: { session: "single" } });
    await workers.stop("W1");
    expect(gone).toEqual([expect.not.objectContaining({ requestMode: expect.anything() })]);
    const handed = await execute({ worker: "W1" });
    expect(handed.details).toMatchObject({ worker: "W2", continuedFrom: "W1", model: "tier-orch/o1" });
    expect(handed.details.requestMode).toBeUndefined();
    // After a crash the gone entries are rebuilt from job start entries: the one-shot mode a job ran in does not become a pin.
    const jobs = new TaskJobs({ pool: () => workers, persist: () => undefined } as unknown as ConstructorParameters<typeof TaskJobs>[0]);
    const restored = jobs.restore([{ event: "start", job: "J1", role: "answer", worker: "W7", at: 1, request: "x", requestMode: "ultra" }], []);
    expect(restored.gone).toEqual([expect.not.objectContaining({ requestMode: expect.anything() })]);
    expect(restored.gone[0]).toMatchObject({ id: "W7" });
    expect(strong.getPendingResponseCount() + general.getPendingResponseCount()).toBe(0);
  });

  it("the ledger keeps a pin through hand-offs without one and rejects a malformed mode", () => {
    const ledger = createLedger("T1", "/w");
    recordHandoff(ledger, { request: "a", primary: { worker: "W1" }, requestMode: "ultra" });
    recordHandoff(ledger, { request: "b", primary: { worker: "W1" } });
    expect(ledger.requestMode).toBe("ultra");
    const entries = [{ v: 1, event: "create", taskId: "T2", cwd: "/w", at: 1 }, { v: 1, event: "handoff", taskId: "T2", at: 2, assignment: 1, requirements: [], primary: { worker: "W1" }, requestMode: "turbo" }];
    expect(latestLedgers(entries.map(data => ({ type: "custom", customType: LEDGER_ENTRY_TYPE, data })))[0]?.requestMode).toBeUndefined();
  });
});

/** The extension in a real session; the workers' strong tier is a faux provider registered in the worker runtime. */
async function session(options: { mainSteps: FauxResponseStep[]; strongSteps?: FauxResponseStep[]; generalSteps?: FauxResponseStep[]; mainMode?: "single" | "ultra" | "direct"; mode?: "tui" }) {
  const h = await createHarness({ mainSteps: options.mainSteps, orcheSteps: options.generalSteps ?? [], models: { "strong-orchestrator": { model: "strong-orch/s1" } }, mainMode: options.mainMode ?? "single", ...(options.mode ? { mode: options.mode } : {}) });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const strong = tierProvider("strong-orch", "s1", options.strongSteps ?? []);
  h.orche.runtime.registerNativeProvider(strong.provider);
  return { h, strong };
}
const toolResults = (h: Harness) => h.session.messages.filter(message => message.role === "toolResult");
const notes = (h: Harness) => h.notifications.map(note => note.message);
/** The system prompt main's model gets for one request (every prompt section after replaying the transcript's patches). */
const promptOf = (context: { messages: Parameters<typeof getCurrentSystemPrompt>[0] }) => getCurrentSystemPrompt(context.messages);
const STRONG_HEAD = "orche mode: strong (the single workflow on the strong model tiers";
const SINGLE_HEAD = "orche mode: single.";
/** Wait until main has used its whole script: runs Pi starts after a settled run (held-back work) begin a moment later. */
async function settledAll(h: Harness) {
  for (let i = 0; i < 250 && h.main.faux.getPendingResponseCount() > 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await h.session.agent.waitForIdle();
}
const modeEntries = (h: Harness) => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === MODE_ENTRY_TYPE);

describe("one-shot commands through the extension", () => {
  it.each([["blocking call", undefined], ["background job (TUI)", "tui"]] as const)("/orche strong <PROMPT> (%s): the turn runs in strong with the prompt verbatim, its worker on the strong tier; the session's mode is untouched", async (_label, mode) => {
    // Leading and trailing whitespace of the prompt are its own (only the one space after "strong" is the delimiter).
    const prompt = '  Inspect "greeting.txt" / report\n  two  spaces stay \n';
    let system = "";
    let userText: unknown;
    const { h, strong } = await session({
      mainSteps: [context => {
        system = promptOf(context);
        const content = (context.messages.filter(message => message.role === "user").at(-1) as { content: unknown }).content;
        userText = typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("");
        return tool("orche_task", { role: "answer", request: "Inspect greeting.txt without changing files" });
      }, context => { expect(promptOf(context)).toContain(STRONG_HEAD); return reply("done"); }],
      strongSteps: [answered("inspected on the strong tier")],
      ...(mode ? { mode } : {}),
    });
    await h.session.prompt(`/orche strong ${prompt}`);
    expect(system).toContain(STRONG_HEAD);
    expect(system).not.toContain(SINGLE_HEAD);
    expect(userText).toBe(prompt);
    const result = JSON.stringify(toolResults(h).at(-1));
    expect(result).toContain("inspected on the strong tier");
    expect(result).toContain("Mode: strong (orchestrator: models.strong-orchestrator");
    expect(result).toContain("Request mode: strong (one-shot /orche strong; the session stays in single)");
    expect(strong.getPendingResponseCount()).toBe(0);
    await h.session.prompt("/orche mode");
    expect(notes(h).at(-1)).toMatch(/^orche mode: single \(config /);
    expect(modeEntries(h)).toEqual([]);
  });

  it.each([["strong"], ["ultra"], ["single"], ["direct"]] as const)("/orche %s <PROMPT>: main receives exactly the text after the one delimiter (leading/trailing whitespace, lines, tabs, quotes, slashes)", async mode => {
    const prompt = "  /keep this \"quoted\" path\n\tindented line\n\n trailing \t\n";
    const users: string[] = [];
    const { h } = await session({
      mainSteps: [context => {
        const content = (context.messages.filter(message => message.role === "user").at(-1) as { content: unknown }).content;
        users.push(typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join(""));
        return reply("ok");
      }],
    });
    await h.session.prompt(`/orche ${mode} ${prompt}`);
    expect(users).toEqual([prompt]);
  });

  it("/orche ultra <PROMPT>: ultra orchestration on the strong tier; a later plain turn reusing W1 is another request: the session's mode, prompt and dispatch alike", async () => {
    const prompts: string[] = [];
    const { h, strong } = await session({
      mainSteps: [
        context => { prompts.push(promptOf(context)); return tool("orche_task", { role: "implement", request: "Fix the greeting" }); }, reply("blocked, asking the user"),
        context => { prompts.push(promptOf(context)); return tool("orche_task", { role: "implement", request: "Continue: the user chose the wording", worker: "W1" }); }, reply("continued"),
      ],
      strongSteps: [ultraBlocked()],
      generalSteps: [tool("report_result", { kind: "implement", summary: "Continued in single", data: { status: "done", split: { decision: "none", reason: "small" } } })],
    });
    await h.session.prompt("/orche ultra Fix the greeting");
    const first = JSON.stringify(toolResults(h).at(-1));
    expect(first).toContain("Ultra: stage exploration");
    expect(first).toContain("Request mode: ultra (one-shot /orche ultra; the session stays in single). After this request, assignments to W1");
    await h.session.prompt("Continue with W1; the wording is fixed now");
    const second = JSON.stringify(toolResults(h).at(-1));
    expect(second).toContain("Continued in single");
    expect(second).toContain("retired");
    expect(second).not.toContain("Request mode");
    expect(second).not.toContain("Ultra: stage");
    expect(prompts[0]).toContain("orche mode: ultra");
    expect(prompts[1]).toContain(SINGLE_HEAD);
    expect(prompts[1]).not.toContain("orche mode: ultra");
    expect(strong.getPendingResponseCount()).toBe(0);
    expect(modeEntries(h)).toEqual([]);
  });

  it("without a prompt: the one-shot usage, no turn and no mode change", async () => {
    const { h } = await session({ mainSteps: [reply("MUST NOT RUN")] });
    for (const input of ["/orche ultra", "/orche strong   ", "/orche ultra \n  "]) await h.session.prompt(input);
    expect(notes(h)).toEqual([oneShotUsage("ultra"), oneShotUsage("strong"), oneShotUsage("ultra")]);
    await h.session.prompt("/orche");
    expect(notes(h).at(-1)).toBe(ORCHE_USAGE);
    expect(h.main.faux.state.callCount).toBe(0);
    expect(modeEntries(h)).toEqual([]);
    expect(h.session.getActiveToolNames()).toContain("orche_task");
  });

  it("a follow-up queued during a one-shot run is another request: held back, it runs as its own run with the session's prompt, tools and dispatch", async () => {
    const entered = deferred();
    const gate = deferred();
    const seen: { prompt: string; context: string; tools: string[] }[] = [];
    let h!: Harness;
    const look = (context: Parameters<typeof promptOf>[0]) => seen.push({ prompt: promptOf(context), context: JSON.stringify(context.messages), tools: h.session.getActiveToolNames() });
    const started = await session({
      mainSteps: [
        async context => { entered.resolve(); await gate.promise; look(context); return tool("orche_task", { role: "answer", request: "A: inspect greeting.txt" }); },
        context => { look(context); return reply("A done"); },
        context => { look(context); return tool("orche_task", { role: "answer", request: "B: inspect greeting.txt again" }); },
        context => { look(context); return reply("B done"); },
      ],
      strongSteps: [answered("A on the strong tier")],
      generalSteps: [answered("B on the general tier")],
    });
    h = started.h;
    const run = h.session.prompt("/orche strong A");
    await entered.promise;
    await h.session.followUp("B: and check it again");
    expect(notes(h).at(-1)).toBe("orche: queued until the one-shot /orche strong request has ended; it then runs as its own turn in the session's mode (single).");
    gate.resolve();
    await run;
    await h.session.agent.waitForIdle();
    await settledAll(h);
    const [a, b] = toolResults(h).map(result => JSON.stringify(result));
    expect(a).toContain("A on the strong tier");
    expect(a).toContain("Request mode: strong (one-shot /orche strong; the session stays in single)");
    expect(b).toContain("B on the general tier");
    expect(b).not.toContain("Request mode");
    expect(b).not.toContain("Mode: strong");
    // Every model request of A's run had the strong prompt and never saw B; B's had the single prompt.
    for (const request of seen.slice(0, 2)) {
      expect(request.prompt).toContain(STRONG_HEAD);
      expect(request.context).not.toContain("B: and check it again");
    }
    for (const request of seen.slice(2)) {
      expect(request.prompt).toContain(SINGLE_HEAD);
      expect(request.prompt).not.toContain(STRONG_HEAD);
      expect(request.context).toContain("B: and check it again");
      expect(request.tools).toContain("orche_task");
    }
    expect(started.strong.getPendingResponseCount()).toBe(0);
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
    expect(h.statuses.filter(status => status.key === "orche-mode").at(-1)?.text).toBe("orche: single");
    expect(modeEntries(h)).toEqual([]);
  });

  it("a steer during a one-shot run corrects that request: it keeps the request's mode", async () => {
    const entered = deferred();
    const gate = deferred();
    const prompts: string[] = [];
    const { h, strong } = await session({
      mainSteps: [
        async context => { entered.resolve(); await gate.promise; prompts.push(promptOf(context)); return tool("orche_task", { role: "answer", request: "A: inspect greeting.txt" }); },
        context => { prompts.push(promptOf(context)); return tool("orche_task", { role: "answer", request: "A, corrected: also the date", worker: "W1" }); },
        reply("done"),
      ],
      strongSteps: [answered("A on the strong tier"), answered("corrected on the strong tier")],
    });
    const run = h.session.prompt("/orche strong A");
    await entered.promise;
    await h.session.steer("also check the date");
    gate.resolve();
    await run;
    await h.session.agent.waitForIdle();
    const corrected = JSON.stringify(toolResults(h).at(-1));
    expect(corrected).toContain("corrected on the strong tier");
    expect(corrected).toContain("Request mode: strong (one-shot /orche strong");
    for (const prompt of prompts) expect(prompt).toContain(STRONG_HEAD);
    expect(strong.getPendingResponseCount()).toBe(0);
  });

  it("a message from outside the request arriving in a one-shot run (a peer note) ends the request's mode there: prompt, guard and dispatch follow the session", async () => {
    let h!: Harness;
    let after = "";
    const started = await session({
      mainSteps: [
        tool("orche_task", { role: "answer", request: "A: inspect greeting.txt" }),
        context => { after = promptOf(context); return tool("orche_task", { role: "answer", request: "Peer's request: inspect greeting.txt" }); },
        reply("done"),
      ],
      strongSteps: [async () => {
        await h.session.sendCustomMessage({ customType: "peer-note", content: "From another session: please inspect greeting.txt", display: true }, { deliverAs: "steer", triggerTurn: true });
        return answered("A on the strong tier");
      }],
      generalSteps: [answered("peer request on the general tier")],
    });
    h = started.h;
    await h.session.prompt("/orche strong A");
    const [a, peer] = toolResults(h).map(result => JSON.stringify(result));
    expect(a).toContain("A on the strong tier");
    expect(notes(h)).toContain("orche: a message from outside the one-shot /orche strong request arrived (peer-note); the rest of this run follows the session's mode (single).");
    expect(after).toContain(SINGLE_HEAD);
    expect(after).not.toContain(STRONG_HEAD);
    expect(peer).toContain("peer request on the general tier");
    expect(peer).not.toContain("Request mode");
    expect(started.strong.getPendingResponseCount()).toBe(0);
  });

  it("the result of an earlier, unrelated job does not enter a one-shot run: it is delivered after it, in a run with the session's prompt and dispatch", async () => {
    const jobGate = deferred();
    const oneShotEntered = deferred();
    const seen: { prompt: string; context: string }[] = [];
    let h!: Harness;
    const started = await session({
      mode: "tui",
      mainSteps: [
        tool("orche_task", { role: "answer", request: "J1: inspect greeting.txt in the background", wait: false }),
        reply("J1 started"),
        async context => {
          oneShotEntered.resolve();
          jobGate.resolve();
          for (let i = 0; i < 200 && !notes(h).some(note => note.includes("J1")); i++) await new Promise(resolve => setTimeout(resolve, 20));
          seen.push({ prompt: promptOf(context), context: JSON.stringify(context.messages) });
          return reply("one-shot answered without a task");
        },
        context => { seen.push({ prompt: promptOf(context), context: JSON.stringify(context.messages) }); return tool("orche_task", { role: "answer", request: "Follow up on J1", worker: "W1" }); },
        reply("J1 followed up"),
      ],
      generalSteps: [async () => { await jobGate.promise; return answered("J1 result on the general tier"); }, answered("W1 again on the general tier")],
    });
    h = started.h;
    await h.session.prompt("start J1");
    await h.session.prompt("/orche strong Just answer: what is in greeting.txt?");
    await oneShotEntered.promise;
    await settledAll(h);
    expect(seen[0]?.prompt).toContain(STRONG_HEAD);
    expect(seen[0]?.context).not.toContain("J1 result on the general tier");
    expect(seen[1]?.context).toContain("J1 result on the general tier");
    expect(seen[1]?.prompt).toContain(SINGLE_HEAD);
    expect(seen[1]?.prompt).not.toContain(STRONG_HEAD);
    const followed = JSON.stringify(toolResults(h).at(-1));
    // Held back, it never entered the one-shot run (which would have ended the request's mode as an unattributable message).
    expect(notes(h).filter(note => note.includes("a message from outside"))).toEqual([]);
    const order = h.session.messages.map(message => (message as { customType?: string }).customType ?? JSON.stringify((message as { content?: unknown }).content));
    expect(order.findIndex(item => item === "orche-task-result")).toBeGreaterThan(order.findIndex(item => item.includes("one-shot answered without a task")));
    expect(followed).toContain("W1 again on the general tier");
    expect(followed).not.toContain("Request mode");
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
  });

  it("in a direct session: plain turns cannot delegate (direct guard); another one-shot continues the request's worker in its mode", async () => {
    const { h, strong } = await session({
      mainMode: "direct",
      mainSteps: [
        tool("orche_task", { role: "implement", request: "Fix the greeting" }), reply("blocked, asking the user"),
        tool("orche_task", { role: "implement", request: "Continue", worker: "W1" }), reply("cannot delegate in direct"),
        tool("orche_task", { role: "implement", request: "Continue: the wording is decided", worker: "W1" }), reply("continued"),
      ],
      strongSteps: [ultraBlocked(), ultraBlocked()],
    });
    await h.session.prompt("/orche ultra Fix the greeting");
    expect(JSON.stringify(toolResults(h).at(-1))).toContain("Request mode: ultra (one-shot /orche ultra; the session stays in direct)");
    await h.session.prompt("Continue with W1");
    const blocked = JSON.stringify(toolResults(h).at(-1));
    expect(blocked).not.toContain("orche task W1");
    expect(strong.getPendingResponseCount()).toBe(1);
    await h.session.prompt("/orche ultra Continue with W1: the wording is decided");
    const continued = JSON.stringify(toolResults(h).at(-1));
    expect(continued).toContain("orche task W1 (implement");
    expect(continued).toContain("Ultra: stage exploration");
    expect(continued).not.toContain("retired");
    expect(h.session.getActiveToolNames()).toContain("edit");
    expect(h.session.getActiveToolNames()).not.toContain("orche_task");
  });

  it("the usual task rules hold in a one-shot turn: the git grant reaches only its assignment, /orche cancel stops it, the mode comes back", async () => {
    let granted = "";
    let plain = "";
    const stopped = deferred();
    const { h } = await session({
      mainSteps: [
        tool("orche_task", { role: "implement", request: "Fix the greeting and commit it", git: { commit: true } }),
        tool("orche_task", { role: "implement", request: "Fix it again without committing", worker: "W1" }),
        tool("orche_task", { role: "answer", request: "Inspect greeting.txt slowly" }),
        reply("done"),
      ],
      strongSteps: [
        context => { granted = JSON.stringify(context.messages); return tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", split: { decision: "none", reason: "small" } } }); },
        context => { plain = JSON.stringify(context.messages.at(-1)); return tool("report_result", { kind: "implement", summary: "Done again", data: { status: "done", split: { decision: "none", reason: "small" } } }); },
        async (_context, options) => { stopped.resolve(); await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve())); return reply("aborted"); },
      ],
    });
    const run = h.session.prompt("/orche strong Fix the greeting, commit, then inspect");
    await stopped.promise;
    await h.session.prompt("/orche cancel");
    await run;
    expect(granted).toContain("This assignment authorizes git commit");
    expect(plain).not.toContain("authorizes git commit");
    expect(notes(h)).toContain("orche task cancelled");
    expect(JSON.stringify(toolResults(h).at(-1))).toContain("cancelled");
    await h.session.prompt("/orche mode");
    expect(notes(h).at(-1)).toMatch(/^orche mode: single \(config /);
    expect(modeEntries(h)).toEqual([]);
  });

  it("a background job of a one-shot request keeps its mode after the turn; a second task meanwhile is refused (one task at a time)", async () => {
    const gate = deferred();
    const { h } = await session({
      mode: "tui",
      mainSteps: [
        tool("orche_task", { role: "answer", request: "Inspect greeting.txt in the background", wait: false }),
        tool("orche_task", { role: "answer", request: "Another task" }),
        reply("waiting for J1"),
        reply("J1 reported"),
      ],
      strongSteps: [async () => { await gate.promise; return answered("background result on the strong tier"); }],
    });
    await h.session.prompt("/orche strong Inspect greeting.txt in the background");
    expect(JSON.stringify(toolResults(h).at(-1))).toContain("still running; one task runs at a time");
    expect(h.statuses.filter(status => status.key === "orche-mode").at(-1)?.text).toBe("orche: single");
    gate.resolve();
    for (let i = 0; i < 100 && !h.session.messages.some(message => (message as { customType?: string }).customType === "orche-task-result"); i++) await new Promise(resolve => setTimeout(resolve, 20));
    await h.session.agent.waitForIdle();
    const delivered = h.session.messages.find(message => (message as { customType?: string }).customType === "orche-task-result") as { details?: { task?: { model?: string; requestMode?: unknown } } } | undefined;
    expect(delivered?.details?.task).toMatchObject({ model: "strong-orch/s1", requestMode: { mode: "strong", source: "one-shot", session: "single" } });
  });

  it("the notice about jobs a crash interrupted is not part of a one-shot request: it goes with the next ordinary prompt", async () => {
    const contexts: string[] = [];
    const { h } = await session({
      mode: "tui",
      mainSteps: [context => { contexts.push(JSON.stringify(context.messages)); return reply("one-shot answered"); }, context => { contexts.push(JSON.stringify(context.messages)); return reply("noted"); }],
    });
    h.session.sessionManager.appendCustomEntry(JOB_ENTRY_TYPE, { event: "start", job: "J5", role: "explore", worker: "W4", at: Date.now() - 60_000, request: "look", sessionFile: "/nowhere/W4.jsonl" } satisfies JobEntry);
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" } as never);
    await h.session.prompt("/orche strong What is in greeting.txt?");
    await h.session.prompt("anything else?");
    expect(contexts[0]).not.toContain("still running when the previous pi process ended");
    expect(contexts[1]).toContain("still running when the previous pi process ended");
  });

  it.each([["single"], ["ultra"]] as const)("busy in %s: /orche ultra is refused, also in the same mode (never queued without its mode); the busy turn is unaffected", async mainMode => {
    const entered = deferred();
    const gate = deferred();
    const { h } = await session({ mainMode, mainSteps: [async () => { entered.resolve(); await gate.promise; return reply("first done"); }, reply("follow-up done")] });
    const first = h.session.prompt("first");
    await entered.promise;
    await h.session.prompt("/orche ultra second request");
    expect(notes(h).at(-1)).toBe(busyRefusal("ultra", mainMode));
    gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(1);
    expect(modeEntries(h)).toEqual([]);
  });
});
