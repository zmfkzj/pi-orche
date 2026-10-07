import { describe, expect, it } from "vitest";
import { classifyLengthStop, DEFAULT_MAX_CONSECUTIVE, DEFAULT_STEP_DOWN_THINKING, lengthNudge, underContextPressure } from "../../src/pi/length-recovery.js";
import { runScenario, STRATEGIES } from "../../experiments/length-recovery/bench.js";

/**
 * Output-limit recovery (src/pi/length-recovery.ts) through the real stack: orche's AgentManager and session factory, Pi's
 * AgentSession with its compaction/overflow recovery, and a scripted faux model (experiments/length-recovery/bench.ts). These are
 * controlled reproductions of the transcripts in docs/length-recovery.md, not measurements of a real model.
 */
describe("length stop classification", () => {
  const message = (content: unknown[], stopReason = "length") => ({ role: "assistant", stopReason, content, usage: { input: 30_000, cacheRead: 10_000, output: 32_000 } });
  it("tells thinking-only, cut-off text and cut-off tool calls apart, and ignores other stops", () => {
    expect(classifyLengthStop(message([{ type: "thinking", thinking: "…" }]))).toBe("thinking_only");
    expect(classifyLengthStop(message([{ type: "thinking", thinking: "…" }, { type: "text", text: "  " }]))).toBe("thinking_only");
    expect(classifyLengthStop(message([{ type: "text", text: "The answer is" }]))).toBe("partial_text");
    expect(classifyLengthStop(message([{ type: "text", text: "x" }, { type: "toolCall", name: "write" }]))).toBe("partial_tool");
    expect(classifyLengthStop(message([{ type: "text", text: "done" }], "stop"))).toBeUndefined();
  });
  it("leaves real context pressure to Pi", () => {
    expect(underContextPressure(40_000, 32_000, 1_000_000)).toBe(false);
    expect(underContextPressure(900_000, 100, 1_000_000)).toBe(true);
    expect(underContextPressure(960_000, 30_000, 1_000_000)).toBe(true);
    expect(underContextPressure(40_000, 32_000, undefined)).toBe(true);
  });
  it("the nudge asks for the next step only, or quotes cut-off text", () => {
    expect(lengthNudge({ kind: "thinking_only", output: 32_000, contextTokens: 40_000 }, 1, 2)).toMatch(/32000 tokens\) while still reasoning.*Reason only about the immediate next step, then call one tool now/s);
    expect(lengthNudge({ kind: "partial_text", output: 32_000, contextTokens: 40_000, tail: "notes.txt contains" }, 2, 2)).toContain("«…notes.txt contains»");
  });
});

describe("recovery in a worker session (shipped defaults vs Pi's own behaviour)", () => {
  it("an overrun bound to the effort level: Pi compacts twice and the worker ends silently; the default recovers without compaction", async () => {
    const pi = await runScenario("P0_pi_default", "effort_bound");
    expect(pi).toMatchObject({ reported: false, outcome: "no_result", compactions: 2, summarizerCalls: 2 });
    const shipped = await runScenario("P0_pi_default", "effort_bound", { recovery: {} });
    expect(shipped).toMatchObject({ reported: true, outcome: "completed", compactions: 0, summarizerCalls: 0, lengthStops: 2 });
  });
  it("an over-planning model recovers after one next-step nudge, with no compaction", async () => {
    expect(await runScenario("P0_pi_default", "needs_nudge", { recovery: {} })).toMatchObject({ reported: true, compactions: 0, lengthStops: 1, requests: 3 });
  });
  it("a model that never stops overrunning ends with an explicit output-limit failure, bounded in requests, never silently", async () => {
    const result = await runScenario("P0_pi_default", "stubborn", { recovery: {} });
    expect(result).toMatchObject({ reported: false, outcome: "failed", compactions: 0 });
    expect(result.error).toMatch(/^Output limit: \d+ consecutive responses hit the model's output token limit/);
    expect(result.requests).toBeLessThanOrEqual(4);
  });
  it("a real context overflow still gets Pi's compact-and-retry", async () => {
    expect(await runScenario("P0_pi_default", "real_overflow", { recovery: {} })).toMatchObject({ reported: true, compactions: 1, summarizerCalls: 1 });
  });
  it("cut-off text continues without compaction", async () => {
    expect(await runScenario("P0_pi_default", "partial_text", { recovery: {} })).toMatchObject({ reported: true, compactions: 0, lengthStops: 1 });
  });
});

describe("the benchmark drives the production recovery", () => {
  it("the shipped defaults are the benchmark's chosen strategy, and running them equals running that strategy", async () => {
    expect(STRATEGIES.P2_nudge_stepdown_cap2).toEqual({ mode: "nudge", maxConsecutive: DEFAULT_MAX_CONSECUTIVE, stepDownThinking: DEFAULT_STEP_DOWN_THINKING });
    const { wallMs: _a, ...chosen } = await runScenario("P2_nudge_stepdown_cap2", "effort_bound");
    const { wallMs: _b, ...shipped } = await runScenario("P0_pi_default", "effort_bound", { recovery: {} });
    expect({ ...shipped, strategy: chosen.strategy }).toEqual(chosen);
  });
  it("the baselines do what their names say: P4 re-sends the identical request, P3 adds a plain continuation, ours adds neither", async () => {
    expect(await runScenario("P4_identical_resend", "transient")).toMatchObject({ reported: true, lengthStops: 1, identicalResends: 1, compactions: 0 });
    expect(await runScenario("P3_plain_continue", "transient")).toMatchObject({ reported: true, lengthStops: 1, identicalResends: 0, compactions: 0 });
    // An over-planning model: re-sending or "Continue." changes nothing, the next-step nudge does.
    expect(await runScenario("P4_identical_resend", "needs_nudge")).toMatchObject({ reported: false, outcome: "failed" });
    expect(await runScenario("P2_nudge_stepdown_cap2", "needs_nudge")).toMatchObject({ reported: true, identicalResends: 0 });
  });
});
