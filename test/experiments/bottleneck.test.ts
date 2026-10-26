// Bottleneck isolation (results/bottleneck-isolation/protocol.md §3, §6, §7): the deterministic reference-aligned ledger R, the packet
// difference, the instrument validators, the stop rule and the frozen comparison design. No model is called; nothing is written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAP, DISPUTED, EXP1, PROTECTED, S_ANSWER, SELECT_JOBS, buildArms, chars, checkRubric, checkSelection, comparisons, composePromptBI, ledgerMarkdownBI, packetDiff, pairJobs, rDecision, refsOf, rubricPacket, shortenPrompt, signatureOf, stopReason, unitOf, type BRef } from "../../experiments/mdsd-ab/bottleneck.js";
import { C_COMPOSE, CONTRACT, COMMON, ledgerJson, ledgerOf } from "../../experiments/mdsd-ab/delivery.js";
import { requiredOf, type Ledger, type LedgerEntry } from "../../experiments/mdsd-ab/delivery-render.mjs";

const REPO = join(__dirname, "../..");
const entry = (id: string, decision: LedgerEntry["decision"], extra: Partial<LedgerEntry> = {}): LedgerEntry => {
  const e: LedgerEntry = { id, decision, required: "", statement: `statement ${id}`, sourceStance: "asserted", support: "supported", relevance: "finding", conditions: [`condition of ${id}`], note: decision === "include" || decision === "duplicate" ? "" : `Q reason ${id}`, duplicateOf: decision === "duplicate" ? "k1" : null, locations: [`f.ts:${id.slice(1)}`], quote: `quote ${id}`, evidence: `Q evidence ${id}`, taskLink: `Q task link ${id}`, ...extra };
  e.required = requiredOf(e);
  return e;
};
const ref = (id: string, support: string, relevance: string, extra: Partial<BRef> = {}): BRef => ({ id, support, relevance, salience: "essential", equivalentTo: [], ...extra });

