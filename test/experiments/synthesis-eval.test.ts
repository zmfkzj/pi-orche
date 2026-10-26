import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalVerdicts, claimNumbers, combine, combineStance, eVerdict, jsonFenceLines, labelOf, pairVerdict, parseFindings, primaryOf, quoteFound, relativeStance, sLabels, studyVerdict, studyVerdictUnder, textMetrics, validateTier2, verdictClass, type JudgeEntry, type Judgments, type Tier2, type UnitContext } from "../../experiments/mdsd-ab/synthesis-eval.js";
import { QV } from "../../experiments/mdsd-ab/synthesis.js";

/**
 * The evaluation side of the synthesis-only validation (experiments/mdsd-ab/synthesis-eval.ts; protocol: results/synthesis-validation/
 * protocol.md) without any model: reading the earlier evaluators' findings into the fixed S reference, the label rules, the judges'
 * combination, metadata-only realization, and the preregistered pair and study verdicts.
 */
describe("the fixed S reference from earlier evaluator reports", () => {
  it("reads finding lines with or without a dash, claim ranges (en dash, hyphen, short form), exclusions and verdict classes", () => {
    const summary = [
      "TOTALS ...",
      "X-1 | X1,X6,X29–X31 | K-I1(3) | Y-1 | parse.py:193",
      "- X-5 D01 | X14 | K2 (3) | Y-11 | workers.ts:1778",
      "- Y-2 | Y15-16 | V low–med | X-7 | as X-7",
      "- X-28 | X80–X82 except initial prompt | S (coverage list) | Y-19 | –",
      "- X-22 | X55 + \"initial prompt preservation\" in the X85 quote | F (K4) | none | index.ts:143",
      "Y-9 | Y27 | C3 | X-3 | settings",
      "not a finding | at all",
    ].join("\n");
    const findings = parseFindings(summary);
    expect(findings.map(item => `${item.id}:${item.cls}:${item.claims.join(",")}`)).toEqual(["X-1:K:1,6,29,30,31", "X-5:K:14", "Y-2:V:15,16", "X-28:S:80,81,82", "X-22:F:55", "Y-9:C:27"]);
    expect(claimNumbers("Y99–Y101,Y104–Y106", "Y")).toEqual([99, 100, 101, 104, 105, 106]);
    expect(verdictClass("V (correct rejection)")).toBe("V");
    expect(verdictClass("U")).toBe("U");
    expect(labelOf(undefined)).toBe("unlabelled");
    expect(labelOf(["V", "S"])).toBe("mixed:SV");
  });
  it.skipIf(!existsSync(join(QV, "eval/evaluators/eval-a1.json")))("labels every S claim of the three units from both reports (no unlabelled or mixed claims)", () => {
    for (const unit of ["dev-r1", "isort-r1", "isort-r2"]) {
      const labels = sLabels(unit);
      const values = Object.values(labels.claims);
      expect(values.every(value => value.a !== "unlabelled" && value.b !== "unlabelled" && !value.a.startsWith("mixed") && !value.b.startsWith("mixed"))).toBe(true);
      expect(labels.counts.valid).toBeGreaterThan(30);
    }
    expect(sLabels("isort-r2").side).toBe("X"); // pair-b put S first
  });
});

