import { describe, expect, it } from "vitest";
import { asksForReview, assessRisk, formatRisk, isDocFile, isTestFile } from "../../src/single/risk.js";

const auto = { threshold: 5, gate: "auto" as const };
const diff = (path: string, lines: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...lines].join("\n");
const met = (id: string, verifiedBy?: string) => ({ id, status: "met" as const, evidence: "x", ...(verifiedBy ? { verifiedBy } : {}) });

describe("risk score", () => {
  it("classifies test and doc files", () => {
    for (const path of ["test/a.test.mjs", "src/__tests__/x.ts", "pkg/foo_test.go", "tests/test_x.py", "a.spec.tsx", "conftest.py"]) expect(isTestFile(path)).toBe(true);
    for (const path of ["src/test-utils-impl.ts", "src/contest.ts", "src/a.mjs"]) expect(isTestFile(path)).toBe(false);
    for (const path of ["README.md", "docs/guide.txt", "CHANGELOG"]) expect(isDocFile(path)).toBe(true);
    expect(isDocFile("test/fixtures/a.md")).toBe(false);
  });

  it("adds the documented signals", () => {
    const risk = assessRisk({
      files: [{ path: "src/a.mjs", added: 100, removed: 60 }, { path: "lib/b.mjs", added: 2, removed: 0 }, { path: "lib/c.mjs", added: 1, removed: 1 }],
      diff: [diff("src/a.mjs", ["+await db.transaction(async tx => {", "+  const lock = new Mutex();"]), diff("test/a.test.mjs", ["+escape(x)"])].join("\n"),
      checklist: [met("R1"), met("R2", "node --test"), { id: "R3", status: "partial", evidence: "x" }],
      requirements: [{ id: "R1", kind: "explicit" }, { id: "R2", kind: "edge" }, { id: "R3", kind: "edge" }, { id: "R4", kind: "edge" }],
      recommendedReadings: 3,
    }, auto);
    expect(risk.signals.map(signal => [signal.name, signal.points])).toEqual([
      ["files", 2], ["top-level directories", 2], ["concurrency", 2], ["transactions/persistence", 2], ["source changed without test changes", 2],
      ["met without verifiedBy", 2], ["edge cases without a passing test", 2], ["ambiguities settled by recommendation", 2], ["lines changed", 2],
    ]);
    expect(risk).toMatchObject({ score: 18, decision: "verify", reason: "threshold" });
    // Domain patterns read changed source lines only: the test file's escape() is not a parsing signal.
    expect(risk.signals.some(signal => signal.name === "parsing/encoding")).toBe(false);
  });

  it("caps domains at two and edge cases at three", () => {
    const risk = assessRisk({
      files: [{ path: "src/a.ts", added: 3, removed: 0 }, { path: "test/a.test.ts", added: 3, removed: 0 }],
      diff: diff("src/a.ts", ["+const hash = crypto.createHmac(password)", "+const price = Math.round(amount)", "+const cache = new Map()", "+JSON.parse(text)"]),
      requirements: ["R1", "R2", "R3", "R4", "R5"].map(id => ({ id, kind: "edge" })),
    }, auto);
    expect(risk.signals.filter(signal => !["edge cases without a passing test"].includes(signal.name)).map(signal => signal.name)).toEqual(["auth/security", "money/rounding"]);
    expect(risk.signals.find(signal => signal.name === "edge cases without a passing test")?.points).toBe(3);
  });

  it("forces, skips and gates", () => {
    const small = { files: [{ path: "src/a.ts", added: 2, removed: 1 }], diff: "", checklist: [met("R1", "npm test")] };
    expect(assessRisk(small, auto)).toMatchObject({ decision: "skip", reason: "skipped: small verified change" });
    expect(assessRisk({ ...small, original: "고치고 검토해줘" }, auto)).toMatchObject({ decision: "verify", reason: "forced: review requested" });
    expect(assessRisk(small, { ...auto, gate: "always" })).toMatchObject({ decision: "verify", reason: "forced: gate always" });
    expect(assessRisk({ files: [{ path: "README.md", added: 400, removed: 0 }], diff: "" }, auto)).toMatchObject({ decision: "skip", reason: "skipped: docs only" });
    expect(assessRisk({ files: [], diff: "" }, auto)).toMatchObject({ decision: "skip", reason: "skipped: no changes" });
    expect(assessRisk({ files: [{ path: "src/a.ts", added: 400, removed: 0 }], diff: "" }, { ...auto, gate: "off" })).toMatchObject({ decision: "skip", reason: "gate off" });
    expect(assessRisk({ files: [{ path: "src/a.ts", added: 20, removed: 0 }], diff: "" }, auto)).toMatchObject({ score: 2, decision: "skip", reason: "below threshold" });
    expect(asksForReview("please review the change")).toBe(true);
    expect(asksForReview("add a preview pane")).toBe(false);
  });

  it("formats the score with its reason and signals", () => {
    expect(formatRisk(assessRisk({ files: [{ path: "src/a.ts", added: 20, removed: 0 }], diff: "" }, auto))).toBe("Risk 2 < 5 → no verification (source changed without test changes +2)");
    expect(formatRisk(assessRisk({ files: [], diff: "" }, { ...auto, gate: "always" }))).toBe("Risk 0; forced: gate always → verify (no signals)");
  });
});
