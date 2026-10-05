import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { delegationRules } from "../../src/extension/mode.js";
import { ANSWER_UNCERTAINTY_INSTRUCTIONS } from "../../src/workflow/critique.js";
import { createHarness, tool } from "./harness.js";
import { findRecords, summarize } from "../../experiments/workflow/yield.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); });

/** Every model call's latest user message, in call order (worker rounds and specialist sessions share the faux script). */
function recorder() {
  const prompts: string[] = [];
  const capture = (step: FauxResponseStep): FauxResponseStep => (context, ...rest) => {
    prompts.push(JSON.stringify(context.messages.filter(message => message.role === "user").at(-1)));
    return typeof step === "function" ? step(context, ...rest) : step;
  };
  return { prompts, capture };
}

async function fixture(steps: FauxResponseStep[], single: Record<string, unknown>, records = false) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, single: single as never, records });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, random: () => 0 });
  opened.push(pool);
  const run = (args: Partial<TaskParameters> & Pick<TaskParameters, "role" | "request">) => pool.execute({ cwd: h.cwd, projectTrusted: false, mainMode: "single", ...args });
  return { h, pool, run };
}

const QUESTION = "Intent/Purpose: explain the greeting.\nOriginal request\nWhy does greeting.txt say hello world?";
const answer = (summary: string, data: Record<string, unknown> = {}) => tool("report_result", { kind: "answer", summary, data: { evidence: ["greeting.txt:1"], ...data } });

describe("investigation policy", () => {
  it("runs the critic on open hypotheses, sends material findings back to the same worker and records its responses", async () => {
    const { prompts, capture } = recorder();
    const { run } = await fixture([
      capture(answer("It is a default template.", { hypotheses: [{ statement: "template", status: "open" }, { statement: "typed by hand", status: "open" }] })),
      capture(tool("report_critique", { verdict: "revise", findings: [
        { id: "C1", kind: "counterevidence", severity: "material", target: "It is a default template.", issue: "Nothing shows a template; the file is hand written.", evidence: "greeting.txt:1 has no template marker" },
        { id: "C2", kind: "overclaim", severity: "minor", target: "default", issue: "certainty", evidence: "none" },
      ] })),
      // The synthesis report must answer C1: the first try is sent back.
      capture(answer("It was written by hand.")),
      answer("It was written by hand (corrected).", { critique: [{ id: "C1", response: "accepted", reason: "greeting.txt:1 has no template marker" }], conclusionChanged: true }),
    ], { investigation: { critic: "auto" } });
    const result = await run({ role: "answer", request: QUESTION });
    expect(prompts[0]).toContain("data.hypotheses");
    expect(prompts[1]).toContain("## The answer under review");
    expect(prompts[1]).toContain("It is a default template.");
    expect(prompts[1]).toContain("Why you were called: 2 open hypotheses.");
    expect(prompts[2]).toContain("synthesis round");
    expect(prompts[2]).toContain("C1 (counterevidence)");
    const workflow = result.details.workflow!;
    expect(workflow.policy).toBe("Workflow: investigation = synthesize → critique(auto) → synthesize");
    expect(workflow.critique).toMatchObject({ trigger: { run: true, reason: "2 open hypotheses" }, synthesisRounds: 1, conclusionChanged: true, responses: [{ id: "C1", response: "accepted" }] });
    expect(workflow.specialists.map(stats => stats.actor)).toEqual(["critic:W1"]);
    expect(result.text).toContain("It was written by hand (corrected).");
    expect(result.text).toContain("Critic (2 open hypotheses): revise, 1 material, 1 minor; synthesis round: conclusion changed.");
    expect(result.text).toContain("- C1 material (counterevidence): Nothing shows a template; the file is hand written. → accepted");
  });

  it("does not run the critic when the answer reports no uncertainty, and says so", async () => {
    const { run } = await fixture([answer("It is hand written.", { confidence: "high" })], { investigation: { critic: "auto" } });
    const result = await run({ role: "answer", request: QUESTION });
    expect(result.details.workflow?.critique).toEqual({ trigger: { run: false, reason: "no open hypotheses or uncertainty reported" }, synthesisRounds: 0 });
    expect(result.details.workflow?.specialists).toEqual([]);
    expect(result.text).toContain("Critic: not run (no open hypotheses or uncertainty reported).");
  });

  it("writes workflow.json into the task record, which the yield script reads", async () => {
    const { h, run } = await fixture([
      answer("It is a default template.", { uncertainties: ["who created the file"] }),
      tool("report_critique", { verdict: "revise", findings: [{ id: "C1", kind: "unsupported", severity: "material", target: "template", issue: "no evidence", evidence: "greeting.txt:1" }] }),
      answer("Unknown origin; no template evidence.", { critique: [{ id: "C1", response: "partly", reason: "no marker either way" }], conclusionChanged: true }),
    ], { investigation: { critic: "auto" } }, true);
    const result = await run({ role: "answer", request: QUESTION });
    const workflow = JSON.parse(await readFile(join(result.details.record!, "workflow.json"), "utf8"));
    expect(workflow).toMatchObject({ type: "investigation", status: "done", critique: { trigger: { reason: "1 stated uncertainties" }, conclusionChanged: true } });
    expect(JSON.parse(await readFile(join(result.details.record!, "critique.json"), "utf8")).verdict).toBe("revise");
    const summary = summarize(await findRecords([join(h.agentDir, "orche", "records")]));
    expect(summary.investigation).toMatchObject({ answers: 1, criticRate: { value: 1 }, criticYield: { num: 1, den: 1 }, responses: { partly: 1 }, conclusionChanged: { value: 1 } });
    expect(JSON.parse(await readFile(join(result.details.record!, "answers.json"), "utf8"))).toEqual({ first: "It is a default template.", final: "Unknown origin; no template evidence." });
  });

  it("keeps the answer unchanged when the critic finds nothing material", async () => {
    const { run } = await fixture([
      answer("It is hand written."),
      tool("report_critique", { verdict: "sound", findings: [] }),
    ], { investigation: { critic: "always" } });
    const result = await run({ role: "answer", request: QUESTION });
    expect(result.details.workflow?.critique).toMatchObject({ trigger: { reason: "gate always" }, critique: { verdict: "sound" }, synthesisRounds: 0 });
    expect(result.text).toContain("Critic (gate always): sound.");
  });

  it("is absent by default: no workflow details, no extra instructions, no policy lines", async () => {
    const { prompts, capture } = recorder();
    const { run } = await fixture([capture(answer("It is hand written."))], {});
    const result = await run({ role: "answer", request: QUESTION });
    expect(prompts[0]).not.toContain(ANSWER_UNCERTAINTY_INSTRUCTIONS);
    expect(result.details.workflow).toBeUndefined();
    expect(result.text).not.toContain("Workflow:");
    expect(result.text).not.toContain("Critic");
  });
});

