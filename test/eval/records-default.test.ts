import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage as reply, fauxToolCall as call } from '@earendil-works/pi-ai';
import { runBaseline } from '../../src/eval/baseline.js';
import { createPiJudge } from '../../src/eval/suite.js';
import { directorySessionRecords } from '../../src/agent/records.js';
import * as factory from '../../src/pi/session-factory.js';
import { fauxRuntime } from '../helpers/faux.js';

// Eval and benchmark paths measure a model; they never persist transcripts unless the caller opts in.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orche-eval-records-'));
  roots.push(root);
  return root;
}
const decision = (data: Parameters<typeof call>[1]) => reply([call('submit_decision', { decision: data })], { stopReason: 'toolUse' });
const result = (kind: string, data: Parameters<typeof call>[1]) => reply([call('report_result', { kind, summary: kind, data })], { stopReason: 'toolUse' });
const baselineSteps = () => [
  decision({ angles: ['path', 'cause', 'repro'] }),
  result('explore', { cause: 'stale token' }), result('explore', { cause: 'stale token' }), result('explore', { cause: 'stale token' }),
  decision({ cause: 'stale token', tasks: [{ id: 'fix', description: 'fix visible code', files: ['src/x.js'] }] }),
  result('implement', {}), result('verify', { passed: true }), decision({ summary: 'Fixed and verified' }),
];
const limits = { overallMs: 10_000, assignmentMs: 3000, explorationMs: 3000, decisionMs: 3000 };
function spyTargets() {
  const targets: Array<{ sessionDir?: string; sessionFile?: string }> = [];
  const files: Array<string | undefined> = [];
  const create = factory.createSession;
  vi.spyOn(factory, 'createSession').mockImplementation(async options => {
    targets.push({ sessionDir: options.sessionDir, sessionFile: options.sessionFile });
    const session = await create(options);
    files.push(session.sessionFile);
    return session;
  });
  return { targets, files };
}

describe('eval paths and session records', () => {
  it('the fork-join baseline keeps every session in memory by default', async () => {
    const f = await fauxRuntime(baselineSteps());
    const cwd = await temp();
    const { targets, files } = spyTargets();
    const report = await runBaseline({ problem: 'Fix visible problem', cwd, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, limits });
    expect(report.status).toBe('done');
    expect(targets).toHaveLength(6);
    expect(targets.every(target => target.sessionDir === undefined && target.sessionFile === undefined)).toBe(true);
    expect(files.every(file => file === undefined)).toBe(true);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('the baseline persists its coordinator and workers only when records are passed', async () => {
    const f = await fauxRuntime(baselineSteps());
    const cwd = await temp();
    const out = await temp();
    const records = directorySessionRecords(join(out, 'transcripts'));
    const report = await runBaseline({ problem: 'Fix visible problem', cwd, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, limits, records });
    expect(report.status).toBe('done');
    const names = (await readdir(join(out, 'transcripts'))).sort();
    expect(names).toEqual(['baseline-explore-1.jsonl', 'baseline-explore-2.jsonl', 'baseline-explore-3.jsonl', 'baseline-implement-4.jsonl', 'baseline-verify-5.jsonl', 'coordinator.jsonl']);
    expect(records.entries.map(entry => entry.id).sort()).toEqual(['baseline-explore-1', 'baseline-explore-2', 'baseline-explore-3', 'baseline-implement-4', 'baseline-verify-5', 'coordinator']);
    expect(records.entries.find(entry => entry.id === 'coordinator')).toMatchObject({ status: 'completed', requests: 3 });
    const lines = (await readFile(join(out, 'transcripts', 'coordinator.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: { role: string } });
    expect(lines[0]).toMatchObject({ type: 'session' });
    expect(lines.filter(line => line.type === 'message' && line.message?.role === 'assistant')).toHaveLength(3);
    expect((await stat(join(out, 'transcripts', 'coordinator.jsonl'))).mode & 0o777).toBe(0o600);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('the blind judge is in memory unless a sessionDir is given', async () => {
    const verdict = () => reply([call('submit_verdict', { items: [{ id: 'fact', satisfied: true, reason: 'Evidence states the required fact' }] })], { stopReason: 'toolUse' });
    const input = { taskId: 'blind', instruction: 'State the fact', items: [{ id: 'fact', criterion: 'State the fact' }], answer: 'The fact', files: {} };
    const f = await fauxRuntime([verdict, verdict]);
    const { targets, files } = spyTargets();
    await createPiJudge({ model: f.route.model, thinking: 'off', modelRuntime: f.runtime })(input);
    expect(targets).toEqual([{ sessionDir: undefined, sessionFile: undefined }]);
    expect(files).toEqual([undefined]);
    const dir = join(await temp(), 'judge');
    await createPiJudge({ model: f.route.model, thinking: 'off', modelRuntime: f.runtime, sessionDir: dir })(input);
    expect(files[1]).toBeDefined();
    expect(files[1]!.startsWith(dir)).toBe(true);
    expect(await readdir(dir)).toHaveLength(1);
  });
});
