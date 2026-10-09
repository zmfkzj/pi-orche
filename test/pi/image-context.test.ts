import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as assistant, type ImageContent, type ToolCall, type ToolResultMessage, type ThinkingContent } from "@earendil-works/pi-ai";
import { createAssignmentProjector } from "../../src/pi/context-projection.js";
import { IMAGE_CONTEXT_LIMITS, OMITTED_TOOL_IMAGE, projectImageContext } from "../../src/pi/image-context.js";

const user = (text = "continue"): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const image = (data = "AAAA"): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const result = (id: string, data = "AAAA"): ToolResultMessage => ({
  role: "toolResult", toolCallId: id, toolName: "mcp__computer_use__act", content: [{ type: "text", text: `Observed ${id}; screenshot: /tmp/${id}.png` }, image(data)], isError: false, timestamp: 2,
});
const call = (id: string): ToolCall => ({ type: "toolCall", id, name: "mcp__computer_use__act", arguments: { action: "click", x: 20 }, thoughtSignature: "call-metadata" });
const thinking = (text = "reason"): ThinkingContent => ({ type: "thinking", thinking: text, thinkingSignature: "signed" });
const images = (messages: readonly AgentMessage[]) => messages.flatMap(m => m.role === "toolResult" ? m.content.filter(b => b.type === "image") : []);
const limits = (maxImages: number, maxBase64Bytes = 1000) => ({ maxImages, maxBase64Bytes });
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

