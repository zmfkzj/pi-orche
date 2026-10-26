/**
 * The analysts' hand-off (H2, src/orchestrator/ultra.ts) through the real stack (WorkerPool, faux-model sessions, real git and shell):
 * the orchestrator's guard hands every call's arguments to its ultra run, and the run reads the orchestrator's own tool results from
 * its session (src/extension/workers.ts `callText`), so a cited check grounds an exclusion only when its arguments or its output name
 * the finding's file. All model calls are faux (no external API).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says fixed.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const partial = [{ id: "R1", status: "partial", evidence: "not done yet" }];

async function fixture() {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single" }));
  const scratchBase = await mkdtemp(join(tmpdir(), "orche-scratch-"));
  temp.push(scratchBase);
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, scratchBase });
  opened.push(pool);
  const mainFaux = fauxProvider({ provider: "main-reasoning", models: [{ id: "current", reasoning: true }] });
  h.runtime.registerNativeProvider(mainFaux.provider);
  const execute = () => pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "ultra", model: mainFaux.getModel(), thinking: "high" });
  return { h, execute, mainFaux };
}

type Context = Parameters<FauxResponseFactory>[0];
const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;
const subWorkerOf = (context: Context) => /You are sub-worker (W\d+\.\d+) \(\\"([^\\"]+)\\"\)/.exec(JSON.stringify(context.messages.find(message => message.role === "user")))?.[2];
/** The tool results of a session so far: its ref and text, in order. */
const resultsOf = (context: Context) => context.messages.filter(message => message.role === "toolResult").map(message => {
  const text = ((message as { content?: { type: string; text?: string }[] }).content ?? []).map(part => part.text ?? "").join("\n");
  return { ref: /\[orche ref (T\d+)/.exec(text)?.[1] ?? "", text };
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

describe("ultra hand-off through the worker pool", () => {
  it("an exclusion is grounded by a check whose output names the file (read from the orchestrator's session), never by one that names another file", async () => {
    const { h, execute, mainFaux } = await fixture();
    await writeFile(join(h.cwd, "greeting.txt"), "hello\n");
    await writeFile(join(h.cwd, "notes.txt"), "keep the greeting short\n");
    const candidates = [{ name: "cand-a", role: "implement", request: "Fix greeting.txt: say fixed.", files: ["greeting.txt"] }, { name: "cand-b", role: "implement", request: "Fix greeting.txt another way.", files: ["greeting.txt"] }];
    const exclude = (ref: string) => ({ path: "notes.txt", reason: "Style notes only; nothing to change.", evidence: [`[orche ref ${ref}] the notes`] });
    const seen: { unrelated?: string; refusal?: string; byOutput?: string; accepted?: string } = {};
    mainFaux.setResponses(scripted(16, {
      orchestrator: (turn, context) => {
        const last = resultsOf(context).at(-1);
        switch (turn) {
          case 0: return tool(SPAWN_TOOL, { reason: "exploration", workers: [{ name: "basis", role: "implement", request: "Write test/basis.sh for R1.", files: ["test/"] }, { name: "cause", role: "answer", request: "Hypotheses for R1." }] });
          // A check that names another file: its arguments and its output name greeting.txt only.
          case 1: return tool("bash", { command: "grep -n hello greeting.txt" });
          case 2: seen.unrelated = last!.ref; return tool(SPAWN_TOOL, { reason: "candidates", workers: candidates, excluded: [exclude(last!.ref)] });
          // Only its output names notes.txt (./notes.txt): the session's tool result is what grounds it.
          case 3: seen.refusal = last!.text; return tool("bash", { command: "grep -rln --exclude-dir=.git 'keep the greeting' ." });
          case 4: seen.byOutput = last!.ref; return tool(SPAWN_TOOL, { reason: "candidates", workers: candidates, excluded: [exclude(last!.ref)] });
          default: seen.accepted = last!.text; return tool("report_result", { kind: "implement", summary: "Stopped after the candidates", data: { status: "blocked", reason: "test stops here", checklist: partial, ultra: { stage: "evaluation" } } });
        }
      },
      basis: turn => turn === 0 ? tool("write", { path: "test/basis.sh", content: "grep -q fixed greeting.txt\n" }) : tool("report_result", { kind: "implement", summary: "basis", data: { status: "done" } }),
      cause: () => tool("report_result", { kind: "answer", summary: "greeting.txt:1 says hello; notes.txt:1 has the style notes.", data: { evidence: ["greeting.txt:1"] } }),
      "cand-a": () => tool("report_result", { kind: "implement", summary: "A", data: { status: "done" } }),
      "cand-b": () => tool("report_result", { kind: "implement", summary: "B", data: { status: "done" } }),
    }));
    const result = await execute();
    expect(seen.refusal).toContain("Refused (ultra hand-off): 1 analyst finding(s) have no accepted disposition");
    expect(seen.refusal).toContain("- notes.txt:1 (analyst W1.2, exploration round 1)");
    expect(seen.refusal).toContain(`excluded not accepted: ${seen.unrelated} does not name this path in its arguments or output`);
    expect(seen.accepted).toContain("Ultra hand-off: 2 analyst finding(s): assigned 1, reference 0, excluded 1, out of scope 0.");
    expect(result.details.ultra).toMatchObject({ candidateRounds: 1, candidates: [expect.objectContaining({ id: "W1.3" }), expect.objectContaining({ id: "W1.4" })] });
    expect(result.text).toContain("Ultra hand-off: 2 analyst finding(s): assigned 1, reference 0, excluded 1, out of scope 0");
    expect(seen.byOutput).toMatch(/^T\d+$/);
  });
});
