import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from '@earendil-works/pi-ai';
import { runOrchestrated } from '../../src/orchestration/coordinator.js';
import { runBaseline } from '../../src/eval/baseline.js';
import { evalRunLimits } from '../../src/eval/limits.js';
import type { RunEvent } from '../../src/orchestration/events.js';
import { fauxRuntime } from '../helpers/faux.js';

/**
 * (h) at run time: with the evaluation limits an ACTIVE run (a model request that never answers counts as active) still times out at
 * its fixed budget. With the product default (3 extensions of 30 minutes) the same run would be extended instead.
 */
afterEach(() => vi.restoreAllMocks());
const tool = (name: string, args: ToolCall['arguments']) => reply([call(name, args)], { stopReason: 'toolUse' });
const decision = (value: ToolCall['arguments']) => tool('coordinator_decision', { decision: value });
const task = { id: 'change', description: 'edit', owner: 'A1', files: ['core.mjs'], status: 'pending' };
/** A model request that does not answer until it is aborted; `seen` counts how many started. */
const blockedRequest = (seen: { count: number }): FauxResponseStep => async (_context, options) => {
  seen.count++;
  await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
  return reply('stopped');
};

describe('evaluation runs do not extend their deadlines', () => {
  it('runOrchestrated with the Pi evaluation limits times out at the fixed overall cap while a worker is still active', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orche-eval-fixed-'));
    const events: RunEvent[] = [];
    const worker = { count: 0 };
    try {
      const f = await fauxRuntime([
        decision({ type: 'classify', taskClass: 'change', workerCount: 1, language: 'en', reason: 'edit' }),
        decision({ type: 'assign', tasks: [task] }),
        tool('read', { path: 'nonexistent.txt' }), blockedRequest(worker),
      ]);
      const started = Date.now();
      const finished = await runOrchestrated({ problem: 'edit core', cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event), limits: evalRunLimits(0.4) });
      expect(worker.count).toBe(1); // the worker was in the middle of a model request (active) when the cap passed
      expect(finished.status).toBe('failed');
      expect(finished.summary).toContain('overall timeout');
      expect(finished.timeouts?.[0]).toMatchObject({ scope: 'overall', configuredCapMs: 400 });
      expect(events.some(event => event.type === 'deadline_extended')).toBe(false);
      expect(finished).not.toHaveProperty('extensions');
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('the fork-join baseline ignores maxExtensions from its config: an active explorer still times out at the fixed cap', async () => {
    const explorers = { count: 0 };
    const f = await fauxRuntime([
      reply([call('submit_decision', { decision: { angles: ['path', 'cause', 'repro'] } })], { stopReason: 'toolUse' }),
      blockedRequest(explorers), blockedRequest(explorers), blockedRequest(explorers),
    ]);
    const events: RunEvent[] = [];
    const started = Date.now();
    const finished = await runBaseline({
      problem: 'Fix A', cwd: process.cwd(), modelRuntime: f.runtime, sink: event => events.push(event),
      routes: { routes: {}, default: { model: f.route.model }, limits: { maxExtensions: 3, extensionMs: 60_000, activityWindowMs: 60_000 } },
      limits: { overallMs: 3000, explorationMs: 300, decisionMs: 1000, assignmentMs: 1000 },
    });
    expect(explorers.count).toBeGreaterThan(0); // the explorers were waiting for the model (active) when the cap passed
    expect(finished.status).toBe('failed');
    expect(finished.summary).toContain('Worker timeout:');
    expect(events.some(event => event.type === 'deadline_extended')).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
