/**
 * Labelled evidence analysis of one worker transcript of the combination-B re-evaluation (README.md §metrics). The labels come from
 * the instance (which decisions govern each item, which check cannot pass), never from the model:
 *
 * - order: the first feed delivery (`npm run decisions` output with the log), first e2e failure, every compaction (cut), item-module
 *   edits, the final report;
 * - exposure: a cut after the feed delivery with an item-module edit after it (decision evidence had to survive the cut), and a
 *   cut after the first e2e failure before the final report (an unresolved failure had to survive the cut);
 * - restored context at each cut = Pi's summary + orche's essentials message. For every item the governing decision (the approval
 *   of a "changed" item, the withdrawal or rejection of the others) is "kept" when its id (D-n) appears there; "withdrawn only" =
 *   the withdrawn or rejected decision appears without the one that withdrew or rejected it. These are proxies: a summary can keep
 *   a rule without its id. The e2e failure is "kept" when the restored context mentions e2e or the sandbox token, and "in the
 *   work log" when the work-log section lists it as FAILED;
 * - recovery after a cut: feed re-fetches (which return "no new decisions"), lookups in the worker's own transcript (.jsonl), and
 *   notes: decision ids the worker wrote into a workspace file (write/edit content or a bash redirect of the feed);
 * - activation: the restored work-log kind (decision memory), `[orche ref T<n>]` in tool results (linkage) and `T<n>` checkpoint
 *   evidence.
 */
import type { Instance } from "./project.js";
import { templateOf } from "./project.js";

export interface CutEvidence {
  index: number;
  afterDecisionsRead: boolean;
  itemEditsAfter: number;
  afterE2eFailure: boolean;
  reportAfter: boolean;
  workLogKind: "decision" | "basic" | "none";
  governingKept: number;
  governingTotal: number;
  withdrawnOnly: number;
  e2eKept: boolean;
  e2eInWorkLog: boolean;
  decisionsRereadAfter: number;
  transcriptLookupsAfter: number;
  /** Item-module writes after the cut, by any route (edit/write/ast_rewrite, or a bash command naming the item file with sed -i,
   * perl -pi, tee, a redirect, python or node writing files). Broader than itemEditsAfter (kept for experiments/decision-memory-b). */
  itemWritesAfter: number;
}

export interface EvidenceAnalysis {
  cuts: CutEvidence[];
  decisionsReads: number;
  emptyRefetches: number;
  notesWritten: number;
  transcriptLookups: number;
  /** Transcript (.jsonl) lookups STARTED (counted at the call, so a lookup that never returned is included). */
  transcriptLookupsStarted: number;
  /** Tool calls without a result in the transcript (interrupted by a timeout or an abort), and how many were transcript lookups. */
  unfinishedCalls: number;
  unfinishedTranscriptLookups: number;
  /** Tool results that took more than 120 s, and how many of them were transcript lookups (the hang seen in decision-memory-b). */
  longCalls: number;
  longTranscriptLookups: number;
  /** Exposure with the broader write detection (a cut after the feed delivery with an item write after it). */
  exposedDecisionsBroad: boolean;
  e2eFailures: number;
  exposedDecisions: boolean;
  exposedE2e: boolean;
  linkedResults: number;
  citedCheckpoints: number;
  finalReport: boolean;
}

const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("") : "";
const E2E_FAILURE = /e2e: (PARCELKIT_SANDBOX_TOKEN is not set|the carrier sandbox rejected)/;

/**
 * `feedDeliveredAt` (ms, from the feed server's request log): the feed delivery is then dated by the server, so a delivery whose
 * output went to an artifact file or a note (not into the tool result) still counts (memory-opus pilot, PREREGISTRATION §9).
 */
