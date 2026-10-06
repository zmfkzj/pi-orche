/**
 * The split log (docs/orchestrator.md 11): one short JSON line per finished orche_task assignment, so the orchestrator's split
 * decisions in real use can be looked at cheaply long after the 30-day records are pruned.
 *
 * - Where: `<records root>/split-log.jsonl` (the records root is `~/.pi/agent/orche/records` by default). Record pruning only
 *   removes run directories, so the log stays. It is written only when records are enabled (the same privacy switch).
 * - What: time, role, whether the assignment was an orchestrator, its decision (`split`/`none`, the criteria, whether it was
 *   reported), sub-worker count, requests, duration, provider-reported cost, status, the models used and where they came from
 *   (config tier, inherited, route) and the record directory. No request or summary text.
 * - Size: when the file would pass {@link SPLIT_LOG_MAX_BYTES} it is renamed to `split-log.1.jsonl` (replacing the previous one)
 *   and a new file starts; reading takes both, so at most about two files' worth (some 20,000 assignments) is kept.
 * - Reading: `/orche splits [days]` prints {@link formatSplitSummary} of {@link readSplitLog}.
 */
import { renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendPrivate, ensurePrivateDir } from "../agent/private-files.js";

export const SPLIT_LOG = "split-log.jsonl";
export const SPLIT_LOG_ROTATED = "split-log.1.jsonl";
export const SPLIT_LOG_MAX_BYTES = 2_000_000;

export interface SplitLogEntry {
  /** ISO time the assignment finished. */
  ts: string;
  role: string;
  /** The assignment ran as an orchestrator (implement/answer in the single workflow with `single.spawn`). */
  orchestrator: boolean;
  /** `split` or `none` for an orchestrator (`none` when it spawned nothing and reported nothing); null otherwise. */
  decision: "split" | "none" | null;
  /** The orchestrator reported `data.split`. */
  reported: boolean;
  criteria: string[];
  subWorkers: number;
  /** The worker's own requests; sub-workers' are in `subRequests`. */
  requests: number;
  subRequests: number;
  durationMs: number;
  /** Provider-reported cost of the worker and its sub-workers; null when the provider reported none. */
  costUSD: number | null;
  status: string;
  model?: string;
  /** Where `model` came from: `models.orchestrator` (config), main's model (main) or a configured route (route). */
  modelSource?: "config" | "main" | "route";
  /** The distinct models the sub-workers ran on and where each came from (config: `models.worker`, orchestrator, route: specialist). */
  workerModels?: { model: string; source: "config" | "orchestrator" | "route" }[];
  record?: string;
}

/** Append one entry; rotates first when the file would pass `maxBytes`. Never throws (the log must not fail a task). */
export function appendSplitLog(root: string, entry: SplitLogEntry, maxBytes: number = SPLIT_LOG_MAX_BYTES): void {
  try {
    ensurePrivateDir(root);
    const file = join(root, SPLIT_LOG);
    const line = `${JSON.stringify(entry)}\n`;
    let size = 0;
    try { size = statSync(file).size; } catch { /* no file yet */ }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, join(root, SPLIT_LOG_ROTATED));
    appendPrivate(file, line);
  } catch { /* best effort */ }
}

/** Every entry of the current and the rotated file, oldest first; unreadable lines are skipped. */
export async function readSplitLog(root: string): Promise<SplitLogEntry[]> {
  const entries: SplitLogEntry[] = [];
  for (const name of [SPLIT_LOG_ROTATED, SPLIT_LOG]) {
    let text = "";
    try { text = await readFile(join(root, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SplitLogEntry;
        if (typeof entry.ts === "string" && typeof entry.role === "string") entries.push(entry);
      } catch { /* a torn line */ }
    }
  }
  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface SplitSummary {
  since?: string;
  assignments: number;
  orchestrator: number;
  split: number;
  /** Orchestrator assignments without a reported decision (and nothing spawned). */
  unreported: number;
  criteria: Record<string, number>;
  /** Per decision: count, done count, median duration (ms), median and total cost (USD, over entries with a cost), mean sub-workers. */
  byDecision: Record<"split" | "none", { count: number; done: number; medianMs: number | null; medianCostUSD: number | null; totalCostUSD: number; meanSubWorkers: number }>;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Aggregate entries finished at or after `sinceMs` (all when omitted). */
export function summarizeSplits(entries: readonly SplitLogEntry[], sinceMs?: number): SplitSummary {
  const chosen = sinceMs === undefined ? [...entries] : entries.filter(entry => Date.parse(entry.ts) >= sinceMs);
  const orchestrators = chosen.filter(entry => entry.orchestrator);
  const criteria: Record<string, number> = {};
  for (const entry of orchestrators) for (const name of entry.criteria) criteria[name] = (criteria[name] ?? 0) + 1;
  const group = (decision: "split" | "none") => {
    const mine = orchestrators.filter(entry => entry.decision === decision);
    const costs = mine.flatMap(entry => entry.costUSD === null ? [] : [entry.costUSD]);
    return {
      count: mine.length,
      done: mine.filter(entry => entry.status === "done").length,
      medianMs: median(mine.map(entry => entry.durationMs)),
      medianCostUSD: median(costs),
      totalCostUSD: costs.reduce((sum, cost) => sum + cost, 0),
      meanSubWorkers: mine.length ? mine.reduce((sum, entry) => sum + entry.subWorkers, 0) / mine.length : 0,
    };
  };
  return {
    ...(sinceMs !== undefined ? { since: new Date(sinceMs).toISOString() } : {}),
    assignments: chosen.length,
    orchestrator: orchestrators.length,
    split: orchestrators.filter(entry => entry.decision === "split").length,
    unreported: orchestrators.filter(entry => !entry.reported && entry.decision === "none").length,
    criteria,
    byDecision: { split: group("split"), none: group("none") },
  };
}

const seconds = (ms: number | null) => (ms === null ? "–" : `${Math.round(ms / 1000)}s`);
const dollars = (usd: number | null) => (usd === null ? "–" : `$${usd.toFixed(2)}`);

/** The text `/orche splits` shows. */
export function formatSplitSummary(summary: SplitSummary, root: string): string {
  if (!summary.assignments) return `No orche_task assignments in the split log${summary.since ? ` since ${summary.since.slice(0, 10)}` : ""} (${join(root, SPLIT_LOG)}).`;
  const rate = summary.orchestrator ? `${((100 * summary.split) / summary.orchestrator).toFixed(1)}%` : "–";
  const criteria = Object.entries(summary.criteria).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ") || "none";
  const line = (name: "split" | "none") => {
    const group = summary.byDecision[name];
    return `- ${name}: ${group.count} (done ${group.done}), median ${seconds(group.medianMs)}, median ${dollars(group.medianCostUSD)}, total ${dollars(group.totalCostUSD)}${name === "split" ? `, ${group.meanSubWorkers.toFixed(1)} sub-workers on average` : ""}`;
  };
  return [
    `orche split log${summary.since ? ` since ${summary.since.slice(0, 10)}` : ""} (${join(root, SPLIT_LOG)}):`,
    `${summary.assignments} assignments, ${summary.orchestrator} as orchestrator; split ${summary.split} (${rate})${summary.unreported ? `, ${summary.unreported} without a reported decision` : ""}.`,
    `Criteria: ${criteria}.`,
    line("split"),
    line("none"),
  ].join("\n");
}
