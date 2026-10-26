import { describe, expect, it } from "vitest";
import { LABELS, blockOf, check, headingOf, render, requiredOf, scanText, tagOf, validateArrangement, type Ledger, type LedgerEntry } from "../../experiments/mdsd-ab/delivery-render.mjs";
import { TOY, canonicalLedger, checkAudit, checkComposeB, checkComposeC, checkJudgment, checkPairwise, citationStatus, cueCount, ledgerMarkdown, pairOrder, prompts, quoteStatus } from "../../experiments/mdsd-ab/delivery.js";
import { JUDGES } from "../../experiments/mdsd-ab/delivery-runtime.js";

const toy = () => canonicalLedger("toy", TOY.claims, TOY.plan, {}).ledger;
const good = { main: ["k1", "k2"], sections: [{ label: "Supporting details", span: null, from: null, items: ["k3"] }, { label: "Corrections", span: "README.md", from: "k4", items: ["k4"] }], appendix: [], proposals: [{ ids: ["k2"], kind: "reword", text: "mean([]) is NaN", why: "shorter" }] };

describe("canonical ledger (frozen rules, nothing repaired)", () => {
  it("maps dispositions to one decision class each and keeps statement bytes", () => {
    const l = toy();
    expect(l.entries.map(e => [e.id, e.decision])).toEqual([["k1", "include"], ["k2", "uncertain"], ["k3", "include"], ["k4", "correct"], ["k5", "duplicate"], ["k6", "exclude"]]);
    expect(l.entries.map(e => e.statement)).toEqual(TOY.claims.map(c => c.claim));
    expect(l.entries.find(e => e.id === "k5")!.duplicateOf).toBe("k1");
    expect(l.entries.find(e => e.id === "k2")!.required).toMatch(/unverified/);
    expect(l.entries.find(e => e.id === "k1")!.note).toBe("");
  });
  it("drops only qualifiers that restate the statement and keeps reasons verbatim as notes of uncertain/correct/exclude entries", () => {
    const claims = ["a1 is broken.", "b2 is fine.", "c3 is unclear.", "d4 is wrong."].map((claim, i) => ({ ref: `k${i + 1}`, claim, quote: claim, stance: "asserted", locations: [], source: "doc-A" }));
    const reason = (own: string) => `${own} Pipeline boilerplate sentence.`;
    const plan = { entries: [
      { ref: "k1", disposition: "retained", support: "supported", relevance: "finding", qualifiers: ["A1 is broken", "only on Linux"], evidence: "e", reason: reason("Keep."), taskLink: "t" },
      { ref: "k2", disposition: "added", support: "supported", relevance: "supporting", qualifiers: [], evidence: "e", reason: reason("Add."), taskLink: "t" },
      { ref: "k3", disposition: "uncertain", support: "conflicting", relevance: "finding", qualifiers: [], evidence: "e", reason: reason("A rerun would settle it."), taskLink: "t" },
      { ref: "k4", disposition: "corrected", support: "refuted", relevance: "finding", qualifiers: ["d4 works on main"], evidence: "e", reason: "It works on main.", taskLink: "t" },
    ] };
    const { ledger, record } = canonicalLedger("x", claims, plan, { "doc-A.md": "a1 is broken. b2 is fine." });
    expect(ledger.entries[0]!.conditions).toEqual(["only on Linux"]);
    expect(record.rows[0].droppedQualifiers).toEqual([0]);
    expect(ledger.entries[2]!.note).toBe("A rerun would settle it. Pipeline boilerplate sentence.");
    expect(ledger.entries[0]!.note).toBe("");
    expect(ledger.entries[3]!.note).toBe("It works on main.");
    expect(record.notesEmpty).toEqual([]);
    expect(record.quotes).toEqual({ exact: 2, not_found: 2 });
    expect(ledger.entries[2]!.required).toMatch(/disputed/);
  });
  it("refuses unknown dispositions and duplicate pointers to unregistered entries", () => {
    const claims = [{ ref: "k1", claim: "x", quote: "x", stance: "asserted", locations: [], source: "doc-A" }];
    expect(() => canonicalLedger("x", claims, { entries: [{ ref: "k1", disposition: "kept" }] }, {})).toThrow(/unknown disposition/);
    expect(() => canonicalLedger("x", claims, { entries: [{ ref: "k1", disposition: "duplicate", duplicateOf: "k9" }] }, {})).toThrow(/duplicate of unknown/);
    expect(() => canonicalLedger("x", claims, { entries: [] }, {})).toThrow(/no plan entry/);
  });
  it("records quote and citation integrity without repairing anything", () => {
    expect(quoteStatus("Exact words", "has Exact words here")).toBe("exact");
    expect(quoteStatus("exact, words!", "has Exact words here")).toBe("normalized");
    expect(quoteStatus("absent", "text")).toBe("not_found");
    expect(quoteStatus("", "text")).toBe("empty");
    const snap = { files: new Set(["src/a.ts"]), lines: () => 10 };
    expect(citationStatus("src/a.ts:3-7,9", snap)).toBe("in_range");
    expect(citationStatus("src/a.ts:3-12", snap)).toBe("out_of_range");
    expect(citationStatus("doc-A/x.json", snap)).toBe("not_a_line_citation");
    expect(citationStatus("src/b.ts:1", snap)).toBe("file_not_in_snapshot");
    expect(citationStatus("a.ts:2–4", snap)).toBe("in_range");
    expect(citationStatus("a.ts:1", { files: new Set(["x/a.ts", "y/a.ts"]), lines: () => 10 })).toBe("ambiguous_path");
    expect(cueCount("the BASE says; baseline and editing base")).toBe(3);
    expect(ledgerMarkdown(toy())).toContain("## k4 — correct");
  });
});

