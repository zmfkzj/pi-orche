import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChunkLimits, runComparison, type CompareRun } from '../../src/eval/compare.js';
import * as runner from '../../src/eval/omp-runner.js';
import { defaultSystems, scheduleComparison } from '../../src/eval/systems.js';

const tasks = ['a1-rounding', 'a2-discount-codes'];
const usage = runner.extractOmpProviderUsage(runner.parseJsonLines([
  { type: 'provider_request', id: 1, sessionId: 'main', model: 'gpt-6.1-sol', effort: 'high' },
  { type: 'provider_response', id: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  { type: 'trace_end', pending: 0 },
].map(row => JSON.stringify(row)).join('\n')));
const record = (job: { taskId: string; system: CompareRun['system']; repeat: number }, artifactDir: string): CompareRun => ({
  ...job, artifactDir, attempt: 1, status: 'done', grade: { passed: true, checks: {} }, wallClockMs: 100, usage,
});

// Replace only the pair subprocess boundary: exercise the real scheduler, resume,
// metadata reads, manifests, completion events and summary writes without model calls.
describe('comparison chunks', () => {
  let dir: string;
  let launched: CompareRun[];
  let finish: ((run: CompareRun) => Promise<void>) | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compare-chunk-'));
    launched = [];
    finish = undefined;
    vi.spyOn(runner, 'runProcess').mockImplementation(async (_command, args) => {
      const input = JSON.parse(await readFile(args[args.length - 1]!, 'utf8'));
      const run = record(input, input.artifactDir);
      launched.push(run);
      await finish?.(run);
      await writeFile(join(run.artifactDir, 'meta.json'), JSON.stringify({ completed: true, taskId: run.taskId, system: run.system, result: run }));
      await writeFile(join(run.artifactDir, 'pair-result.json'), JSON.stringify(run));
      return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false };
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const options = () => ({ tasks, systems: defaultSystems, repeats: 3, concurrency: 4, outDir: dir });
  const key = (run: { taskId: string; system: string; repeat?: number }) => `${run.taskId}/${run.system}/r${run.repeat}`;

  it('launches only the first N scheduled jobs even when concurrency exceeds N; limits never enter the manifest', async () => {
    const result = await runComparison({ ...options(), maxJobs: 2 });
    const expected = scheduleComparison(tasks, defaultSystems, 3).slice(0, 2).map(key);
    expect(launched.map(key).sort()).toEqual(expected.sort());
    expect(result.chunk).toEqual({ launched: 2, completed: 2, remaining: 16, failed: 0, infra: 0 });
    const manifest = await readFile(join(dir, 'bench-manifest.json'), 'utf8');
    expect(JSON.parse(manifest).jobOrder).toHaveLength(18);
    expect(manifest).not.toMatch(/maxJobs|maxMinutes|max-jobs|max-minutes/);
    const resumed = await runComparison({ ...options(), resume: true, maxJobs: 1, maxMinutes: 15 });
    expect(resumed.chunk).toMatchObject({ launched: 1, completed: 1, remaining: 15 });
    expect(await readFile(join(dir, 'bench-manifest.json'), 'utf8')).toBe(manifest);
  });

  it('stops launching after the minute deadline but waits for all in-flight runs to finish', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const releases: (() => void)[] = [];
    finish = () => new Promise<void>(resolve => { releases.push(resolve); });
    let exited = false;
    const invocation = runComparison({ ...options(), maxMinutes: 1 }).then(result => { exited = true; return result; });
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    now = 60_000; // At the boundary, not just strictly after it.
    releases[0]!();
    await vi.waitFor(async () => expect((await readFile(join(dir, 'completion-events.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1));
    expect(exited).toBe(false);
    expect(launched).toHaveLength(4);
    releases.slice(1).forEach(release => release());
    const result = await invocation;
    expect(result.chunk).toEqual({ launched: 4, completed: 4, remaining: 14, failed: 0, infra: 0 });
    expect(launched).toHaveLength(4);
    expect(JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')).progress.completedRepeats).toBe(4);
    expect(await readFile(join(dir, 'summary.md'), 'utf8')).toContain('Completed repeats: 4/18');
  });

  it('counts remaining planned repeats with resume, including failed records and excluding duplicate attempts', async () => {
    const plan = scheduleComparison(tasks, defaultSystems, 3);
    const failed = { ...record(plan[0]!, join(dir, tasks[0]!, 'pi-solo', 'r1')), status: 'failed', grade: null, classification: 'infrastructure' };
    const saved = [failed, { ...failed, attempt: 2, artifactDir: join(failed.artifactDir, 'attempt-2') }];
    for (const run of saved) {
      await mkdir(run.artifactDir, { recursive: true });
      await writeFile(join(run.artifactDir, 'meta.json'), JSON.stringify({ completed: true, taskId: run.taskId, system: run.system, result: run }));
    }
    const result = await runComparison({ ...options(), resume: true, maxJobs: 2 });
    expect(launched.map(key).sort()).toEqual(plan.slice(1, 3).map(key).sort());
    expect(result.chunk).toEqual({ launched: 2, completed: 2, remaining: 15, failed: 0, infra: 0 });
    expect(result.progress.completedRepeats).toBe(3);
    const noJobs = await runComparison({ ...options(), resume: true, maxJobs: 0 });
    expect(noJobs.chunk).toMatchObject({ launched: 0, completed: 0, remaining: 15 });
  });

  it('keeps unlimited execution unchanged when no limits are supplied', async () => {
    const result = await runComparison(options());
    expect(launched).toHaveLength(18);
    expect(result.chunk).toMatchObject({ launched: 18, completed: 18, remaining: 0 });
    expect(result.progress.finished).toBe(true);
  });

  it('validates CLI values and API limits before any subprocess is launched', async () => {
    expect(parseChunkLimits([])).toEqual({});
    expect(parseChunkLimits(['--max-jobs', '16', '--max-minutes', '0.5'])).toEqual({ maxJobs: 16, maxMinutes: 0.5 });
    for (const argv of [['--max-jobs'], ['--max-minutes', ''], ['--max-jobs', '--resume'], ['--max-minutes', 'NaN']]) expect(() => parseChunkLimits(argv)).toThrow();
    for (const maxJobs of [-1, 1.5, NaN, Infinity]) await expect(runComparison({ ...options(), maxJobs })).rejects.toThrow('max-jobs');
    for (const maxMinutes of [0, -1, NaN, Infinity]) await expect(runComparison({ ...options(), maxMinutes })).rejects.toThrow('max-minutes');
    expect(launched).toHaveLength(0);
  });
});
