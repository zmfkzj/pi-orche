import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSystems, normalizeSystem, scheduleComparison, hasCompletedRepeat, defaultSystems } from '../../src/eval/systems.js';
import { bootstrapCI, passPower, estimateCost, benchmarkStatistics, primaryRepeats, oldTaskIds } from '../../src/eval/bench-stats.js';
import { readSavedRuns, summarizeComparison, runComparison, type CompareRun } from '../../src/eval/compare.js';
import { extractOmpProviderUsage, parseJsonLines, ompEnvironment, assistantCompleted } from '../../src/eval/omp-runner.js';
import { checkProviderParity } from '../../src/eval/parity.js';

describe('provider environment isolation regression', () => {
  it('never hands Pi overlay credentials/catalog/session dirs to omp, preserving unrelated environment', () => {
    const input = { PI_CODING_AGENT_DIR: '/private/pi-overlay', PI_CODING_AGENT_SESSION_DIR: '/private/pi-session', HOME: '/home/benchmark', PATH: '/bin', PI_CODEX_WEBSOCKET: '0' };
    expect(ompEnvironment(input)).toEqual({ HOME: '/home/benchmark', PATH: '/bin', PI_CODEX_WEBSOCKET: '0' });
    expect(input.PI_CODING_AGENT_DIR).toBe('/private/pi-overlay');
  });
  it('normalizes omp top-level diagnostic message strings without accepting malformed message records', () => {
    expect(parseJsonLines('{"type":"warning","message":"Provider notice"}')).toEqual([{ type: 'warning', message: { role: 'diagnostic', content: 'Provider notice' } }]);
    expect(() => parseJsonLines('{"type":"warning","message":42}')).toThrow('Malformed JSON');
  });
  it('uses the same authoritative assistant completion gate for Pi/omp JSON mode and offline recovery', () => {
    expect(assistantCompleted({role:'assistant',stopReason:'stop'})).toBe(true);
    expect(assistantCompleted({role:'assistant'})).toBe(true); // Legacy saved events may omit stopReason.
    for (const message of [undefined,{role:'diagnostic'},{role:'assistant',stopReason:'error'},{role:'assistant',stopReason:'aborted'}]) expect(assistantCompleted(message)).toBe(false);
  });
});
const usage = extractOmpProviderUsage(parseJsonLines([
  { type: 'provider_request', id: 1, sessionId: 'main', model: 'gpt-6.1-sol', effort: 'high' },
  { type: 'provider_response', id: 1, usage: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 5 } },
  { type: 'trace_end', pending: 0 },
].map(row => JSON.stringify(row)).join('\n')));
const run = (taskId: string, system: CompareRun['system'], repeat = 1, passed = true): CompareRun => ({ taskId, system, repeat, attempt: 1, status: 'done', grade: { passed, checks: {} }, wallClockMs: 1000, usage, artifactDir: '/saved', category: 'bugfix' });

describe('benchmark arm selection and scheduling', () => {
  it('defaults to three full product arms; pi aliases direct, not main', () => {
    expect(parseSystems()).toEqual(['pi-solo','pi-orche','omp']);
    expect(normalizeSystem('pi')).toBe('pi-orche-direct');
    expect(parseSystems(['pi','omp'])).toEqual(['pi-orche-direct','omp']);
    for (const values of [[], ['unknown'], ['pi','pi-orche-direct']]) expect(() => parseSystems(values)).toThrow();
  });
  it('interleaves and rotates system order for each task and repeat', () => {
    const jobs = scheduleComparison(['a','b'], defaultSystems, 3);
    expect(jobs).toHaveLength(18);
    const arms = (task: string, repeat: number) => jobs.filter(job => job.taskId === task && job.repeat === repeat).map(job => job.system);
    expect(arms('a',1)).toEqual(['pi-solo','pi-orche','omp']);
    expect(arms('b',1)).toEqual(['pi-orche','omp','pi-solo']);
    expect(arms('a',2)).toEqual(['pi-orche','omp','pi-solo']);
    expect(arms('a',3)).toEqual(['omp','pi-solo','pi-orche']);
    for (const count of [0, -1, 1.5, NaN]) expect(() => scheduleComparison([],defaultSystems,count)).toThrow();
  });
  it('resume skips failed terminal repeats, handles legacy aliasing, never skips other repeats', () => {
    const jobs = scheduleComparison(['a'],['pi-orche-direct'],2);
    const failed = { ...run('a','pi',1,false), status: 'failed' as const };
    expect(hasCompletedRepeat([failed],jobs[0]!)).toBe(true);
    expect(hasCompletedRepeat([failed],jobs[1]!)).toBe(false);
  });
});