describe("ledger-bound rendering and mechanical checks", () => {
  it("renders every approved entry exactly once with generated labels, verbatim negation and conditions, and checks clean", () => {
    const l = toy(), r = render(l, good), c = check(l, good, r.text);
    expect(c.errors).toEqual([]);
    expect(c.stats.blocksOnce).toBe(4);
    expect(r.text).toContain("sum([]) does not throw: reduce starts from the initial value 0.");
    expect(r.text).toContain("**[Uncertain: unverified]** mean([]) returns NaN");
    expect(r.text).toContain("  - Open question (decision record): Running mean([]) once would settle it.");
    expect(r.text).toContain("**[Corrected]** The following earlier statement is not accurate as worded: “README.md documents the empty-list behavior.”");
    expect(r.text).toContain("## Corrections: README.md");
    expect(r.text).not.toMatch(/\bk\d\b/);
    expect(r.text).not.toContain("two-space indentation");
    expect(r.text).not.toContain("The average is computed by mean (calc.js:5).");
    expect(r.text).not.toContain("mean([]) is NaN");
    expect(r.proposals.recorded).toBe(1);
    expect(render(l, good).text).toBe(r.text);
    expect(r.map.k4!.region).toBe("section");
  });
  it("reports placement errors and still delivers every approved entry through recorded fallbacks", () => {
    const l = toy(), bad = { main: ["k1", "k1", "k6", "k99"], sections: [{ label: "Not a label", items: ["k5", "k2"] }], proposals: "x" };
    const v = validateArrangement(l, bad);
    expect(v.errors.join("\n")).toMatch(/placed more than once/);
    expect(v.errors.join("\n")).toMatch(/k6 is a exclude entry/);
    expect(v.errors.join("\n")).toMatch(/unknown id "k99"/);
    expect(v.errors.join("\n")).toMatch(/k5 is a duplicate entry/);
    expect(v.errors.join("\n")).toMatch(/2 approved entries not placed: k3, k4/);
    expect(v.errors.join("\n")).toMatch(/not one of the closed labels/);
    expect(v.errors.join("\n")).toMatch(/proposals must be an array/);
    const r = render(l, bad), c = check(l, bad, r.text);
    expect(c.errors).toEqual([]);
    expect(r.text).toContain("## Section 1");
    expect(r.text).toContain("## Approved entries not placed by the arrangement (generated)");
    expect(c.stats.placement).toEqual({ main: 1, section: 1, unplaced: 2 });
    expect(r.fallbacks.length).toBeGreaterThan(3);
    const empty = render(l, null), ce = check(l, null, empty.text);
    expect(ce.errors).toEqual([]);
    expect(ce.stats.blocksOnce).toBe(4);
  });
  it("allows only closed labels and exact word-bounded spans of an entry of the same section", () => {
    const byId = new Map(toy().entries.map(e => [e.id, e] as [string, LedgerEntry]));
    expect(headingOf({ label: LABELS[0], items: ["k1"] }, byId)).toEqual({ text: "Findings" });
    expect(headingOf({ span: "computes the average", from: "k1", items: ["k1"] }, byId)).toEqual({ text: "computes the average" });
    expect(headingOf({ span: "Numeric arrays only", from: "k1", items: ["k1"] }, byId)).toEqual({ text: "Numeric arrays only" });
    expect(headingOf({ span: "computes the averag", from: "k1", items: ["k1"] }, byId).error).toMatch(/word-bounded/);
    expect(headingOf({ span: "average is broken", from: "k1", items: ["k1"] }, byId).error).toMatch(/not an exact/);
    expect(headingOf({ span: "computes the average", from: "k2", items: ["k1"] }, byId).error).toMatch(/from must name/);
    expect(headingOf({ span: "one two three four five six seven eight nine", from: "k1", items: ["k1"] }, byId).error).toMatch(/at most 8/);
    expect(headingOf({ items: ["k1"] }, byId).error).toMatch(/needs a label or a span/);
    expect(headingOf({ span: " computes", from: "k1", items: ["k1"] }, byId).error).toMatch(/surrounding spaces/);
  });
  it("detects unauthorized prose, hidden blocks, removed conditions, leaked exclusions and untagged corrections in a delivered text", () => {
    const l = toy(), r = render(l, good);
    expect(check(l, good, r.text.replace("## Main points\n", "## Main points\n\nThe code is fine.\n")).errors.join("\n")).toMatch(/differs from the deterministic rendering/);
    const k3 = blockOf(l.entries.find(e => e.id === "k3")!);
    expect(check(l, good, r.text.replace(`${k3}\n`, `<!--\n${k3}\n-->\n`)).errors.join("\n")).toMatch(/k3: (exact rendered block|block lies inside)/);
    expect(check(l, good, r.text.replace("  - Condition/limit: Numeric arrays only\n", "")).errors.join("\n")).toMatch(/k1: exact rendered block occurs 0 times/);
    expect(check(l, good, `${r.text}\ncalc.js uses two-space indentation.\n`).errors.join("\n")).toMatch(/k6 \(exclude\): statement appears/);
    expect(check(l, good, `${r.text}\n- README.md documents the empty-list behavior.\n`).errors.join("\n")).toMatch(/k4: corrected statement also appears as an untagged/);
  });
  it("generates tags and required delivery from frozen fields only", () => {
    expect(tagOf({ decision: "include", support: "supported", relevance: "finding" })).toBe("");
    expect(tagOf({ decision: "include", support: "supported", relevance: "requested_context" })).toBe("**[Requested context]** ");
    expect(tagOf({ decision: "uncertain", support: "supported", relevance: "ambiguous" })).toBe("**[Uncertain: scope or applicability open · Scope ambiguous]** ");
    expect(tagOf({ decision: "correct", support: "supported", relevance: "finding" })).toBe("**[Corrected]** ");
    expect(requiredOf({ decision: "exclude", support: "supported", duplicateOf: null })).toMatch(/not part of the answer/);
    expect(requiredOf({ decision: "duplicate", support: "supported", duplicateOf: "k2" })).toMatch(/Duplicate of k2/);
  });
  it("scans any text lexically without scoring meaning", () => {
    const l: Ledger = toy();
    const s = scanText(l, "mean in calc.js:5-7 computes the average.\n<!-- k3 -->\ncalc.js uses two-space indentation.\n");
    expect(s.idMentions).toBe(1);
    expect(s.hidden.comments).toBe(1);
    expect(s.approvedVerbatim).toBe(1);
    expect(s.otherVerbatim).toEqual(["k6"]);
  });
});

