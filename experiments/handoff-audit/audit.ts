/**
 * Hand-off evidence audit (docs/handoff-evidence.md): reads main session transcripts (pi session JSONL) and worker transcripts
 * (orche records), finds every orche_task hand-off and every orche_spawn sub-worker request, and counts deterministic evidence
 * signals per situation. Aggregates only: no message text leaves this module, and a signal is never a verdict on the
 * requirements (a paraphrase, a concise follow-up or an approved change is not a defect).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { handoffSignals, userTextCarry, type CarryResult, type UserTextCarry } from "../../src/orchestration/handoff-evidence.js";
import { originalRequestOf } from "../../src/single/ledger.js";

/** One parsed JSONL entry, reduced to what the audit needs. */
interface Entry {
  id: string;
  parentId?: string;
  kind: "user" | "assistant" | "toolResult" | "compaction" | "gone" | "result" | "other";
  /** user: the text parts (undefined: no text part, e.g. an image only). */
  text?: string;
  calls?: { id: string; name: string; args: Record<string, unknown> }[];
  /** assistant: how many tool calls of any kind it made. */
  toolCalls?: number;
  /** toolResult: its call and whether it failed; result/toolResult: the text flags the audit reads. */
  toolCallId?: string;
  isError?: boolean;
  unmetNote?: boolean;
  goneId?: string;
  goneNote?: boolean;
}

export interface FileRead { entries: Map<string, Entry>; order: string[]; parseErrors: number; truncatedLast: boolean; /** The session header id (agent_workflow runs: "aw-…"). */ sessionId?: string }

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(part => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []);
  return parts.length ? parts.join("\n") : undefined;
};
/** orche_task hand-offs, orche_task_message relays to a running worker and orche_spawn sub-worker requests. */
const AUDITED_TOOLS = new Set(["orche_task", "orche_task_message", "orche_spawn"]);
const UNMET_NOTE = /unmet in \d+ consecutive assignments/;
const GONE_NOTE = /\bwas gone \(|continues the work of W/;

/** Parse one entry line; undefined for entries the audit ignores entirely (still keeps their tree link). */
export function parseEntry(raw: unknown): Entry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string") return undefined;
  const base = { id: value.id, ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}) };
  if (value.type === "compaction") return { ...base, kind: "compaction" };
  if (value.type === "custom" && value.customType === "orche-worker") {
    const id = (value.data as { id?: unknown } | undefined)?.id;
    return { ...base, kind: "gone", ...(typeof id === "string" ? { goneId: id } : {}) };
  }
  if (value.type === "custom_message" && value.customType === "orche-task-result") {
    const text = textOf(value.content) ?? "";
    return { ...base, kind: "result", unmetNote: UNMET_NOTE.test(text), goneNote: GONE_NOTE.test(text) };
  }
  if (value.type !== "message") return { ...base, kind: "other" };
  const message = value.message as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown; toolName?: unknown } | undefined;
  if (message?.role === "user") {
    const text = textOf(message.content);
    return { ...base, kind: "user", ...(text !== undefined ? { text } : {}) };
  }
  if (message?.role === "assistant") {
    const parts = Array.isArray(message.content) ? message.content as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }[] : [];
    const toolCalls = parts.filter(part => part?.type === "toolCall").length;
    const calls = parts.flatMap(call => call?.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string" && AUDITED_TOOLS.has(call.name)
      ? [{ id: call.id, name: call.name, args: call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {} }] : []);
    return { ...base, kind: "assistant", toolCalls, ...(calls.length ? { calls } : {}) };
  }
  if (message?.role === "toolResult" && (message.toolName === "orche_task" || message.toolName === "orche_spawn" || message.toolName === undefined)) {
    const text = textOf(message.content) ?? "";
    return { ...base, kind: "toolResult", ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}), isError: message.isError === true, unmetNote: UNMET_NOTE.test(text), goneNote: GONE_NOTE.test(text) };
  }
  return { ...base, kind: "other" };
}

/** Read one JSONL transcript; a malformed line counts as a parse error (the last one also as a truncated tail, e.g. a live file). */
export async function readTranscript(file: string): Promise<FileRead> {
  const entries = new Map<string, Entry>();
  const order: string[] = [];
  let parseErrors = 0;
  let lastBad = false;
  let sessionId: string | undefined;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); lastBad = false; } catch { parseErrors++; lastBad = true; continue; }
    if (sessionId === undefined && (raw as { type?: unknown })?.type === "session" && typeof (raw as { id?: unknown }).id === "string") sessionId = (raw as { id: string }).id;
    const entry = parseEntry(raw);
    if (!entry) continue;
    entries.set(entry.id, entry);
    order.push(entry.id);
  }
  return { entries, order, parseErrors, truncatedLast: lastBad, ...(sessionId !== undefined ? { sessionId } : {}) };
}

