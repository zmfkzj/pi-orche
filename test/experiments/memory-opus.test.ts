import { describe, expect, it } from "vitest";
import { analyzeEvidence } from "../../experiments/decision-memory-b/evidence.js";
import { instance } from "../../experiments/decision-memory-b/project.js";
import { ARM_CONFIG, schedule } from "../../experiments/decision-memory-b/protocol.js";
import { costAnalysis, costMet, futile, newcombePaired, overallVerdict, pairCounts, PILOT_SEEDS, qualityVerdict, REUSED_SEEDS, STAGE1_SEEDS, STAGE2_SEEDS, wilson, type Pair } from "../../experiments/memory-opus/protocol.js";
import { configsDifferOnlyInMemory, type Run } from "../../experiments/memory-opus/summarize.js";
import { PLANS } from "../../experiments/memory-opus/plans.js";

describe("memory-opus arms and plans", () => {
  it("K and M differ only in workerCompaction.decisionMemory, with linkage off and the Opus worker", () => {
    const [k, m] = [ARM_CONFIG("K", "opus"), ARM_CONFIG("M", "opus")];
    expect(k.workerCompaction.decisionMemory).toBe(false);
    expect(m.workerCompaction.decisionMemory).toBe(true);
    expect({ ...m, workerCompaction: { ...m.workerCompaction, decisionMemory: false } }).toEqual(k);
    expect(k.thinkingPolicy).toBe("fixed");
    expect(k.default.model).toBe("cliproxyapi/claude-opus-5-5");
  });

  it("uses fresh confirmatory seeds that no earlier study ran, and a pilot seed outside them", () => {
    const earlier = [...Array.from({ length: 40 }, (_, i) => i + 1), 901, 902, 903, 904, 905, 906, 907];
    const fresh = [...STAGE1_SEEDS, ...STAGE2_SEEDS];
    expect(fresh).toHaveLength(40);
    expect(new Set(fresh).size).toBe(40);
    expect(fresh.some(seed => earlier.includes(seed) || PILOT_SEEDS.includes(seed))).toBe(false);
    expect(REUSED_SEEDS.every(seed => earlier.includes(seed))).toBe(true);
  });

  it("plans run K and M only, in pairs, with Opus, reservations and the preregistered caps", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.arms).toEqual(["K", "M"]);
      expect(plan.model).toBe("opus");
      expect(plan.reservePerRunUsd).toBe(7.5);
      const cells = schedule(plan.seeds, plan.seed, plan.arms);
      expect(cells).toHaveLength(plan.seeds.length * 2);
      for (const seed of plan.seeds) expect(cells.filter(cell => cell.seed === seed).map(cell => cell.arm).sort()).toEqual(["K", "M"]);
    }
    expect(PLANS.stage1.seeds).toEqual(STAGE1_SEEDS);
    expect(PLANS.stage2.seeds).toEqual(STAGE2_SEEDS);
    expect(PLANS.pilot.budgetUsd + PLANS.stage1.budgetUsd + PLANS.stage2.budgetUsd).toBe(440);
  });
});