describe("mechanical gates of composer, audit and instrument outputs", () => {
  it("C compose needs a non-empty answer without ledger ids; B compose needs a valid arrangement", () => {
    expect(checkComposeC("")).toEqual(["final.md is missing or empty"]);
    expect(checkComposeC("See k12 and k3.")[0]).toMatch(/k12, k3/);
    expect(checkComposeC("An answer about mean and sum.")).toEqual([]);
    expect(checkComposeB(toy(), "{not json")[0]).toMatch(/not valid JSON/);
    expect(checkComposeB(toy(), "")).toEqual(["arrangement.json is missing"]);
    expect(checkComposeB(toy(), JSON.stringify(good))).toEqual([]);
  });
  it("validates audits, judgments and pairwise outputs as schema only", () => {
    expect(checkAudit({ defects: [] })).toEqual([]);
    expect(checkAudit({ defects: [{ kind: "nonsense", problem: "" }] })).toHaveLength(2);
    const text = "mean in calc.js:5-7 computes the average for numeric arrays.";
    const item = (id: string, extra: any = {}) => ({ id, realization: "missing", stance: "absent", status: "not_applicable", conditions: "not_applicable", quote: "", ...extra });
    const value = { items: ["k1", "k2"].map(id => item(id)), other: [], contradictions: [], usefulness: { answersTask: 3, organization: 3, readability: 3, statusClarity: 3, concision: 3, mainAnswerLines: [1], problems: [] } };
    expect(checkJudgment(["k1", "k2"], value, text)).toEqual([]);
    value.items[0] = item("k1", { realization: "complete", stance: "asserted", status: "as_required", conditions: "kept", quote: "computes the average for numeric" });
    expect(checkJudgment(["k1", "k2"], value, text)).toEqual([]);
    value.items[0] = item("k1", { realization: "complete", quote: "this is not in the text" });
    expect(checkJudgment(["k1", "k2"], value, text).join(" ")).toMatch(/quote not found/);
    expect(checkJudgment(["k1", "k2", "k3"], { ...value, items: [item("k1"), item("k2")] }, text).join(" ")).toMatch(/1 ledger entries without an item: k3/);
    expect(checkPairwise({ overall: "X", criteria: { answersTask: "X", organization: "Y", readability: "tie", statusClarity: "X", concision: "Y" }, reasons: "r", problemsX: [], problemsY: [] })).toEqual([]);
    expect(checkPairwise({ overall: "B" }).length).toBeGreaterThan(3);
  });
  it("gives the two judge families opposite blind orders and keeps the delivery contract identical in both composer prompts", () => {
    for (const rep of [1, 2]) { const a = pairOrder("dev-r1.Q-r2", rep, JUDGES[0]), b = pairOrder("dev-r1.Q-r2", rep, JUDGES[1]); expect(a.X).toBe(b.Y); expect(a.Y).toBe(b.X); }
    expect(prompts.C_COMPOSE).not.toMatch(/render\.mjs/);
    expect(prompts.B_COMPOSE).toMatch(/render\.mjs/);
    expect(prompts.JUDGE).not.toMatch(/arm|treatment|control|render/i);
    expect(prompts.PAIR).not.toMatch(/arm|treatment|control|render|ledger-bound/i);
  });
});
