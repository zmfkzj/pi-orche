// Scoring rules of the bottleneck-isolation study (results/bottleneck-isolation/protocol.md §8-§11), on synthetic inputs: gates before
// coverage, unresolved bounds, the usefulness rule, packet-implied attribution, the adjudication allocation and the E2-b prerequisite.
import { describe, expect, it } from "vitest";
import { PACKET_CAP, ROUND_CAP, allocate, pack, checkVerdicts, classify, classifyPoints, clustersOf, idealReadings, ledgerTraceable, planRoundOne, planRoundTwo, prerequisiteOf, tri, writingAttributed, type Item, type Measures, type Range } from "../../experiments/mdsd-ab/bottleneck-eval.js";

const R = (lo: number, hi = lo): Range => ({ lo, hi });
const measures = (over: Partial<Record<keyof Measures, any>> = {}): Measures => ({ status: "judged", EC: R(50), VC: R(150), OC: R(100), Fcore: R(0), Fminor: R(0), Ucore: R(0), Uminor: R(0), Dcore: R(0), O: R(0), Hcore: R(0), corrections: R(0), Rpts: R(3), Rcontra: R(0), X: R(0), UAinvalid: R(0), UAinvalidEssential: R(0), uaOpen: 0, UAvalid: R(0), UAundetermined: R(0), capViolation: 0, artifactMissing: 0, leak: 0, unresolvedItems: [], ...over });

describe("classification hierarchy (protocol §9)", () => {
  it("decides by gates alone: a critical error is never offset by coverage, rubric points, optional information or usefulness", () => {
    const p = measures({ Ucore: R(1), EC: R(80), OC: R(140), Rpts: R(6) }), q = measures();
    expect(classify(p, q, "P").class).toBe("worse");
    expect(classify(p, q, "P", true).class).toBe("worse");
    expect(classify(q, p, "Q").class).toBe("better");
    expect(classify(measures({ capViolation: 1, EC: R(90) }), measures(), "P").class).toBe("worse");
    expect(classify(measures({ Fcore: R(1) }), measures({ Dcore: R(1) }), "equal").class).toBe("mixed");
  });
  it("compares coverage, hedging, contradictions, minor errors and usefulness jointly among gate-equal answers", () => {
    expect(classify(measures({ EC: R(52) }), measures(), "equal").class).toBe("better");
    expect(classify(measures({ EC: R(52) }), measures(), "Q").class).toBe("mixed");
    expect(classify(measures({ Fminor: R(1) }), measures(), "P").class).toBe("mixed");
    expect(classify(measures(), measures(), "equal").class).toBe("tie");
    expect(classify(measures(), measures(), "P").class).toBe("better");
    // optional information is only a sensitivity reading
    expect(classify(measures({ OC: R(120) }), measures(), "equal").class).toBe("tie");
    expect(classify(measures({ OC: R(120) }), measures(), "equal", true).class).toBe("better");
  });
  it("reports unresolved items at both extremes as a set of possible classes, and never treats missing judgments as zero", () => {
    const k = classify(measures({ Ucore: R(0, 1) }), measures(), "equal");
    expect(k.possible.sort()).toEqual(["tie", "worse"]);
    expect(k.class).toBe("unresolved {tie, worse}");
    expect(classify(measures(), measures(), "unresolved").class).toBe("unresolved {better, worse}");
    expect(classify(measures({ status: "incomplete" }), measures(), "P").class).toBe("incomplete");
    expect(classifyPoints({ Rcontra: 0, Fcore: 0, Ucore: 0, Dcore: 0, UAinvalid: 0, capViolation: 0, artifactMissing: 0, leak: 0, Rpts: 3, EC: 50, Hcore: 0, X: 0, minor: 0 }, { Rcontra: 0, Fcore: 0, Ucore: 0, Dcore: 0, UAinvalid: 0, capViolation: 0, artifactMissing: 0, leak: 1, Rpts: 0, EC: 0, Hcore: 9, X: 9, minor: 9 }, "Q")).toBe("better");
  });
  it("keeps a detected invalid writer-added claim in the main gate and leaves open UA clusters unbounded (addendum 3)", () => {
    const q = measures();
    expect(classify(measures({ UAinvalid: R(1), EC: R(55), Rpts: R(8) }), q, "P").class).toBe("worse");
    const open = measures({ UAinvalid: R(0), uaOpen: 2, EC: R(55) });
    expect(classify(open, q, "equal").class).toBe("unresolved {better, worse}");
    expect(classify(open, q, "equal", false, true).class).toBe("better");
    expect(classify(q, measures({ UAinvalid: R(1), uaOpen: 1 }), "equal").class).toBe("better");
    expect(classify(measures({ UAinvalid: R(1) }), measures({ UAinvalid: R(1), uaOpen: 1 }), "equal").class).toBe("unresolved {better, tie}");
  });
  it("lets only a determinate better-than-S estimate qualify Experiment 2-b", () => {
    expect(prerequisiteOf({ "dev-r1": "better", "isort-r1": "worse" })).toEqual(["dev-r1"]);
    expect(prerequisiteOf({ "dev-r1": "unresolved {better, mixed}", "isort-r1": "mixed", "isort-r2": "tie" })).toEqual([]);
    expect(prerequisiteOf({ "dev-r1": "incomplete" })).toEqual([]);
    expect(prerequisiteOf({ "dev-r1": "better", "isort-r1": "better" }, { "dev-r1": 3, "isort-r1": 4 })).toEqual(["isort-r1"]);
  });
});

