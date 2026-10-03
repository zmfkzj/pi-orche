import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/eval/omp-runner.js';
import type { RunEventSink } from '../../src/orchestration/events.js';

const { orchestrate } = vi.hoisted(() => ({ orchestrate: vi.fn() }));
vi.mock('../../src/orchestration/coordinator.js', () => ({ runOrchestrated: orchestrate }));
vi.mock('../../src/orchestration/routing.js', () => ({ loadRouteConfig: async () => ({}), applyRouteOverrides: () => ({}) }));
const roots: string[] = [];
const originalArgv = process.argv, originalExitCode = process.exitCode;
afterEach(async () => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'orche-events-errors-'));
  roots.push(root); return root;
}

describe('events output errors allow cleanup', () => {
  it('CLI finishes the run and reports a missing events parent with a nonzero exit code', async () => {
    const root = await temp();
    process.argv = ['node', 'cli', '--cwd', root, '--problem', 'test', '--events', join(root, 'missing', 'events.jsonl')];
    process.exitCode = 0;
    let cleanedUp = false;
    orchestrate.mockImplementation(async ({ sink }: { sink: RunEventSink }) => {
      sink({ type: 'run_started', timestamp: Date.now(), mode: 'orchestrated', problem: 'test' });
      await new Promise(resolve => setTimeout(resolve, 50));
      sink({ type: 'run_finished', timestamp: Date.now(), status: 'done', summary: 'finished' });
      cleanedUp = true;
      return { status: 'done', summary: 'finished' };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => { expect(cleanedUp).toBe(true); });
    await import('../../src/cli.js');
    expect(cleanedUp).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('finished'));
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Events output failed:.*ENOENT/));
    expect(process.exitCode).toBe(1);
  });

  it.each(['stdoutFile', 'stderrFile'] as const)('runProcess waits for child cleanup before rejecting a %s error', async fileOption => {
    const root = await temp(), marker = join(root, 'cleanup.txt');
    const script = `const fs = require('node:fs'); console.log('event'); console.error('diagnostic'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'cleaned up'), 100);`;
    await expect(runProcess(process.execPath, ['-e', script], { cwd: root, timeoutMs: 5000, [fileOption]: join(root, 'missing', 'events.jsonl') })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(marker, 'utf8')).toBe('cleaned up');
  });

  it('runProcess still flushes successful output streams', async () => {
    const root = await temp(), stdoutFile = join(root, 'events.jsonl'), stderrFile = join(root, 'stderr.txt');
    const result = await runProcess(process.execPath, ['-e', "console.log('event'); console.error('diagnostic');"], { cwd: root, timeoutMs: 5000, stdoutFile, stderrFile });
    expect(result.exitCode).toBe(0);
    expect(await readFile(stdoutFile, 'utf8')).toBe('event\n');
    expect(await readFile(stderrFile, 'utf8')).toBe('diagnostic\n');
  });
});
