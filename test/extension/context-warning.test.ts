import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { contextWarning, DEFAULT_CONTEXT_WARNING } from "../../src/extension/context-warning.js";
import { loadOrcheConfigFile, parseContextWarningConfig } from "../../src/extension/config.js";
import { createHarness, type Harness } from "./harness.js";

const usage = (percent: number | null, window = 200_000) => ({ percent, contextWindow: window, tokens: percent === null ? null : Math.round(window * percent / 100) });
const settings = { ...DEFAULT_CONTEXT_WARNING, thresholds: [...DEFAULT_CONTEXT_WARNING.thresholds] };

describe("contextWarning (pure)", () => {
  it("warns once per threshold in direct mode and names the remedy", () => {
    let state = { warnedLevel: 0 };
    expect(contextWarning("direct", usage(40), settings, state).message).toBeUndefined();
    const first = contextWarning("direct", usage(52), settings, state);
    expect(first.message).toBe("orche: main context is at 52% of the window (104k/200k tokens). For remaining large work, switch with /orche mode single so a worker carries the context and this session keeps only results, or run /compact.");
    state = first.state;
    expect(contextWarning("direct", usage(60), settings, state).message).toBeUndefined();
    const second = contextWarning("direct", usage(76), settings, state);
    expect(second.message).toContain("76%");
    state = second.state;
    expect(contextWarning("direct", usage(90), settings, state).message).toBeUndefined();
  });
  it("re-arms only after usage drops well below the lowest threshold", () => {
    let state = contextWarning("direct", usage(55), settings, { warnedLevel: 0 }).state;
    state = contextWarning("direct", usage(45), settings, state).state;
    expect(contextWarning("direct", usage(55), settings, state).message).toBeUndefined();
    state = contextWarning("direct", usage(30), settings, state).state;
    expect(state.warnedLevel).toBe(0);
    expect(contextWarning("direct", usage(55), settings, state).message).toContain("55%");
  });
  it("warns in the delegating modes too, with /compact and a new session as the remedy (not a mode switch)", () => {
    for (const mode of ["single", "strong", "ultra"] as const) {
      expect(contextWarning(mode, usage(40), settings, { warnedLevel: 0 }).message).toBeUndefined();
      const first = contextWarning(mode, usage(52), settings, { warnedLevel: 0 });
      expect(first.message).toBe(`orche: main context is at 52% of the window (104k/200k tokens) (mode ${mode}). Every main request re-sends this conversation, so main's turns get slower and its long responses come closer to provider time limits; delegating does not shrink the history this session already holds. Run /compact to summarize it, or start the next task in a new session (/new).`);
      expect(first.state).toEqual({ warnedLevel: 50 });
      expect(contextWarning(mode, usage(60), settings, first.state).message).toBeUndefined();
      const second = contextWarning(mode, usage(76), settings, first.state);
      expect(second.message).toContain("76%");
      expect(contextWarning(mode, usage(95), settings, second.state).message).toBeUndefined();
    }
    // The 1M-window main of the 15-minute cut-offs: ~59% is past the first threshold.
    expect(contextWarning("single", { percent: 59, contextWindow: 1_000_000, tokens: 590_000 }, settings, { warnedLevel: 0 }).message).toContain("59% of the window (590k/1000k tokens)");
  });
  it("one warning state across mode switches: a level warned in one mode is not repeated in another until usage re-arms below 40%", () => {
    let state = contextWarning("direct", usage(55), settings, { warnedLevel: 0 }).state;
    expect(contextWarning("single", usage(58), settings, state).message).toBeUndefined();
    state = contextWarning("strong", usage(58), settings, state).state;
    const higher = contextWarning("single", usage(80), settings, state);
    expect(higher.message).toContain("(mode single)");
    expect(contextWarning("direct", usage(85), settings, higher.state).message).toBeUndefined();
    // 40% is not below the re-arm point (lowest threshold 50 minus 10); 39% is.
    expect(contextWarning("single", usage(40), settings, higher.state).state).toEqual(higher.state);
    state = contextWarning("single", usage(39), settings, higher.state).state;
    expect(state).toEqual({ warnedLevel: 0 });
    expect(contextWarning("ultra", usage(51), settings, state).message).toContain("(mode ultra)");
  });
  it("is silent when disabled and when usage is unknown", () => {
    for (const mode of ["direct", "single"] as const) {
      expect(contextWarning(mode, usage(80), { ...settings, enabled: false }, { warnedLevel: 0 }).message).toBeUndefined();
      expect(contextWarning(mode, usage(null), settings, { warnedLevel: 0 }).message).toBeUndefined();
      expect(contextWarning(mode, undefined, settings, { warnedLevel: 0 }).message).toBeUndefined();
    }
  });
});

