import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** One original result. The position disambiguates providers that reuse call IDs. */
export interface ClearCandidate {
  key: string;
  index: number;
  toolCallId: string;
  toolName: string;
  textChars: number;
  images: number;
  estTokens: number;
  placeholder: string;
}

export interface ContextClearedStats {
  /** Newly cleared results and their original estimated size, not lifetime totals. */
  results: number;
  estTokens: number;
  /** Newly omitted reasoning blocks, not lifetime totals. */
  thinkingBlocks: number;
}

export interface AssignmentProjectionPlan {
  cleared: ReadonlyMap<string, ClearCandidate>;
  newlyCleared: ReadonlyMap<string, ClearCandidate>;
  omittedReasoning: ReadonlySet<string>;
  /** Original position:callId -> callId without the Responses item ID. */
  idRewrites: ReadonlyMap<string, string>;
  stats: ContextClearedStats;
}

function checkBoundary(messages: readonly AgentMessage[], boundaryIndex: number): void {
  if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex > messages.length) {
    throw new RangeError("boundaryIndex must be an integer transcript position within messages");
  }
}

const resultKey = (index: number, toolCallId: string): string => `${index}:${toolCallId}`;
const isReasoning = (block: { type: string }): boolean =>
  ["thinking", "redacted-thinking", "redacted_thinking", "reasoning"].includes(block.type);

/** Discover eligible original results strictly before the recorded assignment boundary. */
export function findClearCandidates(messages: readonly AgentMessage[], boundaryIndex: number): ClearCandidate[] {
  checkBoundary(messages, boundaryIndex);
  const candidates: ClearCandidate[] = [];
  for (let index = 0; index < boundaryIndex; index++) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || message.toolName === "report_result") continue;
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("");
    const images = message.content.filter(block => block.type === "image").length;
    if (text.length <= 600 && images === 0) continue;
    const artifact = text.match(/\.orche\/artifacts\/[^\s"'`<>\[\]{}(),;]+/)?.[0];
    const size = `${text.length} chars${images ? `, ${images} image${images === 1 ? "" : "s"}` : ""}`;
    candidates.push({
      key: resultKey(index, message.toolCallId), index,
      toolCallId: message.toolCallId, toolName: message.toolName,
      textChars: text.length, images, estTokens: text.length / 4 + images * 1_000,
      placeholder: `[Earlier ${message.toolName} result cleared to save context (${size}). Repeat the call if you need it.${artifact ? ` Full output: ${artifact}` : ""}]`,
    });
  }
  return candidates;
}

/**
 * Plan once at dispatch. Only newly eligible originals count toward the threshold;
 * reaching it clears ALL candidates, never revoking a clear. Reasoning is removed
 * only after the earliest NEW clear, and removals/ID rewrites are cumulative.
 * All positions refer to the same append-only, system-free context transcript.
 */
export function planAssignmentProjection(options: {
  messages: readonly AgentMessage[];
  boundaryIndex: number;
  previouslyCleared?: ReadonlyMap<string, ClearCandidate>;
  previouslyOmittedReasoning?: ReadonlySet<string>;
  previouslyIdRewrites?: ReadonlyMap<string, string>;
  minClearTokens?: number;
}): AssignmentProjectionPlan {
  const { messages, boundaryIndex, minClearTokens = 10_000 } = options;
  if (!Number.isInteger(minClearTokens) || minClearTokens < 0) {
    throw new RangeError("minClearTokens must be a non-negative integer");
  }
  const candidates = findClearCandidates(messages, boundaryIndex);
  const cleared = new Map(options.previouslyCleared);
  const newCandidates = candidates.filter(candidate => !cleared.has(candidate.key));
  const estimate = newCandidates.reduce((sum, candidate) => sum + candidate.estTokens, 0);
  const newlyCleared = new Map<string, ClearCandidate>();
  if (estimate >= minClearTokens) {
    for (const candidate of newCandidates) {
      cleared.set(candidate.key, candidate);
      newlyCleared.set(candidate.key, candidate);
    }
  }
  const earliest = earliestClearedResult(messages, newlyCleared, boundaryIndex);
  const omittedReasoning = new Set(options.previouslyOmittedReasoning);
  const idRewrites = new Map(options.previouslyIdRewrites);
  let thinkingBlocks = 0;
  for (let index = earliest + 1; index < boundaryIndex; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    let removesReasoning = false;
    message.content.forEach((block, blockIndex) => {
      if (!isReasoning(block)) return;
      removesReasoning = true;
      const key = `${index}:${blockIndex}`;
      if (!omittedReasoning.has(key)) {
        omittedReasoning.add(key);
        thinkingBlocks++;
      }
    });
    if (!removesReasoning) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || !block.id.includes("|")) continue;
      // Mirror openai-responses-shared's different-model handling: omit the
      // item ID (fc_/ctc_) to avoid rs_ pairing validation, keep call_id intact.
      idRewrites.set(resultKey(index, block.id), block.id.split("|")[0]!);
    }
  }
  if (newlyCleared.size) {
    // Pair against the latest occurrence, not a global ID map: some providers
    // reuse call IDs. Include small/exempt results as well as cleared results.
    const calls = new Map<string, string>();
    for (let index = 0; index < boundaryIndex; index++) {
      const message = messages[index]!;
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") {
          calls.set(block.id, idRewrites.get(resultKey(index, block.id)) ?? block.id);
        }
      } else if (message.role === "toolResult") {
        const rewritten = calls.get(message.toolCallId);
        if (rewritten !== undefined && rewritten !== message.toolCallId) {
          idRewrites.set(resultKey(index, message.toolCallId), rewritten);
        }
      }
    }
  }
  return {
    cleared, newlyCleared, omittedReasoning, idRewrites,
    stats: { results: newlyCleared.size, estTokens: newlyCleared.size ? estimate : 0, thinkingBlocks },
  };
}

