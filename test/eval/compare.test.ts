import { describe, it, expect } from 'vitest';
import { extractOmpProviderUsage, extractOmpSessionUsage, parseJsonLines, type RunnerUsage } from '../../src/eval/omp-runner.js';
import { extractPiRequestUsage, loadPromptVariant, summarizePayloadSystem } from '../../src/eval/pi-runner.js';
import { aggregateComparison, parseBaseModel, recomputeComparison, runPromptStudy, selectAttempts, waitForHold, type CompareRun } from '../../src/eval/compare.js';
import { loadSuite, prepareTaskWorkspace } from '../../src/eval/suite.js';
import { mkdtemp, writeFile, readFile, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
// Sanitized real probe records: pilot-2026-09-30-reprobe/probes/omp/provider-requests.jsonl.
// No prompt, credential or provider replay payload is included.
const recordedOmp = [
  { type: 'provider_request', id: 1, model: 'gpt-6.1-sol', effort: 'high', sessionId: '01a0f38a-d460-732e-9b33-c82c360394df' },
  { type: 'provider_request', id: 2, model: 'gpt-6.1-sol', effort: 'high', sessionId: '01a0f38a-d75f-70c2-8e49-f8ec71225c94' },
  { type: 'provider_response', id: 1, status: 200, usage: { input: 10013, output: 10, cacheRead: 0, cacheWrite: 0 } },
  { type: 'provider_request', id: 3, model: 'gpt-6.1-sol', effort: 'high', sessionId: '01a0f38a-e13e-7205-9cb5-6b96cca9b04c' },
  { type: 'provider_response', id: 3, status: 200, usage: null, error: 'AbortError' },
  { type: 'provider_response', id: 2, status: 200, usage: { input: 211, output: 38, cacheRead: 1792, cacheWrite: 0 } },
  { type: 'trace_end', pending: 0 },
];
const jsonl = (records: readonly unknown[]) => records.map(value => JSON.stringify(value)).join('\n');
const usage = (): RunnerUsage => extractOmpProviderUsage(parseJsonLines(jsonl(recordedOmp)));

describe('comparison usage accounting', () => {
  it('includes main, advisor and aborted unpersisted request while keeping unknown tokens explicit', () => {
    const result = usage();
    expect(result).toMatchObject({ requests: 3, knownUsageRequests: 2, input: 10224, output: 48, cacheRead: 1792, cacheWrite: 0, sessionCount: 3, models: ['openai-codex/gpt-6.1-sol'], thinking: ['high'], validModelEffort: true, complete: false });
    expect(result.unknownUsageRequests).toEqual({ count: 1, requests: [{ requestId: '3', sessionId: '01a0f38a-e13e-7205-9cb5-6b96cca9b04c', purpose: 'unidentified side call', reason: 'No final provider usage (HTTP 200, AbortError)' }] });
  });
  it('counts saved assistant and side-call usage once, not repeated projections, and does not invent missing thinking', () => {
    const assistant = { type: 'message', id: '4c153ab7', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol', usage: { input: 10013, output: 10, cacheRead: 0, cacheWrite: 0 } } };
    const side = { type: 'model_usage', id: 'side', provider: 'openai-codex', model: 'gpt-6.1-sol', usage: { input: 211, output: 38, cacheRead: 1792, cacheWrite: 0 } };
    const result = extractOmpSessionUsage('main', parseJsonLines(jsonl([{ type: 'thinking_level_change', thinkingLevel: 'high' }, assistant, assistant, side])));
    expect(result).toMatchObject({ requests: 2, input: 10224, output: 48, cacheRead: 1792, thinking: ['high'] });
    expect(extractOmpSessionUsage('advisor', parseJsonLines(jsonl([assistant]))).thinking).toEqual([null]);
  });
  it('accepts injected string content alongside parts without losing session usage or metadata', () => {
    const rows = parseJsonLines(jsonl([
      { type: 'session', id: 'worker' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      { type: 'message', message: { role: 'user', content: '<system-notice>Background job completed.</system-notice>' } },
      { type: 'message', id: 'reply', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol', content: 'Completed.', usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 } } },
      { type: 'message', id: 'parts', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol', content: [{ type: 'text', text: 'Verified.' }], usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 } } },
    ]));
    expect(rows.find(row => row.type === 'session')).toEqual({ type: 'session', id: 'worker' });
    expect(extractOmpSessionUsage('worker', rows)).toEqual({ id: 'worker', source: 'session-jsonl', requests: 2, input: 14, output: 3, cacheRead: 3, cacheWrite: 0, models: ['openai-codex/gpt-6.1-sol'], thinking: ['high'] });
  });
  it('rejects invalid JSON, missing record types and malformed content', () => {
    expect(() => parseJsonLines('not JSON')).toThrow('Malformed JSON event/session record');
    for (const record of [
      { message: { content: 'Missing type' } },
      { type: 'message', message: { content: 42 } },
      { type: 'message', message: { content: [{ text: 'Missing part type' }] } },
    ]) expect(() => parseJsonLines(jsonl([record]))).toThrow('Malformed JSON event/session record');
  });
  it('flags lower effort even when that request has no usage and catches unsettled capture', () => {
    const invalid = extractOmpProviderUsage(parseJsonLines(jsonl([{ type: 'provider_request', id: 1, sessionId: 's', model: 'gpt-6.1-sol', effort: 'medium' }, { type: 'provider_blocked', id: 1, reason: 'blocked' }, { type: 'trace_end', pending: 0 }])));
    expect(invalid).toMatchObject({ validModelEffort: false, complete: true, requests: 0, knownUsageRequests: 0, unknownUsageRequests: { count: 0 }, blockedRequests: { count: 1 } });
    const unsettled = extractOmpProviderUsage(parseJsonLines(jsonl([{ type: 'provider_request', id: 1, sessionId: 's', model: 'gpt-6.1-sol', effort: 'high' }])));
    expect(unsettled.complete).toBe(false);
    expect(unsettled.unknownUsageRequests.count).toBe(1);
  });
  it('validates external usage fields rather than silently dropping invalid numeric records', () => {
    expect(() => parseJsonLines(jsonl([{ type: 'provider_response', id: 1, usage: { input: 'bad', output: 1, cacheRead: 0, cacheWrite: 0 } }]))).toThrow();
  });
  it('reads the recorded Pi payload/response with actual high effort and separate cache tokens', () => {
    const result = extractPiRequestUsage(jsonl([
      { type: 'provider_request', id: 1, model: 'openai/gpt-6.1-sol', effort: 'high', sessionId: '01a0f385-3a1a-74a6-8a38-bce1ce02159a' },
      { type: 'provider_response', id: 1, model: 'openai/gpt-6.1-sol', effort: 'high', sessionId: '01a0f385-3a1a-74a6-8a38-bce1ce02159a', usage: { input: 435, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]));
    expect(result).toMatchObject({ requests: 1, input: 435, output: 10, complete: true, validModelEffort: true, unknownUsageRequests: { count: 0 } });
  });
  it('validates the enforced wire effort rather than rejecting the original disabled title setting', () => {
    const result = extractOmpProviderUsage(parseJsonLines(jsonl([
      { type: 'provider_request', id: 1, model: 'gpt-6.1-sol', effort: 'high', originalEffort: null, enforced: true, sessionId: 'label', purpose: 'task-label/title' },
      { type: 'provider_response', id: 1, status: 200, usage: { input: 10, output: 1, cacheRead: 2, cacheWrite: 0 } },
      { type: 'trace_end', pending: 0 },
    ])));
    expect(result).toMatchObject({ requests: 1, complete: true, validModelEffort: true, blockedRequests: { count: 0 }, unknownUsageRequests: { count: 0 } });
    expect(result.enforcedRequests).toEqual({ count: 1, requests: [{ requestId: '1', sessionId: 'label', purpose: 'task-label/title', originalEffort: null, enforcedEffort: 'high' }] });
  });
});

describe('comparison aggregation', () => {
  it('retains failed graded runs and known-token lower bounds instead of treating partial accounting as solver failure', () => {
    const base: CompareRun = { taskId: 'one', system: 'omp', status: 'done', wallClockMs: 100, usage: usage(), grade: { passed: true, checks: { visibleTests: { passed: true, detail: 'pass' } } }, artifactDir: 'one/omp' };
    const result = aggregateComparison([base, { ...base, taskId: 'two', status: 'failed', wallClockMs: 300, error: 'validation incomplete' }, { ...base, system: 'pi', usage: { ...base.usage, validModelEffort: false } }]);
    expect(result.omp).toMatchObject({ runs: 2, completed: 1, gradePassed: 2, succeeded: 1, completeUsageRuns: 0, unknownUsageRequests: 2, metrics: { wallClockMs: { count: 2, mean: 200, min: 100, max: 300, stddev: 100 }, input: { count: 2, mean: 10224 } } });
    expect(result.pi?.succeeded).toBe(0);
    expect(result.omp?.errors).toEqual([{ taskId: 'two', error: 'validation incomplete' }]);
  });
});

describe('saved parser failure recovery', () => {
  it('grades the saved workspace without changing original outcomes or losing unknown requests', async () => {
    const task = (await loadSuite()).find(task=>task.id === 'a1-rounding')!;
    const workspace = await prepareTaskWorkspace(task), out = await mkdtemp(join(tmpdir(), 'compare-regrade-'));
    const dir = join(out, task.id, 'omp');
    try {
      await mkdir(dir, { recursive: true });
      await cp(join(task.dir, 'reference'), workspace.dir, { recursive: true });
      await cp(workspace.dir, join(dir, 'workspace-final'), { recursive: true });
      await mkdir(join(dir, 'sessions'));
      await writeFile(join(dir, 'events.jsonl'), jsonl([{ type: 'message_end', message: { role: 'assistant', content: 'Done.' } }]));
      await writeFile(join(dir, 'provider-requests.jsonl'), jsonl(recordedOmp));
      const result: CompareRun = { taskId: task.id, system: 'omp', status: 'failed', wallClockMs: 100, usage: usage(), grade: null, artifactDir: dir, classification: 'harness defect', error: 'Malformed JSON event/session record: string content' };
      const original = JSON.stringify({ completed: true, taskId: task.id, system: 'omp', result });
      await writeFile(join(dir, 'meta.json'), original);
      await writeFile(join(dir, 'grade.json'), 'null');
      await writeFile(join(out, 'triage.json'), '[{"original":"parser error"}]');
      const summary = await recomputeComparison(out, [task.id+':omp']);
      expect(summary.latestAttemptSystems.omp).toMatchObject({ succeeded: 1, unknownUsageRequests: 1 });
      expect(summary.runs[0]).toMatchObject({ status: 'done', grade: { passed: true, checks: { visibleTests: { passed: true }, hiddenTests: { passed: true } } }, usage: { requests: 3, input: 10224 } });
      expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe(original);
      expect(await readFile(join(dir, 'grade.json'), 'utf8')).toBe('null');
      expect(await readFile(join(out, 'triage.json'), 'utf8')).toBe('[{"original":"parser error"}]');
      expect(JSON.parse(await readFile(join(dir, 'recomputed/meta.json'), 'utf8'))).toMatchObject({ originalStatus: 'failed', originalError: result.error, label: 'recomputed after parser fix (no model rerun)' });
      expect((await recomputeComparison(out)).runs[0]?.grade?.passed).toBe(true);
      await recomputeComparison(out, [], [task.id+':omp']);
      expect(JSON.parse(await readFile(join(dir, 'fixture-regraded/original-grade.json'), 'utf8'))).toEqual(summary.runs[0]?.grade);
      expect(JSON.parse(await readFile(join(dir, 'fixture-regraded/meta.json'), 'utf8'))).toMatchObject({ label: 'regraded after fixture fix (post-hoc, disclosed)', originalAsRunGrade: null });
      expect((await recomputeComparison(out)).runs[0]).toMatchObject({ fixtureRegraded: true, grade: { passed: true } });
      expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe(original);
    } finally { await workspace.cleanup(); await rm(out, { recursive: true, force: true }); }
  });
});

describe('fix-as-you-go controls', () => {
  it('separates first/latest attempts without losing failed history or cross-system independence', () => {
    const first: CompareRun = { taskId: 'a', system: 'pi', attempt: 1, sourceRevision: 'before', status: 'failed', wallClockMs: 1, usage: usage(), grade: null, artifactDir: 'a/pi' };
    const latest: CompareRun = { ...first, attempt: 2, sourceRevision: 'after', status: 'done', artifactDir: 'a/pi/attempt-2' };
    const other: CompareRun = { ...first, system: 'omp', sourceRevision: 'unchanged', artifactDir: 'a/omp' };
    expect(selectAttempts([latest, other, first], 'first').find(run => run.system === 'pi')).toEqual(first);
    expect(selectAttempts([first, latest, other], 'latest').find(run => run.system === 'pi')).toEqual(latest);
    expect(selectAttempts([first, latest, other], 'latest').find(run => run.system === 'omp')).toEqual(other);
  });
  it('does not confuse an absent HOLD with an exhausted HOLD wait and bounds a present gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'compare-hold-'));
    try {
      expect((await waitForHold(dir, 0, 1)).expired).toBe(false);
      await writeFile(join(dir, 'HOLD'), 'fixing');
      expect((await waitForHold(dir, 0, 1)).expired).toBe(true);
      await rm(join(dir, 'HOLD'));
      expect((await waitForHold(dir, 0, 1)).expired).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('prompt variants', () => {
  it('keeps C0 as Pi default, loads others with a content hash, and rejects unknown arms', async () => {
    expect(await loadPromptVariant('C0')).toMatchObject({ text: undefined, sha256: null, chars: 0 });
    const c1 = await loadPromptVariant('C1');
    expect(c1.text).toBeTruthy();
    expect(c1.sha256).toBe(createHash('sha256').update(c1.text!).digest('hex'));
    expect(Buffer.byteLength(c1.text!)).toBeLessThanOrEqual(2048);
    expect((await loadPromptVariant('C2')).sha256).not.toBe(c1.sha256);
    await expect(loadPromptVariant('c1')).rejects.toThrow(/Unknown prompt variant/);
  });
  it('reads the leading system text and an order-independent tool digest from a wire payload', () => {
    const tool = (name: string) => ({ type: 'function', name, parameters: {} });
    const base = { model: 'gpt-6.1-sol', input: [{ role: 'developer', content: 'RULES' }, { role: 'user', content: 'hi' }, { role: 'developer', content: 'mid-run update' }] };
    const a = summarizePayloadSystem({ ...base, tools: [tool('read'), tool('edit')] });
    expect(a).toMatchObject({ system: 'RULES', systemChars: 5, allSystem: 'RULES\nmid-run update', toolNames: ['edit', 'read'] });
    expect(summarizePayloadSystem({ model: 'm', input: [{ role: 'user', content: 'hi' }, { role: 'developer', content: 'LATE' }, { type: 'additional_tools', role: 'developer', tools: [tool('grep')] }] })).toMatchObject({ system: '', allSystem: 'LATE', toolNames: ['grep'] });
    expect(summarizePayloadSystem({ ...base, tools: [tool('edit'), tool('read')] }).toolsSha256).toBe(a.toolsSha256);
    expect(summarizePayloadSystem({ ...base, tools: [tool('edit')] }).toolsSha256).not.toBe(a.toolsSha256);
    expect(summarizePayloadSystem({ instructions: 'ABC', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] }).system).toBe('ABC');
    expect(summarizePayloadSystem({ messages: [{ role: 'system', content: 'CHAT RULES' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read' } }] })).toMatchObject({ system: 'CHAT RULES', inputShape: [':system', ':user'], toolNames: ['read'] });
  });
});


describe('study arm manifest', () => {
  it('parses the base-model flag shared by study and single-run modes', () => {
    expect(parseBaseModel([])).toBe('openai/gpt-6.1-sol');
    for (const mode of ['--study', '--systems']) expect(parseBaseModel([mode, 'pi', '--base-model', 'cliproxyapi/gpt-6.1-sol'])).toBe('cliproxyapi/gpt-6.1-sol');
    for (const args of [['--base-model'], ['--base-model', '--out'], ['--base-model', 'gpt-6.1-sol']]) expect(() => parseBaseModel(args)).toThrow('base-model');
  });
  it('records the configured base model in the manifest and every arm', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'proxy-manifest-'));
    try {
      await runPromptStudy({ tasks: [], variants: ['C0', 'A0', 'A1'], repeats: 1, concurrency: 1, outDir, baseModel: 'cliproxyapi/gpt-6.1-sol' });
      const manifest = JSON.parse(await readFile(join(outDir, 'study-manifest.json'), 'utf8'));
      expect(manifest.baseModel).toBe('cliproxyapi/gpt-6.1-sol');
      for (const arm of manifest.arms) expect(arm).toMatchObject({ baseModel: manifest.baseModel, providerExtensions: ['npm:@router-for-me/pi-cliproxyapi-provider'], allowedModelEffortPairs: expect.arrayContaining([{ actor: 'non-advisor', model: manifest.baseModel, effort: 'high' }]) });
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });
  it('records advisor arms and their actual prompt independently without model calls', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'advisor-manifest-'));
    try {
      const options = { tasks: [], variants: ['C0','A0','A1'], repeats: 1, concurrency: 1, outDir };
      await runPromptStudy(options);
      const manifest = JSON.parse(await readFile(join(outDir, 'study-manifest.json'), 'utf8'));
      expect(manifest.baseModel).toBe('openai/gpt-6.1-sol');
      expect(manifest.variants).toEqual(['C0','A0','A1'].map(name => ({ name, promptVariant: 'C0', file: null, sha256: null, chars: 0 })));
      expect(manifest.arms).toHaveLength(3);
      expect(manifest.arms[0]).toMatchObject({ name: 'C0', advisors: [], advisorRoutes: {}, providerExtensions: [], allowedModelEffortPairs: [{ actor: 'non-advisor', model: 'openai/gpt-6.1-sol', effort: 'high' }] });
      expect(manifest.arms[2]).toMatchObject({ name: 'A1', promptVariant: 'C0', advisors: [{ name: 'plan-review' }, { name: 'verification-audit' }], advisorRoutes: { advisor: { model: 'cliproxyapi/claude-opus-5-5', thinking: 'xhigh' }, 'advisor-plan': { model: 'cliproxyapi/gpt-6-astra', thinking: 'xhigh' } }, providerExtensions: ['npm:@router-for-me/pi-cliproxyapi-provider'] });
      expect(manifest.arms[2].allowedModelEffortPairs).toHaveLength(3);
      await runPromptStudy({ ...options, resume: true });
      expect(JSON.parse(await readFile(join(outDir, 'study-manifest.json'), 'utf8')).arms).toEqual(manifest.arms);
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });
});
