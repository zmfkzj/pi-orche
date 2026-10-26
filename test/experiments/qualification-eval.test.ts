import { describe, expect, it } from "vitest";
import { mergeJudges, pairVerdict, studyVerdict, metrics, validateAdjudication, unresolvedItems, pairRecord, conclusion, disputedReferences, allocatePackets, shardItems, twinClasses, newClaimCounts, selectionMetrics, initialSelection, gateIntervals, admissibleVerdicts, quoteFidelity, interruptedEnd, phaseOf, accounting, GATES, type Context, type GateScore, type Intervals } from "../../experiments/mdsd-ab/qualification-eval.js";
const entry = (realization = "complete", stance = "asserted", statusDrift = "none") => ({ realization, stance, statusDrift });
const gate = (patch: Partial<GateScore> = {}): GateScore => ({ L: 0, A: 10, F: 1, O: 5, U: 2, H: 0, D: 0, X: 0, ...patch });
describe("qualification-study verdict (not the old preservation-study rule)", () => {
  it("requires fewer false/out assertions with every preservation/addition/uncertainty safeguard", () => {
    expect(pairVerdict(gate({ O: 4 }), gate())).toBe("improvement");
    expect(pairVerdict(gate({ O: 4, L: 1 }), gate())).toBe("mixed");
    expect(pairVerdict(gate({ O: 4, A: 9 }), gate())).toBe("mixed");
    expect(pairVerdict(gate({ O: 4, U: 3 }), gate())).toBe("mixed");
    expect(pairVerdict(gate({ O: 4, H: 1 }), gate())).toBe("mixed");
    expect(pairVerdict(gate({ O: 3, F: 2 }), gate())).toBe("mixed");
    expect(pairVerdict(gate({ L: 0 }), gate({ L: 1 }))).toBe("secondary gain");
    expect(pairVerdict(gate(), gate())).toBe("tie");
    expect(pairVerdict(gate({ U: 3 }), gate())).toBe("regression");
  });
  it("never reports support when the preregistered independent reference replication is missing", () => {
    const pairs = ["dev-r1", "isort-r1", "isort-r2"].flatMap(unit => [1, 2].map(rep => ({ unit, rep, verdict: "improvement", unresolved: false })));
    expect(studyVerdict(pairs, true).verdict).toBe("supported");
    expect(studyVerdict(pairs, false).verdict).toBe("inconclusive");
    expect(studyVerdict(pairs.map(p => ({ ...p, verdict: "mixed" })), true).verdict).toBe("not supported");
    expect(studyVerdict([{ ...pairs[0], unresolved: true }, ...pairs.slice(1)], true).verdict).toBe("inconclusive");
    expect(studyVerdict(pairs.map(p => ({ ...p, verdict: "incomplete" })), true)).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("technical incompleteness") });
  });
  it("keeps accepted-but-unresolved, missing and baseline-less items out of resolved scoring (fail-closed)", () => {
    const planned = [{ id: "S:T-r1:k1" }, { id: "X:T-r1:1.1" }, { id: "R:T-r1:k2" }, { id: "S:Q-r1:k3" }];
    const adj = { "S:T-r1:k1": { verdict: "unresolved" }, "X:T-r1:1.1": { verdict: "unresolved" }, "S:Q-r1:k3": { verdict: "justified" } };
    expect(unresolvedItems(planned, adj).map(i => i.id)).toEqual(["S:T-r1:k1", "X:T-r1:1.1", "R:T-r1:k2"]);
    const scored = { valid: true, ...gate(), variants: { a: gate() } };
    expect(pairRecord("dev-r1", 1, { ...scored, O: 4 }, scored, { valid: false }, [], ["a"])).toMatchObject({ verdict: "incomplete", unresolved: true, reason: expect.stringContaining("baseline") });
    expect(pairRecord("dev-r1", 1, { ...scored, O: 4 }, scored, { valid: true }, ["S:T-r1:k1"], ["a"])).toMatchObject({ verdict: "improvement", unresolved: true });
  });
  it("forces inconclusive when any fixed sensitivity or reference reading changes the conclusion", () => {
    const pairs = ["dev-r1", "isort-r1", "isort-r2"].flatMap(unit => [1, 2].map(rep => ({ unit, rep, verdict: "improvement", unresolved: false, sensitivity: { partialLossHalf: "improvement", round2ReferenceReading: "improvement" } as Record<string, string> })));
    expect(conclusion(pairs, true)).toMatchObject({ conditionalStudy: { verdict: "supported" }, conclusionChangingReadings: [] });
    pairs[2]!.sensitivity.round2ReferenceReading = "regression";
    expect(conclusion(pairs, true)).toMatchObject({ conditionalRaw: { verdict: "supported" }, conditionalStudy: { verdict: "inconclusive" }, conclusionChangingReadings: ["round2ReferenceReading"] });
    expect(conclusion(pairs, false).study.verdict).toBe("inconclusive");
  });
  it("applies round-2 reference disputes only as a second reading; disagreeing disputes become conflicting", () => {
    const refs = new Map([["k1", { id: "k1", support: "supported", relevance: "finding" }], ["k2", { id: "k2", support: "supported", relevance: "out" }]]);
    const adj = { "R:T-r1:k1": { referenceDispute: { support: "refuted", basis: "x" } }, "R:Q-r1:k1": { referenceDispute: { support: "insufficient", basis: "y" } }, "S:T-r1:k2": { referenceDispute: { relevance: "requested_context", basis: "z" } } };
    const second = disputedReferences({ refs, adj } as unknown as Context);
    expect(second.get("k1")!.support).toBe("conflicting");
    expect(second.get("k2")!.relevance).toBe("requested_context");
    expect(refs.get("k1")!.support).toBe("supported");
  });
});
describe("realization-only instrument combination", () => {
  it("uses lower coverage and higher asserted exposure, with explicit disagreement and opposite sensitivity", () => {
    const a = entry("complete", "rejected"), b = entry("partial", "mixed");
    expect(mergeJudges([a, b])).toMatchObject({ realization: "partial", stance: "mixed", disagreement: true });
    expect(mergeJudges([a, b], undefined, true)).toMatchObject({ realization: "complete", stance: "rejected" });
    expect(mergeJudges([a, b], entry("opposed", "rejected"))).toMatchObject({ realization: "opposed", stance: "rejected", disagreement: false });
    expect(mergeJudges([])).toMatchObject({ realization: "unjudged", stance: "unknown" });
  });
});
describe("separate selection, preservation, scope and evidential status", () => {
  const claims = [
    { ref: "k1", source: "D1", stance: "asserted", claim: "only nonempty comments", quote: "", locations: [] },
    { ref: "k2", source: "D1", stance: "asserted", claim: "false assertion", quote: "", locations: [] },
    { ref: "k3", source: "D2", stance: "asserted", claim: "single source valid discovery", quote: "", locations: [] },
    { ref: "k4", source: "D2", stance: "uncertain", claim: "unavailable execution record", quote: "", locations: [] },
    { ref: "k5", source: "D1", stance: "asserted", claim: "requested check context", quote: "", locations: [] },
    { ref: "k6", source: "D1", stance: "asserted", claim: "unrelated true inventory", quote: "", locations: [] },
  ];
  const refs = new Map(claims.map(c => [c.ref, { support: c.ref === "k2" ? "refuted" : c.ref === "k4" ? "insufficient" : "supported", relevance: c.ref === "k5" ? "requested_context" : c.ref === "k6" ? "out" : "supporting", equivalentTo: [] }]));
  const values: any = { k1: entry("partial"), k2: entry("partial", "mixed", "mixed"), k3: entry(), k4: entry("complete", "asserted", "upgrade"), k5: entry(), k6: entry() };
  const ctx = { unit: "toy-never-on-disk", claims, refs, base: "D1", adj: {}, get: (label: string, ref: string) => label === "baseline" && ref === "k3" ? entry("missing", "absent") : values[ref] } as unknown as Context;
  it("does not equate a requested context statement with irrelevant material; retains single-source value and qualifier loss", () => {
    const m = metrics(ctx, "T-r1");
    expect(m.L).toBe(1); expect(m.supportedBase).toBe(2); expect(m.A).toBe(1); expect(m.singleSourceAdditions).toBe(1);
    expect(m.O).toBe(1); expect(m.F).toBe(1); expect(m.U).toBe(1); expect(m.D).toBe(1); // correction of false k2 is NOT harmful drift
    expect(m.falseRepeated).toBe(1); expect(m.falseCorrected).toBe(0);
  });
  it("a pure correction differs from a surviving false occurrence, and an unavailable log is not automatically false", () => {
    const corrected = { ...ctx, get: (label: string, ref: string) => ref === "k2" ? entry("opposed", "rejected", "downgrade") : ctx.get(label, ref) } as Context;
    const m = metrics(corrected, "T-r1"); expect(m.F).toBe(0); expect(m.falseCorrected).toBe(1); expect(m.U).toBe(1); expect(m.D).toBe(1);
  });
});
describe("round-2 packet allocation", () => {
  it("uses at most eight packets, at least one per complete pair group, roughly proportional to the items", () => {
    expect(allocatePackets([300, 200, 100])).toEqual([4, 3, 1]);
    expect(allocatePackets([10, 10, 10, 10, 10, 10]).reduce((a, b) => a + b, 0)).toBe(8);
    expect(allocatePackets([5])).toEqual([8]);
    expect(allocatePackets([1, 1, 1, 1, 1, 1, 1, 1, 1]).every(n => n === 1)).toBe(true);
  });
  it("keeps every O/X item of one text in one shard (sameAs twins) and balances the rest deterministically", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, n) => ({ id: `O:Q-r1:1.${n + 1}`, label: "Q-r1" })),
      { id: "X:Q-r1:2.1", label: "Q-r1" },
      ...Array.from({ length: 2 }, (_, n) => ({ id: `O:T-r1:2.${n + 1}`, label: "T-r1" })),
      ...Array.from({ length: 11 }, (_, n) => ({ id: `R:${n % 2 ? "T" : "Q"}-r1:k${n + 1}`, label: n % 2 ? "T-r1" : "Q-r1" })),
    ];
    const shards = shardItems(items, 2);
    expect(new Set(shards.filter((_, i) => items[i]!.label === "Q-r1" && /^[OX]/.test(items[i]!.id))).size).toBe(1);
    expect(new Set(shards.filter((_, i) => items[i]!.label === "T-r1" && /^[OX]/.test(items[i]!.id))).size).toBe(1);
    const sizes = [0, 1].map(s => shards.filter(x => x === s).length);
    expect(Math.abs(sizes[0]! - sizes[1]!)).toBeLessThanOrEqual(1);
    expect(shardItems(items, 2)).toEqual(shards);
    expect(shardItems(items, 1).every(s => s === 0)).toBe(true);
  });
});
describe("adjudication contract", () => {
  const items = [{ id: "R:t-a:k1", text: "t-a" }, { id: "S:t-a:k1", text: "t-a" }];
  const body = "Only nonempty comments remain here. Empty comments do not remain.";
  it("flags unknown, missing, malformed and unlocated evidence rather than scoring silence as correctness", () => {
    const r = validateAdjudication(items, { items: [{ id: "R:t-a:k1", realization: "partial", stance: "mixed", statusDrift: "none", quote: "Only nonempty comments remain here", counterQuote: "invented opposite statement" }, { id: "x", verdict: "justified" }] }, { "t-a": body });
    expect(r.missing).toEqual(["R:t-a:k1", "S:t-a:k1"]); expect(r.errors.join(" ")).toMatch(/unknown/);
  });
  it("accepts a valid full-text realization and separate decision-rationale judgment", () => {
    const r = validateAdjudication(items, { items: [{ id: "R:t-a:k1", realization: "complete", stance: "asserted", statusDrift: "none", quote: "Only nonempty comments remain here" }, { id: "S:t-a:k1", verdict: "justified", note: "whole condition preserved" }] }, { "t-a": body });
    expect(r.errors).toEqual([]); expect(r.missing).toEqual([]);
  });
  it("accepts a well-formed reference dispute and rejects one without a basis or valid label", () => {
    const ok = validateAdjudication(items, { items: [{ id: "S:t-a:k1", verdict: "justified", referenceDispute: { support: "insufficient", basis: "log unavailable" } }] }, { "t-a": body });
    expect(ok.accepted["S:t-a:k1"]).toBeDefined();
    const bad = validateAdjudication(items, { items: [{ id: "S:t-a:k1", verdict: "justified", referenceDispute: { support: "maybe" } }] }, { "t-a": body });
    expect(bad.accepted["S:t-a:k1"]).toBeUndefined(); expect(bad.errors.join(" ")).toMatch(/referenceDispute/);
  });
  it("records citation fidelity separately from the word-normalized acceptance rule", () => {
    const text = "Header line\nOnly nonempty comments\nremain here, always.\nOther line";
    expect(quoteFidelity("Only nonempty comments", text, [2])).toEqual({ level: "exact", lines: true });
    expect(quoteFidelity("Only nonempty comments remain here", text)).toEqual({ level: "whitespace" });
    expect(quoteFidelity("only NONEMPTY comments; remain here always", text, [3])).toEqual({ level: "normalized", lines: true });
    expect(quoteFidelity("Only nonempty comments", text, [4]).lines).toBe(false);
    expect(quoteFidelity("invented words here", text).level).toBe("absent");
  });
});
describe("round-2 new claims and contradictions (one count per twin class, order-independent)", () => {
  const o = (support: string, relevance?: string, extra: any = {}) => ({ support, ...(relevance ? { relevance } : {}), ...extra });
  it("joins sameAs chains, cycles and reverse pointers; a missing target never hides an error", () => {
    const adj: any = { "O:Q-r1:1.1": o("refuted", "finding", { sameAs: "O:Q-r1:2.1" }), "O:Q-r1:2.1": o("refuted", "finding", { sameAs: "O:Q-r1:1.1" }), "O:Q-r1:1.2": o("supported", "out", { sameAs: "O:Q-r1:9.9" }), "O:Q-r1:1.3": o("insufficient", "finding", { sameAs: "O:Q-r1:1.4" }), "O:Q-r1:1.4": o("insufficient", "finding", { sameAs: "O:Q-r1:1.5" }), "O:Q-r1:1.5": o("insufficient", "finding") };
    expect(twinClasses(adj, "O:Q-r1:").map(c => c.length).sort()).toEqual([1, 2, 3]);
    expect(newClaimCounts(adj, "Q-r1")).toMatchObject({ newF: 1, newO: 1, newU: 1 });
    const reversed = Object.fromEntries(Object.entries(adj).reverse());
    expect(newClaimCounts(reversed, "Q-r1")).toEqual(newClaimCounts(adj, "Q-r1"));
  });
  it("counts F/O/U only for asserted claims, nothing for not_new, and a twin's error survives a not_new twin", () => {
    expect(newClaimCounts({ "O:T-r1:1.1": o("refuted", "out", { asserted: false }) }, "T-r1")).toMatchObject({ newF: 0, newO: 0, newU: 0, hedgedErrors: 1 });
    expect(newClaimCounts({ "O:T-r1:1.1": o("not_new") }, "T-r1")).toMatchObject({ newV: 0, newF: 0, newO: 0, newU: 0, notNew: 1 });
    const mixed = newClaimCounts({ "O:T-r1:1.1": o("refuted", "finding", { sameAs: "O:T-r1:2.1" }), "O:T-r1:2.1": o("not_new") }, "T-r1");
    expect(mixed).toMatchObject({ newF: 1, inconsistentTwins: 1 });
  });
  it("counts a contradiction class once when any member is confirmed", () => {
    const adj: any = { "X:Q-r1:1.1": { verdict: "confirmed", sameAs: "X:Q-r1:2.1" }, "X:Q-r1:2.1": { verdict: "not" }, "X:Q-r1:1.2": { verdict: "unresolved" } };
    expect(newClaimCounts(adj, "Q-r1").X).toBe(1);
  });
});
describe("initial versus final selection and admissible bounds", () => {
  const claims = [{ ref: "k1", source: "D1", stance: "asserted", claim: "a", quote: "", locations: [] }, { ref: "k2", source: "D2", stance: "asserted", claim: "b", quote: "", locations: [] }];
  const refs = new Map([["k1", { support: "supported", relevance: "finding" }], ["k2", { support: "refuted", relevance: "finding" }]]);
  const ctx = { unit: "toy-never-on-disk", claims, refs, base: "D1", adj: { "S:Q-r1:k1": { verdict: "unjustified" } }, get: () => entry() } as unknown as Context;
  it("never credits initial decisions with a final-plan adjudication", () => {
    const final = [{ ref: "k1", action: "exclude" }, { ref: "k2", action: "exclude" }], initial = [{ ref: "k1", action: "include" }, { ref: "k2", action: "exclude" }];
    expect(selectionMetrics(ctx, "Q-r1", final)).toMatchObject({ validRejected: 1, assessed: 1, unjustified: 1 });
    const first = initialSelection(ctx, "Q-r1", initial, final);
    expect(first).toMatchObject({ decisions: 2, validRejected: 0, differsFromFinal: 1, differsFromFinalIds: ["k1"] });
    expect(first.assessed).toBeUndefined(); expect(first.adjudicationScope).toMatch(/not adjudicated/);
  });
  const point = (patch: Partial<GateScore> = {}): Intervals => Object.fromEntries(GATES.map(g => [g, [gate(patch)[g], gate(patch)[g]]])) as Intervals;
  it("gives one admissible verdict without open items and several when open items can change the class", () => {
    expect(admissibleVerdicts(point({ O: 4 }), point())).toEqual(["improvement"]);
    const m = { ...gate(), ids: { loss: [], addition: [], F: ["k2"], O: [], U: [], H: [], D: [] } };
    const q = gateIntervals(ctx, "Q-r1", m, ["R:Q-r1:k2", "O:Q-r1:1.1", "X:Q-r1:1.1", "S:Q-r1:k1"]);
    expect(q.F).toEqual([0, 2]); expect(q.O).toEqual([5, 6]); expect(q.U).toEqual([2, 3]); expect(q.X).toEqual([0, 1]); expect(q.L).toEqual([0, 0]);
    expect(admissibleVerdicts(q, point()).length).toBeGreaterThan(1);
    const rec = pairRecord("dev-r1", 2, { valid: true, ...gate({ O: 4 }), variants: {} }, { valid: true, ...gate(), variants: {} }, { valid: true }, [], [], { Q: point({ O: 4 }), T: point() });
    expect(rec).toMatchObject({ verdict: "improvement", unresolved: false, admissibleVerdicts: ["improvement"], classificationStable: true });
  });
});
describe("accounting helpers", () => {
  it("ends killed sessions at their kill stamp and counts every preflight run as preflight", () => {
    expect(interruptedEnd("/s/judges/dev-r1/Q-r2.claude.killed-20261018T160431Z/turn-1")).toBe("2026-10-18T16:04:31Z");
    expect(interruptedEnd("/s/runs/dev-r1/T-r1/compose/turn-3", "2026-10-18T12:55:27Z")).toBe("2026-10-18T12:55:27Z");
    expect(interruptedEnd("/s/runs/dev-r1/T-r1/compose/turn-3")).toBeUndefined();
    expect(["/s/preflight/judge/turn-1", "/s/preflight-2/judge/turn-1", "/s/runs/x/turn-1", "/s/judges/x/turn-1"].map(phaseOf)).toEqual(["preflight", "preflight", "measured", "judges"]);
  });
  it("refuses to rescan a removed scratch study instead of writing an empty accounting", () => {
    expect(() => accounting("/nonexistent/qual-retry1-removed")).toThrow(/final-accounting/);
  });
});
