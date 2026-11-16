import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASES, PILOT_CASES } from "../../experiments/verifier-original-ab/cases.js";
import { CASES_2, VIOLATION_TYPES_2 } from "../../experiments/verifier-original-ab/cases-2.js";
import { checkTruth, materialize } from "../../experiments/verifier-original-ab/fixture.js";
import { classify, decide, promptFor, schedule } from "../../experiments/verifier-original-ab/protocol.js";
import { intervals, metrics, perCase, relabel, rescore, signFlipP, type RunRecord } from "../../experiments/verifier-original-ab/analyze.js";
import { scanEntries } from "../../experiments/verifier-original-ab/scan.js";
import { subWorkerPrompt } from "../../src/extension/workers.js";
import { verifierOriginalBlock, userTextCarry } from "../../src/orchestration/handoff-evidence.js";
import { originalRequestOf } from "../../src/single/ledger.js";

const scratch = () => mkdtempSync(join(tmpdir(), "voab-"));
const filesBelow = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return name === ".git" ? [] : statSync(path).isDirectory() ? filesBelow(path) : [path]; });

describe("verifier original-evidence A/B: fixtures", () => {
  it("has the preregistered case set: 34 cases in 20 scenarios, 14 violations and 20 compliant", () => {
    expect(CASES).toHaveLength(34);
    expect(new Set(CASES.map(item => item.scenario)).size).toBe(20);
    expect(CASES.filter(item => item.truth === "fail")).toHaveLength(14);
    expect(CASES.filter(item => item.truth === "fail" && item.evidenceGain).map(item => item.id).sort()).toEqual(["config-keys/bad", "coupon/bad", "csv-stdout/bad", "dedupe/bad", "default-timeout/bad", "duration/bad", "retry/bad", "slugify/bad", "username-early/bad"]);
  });

  it("has the study-2 case set of PREREGISTRATION-2.md: 40 cases in 24 scenarios, 16 violations, 10 with evidence gain", () => {
    expect(CASES_2).toHaveLength(40);
    expect(new Set(CASES_2.map(item => item.scenario)).size).toBe(24);
    expect(CASES_2.filter(item => item.truth === "fail")).toHaveLength(16);
    expect(CASES_2.filter(item => item.truth === "fail" && item.evidenceGain)).toHaveLength(10);
    const tally = (stratum: string) => CASES_2.filter(item => item.stratum === stratum).length;
    expect(["hidden", "doc", "present", "short", "retracted", "scope", "truncated"].map(tally)).toEqual([12, 6, 4, 6, 4, 4, 4]);
    expect(Object.values(VIOLATION_TYPES_2).sort()).toEqual([...Array(8).fill("new-code"), ...Array(8).fill("regression")]);
    expect(CASES_2.filter(item => item.stratum === "retracted").every(item => item.later)).toBe(true);
    expect(new Set([...CASES, ...CASES_2].map(item => item.id)).size).toBe(74);
  });

  it("establishes every label without a model: the visible suite passes and the hidden check agrees", () => {
    const root = scratch();
    for (const item of [...CASES, ...PILOT_CASES, ...CASES_2]) expect({ id: item.id, ...checkTruth(item, join(root, item.id.replaceAll("/", "_"))) }).toMatchObject({ id: item.id, visible: true, agrees: true });
  }, 120_000);

  it("gives the verifier a workspace that reveals neither the case id, its stratum nor its label (scenario names are ordinary function names)", () => {
    const root = scratch();
    for (const item of [...CASES, ...CASES_2]) {
      const workspace = join(root, item.id.replaceAll("/", "_"));
      materialize(item, workspace);
      const text = filesBelow(workspace).map(file => readFileSync(file, "utf8")).join("\n");
      for (const word of [item.id, "violat", "compliant", "ground truth", "hidden check", "retracted", "truncated", "stratum", "label"]) expect(text.toLowerCase(), `${item.id}: ${word}`).not.toContain(word.toLowerCase());
    }
  }, 60_000);
});

