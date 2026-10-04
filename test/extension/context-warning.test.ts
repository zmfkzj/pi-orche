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
  it("is silent in single mode, when disabled, and when usage is unknown", () => {
    const mode = "single" as const;
    expect(contextWarning(mode, usage(80), settings, { warnedLevel: 0 }).message).toBeUndefined();
    expect(contextWarning("direct", usage(80), { ...settings, enabled: false }, { warnedLevel: 0 }).message).toBeUndefined();
    expect(contextWarning("direct", usage(null), settings, { warnedLevel: 0 }).message).toBeUndefined();
    expect(contextWarning("direct", undefined, settings, { warnedLevel: 0 }).message).toBeUndefined();
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
  it("stays silent in single mode", async () => {
    h = await createHarness({ mainSteps: [reply("ok")], orcheSteps: [], mainMode: "single" });
    await h.session.prompt(big);
    expect(warnings(h)).toHaveLength(0);
  });
});
