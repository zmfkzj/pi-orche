import { describe, expect, it } from "vitest";
import { orcheConfig, armHasAdvisor } from "../../experiments/stage-eval/protocol.js";
import { S1, S2, armsOf, bootstrap, cellMeans, contrasts, interactionVerdict, practicallyUseful, signFlipP, type RunRow } from "../../experiments/synergy/protocol.js";
import { PLANS } from "../../experiments/synergy/plans.js";
import { parseSingleConfig } from "../../src/extension/config.js";

describe("synergy arms", () => {
  it("leaves every stage-eval arm's config unchanged when no override is given", () => {
    expect(orcheConfig("single")).toEqual(orcheConfig("single", undefined));
    expect((orcheConfig("single-advisor").single as { advisor: boolean }).advisor).toBe(true);
  });

  it("S1 arms differ only in single.advisor and thinkingPolicy", () => {
    const [base, x, y, xy] = armsOf(S1).map(arm => orcheConfig(arm.kind as "single", arm.config));
    const strip = (config: Record<string, unknown>) => { const { single, thinkingPolicy, ...rest } = config; return { rest, single: { ...(single as object), advisor: undefined } }; };
    for (const config of [x, y, xy]) expect(strip(config!)).toEqual(strip(base!));
    expect(armsOf(S1).map(armHasAdvisor)).toEqual([false, true, false, true]);
    expect([base, x, y, xy].map(config => config!.thinkingPolicy ?? "fixed")).toEqual(["fixed", "fixed", "phase", "phase"]);
    expect(parseSingleConfig((xy!.single as Record<string, unknown>))).toMatchObject({ advisor: true, maxSubWorkers: 8, verifierOriginal: false });
  });

  it("S2 arms differ only in decisionMemory and the evidence linkage, under the same forced compaction, advisor off", () => {
    const configs = armsOf(S2).map(arm => orcheConfig(arm.kind as "single", arm.config));
    const compactions = configs.map(config => config.workerCompaction as Record<string, unknown>);
    expect(compactions.map(entry => entry.decisionMemory)).toEqual([false, true, false, true]);
    expect(new Set(compactions.map(entry => JSON.stringify({ ...entry, decisionMemory: undefined }))).size).toBe(1);
    expect(configs.map(config => JSON.stringify(config.thinkingPolicy))).toEqual(['"fixed"', '"fixed"', '{"mode":"fixed","evidence":"warn"}', '{"mode":"fixed","evidence":"warn"}']);
    expect(armsOf(S2).map(armHasAdvisor)).toEqual([false, false, false, false]);
  });

  it("plans: complete factorial sets with the preregistered sizes and budgets", () => {
    expect(PLANS.s1.tasks).toHaveLength(10);
    expect(PLANS.s1.repeats * PLANS.s1.tasks.length * PLANS.s1.arms.length).toBe(120);
    expect(PLANS.s2.repeats * PLANS.s2.tasks.length * PLANS.s2.arms.length).toBe(64);
    expect(PLANS["pilot-s1"].budgetUsd + PLANS["pilot-s2"].budgetUsd + PLANS.s1.budgetUsd + PLANS.s2.budgetUsd).toBe(285);
  });
});

