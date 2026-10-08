/**
 * Tool-call ledger of one worker assignment: what checkpoint evidence can be checked against (docs/thinking-policy.md "Evidence").
 *
 * Every tool result of a session with evidence linkage on gets a short reference `[orche ref T<n>]` (appended as the last text part,
 * after the spill of large outputs), and the ledger keeps for it: the tool, whether it failed, the model request it belongs to, that
 * request's thinking level (and whether it ran at the assignment's baseline effort), the Task DAG node running at the time, and the
 * command or path it worked on. A checkpoint evidence item is then classified as:
 * - `verified`: it cites a ref (or names a command/path of a call) that exists, succeeded, and ran inside the node's window;
 * - `failed_call`: it cites a call that failed (an error result: a failing command, a missing file);
 * - `unknown_ref`: it cites a ref that does not exist (never issued, or a later number than any call so far);
 * - `outside_window`: it cites a real call made before the node started running;
 * - `unmatched`: free text that names no ref and matches no call (allowed, but proves nothing).
 *
 * Limits, on purpose: a verified item proves that a call ran and how it ended, never that its output supports the claim (a grep that
 * found something, a test run that passed, is not proof that the code is right). Evidence strings are untrusted input: they are only
 * compared with the ledger, never executed or read from disk.
 */
export interface ToolRecord {
  /** `T<n>` for a check, numbered per assignment from 1; `B<n>` for a bookkeeping call (never evidence, never shown). */
  ref: string;
  toolCallId: string;
  name: string;
  isError: boolean;
  /** The model request (thinking-state `requestSeq`) whose response issued the call. */
  request: number;
  /** That request's thinking level. */
  level?: string;
  /** Whether that level ran at the assignment's baseline effort (effective; src/pi/effort-mapping.ts). */
  atBaseline: boolean;
  /** The Task DAG node running when the call ran. */
  node?: string;
  /** The command (bash) or path the call worked on, shortened, for matching evidence without a ref. */
  target?: string;
  timestamp: number;
}

export interface EvidenceLedger {
  calls: ToolRecord[];
  /** Checks (refs T1, T2, ...) and bookkeeping calls (task_plan, report_result: B1, ...; never evidence) recorded so far. */
  checks: number;
  bookkeeping: number;
  /** Append `[orche ref T<n>]` to tool results (evidence linkage on). */
  tag: boolean;
}

export type EvidenceVerdict = "verified" | "failed_call" | "unknown_ref" | "outside_window" | "unmatched";

export interface EvidenceCheck {
  item: string;
  verdict: EvidenceVerdict;
  /** The calls the item cites or matches. */
  calls: ToolRecord[];
}

/** Tools whose calls are bookkeeping, not checks: never evidence for a node. */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(["task_plan", "report_result", "send_message"]);

const ledgers = new WeakMap<object, EvidenceLedger>();
const MAX_CALLS = 2000;
const TARGET_CHARS = 400;

export function evidenceLedgerOf(session: object): EvidenceLedger {
  let ledger = ledgers.get(session);
  if (!ledger) ledgers.set(session, ledger = { calls: [], checks: 0, bookkeeping: 0, tag: false });
  return ledger;
}

/** Start an assignment: forget the previous assignment's calls; `tag` turns the result references on or off. */
export function resetEvidence(session: object, tag: boolean): EvidenceLedger {
  const ledger = evidenceLedgerOf(session);
  ledger.calls = [];
  ledger.checks = 0;
  ledger.bookkeeping = 0;
  ledger.tag = tag;
  return ledger;
}

const targetOf = (name: string, input: Record<string, unknown> | undefined): string | undefined => {
  if (!input) return undefined;
  const value = name === "bash" ? input.command : input.path ?? input.file ?? input.pattern;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, TARGET_CHARS) : undefined;
};

