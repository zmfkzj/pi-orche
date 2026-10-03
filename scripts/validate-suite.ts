#!/usr/bin/env -S npx tsx
/** Mechanical fixture proof. Uses the production workspace/grader, never solver credentials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gradeTask, loadSuite, prepareTaskWorkspace, type SuiteTask } from '../src/eval/suite.js';

async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Fixture/workspace symlink is not permitted: ${path}`);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(relative(root, path));
  }
  return result.sort();
}

async function assertIsolated(task: SuiteTask, workspace: string): Promise<void> {
  const repo = join(task.dir, 'repo');
  const expected = await files(repo);
  const actual = await files(workspace);
  assert.deepEqual(actual, expected, 'Solver workspace must contain exactly repo/ files (plus .git)');
  for (const name of actual) {
    assert(!name.split('/').some(part => ['hidden', 'reference'].includes(part)), `Protected path leaked: ${name}`);
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    assert.equal(digest(await readFile(join(workspace, name))), digest(await readFile(join(repo, name))), `Workspace content differs: ${name}`);
  }
  console.log(`Isolation PASS: ${actual.length} repo files, byte-identical; no hidden/reference paths or extra files`);
}

function printGrade(label: string, grade: Awaited<ReturnType<typeof gradeTask>>): void {
  console.log(`--- ${label} ---`);
  for (const [name, check] of Object.entries(grade.checks)) {
    console.log(`${name}: ${check.passed ? 'PASS' : 'FAIL'}\n${check.detail}`);
  }
}

async function validate(task: SuiteTask): Promise<void> {
  assert(task.expectsChanges && task.grading.hiddenTests && task.grading.visibleTests && !task.grading.rubric,
    `${task.id}: validation requires change task, visible+hidden tests, and no rubric`);
  const workspace = await prepareTaskWorkspace(task);
  try {
    await assertIsolated(task, workspace.dir);
    const options = { judge: async () => { throw new Error('Fixture validation must not invoke a judge'); }, timeoutMs: 30_000 };
    const baseline = await gradeTask(task, workspace.dir, '', options);
    printGrade('untouched repo (hidden/custom failure REQUIRED)', baseline);
    assert.equal(baseline.checks.hiddenTests?.passed, false, 'Hidden tests must fail on untouched repo');
    if (task.grading.custom) assert.equal(baseline.checks.custom?.passed, false, 'Custom grader must fail on untouched repo');
    await cp(join(task.dir, 'reference'), workspace.dir, { recursive: true });
    const reference = await gradeTask(task, workspace.dir, '', options);
    printGrade('reference overlay (all checks must PASS)', reference);
    assert.equal(reference.checks.hiddenTests?.passed, true, 'Reference hidden tests must pass');
    assert.equal(reference.checks.visibleTests?.passed, true, 'Reference visible tests must pass');
    if (task.grading.custom) assert.equal(reference.checks.custom?.passed, true, 'Reference custom grader must pass');
    assert.equal(reference.passed, true, 'All enabled reference checks must pass');
  } finally {
    await workspace.cleanup();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let requested: Set<string> | undefined;
  if (args.length) {
    assert(args.length === 2 && args[0] === '--tasks', 'Usage: npx tsx scripts/validate-suite.ts [--tasks id,id,...]');
    requested = new Set(args[1]!.split(',').filter(Boolean));
  }
  const suite = await loadSuite();
  console.log(`loadSuite PASS: ${suite.length} schema-valid tasks`);
  const selected = suite.filter(task => requested ? requested.has(task.id) : /^d\d+-/.test(task.id));
  assert(selected.length, 'No tasks selected');
  if (requested) assert.equal(selected.length, requested.size, 'Unknown task ID selected');
  let failures = 0;
  for (const task of selected) {
    console.log(`\n========== ${task.id} (${task.category}, ${task.language}) ==========`);
    try {
      await validate(task);
      console.log(`VALIDATED ${task.id}: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS`);
    } catch (error) {
      failures++;
      console.error(`VIOLATION ${task.id}: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }
  console.log(`\nFixture validation: ${selected.length - failures}/${selected.length} passed; ${failures} violations`);
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
