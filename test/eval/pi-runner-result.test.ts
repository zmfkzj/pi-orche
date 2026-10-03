import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPi } from '../../src/eval/pi-runner.js';
import * as runner from '../../src/eval/omp-runner.js';
import type { ProcessResult, RunnerResult } from '../../src/eval/omp-runner.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const success = (answer: string): RunnerResult => ({
  status: 'done', answer, startedAt: 1, finishedAt: 2, exitCode: 0, command: [],
  usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: [], sessionCount: 0, models: [], thinking: [], complete: true, limitations: [], validModelEffort: true, knownUsageRequests: 0, unknownUsageRequests: { count: 0, requests: [] }, blockedRequests: { count: 0, requests: [] }, enforcedRequests: { count: 0, requests: [] } },
});
const processSuccess: ProcessResult = { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' };
async function fixture() {
  const outDir = await mkdtemp(join(tmpdir(), 'orche-pi-result-'));
  roots.push(outDir);
  const resultFile = join(outDir, 'runner-result.json');
  await writeFile(resultFile, JSON.stringify(success('stale answer')));
  return { options: { cwd: outDir, instruction: 'test', outDir, timeoutSec: 1 }, resultFile };
}

describe('Pi runner child results belong to the current successful process', () => {
  it.each([0, 1])('removes a stale result before spawning, even when the new child exits %s without a result', async exitCode => {
    const { options, resultFile } = await fixture();
    vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
      await expect(access(resultFile)).rejects.toMatchObject({ code: 'ENOENT' });
      return { ...processSuccess, exitCode };
    });
    const result = await runPi(options);
    expect(result.status).toBe('failed');
    expect(result.answer).toBe('');
    expect(result.exitCode).toBe(exitCode);
  });

  it.each([
    { exitCode: 1, signal: null, timedOut: false, status: 'failed' },
    { exitCode: null, signal: 'SIGSEGV', timedOut: false, status: 'failed' },
    { exitCode: null, signal: 'SIGKILL', timedOut: true, status: 'timeout' },
  ])('rejects a schema-valid success when the child $status (exit $exitCode, signal $signal)', async ({ status, ...processState }) => {
    const { options, resultFile } = await fixture();
    vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
      await writeFile(resultFile, JSON.stringify(success('fresh but untrustworthy answer')));
      return { ...processSuccess, ...processState };
    });
    const result = await runPi(options);
    expect(result.status).toBe(status);
    expect(result.answer).toBe('');
    expect(result.exitCode).toBe(processState.exitCode);
  });

  it('rejects a malformed current result even when the process exits zero', async () => {
    const { options, resultFile } = await fixture();
    vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
      await writeFile(resultFile, JSON.stringify({ status: 'done', answer: 'invalid' }));
      return processSuccess;
    });
    expect(await runPi(options)).toMatchObject({ status: 'failed', answer: '', error: 'Malformed Pi child result' });
  });

  it('accepts the new valid result after a clean child exit', async () => {
    const { options, resultFile } = await fixture();
    vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
      await writeFile(resultFile, JSON.stringify(success('current answer')));
      return processSuccess;
    });
    expect(await runPi(options)).toMatchObject({ status: 'done', answer: 'current answer', exitCode: 0 });
  });
});
