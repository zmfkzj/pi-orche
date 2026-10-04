import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { answerResultSchema, checklistSchema, implementResultSchema, orchestrationResultSchemas, requirementIds, requiredChecklistError } from "../../src/orchestration/result-schemas.js";

describe.each(["game-asset", "video"])("%s result schema", kind => {
  const contract = orchestrationResultSchemas[kind]!;
  const output = { path: "assets/deliverable.svg", type: "image/svg+xml", spec: "32x32 SVG icon" };

  it("accepts complete and blocked reports", () => {
    expect(contract.optional).not.toBe(true);
    expect(Value.Check(contract.schema, { status: "done", outputs: [output], evidence: ["validated output"] })).toBe(true);
    expect(Value.Check(contract.schema, { status: "blocked", reason: "ffmpeg unavailable", outputs: [], evidence: ["command -v ffmpeg: not found"] })).toBe(true);
  });

  it.each([
    undefined,
    {},
    { status: "done" },
    { outputs: [] },
    { status: "unknown", outputs: [] },
    { status: "done", reason: 42, outputs: [] },
    { status: "done", outputs: "asset.png" },
    { status: "done", outputs: [{ path: "asset.png", type: "image/png" }] },
    { status: "done", outputs: [{ ...output, path: "" }] },
    { status: "done", outputs: [{ ...output, type: 42 }] },
    { status: "done", outputs: [{ ...output, spec: {} }] },
  ])("rejects malformed data %j", data => {
    expect(Value.Check(contract.schema, data)).toBe(false);
  });
});

describe("implement/answer checklist contract", () => {
  const checklist = [{ id: "R1", status: "met", evidence: "test: passed" }];
  it.each([implementResultSchema, answerResultSchema])("accepts optional and valid checklists", schema => {
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { checklist })).toBe(true);
  });
  it.each([
    [{ id: "R1", status: "unknown", evidence: "x" }],
    [{ id: "R0", status: "met", evidence: "x" }],
    [{ id: "R2", status: "met", evidence: "" }],
    [{ id: "R2", status: "unmet" }],
    "R1",
  ].map(value => [value]))("rejects malformed checklist %j", value => expect(Value.Check(checklistSchema, value)).toBe(false));
  it("requires verifiedBy for met implement items only when verification is requested", () => {
    expect(requiredChecklistError(["R1"], { checklist })).toBeUndefined();
    expect(requiredChecklistError(["R1"], { checklist }, true)).toContain("reported met without verifiedBy: R1");
    expect(requiredChecklistError(["R1"], { checklist: [{ ...checklist[0], verifiedBy: "node --test test/a.test.mjs" }] }, true)).toBeUndefined();
    expect(requiredChecklistError(["R1"], { checklist: [{ id: "R1", status: "partial", evidence: "no test yet" }] }, true)).toBeUndefined();
  });
  it("validates reported ambiguities", () => {
    const verified = [{ ...checklist[0], verifiedBy: "node --test" }];
    expect(requiredChecklistError(["R1"], { checklist: verified, ambiguities: [{ id: "R1", readings: ["count every claim", "count failures"], chosen: "count every claim" }] }, true)).toBeUndefined();
    expect(requiredChecklistError(["R1"], { checklist: verified, ambiguities: [{ id: "R1", readings: ["only one"], chosen: "only one" }] }, true)).toContain("Invalid ambiguities");
    expect(Value.Check(implementResultSchema, { checklist: verified, ambiguities: [{ readings: ["a", "b"], chosen: "a" }] })).toBe(true);
  });
  it("requires complete unique coverage only when requested, with actionable errors", () => {
    expect(requiredChecklistError(["R1"], undefined)).toContain("required");
    expect(requiredChecklistError(["R1", "R2"], { checklist })).toContain("missing R2");
    expect(requiredChecklistError(["R1"], { checklist: [...checklist, ...checklist] })).toContain("Duplicate");
    expect(requiredChecklistError(["R1"], { checklist })).toBeUndefined();
    expect(requiredChecklistError(["R1"], { checklist: [null] })).toContain("Invalid checklist");
    expect(requirementIds("R1: accepted\nR2: accepted\nOriginal request\nThe user's R99 reference")).toEqual(["R1", "R2"]);
    expect(requirementIds("R4: remaining\n## **Original request**: the earlier R1, R2, R3")).toEqual(["R4"]);
    expect(requirementIds("Legacy request without requirement ids")).toEqual([]);
    expect(orchestrationResultSchemas.answer).toEqual({ schema: answerResultSchema, optional: true });
  });
});

describe("requirement declaration detection (verifier ids repro)", () => {
  it.each([
    ["R2D2 prose", "Fix the R2D2 robot sprite", []],
    ["R1 prose", "Please follow the R1 spec doc and fix", []],
    ["R1 path", "Update docs/R1.md", []],
    ["R-dash", "R-1 requirement", []],
    ["R10 single line", "R10: x R2: y", ["R10"]],
    ["inline original prose", "R1: a\nthe Original request: R9 is dropped", ["R1"]],
    ["plain original header", "R1: a\nOriginal request\nR7: original", ["R1"]],
    ["parenthetical header", "R1: a\nOriginal request (verbatim):\nR7: original", ["R1"]],
    ["bold header", "R1: a\n**Original request:**\nR7: original", ["R1"]],
    ["Markdown header", "R1: a\n## Original request\nR7: original", ["R1"]],
    ["user header", "R1: a\n## Original user request\nR7: original", ["R1"]],
    ["mixed case header", "R1: a\n### oRiGiNaL UsEr ReQuEsT (verbatim):\nR7: original", ["R1"]],
    ["no requirements", "Intent\nOriginal request\nR7: original", []],
    ["accepted delimiters", "R1: colon\nR2. dot\nR3) paren\nR4 - dash\n R5: indented", ["R1", "R2", "R3", "R4", "R5"]],
    ["prose without delimiter", "R1 is prose\nR2D2\ndocs/R3.md", []],
  ])("%s", (_name, request, expected) => expect(requirementIds(request)).toEqual(expected));
});
