import type { ImageCacheAnchor } from "./image-context.js";

/**
 * Explicit prompt-cache breakpoint at the image pruning boundary of Anthropic Messages requests (docs/request-size.md).
 *
 * Pi marks the system prompt, the last tool and the last message block. A prune rewrites the request from the oldest kept
 * image's result on, and that position is far behind any breakpoint Pi wrote, so without a breakpoint of its own the
 * provider serves only the system prompt and tools from cache and every prune rewrites the whole conversation. The anchor puts
 * one more `cache_control` (a copy of Pi's own marker, so the same TTL) on the tool_result block just before that position:
 * every request between two prunes reads and refreshes that entry, and the next prune reads the cached prefix up to it.
 *
 * Anthropic accepts at most four marked blocks; the anchor is added only while fewer are present (Pi's OAuth layout already
 * uses four) and never on a request without markers (caching disabled). A provider error about the limit disables anchors
 * for the session ({@link isCacheControlLimitError}); the retried request is sent without one.
 */
export const MAX_CACHE_CONTROL_BLOCKS = 4;

export interface CacheAnchorState { anchor?: ImageCacheAnchor; disabled: boolean }
export const createCacheAnchorState = (): CacheAnchorState => ({ disabled: false });

type Block = Record<string, unknown> & { type?: unknown; cache_control?: unknown; content?: unknown };
type Message = Record<string, unknown> & { role?: unknown; content?: unknown };

/** Same normalization as Pi's anthropic-messages adapter applies to tool call IDs. */
export const anthropicToolId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const blocksOf = (value: unknown): Block[] => Array.isArray(value) ? value.filter(isObject) as Block[] : [];

/** Marked blocks in system, tools, message blocks and blocks nested in tool results. */
export function countCacheControl(payload: Record<string, unknown>): number {
  let count = 0;
  const visit = (block: Block, nested: boolean) => {
    if (block.cache_control !== undefined) count++;
    if (!nested && block.type === "tool_result") for (const inner of blocksOf(block.content)) visit(inner, true);
  };
  for (const block of blocksOf(payload.system)) visit(block, true);
  for (const tool of blocksOf(payload.tools)) visit(tool, true);
  for (const message of blocksOf(payload.messages) as Message[]) for (const block of blocksOf(message.content)) visit(block, false);
  return count;
}

/** The marker Pi wrote last (message, then system, then tools): copied so the anchor has the same type and TTL. */
function template(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = blocksOf(payload.messages) as Message[];
  for (let m = messages.length - 1; m >= 0; m--) {
    const blocks = blocksOf(messages[m]!.content);
    for (let b = blocks.length - 1; b >= 0; b--) if (isObject(blocks[b]!.cache_control)) return blocks[b]!.cache_control as Record<string, unknown>;
  }
  for (const list of [payload.system, payload.tools]) {
    const marked = blocksOf(list).filter(block => isObject(block.cache_control));
    if (marked.length) return marked.at(-1)!.cache_control as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The payload with the anchor marked, or undefined when nothing changes: not an Anthropic Messages body, no anchor, anchors
 * disabled, caching off, the marker budget full, the anchor result not found, or already marked. The input is never mutated.
 */
export function withCacheAnchor(payload: unknown, state: CacheAnchorState | undefined): unknown {
  const anchor = state?.anchor;
  if (!anchor || state.disabled || !isObject(payload) || !Array.isArray(payload.messages)) return undefined;
  const marker = template(payload);
  if (!marker || countCacheControl(payload) >= MAX_CACHE_CONTROL_BLOCKS) return undefined;
  const ids = new Set([anchor.toolCallId, anthropicToolId(anchor.toolCallId)]);
  let seen = 0;
  const messages = payload.messages as unknown[];
  for (let m = 0; m < messages.length; m++) {
    const message = messages[m];
    if (!isObject(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
    const content = message.content as unknown[];
    for (let b = 0; b < content.length; b++) {
      const block = content[b];
      if (!isObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string" || !ids.has(block.tool_use_id)) continue;
      if (++seen !== anchor.occurrence) continue;
      if (block.cache_control !== undefined) return undefined;
      const nextContent = [...content];
      nextContent[b] = { ...block, cache_control: { ...marker } };
      const nextMessages = [...messages];
      nextMessages[m] = { ...message, content: nextContent };
      return { ...payload, messages: nextMessages };
    }
  }
  return undefined;
}

/** Provider rejection of a request with too many `cache_control` blocks. */
export function isCacheControlLimitError(message: string | undefined): boolean {
  return !!message && /maximum of \d+ blocks with cache_control/i.test(message);
}