describe("synergy analysis", () => {
  const row = (task: string, arm: string, repeat: number, pass: boolean, extra: Partial<RunRow> = {}): RunRow => ({ task, arm, repeat, terminal: pass ? "done" : "failed", gradePass: pass, primaryPass: pass, costUsd: 1, wallMs: 1000, infra: false, ...extra });

  it("computes cell means per task, skipping infra runs and tasks without all four cells", () => {
    const rows = [row("t1", "C", 1, false), row("t1", "C", 2, true), row("t1", "A", 1, true), row("t1", "P", 1, false), row("t1", "AP", 1, true), row("t1", "AP", 2, false, { infra: true, terminal: "infra" }), row("t2", "C", 1, true)];
    const means = cellMeans(rows, S1, entry => entry.primaryPass ? 1 : 0);
    expect([...means.keys()]).toEqual(["t1"]);
    expect(means.get("t1")).toEqual({ base: 0.5, x: 1, y: 0, xy: 1 });
    expect(contrasts(means)).toMatchObject({ interaction: 0.5, mainX: 0.75, mainY: -0.25, xyMinusBase: 0.5, xyMinusBestSingle: 0 });
  });

  it("detects a pure interaction, and reports additive effects as no interaction", () => {
    const tasks = Array.from({ length: 10 }, (_, index) => `t${index}`);
    const synergy = tasks.flatMap(task => [row(task, "C", 1, false), row(task, "A", 1, false), row(task, "P", 1, false), row(task, "AP", 1, true)]);
    const means = cellMeans(synergy, S1, entry => entry.primaryPass ? 1 : 0);
    const interval = bootstrap(means, c => c.interaction, 0.95, 2_000);
    expect(interval).toMatchObject({ point: 1, lower: 1, upper: 1 });
    expect(interactionVerdict(interval)).toBe("SYNERGY");
    expect(signFlipP([...means.values()].map(c => c.xy - c.x - c.y + c.base))).toBeLessThan(0.01);
    // Additive: x helps on half the tasks, nothing else differs: interaction 0 everywhere.
    const additive = tasks.flatMap((task, index) => [row(task, "C", 1, false), row(task, "A", 1, index % 2 === 0), row(task, "P", 1, false), row(task, "AP", 1, index % 2 === 0)]);
    const additiveMeans = cellMeans(additive, S1, entry => entry.primaryPass ? 1 : 0);
    expect(interactionVerdict(bootstrap(additiveMeans, c => c.interaction, 0.95, 2_000))).toBe("NO MATERIAL INTERACTION");
    expect(contrasts(additiveMeans).mainX).toBeCloseTo(0.5);
  });

  it("applies the verdict and usefulness rules", () => {
    expect(interactionVerdict({ point: -0.3, lower: -0.5, upper: -0.1 })).toBe("ANTAGONISM");
    expect(interactionVerdict({ point: 0.1, lower: -0.2, upper: 0.4 })).toBe("INCONCLUSIVE");
    expect(practicallyUseful({ xyMinusBase: { point: 0.3, lower: 0.1, upper: 0.5 }, xyMinusBestSingle: 0.1 }, 1.4)).toBe(true);
    expect(practicallyUseful({ xyMinusBase: { point: 0.3, lower: 0.1, upper: 0.5 }, xyMinusBestSingle: 0.05 }, 1.4)).toBe(false);
    expect(practicallyUseful({ xyMinusBase: { point: 0.3, lower: 0.1, upper: 0.5 }, xyMinusBestSingle: 0.2 }, 1.6)).toBe(false);
    expect(practicallyUseful({ xyMinusBase: { point: 0.3, lower: -0.1, upper: 0.5 }, xyMinusBestSingle: 0.2 }, 1.0)).toBe(false);
  });
});

describe("stage-eval accounting for Anthropic Messages streams (experiment-only adaptation, README §6)", () => {
  it("reads input, cache read/write and output tokens across the stream head and tail, and prices cache writes", async () => {
    const { anthropicUsage, usageFrom } = await import("../../experiments/stage-eval/proxy.mjs" as string) as { anthropicUsage: (head: string, tail: string) => any; usageFrom: (text: string, head?: string) => any };
    const head = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":120,"cache_read_input_tokens":9000,"cache_creation_input_tokens":800,"output_tokens":1}}}\n';
    const tail = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":350}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n';
    expect(anthropicUsage(head, tail)).toEqual({ input: 9920, cached: 9000, cacheWrite: 800, output: 350, reasoning: 0, final: "message_stop", respModel: "claude-opus-5-5" });
    expect(usageFrom(tail, head).final).toBe("message_stop");
    expect(anthropicUsage(head, "").final).toBe("message_incomplete");
    // A Responses stream is still read as before.
    expect(usageFrom('data: {"type":"response.completed","response":{"model":"gpt-6-astra","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":40},"output_tokens":7}}}\n')).toMatchObject({ input: 100, cached: 40, output: 7, final: "response.completed" });
    const { summarizeWire } = await import("../../experiments/stage-eval/protocol.js");
    const summary = summarizeWire([{ id: 1, at: "2026-11-15T00:00:00Z", method: "POST", model: "claude-opus-5-5", status: 200, final: "message_stop", usage: { input: 9920, cached: 9000, cacheWrite: 800, output: 350 } } as never],
      { roles: new Map(), rates: { "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }, expectAdvisor: false });
    expect(summary.total.errors).toBe(0);
    expect(summary.total.uncached).toBe(120);
    expect(summary.total.costUsd).toBeCloseTo((120 * 4 + 9000 * 0.2 + 350 * 20 + 800 * 5) / 1e6, 10);
  });
});
