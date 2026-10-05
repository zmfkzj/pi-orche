import { describe, expect, it } from "vitest";
import { DEFAULT_SINGLE, parseSingleConfig, type SingleSettings } from "../../src/extension/config.js";
import { formatPolicy, resolvePolicy, workTypeError, workTypeOf } from "../../src/workflow/policy.js";
import { asksForCritique, checkCritique, criticTrigger, synthesisError, type Critique } from "../../src/workflow/critique.js";
import { blindOrder, candidatesError, checkSelection, type Selection } from "../../src/workflow/divergence.js";

const single = (value: Record<string, unknown> = {}): SingleSettings => parseSingleConfig(value);

describe("workflow policy", () => {
  it("derives the work type from the role unless the front names it", () => {
    expect(workTypeOf("answer")).toBe("investigation");
    expect(workTypeOf("implement")).toBe("execution");
    expect(workTypeOf("game-asset")).toBe("creation");
    expect(workTypeOf("video")).toBe("creation");
    expect(workTypeOf("implement", "creation")).toBe("creation");
    expect(workTypeOf("explore")).toBeUndefined();
    expect(workTypeOf("verify")).toBeUndefined();
    expect(workTypeError("answer", "creation")).toBe("type creation does not fit role answer; creation uses role implement or game-asset or video.");
    expect(workTypeError("implement", "creation")).toBeUndefined();
    expect(workTypeError("game-asset", "execution")).toContain("execution uses role implement");
  });

  // Regression: the execution policy reproduces the flags the v1/v2 pipeline used before the abstraction
  // (pipelineV2 = ledger && pipeline v2 && implement; Framer unless frame off; Verifier gate = checker.gate; code_nav = v2 && nav).
  it.each([
    [{}, true], [{ ledger: true }, true], [{ pipeline: "v2" }, true], [{ pipeline: "v2" }, false],
    [{ pipeline: "v2", frame: "off" }, true], [{ pipeline: "v2", frame: "spec", checker: { gate: "auto" } }, true],
    [{ pipeline: "v2", nav: false, checker: { gate: "always" } }, true], [{ pipeline: "v2", checker: { gate: "off" } }, true],
  ] as const)("execution policy for %j (standard role %s) equals the old v1/v2 flags", (value, standard) => {
    const settings = single(value);
    const policy = resolvePolicy("execution", settings, { standard });
    const oldPipelineV2 = standard && settings.ledger && settings.pipeline === "v2";
    expect(policy.post.includes("verify")).toBe(oldPipelineV2);
    expect(policy.pre.includes("frame")).toBe(oldPipelineV2 && settings.frame !== "off");
    expect(policy.gates.verify).toBe(oldPipelineV2 ? settings.checker.gate : undefined);
    expect(policy.retrieve.codeNav).toBe(standard && settings.pipeline === "v2" && settings.nav);
    expect(policy.primary).toBe("execute");
  });

  it("adds the investigation critic and the creation divergence only when configured", () => {
    expect(resolvePolicy("investigation", DEFAULT_SINGLE)).toMatchObject({ pre: [], primary: "synthesize", post: [], gates: {} });
    expect(resolvePolicy("investigation", single({ investigation: { critic: "auto" } }))).toMatchObject({ post: ["critique", "synthesize"], gates: { critique: "auto" } });
    expect(resolvePolicy("creation", DEFAULT_SINGLE, { requestedCandidates: 3 })).toMatchObject({ primary: "generate", post: [], candidates: 1 });
    expect(resolvePolicy("creation", single({ creation: { divergence: "always" } }))).toMatchObject({ post: ["critique", "refine"], candidates: 3 });
    expect(resolvePolicy("creation", single({ creation: { divergence: "auto" } }))).toMatchObject({ post: [], candidates: 1 });
    expect(resolvePolicy("creation", single({ creation: { divergence: "auto", candidates: 2 } }), { requestedCandidates: 3 })).toMatchObject({ post: ["critique", "refine"], candidates: 2 });
    expect(formatPolicy(resolvePolicy("investigation", single({ investigation: { critic: "auto" } })))).toBe("Workflow: investigation = synthesize → critique(auto) → synthesize");
    expect(formatPolicy(resolvePolicy("creation", single({ creation: { divergence: "always" } })))).toBe("Workflow: creation = generate×3 → critique(always) → refine");
    expect(formatPolicy(resolvePolicy("execution", single({ pipeline: "v2" })))).toBe("Workflow: execution = frame → execute → verify(review)");
  });
});

