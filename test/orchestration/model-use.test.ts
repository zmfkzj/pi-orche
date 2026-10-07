import { describe, expect, it } from "vitest";
import { formatModelUse } from "../../src/orchestration/model-use.js";
import { outcomeModelUse } from "../../src/orchestrator/spawn.js";

describe("formatModelUse", () => {
  it("names the session's model and thinking level", () => {
    expect(formatModelUse({ model: "openai/gpt-5", thinking: "high" })).toBe("openai/gpt-5 · thinking high");
    expect(formatModelUse({ model: "openai/gpt-5", thinking: "off", answered: { "openai/gpt-5": 4 } })).toBe("openai/gpt-5 · thinking off");
  });
  it("lists every model that answered, with its responses, when there was more than one or another than the session's", () => {
    expect(formatModelUse({ model: "openai/gpt-5", thinking: "high", answered: { "openai/gpt-5": 3, "openai/gpt-5-mini": 1 } })).toBe("openai/gpt-5 ×3, openai/gpt-5-mini ×1 · thinking high");
    expect(formatModelUse({ model: "openai/gpt-5", thinking: "high", answered: { "openai/gpt-5-mini": 2 } })).toBe("openai/gpt-5-mini ×2 (session model openai/gpt-5) · thinking high");
    expect(formatModelUse({ model: "openai/gpt-5", thinking: "high", answered: { "openai/gpt-5": 0 } })).toBe("openai/gpt-5 · thinking high");
  });
  it("says unknown instead of guessing", () => {
    expect(formatModelUse({})).toBe("model unknown · thinking unknown");
    expect(formatModelUse({ model: "openai/gpt-5" })).toBe("openai/gpt-5 · thinking unknown");
    expect(formatModelUse({ thinking: "low", answered: { "a/b": 1 } })).toBe("a/b ×1 · thinking low");
  });
  it("shows a sub-worker whose session never started as unknown, not as the model it was routed to", () => {
    expect(outcomeModelUse({ model: "a/routed", thinking: "high", models: {}, notStarted: true })).toBe("model unknown · thinking unknown");
    expect(outcomeModelUse({ model: "a/ran", thinking: "low", models: { "a/ran": 2 } })).toBe("a/ran · thinking low");
  });
});
