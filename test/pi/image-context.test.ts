import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as assistant, type ImageContent, type ToolCall, type ToolResultMessage, type ThinkingContent } from "@earendil-works/pi-ai";
import { createAssignmentProjector } from "../../src/pi/context-projection.js";
import { IMAGE_CONTEXT_LIMITS, OMITTED_TOOL_IMAGE, keptImageStart, projectImageContext } from "../../src/pi/image-context.js";

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

describe("tool-image request budget (rolling semantics when keep* = max*)", () => {
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
    // Batched default: pruned to 4 at image 9, 14, …, 74, then 3 more appended (75, 76, 77) → 7 images, never above 8.
    expect(images(projected)).toHaveLength(7);
    expect(images(projected).reduce((sum, b) => sum + b.data.length, 0)).toBe(7 * 431_324);
    expect((projected.at(-1) as ToolResultMessage).toolCallId).toBe("76");
    const rolling = projectImageContext(raw, { maxImages: IMAGE_CONTEXT_LIMITS.maxImages, maxBase64Bytes: IMAGE_CONTEXT_LIMITS.maxBase64Bytes });
    expect(images(rolling)).toHaveLength(8);
    expect(images(rolling).reduce((sum, b) => sum + b.data.length, 0)).toBe(3_450_592);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid budgets: %s", value => {
    expect(() => projectImageContext([], limits(value))).toThrow(RangeError);
    expect(() => projectImageContext([], limits(8, value))).toThrow(RangeError);
  });

  it("rejects low-water marks above the ceiling", () => {
    expect(() => projectImageContext([], { maxImages: 4, maxBase64Bytes: 100, keepImages: 5 })).toThrow(RangeError);
    expect(() => projectImageContext([], { maxImages: 4, maxBase64Bytes: 100, keepBase64Bytes: 101 })).toThrow(RangeError);
    expect(() => projectImageContext([], { maxImages: 4, maxBase64Bytes: 100, keepImages: 0 })).toThrow(RangeError);
  });
});

/** Reference rolling window: the newest contiguous suffix within both ceilings, the newest image always kept. */
function rollingStart(sizes: number[], maxImages: number, maxBytes: number): number {
  let start = sizes.length, bytes = 0;
  for (let i = sizes.length - 1; i >= 0; i--) {
    if (start < sizes.length && (sizes.length - i > maxImages || bytes + sizes[i]! > maxBytes)) break;
    bytes += sizes[i]!; start = i;
  }
  return start;
}