describe("verifier original-evidence A/B: the arms", () => {
  it("OFF is the pre-change prompt and ON adds exactly the production block, for every case", () => {
    for (const item of [...CASES, ...PILOT_CASES, ...CASES_2]) {
      const original = originalRequestOf(item.assignment);
      expect(original, item.id).toBeTruthy();
      // The request never carries the original verbatim, so every case is eligible for the supplement.
      expect(userTextCarry(item.request, original!).carry, item.id).not.toBe("verbatim");
      const off = promptFor(item, "off"), on = promptFor(item, "on");
      const planned = { id: "W1.1", name: "verify", role: "verify", reason: "verification", request: item.request } as Parameters<typeof subWorkerPrompt>[0];
      expect(off).toBe(subWorkerPrompt(planned, "W1", [], false));
      expect(on).toBe(`${off}`.replace(item.request, `${item.request}\n\n${verifierOriginalBlock(item.request, original)}`));
      expect(on.length).toBeGreaterThan(off.length);
    }
  });

  it("cuts the long originals so that only the early rule reaches the ON verifier", () => {
    const rule = "숫자로 시작하면 안 된다";
    const early = CASES.find(item => item.id === "username-early/bad")!, late = CASES.find(item => item.id === "username-late/bad")!;
    expect(originalRequestOf(early.assignment)!.length).toBeGreaterThan(8_000);
    expect(originalRequestOf(late.assignment)!.indexOf(rule)).toBeGreaterThan(8_000);
    expect(promptFor(early, "on")).toContain(rule);
    expect(promptFor(late, "on")).not.toContain(rule);
    expect(promptFor(late, "on")).toContain("more characters of the user's request not shown");
  });

  it("schedules every case once per replicate with both arms adjacent, deterministically", () => {
    const ids = CASES.map(item => item.id);
    const cells = schedule(ids, 1, 7);
    expect(cells).toHaveLength(68);
    for (let index = 0; index < cells.length; index += 2) { expect(cells[index]!.caseId).toBe(cells[index + 1]!.caseId); expect(new Set([cells[index]!.arm, cells[index + 1]!.arm])).toEqual(new Set(["off", "on"])); }
    expect(new Set(cells.map(cell => cell.caseId)).size).toBe(34);
    expect(schedule(ids, 1, 7)).toEqual(cells);
    expect(schedule(ids, 2, 7)).not.toEqual(cells);
  });
});