describe("readings, clusters and attribution (protocol §8)", () => {
  it("combines two readers by agreement, a verdict first, otherwise unresolved", () => {
    const a = { realization: "complete", stance: "asserted" }, b = { realization: "partial", stance: "asserted" };
    expect(tri([a, a], "covered")).toBe(true);
    expect(tri([a, b], "covered")).toBeUndefined();
    expect(tri([a, b], "asserted")).toBe(true);
    expect(tri([a, b], "covered", { resolved: true, realization: "partial", stance: "hedged" })).toBe(false);
    expect(tri([a, undefined], "covered")).toBeUndefined();
    expect(tri([{ realization: "complete", stance: "rejected" }, a], "covered")).toBeUndefined();
  });
  it("forms equivalence clusters from labeller-b links within the kept ids", () => {
    const refs = new Map([["k1", { id: "k1", support: "supported", relevance: "finding", salience: "essential", equivalentTo: ["k3"] }], ["k2", { id: "k2", support: "supported", relevance: "finding", salience: "essential", equivalentTo: [] }], ["k3", { id: "k3", support: "supported", relevance: "finding", salience: "essential", equivalentTo: [] }], ["k4", { id: "k4", support: "supported", relevance: "out", salience: "detail", equivalentTo: ["k2"] }]]);
    expect(clustersOf(refs, () => true).map(c => c.sort()).sort()).toEqual([["k1", "k3"], ["k2", "k4"]]);
    expect(clustersOf(refs, id => id !== "k4").map(c => c.sort()).sort()).toEqual([["k1", "k3"], ["k2"]]);
  });
  it("derives packet-implied readings from the text's own ledger and attributes the rest to writing", () => {
    const ledger: any = { ledger: "t", entries: [{ id: "k1", decision: "include" }, { id: "k2", decision: "uncertain" }, { id: "k3", decision: "correct" }, { id: "k4", decision: "exclude" }, { id: "k5", decision: "duplicate", duplicateOf: "k1" }, { id: "k6", decision: "duplicate", duplicateOf: "k4" }] };
    const p = idealReadings(ledger);
    expect([p("k1", "covered"), p("k1", "asserted"), p("k2", "covered"), p("k2", "hedged"), p("k3", "rejOpp"), p("k4", "covered"), p("k5", "covered"), p("k6", "covered")]).toEqual([true, true, true, true, true, false, true, false]);
    const w = writingAttributed(measures({ EC: R(48, 50), Ucore: R(1) }), measures({ EC: R(52), Ucore: R(0) }));
    expect(w.EC).toEqual({ lo: -4, hi: -2 });
    expect(w.Ucore).toEqual({ lo: 1, hi: 1 });
  });
  it("pre-filters writer-added claims lexically against any single ledger field", () => {
    const ledger: any = { entries: [{ statement: "The fingerprint covers only git-visible files", conditions: ["node_modules is ignored"], note: "", evidence: "candidate-workspace.ts:459 builds the manifest", taskLink: "", quote: "" }] };
    expect(ledgerTraceable("fingerprint covers only git-visible files", ledger)).toBe(true);
    expect(ledgerTraceable("The scheduler retries every request three times after a timeout", ledger)).toBe(false);
  });
});

