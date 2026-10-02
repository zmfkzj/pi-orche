import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evalRunLimits, fixedBudgetLimits } from '../../src/eval/limits.js';
import { runBenchmark } from '../../src/eval/bench.js';
import { runPiChild } from '../../src/eval/pi-runner.js';
import { runBaseline } from '../../src/eval/baseline.js';
import { runOrchestrated } from '../../src/orchestration/coordinator.js';
import { defaultRunLimits, resolveRunLimits } from '../../src/orchestration/limits.js';

/**
 * (h) The evaluation and benchmark paths keep FIXED budgets: the activity-aware timeout extension of orche_run / orche_task
 * (maxExtensions 10 by default) is off there unless a caller sets `maxExtensions` itself, so arms stay comparable.
 */
vi.mock('@earendil-works/pi-coding-agent', async importOriginal => ({ ...await importOriginal<typeof import('@earendil-works/pi-coding-agent')>(), ModelRuntime: { create: async () => ({ streamSimple: vi.fn() }) } }));
const report = { status: 'done' as const, taskClass: 'unclassified', answer: 'ok', summary: 'ok', tasks: [], startedAt: 1, finishedAt: 2 };
vi.mock('../../src/orchestration/coordinator.js', () => ({ runOrchestrated: vi.fn(async (options: { sink?: (event: unknown) => void }) => { options.sink?.({ type: 'run_started', timestamp: 1, mode: 'orchestrated', problem: 'p' }); options.sink?.({ type: 'run_finished', timestamp: 2, status: 'done', summary: 'ok' }); return report; }) }));
vi.mock('../../src/eval/baseline.js', () => ({ runBaseline: vi.fn(async (options: { sink?: (event: unknown) => void }) => { options.sink?.({ type: 'run_started', timestamp: 1, mode: 'baseline', problem: 'p' }); options.sink?.({ type: 'run_finished', timestamp: 2, status: 'done', summary: 'ok' }); return report; }) }));
vi.mock('../../src/eval/scenarios.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/eval/scenarios.js')>();
  const command = { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  return { ...original, prepareWorkspace: vi.fn(async () => ({ dir: process.cwd(), cleanup: async () => undefined })), gradeWorkspace: vi.fn(async () => ({ passed: true, visible: command, hidden: command })) };
});
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'fixed-budget-')); dirs.push(dir); return dir; };

describe('fixed budgets for the evaluation paths', () => {
  it('the helpers turn extension off by default, keep every other limit, and let a caller opt in explicitly', () => {
    expect(defaultRunLimits.maxExtensions).toBe(10); // the product default...
    expect(fixedBudgetLimits()).toEqual({ maxExtensions: 0 }); // ...is not the evaluation default
    expect(resolveRunLimits(undefined, fixedBudgetLimits()).maxExtensions).toBe(0); // and it is what an evaluation run resolves to
    expect(fixedBudgetLimits({ overallMs: 5000, decisionMs: 100 })).toEqual({ overallMs: 5000, decisionMs: 100, maxExtensions: 0 });
    expect(fixedBudgetLimits({ maxExtensions: 2 })).toEqual({ maxExtensions: 2 });
    expect(evalRunLimits(90)).toEqual({ overallMs: 90_000, maxExtensions: 0 });
    // Resolved, and above a config's own `limits` (limits of the user's orche.config.json must not turn extension on in a benchmark).
    expect(resolveRunLimits({ maxExtensions: 3, extensionMs: 60_000 }, evalRunLimits(90))).toMatchObject({ overallMs: 90_000, assignmentMs: 90_000, maxExtensions: 0, extensionMs: 60_000 });
  });

  it('Pi evaluation runs (runPiChild) pass fixed limits to runOrchestrated and record them in the command metadata', async () => {
    const outDir = await tempDir();
    const result = await runPiChild({ arm: 'A1', baseModel: 'cliproxyapi/gpt-6.1-sol', cwd: outDir, outDir, instruction: 'test', timeoutSec: 7 });
    expect(runOrchestrated).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOrchestrated).mock.calls[0]![0].limits).toEqual({ overallMs: 7000, maxExtensions: 0 });
    expect(JSON.parse(result.command[1]!).limits).toEqual({ overallMs: 7000, maxExtensions: 0 });
  });

  it('the benchmark runs both arms with maxExtensions 0 by default, records that in config.json, and honors an explicit value', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined); // the benchmark prints a line per trial
    const root = await tempDir();
    const config = join(root, 'orche.config.json');
    await writeFile(config, JSON.stringify({ routes: {}, default: { model: 'faux/model' }, limits: { maxExtensions: 3 } }));
    const modes = ['baseline', 'orchestrated'] as const;

    await runBenchmark({ runs: 1, modes, config, outputDir: join(root, 'default') });
    expect(vi.mocked(runBaseline).mock.calls[0]![0].limits).toEqual({ maxExtensions: 0 });
    expect(vi.mocked(runOrchestrated).mock.calls[0]![0].limits).toEqual({ maxExtensions: 0 });
    expect(JSON.parse(await readFile(join(root, 'default', 'config.json'), 'utf8')).limits).toEqual({ maxExtensions: 0 });

    vi.clearAllMocks();
    await runBenchmark({ runs: 1, modes, config, outputDir: join(root, 'limited'), limits: { overallMs: 5000 } });
    expect(vi.mocked(runOrchestrated).mock.calls[0]![0].limits).toEqual({ overallMs: 5000, maxExtensions: 0 });
    expect(JSON.parse(await readFile(join(root, 'limited', 'config.json'), 'utf8')).limits).toEqual({ overallMs: 5000, maxExtensions: 0 });

    vi.clearAllMocks();
    await runBenchmark({ runs: 1, modes: ['orchestrated'], config, outputDir: join(root, 'explicit'), limits: { maxExtensions: 1 } });
    expect(vi.mocked(runOrchestrated).mock.calls[0]![0].limits).toEqual({ maxExtensions: 1 });
  });
});
