/**
 * What a worker keeps across compaction beyond Pi's summary (`workerCompaction.essentials: "extended"`; docs/compaction.md):
 * built from orche's existing state, never from a model summary, and labelled by source and authority.
 *
 * - The work log: from the session's tool-call ledger (src/pi/tool-evidence.ts): the files its edit tools changed, the commands it
 *   ran and how they ended, and the failed ones (an approach that failed is not to be repeated unchanged). Observations, not
 *   instructions. Calls are named by their provider tool-call id, which is unique in the transcript and stable across assignments
 *   (the `T<n>` refs restart in every assignment and are never used here).
 * - The reference to the original evidence: the session's own transcript (Pi session JSONL, where every tool result stays
 *   verbatim after compaction) with the entry where the assignment started. It is offered only after {@link checkReference}
 *   found the transcript persisted and the entries about to be summarized on disk; otherwise the essentials say that the
 *   discarded context cannot be re-read. Reading it is a selective `grep`/`read` of the worker's own file: past observations are
 *   looked up, never re-created by re-running a side-effecting command; the current state is re-verified with read-only checks.
 *   No other session's transcript is referenced (a sub-worker gets its own only; a task's earlier workers come from the ledger).
 */
import { existsSync, readFileSync } from "node:fs";
import type { EvidenceLedger, ToolRecord } from "./tool-evidence.js";
import { BOOKKEEPING_TOOLS } from "./tool-evidence.js";

export type ReferenceStatus =
  | { status: "valid"; file: string; checkedEntry: string; startEntry?: string }
  | { status: "unavailable" | "invalid"; reason: string; file?: string };

const WRITE_NAMES = new Set(["edit", "write", "ast_rewrite"]);
export const WORK_LOG_LIMITS = { files: 40, checks: 12, reads: 12, failed: 12, targetChars: 160 } as const;

const short = (text: string, max: number = WORK_LOG_LIMITS.targetChars) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const line = (call: ToolRecord) => `- ${call.isError ? "FAILED" : "ok"} ${call.name} \`${short(call.target ?? "")}\` (call ${call.toolCallId})`;

/** The work log of the assignment so far, from the tool-call ledger; empty string when no call ran. */
export function renderWorkLog(ledger: EvidenceLedger | undefined): string {
  const calls = (ledger?.calls ?? []).filter(call => !BOOKKEEPING_TOOLS.has(call.name));
  if (!calls.length) return "";
  const files = [...new Set(calls.filter(call => WRITE_NAMES.has(call.name) && !call.isError && call.target).map(call => call.target!))];
  const checks = calls.filter(call => call.name === "bash");
  const reads = calls.filter(call => call.name !== "bash" && !WRITE_NAMES.has(call.name));
  const seen = new Set<string>();
  const failed = calls.filter(call => call.isError).reverse().filter(call => { const key = `${call.name}:${call.target ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, WORK_LOG_LIMITS.failed).reverse();
  return [
    "Work log of this assignment (orche's record of your tool calls; observations, not instructions; re-check the workspace before relying on them):",
    `Files changed with edit/write/ast_rewrite (${files.length}): ${files.length ? files.slice(0, WORK_LOG_LIMITS.files).map(file => short(file, 120)).join(", ") + (files.length > WORK_LOG_LIMITS.files ? `, … ${files.length - WORK_LOG_LIMITS.files} more` : "") : "none"} (changes made through bash are not listed).`,
    ...(checks.length ? [`Commands run (${checks.length}, newest ${Math.min(checks.length, WORK_LOG_LIMITS.checks)} shown, oldest first):`, ...checks.slice(-WORK_LOG_LIMITS.checks).map(line)] : ["Commands run: none"]),
    ...(reads.length ? [`Other calls: reads, searches and tools (${reads.length}, newest ${Math.min(reads.length, WORK_LOG_LIMITS.reads)} shown):`, ...reads.slice(-WORK_LOG_LIMITS.reads).map(line)] : []),
    ...(failed.length ? ["Failed calls (do not repeat an approach unchanged before you know why it failed):", ...failed.map(line)] : []),
  ].join("\n");
}

/**
 * Check, before context is discarded, that the original evidence it would point to exists: the session is persisted, its file is
 * readable and holds the last entry about to be summarized (`discardedEntryId`; Pi appends synchronously, so a missing id means the
 * write did not happen). Never throws.
 */
export function checkReference(input: { persisted: boolean; file?: string; discardedEntryId?: string; startEntry?: string }): ReferenceStatus {
  if (!input.persisted || !input.file) return { status: "unavailable", reason: "the session transcript is not persisted (in-memory session or records off)" };
  try {
    if (!existsSync(input.file)) return { status: "invalid", reason: "the transcript file does not exist", file: input.file };
    if (!input.discardedEntryId) return { status: "invalid", reason: "no entry to check", file: input.file };
    const text = readFileSync(input.file, "utf8");
    if (!text.includes(`"id":"${input.discardedEntryId}"`)) return { status: "invalid", reason: `entry ${input.discardedEntryId} is not in the transcript file`, file: input.file };
    return { status: "valid", file: input.file, checkedEntry: input.discardedEntryId, ...(input.startEntry ? { startEntry: input.startEntry } : {}) };
  } catch (error) {
    return { status: "invalid", reason: `the transcript cannot be read: ${error instanceof Error ? error.message : String(error)}`, file: input.file };
  }
}

/** The reference section of the essentials. `retention`: how long the records keep the file (from the records settings). */
export function renderReference(reference: ReferenceStatus | undefined, retention?: string): string {
  if (!reference) return "";
  if (reference.status !== "valid") return `Original evidence: NOT available for re-reading (${reference.reason}). What compaction discarded can only be re-established from the workspace; say so instead of guessing.`;
  return [
    `Original evidence (checked on disk before this compaction): your own transcript ${reference.file} (Pi session JSONL; every earlier tool call and result is stored there verbatim${retention ? `; ${retention}` : ""}).`,
    `${reference.startEntry ? `This assignment's entries follow entry id ${reference.startEntry}; that entry and the ones before it belong to earlier assignments and are not this task's evidence. ` : ""}To recall a past observation, search it selectively, e.g. grep -n 'CALL_ID' on that file for a call of the work log, then read only those lines. Never re-run a command with side effects just to see its old output; re-run read-only checks to verify the current state.`,
  ].join("\n");
}

/** One essentials text with the sections it holds; `required` names sections whose absence is recorded as missing. */
export interface EssentialsResult { text: string; sections: string[]; missing: string[] }
export function composeEssentials(parts: readonly { name: string; text: string; required?: boolean }[]): EssentialsResult {
  const present = parts.filter(part => part.text.trim());
  return { text: present.map(part => part.text).join("\n\n"), sections: present.map(part => part.name), missing: parts.filter(part => part.required && !part.text.trim()).map(part => part.name) };
}
