import { describe, expect, it } from "vitest";
import { packetText, redact } from "../../experiments/cb-ab/score.js";
import { stopAfterTwo, summarizeCase, verdict, type RunScore } from "../../experiments/cb-ab/protocol.js";

const run = (caseId: string, arm: "A" | "B" | "C", repeat: number, found: string[], f = 0): RunScore => ({ unit: `${caseId}/${arm}/r${repeat}`, caseId, arm, repeat, k: ["K1", "K2"].map(k => ({ k, m: found.includes(k) ? 1 : 0, l: found.includes(k) ? 1 : 0, s: 0 })) as RunScore["k"], v: 0, f, u: 0 });

describe("cb-ab blind packets", () => {
  it("redacts arm-revealing words and drops split lines", () => {
    const text = redact("**Split:** one isolated explorer, `contract-backward`, ran.\nThe independent-explorer and W1.1 sub-worker found K at a.py:3 (orche_spawn).\nPath /tmp/pi-orche/tmp/x/W1/probe.py");
    expect(text).not.toMatch(/split|contract-backward|independent-explorer|W1\.1|sub-worker|orche_spawn|explorer|\/tmp\/pi-orche/i);
    expect(text).toContain("a.py:3");
  });
  it("builds a packet from the worker report and main's text", () => {
    const packet = packetText({ text: "final", report: { arguments: { kind: "answer", summary: "sum", findings: [1] } } });
    expect(packet).toContain("final"); expect(packet).toContain("sum"); expect(packet).toContain("findings");
  });
});

describe("cb-ab decision rules", () => {
  it("stops after two cases without a B-unique defect unless both are saturated", () => {
    const runs = [run("c1", "A", 1, ["K1"]), run("c1", "A", 2, []), run("c1", "B", 1, ["K1"]), run("c1", "B", 2, []), run("c2", "A", 1, ["K1", "K2"]), run("c2", "A", 2, ["K1", "K2"]), run("c2", "B", 1, ["K1"]), run("c2", "B", 2, [])];
    const c1 = summarizeCase("c1", ["K1", "K2"], runs), c2 = summarizeCase("c2", ["K1", "K2"], runs);
    expect(c2.saturated).toBe(true); expect(c1.saturated).toBe(false);
    expect(stopAfterTwo(c1, c2)).toBe(true);
    expect(stopAfterTwo(c2, c2)).toBe(false);
  });
  it("needs B-unique defects in two cases; B > A without B > C is not isolated from compute", () => {
    const runs = ["c1", "c2"].flatMap(c => [run(c, "A", 1, []), run(c, "A", 2, []), run(c, "B", 1, ["K2"]), run(c, "B", 2, []), run(c, "C", 1, ["K2"]), run(c, "C", 2, [])]);
    const cases = ["c1", "c2"].map(c => summarizeCase(c, ["K1", "K2"], runs));
    expect(verdict(cases, runs).verdict).toBe("supported-not-isolated-from-compute");
    const runsC = runs.map(item => item.arm === "C" ? { ...item, k: item.k.map(k => ({ ...k, m: 0 as const, l: 0 as const })) } : item);
    expect(verdict(["c1", "c2"].map(c => summarizeCase(c, ["K1", "K2"], runsC)), runsC).verdict).toBe("supported-cb-specific");
    const worseF = runs.map(item => item.arm === "B" ? { ...item, f: 3 } : item);
    expect(verdict(cases, worseF).verdict).toBe("regression");
  });
});
