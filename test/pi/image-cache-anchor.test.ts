import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as assistant, type Message, type Model, type ToolCall, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createAssignmentProjector } from "../../src/pi/context-projection.js";
import { IMAGE_CONTEXT_LIMITS, compactionRebase, keptImageStart, planImageContext, type ImageContextLimits } from "../../src/pi/image-context.js";
import { anthropicToolId, countCacheControl, createCacheAnchorState, isCacheControlLimitError, withCacheAnchor } from "../../src/pi/cache-anchor.js";

const call = (id: string): ToolCall => ({ type: "toolCall", id, name: "observe", arguments: {} });
const shot = (id: string, data = "AAAA", timestamp = 2, count = 1): ToolResultMessage => ({
  role: "toolResult", toolCallId: id, toolName: "observe", isError: false, timestamp,
  content: [{ type: "text", text: `frame ${id}` }, ...Array.from({ length: count }, () => ({ type: "image" as const, data, mimeType: "image/png" }))],
});
const text = (id: string, timestamp = 2): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp, content: [{ type: "text", text: `text ${id}` }] });
const turn = (id: string, reasoning = true, timestamp = 2) => ({ ...assistant([...(reasoning ? [{ type: "thinking" as const, thinking: `why ${id}`, thinkingSignature: `sig-${id}` }] : []), call(id)], { stopReason: "toolUse" }), timestamp });
const keptImages = (messages: readonly AgentMessage[]) => messages.reduce((n, m) => n + (m.role === "toolResult" ? m.content.filter(b => b.type === "image").length : 0), 0);
const firstDifference = (before: readonly AgentMessage[], after: readonly AgentMessage[]) => {
  let index = 0;
  while (index < before.length && JSON.stringify(before[index]) === JSON.stringify(after[index])) index++;
  return index;
};

describe("opportunistic low-water trims (keptImageStart)", () => {
  const limits = { maxImages: 8, maxBase64Bytes: 1_000, keepImages: 4, keepBase64Bytes: 1_000 };
  it("trims to the low-water marks once the images exist, only when every kept image lies in the rewritten part", () => {
    const sizes = Array(6).fill(1);
    expect(keptImageStart(sizes, limits)).toBe(0);
    expect(keptImageStart(sizes, limits, [{ images: 6, from: 0 }])).toBe(2);
    expect(keptImageStart(sizes, limits, [{ images: 6, from: 1 }])).toBe(0); // image 0 is still served from cache: keep it
    expect(keptImageStart(sizes, limits, [{ images: 6, from: 1 }, { images: 6, from: 0 }])).toBe(2);
    expect(keptImageStart(sizes, limits, [{ images: 7, from: 0 }, { images: 0, from: 0 }])).toBe(0); // not reached yet / nothing
  });
  it("continues batching from the trimmed point and stays a pure function of the history", () => {
    const sizes = Array(13).fill(1);
    // Trimmed at 6 images to start 2; the ceiling (8 since the pruning point) is next exceeded at image 11 → start 7.
    expect(Array.from({ length: 13 }, (_, n) => keptImageStart(sizes.slice(0, n + 1), limits, [{ images: 6, from: 0 }])))
      .toEqual([0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 7, 7, 7]);
    // Byte-triggered: a trim also enforces keepBase64Bytes, and the newest image survives on its own.
    expect(keptImageStart([400, 400, 400], { ...limits, keepBase64Bytes: 500 }, [{ images: 3, from: 0 }])).toBe(2);
    expect(keptImageStart([900], { ...limits, keepBase64Bytes: 10 }, [{ images: 1, from: 0 }])).toBe(0);
  });
});

/** Raw worker history: every turn calls `observe` (screenshots, sometimes two or a large one) or `read` (text only). */
function history(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "user", content: "One long GUI assignment", timestamp: 1 }];
  for (let n = 0; n < turns; n++) {
    const id = `toolu_${n}`;
    messages.push(turn(id, n % 3 !== 0), n % 5 === 4 ? text(id) : shot(id, n % 7 === 6 ? "B".repeat(600) : "AAAA", 2, n % 4 === 3 ? 2 : 1));
  }
  return messages;
}

