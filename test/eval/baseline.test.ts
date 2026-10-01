import { afterEach, describe, it, expect, vi, type MockInstance } from 'vitest';
import { fauxAssistantMessage as reply, fauxToolCall as call } from '@earendil-works/pi-ai';
import { runBaseline } from '../../src/eval/baseline.js';
import { AgentManager } from '../../src/agent/agent-manager.js';
import * as factory from '../../src/pi/session-factory.js';
import { deferred, fauxRuntime } from '../helpers/faux.js';
import type { RunEvent } from '../../src/orchestration/events.js';
const decision = (data: Parameters<typeof call>[1]) => reply([call('submit_decision', { decision: data })], { stopReason: 'toolUse' });
const result = (kind: string, data: Parameters<typeof call>[1]) => reply([call('report_result', { kind, summary: kind, data })], { stopReason: 'toolUse' });
afterEach(() => vi.restoreAllMocks());
describe('real-session fork-join baseline', () => {
  it('honors config repair limits and lets explicit API budgets override them', async () => {
    for (const override of [false, true]) {
      const f = await fauxRuntime([reply('unstructured'), reply('still unstructured')]);
      const report = await runBaseline({ problem: 'test', cwd: process.cwd(), routes: { routes: {}, default: { model: f.route.model }, limits: { overallMs: 0, decisionRepairs: 0 } }, modelRuntime: f.runtime, ...(override ? { limits: { overallMs: 3000, decisionMs: 1000, decisionRepairs: 1 } } : {}) });
      expect(report.status).toBe('failed');
      expect(report.summary).toBe(override ? 'Coordinator failed to submit a valid decision' : 'Baseline overall timeout');
      if (override) expect(f.faux.state.callCount).toBe(2);
    }
  });

  it('waits for all explorers, uses fresh sessions without peer tools and disposes every session', async () => {
    const f = await fauxRuntime([
      decision({ angles: ['path', 'cause', 'repro'] }),
      result('explore', { cause: 'stale token' }), result('explore', { cause: 'stale token' }), result('explore', { cause: 'stale token' }),
      decision({ cause: 'stale token', tasks: [{ id: 'fix', description: 'fix visible code', files: ['src/x.js'] }] }),
      result('implement', {}), result('verify', { passed: true }), decision({ summary: 'Fixed and verified' }),
    ]);
    const disposed: MockInstance<() => void>[] = [];
    const create = factory.createSession;
    vi.spyOn(factory, 'createSession').mockImplementation(async options => {
      const session = await create(options);
      disposed.push(vi.spyOn(session, 'dispose'));
      return session;
    });
    const release = deferred(), entered = deferred();
    const snapshots: { id: string; tools: string[] }[] = [];
    const spawn = AgentManager.prototype.spawn;
    vi.spyOn(AgentManager.prototype, 'spawn').mockImplementation(async function(this: AgentManager, options) {
      const handle = await spawn.call(this, options);
      const session = this.session(options.id);
      snapshots.push({ id: options.id, tools: session.agent.state.tools.map(t => t.name) });
      if (snapshots.length === 1) {
        const tool = session.agent.state.tools.find(t => t.name === 'report_result')!;
        const execute = tool.execute;
        tool.execute = async (...args) => { entered.resolve(); await release.promise; return execute(...args); };
      }
      return handle;
    });
    const events: RunEvent[] = [];
    const pending = runBaseline({ problem: 'Fix visible problem', cwd: process.cwd(), routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: e => events.push(e), limits: { overallMs: 5000, assignmentMs: 1000, explorationMs: 1000, decisionMs: 1000 } });
    await entered.promise;
    expect(events.some(e => e.type === 'root_cause_accepted')).toBe(false);
    release.resolve();
    const report = await pending;
    expect(report.status).toBe('done');
    const acceptance = events.findIndex(e => e.type === 'root_cause_accepted');
    expect(events.slice(0, acceptance).filter(e => e.type === 'assignment_outcome' && e.outcome.kind === 'explore')).toHaveLength(3);
    expect(snapshots.map(s => s.tools.includes('send_message'))).toEqual([false, false, false, false, false]);
    const assignments = events.filter(e => e.type === 'assignment_started');
    expect(new Set(assignments.map(e => e.type === 'assignment_started' ? e.agentId : '')).size).toBe(5);
    expect(disposed).toHaveLength(6);
    for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
  });
  it('bounds malformed coordinator output and disposes the main session on failure', async () => {
    const f = await fauxRuntime([reply('unstructured output'), reply('still unstructured')]);
    const create = factory.createSession;
    let disposed = false;
    vi.spyOn(factory, 'createSession').mockImplementation(async options => {
      const session = await create(options);
      const dispose = session.dispose.bind(session);
      session.dispose = () => { disposed = true; dispose(); };
      return session;
    });
    const events: RunEvent[] = [];
    const report = await runBaseline({ problem: 'Fix A', cwd: process.cwd(), routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: e => events.push(e), limits: { decisionRepairs: 1, decisionMs: 1000, overallMs: 3000 } });
    expect(report).toMatchObject({ status: 'failed', summary: 'Coordinator failed to submit a valid decision' });
    expect(f.faux.state.callCount).toBe(2);
    expect(disposed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'failed' });
  });
  it('times out an unfinished explorer without integrating and disposes all sessions', async () => {
    const f = await fauxRuntime([decision({ angles: ['path', 'cause', 'repro'] }), result('explore', {}), result('explore', {}), result('explore', {})]);
    const release = deferred();
    const disposed: MockInstance<() => void>[] = [];
    const create = factory.createSession;
    vi.spyOn(factory, 'createSession').mockImplementation(async options => {
      const session = await create(options);
      disposed.push(vi.spyOn(session, 'dispose'));
      const tool = session.agent.state.tools.find(t => t.name === 'report_result');
      if (tool) {
        const execute = tool.execute;
        tool.execute = async (...args) => { await release.promise; return execute(...args); };
      }
      return session;
    });
    const events: RunEvent[] = [];
    const report = await runBaseline({
      problem: 'Fix A', cwd: process.cwd(), routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime,
      limits: { explorationMs: 20, overallMs: 3000, decisionMs: 1000 },
      sink: event => { events.push(event); if (event.type === 'run_finished') release.resolve(); },
    });
    expect(report.status).toBe('failed');
    expect(report.summary).toContain('Worker timeout:');
    expect(events.some(e => e.type === 'root_cause_accepted')).toBe(false);
    expect(disposed).toHaveLength(4);
    for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
  });
  it('does not silently complete an explicitly blocked implementation task', async () => {
    const f = await fauxRuntime([
      decision({ angles: ['path', 'cause', 'repro'] }),
      result('explore', { cause: 'stale token' }), result('explore', {}), result('explore', {}),
      decision({ cause: 'stale token', tasks: [{ id: 'fix', description: 'fix code', files: ['src/x.js'] }] }),
      result('implement', { status: 'blocked' }),
    ]);
    const events: RunEvent[] = [];
    const report = await runBaseline({ problem: 'Fix A', cwd: process.cwd(), routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: e => events.push(e), limits: { overallMs: 5000, assignmentMs: 1000, explorationMs: 1000, decisionMs: 1000 } });
    expect(report).toMatchObject({ status: 'failed', summary: 'Baseline backlog blocked', tasks: [{ id: 'fix', status: 'blocked' }] });
    expect(events.some(e => e.type === 'task_finished' && e.status === 'blocked')).toBe(true);
    expect(events.some(e => e.type === 'verification')).toBe(false);
  });
});