describe("contextWarning config", () => {
  it("applies defaults and validates fields", () => {
    expect(parseContextWarningConfig({})).toEqual({ enabled: true, thresholds: [50, 75] });
    expect(parseContextWarningConfig({ enabled: false, thresholds: [40] })).toEqual({ enabled: false, thresholds: [40] });
    expect(() => parseContextWarningConfig({ extra: 1 })).toThrow("unknown field");
    expect(() => parseContextWarningConfig({ enabled: "yes" })).toThrow("expected boolean");
    expect(() => parseContextWarningConfig({ thresholds: [] })).toThrow("1-5 percentages");
    expect(() => parseContextWarningConfig({ thresholds: [60, 50] })).toThrow("strictly ascending");
    expect(() => parseContextWarningConfig({ thresholds: [0] })).toThrow("greater than 0");
    expect(() => parseContextWarningConfig({ thresholds: [100] })).toThrow("below 100");
  });
  it("is read from the config file next to the routes", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], writeUserConfig: false });
    try {
      const path = join(h.agentDir, "orche.config.json");
      await writeFile(path, JSON.stringify({ routes: {}, contextWarning: { thresholds: [30, 60] } }));
      expect((await loadOrcheConfigFile(path)).contextWarning).toEqual({ enabled: true, thresholds: [30, 60] });
      await writeFile(path, JSON.stringify({ routes: {} }));
      expect((await loadOrcheConfigFile(path)).contextWarning).toEqual({ enabled: true, thresholds: [50, 75] });
    } finally { await h.dispose(); }
  });
});

describe("contextWarning in a real session", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.dispose(); h = undefined; });
  // The faux model has a 128k window and estimates chars/4 tokens: ~280k chars of prompt is past 50%.
  const big = "x".repeat(280_000);
  const warnings = (harness: Harness) => harness.notifications.filter(note => note.message.startsWith("orche: main context is at"));

  it("notifies the user once in direct mode when a turn crosses 50%", async () => {
    h = await createHarness({ mainSteps: [reply("ok"), reply("ok again")], orcheSteps: [], mainMode: "direct" });
    await h.session.prompt("small task");
    expect(warnings(h)).toHaveLength(0);
    await h.session.prompt(big);
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]).toMatchObject({ type: "warning" });
    expect(warnings(h)[0]!.message).toContain("/orche mode single");
  });
  it("warns once in single mode, recommends /compact or /new, compacts nothing, and does not repeat after a switch to direct", async () => {
    h = await createHarness({ mainSteps: [reply("ok"), reply("ok again"), reply("ok in direct")], orcheSteps: [], mainMode: "single" });
    await h.session.prompt(big);
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]).toMatchObject({ type: "warning" });
    expect(warnings(h)[0]!.message).toContain("(mode single)");
    expect(warnings(h)[0]!.message).toContain("/compact");
    expect(warnings(h)[0]!.message).toContain("(/new)");
    await h.session.prompt("and a small follow-up");
    expect(warnings(h)).toHaveLength(1);
    // Advice only: the history is intact (no compaction, nothing removed).
    expect(h.session.messages.filter(message => message.role === "user")).toHaveLength(2);
    expect(h.session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
    await h.session.prompt("/orche mode direct");
    await h.session.prompt("now in direct");
    expect(warnings(h)).toHaveLength(1);
  });
});