describe("rolling tool-image request budget", () => {
  it("is byte-identical at the count/byte boundary and a no-op on text-only/empty context", () => {
    for (const messages of [[], [user(), assistant([thinking()])], [result("a"), result("b")]] as AgentMessage[][]) {
      expect(projectImageContext(messages, limits(2, 8))).toBe(messages);
    }
    const defaults = Array.from({ length: IMAGE_CONTEXT_LIMITS.maxImages }, (_, i) => result(`${i}`));
    expect(projectImageContext(defaults)).toBe(defaults);
  });

  it("limits images inside one assignment, preserving text, errors, metadata and message order", () => {
    const first = { ...result("a"), isError: true, details: { observed: true } };
    const messages = [user(), first, result("b"), result("c"), assistant("keep conclusion")];
    const projected = projectImageContext(messages, limits(2));
    expect(projected.map(m => m.role)).toEqual(messages.map(m => m.role));
    expect(images(projected)).toEqual(images(messages).slice(-2));
    expect(projected[1]).toEqual({ ...first, content: [first.content[0], { type: "text", text: OMITTED_TOOL_IMAGE }] });
    expect(projected[0]).toBe(messages[0]);
    expect(projected.slice(2)).toEqual(messages.slice(2));
    expect(OMITTED_TOOL_IMAGE).toContain("do not repeat a state-changing action");
  });

  it("bounds encoded bytes before count, not decoded bytes, and keeps a contiguous newest suffix", () => {
    const messages = [result("tiny", "AAAA"), result("large", "B".repeat(12)), result("new", "CCCC")];
    // Decoded data would fit; 16 encoded bytes do not. Do not skip the middle image and revive older images.
    const projected = projectImageContext(messages, limits(8, 12));
    expect(images(projected)).toEqual([image("CCCC")]);
    expect(images(projectImageContext(messages, limits(8, 16)))).toEqual([image("B".repeat(12)), image("CCCC")]);
  });

  it("always keeps the newest image even if it alone is over budget", () => {
    const latest = result("new", "Z".repeat(32));
    expect(projectImageContext([latest], limits(1, 4))[0]).toBe(latest);
    expect(images(projectImageContext([result("old"), latest], limits(8, 4)))).toEqual([image("Z".repeat(32))]);
  });

  it("handles multi-image and image-only results without empty content, and preserves user attachments", () => {
    const attached: AgentMessage = { role: "user", content: [image("user-image"), { type: "text", text: "Compare these" }], timestamp: 0 };
    const multi = result("multi");
    multi.content = [image("first"), { type: "text", text: "caption" }, image("second"), image("third")];
    const single = result("old"); single.content = [image("old")];
    const projected = projectImageContext([attached, single, multi], limits(2));
    expect(projected[0]).toBe(attached);
    expect((projected[1] as ToolResultMessage).content).toEqual([{ type: "text", text: OMITTED_TOOL_IMAGE }]);
    expect((projected[2] as ToolResultMessage).content).toEqual([{ type: "text", text: OMITTED_TOOL_IMAGE }, { type: "text", text: "caption" }, image("second"), image("third")]);
  });

  it("drops affected reasoning and paired Responses item IDs, including repeated IDs and non-image results", () => {
    const first = assistant([thinking("before"), call("same|fc_same")]);
    const later = assistant([thinking("after"), { type: "text", text: "keep explanation", textSignature: "keep-text" }, call("same|fc_same"), call("plain|fc_plain")]);
    const small = result("plain|fc_plain"); small.content = [{ type: "text", text: "small" }];
    const latest = assistant([call("same|fc_same")]); // no removed reasoning: keep its own ID, not the prior rewrite
    const messages = [first, result("same|fc_same"), later, result("same|fc_same"), small, assistant([thinking("only")]), latest, result("same|fc_same")];
    const projected = projectImageContext(messages, limits(1));
    expect(projected[0]).toBe(first);
    expect((projected[1] as ToolResultMessage).toolCallId).toBe("same|fc_same");
    expect((projected[2] as typeof later).content).toEqual([
      { type: "text", text: "keep explanation", textSignature: "keep-text" }, { ...call("same|fc_same"), id: "same" }, { ...call("plain|fc_plain"), id: "plain" },
    ]);
    expect((projected[3] as ToolResultMessage).toolCallId).toBe("same");
    expect((projected[4] as ToolResultMessage).toolCallId).toBe("plain");
    expect((projected[5] as typeof later).content).toEqual([{ type: "text", text: "[earlier reasoning omitted]" }]);
    expect(projected[6]).toBe(latest);
    expect((projected[7] as ToolResultMessage).toolCallId).toBe("same|fc_same");
  });

  it("handles raw legacy reasoning shapes and retains native Anthropic call IDs", () => {
    const later = assistant([thinking(""), call("toolu_next")]);
    (later.content as unknown[]).push({ type: "redacted-thinking", data: "secret" }, { type: "redacted_thinking", data: "secret" }, { type: "reasoning", encrypted_content: "secret" });
    const projected = projectImageContext([result("old"), later, result("toolu_next")], limits(1));
    expect((projected[1] as typeof later).content).toEqual([call("toolu_next")]);
    expect((projected[2] as ToolResultMessage).toolCallId).toBe("toolu_next");
  });

  it("never mutates frozen raw history and isolates changed messages from downstream mutation", () => {
    const raw = freeze([result("old"), assistant([thinking(), call("next|fc_next")]), result("next|fc_next")]);
    const original = JSON.stringify(raw);
    const projected = projectImageContext(raw, limits(1));
    ((projected[0] as ToolResultMessage).content[0] as { text: string }).text = "mutated";
    ((projected[1] as ReturnType<typeof assistant>).content[0] as ToolCall).arguments.x = 99;
    expect(JSON.stringify(raw)).toBe(original);
    expect(JSON.stringify(projectImageContext(raw, limits(1)))).not.toContain("mutated");
  });

  it("is deterministic, idempotent, and re-evaluates rolling images after append or compaction/rebase", () => {
    const raw = [result("one", "one"), result("two", "two"), result("three", "three")];
    const first = projectImageContext(raw, limits(2));
    expect(projectImageContext(first, limits(2))).toBe(first);
    expect(projectImageContext(raw, limits(2))).toEqual(first);
    raw.push(result("four", "four"));
    expect(images(projectImageContext(raw, limits(2)))).toEqual([image("three"), image("four")]);
    const rebased = [user("summary"), result("one", "new bytes")];
    expect(projectImageContext(rebased, limits(2))).toBe(rebased);
  });

  it("composes after assignment clears even when clearing is disabled or reset", () => {
    const assignment = createAssignmentProjector();
    const raw: AgentMessage[] = [result("old")];
    assignment.beginAssignment(raw, 1, { minClearTokens: 0 });
    raw.push(user(), result("one", "one"), result("two", "two"));
    const projected = projectImageContext(assignment.project(raw), limits(1));
    expect(JSON.stringify(projected[0])).toContain("Earlier mcp__computer_use__act result cleared");
    expect(images(projected)).toEqual([image("two")]);
    assignment.reset();
    assignment.beginAssignment(raw, raw.length, { enabled: false });
    expect(images(projectImageContext(assignment.project(raw), limits(1)))).toEqual([image("two")]);
  });

  it("reduces an incident-shaped 77-image/33MB request without modifying the original", () => {
    const raw = Array.from({ length: 77 }, (_, i) => result(`${i}`, "A".repeat(431_324)));
    const projected = projectImageContext(raw);
    expect(images(raw)).toHaveLength(77);
    expect(images(projected)).toHaveLength(8);
    expect(images(projected).reduce((sum, b) => sum + b.data.length, 0)).toBe(3_450_592);
    expect((projected.at(-1) as ToolResultMessage).toolCallId).toBe("76");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid budgets: %s", value => {
    expect(() => projectImageContext([], limits(value))).toThrow(RangeError);
    expect(() => projectImageContext([], limits(8, value))).toThrow(RangeError);
  });
});