/** The tally of one group of hand-offs. */
export interface Stats {
  n: number;
  /** Declares R-ids (a single-workflow hand-off, where an Original request section is asked for). */
  withRequirements: number;
  originalSection: number;
  originalSectionWithRequirements: number;
  /** No user message since the previous hand-off (main delegated on its own, e.g. after a result): nothing to compare. */
  noUserSinceHandoff: number;
  /** The newest user message since the previous hand-off, by carry. */
  latest: Record<UserTextCarry, number>;
  /** The same for hand-offs with an Original request section only (the others predate that guidance or ran in direct mode). */
  latestWithOriginal: Record<UserTextCarry, number>;
  /** The same by the newest message's normalized length: up to 2,000 characters, up to 8,000, longer (pasted documents, generated prompts). */
  latestByLength: Record<LengthBucket, Record<UserTextCarry, number>>;
  /** Several user messages since the previous hand-off; and those with an earlier one entirely absent. */
  multipleUserMessages: number;
  earlierAbsent: number;
  /**
   * The earlier user messages (all but the newest) since the previous hand-off: carried by the hand-off (verbatim or at least
   * half); else relayed by orche_task_message to the running worker; else answered by main without any tool call (a question
   * or status check); else none of these (a candidate for manual review, not a loss by itself); no text (an image only).
   */
  earlier: { total: number; carried: number; relayed: number; answeredWithoutTools: number; unexplained: number; noText: number };
  duplicateIds: number;
}
export type LengthBucket = "upTo2k" | "upTo8k" | "longer";
const bucketOf = (chars: number): LengthBucket => chars <= 2_000 ? "upTo2k" : chars <= 8_000 ? "upTo8k" : "longer";
const emptyCarry = (): Record<UserTextCarry, number> => ({ verbatim: 0, partial: 0, absent: 0, "no-text": 0 });
const emptyStats = (): Stats => ({ n: 0, withRequirements: 0, originalSection: 0, originalSectionWithRequirements: 0, noUserSinceHandoff: 0, latest: emptyCarry(), latestWithOriginal: emptyCarry(), latestByLength: { upTo2k: emptyCarry(), upTo8k: emptyCarry(), longer: emptyCarry() }, multipleUserMessages: 0, earlierAbsent: 0, earlier: { total: 0, carried: 0, relayed: 0, answeredWithoutTools: 0, unexplained: 0, noText: 0 }, duplicateIds: 0 });

export type Situation = "first" | "follow-up" | "handover" | "ledger-takeover" | "replacement-after-unmet";
export const SITUATIONS: readonly Situation[] = ["first", "follow-up", "handover", "ledger-takeover", "replacement-after-unmet"];

export interface MainAudit {
  /** orche_task calls found; rejected (an error result, e.g. validation: no worker ran); without a result (cut off or live); malformed arguments. */
  calls: number; rejected: number; noResult: number; malformed: number;
  /** Delivered hand-offs by situation (exclusive), and two cross-tags over them. */
  bySituation: Record<Situation, Stats>;
  /** Main's context had been compacted before the hand-off (any compaction in its branch). */
  afterMainCompaction: Stats;
  /** A compaction lies between the newest user message (or previous hand-off) and the hand-off: main wrote it from a summary. */
  compactedBetween: Stats;
  all: Stats;
}
export interface SpawnStats { n: number; ownOriginalSection: number; carry: Record<UserTextCarry, number> }
export interface SubWorkerAudit {
  /**
   * Compactions in worker transcripts. What their essentials restored (the current and earlier hand-offs, workers.ts
   * taskCompactionFor) is built when the context is rebuilt and is not stored in the transcript, so it cannot be audited here.
   */
  workerCompactions: number;
  spawnCalls: number; rejected: number; requests: number;
  /** Requests whose parent assignment prompt was found in the transcript, and those of them whose parent had an Original request section. */
  parentFound: number; parentWithOriginal: number;
  /** The parent's Original request text carried by the sub-worker request, by origin and sub-worker role. */
  byOrigin: Record<Origin, Record<string, SpawnStats>>;
}

/** One user message since the previous hand-off, with what followed it before the next user message. */
interface UserTurn { text: string; answeredWithoutTools: boolean }