describe("verifier original-evidence A/B: scoring and decision", () => {
  it("scores only data.passed as a verdict; a model that gave none is no-verdict, a provider failure infra", () => {
    expect(classify({ status: "passed", data: { passed: true }, requests: 3 })).toBe("verdict");
    expect(classify({ status: "not passed", data: { passed: false }, requests: 3 })).toBe("verdict");
    expect(classify({ status: "failed", requests: 5, error: "timed out after 900s" })).toBe("no-verdict");
    expect(classify({ status: "cancelled", requests: 0 })).toBe("infra");
    expect(classify({ status: "failed", requests: 2, error: "fetch failed: ECONNRESET" })).toBe("infra");
    expect(classify(undefined)).toBe("infra");
  });

  it("applies the preregistered decision rule in its order", () => {
    const at = (point: number, lower: number, upper: number) => ({ point, lower, upper });
    expect(decide(at(0.5, 0.2, 0.8), at(0.2, 0.05, 0.35), at(0.1, -0.05, 0.25))).toBe("TRADE-OFF");
    expect(decide(at(0.5, 0.2, 0.8), at(0, -0.1, 0.1), at(0.2, 0.05, 0.35))).toBe("IMPROVES");
    expect(decide(at(0, -0.1, 0.1), at(0.2, 0.05, 0.35), at(-0.1, -0.2, 0.02))).toBe("HARMS");
    expect(decide(at(0, -0.1, 0.1), at(0, -0.05, 0.05), at(0, -0.08, 0.08))).toBe("NO MATERIAL DIFFERENCE");
    expect(decide(at(0.2, -0.1, 0.5), at(0.05, -0.1, 0.2), at(0.05, -0.1, 0.2))).toBe("INCONCLUSIVE");
  });

  const run = (caseId: string, arm: "off" | "on", replicate: number, correct: boolean, extra: Partial<RunRecord> = {}): RunRecord => {
    const truth = CASES.find(item => item.id === caseId)!.truth;
    return { caseId, arm, replicate, class: "verdict", correct, verdict: correct ? truth : truth === "pass" ? "fail" : "pass", costUSD: 0.1, durationMs: 1000, requests: 3, promptChars: 100, contaminated: false, attempts: 1, ...extra };
  };

  it("averages replicates per case and drops a replicate whose pair is incomplete, infra or contaminated", () => {
    const runs = [run("coupon/bad", "off", 1, false), run("coupon/bad", "on", 1, true), run("coupon/bad", "off", 2, false), run("coupon/bad", "on", 2, false),
      run("coupon/bad", "off", 3, true), run("coupon/bad", "on", 3, true, { class: "infra", correct: null }),
      run("coupon/ok", "off", 1, true), run("coupon/ok", "on", 1, false, { contaminated: true })];
    const results = perCase(runs);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "coupon/bad", replicates: 2, off: 0, on: 0.5, d: 0.5 });
  });

  it("computes M1, M2, M3 with intervals and sign-flip p-values; identical arms give zero effect", () => {
    const same = CASES.flatMap(item => [run(item.id, "off", 1, true), run(item.id, "on", 1, true)]);
    const zero = intervals(perCase(same), 0.98, 2_000);
    expect([zero.m1.point, zero.m2.point, zero.m3.point]).toEqual([0, 0, 0]);
    expect(decide(zero.m1, zero.m2, zero.m3)).toBe("NO MATERIAL DIFFERENCE");
    // ON catches every evidence-gain violation OFF misses, and nothing else differs.
    const better = CASES.flatMap(item => item.truth === "fail" && item.evidenceGain ? [run(item.id, "off", 1, false), run(item.id, "on", 1, true)] : [run(item.id, "off", 1, true), run(item.id, "on", 1, true)]);
    const results = perCase(better);
    expect(metrics(results).m1).toBe(1);
    expect(metrics(results).m2).toBe(0);
    expect(metrics(results).m3).toBeCloseTo(0.5 * 9 / 14);
    const ci = intervals(results, 0.98, 2_000);
    expect(decide(ci.m1, ci.m2, ci.m3)).toBe("IMPROVES");
    expect(signFlipP(results, items => metrics(items).m3, 5_000)).toBeLessThan(0.01);
  });
});

describe("verifier original-evidence A/B: label overrides (DEVIATIONS.md D1-D2)", () => {
  it("relabels or excludes cases and rescores runs from their verdicts; a no-verdict run stays incorrect", () => {
    const cases = relabel(CASES, { "csv-stdout/ok": { label: "fail", evidenceGain: false }, "tokenize/ok": { label: "exclude" } });
    expect(cases).toHaveLength(33);
    expect(cases.find(item => item.id === "csv-stdout/ok")).toMatchObject({ truth: "fail", evidenceGain: false });
    const runs: RunRecord[] = [
      { caseId: "csv-stdout/ok", arm: "off", replicate: 1, class: "verdict", correct: false, verdict: "fail", costUSD: 0, durationMs: 0, requests: 1, promptChars: 1, contaminated: false, attempts: 1 },
      { caseId: "tokenize/ok", arm: "off", replicate: 1, class: "verdict", correct: false, verdict: "fail", costUSD: 0, durationMs: 0, requests: 1, promptChars: 1, contaminated: false, attempts: 1 },
      { caseId: "coupon/bad", arm: "on", replicate: 1, class: "no-verdict", correct: false, verdict: null, costUSD: 0, durationMs: 0, requests: 4, promptChars: 1, contaminated: false, attempts: 1 },
    ];
    expect(rescore(runs, cases).map(run => [run.caseId, run.correct])).toEqual([["csv-stdout/ok", true], ["coupon/bad", false]]);
  });
});

describe("verifier original-evidence A/B: contamination scan", () => {
  it("flags tool calls that reach the study's own files and counts paths outside the workspace", () => {
    const call = (args: object) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: args }] } });
    const scan = scanEntries([call({ path: "/var/tmp/x/work/repo/src/a.js" }), call({ path: "/home/u/orche/experiments/verifier-original-ab/cases.ts" }), call({ command: "cat /etc/hosts" })], "/var/tmp/x/work/repo");
    expect(scan).toEqual({ scanned: true, toolCalls: 3, outsidePaths: 2, studyAccess: ["read"] });
  });
});