describe("label rules and the judges' combination", () => {
  it("combines two labellers into the primary class; reads verdict text and duplicate links", () => {
    expect(primaryOf("V", "K")).toBe("valid");
    expect(primaryOf("S", "S")).toBe("S");
    expect(primaryOf("V", "S")).toBe("valid-either");
    expect(primaryOf("F", "S")).toBe("F-either");
    expect(primaryOf("S", "U")).toBe("S-either");
    expect(primaryOf("U", "?")).toBe("disputed");
    expect(eVerdict({ verdict: "S, dup of Q42" })).toEqual({ cls: "S", dup: "E:c42" });
    expect(eVerdict({ verdict: "K-I1", duplicateOf: "Q3" })).toEqual({ cls: "K", dup: "E:c3" });
    expect(eVerdict({ verdict: "C4" })).toEqual({ cls: "C" });
  });
  it("Tier 2 overrides; agreeing judges stand; otherwise the lower realization, with the higher kept for the sensitivity", () => {
    const entry = (realization: any, textStance = "asserted", lines = [3]) => ({ id: "q1", realization, textStance, lines });
    expect(combine([entry("complete"), entry("complete")])).toMatchObject({ realization: "complete", source: "agree", disagreement: false });
    expect(combine([entry("complete"), entry("partial")])).toMatchObject({ realization: "partial", source: "lower", disagreement: true, higher: "complete" });
    expect(combine([entry("missing"), entry("opposed")])).toMatchObject({ realization: "opposed", higher: "missing" });
    expect(combine([entry("missing"), entry("partial")], { verdict: "complete" })).toMatchObject({ realization: "complete", source: "tier2" });
    expect(combine([undefined, entry("partial", "uncertain")])).toMatchObject({ realization: "partial", source: "single", stance: "uncertain" });
    expect(combine([undefined, undefined])).toMatchObject({ realization: "unjudged", source: "none" });
    expect(combine([entry("complete", "asserted"), entry("complete", "uncertain")]).stance).toBe("mixed");
  });
  it("marks lines inside fenced json blocks (metadata-only realization) but not other fences", () => {
    const text = ["# Answer", "```json", "{\"a\": 1}", "```", "text", "```python", "x = 1", "```"].join("\n");
    expect([...jsonFenceLines(text)]).toEqual([3]);
  });
});

describe("preregistered verdicts", () => {
  it("pair verdicts on (loss, invalid, additions) with T better when loss is lower", () => {
    expect(pairVerdict({ L: 2, I: 5, A: 10 }, { L: 4, I: 5, A: 10 })).toBe("improvement");
    expect(pairVerdict({ L: 4, I: 5, A: 10 }, { L: 4, I: 5, A: 10 })).toBe("tie");
    expect(pairVerdict({ L: 4, I: 3, A: 10 }, { L: 4, I: 5, A: 10 })).toBe("secondary gain");
    expect(pairVerdict({ L: 2, I: 7, A: 10 }, { L: 4, I: 5, A: 10 })).toBe("mixed");
    expect(pairVerdict({ L: 2, I: 5, A: 9 }, { L: 4, I: 5, A: 10 })).toBe("mixed");
    expect(pairVerdict({ L: 5, I: 5, A: 10 }, { L: 4, I: 5, A: 10 })).toBe("regression");
    expect(pairVerdict({ L: 4, I: 6, A: 10 }, { L: 4, I: 5, A: 10 })).toBe("regression");
  });
  it("study verdict: any T-vs-C1 regression means not supported; all improvements in every unit with two complete units means supported", () => {
    const unit = (name: string, verdicts: string[], incomplete = false) => ({
      unit: name,
      texts: Object.fromEntries([1, 2].flatMap(rep => [`T-r${rep}`, `C1-r${rep}`, `C0-r${rep}`].map(label => [label, incomplete ? { incomplete: "x" } : {}]))),
      pairs: [1, 2].flatMap(rep => [
        { rep, t: `T-r${rep}`, c: `C1-r${rep}`, verdict: verdicts[0], T: { L: verdicts[0] === "improvement" ? 1 : 3, I: 0, A: 0 }, C: { L: 2, I: 0, A: 0 } },
        { rep, t: `T-r${rep}`, c: `C0-r${rep}`, verdict: verdicts[1], T: { L: 1, I: 0, A: 0 }, C: { L: 2, I: 0, A: 0 } },
        { rep, t: `Tpre-r${rep}`, c: `C0-r${rep}`, verdict: "mixed" },
      ]),
    });
    expect(studyVerdict([unit("a", ["improvement", "improvement"]), unit("b", ["improvement", "improvement"]), unit("c", ["improvement", "improvement"])]).verdict).toBe("supported");
    expect(studyVerdict([unit("a", ["regression", "improvement"]), unit("b", ["improvement", "improvement"]), unit("c", ["improvement", "improvement"])]).verdict).toBe("not supported");
    expect(studyVerdict([unit("a", ["mixed", "improvement"]), unit("b", ["improvement", "improvement"]), unit("c", ["improvement", "improvement"])]).verdict).toBe("inconclusive");
  });
});

