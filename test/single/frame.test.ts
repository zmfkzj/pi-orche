import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { checkFrame, CONTRACT_HEADER, formatFrame, framedRequest, framerPrompt, frameSchema, renderContract, type Frame } from "../../src/single/frame.js";
import { requirementDefinitions, requirementIds } from "../../src/orchestration/result-schemas.js";
import { originalRequestOf } from "../../src/single/ledger.js";

const frame: Frame = {
  goal: "Retry failed deliveries",
  requirements: [
    { id: "R1", kind: "explicit", text: "A rejected send releases the event for retry", acceptance: "send rejects → event pending again", quote: "rejection releases for retry" },
    { id: "R2", kind: "implied", text: "node --test stays green", acceptance: "node --test exits 0" },
    { id: "R3", kind: "edge", text: "Fail then succeed counts both claims", acceptance: "fail, succeed → attempts 2" },
  ],
  ambiguities: [{ id: "A1", quote: "increments attempts once per claim", readings: ["every claim counts", "only failed claims count"], observableDifference: "fail then succeed: 2 vs 1", recommended: 1, why: "the claim step owns the counter in event-repository.mjs:40", askUser: false, affects: ["R3"] }],
  invariants: ["exported interfaces of src/index.mjs"],
  locations: [{ path: "src/dispatcher.mjs:12", why: "claim loop" }],
};
const request = "Intent/Purpose: retries.\nOriginal request\nMake retries work.";

describe("Framer contract", () => {
  it("validates against the schema and the request's own ids", () => {
    expect(Value.Check(frameSchema, frame)).toBe(true);
    expect(checkFrame(frame, request)).toBeUndefined();
    expect(checkFrame(frame, "R4: keep this\nOriginal request\nx")).toBe("The request defines R4; keep each of them as a requirement with the same id.");
    expect(checkFrame({ ...frame, requirements: [...frame.requirements, frame.requirements[0]!] }, request)).toBe("Duplicate requirement id R1.");
    expect(checkFrame({ ...frame, ambiguities: [{ ...frame.ambiguities[0]!, recommended: 3 }] }, request)).toBe("A1: recommended 3 but only 2 readings.");
    expect(checkFrame({ ...frame, ambiguities: [{ ...frame.ambiguities[0]!, affects: ["R9"] }] }, request)).toBe("A1: affects unknown requirement ids R9.");
  });

  it("renders requirement lines the checklist machinery reads, before the verbatim request", () => {
    const contract = renderContract(frame);
    expect(contract.startsWith(CONTRACT_HEADER)).toBe(true);
    const handoff = framedRequest(contract, `${request}\nR9: quoted text after the original is not a requirement`);
    expect(requirementIds(handoff)).toEqual(["R1", "R2", "R3"]);
    expect(requirementDefinitions(handoff).get("R3")).toBe("[edge] Fail then succeed counts both claims\nAcceptance: fail, succeed → attempts 2");
    expect(contract).toContain('- A1 "increments attempts once per claim": chosen "every claim counts" over "only failed claims count". Differs when: fail then succeed: 2 vs 1.');
    expect(originalRequestOf(handoff)).toBe("Make retries work.\nR9: quoted text after the original is not a requirement");
  });

  it("drops locations, then invariants, to fit; requirements stay", () => {
    const big: Frame = { ...frame, locations: Array.from({ length: 12 }, (_, index) => ({ path: `src/file-${index}.mjs`, why: "x".repeat(250) })), invariants: Array.from({ length: 8 }, () => "y".repeat(280)) };
    const contract = renderContract(big, { maxChars: 2_000 });
    expect(contract.length).toBeLessThanOrEqual(2_000);
    expect(contract).toContain("R3: [edge]");
    expect(contract).not.toContain("Where to look:");
  });

  it("asks a follow-up to carry earlier ids over, and keeps the request's ids", () => {
    const prompt = framerPrompt({ request: "R1: keep\nOriginal request\nx", grounded: false, previous: { contract: "Task ledger T1 …", outcome: "done: ok" } });
    expect(prompt).toContain("Keep the request's own ids R1 with the same meaning");
    expect(prompt).toContain("Carry over the earlier requirements that still apply with their ids");
    expect(prompt).toContain("locations: omit (you have no repository access).");
  });

  it("summarizes for the main session", () => {
    expect(formatFrame(frame)).toEqual([
      "Frame: 3 requirements (1 explicit, 1 implied, 1 edge), 1 ambiguity settled by the recommended reading.",
      '- A1 "increments attempts once per claim": chose "every claim counts" over "only failed claims count"',
    ]);
    expect(formatFrame({ ...frame, ambiguities: [{ ...frame.ambiguities[0]!, askUser: true }] })[1]).toContain("— needs the user's decision");
  });
});