describe("reference-aligned ledger R (protocol §3)", () => {
  it("applies the precedence: disputed, refuted (Q-correct kept), insufficient, out, ambiguous, relevant; duplicate only with both predicates", () => {
    const d = (decision: LedgerEntry["decision"], r: BRef, disputed: string[] = []) => rDecision({ id: r.id, decision }, r, disputed);
    expect(d("include", ref("k9", "refuted", "out"), ["k9"])).toEqual({ decision: "uncertain", rule: "disputed-reference" });
    expect(d("correct", ref("k2", "refuted", "finding"))).toEqual({ decision: "correct", rule: "refuted-kept-correct" });
    expect(d("include", ref("k2", "refuted", "finding"))).toEqual({ decision: "exclude", rule: "refuted" });
    expect(d("exclude", ref("k3", "insufficient", "out"))).toEqual({ decision: "uncertain", rule: "insufficient" });
    expect(d("include", ref("k3", "conflicting", "finding"))).toEqual({ decision: "uncertain", rule: "insufficient" });
    expect(d("include", ref("k4", "supported", "out"))).toEqual({ decision: "exclude", rule: "out" });
    expect(d("include", ref("k5", "supported", "ambiguous"))).toEqual({ decision: "uncertain", rule: "ambiguous" });
    expect(d("duplicate", ref("k6", "supported", "supporting", { equivalentTo: ["k1"] }))).toEqual({ decision: "duplicate", rule: "duplicate-kept" });
    expect(d("duplicate", ref("k6", "supported", "supporting"))).toEqual({ decision: "include", rule: "relevant" });
    expect(d("include", ref("k6", "supported", "supporting", { equivalentTo: ["k1"] }))).toEqual({ decision: "include", rule: "relevant" });
    expect(d("exclude", ref("k7", "supported", "requested_context"))).toEqual({ decision: "include", rule: "relevant" });
  });
  it("keeps the claim pool byte-identical, recomputes required delivery and replaces only the rationale of changed entries", () => {
    const base: Ledger = { ledger: "toy", entries: [entry("k1", "include"), entry("k2", "include", { support: "supported" }), entry("k3", "exclude", { relevance: "out" }), entry("k4", "duplicate"), entry("k5", "uncertain", { support: "insufficient" }), entry("k6", "include", { relevance: "supporting" })] };
    const refs = new Map<string, BRef>([ref("k1", "supported", "finding"), ref("k2", "insufficient", "finding"), ref("k3", "supported", "out"), ref("k4", "supported", "finding"), ref("k5", "supported", "finding"), ref("k6", "supported", "requested_context", { salience: "detail" })].map(r => [r.id, r]));
    const { A, R, rows } = buildArms(base, refs, []);
    expect(A.entries.map(e => e.id)).toEqual(base.entries.map(e => e.id));
    A.entries.forEach((a, i) => { const { priority, ...rest } = a; expect(priority).toBe("unassessed"); expect(rest).toEqual(base.entries[i]); });
    R.entries.forEach((r, i) => { for (const k of PROTECTED) expect(r[k]).toEqual(base.entries[i]![k]); expect(Object.keys(r)).toEqual(Object.keys(A.entries[i]!)); expect(r.required).toBe(requiredOf(r)); });
    const by = new Map(R.entries.map(e => [e.id, e]));
    // unchanged decision: Q rationale kept, labels and priority from b
    expect(by.get("k1")).toMatchObject({ decision: "include", note: "", evidence: "Q evidence k1", taskLink: "Q task link k1", priority: "essential" });
    expect(by.get("k3")).toMatchObject({ decision: "exclude", note: "Q reason k3", evidence: "Q evidence k3", taskLink: "Q task link k3" });
    // include → uncertain (support label differs): note and evidence templated, taskLink kept (same relevance)
    expect(by.get("k2")).toMatchObject({ decision: "uncertain", support: "insufficient", note: "Decision record: support for this statement is insufficient; it is not established as worded.", evidence: "Support label: insufficient (no further rationale recorded).", taskLink: "Q task link k2" });
    expect(by.get("k2")!.required).toMatch(/^Not established \(unverified\)/);
    // duplicate without a b equivalent → include, pointer dropped, empty note
    expect(by.get("k4")).toMatchObject({ decision: "include", duplicateOf: null, note: "", evidence: "Q evidence k4" });
    // uncertain → include with a different support label: evidence templated
    expect(by.get("k5")).toMatchObject({ decision: "include", note: "", evidence: "Support label: supported (no further rationale recorded)." });
    // unchanged decision with a different relevance label: rationale kept
    expect(by.get("k6")).toMatchObject({ decision: "include", relevance: "requested_context", taskLink: "Q task link k6", priority: "detail" });
    expect(rows.filter(r => r.changed).map(r => r.id)).toEqual(["k2", "k4", "k5"]);
    expect(() => buildArms(base, new Map([...refs].slice(1)), [])).toThrow(/reference ids/);
    expect(ledgerMarkdownBI(R)).toContain("- Source stance: asserted · Support: insufficient · Relevance: finding · Priority: essential");
    expect(ledgerMarkdownBI(R)).not.toMatch(/labeller|hidden|test\.patch/);
  });
  it("reproduces the plan's input properties on the three frozen ledgers (every k-id reconsidered; protected fields identical)", () => {
    const expected: Record<string, [number, number]> = { "dev-r1.Q-r2": [32, 12], "isort-r1.Q-r1": [38, 0], "isort-r1.Q-r2": [74, 16] };
    for (const l of EXP1) {
      const unit = unitOf(l), base = ledgerOf(l), { A, R, rows } = buildArms(base, refsOf(unit), DISPUTED[unit]!);
      const original = { "ledger.json": readFileSync(join(REPO, "results/delivery-validation/inputs", l, "ledger.json"), "utf8"), "ledger.md": readFileSync(join(REPO, "results/delivery-validation/inputs", l, "ledger.md"), "utf8") };
      const d = packetDiff(A, R, rows, { A: { "ledger.json": ledgerJson(A as Ledger), "ledger.md": ledgerMarkdownBI(A) }, R: { "ledger.json": ledgerJson(R as Ledger), "ledger.md": ledgerMarkdownBI(R) }, original });
      expect(rows.length).toBe(base.entries.length);
      expect([d.changed, d.changedEssential]).toEqual(expected[l]);
      expect(d.protectedFieldsIdentical && d.keyOrderIdentical).toBe(true);
      expect(d.duplicatesToNonApproved).toEqual([]);
      expect(R.entries.every(e => e.required === requiredOf(e))).toBe(true);
      for (const id of DISPUTED[unit]!) expect(R.entries.find(e => e.id === id)).toMatchObject({ decision: "uncertain", support: "conflicting" });
      if (l === "isort-r1.Q-r2") expect(d.transitions["duplicate->include"]).toBe(40);
      if (unit === "isort-r1") expect(d.decisions.R).toEqual({ include: 300, uncertain: 14, duplicate: 5, exclude: 14, correct: 1 });
    }
  });
});

