import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool } from "./harness.js";

/**
 * workerCompaction through the WorkerPool (orche.config.json read per task, the real worker session): two early compactions in
 * one assignment, main's corrections delivered between them, and what the worker sees after each compaction.
 */
const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); vi.restoreAllMocks(); });
const request = "Intent/Purpose: summarize data\nRequirements:\nR1: write summary.txt with the totals.\nConstraints and non-goals: none.\nAssumptions: none.\nOriginal request\nSummarize large.txt into summary.txt.";
const plan = { nodes: [{ id: "n1", title: "Summarize", dependsOn: [], covers: ["R1"], status: "running" as const }] };
const report = tool("report_result", { kind: "implement", summary: "done", data: { status: "done", checklist: [{ id: "R1", status: "met", evidence: "summary.txt:1", verifiedBy: "cat summary.txt" }] } });

describe("workerCompaction through the worker pool", () => {
  it("extended essentials keep main's latest correction across two compactions, never as the advisor's and never the superseded value alone", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], records: true, taskContext: { minClearTokens: 0 } });
    opened.push(h);
    const config = JSON.parse(await readFile(join(h.agentDir, "orche.config.json"), "utf8"));
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ ...config, workerCompaction: { policy: "absolute", triggerTokens: 16_384, keepRecentTokens: 2_000, essentials: "extended" } }));
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const pool = new WorkerPool({ controller, agentDir: h.agentDir });
    opened.push(pool);
    const faux = fauxProvider({ provider: "wc-pool", models: [{ id: "big", contextWindow: 200_000, maxTokens: 4096 }] });
    h.runtime.registerNativeProvider(faux.provider);
    await writeFile(join(h.cwd, "large.txt"), Array.from({ length: 30 }, (_, i) => `ROW-${i} ${"y".repeat(490)}`).join("\n"));
    const manager = { steer: (id: string, text: string, options?: { source?: "advisor" }) => (pool as unknown as { manager: { steer(id: string, text: string, options?: { source?: "advisor" }): unknown } }).manager.steer(id, text, options) };
    let step = 0;
    const seenAfter: string[] = [];
    const scripted: FauxResponseStep = context => {
      const text = JSON.stringify(context.messages);
      if (JSON.stringify(context.messages.filter(message => message.role === "system")).includes("context summarization assistant")) return reply("SUMMARY");
      step++;
      if (step === 1) return tool("task_plan", plan);
      if (step === 2) { manager.steer("W1", "Correction: use the unit EUR."); manager.steer("W1", "ADVISOR SAYS USD", { source: "advisor" }); return tool("read", { path: "large.txt" }); }
      if (step <= 7) return tool("read", { path: "large.txt" });
      if (step === 8) { manager.steer("W1", "Correction 2: use the unit CHF instead of EUR."); return tool("read", { path: "large.txt" }); }
      if (step <= 14) return tool("read", { path: "large.txt" });
      seenAfter.push(text);
      return report;
    };
    faux.setResponses(Array(30).fill(scripted));
    const result = await pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: faux.getModel() });
    const events = (await readFile(join(result.details.record!, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const compactions = events.filter(event => event.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(2);
    expect(compactions[0]).toMatchObject({ policy: "absolute", early: true, reference: "valid", reason: "threshold" });
    const last = seenAfter.at(-1)!;
    const essentials = last.slice(last.lastIndexOf("Assignment in progress at compaction time"));
    expect(essentials).toContain("Messages from main during this assignment");
    expect(essentials).toContain("Correction: use the unit EUR.");
    expect(essentials).toContain("Correction 2: use the unit CHF instead of EUR.");
    expect(essentials.indexOf("Correction: use the unit EUR.")).toBeLessThan(essentials.indexOf("Correction 2"));
    expect(essentials).toContain("where two conflict the later one wins");
    expect(essentials).not.toContain("ADVISOR SAYS USD");
    expect(essentials).toContain("R1: write summary.txt with the totals.");
    expect(essentials).toContain("Task DAG at compaction time");
    expect(result.details.compactions?.count).toBe(compactions.length);
  });

  it("without workerCompaction a worker keeps the stable 50% policy (no early compaction in the same assignment)", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], records: true, taskContext: { minClearTokens: 0 } });
    opened.push(h);
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const pool = new WorkerPool({ controller, agentDir: h.agentDir });
    opened.push(pool);
    const faux = fauxProvider({ provider: "wc-pool-stable", models: [{ id: "big", contextWindow: 200_000, maxTokens: 4096 }] });
    h.runtime.registerNativeProvider(faux.provider);
    await writeFile(join(h.cwd, "large.txt"), Array.from({ length: 90 }, (_, i) => `ROW-${i} ${"y".repeat(490)}`).join("\n"));
    let step = 0;
    faux.setResponses(Array(30).fill((context => { if (JSON.stringify(context.messages.filter(message => message.role === "system")).includes("context summarization assistant")) return reply("SUMMARY"); step++; return step === 1 ? tool("task_plan", plan) : step <= 6 ? tool("read", { path: "large.txt" }) : report; }) as FauxResponseStep));
    const result = await pool.execute({ role: "implement", request, cwd: h.cwd, projectTrusted: false, mainMode: "single", model: faux.getModel() });
    expect(result.details.compactions?.count).toBe(0);
  });
});