describe("study verdict edge cases", () => {
  it("all pairs mixed with no improvement anywhere is 'not supported' (protocol: no improvement in any unit), not 'inconclusive'", () => {
    const unit = (name: string) => ({
      unit: name,
      texts: Object.fromEntries([1, 2].flatMap(rep => [`T-r${rep}`, `C1-r${rep}`, `C0-r${rep}`].map(label => [label, {}]))),
      pairs: [1, 2].flatMap(rep => [
        { rep, t: `T-r${rep}`, c: `C1-r${rep}`, verdict: "mixed", T: { L: 0, I: 9, A: 5 }, C: { L: 4, I: 5, A: 5 } },
        { rep, t: `T-r${rep}`, c: `C0-r${rep}`, verdict: "mixed", T: { L: 0, I: 9, A: 5 }, C: { L: 4, I: 5, A: 5 } },
      ]),
    });
    const result = studyVerdict([unit("a"), unit("b"), unit("c")]);
    expect(result.verdict).toBe("not supported");
    expect(result.reasons).toContain("no improvement in any unit");
  });
  it("a sensitivity reading replaces every pair's scores and verdict before the same rule runs", () => {
    const unit = { unit: "a", texts: { "T-r1": {}, "C1-r1": {}, "C0-r1": {}, "T-r2": {}, "C1-r2": {}, "C0-r2": {} }, pairs: [1, 2].map(rep => ({ rep, t: `T-r${rep}`, c: `C1-r${rep}`, verdict: "mixed", T: { L: 0, I: 9, A: 5 }, C: { L: 4, I: 5, A: 5 }, variants: { lenient: { T: { L: 0, I: 5, A: 5 }, C: { L: 4, I: 5, A: 5 }, verdict: "improvement" } } })) };
    expect(studyVerdict([unit]).verdict).toBe("not supported");
    expect(studyVerdictUnder([unit], "lenient").verdict).toBe("inconclusive"); // one unit only: fewer than two units with both reps
  });
});

describe("stance relative to the statement as worded (protocol, Tier 2 item 3)", () => {
  it("reads hedging, rejection statements and corrections per judge; absolute is the reading as first coded", () => {
    expect(relativeStance("complete", "asserted", "asserted")).toBe("asserted");
    expect(relativeStance("partial", "uncertain", "asserted")).toBe("hedged");
    expect(relativeStance("complete", "rejected", "asserted")).toBe("not"); // the text corrects the statement
    expect(relativeStance("complete", "rejected", "rejected")).toBe("asserted"); // "X is not a defect" said again
    expect(relativeStance("complete", "asserted", "rejected")).toBe("asserted"); // the same, recorded the other way
    expect(relativeStance("complete", "rejected", "rejected", true)).toBe("not");
    expect(relativeStance("missing", "none", "asserted")).toBe("not");
    expect(relativeStance("opposed", "rejected", "rejected")).toBe("not");
  });
  it("combines two judges like realizations: the lower counts, the higher is the sensitivity, a disagreement is flagged", () => {
    expect(combineStance(["asserted", "asserted"])).toEqual({ value: "asserted", disagreement: false });
    expect(combineStance(["asserted", "hedged"])).toEqual({ value: "hedged", disagreement: true });
    expect(combineStance(["asserted", "not"], "higher")).toEqual({ value: "asserted", disagreement: true });
    expect(combineStance([])).toEqual({ value: "not", disagreement: false });
  });
});

