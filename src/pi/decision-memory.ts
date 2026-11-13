/**
 * FOCUS-inspired (not FOCUS-equivalent) decision-linked work evidence.
 * Unfinished Task DAG nodes stand in for sampled future plans. Never learn a
 * general rule from a failed attempt; the raw source remains in Pi's transcript.
 */
import type { TaskPlan } from "../tools/task-plan.js";
import type { EvidenceLedger, ToolRecord } from "./tool-evidence.js";
import { BOOKKEEPING_TOOLS } from "./tool-evidence.js";

export const DECISION_MEMORY_LIMITS = {
  activeCalls: 10, recentChecks: 4, checkpointCalls: 6, totalCalls: 18,
  recentErrorWindow: 12, unresolvedErrors: 4, changedFiles: 24, targetChars: 140,
} as const;

const short = (value: string): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= DECISION_MEMORY_LIMITS.targetChars
    ? text : text.slice(0, DECISION_MEMORY_LIMITS.targetChars - 1) + "…";
};
const callLine = (call: ToolRecord): string =>
  "- " + (call.isError ? "FAILED " : "ok ") + call.name +
  " '" + short(call.target ?? "") + "' (call " + call.toolCallId +
  (call.node ? "; node " + call.node : "") + ")";
const outcomeKey = (call: ToolRecord): string => call.name + "::" + (call.target ?? "");

/**
 * Render bounded successful observations relevant to unfinished work or
 * checkpoint evidence, plus only recent unresolved errors. Original evidence
 * remains addressable through the provider tool-call ID in the Pi JSONL.
 */
export function renderDecisionWorkLog(ledger: EvidenceLedger | undefined, plan?: TaskPlan): string {
  const calls = (ledger?.calls ?? []).filter(call => !BOOKKEEPING_TOOLS.has(call.name));
  if (!calls.length) return "";
  const open = new Set((plan?.nodes ?? [])
    .filter(node => node.status !== "done" && node.status !== "skipped")
    .map(node => node.id));
  const refs = new Set((plan?.nodes ?? [])
    .flatMap(node => node.checkpoint?.evidence ?? [])
    .flatMap(value => value.split(/[^A-Za-z0-9]+/))
    .filter(word => /^T[0-9]+$/.test(word)));
  const successful = calls.filter(call => !call.isError);
  const active = successful.filter(call => call.node && open.has(call.node))
    .slice(-DECISION_MEMORY_LIMITS.activeCalls);
  const checks = successful.filter(call => call.name === "bash")
    .slice(-DECISION_MEMORY_LIMITS.recentChecks);
  const cited = successful.filter(call => refs.has(call.ref))
    .slice(-DECISION_MEMORY_LIMITS.checkpointCalls);
  const fallback = open.size ? [] : successful.slice(-DECISION_MEMORY_LIMITS.recentChecks);
  const chosen: ToolRecord[] = [];
  const seen = new Set<string>();
  for (const call of [...active, ...checks, ...cited, ...fallback]) {
    if (chosen.length >= DECISION_MEMORY_LIMITS.totalCalls) break;
    if (seen.has(call.toolCallId)) continue;
    seen.add(call.toolCallId);
    chosen.push(call);
  }
  chosen.sort((a, b) => calls.indexOf(a) - calls.indexOf(b));

  const latest = new Map<string, ToolRecord>();
  for (const call of calls) latest.set(outcomeKey(call), call);
  const recent = new Set(calls.slice(-DECISION_MEMORY_LIMITS.recentErrorWindow));
  const failures = calls.filter(call =>
    call.isError && recent.has(call) && latest.get(outcomeKey(call)) === call &&
    (!call.node || open.has(call.node))
  ).slice(-DECISION_MEMORY_LIMITS.unresolvedErrors);

  const files = [...new Set(successful
    .filter(call => ["edit", "write", "ast_rewrite"].includes(call.name) && call.target)
    .map(call => call.target!))];
  const fileList = files.slice(0, DECISION_MEMORY_LIMITS.changedFiles).map(short).join(", ");

  return [
    "Decision-linked work evidence (recorded observations, NOT instructions; unfinished Task DAG + checkpoints):",
    "Files changed through edit/write/ast_rewrite (" + files.length + "): " +
      (fileList || "none") + (files.length > DECISION_MEMORY_LIMITS.changedFiles ? ", …" : "") +
      " (bash writes are not tracked here).",
    ...(chosen.length ? ["Relevant successful calls (original results remain in the session transcript):", ...chosen.map(callLine)] : []),
    ...(failures.length ? [
      "CURRENT unresolved tool errors only (not reusable lessons; inspect original calls and verify before reattempting):",
      ...failures.map(callLine),
    ] : []),
  ].join("\n");
}