describe("image cache anchor", () => {
  it.each<[string, ImageContextLimits]>([
    ["default 8/4", IMAGE_CONTEXT_LIMITS],
    ["count-triggered 5/2", { maxImages: 5, maxBase64Bytes: 100_000, keepImages: 2, keepBase64Bytes: 100_000 }],
    ["byte-triggered", { maxImages: 50, maxBase64Bytes: 1_500, keepImages: 25, keepBase64Bytes: 700 }],
  ])("%s: every later request, prunes included, leaves the previous request unchanged up to its anchor", (_name, limits) => {
    const raw = history(60);
    let previous: ReturnType<typeof planImageContext> | undefined, prunes = 0, anchoredPrunes = 0;
    for (let end = 1; end <= raw.length; end++) {
      if (raw[end - 1]!.role !== "toolResult") continue;
      const plan = planImageContext(raw.slice(0, end), limits);
      const anchor = plan.anchor;
      if (anchor) {
        const target = plan.messages[anchor.index] as ToolResultMessage;
        expect(target.role).toBe("toolResult");
        expect(target.toolCallId).toBe(anchor.toolCallId);
        // Nothing between the anchor and the oldest kept image's result is another tool result.
        const kept = plan.messages.findIndex(m => m.role === "toolResult" && m.content.some(b => b.type === "image"));
        expect(plan.messages.slice(anchor.index + 1, kept).some(m => m.role === "toolResult")).toBe(false);
      }
      if (previous) {
        const changed = firstDifference(previous.messages, plan.messages);
        if (changed < previous.messages.length) {
          prunes++;
          if (previous.anchor) { anchoredPrunes++; expect(changed).toBeGreaterThan(previous.anchor.index); }
        }
      }
      previous = plan;
    }
    expect(prunes).toBeGreaterThan(2);
    expect(anchoredPrunes).toBeGreaterThanOrEqual(prunes - 1); // only the first prune may lack a result before the first image
  });

  it("counts repeated call IDs so the right occurrence is anchored", () => {
    const raw: AgentMessage[] = [{ role: "user", content: "go", timestamp: 1 }];
    for (let n = 0; n < 10; n++) raw.push(turn("same", false), n === 2 ? text("same") : shot("same"));
    const plan = planImageContext(raw, { maxImages: 3, maxBase64Bytes: 1_000, keepImages: 2, keepBase64Bytes: 1_000 });
    expect(plan.anchor).toBeDefined();
    const occurrence = plan.messages.slice(0, plan.anchor!.index + 1).filter(m => m.role === "toolResult").length;
    expect(plan.anchor!.occurrence).toBe(occurrence);
  });

  it("has no anchor without tool images or without an earlier tool result", () => {
    expect(planImageContext([{ role: "user", content: "hi", timestamp: 1 }]).anchor).toBeUndefined();
    expect(planImageContext([turn("a"), text("a")]).anchor).toBeUndefined();
    expect(planImageContext([turn("a"), shot("a")]).anchor).toBeUndefined();
    expect(planImageContext([turn("a"), text("a"), turn("b"), shot("b")]).anchor).toMatchObject({ index: 1, toolCallId: "a", occurrence: 1 });
  });
});