describe("text metrics on a synthetic unit (no files)", () => {
  const statement = (id: string, origin: string, stance: string) => ({ id, origin, stance, statement: `statement ${id}`, locations: [] as string[] });
  const statements = [statement("q1", "S:c1", "asserted"), statement("q2", "S:c2", "rejected"), statement("q3", "S:c3", "asserted"), statement("q4", "E:c1", "asserted"), statement("q5", "E:c2", "rejected"), statement("q6", "E:c3", "asserted"), statement("q7", "S:c4", "asserted")];
  const ctx: UnitContext = {
    unit: "toy", statements, key: Object.fromEntries(statements.map(item => [item.id, item.origin])), byOrigin: new Map(statements.map(item => [item.origin, item.id])),
    s: { "S:c1": { a: "V", b: "K", primary: "valid" }, "S:c2": { a: "S", b: "S", primary: "S" }, "S:c3": { a: "F", b: "F", primary: "F" }, "S:c4": { a: "F", b: "F", primary: "F" } },
    e: { "E:c1": { a: "V", b: "V", primary: "valid", dups: [] }, "E:c2": { a: "V", b: "K", primary: "valid", dups: [] }, "E:c3": { a: "S", b: "S", primary: "S", dups: [] } },
    sourceStance: new Map(statements.map(item => [item.id, item.stance])), inS: new Set(), inSEither: new Set(), notInS: new Set(["q4", "q5"]), map: {},
  };
  const entry = (id: string, realization: JudgeEntry["realization"], textStance = "asserted"): JudgeEntry => ({ id, realization, textStance, lines: [1], quote: "text" });
  const judge = (entries: JudgeEntry[]) => ({ byId: new Map(entries.map(item => [item.id, item])), other: [], contradictions: [], valid: true });
  const judgments: Judgments = {
    claude: judge([entry("q1", "complete"), entry("q2", "complete", "rejected"), entry("q3", "complete"), entry("q4", "complete"), entry("q5", "complete", "rejected"), entry("q6", "complete"), entry("q7", "missing", "none")]),
    gpt: judge([entry("q1", "partial"), entry("q2", "complete", "rejected"), entry("q3", "complete"), entry("q4", "complete", "uncertain"), entry("q5", "complete", "rejected"), entry("q6", "missing", "none"), entry("q7", "missing", "none")]),
  };
  const tier2: Tier2 = new Map([
    ["I:toy:q3", { verdict: "rejected" }],
    ["O:toy:1.1", { verdict: "F" }], ["O:toy:2.1", { verdict: "F", sameAs: "O:toy:1.1" }], ["O:toy:2.2", { verdict: "V" }],
    ["X:toy:1.1", { verdict: "confirmed" }], ["X:toy:2.1", { verdict: "confirmed", sameAs: "X:toy:1.1" }],
  ]);
  const m = textMetrics(ctx, "toy", "line one\n", { tier2, judgments, baseline: new Set(["q2"]) });
  it("loss uses the lower judge, the higher one is the sensitivity", () => {
    expect(m.loss.L).toBe(1);
    expect(m.loss.partial).toBe(1);
    expect(m.lossHigher).toBe(0);
  });
  it("counts a realized out-of-scope rejection statement as asserted invalid content, and the reading as first coded does not", () => {
    expect(m.invalid.S).toBe(1); // q2; q6 is realized by one judge only, so the lower reading leaves it out
    expect(m.invalid.F).toBe(0); // q3 corrected by Tier 2, q7 absent
    expect(m.invalid.total).toBe(2); // q2 + one distinct false other claim
    expect(m.invalidAbsolute).toBe(1); // only the other claim
    expect(m.invalidHigher).toBe(3); // q2 + q6 + the other claim
    expect(m.stanceOpen.ids.invalid).toEqual(["q6"]);
  });
  it("counts hedged and rejection-statement additions under the relative reading only", () => {
    expect(m.additions).toBe(2); // q4 (hedged by one judge: still realized, not rejected) and q5 ("not a defect" said again)
    expect(m.additionsAbsolute).toBe(1);
    expect(m.stanceOpen.additions).toBe(0);
  });
  it("tells corrected from silently removed false baseline claims", () => {
    expect(m.falseBaseline).toEqual([{ q: "q3", handling: "corrected", by: "tier2" }, { q: "q7", handling: "silently removed", by: "judges" }]);
  });
  it("counts twin other claims and contradictions once, and splits invalid content into inherited and new", () => {
    expect(m.invalid.other.F).toBe(1);
    expect(m.newObservations).toBe(1);
    expect(m.otherMerged).toBe(1);
    expect(m.contradictions).toBe(1);
    expect(m.invalidOrigin).toEqual({ inherited: 1, newStatements: 0, newFromE: 0, newFromS: 0, newOther: 1 });
  });
  it("merges sameAs cycles into one claim", () => {
    const cycle: Tier2 = new Map([["O:x:1.1", { verdict: "S", sameAs: "O:x:2.1" }], ["O:x:2.1", { verdict: "S", sameAs: "O:x:1.1" }], ["O:x:2.2", { verdict: "F", sameAs: "O:x:9.9" }]]);
    expect(canonicalVerdicts(cycle, "O", "x")).toEqual({ verdicts: ["S", "F"], merged: 1, conflicts: 0 });
  });
});