export function analyzeEvidence(transcript: string, inst: Instance, options: { feedDeliveredAt?: number } = {}): EvidenceAnalysis {
  const itemFiles = inst.items.map(item => `src/${templateOf(item.template).file}.js`);
  const governing = inst.items.map(item => ({ governing: item.decisions.at(-1)!, withdrawn: item.decisions.length === 2 ? item.decisions[0]! : undefined }));
  const mentions = (text: string, id: string) => new RegExp(`\\bD-${id.slice(2)}\\b`).test(text);
  interface Open { cut: CutEvidence; restored: string; awaitingEssentials: boolean }
  const cuts: Open[] = [];
  const pending = new Map<string, { name: string; input: any }>();
  let decisionsReads = 0, emptyRefetches = 0, notesWritten = 0, transcriptLookups = 0, e2eFailures = 0, linkedResults = 0, citedCheckpoints = 0, finalReport = false;
  let transcriptLookupsStarted = 0, longCalls = 0, longTranscriptLookups = 0;
  const answered = new Set<string>();
  const isLookup = (name: string, input: any) => ["bash", "grep", "read"].includes(name) && /\.jsonl\b/.test(`${input?.path ?? ""} ${input?.command ?? ""} ${input?.pattern ?? ""}`);
  let sawDecisions = false, sawE2eFailure = false;

  const settle = (open: Open) => {
    const text = open.restored;
    const kept = governing.filter(entry => mentions(text, entry.governing)).length;
    const withdrawnOnly = governing.filter(entry => entry.withdrawn && mentions(text, entry.withdrawn) && !mentions(text, entry.governing)).length;
    const log = text.slice(Math.max(0, text.search(/Decision-linked work evidence|Work log of this assignment/)));
    Object.assign(open.cut, { governingKept: kept, governingTotal: governing.length, withdrawnOnly, e2eKept: /e2e|SANDBOX/i.test(text), e2eInWorkLog: /^- FAILED [^\n]*(e2e|verify)/im.test(log) });
  };

  for (const line of transcript.split("\n")) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (options.feedDeliveredAt !== undefined && !sawDecisions && typeof entry.timestamp === "string" && Date.parse(entry.timestamp) >= options.feedDeliveredAt) sawDecisions = true;
    if (entry.type === "compaction") {
      const open: Open = { cut: { index: cuts.length + 1, afterDecisionsRead: sawDecisions, itemEditsAfter: 0, afterE2eFailure: sawE2eFailure, reportAfter: false, workLogKind: "none", governingKept: 0, governingTotal: governing.length, withdrawnOnly: 0, e2eKept: false, e2eInWorkLog: false, decisionsRereadAfter: 0, transcriptLookupsAfter: 0, itemWritesAfter: 0 }, restored: String(entry.summary ?? ""), awaitingEssentials: true };
      cuts.push(open);
      settle(open);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "orche:task-essentials" && cuts.at(-1)?.awaitingEssentials) {
      const open = cuts.at(-1)!;
      open.awaitingEssentials = false;
      const text = textOf(entry.content);
      open.restored += `\n${text}`;
      open.cut.workLogKind = text.includes("Decision-linked work evidence") ? "decision" : text.includes("Work log of this assignment") ? "basic" : "none";
      settle(open);
      continue;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        pending.set(part.id, { name: part.name, input: part.arguments });
        if (isLookup(part.name, part.arguments)) transcriptLookupsStarted++;
        if (part.name === "task_plan" && Array.isArray(part.arguments?.nodes)) {
          for (const node of part.arguments.nodes) for (const item of Array.isArray(node?.checkpoint?.evidence) ? node.checkpoint.evidence : []) if (typeof item === "string" && /^T\d+\b/.test(item)) citedCheckpoints++;
        }
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const call = pending.get(message.toolCallId);
    answered.add(message.toolCallId);
    if (typeof message.durationMs === "number" && message.durationMs > 120_000) { longCalls++; if (call && isLookup(call.name, call.input)) longTranscriptLookups++; }
    const name = message.toolName ?? call?.name;
    const input = call?.input ?? {};
    const result = textOf(message.content);
    if (/\[orche ref T\d+/.test(result)) linkedResults++;
    const target = `${input.path ?? ""} ${input.command ?? ""} ${input.pattern ?? ""}`;
    const feedCall = name === "bash" && /decisions|PARCELKIT_FEED_URL|\/v1\/decisions/.test(String(input.command ?? ""));
    if (feedCall && /^## D-1 /m.test(result)) { decisionsReads++; sawDecisions = true; }
    else if (feedCall && /No new decisions/.test(result)) {
      emptyRefetches++;
      for (const open of cuts) if (open.cut.afterDecisionsRead) open.cut.decisionsRereadAfter++;
    }
    if (["bash", "grep", "read"].includes(name) && /\.jsonl\b/.test(target)) {
      transcriptLookups++;
      for (const open of cuts) open.cut.transcriptLookupsAfter++;
    }
    if ((["write", "edit"].includes(name) && /\bD-\d+\b/.test(JSON.stringify(input))) || (feedCall && /(>|\btee\b)/.test(String(input.command ?? "")))) notesWritten++;
    if (name === "bash" && E2E_FAILURE.test(result)) { e2eFailures++; sawE2eFailure = true; }
    const editsItem = (["edit", "write", "ast_rewrite"].includes(name) && itemFiles.some(file => String(input.path ?? "").endsWith(file)))
      || (name === "bash" && itemFiles.some(file => String(input.command ?? "").includes(file)) && /sed -i|>\s*\S*src\/|tee |perl -pi/.test(String(input.command ?? "")));
    if (editsItem) for (const open of cuts) open.cut.itemEditsAfter++;
    const command = String(input.command ?? "");
    const writesItem = editsItem || (name === "bash" && (itemFiles.some(file => command.includes(file)) || /src\//.test(command))
      && /sed -i|perl -pi|\btee\b|>\s*\S|python3?\b|\bnode\b[^|]*(-e|--eval|<<)|writeFileSync|\bmv\b|\bcp\b/.test(command));
    if (writesItem) for (const open of cuts) open.cut.itemWritesAfter++;
    if (name === "report_result" && !message.isError) { finalReport = true; for (const open of cuts) open.cut.reportAfter = true; }
  }
  const list = cuts.map(open => open.cut);
  const unanswered = [...pending.entries()].filter(([id]) => !answered.has(id));
  return {
    cuts: list, decisionsReads, emptyRefetches, notesWritten, transcriptLookups, e2eFailures,
    transcriptLookupsStarted, unfinishedCalls: unanswered.length, unfinishedTranscriptLookups: unanswered.filter(([, call]) => isLookup(call.name, call.input)).length, longCalls, longTranscriptLookups,
    exposedDecisionsBroad: list.some(cut => cut.afterDecisionsRead && cut.itemWritesAfter > 0),
    exposedDecisions: list.some(cut => cut.afterDecisionsRead && cut.itemEditsAfter > 0),
    exposedE2e: list.some(cut => cut.afterE2eFailure && cut.reportAfter),
    linkedResults, citedCheckpoints, finalReport,
  };
}
