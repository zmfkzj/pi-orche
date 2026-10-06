import { describe, expect, it } from "vitest";
import { errorToolResult, failureReason } from "../../src/extension/tool-result.js";

describe("error result builder", () => {

  it("errorToolResult marks the result as an error, keeps the text and adds the failure to a copy of the details", () => {
    const details = { model: "p/m", requests: 2 };
    const failure = { kind: "blocked" as const, status: "blocked", reason: "needs input" };
    const result = errorToolResult("the text", details, failure);
    expect(result).toEqual({ content: [{ type: "text", text: "the text" }], details: { model: "p/m", requests: 2, failure }, isError: true });
    expect(details).toEqual({ model: "p/m", requests: 2 });
  });

  it("failureReason takes the first non-empty line, collapses whitespace and bounds the length", () => {
    expect(failureReason("\n\n  first   line \nsecond")).toBe("first line");
    expect(failureReason("x".repeat(500)).length).toBe(300);
    expect(failureReason("x".repeat(500)).endsWith("…")).toBe(true);
    expect(failureReason("")).toBe("");
  });



});
