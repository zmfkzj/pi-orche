import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { delegationRules } from "../../src/extension/mode.js";
import { assignmentPrompt } from "../../src/extension/workers.js";

// Stage evaluation 2026-11-12 (docs/stage-eval.md): only #2 (image batching) and #6 (test output reduction) were kept.
// #5 (regression_check against the starting state) and #7 (early ambiguity / acceptance-criteria rule) were removed;
// the requirement-ambiguity contract and worker-owned acceptance that existed before the evaluation stay.
describe("removed stage-eval changes #5 and #7", () => {
  it("ships no regression_check tool or rule", () => {
    expect(existsSync(new URL("../../src/tools/regression-check.ts", import.meta.url))).toBe(false);
    for (const mode of ["single", "strong", "ultra", "mdsd"] as const) {
      const prompt = assignmentPrompt({ role: "implement", request: "R1: x", mainMode: mode, orchestrate: true }, []);
      expect(prompt).not.toContain("regression_check");
      expect(prompt).not.toContain("Regression check:");
    }
  });

  it("drops the acceptance-first rule but keeps the earlier ambiguity contract and worker-owned acceptance", () => {
    for (const mode of ["single", "strong"] as const) {
      const prompt = assignmentPrompt({ role: "implement", request: "R1: x", mainMode: mode, orchestrate: true }, []);
      expect(prompt).not.toContain("Acceptance first");
      expect(prompt).not.toContain("material ambiguity");
      expect(prompt).toContain("If a requirement can be read more than one way with observably different behaviour, settle it from the Original request text");
      expect(prompt).toContain("report it in data.ambiguities");
      expect(prompt).toContain("only the user can decide also goes in data.unresolved");
      expect(prompt).toContain("you own acceptance");
      expect(prompt.indexOf("covering every requirement id.")).toBeLessThan(prompt.indexOf("Then execute nodes sequentially"));
    }
  });

  it("drops the main-side material-ambiguity hand-off rule but keeps requirement refinement", () => {
    for (const mode of ["single", "strong"] as const) {
      const rules = delegationRules(mode);
      expect(rules).not.toContain("material ambiguit");
      expect(rules).toContain("Single workflow: refine the requirements with the user: goal, constraints and acceptance criteria.");
      expect(rules).toContain("Assumptions (explicit when there is no UI);");
    }
  });
});
