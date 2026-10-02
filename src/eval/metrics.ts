import type { RunEvent } from '../orchestration/events.js';
import { matchRootCause, type GroundTruth, type GradeResult } from './scenarios.js';

export interface TokenTotals { requests: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }
export interface RunMetrics extends TokenTotals {
  wallClockMs: number | null;
  timeToFirstUsefulResultMs: number | null;
  timeToRootCauseMs: number | null;
  wastedWorkAfterRootCause: TokenTotals | null;
  /** Advisor model calls; already included in the headline totals above. */
  advisorUsage: TokenTotals;
  advisorTriggered: number;
  advisorResults: { ok: number; concern: number; blocker: number };
  advisorDelivered: number;
  advisorFailed: number;
  coordinatorReconsiderations: number;
  awaitedAdvisorCalls: number;
  workerReuseCount: number;
  peerMessageCount: number;
  notesToMain: number;
  nudgeCount: number;
  correctness: { passed: boolean | null; visible: boolean | null; hidden: boolean | null; rootCauseCorrect: boolean | null };
}
const totals = (): TokenTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
export function computeMetrics(events: readonly RunEvent[], groundTruth: GroundTruth, grade: GradeResult | null): RunMetrics {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const start = sorted.find(e => e.type === 'run_started');
  const end = sorted.find(e => e.type === 'run_finished');
  const claim = sorted.find(e => e.type === 'root_cause_claimed' && matchRootCause(e.cause, groundTruth).matched);
  const accept = sorted.find(e => e.type === 'root_cause_accepted' && matchRootCause(e.cause, groundTruth).matched);
  const accepted = sorted.filter(e => e.type === 'root_cause_accepted');
  const all = totals();
  const waste = claim ? totals() : null;
  const advisor = totals();
  const kinds = new Map<string, string>();
  const assignments = new Map<string, number>();
  let peerMessageCount = 0, notesToMain = 0, nudgeCount = 0;
  const advisorResults = { ok: 0, concern: 0, blocker: 0 };
  let advisorTriggered = 0, advisorDelivered = 0, advisorFailed = 0, coordinatorReconsiderations = 0, awaitedAdvisorCalls = 0;
  for (const event of sorted) {
    if (event.type === 'advisor_triggered') { advisorTriggered++; if (event.await) awaitedAdvisorCalls++; }
    if (event.type === 'advisor_result') { advisorResults[event.verdict]++; if (event.delivered) advisorDelivered++; }
    if (event.type === 'advisor_failed') advisorFailed++;
    if (event.type === 'coordinator_reconsidering') coordinatorReconsiderations++;
    if (event.type === 'assignment_nudged') nudgeCount++;
    if (event.type === 'assignment_started') {
      kinds.set(event.assignment.id, event.assignment.kind);
      assignments.set(event.agentId, (assignments.get(event.agentId) ?? 0) + 1);
    }
    if (event.type === 'usage' || event.type === 'coordinator_usage' || event.type === 'advisor_usage') {
      const add = (target: TokenTotals) => {
        target.requests++; target.inputTokens += event.input; target.outputTokens += event.output;
        target.cacheRead += event.cacheRead; target.cacheWrite += event.cacheWrite;
      };
      add(all);
      if (event.type === 'advisor_usage') add(advisor);
      if (waste && claim?.type === 'root_cause_claimed' && event.type === 'usage' && event.timestamp > claim.timestamp && event.agentId !== claim.agentId && kinds.get(event.assignmentId) === 'explore') add(waste);
    }
    if (event.type === 'message_sent' && event.message.type === 'note' && event.message.from !== 'main') {
      if (event.message.to === 'main') notesToMain++; else peerMessageCount++;
    }
  }
  const elapsed = (event: RunEvent | undefined) => start && event ? event.timestamp - start.timestamp : null;
  return { ...all, wallClockMs: elapsed(end), timeToFirstUsefulResultMs: elapsed(claim), timeToRootCauseMs: elapsed(accept),
    wastedWorkAfterRootCause: waste, advisorUsage: advisor, workerReuseCount: [...assignments.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    peerMessageCount, notesToMain, nudgeCount,
    advisorTriggered, advisorResults, advisorDelivered, advisorFailed, coordinatorReconsiderations, awaitedAdvisorCalls,
    correctness: { passed: grade?.passed ?? null, visible: grade?.visible.passed ?? null,
      hidden: grade?.hidden.passed ?? null, rootCauseCorrect: accepted.length ? !!accept : null } };
}

/** Attribute usage to assignment identity, never to an agent's latest phase. */
export function computeUsageByKind(events: readonly RunEvent[]): Record<string, TokenTotals> {
  const byKind: Record<string, TokenTotals> = Object.fromEntries(
    ['coordinator', 'advisor', 'explore', 'backlog_proposal', 'implement', 'fix', 'verify'].map(kind => [kind, totals()]),
  );
  const assignments = new Map<string, string>();
  for (const event of events) if (event.type === 'assignment_started') assignments.set(event.assignment.id, event.assignment.kind);
  for (const event of events) {
    if (event.type !== 'usage' && event.type !== 'coordinator_usage' && event.type !== 'advisor_usage') continue;
    const kind = event.type === 'coordinator_usage' ? 'coordinator' : event.type === 'advisor_usage' ? 'advisor' : assignments.get(event.assignmentId) ?? 'unattributed';
    const target = byKind[kind] ??= totals();
    target.requests++; target.inputTokens += event.input; target.outputTokens += event.output;
    target.cacheRead += event.cacheRead; target.cacheWrite += event.cacheWrite;
  }
  return byKind;
}

export interface Statistics { count: number; mean: number | null; min: number | null; max: number | null; stddev: number | null }
export function statistics(values: readonly (number | null)[]): Statistics {
  const defined = values.filter((v): v is number => v !== null);
  if (!defined.length) return { count: 0, mean: null, min: null, max: null, stddev: null };
  const mean = defined.reduce((sum, v) => sum + v, 0) / defined.length;
  return { count: defined.length, mean, min: Math.min(...defined), max: Math.max(...defined), stddev: Math.sqrt(defined.reduce((sum, v) => sum + (v - mean) ** 2, 0) / defined.length) };
}
export function numericMetrics(metrics: RunMetrics): Record<string, number | null> {
  const { correctness: _correctness, wastedWorkAfterRootCause, advisorUsage, advisorResults, ...flat } = metrics;
  const nested = (prefix: string, source: TokenTotals | null) => Object.keys(totals()).map(key => [`${prefix}.${key}`, source?.[key as keyof TokenTotals] ?? null]);
  return { ...flat, ...Object.fromEntries([...nested('wastedWorkAfterRootCause', wastedWorkAfterRootCause), ...nested('advisorUsage', advisorUsage),
    ...Object.entries(advisorResults).map(([verdict, count]) => [`advisorResults.${verdict}`, count])]) };
}
