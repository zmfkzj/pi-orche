import { describe, it, expect } from 'vitest';
import { computeMetrics, computeUsageByKind, numericMetrics, statistics } from '../../src/eval/metrics.js';
import type { RunEvent } from '../../src/orchestration/events.js';
import type { GroundTruth } from '../../src/eval/scenarios.js';
const truth: GroundTruth = { rootCause: { file: 'x', startLine: 1, endLine: 2 }, relatedFiles: [], facts: [], keywordGroups: [['stale'], ['token']], distractors: [] };
const usage = (timestamp: number, agentId: string, assignmentId: string): RunEvent => ({ type: 'usage', timestamp, agentId, assignmentId, model: 'test', input: 10, output: 2, cacheRead: 30, cacheWrite: 4 });
const assignment = (timestamp: number, agentId: string, id: string, kind: string): RunEvent => ({ type: 'assignment_started', timestamp, agentId, assignment: { id, kind, epoch: 1, prompt: '' } });
describe('event-derived evaluation metrics', () => {
  it('separates first matching claim from integration, excludes claimant/non-exploration/coordinator wasted usage and counts reuse and sparse notes', () => {
    const events: RunEvent[] = [
      { type: 'run_started', timestamp: 100, mode: 'baseline', problem: 'A' },
      assignment(101, 'a', 'a1', 'explore'), assignment(102, 'b', 'b1', 'explore'),
      { type: 'root_cause_claimed', timestamp: 110, agentId: 'b', cause: 'wrong', via: 'result' }, usage(115, 'b', 'b1'),
      { type: 'root_cause_claimed', timestamp: 120, agentId: 'a', cause: 'stale token', via: 'note' },
      usage(120, 'b', 'b1'), usage(121, 'a', 'a1'), usage(122, 'b', 'b1'),
      assignment(123, 'b', 'b2', 'implement'), usage(124, 'b', 'b2'),
      { type: 'coordinator_usage', timestamp: 125, model: 'test', input: 5, output: 1, cacheRead: 9, cacheWrite: 0 },
      { type: 'root_cause_accepted', timestamp: 130, agentId: 'main', cause: 'stale token' },
      ...(['b', 'main'] as const).map((to, i): RunEvent => ({ type: 'message_sent', timestamp: 135 + i, message: { type: 'note', id: String(i), from: 'a', to, content: 'info' } })),
      { type: 'message_sent', timestamp: 137, message: { type: 'note', id: 'm', from: 'main', to: 'a', content: 'info' } },
      { type: 'run_finished', timestamp: 150, status: 'done', summary: 'done' },
    ];
    const m = computeMetrics(events, truth, null);
    expect(m).toEqual({ wallClockMs: 50, requests: 6, inputTokens: 55, outputTokens: 11, cacheRead: 159, cacheWrite: 20,
      timeToFirstUsefulResultMs: 20, timeToRootCauseMs: 30, wastedWorkAfterRootCause: { requests: 1, inputTokens: 10, outputTokens: 2, cacheRead: 30, cacheWrite: 4 }, advisorUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, workerReuseCount: 1, peerMessageCount: 1, notesToMain: 1,
      nudgeCount: 0, correctness: { passed: null, visible: null, hidden: null, rootCauseCorrect: true } });
  });
  it('preserves undefined values and distinguishes wrong accepted cause from no cause', () => {
    expect(computeMetrics([], truth, null)).toMatchObject({ wallClockMs: null, timeToFirstUsefulResultMs: null, timeToRootCauseMs: null, wastedWorkAfterRootCause: null, correctness: { rootCauseCorrect: null } });
    expect(computeMetrics([{ type: 'root_cause_accepted', timestamp: 5, agentId: 'main', cause: 'wrong' }], truth, null).correctness.rootCauseCorrect).toBe(false);
    expect(computeMetrics([{ type: 'root_cause_claimed', timestamp: 5, agentId: 'a', cause: 'stale token', via: 'result' }], truth, null)).toMatchObject({ timeToFirstUsefulResultMs: null, timeToRootCauseMs: null, wastedWorkAfterRootCause: { requests: 0 } });
  });
  it('reports independent grade results and population variance without inventing empty samples', () => {
    const result = { passed: false, exitCode: 1, timedOut: false, stdout: '', stderr: '' };
    expect(computeMetrics([], truth, { passed: false, visible: { ...result, passed: true }, hidden: result }).correctness).toEqual({ passed: false, visible: true, hidden: false, rootCauseCorrect: null });
    expect(statistics([null, 2, 4])).toEqual({ count: 2, mean: 3, min: 2, max: 4, stddev: 1 });
    expect(statistics([null])).toEqual({ count: 0, mean: null, min: null, max: null, stddev: null });
  });
  it('attributes reused-worker usage to its assignment even when a late event follows reassignment', () => {
    const events: RunEvent[] = [
      assignment(1, 'a', 'old', 'explore'), assignment(2, 'a', 'new', 'implement'),
      usage(3, 'a', 'old'), usage(4, 'a', 'new'), usage(5, 'a', 'missing'),
      { type: 'coordinator_usage', timestamp: 6, model: 'main', input: 7, output: 3, cacheRead: 12, cacheWrite: 0 },
    ];
    const breakdown = computeUsageByKind(events);
    expect(breakdown.explore).toEqual({ requests: 1, inputTokens: 10, outputTokens: 2, cacheRead: 30, cacheWrite: 4 });
    expect(breakdown.implement).toEqual(breakdown.explore);
    expect(breakdown.coordinator).toEqual({ requests: 1, inputTokens: 7, outputTokens: 3, cacheRead: 12, cacheWrite: 0 });
    expect(breakdown.unattributed).toEqual(breakdown.explore);
    expect(breakdown.fix).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    const aggregate = computeMetrics(events, truth, null);
    for (const key of ['requests', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite'] as const) {
      expect(Object.values(breakdown).reduce((sum, total) => sum + total[key], 0)).toBe(aggregate[key]);
    }
  });
  it('counts a result nudge without inflating assignments or worker reuse', () => {
    const events: RunEvent[] = [
      assignment(1, 'a', 'a1', 'explore'), usage(2, 'a', 'a1'),
      { type: 'assignment_nudged', timestamp: 3, agentId: 'a', assignmentId: 'a1', attempt: 1 },
      usage(4, 'a', 'a1'),
    ];
    expect(computeMetrics(events, truth, null)).toMatchObject({ nudgeCount: 1, workerReuseCount: 0, requests: 2 });
    expect(computeUsageByKind(events).explore?.requests).toBe(2);
  });
  it('counts advisor usage in the headline totals and reports it separately', () => {
    const advisor = (timestamp: number): RunEvent => ({ type: 'advisor_usage', timestamp, name: 'plan-review', model: 'test', input: 100, output: 7, cacheRead: 11, cacheWrite: 3 });
    const events: RunEvent[] = [assignment(1, 'a', 'a1', 'implement'), usage(2, 'a', 'a1'), advisor(3), advisor(4)];
    const metrics = computeMetrics(events, truth, null);
    expect(metrics).toMatchObject({ requests: 3, inputTokens: 210, outputTokens: 16, cacheRead: 52, cacheWrite: 10 });
    expect(metrics.advisorUsage).toEqual({ requests: 2, inputTokens: 200, outputTokens: 14, cacheRead: 22, cacheWrite: 6 });
    expect(numericMetrics(metrics)['advisorUsage.inputTokens']).toBe(200);
    const breakdown = computeUsageByKind(events);
    expect(breakdown.advisor).toEqual(metrics.advisorUsage);
    expect(Object.values(breakdown).reduce((sum, total) => sum + total.requests, 0)).toBe(metrics.requests);
  });
});