describe('rigorous benchmark statistics', () => {
  it('prices uncached input, output, cache read and cache write independently', () => {
    expect(estimateCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(14.6);
    expect(estimateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(estimateCost({ input: 100, output: 20, cacheRead: 1000, cacheWrite: 5 }, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBeCloseTo(0.00316);
  });
  it('computes pass^k without replacement; incomplete cells are null, not failures', () => {
    expect(passPower(3,2,1)).toBeCloseTo(2/3);
    expect(passPower(3,2,2)).toBeCloseTo(1/3);
    expect(passPower(3,2,3)).toBe(0);
    expect(passPower(3,3,3)).toBe(1);
    expect(passPower(1,1,3)).toBeNull();
    expect(() => passPower(2,3,1)).toThrow();
  });
  it('bootstrap percentile intervals are deterministic, task-level and defined on tiny/empty data', () => {
    expect(bootstrapCI([1,2,3,10],42,1000)).toEqual(bootstrapCI([1,2,3,10],42,1000));
    expect(bootstrapCI([3,3])).toEqual({ n: 2, mean: 3, low: 3, high: 3 });
    expect(bootstrapCI([])).toEqual({ n: 0, mean: null, low: null, high: null });
    const ci = bootstrapCI([-1,0,1]);
    expect(ci.low!).toBeLessThanOrEqual(ci.mean!); expect(ci.high!).toBeGreaterThanOrEqual(ci.mean!);
  });
  it('retains failed repeats and separates reruns from primary quality/accounting', () => {
    const failed = run('a1-rounding','pi-orche',1,false), rerun = { ...failed, attempt: 2, grade: { passed: true, checks: {} } };
    const stats = benchmarkStatistics([failed,run('a1-rounding','pi-orche',2),run('a1-rounding','pi-orche',3),rerun],3);
    expect(primaryRepeats([rerun,failed])).toEqual([failed]);
    expect(stats.recordedRuns).toBe(4); expect(stats.primaryRuns).toBe(3);
    expect(stats.systems['pi-orche']).toMatchObject({ runs: 3, successes: 2, passRate: 2/3, allKConsistency: { completeTasks: 1, allKPassed: 0, rate: 0 } });
    expect(stats.allAttempts['pi-orche']?.runs).toBe(4);
    expect(stats.systems['pi-orche']?.costPerSuccessfulTaskUSD).toBeCloseTo(3*estimateCost(usage)/2);
    expect(stats.systems['pi-orche']?.timePerSuccessfulTaskMs).toBe(1500);
    expect(stats.byTaskAge.old['pi-orche']?.runs).toBe(3); expect(oldTaskIds.size).toBe(20);
    expect(benchmarkStatistics([run('new','pi-solo')],3).systems['pi-solo']?.allKConsistency.rate).toBeNull();
  });
  it('pairs matching repeats and bootstraps per-task means, not individual repeats', () => {
    const runs = [run('a','pi-orche',1),run('a','pi-orche',2,false),run('a','pi-solo',1,false),run('a','pi-solo',2,false),run('b','pi-orche',1),run('b','pi-solo',2)];
    const pair = benchmarkStatistics(runs,2).paired[0]!;
    expect(pair.perTask).toHaveLength(1); expect(pair.perTask[0]).toMatchObject({ taskId: 'a', repeats: 2, passRate: 0.5 });
    expect(pair.bootstrap95.passRate).toMatchObject({ n: 1, mean: 0.5, low: 0.5, high: 0.5 });
  });
});

describe('partial artifacts and parity', () => {
  it('loads rN/attempt-N plus legacy roots, skips in-progress records; resume invokes no solver', async () => {
    const dir = await mkdtemp(join(tmpdir(),'bench3-resume-'));
    try {
      const records = [run('a1-rounding','pi-solo',1,false),run('a1-rounding','pi-solo',2)];
      for (const record of records) { const path = join(dir,record.taskId,record.system,`r${record.repeat}`); await mkdir(path,{recursive:true}); await writeFile(join(path,'meta.json'),JSON.stringify({ completed: true, taskId: record.taskId, system: record.system, result: record })); }
      const pending = join(dir,'a1-rounding','pi-orche','r1'); await mkdir(pending,{recursive:true}); await writeFile(join(pending,'meta.json'),JSON.stringify({ completed: false }));
      const legacy = join(dir,'a1-rounding','pi'); await mkdir(legacy,{recursive:true}); await writeFile(join(legacy,'meta.json'),JSON.stringify({ completed: true, taskId: 'a1-rounding', system: 'pi', result: run('a1-rounding','pi') }));
      const loaded = await readSavedRuns(dir); expect(loaded).toHaveLength(3);
      expect((await summarizeComparison(dir)).benchmark.recordedRuns).toBe(3);
      expect(await readFile(join(dir,'summary.md'),'utf8')).toContain('Paired task bootstrap');
      await runComparison({ tasks: ['a1-rounding'], systems: ['pi-solo'], repeats: 2, outDir: dir, resume: true });
      await expect(runComparison({ tasks: ['a1-rounding'], systems: ['pi-solo'], repeats: 2, outDir: dir })).rejects.toThrow('Existing run');
      expect((await readSavedRuns(dir)).filter(run => run.system === 'pi-solo')).toHaveLength(2);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('checks captured endpoint/model/effort and solo tools, never config alone', () => {
    const request = { type: 'provider_request', id: 1, model: 'gpt-6.1-sol', effort: 'high', host: 'chatgpt.com', path: '/backend-api/codex/responses', toolNames: ['read','bash','edit','write'] };
    expect(checkProviderParity(JSON.stringify(request),true)).toMatchObject({ passed: true, toolsOffered: ['bash','edit','read','write'] });
    expect(checkProviderParity(JSON.stringify({ ...request, toolNames: ['orche_task'] }),true).passed).toBe(false);
    expect(checkProviderParity(JSON.stringify({ ...request, effort: 'low' })).passed).toBe(false);
    expect(checkProviderParity(JSON.stringify({ ...request, host: 'api.openai.com' })).passed).toBe(false);
    expect(checkProviderParity('',true).passed).toBe(false);
  });
});
