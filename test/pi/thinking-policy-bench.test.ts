import { describe, expect, it } from "vitest";
import { runMatrix } from "../../experiments/thinking-policy/bench.js";

/**
 * The thinking-policy comparison harness (experiments/thinking-policy) runs the real orche_task stack per arm; this keeps it working
 * and pins the MECHANICS it shows. Its scenario behaviours are scripted assumptions: nothing here is evidence of real-model quality.
 */
describe("thinking-policy comparison harness (arms a-d, scripted scenarios)", () => {
  it("runs every arm × scenario through the real stack with no unexpected tool errors and no false success report", async () => {
    const results = await runMatrix();
    expect(results).toHaveLength(28);
    expect(results.flatMap(result => result.simErrors)).toEqual([]);
    expect(results.filter(result => result.scenario !== "legacy_plan").every(result => result.checkpointRejections === 0)).toBe(true);
    expect(results.filter(result => result.falseSuccess)).toEqual([]);
    const get = (arm: string, scenario: string) => results.find(result => result.arm === arm && result.scenario === scenario)!;
    // A hidden error made at the step level: the full policy reworks it at the baseline; the plain S/B split reworks at S and ends
    // honestly blocked; the fixed arms never made it.
    expect([get("c_phase_full", "hidden_error").correct, get("b_phase_plain", "hidden_error").correct, get("b_phase_plain", "hidden_error").status]).toEqual([true, false, "blocked"]);
    // A premature report at the step level is caught by the report guard (both phase arms) and the integration runs.
    expect(get("c_phase_full", "premature_report")).toMatchObject({ correct: true, falseSuccess: false });
    // An overrunning integration keeps the baseline in every arm and is split per requirement: the step-down ladder no longer lowers
    // the effort of an integration node (quality first; before, arm a finished it at medium).
    expect([get("a_fixed", "integration_overrun").integrationEffort, get("c_phase_full", "integration_overrun").integrationEffort, get("d_fixed_checkpoints", "integration_overrun").integrationEffort]).toEqual(["high", "high", "high"]);
    expect(get("c_phase_full", "integration_overrun").redecompositions).toBe(1);
    expect(get("a_fixed", "integration_overrun")).toMatchObject({ correct: true, falseSuccess: false });
    // A hopeless model ends in an explicit failure in every arm (the split ladder spends more before giving up).
    for (const arm of ["a_fixed", "b_phase_plain", "c_phase_full", "d_fixed_checkpoints"]) expect(get(arm, "stubborn")).toMatchObject({ completed: false, correct: false });
    expect(get("c_phase_full", "stubborn").outputTokens).toBeGreaterThan(get("a_fixed", "stubborn").outputTokens);
    // The forced report after an exhausted recovery runs at B in every arm (a, b: after a step-down to medium/low).
    for (const arm of ["a_fixed", "b_phase_plain", "c_phase_full", "d_fixed_checkpoints"]) expect(get(arm, "stubborn").efforts.at(-1)).toBe("high");
    // A report written at S is never accepted: rewritten at B, and nothing after it runs at S.
    for (const arm of ["b_phase_plain", "c_phase_full"]) {
      const efforts = get(arm, "premature_report").efforts;
      expect(efforts.slice(efforts.indexOf("high", 1))).toEqual(efforts.slice(efforts.indexOf("high", 1)).map(() => "high"));
    }
    // Plans in the format from before the policy: accepted as they are without required checkpoints (a, b), refused once and
    // completed with checkpoints where they are required (d), refused for the missing integration node and then for the missing
    // checkpoint under the full phase policy with its gate (c).
    expect(["a_fixed", "b_phase_plain", "c_phase_full", "d_fixed_checkpoints"].map(arm => [arm, get(arm, "legacy_plan").correct, get(arm, "legacy_plan").checkpointRejections])).toEqual([
      ["a_fixed", true, 0], ["b_phase_plain", true, 0], ["c_phase_full", true, 2], ["d_fixed_checkpoints", true, 1],
    ]);
  }, 60_000);
});