describe("investigation critic", () => {
  const critique = (findings: Critique["findings"], verdict: Critique["verdict"]): Critique => ({ verdict, findings });
  const material = { id: "C1", kind: "counterevidence" as const, severity: "material" as const, target: "X", issue: "Y", evidence: "src/a.ts:12 shows the opposite" };

  it("gates on an explicit request, open hypotheses, stated uncertainty or low confidence", () => {
    expect(criticTrigger("off", "review this", {})).toEqual({ run: false, reason: "gate off" });
    expect(criticTrigger("always", "why?", {})).toEqual({ run: true, reason: "gate always" });
    expect(criticTrigger("auto", "이 설계에 반론을 제시해줘", {})).toEqual({ run: true, reason: "explicit review request" });
    expect(criticTrigger("auto", "why does it fail?", { hypotheses: [{ status: "open" }, { status: "supported" }, { status: "rejected" }] })).toEqual({ run: true, reason: "2 open hypotheses" });
    expect(criticTrigger("auto", "why does it fail?", { hypotheses: [{ status: "supported" }, { status: "rejected" }] }).run).toBe(false);
    expect(criticTrigger("auto", "why?", { uncertainties: ["is the cache shared?"], confidence: "low" })).toEqual({ run: true, reason: "1 stated uncertainties, low confidence" });
    expect(criticTrigger("auto", "why?", { confidence: "high" })).toEqual({ run: false, reason: "no open hypotheses or uncertainty reported" });
    expect(asksForCritique("play devil's advocate")).toBe(true);
    expect(asksForCritique("explain the cache")).toBe(false);
  });

  it("requires located evidence for material findings and a verdict that matches them", () => {
    expect(checkCritique(critique([material], "revise"))).toBeUndefined();
    expect(checkCritique(critique([material], "sound"))).toBe("verdict must be revise when a finding is material.");
    expect(checkCritique(critique([{ ...material, evidence: "I think it is wrong" }], "revise"))).toContain("C1: a material finding needs located evidence");
    expect(checkCritique(critique([{ ...material, evidence: 'the question says "only on retries"' }], "revise"))).toBeUndefined();
    expect(checkCritique(critique([{ ...material, severity: "minor", evidence: "a hunch" }], "sound"))).toBeUndefined();
    expect(checkCritique(critique([material, material], "revise"))).toBe("Duplicate finding id C1.");
  });

  it("requires a response to every material finding in the synthesis round", () => {
    const value = critique([material, { ...material, id: "C2", severity: "minor", evidence: "x" }], "revise");
    expect(synthesisError(value, {})).toContain("data.critique is required");
    expect(synthesisError(value, { critique: [{ id: "C1", response: "maybe", reason: "x" }] })).toContain('response must be "accepted"');
    expect(synthesisError(value, { critique: [{ id: "C1", response: "rebutted", reason: "src/a.ts:12 is dead code" }] })).toContain("data.conclusionChanged is required");
    expect(synthesisError(value, { critique: [{ id: "C1", response: "rebutted", reason: "src/a.ts:12 is dead code" }], conclusionChanged: false })).toBeUndefined();
  });
});

describe("creation divergence", () => {
  const scratch = ".orche/scratch/W1-c1";
  it("validates one candidate per direction inside the scratch directory", () => {
    const candidate = (id: string, outputs = [`${scratch}/${id}/a.svg`]) => ({ id, direction: "d", summary: "s", outputs });
    expect(candidatesError({ candidates: [candidate("A"), candidate("B")] }, 2, scratch)).toBeUndefined();
    expect(candidatesError({ candidates: [candidate("A")] }, 2, scratch)).toBe("data.candidates must have exactly one entry per direction A, B (missing B).");
    expect(candidatesError({ candidates: [candidate("A"), candidate("B", ["assets/a.svg"])] }, 2, scratch)).toContain("assets/a.svg is outside");
    expect(candidatesError({ candidates: [candidate("A"), { id: "B", direction: "d", summary: "s", content: "Nightfall" }] }, 2, scratch)).toBeUndefined();
    expect(candidatesError({ candidates: [candidate("A"), { id: "B", summary: "s" }] }, 2, scratch)).toContain("give its outputs");
  });

  it("presents candidates blind in a shuffled order and checks the selection", () => {
    expect(blindOrder(["A", "B", "C"], () => 0)).toEqual(["B", "C", "A"]);
    expect(blindOrder(["A", "B", "C"], () => 0.999)).toEqual(["A", "B", "C"]);
    const scores = (label: number) => ({ label, compliance: 4, quality: 4, fit: 4, strengths: "s", weaknesses: "w" });
    const selection: Selection = { candidates: [scores(1), scores(2)], selected: 2, rationale: "r", refinements: [], acceptable: true };
    expect(checkSelection(selection, 2)).toBeUndefined();
    expect(checkSelection({ ...selection, candidates: [scores(1)] }, 2)).toBe("Score every candidate exactly once: labels 1, 2.");
    expect(checkSelection({ ...selection, selected: 3 }, 2)).toBe("selected must be one of 1, 2.");
    expect(checkSelection({ ...selection, borrow: [{ from: 2, what: "x" }] }, 2)).toBe("borrow.from 2 must name another candidate's label.");
  });
});