describe("creation policy", () => {
  const scratch = ".orche/scratch/W1-c1";
  const asset = (summary: string, data: Record<string, unknown>) => tool("report_result", { kind: "game-asset", summary, data: { status: "done", ...data } });
  const candidate = (id: string) => ({ id, direction: id === "A" ? "plain shield" : "cracked rune shield", summary: `icon ${id}`, outputs: [`${scratch}/${id}/icon.svg`] });

  it("makes divergent candidates in scratch, lets a blind critic select one and refines it into the deliverable", async () => {
    const { prompts, capture } = recorder();
    const { h, run } = await fixture([
      capture(tool("write", { path: `${scratch}/A/icon.svg`, content: "<svg>A</svg>" })),
      tool("write", { path: `${scratch}/B/icon.svg`, content: "<svg>B</svg>" }),
      // Only one candidate: sent back to the worker.
      asset("two icons", { outputs: [{ path: `${scratch}/A/icon.svg`, type: "svg", spec: "A" }], candidates: [candidate("A")] }),
      asset("two icons", { outputs: [{ path: `${scratch}/A/icon.svg`, type: "svg", spec: "A" }, { path: `${scratch}/B/icon.svg`, type: "svg", spec: "B" }], candidates: [candidate("A"), candidate("B")] }),
      capture(tool("report_selection", {
        candidates: [{ label: 1, compliance: 5, quality: 4, fit: 5, strengths: "readable", weaknesses: "busy" }, { label: 2, compliance: 5, quality: 3, fit: 3, strengths: "safe", weaknesses: "bland" }],
        selected: 1, rationale: "Distinctive and still readable at 32px.", refinements: ["thicken the outline"], borrow: [{ from: 2, what: "the palette" }], acceptable: true,
      })),
      capture(tool("write", { path: "assets/icon.svg", content: "<svg>B final</svg>" })),
      asset("Final shield icon (B, refined).", { outputs: [{ path: "assets/icon.svg", type: "svg", spec: "B refined" }], selected: "B" }),
    ], { creation: { divergence: "always", candidates: 2 } });
    const result = await run({ role: "game-asset", request: "Make a shield icon at assets/icon.svg.", files: ["assets/"], then: "execution" });
    // Candidate round: the directions and the scratch directory (also writable although files is assets/ only).
    expect(prompts[0]).toContain("## Divergent candidates (orche creation policy: this round)");
    expect(prompts[0]).toContain("- A: minimal / safe:");
    expect(prompts[0]).toContain(`${scratch}/<id>/`);
    // The critic sees neutral labels in the shuffled order (random 0: B first) and no direction names.
    expect(prompts[1]).toContain("### Candidate 1\\nSummary: icon B");
    expect(prompts[1]).not.toContain("distinctive");
    // Refine round: the selection in candidate ids.
    expect(prompts[2]).toContain("refine round");
    expect(prompts[2]).toContain("selected B (cracked rune shield)");
    expect(prompts[2]).toContain("- from candidate A: the palette");
    const divergence = result.details.workflow!.divergence!;
    expect(divergence).toMatchObject({ candidates: 2, scratch, order: ["B", "A"], selected: "B", refineRounds: 1 });
    expect(divergence.generated?.map(item => item.id)).toEqual(["A", "B"]);
    expect(result.details.workflow?.next).toBe("execution");
    // Only the deliverable is a workspace change; the candidates stay in the ignored scratch directory.
    expect(result.details.changes).toEqual([{ path: "assets/icon.svg", status: "added" }]);
    expect(await readFile(join(h.cwd, scratch, "A", "icon.svg"), "utf8")).toBe("<svg>A</svg>");
    expect(result.text).toContain("Workflow: creation = generate×2 → critique(always) → refine");
    expect(result.text).toContain("Critic selected B: Distinctive and still readable at 32px.");
    expect(result.text).toContain("Scores (compliance/quality/fit): B 5/4/5, A 5/3/3");
    expect(result.text).toContain("Next: execution.");
    expect(result.text).toContain("Final shield icon (B, refined).");
  });

  it("with divergence auto, one candidate (the default) is the existing single creation assignment", async () => {
    const { prompts, capture } = recorder();
    const { run } = await fixture([
      capture(tool("write", { path: "assets/icon.svg", content: "<svg/>" })),
      asset("icon", { outputs: [{ path: "assets/icon.svg", type: "svg", spec: "s" }] }),
    ], { creation: { divergence: "auto" } });
    const result = await run({ role: "game-asset", request: "Make a shield icon at assets/icon.svg." });
    expect(prompts[0]).not.toContain("Divergent candidates");
    expect(result.details.workflow).toBeUndefined();
  });

  it("rejects a type that does not fit the role before any worker starts", async () => {
    const { pool, run } = await fixture([], { creation: { divergence: "always" } });
    await expect(run({ role: "answer", request: "x", type: "creation" })).rejects.toThrow("Unsupported orche_task arguments: type creation does not fit role answer");
    expect(pool.list()).toEqual([]);
  });
});

describe("workflow policy rules for the main session", () => {
  it("leave the single rules unchanged when the policies are off and add one rule each when on", () => {
    for (const pipeline of ["v1", "v2"] as const) {
      const base = delegationRules("single", { pipeline });
      expect(delegationRules("single", { pipeline, critic: "off", divergence: "off" })).toBe(base);
      const on = delegationRules("single", { pipeline, critic: "auto", divergence: "auto" });
      expect(on).toContain("Investigation policy:");
      expect(on).toContain("Pass `candidates`: 3 when distinct alternatives are worth comparing");
      expect(delegationRules("single", { pipeline, divergence: "always" })).not.toContain("Pass `candidates`");
    }
    expect(delegationRules("direct", { critic: "auto" })).not.toContain("Investigation policy");
  });
});
