import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GroundTruth {
  rootCause: { file: string; startLine: number; endLine: number };
  relatedFiles: string[];
  facts: string[];
  keywordGroups: string[][];
  distractors: string[];
}

export interface Scenario {
  id: string;
  title: string;
  userProblemPrompt: string;
  fixtureDir: string;
  hiddenDir: string;
  groundTruth: GroundTruth;
}

export interface PreparedWorkspace {
  dir: string;
  cleanup(): Promise<void>;
}

export interface CommandResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface GradeResult {
  passed: boolean;
  visible: CommandResult;
  hidden: CommandResult;
}

export interface RootCauseMatch {
  matched: boolean;
  score: number;
  matchedGroups: number;
  totalGroups: number;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = join(root, 'fixtures/problem-a');
const hiddenDir = join(root, 'fixtures/problem-a.hidden');

export const problemA: Scenario = {
  id: 'problem-a',
  title: 'Parallel invoice synchronization during credential rotation',
  userProblemPrompt: await readFile(join(fixtureDir, 'ISSUE.md'), 'utf8'),
  fixtureDir,
  hiddenDir,
  groundTruth: JSON.parse(await readFile(join(hiddenDir, 'ground-truth.json'), 'utf8')) as GroundTruth,
};

export const scenarios: readonly Scenario[] = [problemA];

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  execFile(command, args, { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({
      passed: error === null,
      exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
      timedOut: error !== null && error.killed === true && error.signal === 'SIGKILL',
      stdout,
      stderr: stderr + (error && !stderr ? '\n' + error.message : ''),
    });
  });
  return promise;
}

/** Creates a visible-only workspace. Hidden grading data is never copied here. */
export async function prepareWorkspace(scenario: Scenario = problemA): Promise<PreparedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-orche-' + scenario.id + '-'));
  try {
    await cp(scenario.fixtureDir, dir, { recursive: true });
    for (const args of [
      ['init', '--quiet'],
      ['add', '.'],
      ['-c', 'user.name=pi-orche', '-c', 'user.email=benchmark@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial benchmark fixture'],
    ]) {
      const result = await run('git', args, dir, 10_000);
      if (!result.passed) throw new Error('Workspace git setup failed: ' + result.stderr);
    }
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Both suites run in disposable copies; grading does not touch worker state. */
export async function gradeWorkspace(dir: string, scenario: Scenario = problemA, timeoutMs = 10_000): Promise<GradeResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive and finite');
  const gradingDir = await mkdtemp(join(tmpdir(), 'pi-orche-grade-'));
  try {
    const visibleDir = join(gradingDir, 'visible');
    const hiddenWorkspace = join(gradingDir, 'hidden');
    await cp(dir, visibleDir, { recursive: true, filter: source => source !== join(dir, '.git') });
    await cp(dir, hiddenWorkspace, { recursive: true, filter: source => source !== join(dir, '.git') });
    await cp(join(scenario.hiddenDir, 'acceptance.test.js'), join(hiddenWorkspace, 'test', 'acceptance.hidden.test.js'));
    const [visible, hidden] = await Promise.all([
      run(process.execPath, ['--test'], visibleDir, timeoutMs),
      run(process.execPath, ['--test', 'test/acceptance.hidden.test.js'], hiddenWorkspace, timeoutMs),
    ]);
    return { passed: visible.passed && hidden.passed, visible, hidden };
  } finally {
    await rm(gradingDir, { recursive: true, force: true });
  }
}

function normalizeClaimText(text: string): string {
  return text
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_./\\]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lexical heuristic for telemetry, not a substitute for acceptance grading. */
export function matchRootCause(claim: string, groundTruth: GroundTruth = problemA.groundTruth): RootCauseMatch {
  const normalized = normalizeClaimText(claim);
  const matchedGroups = groundTruth.keywordGroups.filter(group => group.some(keyword => normalized.includes(normalizeClaimText(keyword)))).length;
  const totalGroups = groundTruth.keywordGroups.length;
  const score = totalGroups === 0 ? 0 : matchedGroups / totalGroups;
  return { matched: totalGroups > 0 && matchedGroups === totalGroups, score, matchedGroups, totalGroups };
}
