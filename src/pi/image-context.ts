import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Token limits do not bound the base64 bytes carried by screenshots. `maxImages`/`maxBase64Bytes` are the hard ceiling of one
 * request; when the tool images since the last pruning point exceed either, the request keeps only the newest suffix that fits
 * `keepImages`/`keepBase64Bytes` (the low-water marks), and that pruning point stays put until the ceiling is reached again.
 * Pruning in batches keeps the projected prefix of consecutive requests identical between pruning points, so the provider's
 * prompt cache is reused; a rolling window (`keep* = max*`) changes an early part of the prefix with every new image.
 */
export interface ImageContextLimits { maxImages: number; maxBase64Bytes: number; keepImages?: number; keepBase64Bytes?: number }
export const IMAGE_CONTEXT_LIMITS = { maxImages: 8, maxBase64Bytes: 8 * 1024 * 1024, keepImages: 4, keepBase64Bytes: 4 * 1024 * 1024 } as const;
export const OMITTED_TOOL_IMAGE = "[Earlier tool image omitted from this request to limit payload size. The original remains in session history. Re-read a saved image or take a fresh observation if needed; do not repeat a state-changing action.]";

const isReasoning = (block: { type: string }): boolean =>
  ["thinking", "redacted-thinking", "redacted_thinking", "reasoning"].includes(block.type);

/**
 * Index (into the chronological list of tool images) of the oldest image a request keeps. Replayed from the first image on, so
 * it depends only on the history (no stored state survives a reload/rebase): the pruning point moves only when the images since it
 * exceed a ceiling, then jumps forward to the newest suffix within the low-water marks. The newest image is always kept, even
 * when it alone is over the byte budget. With keep* = max* this is exactly the newest contiguous suffix within max*.
 */
export function keptImageStart(sizes: readonly number[], limits: ImageContextLimits): number {
  const keepImages = limits.keepImages ?? limits.maxImages, keepBytes = limits.keepBase64Bytes ?? limits.maxBase64Bytes;
  let start = 0, bytes = 0;
  for (let i = 0; i < sizes.length; i++) {
    bytes += sizes[i]!;
    if (i - start + 1 <= limits.maxImages && bytes <= limits.maxBase64Bytes) continue;
    while (start < i && (i - start + 1 > keepImages || bytes > keepBytes)) bytes -= sizes[start++]!;
  }
  return start;
}

/**
 * Request-only, provider-neutral image budget, independent of assignment boundaries and token compaction.
 * Keep a contiguous newest suffix of tool images chosen by {@link keptImageStart}; user attachments, tool text and raw history
 * are untouched.
 *
 * Removing input invalidates downstream signed reasoning. Conservatively omit that reasoning and its Responses
 * item IDs (not call IDs), as assignment projection does, keeping every call/result pair and all assistant text.
 */
export function projectImageContext<T extends readonly AgentMessage[]>(
  messages: T,
  limits: ImageContextLimits = IMAGE_CONTEXT_LIMITS,
): T | AgentMessage[] {
  for (const [name, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if ((limits.keepImages ?? 0) > limits.maxImages) throw new RangeError("keepImages must not exceed maxImages");
  if ((limits.keepBase64Bytes ?? 0) > limits.maxBase64Bytes) throw new RangeError("keepBase64Bytes must not exceed maxBase64Bytes");
  const positions: { index: number; block: number; size: number }[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "toolResult") continue;
    message.content.forEach((block, blockIndex) => {
      // Base64 is ASCII: its string length is its serialized data byte count (not decoded image bytes).
      if (block.type === "image") positions.push({ index, block: blockIndex, size: block.data.length });
    });
  }
  const start = keptImageStart(positions.map(position => position.size), limits);
  const omitted = new Map<number, Set<number>>();
  for (const position of positions.slice(0, start)) {
    let indices = omitted.get(position.index);
    if (!indices) omitted.set(position.index, indices = new Set());
    indices.add(position.block);
  }
  const earliest = start ? positions[0]!.index : messages.length;
  if (!omitted.size) return messages;

  const calls = new Map<string, string>();
  return messages.map((message, index) => {
    if (message.role === "assistant") {
      const removeReasoning = index > earliest && message.content.some(isReasoning);
      let changed = false;
      const content = message.content.flatMap<(typeof message.content)[number]>(block => {
        if (removeReasoning && isReasoning(block)) { changed = true; return []; }
        if (block.type !== "toolCall") return [block];
        const id = removeReasoning ? block.id.split("|")[0]! : block.id;
        // Track each occurrence: providers may reuse call IDs.
        calls.set(block.id, id);
        if (id === block.id) return [block];
        changed = true;
        return [{ ...block, id }];
      });
      return changed ? structuredClone({ ...message, content: content.length ? content : [{ type: "text" as const, text: "[earlier reasoning omitted]" }] }) : message;
    }
    if (message.role !== "toolResult") return message;
    const indices = omitted.get(index);
    const toolCallId = calls.get(message.toolCallId) ?? message.toolCallId;
    if (!indices && toolCallId === message.toolCallId) return message;
    return structuredClone({
      ...message, toolCallId,
      content: message.content.map((block, blockIndex) => indices?.has(blockIndex) ? { type: "text" as const, text: OMITTED_TOOL_IMAGE } : block),
    });
  });
}