/** Record one finished tool call (the `tool_result` of the session); returns the record. */
export function recordToolCall(session: object, call: { toolCallId: string; toolName: string; input?: Record<string, unknown>; isError: boolean }, context: { request: number; level?: string; atBaseline: boolean; node?: string }): ToolRecord {
  const ledger = evidenceLedgerOf(session);
  const target = targetOf(call.toolName, call.input);
  const record: ToolRecord = {
    ref: BOOKKEEPING_TOOLS.has(call.toolName) ? `B${++ledger.bookkeeping}` : `T${++ledger.checks}`,
    toolCallId: call.toolCallId, name: call.toolName, isError: call.isError,
    request: context.request, ...(context.level ? { level: context.level } : {}), atBaseline: context.atBaseline,
    ...(context.node ? { node: context.node } : {}), ...(target ? { target } : {}), timestamp: Date.now(),
  };
  ledger.calls.push(record);
  if (ledger.calls.length > MAX_CALLS) ledger.calls.splice(0, ledger.calls.length - MAX_CALLS);
  return record;
}

/** The reference text appended to a tool result. */
export const refText = (record: ToolRecord) => `[orche ref ${record.ref}${record.isError ? ", failed" : ""}]`;

const REF = /\bT(\d{1,5})\b/g;
const PATH = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8})(?::\d+(?:[-–]\d+)?)?/g;
const norm = (text: string) => text.replace(/[`'"]/g, "").replace(/\s+/g, " ").trim();

function matchCalls(item: string, calls: readonly ToolRecord[]): ToolRecord[] {
  const arrow = item.search(/->|→|=>/);
  const command = norm(arrow > 0 ? item.slice(0, arrow) : "");
  if (command.length >= 3) {
    const hits = calls.filter(call => call.name === "bash" && call.target && (norm(call.target).includes(command) || command.includes(norm(call.target))));
    if (hits.length) return hits;
  }
  const paths = [...item.matchAll(PATH)].map(match => match[1]!.replace(/^\.\//, ""));
  if (!paths.length) return [];
  return calls.filter(call => call.name !== "bash" && call.target && paths.some(path => call.target!.replace(/^\.\//, "").endsWith(path) || path.endsWith(call.target!.replace(/^\.\//, ""))));
}

/**
 * Classify one evidence item against the ledger. `fromRequest`: the request at which the node started running (calls of earlier
 * requests are `outside_window`; 0 = the whole assignment). `atBaseline`: only calls made at the baseline effort count as verified.
 */
export function classifyEvidence(item: string, ledger: EvidenceLedger, window: { fromRequest: number; atBaseline?: boolean }): EvidenceCheck {
  const calls = ledger.calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
  const refs = [...item.matchAll(REF)].map(match => `T${Number(match[1])}`);
  let cited: ToolRecord[];
  if (refs.length) {
    const byRef = new Map(ledger.calls.map(call => [call.ref, call]));
    const missing = refs.filter(ref => !byRef.has(ref) || BOOKKEEPING_TOOLS.has(byRef.get(ref)!.name));
    if (missing.length) return { item, verdict: "unknown_ref", calls: [] };
    cited = refs.map(ref => byRef.get(ref)!);
  } else {
    cited = matchCalls(item, calls);
    if (!cited.length) return { item, verdict: "unmatched", calls: [] };
  }
  if (refs.length && cited.some(call => call.isError)) return { item, verdict: "failed_call", calls: cited };
  const usable = cited.filter(call => !call.isError && call.request >= window.fromRequest && (!window.atBaseline || call.atBaseline));
  if (usable.length) return { item, verdict: "verified", calls: usable };
  if (!refs.length && cited.every(call => call.isError)) return { item, verdict: "failed_call", calls: cited };
  return { item, verdict: "outside_window", calls: cited };
}

/** Checks (non-bookkeeping calls) of the assignment so far. */
export function checkCalls(ledger: EvidenceLedger): ToolRecord[] {
  return ledger.calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
}