describe("rebases: compaction and assignment clears trim kept images to the low-water marks", () => {
  const summary = (timestamp: number): AgentMessage => ({ role: "compactionSummary", summary: "earlier work", tokensBefore: 500_000, timestamp } as AgentMessage);
  /** After a compaction: the summary, six kept screenshots older than it, then `later` new ones. */
  const compacted = (later: number) => {
    const messages: AgentMessage[] = [summary(100)];
    for (let n = 0; n < 6; n++) messages.push(turn(`k${n}`, true, 50 + n), shot(`k${n}`, "AAAA", 50 + n));
    for (let n = 0; n < later; n++) messages.push(turn(`n${n}`, true, 200 + n), shot(`n${n}`, "AAAA", 200 + n));
    return messages;
  };

  it("derives the compaction rebase from the summary and the kept messages' timestamps", () => {
    expect(compactionRebase(compacted(0))).toEqual({ before: 13, from: 0 });
    expect(compactionRebase(compacted(3))).toEqual({ before: 13, from: 0 });
    expect(compactionRebase(history(4))).toBeUndefined();
  });

  it("keeps 4 of the 6 kept screenshots right after compaction, stably on every later request, and never touches raw history", () => {
    const counts: number[] = [];
    let previous: AgentMessage[] | undefined;
    for (let later = 0; later <= 9; later++) {
      const raw = compacted(later);
      const before = JSON.stringify(raw);
      const plan = planImageContext(raw);
      expect(JSON.stringify(raw)).toBe(before);
      counts.push(keptImages(plan.messages));
      if (previous && keptImages(plan.messages) === keptImages(previous) + 1) expect(firstDifference(previous, plan.messages)).toBe(previous.length);
      previous = plan.messages;
    }
    // Without the trim the first request would carry 6 and prune at the 9th; with it: 4, growing to 8, pruned again to 4.
    expect(counts).toEqual([4, 5, 6, 7, 8, 4, 5, 6, 7, 8]);
    expect(keptImages(planImageContext(compacted(0).filter(m => m.role !== "compactionSummary")).messages)).toBe(6);
  });

  it("an assignment clear trims only kept images after the earliest newly cleared result", () => {
    const raw = history(12);
    const imagesIn = (rebases: { before: number; from: number }[]) => keptImages(planImageContext(raw, IMAGE_CONTEXT_LIMITS, rebases).messages);
    const all = keptImages(raw);
    expect(all).toBeLessThanOrEqual(IMAGE_CONTEXT_LIMITS.maxImages * 2);
    const untrimmed = keptImages(planImageContext(raw).messages);
    expect(imagesIn([{ before: raw.length, from: 0 }])).toBeLessThanOrEqual(IMAGE_CONTEXT_LIMITS.keepImages);
    expect(imagesIn([{ before: raw.length, from: raw.length - 1 }])).toBe(untrimmed);
  });

  it("records a rebase per boundary that newly clears, cumulatively, until compaction resets the projector", () => {
    const projector = createAssignmentProjector();
    const raw: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 }, turn("a"), shot("a"), turn("b"), text("b")];
    projector.beginAssignment(raw, raw.length, { minClearTokens: 0 });
    expect(projector.imageRebases).toEqual([{ before: 5, from: 2 }]);
    raw.push({ role: "user", content: "second", timestamp: 3 }, turn("c"), text("c"));
    projector.beginAssignment(raw, raw.length, { minClearTokens: 1_000_000 }); // below threshold: nothing newly cleared
    expect(projector.imageRebases).toEqual([{ before: 5, from: 2 }]);
    projector.beginAssignment(raw, raw.length, { enabled: false });
    expect(projector.imageRebases).toHaveLength(1);
    projector.reset();
    expect(projector.imageRebases).toEqual([]);
  });
});

