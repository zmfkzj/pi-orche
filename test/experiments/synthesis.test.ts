import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Gate, QV, TOY, checkJudgment, checkLedger, checkPlan, claimsMarkdown, composePrompt, judgeInputs, linesKept, numberLines, pipeline, promptHashes, reviewPrompt, runTurn, setStudy, sourceInputs, spanFound, statementsOf, unitInput, unitStatements } from "../../experiments/mdsd-ab/synthesis.js";

/**
 * The synthesis-only validation harness (experiments/mdsd-ab/synthesis.ts; results/synthesis-validation/protocol.md) without any
 * model: the mechanical checks of both arms and what they cannot see, the judge's validation, input isolation, never-rerun guards.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "synthesis-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); setStudy(""); });

const refs = ["P1:c1", "P1:c2", "P2:c1", "P2:c2"];
const final = "# Answer\n\nmean (calc.js:5-7) computes the average. For an empty list mean([]) returns NaN because 0 is divided by 0.\n";

describe("C ledger check (the current MDSD report gate: accounting only)", () => {
  it("accepts complete accounting even when the final text never states a kept claim: metadata-only retention is invisible to it", () => {
    const ledger = { findings: [{ id: "F1", statement: "mean computes the average; sum([]) is 0; README describes the helpers", status: "confirmed", evidence: "calc.js:2,5", provenance: ["P1:c1", "P1:c2", "P2:c1", "P2:c2"] }], dropped: [] };
    const result = checkLedger(refs, ledger);
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ kept: 4, unaccounted: 0 });
    expect(spanFound("sum uses reduce with initial value 0", final)).toBe(false); // P2:c1 is "kept" but absent from the text
  });
  it("flags caps, missing evidence or dissent, unknown refs and unaccounted refs; counts a ref both kept and dropped without refusing it", () => {
    const many = Array.from({ length: 81 }, (_, index) => ({ id: `F${index + 1}`, status: "unverified", provenance: [] }));
    expect(checkLedger(refs, { findings: many, dropped: [] }).errors.join("\n")).toMatch(/81 findings; at most 80/);
    const result = checkLedger(refs, { findings: [
      { id: "F1", status: "confirmed", provenance: Array.from({ length: 31 }, () => "P1:c1") },
      { id: "F2", status: "disputed", evidence: "x", provenance: ["P9:c1"] },
      { id: "F3", status: "refuted", evidence: "calc.js:2", provenance: ["P2:c1"] },
    ], dropped: [{ ref: "P2:c1", reason: "duplicate" }, { ref: "P1:c2", reason: "" }] });
    const text = result.errors.join("\n");
    expect(text).toMatch(/F1: 31 provenance refs/);
    expect(text).toMatch(/F1: confirmed without evidence/);
    expect(text).toMatch(/F2: disputed without the dissent/);
    expect(text).toMatch(/unknown provenance ref P9:c1/);
    expect(text).toMatch(/dropped P1:c2: no reason/);
    expect(text).toMatch(/2 registered refs neither .*P1:c2, P2:c2/);
    expect(result.stats.both).toBe(1); // P2:c1 kept and dropped: recorded, as the current gate does not refuse it
    expect(checkLedger(refs, undefined).errors[0]).toMatch(/no findings array/);
  });
});

describe("T plan check (mechanical contract, not meaning)", () => {
  const plan = (entries: any[]) => ({ entries });
  it("accepts one disposition per claim with exact spans, evidence and reasons", () => {
    const result = checkPlan(refs, "P1", plan([
      { ref: "P1:c1", disposition: "retained", spans: ["mean (calc.js:5-7) computes the average"] },
      { ref: "P1:c2", disposition: "retained", spans: ["For an empty list mean([]) returns NaN"] },
      { ref: "P2:c1", disposition: "duplicate", duplicateOf: "P1:c2", reason: "same" },
      { ref: "P2:c2", disposition: "out_of_scope", reason: "README is not asked about" },
    ]), final);
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ retained: 2, duplicate: 1, out_of_scope: 1, entries: 4, spans: 2, spansFound: 2 });
  });
  it("cannot see a qualifier lost through a 'duplicate' whose target is realized: that is the audit's and the evaluation's job", () => {
    // P2:c1 ("sum([]) is 0 because reduce has an initial value") is not what P1:c2 says, yet the mechanical contract holds.
    const result = checkPlan(refs, "P1", plan([
      { ref: "P1:c1", disposition: "retained", spans: ["mean (calc.js:5-7) computes the average"] },
      { ref: "P1:c2", disposition: "retained", spans: ["mean([]) returns NaN because 0 is divided by 0"] },
      { ref: "P2:c1", disposition: "duplicate", duplicateOf: "P1:c2" },
      { ref: "P2:c2", disposition: "unsupported", reason: "not checked" },
    ]), final);
    expect(result.errors).toEqual([]);
  });
  it("flags stale or nonexistent spans, short spans, missing entries, unrealized duplicate targets, an unmentioned refuted base claim, missing evidence", () => {
    const result = checkPlan(refs, "P1", plan([
      { ref: "P1:c1", disposition: "retained", spans: ["mean computes the arithmetic average of xs"] },
      { ref: "P1:c2", disposition: "refuted", evidence: "" },
      { ref: "P2:c1", disposition: "duplicate", duplicateOf: "P1:c2" },
      { ref: "P2:c2", disposition: "added", spans: ["NaN"], evidence: "" },
      { ref: "P9:c1", disposition: "retained", spans: [] },
    ]), final);
    const text = result.errors.join("\n");
    expect(text).toMatch(/P1:c1: span not found verbatim/);
    expect(text).toMatch(/P1:c2 \(refuted\): no span/); // a refuted BASE claim must be corrected visibly
    expect(text).toMatch(/P1:c2 \(refuted\): no evidence/);
    expect(text).toMatch(/P2:c1 \(duplicate\): P1:c2 is not realized \(refuted\)/);
    expect(text).toMatch(/P2:c2: span not found verbatim .*under four words/);
    expect(text).toMatch(/P2:c2 \(added\): no evidence/);
    expect(text).toMatch(/unknown ref P9:c1/);
    expect(checkPlan(refs, "P1", plan([{ ref: "P1:c1", disposition: "retained", spans: ["mean (calc.js:5-7) computes the average"] }]), final).errors.join("\n")).toMatch(/3 registered refs without an entry: P1:c2, P2:c1, P2:c2/);
    expect(checkPlan(refs, "P1", {}, final).errors[0]).toMatch(/no entries array/);
    expect(checkPlan(refs, "P1", plan([{ ref: "P1:c1", disposition: "kept" }]), final).errors[0]).toMatch(/unknown disposition kept/);
  });
  it("matches spans word-normalized (case, punctuation, markdown) and numbers lines for judges; counts base lines kept verbatim", () => {
    expect(spanFound("MEAN (calc.js:5-7) — computes the average", final)).toBe(true);
    expect(spanFound("computes the", final)).toBe(false);
    expect(spanFound(42, final)).toBe(false);
    expect(numberLines("a\nb")).toBe("L1: a\nL2: b");
    expect(linesKept("one\n\ntwo\nthree", "one\nTWO\nthree\nfour")).toEqual({ lines: 3, kept: 2 });
  });
});

describe("judges: origin-blind statements, validated judgments", () => {
  const sets = { S: [{ id: "c1", claim: "s one", stance: "asserted", locations: [] }, { id: "c2", claim: "s two", stance: "rejected", locations: ["a.py:1"] }], E: [{ id: "c1", claim: "e one", stance: "uncertain", locations: [] }] };
  it("relabels S and E claims as q1… in a unit-fixed order; the judge's input carries no origin", () => {
    const first = statementsOf("u1", sets), again = statementsOf("u1", sets);
    expect(first).toEqual(again);
    expect(Object.values(first.key).sort()).toEqual(["E:c1", "S:c1", "S:c2"]);
    expect(first.statements.map(item => item.id)).toEqual(["q1", "q2", "q3"]);
    const input = judgeInputs("task", "line one\nline two", first.statements);
    expect(input["statements.json"]).not.toMatch(/"origin"|S:c1|E:c1/);
    expect(input["text.md"]).toBe("L1: line one\nL2: line two");
  });
  it("rejects a missing or partial judgment (empty or truncated output) and counts quotes found in the text", () => {
    expect(checkJudgment(["q1"], undefined, "x").errors[0]).toMatch(/no statements array/);
    const text = "The parser stores the opener comment under the first alias member.";
    const result = checkJudgment(["q1", "q2", "q3"], { statements: [
      { id: "q1", realization: "complete", quote: "stores the opener comment under the first alias" },
      { id: "q2", realization: "partial", quote: "a quote that is not there at all" },
      { id: "q2", realization: "missing" },
      { id: "q9", realization: "missing" },
    ] }, text);
    const errors = result.errors.join("\n");
    expect(errors).toMatch(/q2: more than one entry/);
    expect(errors).toMatch(/unknown id q9/);
    expect(errors).toMatch(/1 statements without an entry: q3/);
    expect(checkJudgment(["q1"], { statements: [{ id: "q1", realization: "present" }] }, text).errors[0]).toMatch(/realization must be/);
    expect(checkJudgment(["q1", "q2"], { statements: [{ id: "q1", realization: "complete", quote: "stores the opener comment" }, { id: "q2", realization: "opposed", quote: "nowhere in it" }] }, text)).toMatchObject({ quotesFound: 1, quotesNeeded: 2, errors: [] });
  });
});

describe("isolation and the never-rerun guards", () => {
  it("measured sessions receive only the task, both prior answers and the registered claims", () => {
    const inputs = sourceInputs(TOY);
    expect(Object.keys(inputs).sort()).toEqual(["P1.md", "P2.md", "claims.json", "claims.md", "task.md"]);
    expect(Object.values(inputs).join("\n")).not.toMatch(/rubric|ground truth|evaluator|hidden|fix\.patch|"key"|"map"/i);
    expect(claimsMarkdown(TOY.claims).split("\n")[0]).toBe("- P1:c1 [asserted] mean in calc.js:5-7 computes the average. (locations: calc.js:5-7)");
    // T names the baseline; C stays origin-blinded like the current integration.
    expect(composePrompt(TOY, "T")).toMatch(/BASE = \/tmp\/pi-orche\/input\/P1\.md/);
    expect(composePrompt(TOY, "C")).not.toMatch(/BASE|baseline/);
    expect(reviewPrompt(TOY, "T", true)).toMatch(/BASE = P1\.md/);
    expect(Object.keys(promptHashes())).toHaveLength(14);
  });
  it("refuses to rerun a recorded turn or a pipeline directory without a recorded result (cache collisions)", async () => {
    const dir = await temp();
    await mkdir(join(dir, "turn-1"), { recursive: true });
    await writeFile(join(dir, "turn-1", "meta.json"), "{}");
    await expect(runTurn({ dir, label: "x", caseId: "none", model: "cliproxyapi/gpt-6-astra", prompt: "p", inputs: {}, turn: 1, guardMs: 1000, pool: "measured" })).rejects.toThrow(/already ran/);
    setStudy(dir);
    await mkdir(join(dir, "preflight", "toy", "C-r1"), { recursive: true });
    await expect(pipeline(TOY, "C", 1, join(dir, "results"))).rejects.toThrow(/exists without a recorded pipeline/);
  });
  it("the concurrency gate never runs more jobs than its limit", async () => {
    const gate = new Gate(2);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => gate.run(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; })));
    expect(peak).toBe(2);
  });
});

describe.skipIf(!existsSync(join(QV, "isort-r1", "seed.json")))("frozen inputs of results/quality-validation", () => {
  it("are exactly what the integration stage A read (prior files, seed, task hashes) and S is the base", () => {
    for (const unit of ["dev-r1", "isort-r1", "isort-r2"]) {
      const input = unitInput(unit);
      expect(input.claims.length).toBeGreaterThan(200);
      expect(input.baseLabel).toBe(unit === "dev-r1" ? "P1" : "P2");
      const statements = unitStatements(unit);
      expect(statements.statements.length).toBeGreaterThan(200);
      expect(new Set(Object.values(statements.key)).size).toBe(statements.statements.length);
    }
  });
});
