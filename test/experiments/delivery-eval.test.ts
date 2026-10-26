// Pure scoring logic of the delivery-only validation (experiments/mdsd-ab/delivery-eval.ts): delivery predicates, Tier-1 merges,
// verdict classes with unresolved bounds, study conclusions, twin clustering, packet binning, verdict validation and attribution.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assign, checkVerdicts, classify, clusters, conclusion, consistency, delivered, direction, entryVec, failureKinds, k62Reading, merged, newClaimVec, overlapping, pairClass, reportData, studyConclusion, type Item, type Reading, type TextMeasures } from "../../experiments/mdsd-ab/delivery-eval.js";
import type { LedgerEntry } from "../../experiments/mdsd-ab/delivery-render.mjs";

const r = (realization: string, stance: string, status: string, conditions: string): Reading => ({ realization, stance, status, conditions });
const entry = (id: string, decision: LedgerEntry["decision"], extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id, decision, required: "", statement: `statement ${id}`, sourceStance: "asserted", support: "supported", relevance: "finding", conditions: [], note: "", duplicateOf: null, locations: [], quote: "", evidence: "", taskLink: "", ...extra });
const MAIN = { withConditions: true, contextIncluded: true, secondReference: false, applySample: true };
const measures = (base: Record<string, number>, lo = base, hi = base): TextMeasures => ({ status: "judged", base, lo, hi, unresolved: [], detail: {} });

describe("delivery predicates and merges", () => {
  it("decides delivery per decision class, with and without the condition requirement", () => {
    expect(delivered(entry("k1", "include"), r("complete", "asserted", "as_required", "kept"))).toBe(true);
    expect(delivered(entry("k1", "include"), r("partial", "asserted", "as_required", "kept"))).toBe(false);
    expect(delivered(entry("k1", "include"), r("complete", "asserted", "as_required", "lost"))).toBe(false);
    expect(delivered(entry("k1", "include"), r("complete", "asserted", "as_required", "lost"), false)).toBe(true);
    expect(delivered(entry("k2", "uncertain"), r("complete", "asserted", "upgraded", "kept"))).toBe(false);
    expect(delivered(entry("k3", "correct"), r("opposed", "rejected", "as_required", "kept"))).toBe(true);
    expect(delivered(entry("k3", "correct"), r("missing", "absent", "as_required", "not_applicable"))).toBe(false);
    expect(delivered(entry("k4", "exclude"), r("missing", "absent", "as_required", "not_applicable"))).toBe(false);
    expect(failureKinds(entry("k1", "include"), r("missing", "absent", "downgraded", "not_applicable"))).toEqual(["missing", "status"]);
    expect(failureKinds(entry("k1", "include"), r("opposed", "rejected", "downgraded", "lost"))).toEqual(["contradicted", "status", "conditions"]);
    expect(failureKinds(entry("k3", "correct"), r("complete", "asserted", "upgraded", "kept"))).toEqual(["status"]);
  });
  it("merges two readers conservatively or optimistically, field by field", () => {
    const a = r("complete", "asserted", "as_required", "kept"), b = r("partial", "hedged", "downgraded", "lost");
    expect(merged([a, b])).toEqual(r("partial", "asserted", "downgraded", "lost"));
    expect(merged([a, b], true)).toEqual(r("complete", "hedged", "as_required", "kept"));
    expect(merged([a, a])).toEqual(r("complete", "asserted", "as_required", "kept"));
    expect(merged([a, undefined])).toEqual(a);
    expect(delivered(entry("k1", "include"), merged([a, b]))).toBe(false);
  });
});