describe("Tier-2 ingestion", () => {
  const text = "The parser drops the trailing comment when the line wraps at the limit.\nA second line follows here.";
  const items = ["R:t-aaaaaa:q1", "I:t-aaaaaa:q2", "I:t-aaaaaa:q3", "O:t-aaaaaa:1.1", "O:t-aaaaaa:2.1", "X:t-aaaaaa:1.1", "D:t-aaaaaa:q1", "R:t-aaaaaa:q9"].map(id => ({ id, text: "t-aaaaaa" }));
  const entries = [
    { id: "R:t-aaaaaa:q1", verdict: "Complete", stance: "asserted", quote: "L1: The parser drops the trailing comment when" },
    { id: "I:t-aaaaaa:q2", verdict: "asserted", quote: "a sentence that is not in the text" },
    { id: "I:t-aaaaaa:q3", verdict: "asserted", quote: "The parser drops the trailing comment" },
    { id: "I:t-aaaaaa:q3", verdict: "absent" },
    { id: "O:t-aaaaaa:1.1", verdict: "f" }, { id: "O:t-aaaaaa:1.1", verdict: "F" },
    { id: "O:t-aaaaaa:2.1", verdict: "F", sameAs: "O:t-aaaaaa:9.9" },
    { id: "X:t-aaaaaa:1.1", verdict: "not confirmed" },
    { id: "D:t-aaaaaa:q1", verdict: "maybe" },
    { id: "R:t-bbbbbb:q1", verdict: "complete" },
  ];
  const { accepted, check } = validateTier2(items, entries, { "t-aaaaaa": text });
  it("checks coverage, uniqueness, values per kind and quotes, and keeps rejected entries unresolved", () => {
    expect(check.missing).toEqual(["R:t-aaaaaa:q9"]);
    expect(check.unknown).toEqual(["R:t-bbbbbb:q1"]);
    expect(check.duplicates.sort()).toEqual(["I:t-aaaaaa:q3", "O:t-aaaaaa:1.1"]);
    expect(check.invalid.map(problem => problem.id).sort()).toEqual(["D:t-aaaaaa:q1", "I:t-aaaaaa:q3"]);
    expect(check.quoteMisses).toEqual(["I:t-aaaaaa:q2"]);
    expect(accepted.get("R:t-aaaaaa:q1")).toMatchObject({ verdict: "complete", stance: "asserted" });
    expect(accepted.get("O:t-aaaaaa:1.1")?.verdict).toBe("F");
    expect(accepted.has("I:t-aaaaaa:q3")).toBe(false);
    expect(accepted.has("D:t-aaaaaa:q1")).toBe(false);
  });
  it("reads 'not confirmed' as 'not' and ignores a broken sameAs link, noting both", () => {
    expect(accepted.get("X:t-aaaaaa:1.1")?.verdict).toBe("not");
    expect(accepted.get("O:t-aaaaaa:2.1")).toMatchObject({ verdict: "F" });
    expect(accepted.get("O:t-aaaaaa:2.1")?.sameAs).toBeUndefined();
    expect(check.notes.map(note => note.id).sort()).toEqual(["O:t-aaaaaa:1.1", "O:t-aaaaaa:2.1", "R:t-aaaaaa:q1", "X:t-aaaaaa:1.1"]);
  });
  it("finds quotes with line prefixes and ellipses, and refuses fragments too short to place", () => {
    expect(quoteFound("L1: The parser drops the … wraps at the limit", text)).toBe(true);
    expect(quoteFound("wraps at", text)).toBe(false);
    expect(quoteFound(undefined, text)).toBe(false);
  });
});