function add(stats: Stats, signals: ReturnType<typeof handoffSignals>, withRequirements: boolean, turns: readonly UserTurn[] = [], relays = ""): void {
  stats.n++;
  if (withRequirements) stats.withRequirements++;
  if (signals.original) { stats.originalSection++; if (withRequirements) stats.originalSectionWithRequirements++; }
  const latest = signals.userMessages.at(-1);
  if (!latest) stats.noUserSinceHandoff++;
  else {
    stats.latest[latest.carry]++;
    if (signals.original) stats.latestWithOriginal[latest.carry]++;
    stats.latestByLength[bucketOf(latest.chars)][latest.carry]++;
  }
  if (signals.userMessages.length > 1) stats.multipleUserMessages++;
  if (signals.userMessages.slice(0, -1).some(item => item.carry === "absent")) stats.earlierAbsent++;
  for (const [index, item] of signals.userMessages.slice(0, -1).entries()) {
    stats.earlier.total++;
    if (item.carry === "no-text") stats.earlier.noText++;
    else if (item.carry !== "absent") stats.earlier.carried++;
    else if (relays && userTextCarry(relays, turns[index]?.text ?? "").carry !== "absent") stats.earlier.relayed++;
    else if (turns[index]?.answeredWithoutTools) stats.earlier.answeredWithoutTools++;
    else stats.earlier.unexplained++;
  }
  if (signals.duplicateIds.length) stats.duplicateIds++;
}

/** A flagged hand-off for manual review: its location only (file, entry id), never its text. */
export interface Suspect { file: string; entry: string; origin: Origin; original: boolean; situation: Situation; latest: UserTextCarry | "none"; coverage: number; chars: number; earlierAbsent: number }
/** agent_workflow runs (session id "aw-…") hand main a generated prompt; every other session is interactive. */
export type Origin = "interactive" | "automated";
export const originOf = (read: Pick<FileRead, "sessionId">): Origin => read.sessionId?.startsWith("aw-") ? "automated" : "interactive";

export function emptyMainAudit(): MainAudit {
  return { calls: 0, rejected: 0, noResult: 0, malformed: 0, bySituation: Object.fromEntries(SITUATIONS.map(item => [item, emptyStats()])) as Record<Situation, Stats>, afterMainCompaction: emptyStats(), compactedBetween: emptyStats(), all: emptyStats() };
}

const R_ID = /^[ \t]*R[1-9]\d*(?::|[.)]|[ \t]+-)/m;

/** Audit the orche_task hand-offs of one main transcript into `audit` (a call seen in another file, e.g. a fork, is skipped via `seen`). */
export function auditMain(read: FileRead, audit: MainAudit, seen: Set<string>, file = "", suspects?: Suspect[]): void {
  const origin = originOf(read);
  const results = new Map<string, Entry>();
  for (const id of read.order) { const entry = read.entries.get(id)!; if (entry.kind === "toolResult" && entry.toolCallId) results.set(entry.toolCallId, entry); }
  for (const id of read.order) {
    const entry = read.entries.get(id)!;
    for (const [index, call] of (entry.calls ?? []).entries()) {
      if (call.name !== "orche_task" || seen.has(call.id)) continue;
      seen.add(call.id);
      audit.calls++;
      const result = results.get(call.id);
      if (!result) { audit.noResult++; continue; }
      if (result.isError) { audit.rejected++; continue; }
      const { request, context, worker, task } = call.args;
      if (typeof request !== "string") { audit.malformed++; continue; }
      // Walk the branch from this call to the root: user messages since the previous hand-off (an earlier orche_task call in
      // this message counts too), compactions, gone workers and the notes of results that came back in between.
      const turns: UserTurn[] = [];
      const relays: string[] = [];
      let previousFound = (entry.calls ?? []).slice(0, index).some(item => item.name === "orche_task");
      let compactedBetween = false, compacted = false, unmet = false, goneWorker = false, sawUser = false, segmentTools = false;
      for (let cursor = entry.parentId ? read.entries.get(entry.parentId) : undefined; cursor; cursor = cursor.parentId ? read.entries.get(cursor.parentId) : undefined) {
        if (cursor.kind === "compaction") { compacted = true; if (!previousFound && !sawUser) compactedBetween = true; }
        if (cursor.kind === "gone" && typeof worker === "string" && cursor.goneId === worker) goneWorker = true;
        if (previousFound) continue;
        if ((cursor.kind === "result" || cursor.kind === "toolResult") && cursor.unmetNote) unmet = true;
        if (cursor.kind === "user") { turns.unshift({ text: cursor.text ?? "", answeredWithoutTools: sawUser && !segmentTools }); sawUser = true; segmentTools = false; }
        if (cursor.kind === "assistant") {
          if (cursor.toolCalls) segmentTools = true;
          for (const item of cursor.calls ?? []) if (item.name === "orche_task_message" && typeof item.args.message === "string") relays.push(item.args.message);
          if (cursor.calls?.some(item => item.name === "orche_task")) previousFound = true;
        }
      }
      const users = turns.map(turn => turn.text);
      const situation: Situation = typeof worker === "string" && worker
        ? (goneWorker || result.goneNote ? "handover" : "follow-up")
        : typeof task === "string" && task ? "ledger-takeover" : unmet ? "replacement-after-unmet" : "first";
      const signals = handoffSignals(request, typeof context === "string" ? context : undefined, users);
      const withRequirements = R_ID.test(request);
      const relayText = relays.join("\n\n");
      for (const stats of [audit.bySituation[situation], audit.all, ...(compacted ? [audit.afterMainCompaction] : []), ...(compactedBetween ? [audit.compactedBetween] : [])])
        add(stats, signals, withRequirements, turns, relayText);
      const latest = signals.userMessages.at(-1);
      const earlierAbsent = signals.userMessages.slice(0, -1).filter(item => item.carry === "absent").length;
      if (suspects && (earlierAbsent || latest && (latest.carry === "absent" || latest.carry === "partial")))
        suspects.push({ file, entry: entry.id, origin, original: signals.original, situation, latest: latest?.carry ?? "none", coverage: latest?.coverage ?? 0, chars: latest?.chars ?? 0, earlierAbsent });
    }
  }
}

