import { describe, expect, it } from "vitest";
import { delegationRules } from "../../src/extension/mode.js";
import { AMBIGUITY_RULE, assignmentPrompt } from "../../src/extension/workers.js";

// Change #7: testable acceptance criteria and material ambiguities before implementation; asking the user only when necessary;
// a clarification policy in the request (unattended benchmark) takes precedence.
describe("early ambiguity and acceptance rule", () => {
  it("puts acceptance criteria and ambiguities into the first plan of every workflow implement worker, before any edit", () => {
    for (const mode of ["single", "strong", "ultra", "mdsd"] as const) {
      const prompt = assignmentPrompt({ role: "implement", request: "R1: x", mainMode: mode, orchestrate: true }, []);
      expect(prompt).toContain(AMBIGUITY_RULE);
      expect(prompt.indexOf(AMBIGUITY_RULE)).toBeLessThan(prompt.indexOf("Then execute nodes sequentially"));
    }
    expect(AMBIGUITY_RULE).toMatch(/^Acceptance first: before any edit, write for each requirement a testable acceptance criterion/);
    expect(AMBIGUITY_RULE).toContain("task_plan node note");
    expect(assignmentPrompt({ role: "implement", request: "x" }, [])).not.toContain(AMBIGUITY_RULE);
  });

  it("keeps the existing ambiguity reporting contract and worker-owned acceptance", () => {
    const prompt = assignmentPrompt({ role: "implement", request: "R1: x", mainMode: "single", orchestrate: true }, []);
    expect(AMBIGUITY_RULE).toContain("report it in data.ambiguities");
    expect(AMBIGUITY_RULE).toContain("only the user can decide also goes in data.unresolved");
    expect(prompt).toContain("you own acceptance");
  });

  it("asks only for an expensive unsettled ambiguity, never under a stated clarification policy", () => {
    expect(AMBIGUITY_RULE).toMatch(/Only when such an unsettled ambiguity decides most of the work or a hard-to-undo change .*and the request states no clarification policy, stop before that part/);
    expect(AMBIGUITY_RULE).toMatch(/complete what does not depend on it, then report status blocked with the question, its readings and your recommended reading in data\.unresolved/);
    expect(AMBIGUITY_RULE).toContain("Otherwise never stop for a question: proceed with the closest reading.");
    expect(AMBIGUITY_RULE).toMatch(/clarification policy in the request \(for example that nobody can answer questions during the run\) takes precedence/);
  });

  it("has main name material ambiguities before the hand-off and batch any question with a recommended reading", () => {
    for (const mode of ["single", "strong"] as const) {
      const rules = delegationRules(mode);
      expect(rules).toContain("Before the hand-off, name the material ambiguities");
      expect(rules).toContain("in one batched question with your recommended reading for each, only when a wrong reading would waste most of the work or make a hard-to-undo change");
      expect(rules).toContain("Assumptions (explicit when there is no UI, including the reading chosen for each material ambiguity)");
    }
    expect(delegationRules("direct")).not.toContain("material ambiguities");
  });
});
