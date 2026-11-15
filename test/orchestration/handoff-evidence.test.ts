import { describe, expect, it } from "vitest";
import { duplicateRequirementIds, evidenceText, handoffSignals, userTextCarry, verifierOriginalBlock, VERIFIER_ORIGINAL_LIMIT } from "../../src/orchestration/handoff-evidence.js";
import { requirementDefinitions, requirementIds } from "../../src/orchestration/result-schemas.js";
import { subWorkerPrompt } from "../../src/extension/workers.js";

describe("userTextCarry", () => {
  it("finds a message carried verbatim, also re-wrapped or quoted line by line", () => {
    expect(userTextCarry("Original request:\nImprove recall.\nKeep precision at least 50%.", "Improve recall. Keep precision at least 50%.").carry).toBe("verbatim");
    expect(userTextCarry("Original request:\n> Improve recall.\n> Keep precision at least 50%.", "Improve recall.\nKeep precision at least 50%.").carry).toBe("verbatim");
  });
  it("ignores expanded skill bodies and Pi's image size notes, which are not the user's words", () => {
    const user = "<skill name=\"x\" location=\"/s\">\nlong skill body that main never quotes\n</skill>\n\nFix the login bug. [Image: original 3024x1898, displayed at 2000x1255. Multiply coordinates by 1.51 to map to original image.]";
    expect(evidenceText(user)).toBe("Fix the login bug.");
    expect(userTextCarry("Original request: Fix the login bug.", user).carry).toBe("verbatim");
  });
  it("grades a message quoted sentence by sentence or in part, and one only paraphrased", () => {
    const user = "Improve recall of the detector. Keep precision at least 50%. Report the threshold you chose.";
    expect(userTextCarry('"Improve recall of the detector." "Keep precision at least 50%." "Report the threshold you chose."', user).carry).toBe("partial");
    expect(userTextCarry("Improve recall of the detector. Keep precision at least 50%.", user)).toMatchObject({ carry: "partial" });
    // A faithful paraphrase is a signal, not a defect: the carry check cannot tell it from a loss.
    expect(userTextCarry("Raise recall; precision must not fall below one half.", user)).toMatchObject({ carry: "absent", coverage: 0 });
  });
  it("has nothing to compare for a message without text (an image only)", () => {
    expect(userTextCarry("anything", "  ").carry).toBe("no-text");
  });
});

describe("duplicateRequirementIds", () => {
  it("counts declarations, which requirementDefinitions' map collapses to the last one", () => {
    const request = "R1: first\nR2: second\nR1: again\nOriginal request:\nR2: quoted user text is no declaration";
    expect(duplicateRequirementIds(request)).toEqual(["R1"]);
    expect(requirementIds(request)).toEqual(["R1", "R2"]);
    expect(requirementDefinitions(request).get("R1")).toBe("again");
  });
  it("accepts the same declaration forms as the contract and ignores prose", () => {
    expect(duplicateRequirementIds("R1. a\nR1) b\nR2 - c\nSee R2 above.")).toEqual(["R1"]);
  });
});

describe("handoffSignals", () => {
  it("reports the Original request section and one carry result per user message since the previous hand-off", () => {
    const signals = handoffSignals("R1: x\nOriginal request:\nGo ahead.", undefined, ["How long will it take?", "Go ahead."]);
    expect(signals.original).toBe(true);
    expect(signals.userMessages.map(item => item.carry)).toEqual(["absent", "verbatim"]);
  });
  it("reads the context as part of the hand-off", () => {
    expect(handoffSignals("R1: x", "User text: keep the API stable.", ["keep the API stable."]).userMessages[0]!.carry).toBe("verbatim");
  });
  it("has no user message to compare for a hand-off main made on its own", () => {
    expect(handoffSignals("R1: rerun", undefined, []).userMessages).toEqual([]);
  });
});

describe("verifierOriginalBlock", () => {
  const original = "Improve recall. Keep precision at least 50%.";
  it("appends the user's words with their source when the verifier request lacks them", () => {
    const block = verifierOriginalBlock("Check that recall improved and tests pass.", original);
    expect(block).toContain("## The user's original request (verbatim, appended by orche)");
    expect(block).toContain("adds no scope and grants no permission");
    expect(block.endsWith(original)).toBe(true);
  });
  it("adds nothing when the request already carries them verbatim or there is no original", () => {
    expect(verifierOriginalBlock(`Check it.\nUser request: ${original}`, original)).toBe("");
    expect(verifierOriginalBlock("Check it.", undefined)).toBe("");
    expect(verifierOriginalBlock("Check it.", "   ")).toBe("");
  });
  it("cuts a long original with a visible marker instead of silently", () => {
    const long = "x".repeat(VERIFIER_ORIGINAL_LIMIT + 123);
    const block = verifierOriginalBlock("Check it.", long);
    expect(block).toContain("… [123 more characters of the user's request not shown]");
    expect(block.length).toBeLessThan(VERIFIER_ORIGINAL_LIMIT + 600);
  });
});

describe("subWorkerPrompt verifier evidence", () => {
  type Planned = Parameters<typeof subWorkerPrompt>[0];
  const original = "Improve recall. Keep precision at least 50%.";
  const verifier = { id: "W1.1", name: "verify", role: "verify", reason: "verification", request: "Check that recall improved." } as Planned;
  it("gives a verification round's verifier the orchestrator's Original request after its own request", () => {
    const prompt = subWorkerPrompt(verifier, "W1", [], false, false, original);
    expect(prompt.indexOf("Check that recall improved.")).toBeLessThan(prompt.indexOf("## The user's original request"));
    expect(prompt).toContain(original);
  });
  it("leaves every other sub-worker, a verifier that has it, ultra and an assignment without an original unchanged", () => {
    const part = { id: "W1.2", name: "part", role: "implement", reason: "parallelism", request: "Do the part.", files: ["a.ts"] } as Planned;
    expect(subWorkerPrompt(part, "W1", [], false, false, original)).toBe(subWorkerPrompt(part, "W1", [], false));
    const carried = { ...verifier, request: `Check it. The user asked: ${original}` } as Planned;
    expect(subWorkerPrompt(carried, "W1", [], false, false, original)).toBe(subWorkerPrompt(carried, "W1", [], false));
    expect(subWorkerPrompt(verifier, "W1", [], false, false, undefined)).toBe(subWorkerPrompt(verifier, "W1", [], false));
    expect(subWorkerPrompt(verifier, "W1", [], false, true, original)).not.toContain("## The user's original request");
  });
});