describe("host-verification allocation and verdict checks (protocol §11)", () => {
  const item = (id: string, category: any, kind: any = "C", text = "T01"): Item => ({ item: id, kind, category, text, unit: "dev-r1", priority: 0 });
  it("trims in reverse priority (S, M, P, X, C, K) and never trims gate items", () => {
    const items = [...Array.from({ length: 5 }, (_, i) => item(`G${i}`, "G")), ...Array.from({ length: 5 }, (_, i) => item(`S${i}`, "S")), ...Array.from({ length: 3 }, (_, i) => item(`P${i}`, "P", "P", undefined as any)), ...Array.from({ length: 4 }, (_, i) => item(`C${i}`, "C"))];
    const r = allocate(items, 12);
    expect(r.kept.filter(i => i.category === "G")).toHaveLength(5);
    expect(r.trimmed.map(i => i.category)).toEqual(["S", "S", "S", "S", "S", "P", "P", "P"].slice(0, r.trimmed.length));
    expect(r.kept.reduce((n, i) => n + (i.kind === "P" ? 3 : 1), 0)).toBeLessThanOrEqual(12);
    expect(allocate(items, 1000).trimmed).toEqual([]);
  });
  it("adjudicates every UA cluster: beyond the round ceiling clusters are deferred to round 2, then left open, never dropped (addendum 3)", () => {
    const ua = Array.from({ length: 400 }, (_, i) => item(`O-T0${i % 4}-${i}`, "O", "O", `T0${i % 4}`)), rest = Array.from({ length: 30 }, (_, i) => item(`C${i}`, "C"));
    const r1 = planRoundOne([...rest, ...ua]), w = (xs: Item[]) => xs.reduce((n, i) => n + (i.kind === "O" || i.kind === "P" ? 3 : 1), 0);
    expect(r1.items.filter(i => i.kind === "O").length + r1.deferred.length).toBe(400);
    expect(r1.items.filter(i => i.kind === "C")).toHaveLength(30);
    expect(w(r1.items)).toBeLessThanOrEqual(ROUND_CAP);
    expect(new Set(r1.deferred.map(i => i.text)).size).toBe(4);
    const r2 = planRoundTwo([item("K-x", "K", "K"), item("G-x", "G")], r1.deferred, [item("S-x", "C")]);
    expect(r2.items.map(i => i.item).slice(0, 1)).toEqual(["G-x"]);
    expect(r2.items.filter(i => i.kind === "O").length + r2.unassessed.filter(i => i.kind === "O").length).toBe(r1.deferred.length);
    const big = planRoundTwo([], ua, [item("S-y", "C")]);
    expect(big.unassessed.length).toBeGreaterThan(0);
    expect(big.trimmedSecond.map(i => i.item)).toEqual(["S-y"]);
  });
  it("accepts only verbatim, schema-valid verdicts and keeps invalid ones unresolved", () => {
    const body = "The gate passes although a finished candidate was never checked.";
    const items: Item[] = [item("C-T01-k1", "C"), item("K-T01-K3.mechanism", "K", "K"), item("P-dev-r1-k9", "P", "P", undefined as any), item("O-T01-1", "O", "O")];
    const r = checkVerdicts(items, { items: [
      { item: "C-T01-k1", realization: "complete", stance: "asserted", quotes: [{ line: 1, quote: "a finished candidate was never checked" }], reason: "line 1 states it", resolved: true },
      { item: "K-T01-K3.mechanism", credit: 1, quotes: [{ line: 1, quote: "not in the text at all" }], reason: "x", resolved: true },
      { item: "P-dev-r1-k9", support: "supported", basis: "src/orchestrator/ultra.ts:455", reason: "line 455 shows it", resolved: true },
      { item: "O-T01-1", origin: "new", claims: [{ claim: "c", quote: "The gate passes although", stance: "asserted", support: "maybe", relevance: "finding", basis: "b" }], reason: "not in the ledger", resolved: true },
    ] }, new Map([["T01", body]]));
    expect([...r.valid.keys()].sort()).toEqual(["C-T01-k1", "P-dev-r1-k9"]);
    expect(r.errors.join(" ")).toMatch(/K-T01-K3.mechanism: quote 1 not found verbatim/);
    expect(r.errors.join(" ")).toMatch(/O-T01-1: claim 1: support/);
  });
  it("rejects verdicts that would close a gate without evidence (addendum 4)", () => {
    const body = "Alpha beta gamma delta. Later the text says epsilon zeta eta.";
    const items: Item[] = [item("X-T01-1", "X", "X"), item("Q-T01-1", "Q", "Q"), item("O-T01-1", "O", "O"), item("O-T01-2", "O", "O"), item("C-T01-k2", "C")];
    const r = checkVerdicts(items, { items: [
      { item: "X-T01-1", confirmed: true, quotes: [{ line: 1, quote: "Alpha beta gamma delta" }], reason: "contradiction", resolved: true },
      { item: "Q-T01-1", confirmed: false, resolved: true },
      { item: "O-T01-1", origin: "ledger", ledgerIds: ["k999"], reason: "from the ledger", resolved: true },
      { item: "O-T01-2", origin: "ledger_background", ledgerIds: ["k7"], reason: "from the k7 evidence field", resolved: true },
      { item: "C-T01-k2", realization: "complete", stance: "asserted", quotes: [{ line: 1, quote: "epsilon zeta eta" }], resolved: true },
    ] }, new Map([["T01", body]]), new Map([["T01", new Set(["k7", "k8"])]]));
    expect([...r.valid.keys()]).toEqual(["O-T01-2"]);
    const e = r.errors.join(" | ");
    expect(e).toMatch(/X-T01-1: a confirmed contradiction needs both passages quoted/);
    expect(e).toMatch(/Q-T01-1: reason required/);
    expect(e).toMatch(/O-T01-1: ledgerIds must be ids of the text's own ledger/);
    expect(e).toMatch(/C-T01-k2: reason required/);
  });
  it("never exceeds the packet ceiling or the worker count and returns what does not fit (addendum 4)", () => {
    const xs = Array.from({ length: 12 }, (_, t) => Array.from({ length: 26 }, (_, k) => item(`O-T${t}-${k}`, "O", "O", `T${t}`))).flat();
    const w = (b: Item[]) => b.reduce((n, i) => n + (i.kind === "O" || i.kind === "P" ? 3 : 1), 0), p = pack(xs);
    expect(p.bins.length).toBeLessThanOrEqual(8);
    expect(Math.max(...p.bins.map(w))).toBeLessThanOrEqual(PACKET_CAP);
    expect(p.bins.flat().length + p.overflow.length).toBe(312);
    expect(p.overflow).toEqual([]);
    const over = pack([...xs, ...Array.from({ length: 10 }, (_, k) => item(`O-T99-${k}`, "O", "O", "T99"))]);
    expect(Math.max(...over.bins.map(w))).toBeLessThanOrEqual(PACKET_CAP);
    expect(over.bins.flat().length + over.overflow.length).toBe(322);
    expect(over.overflow.length).toBeGreaterThanOrEqual(2);
  });
});
