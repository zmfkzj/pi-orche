import { describe, expect, it } from "vitest";
import { advisorPresets, parseAdvisorConfigs, resolveAdvisor, advisorDefaults } from "../../src/advisor/config.js";
import { loadRouteConfig, parseRouteConfig } from "../../src/orchestration/routing.js";

const minimal = { name: "mine", domains: ["tests"], targets: ["coordinator"], triggers: [{ on: "tool_error" }] };

describe("advisor config", () => {
  it("ships both presets disabled and expands them to the documented definitions", async () => {
    const config = await loadRouteConfig("orche.config.json");
    expect(config.advisors?.map(advisor => [advisor.name, advisor.enabled])).toEqual([["plan-review", false], ["verification-audit", false]]);
    expect(config.advisors?.[0]).toMatchObject({ domains: ["plan"], targets: ["coordinator"], triggers: [{ on: "coordinator_decision", decisions: ["classify", "assign"], await: true }] });
    expect(config.advisors?.[1]).toMatchObject({ domains: ["verification"], targets: ["coordinator"], triggers: [{ on: "assignment_result", kinds: ["implement", "fix", "verify"] }] });
  });
  it("lets a preset entry override fields and rename without mutating the preset", () => {
    const [custom] = parseAdvisorConfigs([{ preset: "plan-review", name: "plan-strict", enabled: true, maxCallsPerRun: 9 }]);
    expect(custom).toMatchObject({ name: "plan-strict", enabled: true, maxCallsPerRun: 9, domains: ["plan"] });
    expect(advisorPresets["plan-review"].maxCallsPerRun).toBe(4);
  });
  it("applies finite defaults and resolves builtin and custom domains", () => {
    const resolved = resolveAdvisor(parseAdvisorConfigs([{ ...minimal, domains: ["security", { id: "naming", instructions: "Names match the glossary." }] }])[0]!);
    expect(resolved).toMatchObject({ route: "advisor", cooldownMs: advisorDefaults.cooldownMs, maxCallsPerRun: advisorDefaults.maxCallsPerRun, maxCallsPerTarget: advisorDefaults.maxCallsPerTarget, timeoutMs: advisorDefaults.timeoutMs });
    expect(resolved.domains.map(domain => domain.id)).toEqual(["security", "naming"]);
    expect(resolved.domains[0]!.instructions).toContain("injection");
  });
  it("is accepted by the route config parser, which still rejects unknown fields", () => {
    const routes = parseRouteConfig({ routes: {}, advisors: [minimal] });
    expect(routes.advisors).toHaveLength(1);
    expect(() => parseRouteConfig({ routes: {}, advisor: [] })).toThrow("unknown field");
  });
  const invalid: [string, unknown, string][] = [
    ["non-array", {}, "config.advisors: expected array"],
    ["unknown field", [{ ...minimal, trigger: [] }], 'config.advisors[0]: unknown field "trigger"'],
    ["unknown preset", [{ preset: "nope" }], 'config.advisors[0].preset: unknown preset "nope"'],
    ["bad name", [{ ...minimal, name: "a b" }], "config.advisors[0].name"],
    ["duplicate name", [minimal, minimal], 'config.advisors[1].name: duplicate advisor name "mine"'],
    ["unknown domain", [{ ...minimal, domains: ["style"] }], 'config.advisors[0].domains[0]: unknown domain "style"'],
    ["builtin id for custom domain", [{ ...minimal, domains: [{ id: "tests", instructions: "x" }] }], "is a builtin domain"],
    ["bad target", [{ ...minimal, targets: ["everyone"] }], "config.advisors[0].targets[0]: expected"],
    ["unknown trigger", [{ ...minimal, triggers: [{ on: "sometimes" }] }], "config.advisors[0].triggers[0].on: unknown trigger"],
    ["turn_end without period", [{ ...minimal, triggers: [{ on: "turn_end" }] }], "triggers[0].every: expected integer >= 1"],
    ["interval too small", [{ ...minimal, triggers: [{ on: "interval", ms: 5 }] }], "triggers[0].ms: expected integer >= 100"],
    ["unknown assignment kind", [{ ...minimal, triggers: [{ on: "assignment_result", kinds: ["ship"] }] }], 'triggers[0].kinds[0]: unknown value "ship"'],
    ["unknown decision", [{ ...minimal, triggers: [{ on: "coordinator_decision", decisions: ["approve"] }] }], 'triggers[0].decisions[0]: unknown value "approve"'],
    ["unknown phase", [{ ...minimal, triggers: [{ on: "coordinator_decision", phases: ["LATER"] }] }], 'triggers[0].phases[0]: unknown value "LATER"'],
    ["trigger field typo", [{ ...minimal, triggers: [{ on: "tool_error", every: 2 }] }], 'triggers[0]: unknown field "every"'],
    ["decision trigger with worker target", [{ ...minimal, targets: ["workers"], triggers: [{ on: "before_complete" }] }], 'can only go to target "coordinator"'],
    ["negative cooldown", [{ ...minimal, cooldownMs: -1 }], "cooldownMs: expected integer >= 0"],
    ["zero budget", [{ ...minimal, maxCallsPerRun: 0 }], "maxCallsPerRun: expected integer >= 1"],
  ];
  for (const [label, value, message] of invalid) {
    it(`rejects ${label} with a located message`, () => {
      expect(() => parseAdvisorConfigs(value)).toThrow(message);
      expect(() => parseRouteConfig({ routes: {}, advisors: value })).toThrow(message);
    });
  }
});
