/**
 * Analysis of one worker transcript of the decision-memory A/B (README.md): every compaction (the cut), what the restored work log
 * names, and how the worker behaved until the next compaction; plus the run's token usage and the estimated cost.
 *
 * Retention is split three ways, so a final grade is not read as "the log kept it":
 * - shown: the restored work log (orche:task-essentials after the compaction entry) names the call;
 * - recovered: after the cut the worker re-read a path it had read before the cut (it went back to the source);
 * - resolved: an unresolved failure at the cut ended with a later success of the same tool and target.
 * Tool calls are recorded with orche's own recordToolCall, so targets and failure keys are orche's.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { BOOKKEEPING_TOOLS, classifyEvidence, evidenceLedgerOf, recordToolCall, resetEvidence, type EvidenceLedger, type ToolRecord } from "../../src/pi/tool-evidence.js";

interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; costMissing: number }
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costMissing: 0 });
function addUsage(total: Usage, usage: any) {
  if (!usage) return;
  total.input += usage.input ?? 0; total.output += usage.output ?? 0; total.cacheRead += usage.cacheRead ?? 0; total.cacheWrite += usage.cacheWrite ?? 0;
  const cost = usage.cost?.total;
  if (typeof cost === "number" && cost > 0) total.cost += cost; else total.costMissing++;
}

export interface CutAnalysis {
  index: number;
  tokensBefore: number | null;
  summaryBytes: number;
  essentialsBytes: number;
  workLogKind: "basic" | "decision" | "none";
  workLogBytes: number;
  callsBeforeCut: number;
  readsBeforeCut: number;
  unresolvedAtCut: number;
  unresolvedShown: number;
  unresolvedLaterResolved: number;
  /** Unresolved failures at the cut that are failing project checks (npm test / npm run lint / node --test / tools/lint.js). */
  unresolvedChecksAtCut: number;
  unresolvedChecksShown: number;
  /** Every unresolved failure at the cut: tool, short target, whether it is a project check, whether the restored log names it. */
  unresolvedDetail: Array<{ tool: string; target: string; check: boolean; shown: boolean }>;
  citedAtCut: number;
  citedShown: number;
  laterCitedItems: number;
  laterCitedShown: number;
  /** Requests (assistant messages) and tool calls from this cut to the next compaction or the end. */
  requestsAfter: number;
  callsAfter: number;
  rereadsAfter: number;
  repeatedCommandsAfter: number;
}

export interface TranscriptAnalysis {
  file: string;
  requests: number;
  errorResponses: number;
  usage: Usage & { requests: number };
  summaryUsage: Usage;
  costEstimate: number;
  costMissingResponses: number;
  transcriptBytes: number;
  toolCalls: number;
  taskPlanCalls: number;
  checkpoints: number;
  compactions: CutAnalysis[];
  finalReport: boolean;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const textOf = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("") : "";

/** The work-log section of a restored essentials message (from its header to the next blank-line section or the end). */
export function workLogOf(essentials: string): { kind: CutAnalysis["workLogKind"]; text: string } {
  const decision = essentials.indexOf("Decision-linked work evidence");
  const basic = essentials.indexOf("Work log of this assignment");
  const start = decision >= 0 ? decision : basic;
  if (start < 0) return { kind: "none", text: "" };
  const rest = essentials.slice(start);
  const end = rest.search(/\n\n(?=[A-Z][^\n]*:\n)/);
  return { kind: decision >= 0 ? "decision" : "basic", text: end > 0 ? rest.slice(0, end) : rest };
}
const shownIds = (text: string) => new Set([...text.matchAll(/\(call ([^;)]+)[;)]/g)].map(match => match[1]!));
const failedIds = (text: string) => new Set([...text.matchAll(/^- FAILED .*\(call ([^;)]+)[;)]/gm)].map(match => match[1]!));
const CHECK = /npm (run )?(test|lint)|node --test|tools\/lint\.js/;
const isCheck = (call: ToolRecord) => call.name === "bash" && CHECK.test(call.target ?? "");
/** A target without the run's temp path (`cd <workspace> && `), cut to 100 characters. */
const shortTarget = (target: string | undefined) => (target ?? "").replace(/^cd \S+ && /, "").slice(0, 100);
const keyOf = (call: ToolRecord) => `${call.name}::${call.target ?? ""}`;
const checkpointEvidence = (plan: any): string[] => (Array.isArray(plan?.nodes) ? plan.nodes : []).flatMap((node: any) => Array.isArray(node?.checkpoint?.evidence) ? node.checkpoint.evidence.filter((item: unknown) => typeof item === "string") : []);