describe("length cap, prompts and validators (protocol §4, §7)", () => {
  it("uses the stored S answer's code points as the cap and changes the compose prompt by exactly one sentence", () => {
    for (const [unit, cap] of Object.entries(CAP)) expect(chars(readFileSync(S_ANSWER(unit), "utf8"))).toBe(cap);
    const p = composePromptBI(43700);
    expect(p.startsWith([COMMON, C_COMPOSE].join("\n\n"))).toBe(true);
    expect(p.endsWith(CONTRACT)).toBe(true);
    expect(p.replace([COMMON, C_COMPOSE, ""].join("\n\n"), "").replace(`\n\n${CONTRACT}`, "")).toBe("Length limit: final.md must be at most 43700 characters long (Unicode characters, counting spaces, line breaks and Markdown syntax).");
    expect(shortenPrompt(50000, 43700)).toContain("has 50000 characters, more than the length limit of 43700 characters. Shorten it to at most 43700 characters");
    expect(chars("é😀")).toBe(2);
  });
  it("validates rubric judgments and id-only selections", () => {
    const body = "line one says the mean divides by zero for an empty list\nline two";
    const ok = { criteria: [{ id: "T1.mechanism", credit: 1, quotes: [{ line: 1, quote: "the mean divides by zero" }] }, { id: "T1.scenario", credit: 0, quotes: [] }], contradictions: [] };
    expect(checkRubric(["T1.mechanism", "T1.scenario"], ok, body)).toEqual([]);
    expect(checkRubric(["T1.mechanism", "T1.scenario"], { ...ok, criteria: [ok.criteria[0]] }, body).join(" ")).toMatch(/without an item: T1.scenario/);
    expect(checkRubric(["T1.mechanism", "T1.scenario"], { ...ok, criteria: [{ id: "T1.mechanism", credit: 1, quotes: [] }, ok.criteria[1]] }, body).join(" ")).toMatch(/needs at least one verbatim quote/);
    expect(checkRubric(["T1.mechanism", "T1.scenario"], { ...ok, contradictions: [{ criterion: "K9", quote: "the mean divides by zero" }] }, body).join(" ")).toMatch(/must name a rubric item/);
    expect(checkSelection('{"candidate_id":"candidate-2"}')).toEqual([]);
    expect(checkSelection('{"candidate_id":"candidate-3"}')).not.toEqual([]);
    expect(checkSelection('{"candidate_id":"candidate-1","why":"x"}')).not.toEqual([]);
    expect(checkSelection("candidate-1")).not.toEqual([]);
  });
  it("freezes the rubric criteria per case", () => {
    expect(rubricPacket("dev-r1").criteria).toHaveLength(12);
    expect(rubricPacket("isort-r2").criteria).toEqual(["K-I1.mechanism", "K-I1.location", "K-I1.scenario", "C1", "C2", "C3", "C4", "C5"]);
    expect(rubricPacket("isort-r1").body).toContain("C4 | When the import fits on one line");
    expect(rubricPacket("dev-r1").body).not.toContain("## Additional findings");
  });
});

describe("stop rule and comparison design (protocol §6, §7, §10)", () => {
  it("stops after three identical error signatures or more than 25% technical failures", () => {
    const fail = (f: string) => ({ outcome: "technical", signature: signatureOf(f) });
    expect(signatureOf("compose: final stop error: 503 at /tmp/x/y")).toBe(signatureOf("compose: final stop error: 502 at /tmp/z"));
    expect(stopReason([fail("audit: final stop error: 503"), fail("audit: final stop error: 503"), { outcome: "complete" }, { outcome: "complete" }, { outcome: "complete" }, { outcome: "complete" }, { outcome: "complete" }, { outcome: "complete" }, { outcome: "complete" }])).toBeUndefined();
    expect(stopReason([fail("audit: final stop error: 503"), fail("audit: final stop error: 503"), fail("audit: final stop error: 504")])).toMatch(/identical technical error signature 3 times/);
    expect(stopReason([fail("a: x"), fail("b: y"), { outcome: "complete" }, { outcome: "complete" }, {}])).toMatch(/exceed 25%/);
    expect(stopReason([fail("a: x"), {}, {}])).toBeUndefined();
  });
  it("judges every comparison by both families in both orders and runs the selector in two orders × two repetitions per pool", () => {
    const jobs = pairJobs(), cs = comparisons();
    expect(cs).toHaveLength(27);
    expect(jobs).toHaveLength(cs.length * 4);
    for (const c of cs) {
      const mine = jobs.filter(j => j.comparison.id === c.id);
      expect(mine.map(j => `${j.fam}.${j.order}`).sort()).toEqual(["claude.1", "claude.2", "gpt.1", "gpt.2"]);
      for (const j of mine) expect(j.order === 1 ? [j.X, j.Y] : [j.Y, j.X]).toEqual([c.P, c.Q]);
    }
    expect(cs.filter(c => c.kind === "A-R")).toHaveLength(6);
    expect(cs.filter(c => c.kind === "vs-S")).toHaveLength(12);
    expect(SELECT_JOBS).toHaveLength(12);
    for (const u of ["dev-r1", "isort-r1", "isort-r2"]) expect(SELECT_JOBS.filter(j => j.unit === u).map(j => j.candidates.join(""))).toEqual(["SE", "SE", "ES", "ES"]);
  });
});
