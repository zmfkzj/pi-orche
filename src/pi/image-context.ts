import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Token limits do not bound the base64 bytes carried by screenshots. */
export const IMAGE_CONTEXT_LIMITS = { maxImages: 8, maxBase64Bytes: 8 * 1024 * 1024 } as const;
export const OMITTED_TOOL_IMAGE = "[Earlier tool image omitted from this request to limit payload size. The original remains in session history. Re-read a saved image or take a fresh observation if needed; do not repeat a state-changing action.]";

const isReasoning = (block: { type: string }): boolean =>
  ["thinking", "redacted-thinking", "redacted_thinking", "reasoning"].includes(block.type);

/**
 * Request-only, provider-neutral rolling budget, independent of assignment boundaries and token compaction.
 * Keep the newest contiguous suffix of tool images; user attachments, tool text and raw history are untouched.
 * Always keep the newest tool image, even if that single image exceeds the byte budget: this bounds accumulated
 * history, not an individually oversized attachment. There is no mutable index state to survive a rebase/reload.
 *
 * Removing input invalidates downstream signed reasoning. Conservatively omit that reasoning and its Responses
 * item IDs (not call IDs), as assignment projection does, keeping every call/result pair and all assistant text.
 */
export function projectImageContext<T extends readonly AgentMessage[]>(
  messages: T,
  limits: { maxImages: number; maxBase64Bytes: number } = IMAGE_CONTEXT_LIMITS,
): T | AgentMessage[] {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const omitted = new Map<number, Set<number>>();
  let kept = 0, bytes = 0, full = false, earliest = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult") continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.content[blockIndex]!;
      if (block.type !== "image") continue;
      // Base64 is ASCII: its string length is its serialized data byte count (not decoded image bytes).
      if (!kept || (!full && kept < limits.maxImages && bytes + block.data.length <= limits.maxBase64Bytes)) {
        kept++;
        bytes += block.data.length;
      } else {
        full = true;
        let indices = omitted.get(index);
        if (!indices) omitted.set(index, indices = new Set());
        indices.add(blockIndex);
        earliest = index;
      }
    }
  }
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