describe("memory-opus statistics", () => {
  it("Newcombe's paired hybrid score interval matches the published example and never collapses at the boundary", () => {
    // Fagerland, Lydersen & Laake (2014), airway hyper-responsiveness example: Newcombe square-and-add −0.507 to −0.026.
    const published = newcombePaired({ a: 1, b: 1, c: 7, d: 12 });
    expect(published.point).toBeCloseTo(-0.2857, 4);
    expect(published.lower).toBeCloseTo(-0.507, 3);
    expect(published.upper).toBeCloseTo(-0.026, 3);
    for (const n of [1, 6, 24, 40]) {
      const perfect = newcombePaired({ a: n, b: 0, c: 0, d: 0 });
      expect(Number.isFinite(perfect.lower) && Number.isFinite(perfect.upper)).toBe(true);
      expect(perfect.lower).toBeLessThan(0);
      expect(perfect.lower).toBeCloseTo(-(1 - wilson(n, n).lower), 10);
    }
    const none = newcombePaired({ a: 0, b: 0, c: 0, d: 10 });
    expect(none.lower).toBeLessThan(0);
    expect(none.upper).toBeGreaterThan(0);
    expect(newcombePaired({ a: 0, b: 0, c: 0, d: 0 }).lower).toBeNaN();
  });

  it("applies the non-inferiority margin, the futility rule and the verdict table", () => {
    expect(qualityVerdict(newcombePaired({ a: 40, b: 0, c: 0, d: 0 }))).toBe("NON-INFERIOR");
    expect(qualityVerdict(newcombePaired({ a: 39, b: 0, c: 1, d: 0 }))).toBe("NON-INFERIORITY NOT ESTABLISHED");
    expect(qualityVerdict(newcombePaired({ a: 24, b: 0, c: 0, d: 0 }))).toBe("NON-INFERIORITY NOT ESTABLISHED");
    expect(qualityVerdict({ point: -0.3, lower: -0.5, upper: -0.05 })).toBe("INFERIOR");
    expect(futile({ a: 24, b: 0, c: 0, d: 0 }, 16)).toBe(false);
    expect(futile({ a: 22, b: 0, c: 2, d: 0 }, 16)).toBe(true);
    expect(overallVerdict("NON-INFERIOR", true)).toBe("COST REDUCTION WITH NON-INFERIOR QUALITY");
    expect(overallVerdict("NON-INFERIORITY NOT ESTABLISHED", true)).toBe("COST REDUCED; QUALITY NON-INFERIORITY NOT ESTABLISHED");
    expect(pairCounts([{ on: true, off: true }, { on: true, off: false }, { on: false, off: true }, { on: false, off: false }])).toEqual({ a: 1, b: 1, c: 1, d: 1 });
  });

  it("does not let savings from failed runs satisfy the cost criterion", () => {
    const run = (success: boolean, costUsd: number) => ({ success, score: success ? 1 : 0.5, costUsd, wallS: 100 });
    // ON is cheaper only in pairs where it failed; where both succeed it costs the same.
    const pairs: Pair[] = Array.from({ length: 20 }, (_, i) => i < 10
      ? { seed: i, on: run(false, 1), off: run(true, 5) }
      : { seed: i, on: run(true, 5), off: run(true, 5 + (i % 2 ? 0.1 : -0.1)) });
    const cost = costAnalysis(pairs);
    expect(cost.perRunDiff.upper).toBeLessThan(0);
    expect(cost.bothSuccessDiff.pairs).toBe(10);
    expect(costMet(cost)).toBe(false);
    expect(cost.costPerSuccess.on).toBeCloseTo((10 + 50) / 10);
    // A genuine saving in comparable outcomes passes.
    const genuine: Pair[] = Array.from({ length: 20 }, (_, i) => ({ seed: i, on: run(true, 3 + (i % 3) * 0.1), off: run(true, 5 + (i % 2) * 0.2) }));
    expect(costMet(costAnalysis(genuine))).toBe(true);
  });

  it("checks across runs that the resolved configurations differ only in decisionMemory", () => {
    const resolved = (memory: boolean) => ({ workerCompaction: { policy: "absolute", triggerTokens: 28_000, decisionMemory: memory }, thinkingPolicy: { mode: "fixed", evidence: "off" } });
    const run = (arm: "K" | "M", config: unknown) => ({ arm, resolvedConfig: config }) as unknown as Run;
    expect(configsDifferOnlyInMemory([run("K", resolved(false)), run("M", resolved(true))])).toBe(true);
    expect(configsDifferOnlyInMemory([run("K", resolved(false)), run("M", { ...resolved(true), thinkingPolicy: { mode: "fixed", evidence: "warn" } })])).toBe(false);
    expect(configsDifferOnlyInMemory([run("K", resolved(true)), run("M", resolved(true))])).toBe(false);
  });
});

describe("memory-opus evidence measures", () => {
  const line = (value: unknown) => JSON.stringify(value);
  const at = (second: number) => new Date(Date.UTC(2026, 10, 16, 2, 0, second)).toISOString();
  it("dates the feed delivery from the feed server, counts lookups when started, and flags unfinished or long calls", () => {
    const inst = instance(201);
    const item = `src/${inst.items[0]!.template === "volume" ? "volume" : inst.items[0]!.template}.js`;
    const transcript = [
      // The feed output went to an artifact: the tool result does not contain the log.
      line({ type: "message", timestamp: at(1), message: { role: "assistant", content: [{ type: "toolCall", id: "f", name: "bash", arguments: { command: "npm run decisions" } }] } }),
      line({ type: "message", timestamp: at(2), message: { role: "toolResult", toolCallId: "f", toolName: "bash", content: "output saved to .orche/artifacts/bash-1.txt" } }),
      line({ type: "compaction", timestamp: at(3), summary: "s" }),
      line({ type: "message", timestamp: at(4), message: { role: "assistant", content: [{ type: "toolCall", id: "w", name: "bash", arguments: { command: `python3 - <<EOF\nopen("${item}","w").write("x")\nEOF` } }] } }),
      line({ type: "message", timestamp: at(5), message: { role: "toolResult", toolCallId: "w", toolName: "bash", content: "" } }),
      line({ type: "message", timestamp: at(6), message: { role: "assistant", content: [{ type: "toolCall", id: "g", name: "bash", arguments: { command: "grep -o 'D-1.\\{0,2500\\}' /x/W1.jsonl" } }] } }),
    ].join("\n");
    const without = analyzeEvidence(transcript, inst);
    expect(without.exposedDecisionsBroad).toBe(false);
    const withFeed = analyzeEvidence(transcript, inst, { feedDeliveredAt: Date.parse(at(1)) });
    expect(withFeed.exposedDecisions).toBe(false); // narrow: edit/write tools only
    expect(withFeed.exposedDecisionsBroad).toBe(true);
    expect(withFeed).toMatchObject({ transcriptLookupsStarted: 1, transcriptLookups: 0, unfinishedCalls: 1, unfinishedTranscriptLookups: 1 });
  });
});