/** Analyse a worker transcript (one assignment per transcript in this study). */
export async function analyzeTranscript(file: string): Promise<TranscriptAnalysis> {
  const session = {};
  resetEvidence(session, true);
  const usage = emptyUsage();
  const summaryUsage = emptyUsage();
  let requests = 0, errorResponses = 0, transcriptBytes = 0, toolCalls = 0, taskPlanCalls = 0, finalReport = false;
  let plan: any;
  const pending = new Map<string, { name: string; input: any }>();
  const commands: string[] = [];
  const reads: string[] = [];
  const evidenceItems: { atCall: number; item: string }[] = [];
  interface Open { cut: CutAnalysis; ledger: EvidenceLedger; preIds: Set<string>; readSet: Set<string>; commandSet: Set<string>; unresolved: ToolRecord[]; planEvidence: Set<string>; callCount: number; awaitingEssentials: boolean }
  const cuts: Open[] = [];
  const current = () => cuts.at(-1);

  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    transcriptBytes += bytes(line) + 1;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "compaction") {
      addUsage(summaryUsage, entry.usage);
      const ledger = evidenceLedgerOf(session);
      const calls = ledger.calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
      const latest = new Map<string, ToolRecord>();
      for (const call of calls) latest.set(keyOf(call), call);
      const unresolved = calls.filter(call => call.isError && latest.get(keyOf(call)) === call);
      const cut: CutAnalysis = {
        index: cuts.length + 1, tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : Number(entry.tokensBefore) || null,
        summaryBytes: bytes(String(entry.summary ?? "")), essentialsBytes: 0, workLogKind: "none", workLogBytes: 0,
        callsBeforeCut: calls.length, readsBeforeCut: new Set(reads).size, unresolvedAtCut: unresolved.length, unresolvedShown: 0, unresolvedLaterResolved: 0,
        unresolvedChecksAtCut: unresolved.filter(isCheck).length, unresolvedChecksShown: 0, unresolvedDetail: [],
        citedAtCut: 0, citedShown: 0, laterCitedItems: 0, laterCitedShown: 0, requestsAfter: 0, callsAfter: 0, rereadsAfter: 0, repeatedCommandsAfter: 0,
      };
      cuts.push({ cut, ledger: { ...ledger, calls: ledger.calls.slice() }, preIds: new Set(ledger.calls.map(call => call.toolCallId)), readSet: new Set(reads), commandSet: new Set(commands), unresolved, planEvidence: new Set(checkpointEvidence(plan)), callCount: ledger.calls.length, awaitingEssentials: true });
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "orche:task-essentials" && current()?.awaitingEssentials) {
      const open = current()!;
      open.awaitingEssentials = false;
      const text = textOf(entry.content);
      const log = workLogOf(text);
      const shown = shownIds(log.text), failed = failedIds(log.text);
      const citedChecks = [...open.planEvidence].map(item => classifyEvidence(item, open.ledger, { fromRequest: 0 })).flatMap(check => check.calls.map(call => call.toolCallId));
      const cited = [...new Set(citedChecks)].filter(id => open.preIds.has(id));
      Object.assign(open.cut, {
        essentialsBytes: bytes(text), workLogKind: log.kind, workLogBytes: bytes(log.text),
        unresolvedShown: open.unresolved.filter(call => failed.has(call.toolCallId)).length,
        unresolvedChecksShown: open.unresolved.filter(call => isCheck(call) && failed.has(call.toolCallId)).length,
        unresolvedDetail: open.unresolved.map(call => ({ tool: call.name, target: shortTarget(call.target), check: isCheck(call), shown: failed.has(call.toolCallId) })),
        citedAtCut: cited.length, citedShown: cited.filter(id => shown.has(id)).length,
      });
      (open as any).shown = shown;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "assistant") {
      requests++;
      if (message.stopReason === "error") errorResponses++;
      addUsage(usage, message.usage);
      if (current()) current()!.cut.requestsAfter++;
      for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "toolCall" && part.id) pending.set(part.id, { name: part.name, input: part.arguments });
      continue;
    }
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const call = pending.get(message.toolCallId);
    const name = message.toolName ?? call?.name ?? "unknown";
    const input = call?.input && typeof call.input === "object" ? call.input : undefined;
    toolCalls++;
    if (name === "task_plan" && !message.isError && input && Array.isArray(input.nodes)) { taskPlanCalls++; plan = { nodes: input.nodes }; }
    if (name === "report_result" && !message.isError) finalReport = true;
    const running = plan?.nodes?.find((node: any) => node?.status === "running")?.id;
    const record = recordToolCall(session, { toolCallId: message.toolCallId, toolName: name, ...(input ? { input } : {}), isError: message.isError === true }, { request: requests, atBaseline: true, ...(running ? { node: running } : {}) });
    const open = current();
    if (open) {
      open.cut.callsAfter++;
      if (name === "read" && record.target && open.readSet.has(record.target)) open.cut.rereadsAfter++;
      if (name === "bash" && record.target && open.commandSet.has(record.target)) open.cut.repeatedCommandsAfter++;
    }
    if (name === "read" && record.target) reads.push(record.target);
    if (name === "bash" && record.target) commands.push(record.target);
    if (!message.isError && (name === "task_plan" || name === "report_result")) {
      const items = name === "task_plan" ? checkpointEvidence(input) : [...(Array.isArray(input?.data?.evidence) ? input.data.evidence : []), ...(Array.isArray(input?.data?.checklist) ? input.data.checklist.flatMap((item: any) => [item?.evidence, item?.verifiedBy]) : [])].filter((item: unknown): item is string => typeof item === "string");
      for (const item of items) evidenceItems.push({ atCall: evidenceLedgerOf(session).calls.length, item });
    }
  }

  // Resolution of unresolved failures and evidence cited after each cut.
  const finalLedger = evidenceLedgerOf(session);
  const latest = new Map<string, ToolRecord>();
  for (const call of finalLedger.calls) latest.set(keyOf(call), call);
  for (const open of cuts) {
    open.cut.unresolvedLaterResolved = open.unresolved.filter(call => { const last = latest.get(keyOf(call)); return !!last && last !== call && !last.isError; }).length;
    const shown: Set<string> = (open as any).shown ?? new Set();
    const later = [...new Set(evidenceItems.filter(entry => entry.atCall > open.callCount).map(entry => entry.item))].filter(item => !open.planEvidence.has(item));
    const resolved = later.map(item => classifyEvidence(item, open.ledger, { fromRequest: 0 })).filter(check => check.calls.length > 0 && check.calls.every(call => open.preIds.has(call.toolCallId)));
    open.cut.laterCitedItems = resolved.length;
    open.cut.laterCitedShown = resolved.filter(check => check.calls.some(call => shown.has(call.toolCallId))).length;
  }
  return {
    file, requests, errorResponses, usage: { ...usage, requests }, summaryUsage, costEstimate: usage.cost + summaryUsage.cost,
    costMissingResponses: usage.costMissing + summaryUsage.costMissing, transcriptBytes, toolCalls, taskPlanCalls,
    checkpoints: checkpointEvidence(plan).length, compactions: cuts.map(open => open.cut), finalReport,
  };
}
