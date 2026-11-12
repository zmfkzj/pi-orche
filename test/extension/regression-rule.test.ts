import { describe, expect, it } from "vitest";
import { assignmentPrompt } from "../../src/extension/workers.js";
import { REGRESSION_RULE, REGRESSION_TOOL } from "../../src/tools/regression-check.js";

describe("regression_check rule in assignment prompts", () => {
  it("tells single/strong implement workers to compare existing tests with the starting state, keeping acceptance theirs", () => {
    for (const mode of ["single", "strong"] as const) {
      const prompt = assignmentPrompt({ role: "implement", request: "R1: fix it", mainMode: mode, orchestrate: true }, []);
      expect(prompt).toContain(REGRESSION_RULE);
      expect(prompt).toContain("you own acceptance");
    }
    expect(REGRESSION_RULE).toContain(REGRESSION_TOOL);
    expect(REGRESSION_RULE).toMatch(/pre-existing failures are not yours/);
    expect(REGRESSION_RULE).toMatch(/evidence, not acceptance/);
  });

  it("is absent for ultra/mdsd orchestrators, read-only roles and library implement prompts", () => {
    expect(assignmentPrompt({ role: "implement", request: "x", mainMode: "ultra", orchestrate: true }, [])).not.toContain(REGRESSION_RULE);
    expect(assignmentPrompt({ role: "implement", request: "x", mainMode: "mdsd", orchestrate: true }, [])).not.toContain(REGRESSION_RULE);
    expect(assignmentPrompt({ role: "answer", request: "x", mainMode: "single", orchestrate: true }, [])).not.toContain(REGRESSION_RULE);
    expect(assignmentPrompt({ role: "implement", request: "x" }, [])).not.toContain(REGRESSION_RULE);
  });
});