describe("batched tool-image pruning (default 8 → 4 images, 8 MB → 4 MB)", () => {
  const limits8to4 = { maxImages: 8, maxBase64Bytes: 1000, keepImages: 4, keepBase64Bytes: 500 };

  it("keeps all images up to the ceiling, then prunes to the low-water mark and holds that point until the ceiling again", () => {
    const kept = Array.from({ length: 20 }, (_, n) => (n + 1) - keptImageStart(Array(n + 1).fill(1), limits8to4));
    expect(kept).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 4, 5, 6, 7, 8, 4, 5, 6, 7, 8, 4, 5]);
    expect(IMAGE_CONTEXT_LIMITS).toMatchObject({ maxImages: 8, keepImages: 4, maxBase64Bytes: 8 * 1024 * 1024, keepBase64Bytes: 4 * 1024 * 1024 });
  });

  it("equals the rolling window when keep* equal the ceilings (random sizes, the newest image always kept)", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 300; trial++) {
      const sizes = Array.from({ length: 1 + Math.floor(random() * 30) }, () => 1 + Math.floor(random() * 400));
      const maxImages = 1 + Math.floor(random() * 9), maxBytes = 1 + Math.floor(random() * 1200);
      for (let n = 1; n <= sizes.length; n++) {
        expect(keptImageStart(sizes.slice(0, n), { maxImages, maxBase64Bytes: maxBytes })).toBe(rollingStart(sizes.slice(0, n), maxImages, maxBytes));
      }
    }
  });

  it("never exceeds either ceiling, always keeps the newest image and only moves the pruning point forward", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 200; trial++) {
      const sizes = Array.from({ length: 40 }, () => 1 + Math.floor(random() * 300));
      let previous = 0;
      for (let n = 1; n <= sizes.length; n++) {
        const start = keptImageStart(sizes.slice(0, n), limits8to4);
        expect(start).toBeLessThan(n);
        expect(start).toBeGreaterThanOrEqual(previous);
        const bytes = sizes.slice(start, n).reduce((a, b) => a + b, 0);
        expect(n - start).toBeLessThanOrEqual(8);
        if (n - start > 1) expect(bytes).toBeLessThanOrEqual(1000);
        previous = start;
      }
    }
    // A single image over every budget is still kept, alone.
    expect(keptImageStart([10, 5000], limits8to4)).toBe(1);
  });

  it("prunes by bytes to the byte low-water mark", () => {
    // 300-byte images: the 4th exceeds 1000 bytes → keep the newest suffix within 500 bytes (one image).
    expect([1, 2, 3, 4, 5].map(n => n - keptImageStart(Array(n).fill(300), limits8to4))).toEqual([1, 2, 3, 1, 2]);
  });

  it("keeps the projected prefix of consecutive requests identical between pruning points (prompt-cache reuse)", () => {
    const history: AgentMessage[] = [user("start")];
    const projections: AgentMessage[][] = [];
    for (let i = 0; i < 18; i++) {
      history.push(assistant([thinking(`step ${i}`), call(`c${i}|fc_${i}`)]), result(`c${i}|fc_${i}`, `img${i}`));
      projections.push(structuredClone(projectImageContext(history, limits8to4)) as AgentMessage[]);
    }
    const prunedAt = new Set([8, 13]); // 0-based request index whose newest image is the 9th / 14th
    for (let i = 1; i < projections.length; i++) {
      const before = projections[i - 1]!, now = projections[i]!;
      const stable = JSON.stringify(now.slice(0, before.length)) === JSON.stringify(before);
      expect(stable).toBe(!prunedAt.has(i));
    }
    // Rolling rewrites an earlier part of the prompt at every image after the 8th.
    const rolling: AgentMessage[][] = [];
    const raw: AgentMessage[] = [user("start")];
    for (let i = 0; i < 18; i++) {
      raw.push(assistant([thinking(`step ${i}`), call(`c${i}|fc_${i}`)]), result(`c${i}|fc_${i}`, `img${i}`));
      rolling.push(structuredClone(projectImageContext(raw, { maxImages: 8, maxBase64Bytes: 1000 })) as AgentMessage[]);
    }
    const rollingBreaks = rolling.slice(1).filter((now, i) => JSON.stringify(now.slice(0, rolling[i]!.length)) !== JSON.stringify(rolling[i])).length;
    expect(rollingBreaks).toBe(10);
  });

  it("is a pure function of the history: idempotent, unchanged by reload, and re-evaluated after a rebase", () => {
    const raw = Array.from({ length: 11 }, (_, i) => result(`r${i}`, `d${i}`));
    const first = projectImageContext(raw, limits8to4);
    expect(images(first).map(b => b.data)).toEqual(["d5", "d6", "d7", "d8", "d9", "d10"]);
    expect(projectImageContext(first, limits8to4)).toBe(first);
    expect(projectImageContext(structuredClone(raw), limits8to4)).toEqual(first);
    const rebased = [user("summary"), ...raw.slice(9)];
    expect(projectImageContext(rebased, limits8to4)).toBe(rebased);
  });

  it("drops reasoning after the earliest omitted image exactly as the rolling window does", () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) history.push(assistant([thinking(`t${i}`), call(`c${i}|fc_${i}`)]), result(`c${i}|fc_${i}`, `img${i}`));
    const projected = projectImageContext(history, limits8to4) as AgentMessage[];
    expect(projected[0]).toBe(history[0]);
    for (let i = 2; i < projected.length; i += 2) {
      const message = projected[i] as ReturnType<typeof assistant>;
      expect(message.content.some(block => block.type === "thinking")).toBe(false);
      expect((projected[i + 1] as ToolResultMessage).toolCallId).toBe(`c${i / 2}`);
    }
    expect(images(projected).map(b => b.data)).toEqual(["img5", "img6", "img7", "img8", "img9"]);
  });
});
