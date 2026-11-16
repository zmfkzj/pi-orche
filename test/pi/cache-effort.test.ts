import { describe, expect, it } from "vitest";
import {
  guardedThinkingLevel, lockedEffort, needsCacheEffortProtection,
  observeEffortRequest, preserveAnthropicToolLoopEffort, supportsCachePreservingEffort,
} from "../../src/pi/cache-effort.js";
import { beginThinking, setThinkingPhase } from "../../src/pi/thinking-state.js";

const proxyClaude = { provider: "cliproxyapi", id: "claude-opus-5-5", api: "cliproxyapi-codex-responses" };
const proxyGPT = { provider: "cliproxyapi", id: "gpt-6.1-sol", api: "cliproxyapi-codex-responses", compat: { supportsMidConvoEffort: true } };
const nativeClaude = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", compat: { supportsMidConvoEffort: true } };
const other = { provider: "google", id: "gemini-3.1-pro", api: "google-generative-ai" };

describe("prompt-cache-preserving effort capability", () => {
  it("delegates GPT-6 changes to CPA's configuration_update provider implementation", () => {
    expect(supportsCachePreservingEffort(proxyGPT)).toBe(true);
    expect(supportsCachePreservingEffort({ ...proxyGPT, compat: { supportsMidConvoEffort: false } })).toBe(false);
  });

  it("delegates native Anthropic effort-only system messages to Pi", () => {
    expect(supportsCachePreservingEffort(nativeClaude)).toBe(true);
    expect(supportsCachePreservingEffort(proxyClaude)).toBe(false);
    expect(supportsCachePreservingEffort({ ...nativeClaude, api: "cliproxyapi-codex-responses" })).toBe(false);
  });

  it("protects cache-eligible providers, not Gemini or local backends", () => {
    expect(needsCacheEffortProtection(proxyClaude)).toBe(true);
    expect(needsCacheEffortProtection(other)).toBe(false);
    const session = {};
    observeEffortRequest(session, other, "high");
    expect(lockedEffort(session, other)).toBeUndefined();
    expect(guardedThinkingLevel(session, other, "low")).toBe("low");
  });

  it("locks a warm Claude proxy session at its first requested effort, resetting on model change", () => {
    const session = {};
    observeEffortRequest(session, proxyClaude, "high");
    expect(lockedEffort(session, proxyClaude)).toBe("high");
    expect(guardedThinkingLevel(session, proxyClaude, "low")).toBe("high");
    observeEffortRequest(session, proxyClaude, "low");
    expect(lockedEffort(session, proxyClaude)).toBe("high");
    const nextModel = { ...proxyClaude, id: "claude-sonnet-5-5" };
    expect(guardedThinkingLevel(session, nextModel, "low")).toBe("low");
    observeEffortRequest(session, nextModel, "low");
    expect(lockedEffort(session, nextModel)).toBe("low");
    expect(lockedEffort(session, proxyClaude)).toBeUndefined();
  });

  it("keeps the lock isolated to each worker session", () => {
    const a = {}, b = {};
    observeEffortRequest(a, proxyClaude, "high");
    observeEffortRequest(b, proxyClaude, "low");
    expect(guardedThinkingLevel(a, proxyClaude, "low")).toBe("high");
    expect(guardedThinkingLevel(b, proxyClaude, "high")).toBe("low");
  });

  it("defers native Claude effort-only markers across tool_result-only turns without editing history", () => {
    const session = {};
    const user = { role: "user", content: "initial question" };
    const marker = (effort: string) => ({ role: "system", content: [], output_config: { effort } });
    const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "result" }] };
    observeEffortRequest(session, nativeClaude, "high");
    const first = { messages: [user, marker("high")], output_config: { effort: "low" } };
    expect(preserveAnthropicToolLoopEffort(session, nativeClaude, first)).toBeUndefined();
    const later = { messages: [user, { role: "assistant", content: [{ type: "tool_use", id: "tool_1" }] }, toolResult, marker("low")], output_config: { effort: "low" } };
    const safe = preserveAnthropicToolLoopEffort(session, nativeClaude, later) as typeof later;
    expect(safe.messages.at(-1)).toEqual(marker("high"));
    expect(safe.output_config).toEqual({ effort: "low" });
    expect(later.messages.at(-1)).toEqual(marker("low")); // no mutation
    const realUser = { messages: [...later.messages.slice(0, -1), { role: "user", content: "follow-up" }, marker("low")] };
    expect(preserveAnthropicToolLoopEffort(session, nativeClaude, realUser)).toBeUndefined();
    const anotherTool = { messages: [...realUser.messages.slice(0, -1), toolResult, marker("high")] };
    const delayed = preserveAnthropicToolLoopEffort(session, nativeClaude, anotherTool) as typeof anotherTool;
    expect(delayed.messages.at(-1)).toEqual(marker("low"));
  });

  it("records actual high effort through a native Claude tool loop and changes at a fresh assignment", () => {
    const session = {
      model: nativeClaude,
      thinkingLevel: "high",
      getAvailableThinkingLevels: () => ["low", "medium", "high"],
      setThinkingLevel(level: never) { session.thinkingLevel = level; },
    };
    beginThinking(session);
    observeEffortRequest(session, nativeClaude, "high");
    setThinkingPhase(session, "read", "read node");
    expect(session.thinkingLevel).toBe("high"); // tool_result-only request is still high
    setThinkingPhase(session, "step", "ordinary node");
    expect(session.thinkingLevel).toBe("high");
    beginThinking(session, "low"); // the next assignment will send real user input
    expect(session.thinkingLevel).toBe("low");
  });

  it("prevents switching between disabled and adaptive thinking in a warm native Claude session", () => {
    const active = {};
    observeEffortRequest(active, nativeClaude, "high");
    expect(guardedThinkingLevel(active, nativeClaude, "off")).toBe("high");
    expect(lockedEffort(active, nativeClaude, "off")).toBe("high");
    const disabled = {};
    observeEffortRequest(disabled, nativeClaude, "off");
    expect(guardedThinkingLevel(disabled, nativeClaude, "high")).toBe("off");
  });

  it("retains a warm Claude proxy prefix through read-node / phase effort changes", () => {
    const session = {
      model: proxyClaude,
      thinkingLevel: "high",
      getAvailableThinkingLevels: () => ["low", "medium", "high", "xhigh"],
      setThinkingLevel(level: never) { session.thinkingLevel = level; },
    };
    beginThinking(session);
    observeEffortRequest(session, session.model, "high");
    setThinkingPhase(session, "read", "read N1");
    expect(session.thinkingLevel).toBe("high");
    setThinkingPhase(session, "step", "step N2");
    expect(session.thinkingLevel).toBe("high");
    setThinkingPhase(session, "baseline", "integrate");
    expect(session.thinkingLevel).toBe("high");
  });

  it("permits the same transitions when the provider advertises configuration_update", () => {
    const session = {
      model: proxyGPT,
      thinkingLevel: "high",
      getAvailableThinkingLevels: () => ["low", "medium", "high", "xhigh"],
      setThinkingLevel(level: never) { session.thinkingLevel = level; },
    };
    beginThinking(session);
    observeEffortRequest(session, session.model, "high");
    setThinkingPhase(session, "read", "read N1");
    expect(session.thinkingLevel).toBe("low");
    setThinkingPhase(session, "baseline", "integrate");
    expect(session.thinkingLevel).toBe("high");
  });
});
