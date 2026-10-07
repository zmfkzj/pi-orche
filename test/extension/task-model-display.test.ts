/**
 * orche_task shows the model and thinking (reasoning effort) its worker actually runs on: in the live progress line, the result text, the
 * sub-worker lines, `details.models` / run.json and `/orche workers`; a failed assignment keeps them in its details (the TUI draws them, see
 * render.test.ts). The values come from the worker's session and the provider's answers, never from a configured default in their place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider } from "@earendil-works/pi-ai";
import { TaskFailedError, WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { createHarness, tool } from "./harness.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });

const request = "Intent/Purpose: fix the greeting\nRequirements:\nR1: greeting.txt says hello.\nConstraints and non-goals: no commits.\nAssumptions: plain text.\nOriginal request\n인사말을 고쳐줘.";
const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
const implemented = (split?: { decision: string; criteria?: string[]; reason: string }) => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: split ?? { decision: "none", reason: "small" } } });

async function fixture(options: { models?: Record<string, unknown>; records?: boolean } = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [], records: options.records ?? false });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: options.records ? {} : { enabled: false }, mainMode: "single", ...(options.models ? { models: options.models } : {}) }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  opened.push(pool);
  const mainFaux = fauxProvider({ provider: "main-reasoning", models: [{ id: "current", reasoning: true }] });
  h.runtime.registerNativeProvider(mainFaux.provider);
  const mainModel = mainFaux.getModel();
  const progress: string[][] = [];
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({
    role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: mainModel, thinking: "high",
    onProgress: lines => progress.push([...lines]), ...args,
  });
  return { h, pool, execute, mainFaux, progress };
}
const statusLines = (progress: string[][]) => progress.filter(lines => lines.length).map(lines => lines.at(-1)!);

describe("orche_task shows the model and thinking its worker runs on", () => {
  it("in the live progress line, the result's Model line, details.models and run.json: the session's values, not main's", async () => {
    const orchestrator = fauxProvider({ provider: "tier-orch", models: [{ id: "o1", reasoning: true }] });
    const { h, execute, progress } = await fixture({ records: true, models: { orchestrator: { model: "tier-orch/o1", thinking: "low" } } });
    h.runtime.registerNativeProvider(orchestrator.provider);
    orchestrator.setResponses([tool("read", { path: "greeting.txt" }), implemented()]);
    const result = await execute();
    // Running: every live status line names the model and level of the worker's session (main runs high; this worker low).
    const lines = statusLines(progress);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^W1 implement · tier-orch\/o1 · thinking low · \d+ requests/);
    expect(lines.some(line => line.includes("last tool: read"))).toBe(true);
    // Finished: the Model line right below the header, the per-model response counts in the details and the record.
    const text = result.text.split("\n");
    expect(text[0]).toMatch(/^orche task W1 \(implement, /);
    expect(text[1]).toBe("Model: tier-orch/o1 · thinking low");
    expect(result.text).not.toContain("thinking high");
    expect(result.details).toMatchObject({ model: "tier-orch/o1", thinking: "low", models: { "tier-orch/o1": 2 }, modelSource: "config", thinkingSource: "config" });
    const run = JSON.parse(await readFile(join(result.details.record!, "run.json"), "utf8")) as { outcome: Record<string, unknown> };
    expect(run.outcome).toMatchObject({ model: "tier-orch/o1", thinking: "low", models: { "tier-orch/o1": 2 } });
  });

  it("shows the level the session really runs on after Pi's clamp (a non-reasoning model runs off), not the requested one", async () => {
    const plain = fauxProvider({ provider: "tier-plain", models: [{ id: "p1", reasoning: false }] });
    const { h, pool, execute, progress } = await fixture({ models: { orchestrator: { model: "tier-plain/p1", thinking: "high" } } });
    h.runtime.registerNativeProvider(plain.provider);
    plain.setResponses([implemented()]);
    const result = await execute();
    expect(pool.session("W1").thinkingLevel).toBe("off");
    expect(result.details).toMatchObject({ model: "tier-plain/p1", thinking: "off" });
    expect(result.text.split("\n")[1]).toBe("Model: tier-plain/p1 · thinking off");
    for (const line of statusLines(progress)) expect(line).toContain("tier-plain/p1 · thinking off");
    expect(pool.formatWorkers()).toMatch(/^W1 idle · implement · tier-plain\/p1 · thinking off · 1 assignments/);
  });

  it("names each sub-worker's model and thinking while it runs and in the Sub-workers line", async () => {
    const worker = fauxProvider({ provider: "tier-worker", models: [{ id: "w1", reasoning: true }] });
    const { h, execute, mainFaux, progress } = await fixture({ models: { worker: { model: "tier-worker/w1", thinking: "medium" } } });
    h.runtime.registerNativeProvider(worker.provider);
    mainFaux.setResponses([
      tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] }),
      implemented({ decision: "split", criteria: ["verification"], reason: "the user asked for an independent check" }),
    ]);
    worker.setResponses([tool("report_result", { kind: "verify", summary: "greeting.txt says hello", data: { passed: true, evidence: ["cat greeting.txt"], issues: [] } })]);
    const result = await execute();
    const subLines = progress.flat().filter(line => line.startsWith("W1 → W1.1"));
    expect(subLines[0]).toBe("W1 → W1.1 check (verify): starting");
    expect(subLines).toContain("W1 → W1.1 check (verify · tier-worker/w1 · thinking medium): starting");
    expect(subLines.at(-1)).toBe("W1 → W1.1 check (verify · tier-worker/w1 · thinking medium): passed");
    expect(result.text.split("\n")[1]).toBe("Model: main-reasoning/current · thinking high");
    expect(result.text).toMatch(/Sub-workers: W1\.1 check \(verify, verification; tier-worker\/w1 · thinking medium\): passed/);
    expect(result.details.spawned?.map(item => [item.model, item.thinking, item.models, item.notStarted])).toEqual([["tier-worker/w1", "medium", { "tier-worker/w1": 1 }, undefined]]);
  });

  it("a failed assignment keeps the model and thinking in its details; its message stays the plain error text", async () => {
    const { execute, mainFaux } = await fixture();
    mainFaux.setResponses([reply("I will not report"), reply("Still no report")]);
    const error = await execute().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TaskFailedError);
    const failed = error as TaskFailedError;
    expect(failed.message).toBe("Still no report");
    expect(failed.details).toMatchObject({ worker: "W1", model: "main-reasoning/current", thinking: "high", models: { "main-reasoning/current": 2 } });
    expect(failed.toolResult().content).toEqual([{ type: "text", text: "Still no report" }]);
  });
});
