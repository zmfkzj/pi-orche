import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createPiJudge, gradeTask, loadSuite, prepareTaskWorkspace, type Judge, type SuiteTask } from '../../src/eval/suite.js';
import { fauxRuntime } from '../helpers/faux.js';

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const judge: Judge = async input => input.items.map(item => ({ id: item.id, satisfied: input.answer.includes('correct') || Object.values(input.files).some(value => value?.includes('correct')), reason: 'Criterion checked against supplied evidence' }));
async function taskFixture(grading: Partial<SuiteTask['grading']> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orche-suite-test-')); temporary.push(root);
  const dir = join(root, 'example');
  await mkdir(join(dir, 'repo/test'), { recursive: true });
  await writeFile(join(dir, 'repo/package.json'), '{"type":"module"}\n');
  await writeFile(join(dir, 'repo/value.js'), 'export const value = 1;\n');
  await writeFile(join(dir, 'repo/test/visible.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../value.js'; test('visible', () => assert.equal(value,1));\n");
  await mkdir(join(dir, 'hidden/test'), { recursive: true });
  await writeFile(join(dir, 'hidden/test/hidden.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../value.js'; test('hidden', () => assert.equal(value,2));\n");
  await writeFile(join(dir, 'rubric.json'), JSON.stringify({ items: [{ id: 'fact', criterion: 'States the correct fact' }], referenceAnswer: 'correct', passRule: 'all' }));
  await writeFile(join(dir, 'grade.mjs'), "import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const dir=process.argv[2]; const passed=readFileSync(join(dir,'value.js'),'utf8').includes('= 2'); writeFileSync(join(dir,'custom-scratch'),'grader only'); console.log(JSON.stringify({passed,details:'value checked'})); process.exitCode=passed?0:1;\n");
  const manifest = { id: 'example', title: 'Example', category: 'bugfix', language: 'en', instruction: 'Fix or analyze the value', expectsChanges: false, timeoutSec: 30, grading: { visibleTests: false, hiddenTests: false, rubric: false, mustNotModify: false, custom: false, ...grading } };
  await writeFile(join(dir, 'task.json'), JSON.stringify(manifest));
  return { root, dir, manifest };
}
async function prepared(grading: Partial<SuiteTask['grading']>) {
  const fixture = await taskFixture(grading);
  const task = (await loadSuite(fixture.root))[0]!;
  const workspace = await prepareTaskWorkspace(task); temporary.push(workspace.dir);
  return { ...fixture, task, workspace };
}

describe('suite schema and enabled check prerequisites', () => {
  it.each([
    ['category', 'unknown', '/category'], ['language', 'fr', '/language'], ['timeoutSec', 0, '/timeoutSec'], ['instruction', '', '/instruction'], ['id', '../escape', '/id'],
  ])('rejects invalid %s', async (field, value, message) => {
    const fixture = await taskFixture({ visibleTests: true });
    await writeFile(join(fixture.dir, 'task.json'), JSON.stringify({ ...fixture.manifest, [field]: value }));
    await expect(loadSuite(fixture.root)).rejects.toThrow(message);
  });
  it('rejects malformed JSON and missing enabled-check files', async () => {
    const fixture = await taskFixture({ custom: true });
    await writeFile(join(fixture.dir, 'task.json'), '{broken');
    await expect(loadSuite(fixture.root)).rejects.toThrow('Cannot read JSON');
    await writeFile(join(fixture.dir, 'task.json'), JSON.stringify(fixture.manifest));
    await rm(join(fixture.dir, 'grade.mjs'));
    await expect(loadSuite(fixture.root)).rejects.toThrow('grade.mjs');
  });
  it('rejects empty hidden tests, duplicate rubric ids and traversal paths', async () => {
    const fixture = await taskFixture({ hiddenTests: true, rubric: true });
    await rm(join(fixture.dir, 'hidden/test/hidden.test.js'));
    await expect(loadSuite(fixture.root)).rejects.toThrow('hidden test files');
    await writeFile(join(fixture.dir, 'task.json'), JSON.stringify({ ...fixture.manifest, grading: { ...fixture.manifest.grading, hiddenTests: false, rubricFiles: ['../secret'] } }));
    await expect(loadSuite(fixture.root)).rejects.toThrow('unsafe rubricFiles');
    await writeFile(join(fixture.dir, 'task.json'), JSON.stringify({ ...fixture.manifest, grading: { ...fixture.manifest.grading, hiddenTests: false } }));
    await writeFile(join(fixture.dir, 'rubric.json'), JSON.stringify({ items: [{ id: 'x', criterion: 'one' }, { id: 'x', criterion: 'two' }], referenceAnswer: '', passRule: 'all' }));
    await expect(loadSuite(fixture.root)).rejects.toThrow('duplicate rubric item ids');
  });
});

describe('isolated grading', () => {
  it('passes and fails visible tests without modifying the workspace', async () => {
    const { task, workspace } = await prepared({ visibleTests: true });
    expect((await gradeTask(task, workspace.dir, '', { judge })).passed).toBe(true);
    await writeFile(join(workspace.dir, 'value.js'), 'export const value = 3;\n');
    const before = await readFile(join(workspace.dir, 'value.js'), 'utf8');
    expect((await gradeTask(task, workspace.dir, '', { judge })).checks.visibleTests?.passed).toBe(false);
    expect(await readFile(join(workspace.dir, 'value.js'), 'utf8')).toBe(before);
  });
  it('runs exactly hidden files, not a failing visible suite, and never injects hidden tests into workspace', async () => {
    const { task, workspace } = await prepared({ hiddenTests: true });
    expect((await gradeTask(task, workspace.dir, '', { judge })).checks.hiddenTests?.passed).toBe(false);
    await writeFile(join(workspace.dir, 'value.js'), 'export const value = 2;\n');
    expect((await gradeTask(task, workspace.dir, '', { judge })).checks.hiddenTests?.passed).toBe(true);
    expect(await readdir(join(workspace.dir, 'test'))).toEqual(['visible.test.js']);
  });
  it('requires every enabled check, not just the successful visible suite', async () => {
    const { task, workspace } = await prepared({ visibleTests: true, hiddenTests: true });
    const grade = await gradeTask(task, workspace.dir, '', { judge });
    expect(grade.checks.visibleTests?.passed).toBe(true);
    expect(grade.checks.hiddenTests?.passed).toBe(false);
    expect(grade.passed).toBe(false);
  });
  it('uses custom exit status and confines custom writes to its grading copy', async () => {
    const { task, workspace } = await prepared({ custom: true });
    expect((await gradeTask(task, workspace.dir, '', { judge })).passed).toBe(false);
    await writeFile(join(workspace.dir, 'value.js'), 'export const value = 2;\n');
    expect((await gradeTask(task, workspace.dir, '', { judge })).passed).toBe(true);
    expect(await readdir(workspace.dir)).not.toContain('custom-scratch');
  });
  it('detects tracked/new/ignored changes while excluding only untracked tooling scratch', async () => {
    const { task, workspace } = await prepared({ mustNotModify: true });
    expect((await gradeTask(task, workspace.dir, '', { judge })).passed).toBe(true);
    await mkdir(join(workspace.dir, 'node_modules'), { recursive: true });
    await writeFile(join(workspace.dir, 'node_modules/scratch'), 'scratch');
    expect((await gradeTask(task, workspace.dir, '', { judge })).passed).toBe(true);
    await writeFile(join(workspace.dir, 'extra.txt'), 'new output');
    expect((await gradeTask(task, workspace.dir, '', { judge })).checks.mustNotModify?.detail).toContain('extra.txt');
    await rm(join(workspace.dir, 'extra.txt'));
    await writeFile(join(workspace.dir, 'value.js'), 'changed');
    expect((await gradeTask(task, workspace.dir, '', { judge })).checks.mustNotModify?.detail).toContain('value.js');
  });
  it('does not let a task gitignore conceal new output', async () => {
    const fixture = await taskFixture({ mustNotModify: true });
    await writeFile(join(fixture.dir, 'repo/.gitignore'), 'concealed/\n');
    const task = (await loadSuite(fixture.root))[0]!;
    const workspace = await prepareTaskWorkspace(task); temporary.push(workspace.dir);
    await mkdir(join(workspace.dir, 'concealed'));
    await writeFile(join(workspace.dir, 'concealed/new.txt'), 'new');
    expect((await gradeTask(task, workspace.dir, '', { judge })).checks.mustNotModify?.passed).toBe(false);
  });
  it('grades answer and rubric file contents; missing output and incomplete verdicts fail', async () => {
    const { task, workspace } = await prepared({ rubric: true });
    expect((await gradeTask(task, workspace.dir, 'correct', { judge })).passed).toBe(true);
    expect((await gradeTask(task, workspace.dir, 'wrong', { judge })).passed).toBe(false);
    task.grading.rubricFiles = ['REPORT.md'];
    const missing = await gradeTask(task, workspace.dir, 'correct', { judge });
    expect(missing.checks.rubric?.detail).toContain('Missing rubric files: REPORT.md');
    await writeFile(join(workspace.dir, 'REPORT.md'), 'correct');
    expect((await gradeTask(task, workspace.dir, 'wrong', { judge })).passed).toBe(true);
    expect((await gradeTask(task, workspace.dir, 'correct', { judge: async () => [] })).passed).toBe(false);
  });
  it('rejects rubric file symlinks escaping the workspace without reading their contents', async () => {
    const { task, workspace, dir } = await prepared({ rubric: true });
    task.grading.rubricFiles = ['REPORT.md'];
    const outside = join(dir, 'outside-report');
    await writeFile(outside, 'correct');
    await symlink(outside, join(workspace.dir, 'REPORT.md'));
    const grade = await gradeTask(task, workspace.dir, 'correct', { judge });
    expect(grade.checks.rubric?.passed).toBe(false);
    expect(grade.checks.rubric?.detail).toContain('Missing rubric files: REPORT.md');
  });
  it('bounds a hung real test process and a nonsettling injected judge', async () => {
    const { task, workspace } = await prepared({ visibleTests: true, rubric: true });
    await writeFile(join(workspace.dir, 'test/hung.test.js'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);');
    // Real child-process termination cannot be exercised using fake platform timers.
    const grade = await gradeTask(task, workspace.dir, 'correct', { judge: async () => Promise.withResolvers<never>().promise, timeoutMs: 200 });
    expect(grade.checks.visibleTests?.detail).toContain('Timed out');
    expect(grade.checks.rubric?.detail).toContain('Timed out');
  });
});

describe('Pi blind judge', () => {
  it('uses a single structured tool without file tools, repairs once and disposes the real session', async () => {
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const contexts: string[] = [];
    const f = await fauxRuntime([
      context => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage([fauxToolCall('submit_verdict', { items: [{ id: 'other', satisfied: true, reason: 'wrong id' }] })], { stopReason: 'toolUse' }); },
      context => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage([fauxToolCall('submit_verdict', { items: [{ id: 'fact', satisfied: true, reason: 'Evidence states the required fact' }] })], { stopReason: 'toolUse' }); },
    ]);
    const result = await createPiJudge({ model: f.route.model, thinking: 'off', modelRuntime: f.runtime })({ taskId: 'blind', instruction: 'State the fact', items: [{ id: 'fact', criterion: 'State the fact' }], answer: 'The fact', files: {} });
    expect(result).toEqual([{ id: 'fact', satisfied: true, reason: 'Evidence states the required fact' }]);
    expect(f.faux.state.callCount).toBe(2);
    expect(contexts[0]).toContain('submit_verdict');
    expect(contexts[0]).not.toContain('"name":"read"');
    expect(contexts[0]).not.toContain('"name":"bash"');
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('rejects two missing verdicts without a third request and still disposes', async () => {
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const f = await fauxRuntime([fauxAssistantMessage('No verdict'), fauxAssistantMessage('Still no verdict')]);
    await expect(createPiJudge({ model: f.route.model, thinking: 'off', modelRuntime: f.runtime })({
      taskId: 'blind', instruction: 'State the fact', items: [{ id: 'fact', criterion: 'State the fact' }], answer: 'The fact', files: {},
    })).rejects.toThrow('invalid output after one repair prompt');
    expect(f.faux.state.callCount).toBe(2);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