describe("pair verdicts and study conclusions (protocol §9)", () => {
  const C = { DL: 10, UA: 4, EL: 1, UAinvalid: 1, X: 0, FOUd: 2, VD: 100 };
  it("classifies primary improvement, gates, usefulness cost, ties, regressions and mixed results", () => {
    expect(classify({ ...C, DL: 3 }, C, "none").class).toBe("improved");
    expect(classify({ ...C, DL: 3 }, C, "cost").class).toBe("improved-with-usefulness-cost");
    expect(classify({ ...C, UA: 0, UAinvalid: 0 }, C, "gain").class).toBe("improved");
    expect(classify({ ...C, DL: 3 }, C, "unmeasured").class).toBe("improved (usefulness unmeasured)");
    expect(classify({ ...C, DL: 3, EL: 2 }, C, "none").class).toBe("mixed");
    expect(classify({ ...C, DL: 3, VD: 99 }, C, "none").class).toBe("mixed");
    expect(classify({ ...C, DL: 3, UA: 5 }, C, "none").class).toBe("mixed");
    expect(classify(C, C, "cost").class).toBe("tie");
    expect(classify({ ...C, DL: 11 }, C, "none").class).toBe("regression");
    expect(classify({ ...C, X: 1 }, C, "none").class).toBe("regression");
  });
  it("reports unresolved pairs with the possible classes and incomplete pairs as incomplete", () => {
    const b = measures({ ...C, DL: 9 }, { ...C, DL: 8 }, { ...C, DL: 12 });
    const p = pairClass(b, measures(C), "none");
    expect(p.class).toBe("unresolved");
    expect(p.possible).toEqual(expect.arrayContaining(["improved", "regression"]));
    expect(pairClass(measures({ ...C, DL: 3 }), measures(C), "none").class).toBe("improved");
    expect(pairClass({ ...measures(C), status: "incomplete", reason: "gpt judgment invalid" }, measures(C), "none").class).toBe("incomplete");
  });
  it("derives the preregistered study conclusion, at both extremes when pairs are unresolved", () => {
    const six = (c: string, primary = true) => Array.from({ length: 6 }, () => ({ class: c, primary }));
    expect(conclusion(six("improved"))).toBe("supported (exposed ledgers only)");
    expect(conclusion([...six("improved").slice(0, 5), { class: "improved-with-usefulness-cost", primary: true }])).toBe("fidelity improvement with usefulness trade-off");
    expect(conclusion([...six("improved").slice(0, 5), { class: "regression", primary: false }])).toBe("not supported");
    expect(conclusion(six("mixed", false))).toBe("not supported");
    expect(conclusion([...six("improved").slice(0, 5), { class: "mixed", primary: true }])).toBe("inconclusive");
    expect(conclusion([...six("improved").slice(0, 5), { class: "incomplete" }])).toBe("inconclusive");
    const s = studyConclusion([...six("improved").slice(0, 5), { class: "unresolved", best: "improved", worst: "regression", primary: true }]);
    expect(s).toEqual({ conclusion: "inconclusive (reading-dependent)", best: "supported (exposed ledgers only)", worst: "not supported" });
  });
});

describe("attribution of secondary counts (protocol §8)", () => {
  it("attributes losses, invalid assertions and hedging to the ledger or to delivery", () => {
    const valid = { support: "supported", relevance: "finding" };
    expect(entryVec(entry("k1", "include"), r("missing", "absent", "downgraded", "not_applicable"), valid, MAIN)).toMatchObject({ DL: 1, VL: 1, VLdelivery: 1 });
    expect(entryVec(entry("k2", "exclude"), undefined, valid, MAIN)).toMatchObject({ VL: 1, VLledger: 1 });
    expect(entryVec(entry("k2", "exclude"), r("complete", "asserted", "upgraded", "not_applicable"), valid, MAIN, true)).toMatchObject({ EL: 1, VD: 1 });
    expect(entryVec(entry("k3", "include"), r("complete", "asserted", "as_required", "kept"), { support: "refuted", relevance: "finding" }, MAIN)).toMatchObject({ F: 1, FOU: 1, FOUledger: 1 });
    expect(entryVec(entry("k4", "uncertain"), r("complete", "asserted", "upgraded", "kept"), { support: "insufficient", relevance: "finding" }, MAIN)).toMatchObject({ DL: 1, U: 1, FOUdelivery: 1 });
    expect(entryVec(entry("k5", "uncertain"), r("complete", "hedged", "as_required", "kept"), valid, MAIN)).toMatchObject({ VD: 1, H: 1, Hledger: 1 });
    expect(entryVec(entry("k6", "include"), r("complete", "hedged", "downgraded", "kept"), valid, MAIN)).toMatchObject({ DL: 1, H: 1, Hdelivery: 1 });
    expect(entryVec(entry("k7", "include"), r("complete", "asserted", "as_required", "kept"), { support: "supported", relevance: "requested_context" }, { ...MAIN, contextIncluded: false })).toEqual({});
    expect(newClaimVec([{ support: "supported", relevance: "supporting", stance: "asserted" }, { support: "refuted", relevance: "finding", stance: "asserted" }, { support: "insufficient", relevance: "finding", stance: "hedged" }])).toEqual({ UA: 3, UAvalid: 1, UAinvalid: 1, UAundetermined: 1, newF: 1, newFOU: 1 });
  });
});