const anthropicModel: Model<"anthropic-messages"> = {
  api: "anthropic-messages", provider: "cliproxyapi", id: "claude-test", name: "Claude test", baseUrl: "https://invalid.example",
  reasoning: false, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
async function anthropicPayload(messages: readonly AgentMessage[], cacheRetention?: "none" | "short" | "long", apiKey = "test-key"): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const system = { role: "system", content: "system", toolsAdded: [{ name: "observe", description: "Observe", parameters: { type: "object", properties: {} } }], timestamp: 0 };
  const output = await streamAnthropic(anthropicModel, { messages: [system, ...messages] as Message[] } as unknown as TranscriptContext, {
    apiKey, ...(cacheRetention ? { cacheRetention } : {}),
    onPayload: value => { payload = structuredClone(value) as Record<string, unknown>; throw new Error("stop before transport"); },
  }).result();
  expect(output.errorMessage).toContain("stop before transport");
  return payload!;
}
type WireBlock = { type: string; tool_use_id?: string; cache_control?: unknown };
const wireBlocks = (payload: unknown) => ((payload as { messages: { content: WireBlock[] | string }[] }).messages).flatMap(m => Array.isArray(m.content) ? m.content : []);

describe("anchor marker on Pi's real Anthropic request body (no network)", () => {
  const raw = history(14);
  const plan = planImageContext(raw);
  const state = { ...createCacheAnchorState(), anchor: plan.anchor };

  it("marks the anchor's tool_result with a copy of Pi's marker (same TTL), within four markers, without mutating the input", async () => {
    expect(plan.anchor).toBeDefined();
    const payload = await anthropicPayload(plan.messages, "long");
    expect(countCacheControl(payload)).toBe(3); // system, last tool, last message block
    const before = JSON.stringify(payload);
    const anchored = withCacheAnchor(payload, state) as Record<string, unknown>;
    expect(JSON.stringify(payload)).toBe(before);
    expect(countCacheControl(anchored)).toBe(4);
    const marked = wireBlocks(anchored).filter(b => b.type === "tool_result" && b.cache_control);
    // The anchor plus Pi's own marker on the last block (the newest result).
    expect(marked.map(b => b.tool_use_id)).toEqual([anthropicToolId(plan.anchor!.toolCallId), "toolu_13"]);
    expect(marked[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(withCacheAnchor(anchored, state)).toBeUndefined(); // full budget / already marked: no change
  });

  it("adds nothing when caching is off, the budget is full (OAuth layout), anchors are disabled, or the result is absent", async () => {
    expect(withCacheAnchor(await anthropicPayload(plan.messages, "none"), state)).toBeUndefined();
    const oauth = await anthropicPayload(plan.messages, "short", "sk-ant-oat01-test");
    expect(countCacheControl(oauth)).toBe(4);
    expect(withCacheAnchor(oauth, state)).toBeUndefined();
    const payload = await anthropicPayload(plan.messages, "short");
    expect(withCacheAnchor(payload, { anchor: plan.anchor, disabled: true })).toBeUndefined();
    expect(withCacheAnchor(payload, { disabled: false })).toBeUndefined();
    expect(withCacheAnchor(payload, { disabled: false, anchor: { index: 0, toolCallId: "missing", occurrence: 1 } })).toBeUndefined();
    expect(withCacheAnchor({ input: [{ type: "function_call_output", call_id: plan.anchor!.toolCallId }] }, state)).toBeUndefined();
    expect((wireBlocks(withCacheAnchor(payload, state)).find(b => b.cache_control && b.tool_use_id === plan.anchor!.toolCallId))?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("finds normalized and repeated call IDs", () => {
    const blocks = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] });
    const payload = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [blocks("call_1_fc_1"), blocks("call_1_fc_1"), { role: "user", content: [{ type: "text", text: "t", cache_control: { type: "ephemeral" } }] }] };
    const anchored = withCacheAnchor(payload, { disabled: false, anchor: { index: 9, toolCallId: "call_1|fc_1", occurrence: 2 } });
    expect(wireBlocks(anchored).map(b => !!b.cache_control)).toEqual([false, true, true]);
  });

  it("recognizes the provider's marker-limit rejection", () => {
    expect(isCacheControlLimitError("400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"A maximum of 4 blocks with cache_control may be provided. Found 5.\"}}")).toBe(true);
    expect(isCacheControlLimitError("prompt is too long")).toBe(false);
    expect(isCacheControlLimitError(undefined)).toBe(false);
  });
});