function earliestClearedResult(
  messages: readonly AgentMessage[], cleared: ReadonlyMap<string, ClearCandidate>, boundaryIndex: number,
): number {
  // Verify the key against the actual result; unrelated/rebased messages cannot be cleared.
  for (let index = 0; index < boundaryIndex; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult" && cleared.has(resultKey(index, message.toolCallId))) return index;
  }
  return boundaryIndex;
}

/**
 * Non-persisted projection of exactly the stored clears, reasoning and ID rewrites.
 * No changes returns the input array itself. Unchanged messages retain identity;
 * changed messages are fresh deep copies, never sharing mutable state across calls.
 */
export function applyProjection<T extends readonly AgentMessage[]>(
  messages: T, plan: AssignmentProjectionPlan, boundaryIndex: number,
): T | AgentMessage[] {
  checkBoundary(messages, boundaryIndex);
  if (!plan.cleared.size && !plan.omittedReasoning.size && !plan.idRewrites.size) return messages;
  let projected: AgentMessage[] | undefined;
  for (let index = 0; index < boundaryIndex; index++) {
    const message = messages[index]!;
    let changed: AgentMessage | undefined;
    if (message.role === "toolResult") {
      const candidate = plan.cleared.get(resultKey(index, message.toolCallId));
      const rewritten = plan.idRewrites.get(resultKey(index, message.toolCallId));
      if (candidate || rewritten !== undefined) {
        changed = structuredClone({
          ...message,
          content: candidate ? [{ type: "text", text: candidate.placeholder }] : message.content,
          toolCallId: rewritten ?? message.toolCallId,
        });
      }
    } else if (message.role === "assistant") {
      const content = message.content.flatMap((block, blockIndex) => {
        if (plan.omittedReasoning.has(`${index}:${blockIndex}`)) return [];
        const rewritten = block.type === "toolCall" ? plan.idRewrites.get(resultKey(index, block.id)) : undefined;
        return [rewritten === undefined ? block : { ...block, id: rewritten }];
      });
      if (content.length !== message.content.length || content.some((block, i) => block !== message.content[i])) {
        changed = structuredClone({ ...message, content: content.length ? content : [{ type: "text", text: "[earlier reasoning omitted]" }] });
      }
    }
    if (changed) {
      projected ??= [...messages];
      projected[index] = changed;
    }
  }
  return projected ?? messages;
}

/**
 * Session-local state, with no Pi runtime effects. beginAssignment() must be called
 * once at an exact recorded boundary, with the original system-free transcript.
 * Disabled assignments add no clears; existing projection remains applied.
 * Do not feed projected messages back into beginAssignment() or session persistence.
 */
export function createAssignmentProjector() {
  let boundaryIndex = 0;
  let plan: AssignmentProjectionPlan | undefined;
  return {
    /** Compaction rebases the transcript: suspend projection until the next boundary. */
    reset() { boundaryIndex = 0; plan = undefined; },
    beginAssignment(messages: readonly AgentMessage[], boundary: number, options: {
      enabled?: boolean;
      minClearTokens?: number;
    } = {}): AssignmentProjectionPlan {
      checkBoundary(messages, boundary);
      boundaryIndex = boundary;
      const previous = plan;
      plan = (options.enabled ?? true) ? planAssignmentProjection({
        messages, boundaryIndex, previouslyCleared: previous?.cleared,
        previouslyOmittedReasoning: previous?.omittedReasoning, previouslyIdRewrites: previous?.idRewrites,
        minClearTokens: options.minClearTokens,
      }) : {
        cleared: previous?.cleared ?? new Map(), newlyCleared: new Map(),
        omittedReasoning: previous?.omittedReasoning ?? new Set(), idRewrites: previous?.idRewrites ?? new Map(),
        stats: { results: 0, estTokens: 0, thinkingBlocks: 0 },
      };
      return plan;
    },
    project<T extends readonly AgentMessage[]>(messages: T): T | AgentMessage[] {
      return plan ? applyProjection(messages, plan, boundaryIndex) : messages;
    },
    get plan(): AssignmentProjectionPlan | undefined { return plan; },
  };
}