describe("items, packets and verdicts", () => {
  const body = "Alpha beta gamma delta epsilon.\nZeta eta theta iota kappa.\nLambda mu nu xi omicron.";
  it("clusters twin allegations by overlapping verbatim quotes, else shared lines", () => {
    const xs = [{ quote: "beta gamma delta", lines: [1] }, { quote: "Alpha beta gamma delta", lines: [9] }, { quote: "Lambda mu nu", lines: [3] }, { quote: "not in text", lines: [3] }, { quote: "Zeta eta theta", lines: [3] }];
    expect(overlapping(xs[0]!, xs[1]!, body)).toBe(true);
    expect(overlapping(xs[2]!, xs[4]!, body)).toBe(false);
    expect(clusters(xs, (a, b) => overlapping(a, b, body)).map(g => g.length).sort()).toEqual([2, 3]);
  });
  it("bins items into at most eight packets, each item once, splitting heavy texts", () => {
    const items: Item[] = Array.from({ length: 90 }, (_, n) => ({ item: `R-T${n < 60 ? "01" : String(2 + (n % 5)).padStart(2, "0")}-k${n}`, kind: n % 10 === 0 ? "O" : "R", text: n < 60 ? "T01" : `T0${2 + (n % 5)}`, ledger: "dev-r1.Q-r2" }));
    const bins = assign(items);
    expect(bins.length).toBeLessThanOrEqual(8);
    expect(bins.flat().map(i => i.item).sort()).toEqual(items.map(i => i.item).sort());
    expect(bins.filter(b => b.some(i => i.text === "T01")).length).toBeGreaterThan(1);
  });
  it("accepts complete verbatim verdicts and rejects missing, malformed or unquoted ones", () => {
    const items: Item[] = [
      { item: "R-T01-k1", kind: "R", text: "T01", ledger: "dev-r1.Q-r2" }, { item: "R-T01-k2", kind: "R", text: "T01", ledger: "dev-r1.Q-r2", exclude: true },
      { item: "O-T01-1", kind: "O", text: "T01", ledger: "dev-r1.Q-r2" }, { item: "X-T01-1", kind: "X", text: "T01", ledger: "dev-r1.Q-r2" }, { item: "S-T01-k3", kind: "S", text: "T01", ledger: "dev-r1.Q-r2" },
    ];
    const good = { items: [
      { item: "R-T01-k1", realization: "complete", stance: "asserted", status: "as_required", conditions: "kept", quotes: [{ line: 1, quote: "beta gamma delta" }], resolved: true },
      { item: "R-T01-k2", realization: "missing", stance: "absent", status: "as_required", conditions: "not_applicable", presented: false, quotes: [], reason: "searched for zeta and synonyms", resolved: true },
      { item: "O-T01-1", origin: "new", claims: [{ claim: "Lambda", quote: "Lambda mu nu", stance: "asserted", support: "supported", relevance: "supporting", basis: "src/x.ts:1" }], resolved: true },
      { item: "X-T01-1", confirmed: false, quotes: [{ line: 2, quote: "Zeta eta theta" }], resolved: true },
      { item: "S-T01-k3", resolved: false, reason: "the passage is ambiguous" },
    ] };
    const bodies = new Map([["T01", body]]);
    expect(checkVerdicts(items, good, bodies)).toMatchObject({ errors: [] });
    expect(checkVerdicts(items, good, bodies).valid.size).toBe(5);
    const bad = { items: [{ ...good.items[0], quotes: [{ line: 1, quote: "not present here at all" }] }, { ...good.items[1], presented: undefined }, { ...good.items[2], claims: [{ claim: "x", quote: "Lambda mu nu", stance: "asserted", support: "maybe", relevance: "supporting", basis: "" }] }, good.items[3], { item: "S-T01-k3", resolved: false }, { item: "R-T09-k9", resolved: false, reason: "x" }] };
    const c = checkVerdicts(items, bad, bodies);
    expect(c.valid.size).toBe(1);
    expect(c.errors.join("\n")).toMatch(/R-T01-k1: quote 1 not found verbatim/);
    expect(c.errors.join("\n")).toMatch(/R-T01-k2: presented must be true or false/);
    expect(c.errors.join("\n")).toMatch(/O-T01-1: claim 1: support; claim 1: basis/);
    expect(c.errors.join("\n")).toMatch(/S-T01-k3: unresolved without reason/);
    expect(c.errors.join("\n")).toMatch(/R-T09-k9: not an item of this packet/);
  });
  it("extracts the last report_result data of a worker session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "delivery-eval-"));
    try {
      const file = join(dir, "W9.1.jsonl"), call = (data: unknown) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "report_result", arguments: { kind: "verify", summary: "s", data } }] } });
      await writeFile(file, [JSON.stringify({ type: "session" }), call({ packet: "P1-1", round: 1, items: [] }), call({ status: "ok", evidence: { packet: "P1-1", round: 1, items: [{ item: "X" }] } })].join("\n"));
      expect(reportData(file)).toEqual({ packet: "P1-1", round: 1, items: [{ item: "X" }] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("replication readings (results/delivery-validation-high/protocol.md §7)", () => {
  it("k62: one uniform rule for both arms that changes only k62's status", () => {
    const complete = r("complete", "hedged", "mixed", "kept"), asRequired = r("complete", "hedged", "as_required", "kept");
    expect(k62Reading("delivered", complete, [])).toEqual(asRequired);
    expect(k62Reading("delivered", r("partial", "hedged", "mixed", "kept"), [])).toEqual(r("partial", "hedged", "mixed", "kept"));
    expect(k62Reading("delivered", r("complete", "hedged", "mixed", "lost"), [])).toEqual(r("complete", "hedged", "mixed", "lost"));
    // failed: wherever any reader (or the accepted reading) saw the conflict
    expect(k62Reading("failed", asRequired, [asRequired, complete])).toEqual(complete);
    expect(k62Reading("failed", asRequired, [asRequired, asRequired])).toEqual(asRequired);
    expect(k62Reading("failed", complete, [undefined])).toEqual(complete);
    expect(delivered(entry("k62", "uncertain"), k62Reading("delivered", complete, []))).toBe(true);
    expect(delivered(entry("k62", "uncertain"), k62Reading("failed", asRequired, [complete]))).toBe(false);
  });
  it("effort direction needs both high values strictly beyond both max values; consistency needs all ledgers", () => {
    expect(direction([3, 2], [1, 0])).toBe("high lower");
    expect(direction([1, 2], [3, 4])).toBe("high higher");
    expect(direction([1, 3], [2, 2])).toBe("overlap");
    expect(direction([2, 2], [2, 1])).toBe("overlap");
    expect(direction([0, 0], [0, 0])).toBe("overlap");
    expect(direction([1, null], [0, 0])).toBe("unavailable");
    expect(consistency(["high lower", "high lower", "high lower"])).toBe("consistent (high lower)");
    expect(consistency(["high lower", "overlap", "high lower"])).toBe("not consistent");
    expect(consistency(["overlap", "overlap", "overlap"])).toBe("not consistent");
    expect(consistency(["unavailable", "unavailable", "unavailable"])).toBe("not consistent");
  });
});