/** The first line of an assignment prompt; a handover or resume briefing may come before it. */
const ASSIGNMENT_LINE = /^Assignment: /m;
/** The role instruction texts that follow the task in an assignment prompt (workers.ts assignmentPrompt) end its Original request. */
const PROMPT_TAIL = /^(?:## Context from the requesting session|Strictly read-only\.|Own the task end to end|Implement completely|Investigate independently|Independent read-only review|Game asset production\.|Video production\.)/m;
/** The user's text of an assignment prompt: its Original request section up to the context or the role instructions. */
export function assignmentOriginal(prompt: string): string | undefined {
  const start = ASSIGNMENT_LINE.exec(prompt)?.index ?? 0;
  const original = originalRequestOf(prompt.slice(start));
  if (original === undefined) return undefined;
  const tail = PROMPT_TAIL.exec(original);
  const text = (tail ? original.slice(0, tail.index) : original).trim();
  return text || undefined;
}

export function emptySubWorkerAudit(): SubWorkerAudit { return { workerCompactions: 0, spawnCalls: 0, rejected: 0, requests: 0, parentFound: 0, parentWithOriginal: 0, byOrigin: { interactive: {}, automated: {} } }; }

/** Audit the orche_spawn requests of one worker transcript (of an `origin` session) into `audit`. */
export function auditWorker(read: FileRead, audit: SubWorkerAudit, seen: Set<string>, origin: Origin = "interactive"): void {
  const results = new Map<string, Entry>();
  for (const id of read.order) { const entry = read.entries.get(id)!; if (entry.kind === "toolResult" && entry.toolCallId) results.set(entry.toolCallId, entry); }
  for (const id of read.order) {
    const entry = read.entries.get(id)!;
    if (entry.kind === "compaction") audit.workerCompactions++;
    for (const call of entry.calls ?? []) {
      if (call.name !== "orche_spawn" || seen.has(call.id)) continue;
      seen.add(call.id);
      audit.spawnCalls++;
      if (results.get(call.id)?.isError) { audit.rejected++; continue; }
      let parent: string | undefined;
      for (let cursor = entry.parentId ? read.entries.get(entry.parentId) : undefined; cursor; cursor = cursor.parentId ? read.entries.get(cursor.parentId) : undefined)
        if (cursor.kind === "user" && cursor.text && ASSIGNMENT_LINE.test(cursor.text)) { parent = cursor.text; break; }
      const original = parent === undefined ? undefined : assignmentOriginal(parent);
      const workers = Array.isArray(call.args.workers) ? call.args.workers as { role?: unknown; request?: unknown }[] : [];
      for (const item of workers) {
        if (typeof item?.request !== "string") continue;
        audit.requests++;
        if (parent !== undefined) audit.parentFound++;
        if (original === undefined) continue;
        audit.parentWithOriginal++;
        const role = typeof item.role === "string" ? item.role : "unknown";
        const stats = audit.byOrigin[origin][role] ??= { n: 0, ownOriginalSection: 0, carry: { verbatim: 0, partial: 0, absent: 0, "no-text": 0 } };
        stats.n++;
        if (originalRequestOf(item.request) !== undefined) stats.ownOriginalSection++;
        const carried: CarryResult = userTextCarry(item.request, original);
        stats.carry[carried.carry]++;
      }
    }
  }
}
