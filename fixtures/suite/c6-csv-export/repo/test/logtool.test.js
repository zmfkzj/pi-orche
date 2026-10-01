import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseLine, parseLogs } from '../src/parser.js';
import { aggregate } from '../src/aggregate.js';
import { main } from '../src/cli.js';

const event = (level, source = 'api') => JSON.stringify({timestamp:'2026-01-02T10:20:00Z', level, source, message:'request completed'});

test('parser preserves message and ignores separators', () => {
  assert.equal(parseLine(event('WARN')).level, 'WARN');
  assert.equal(parseLogs(event('INFO') + '\n\n' + event('ERROR') + '\n').records.length, 2);
});

test('aggregation keeps per-source counts and does not mutate input', () => {
  const records = parseLogs([event('INFO'), event('ERROR'), event('WARN', 'worker')].join('\n')).records;
  const before = structuredClone(records);
  const result = aggregate(records);
  assert.equal(result.total, 3);
  assert.equal(result.errors, 1);
  assert.deepEqual(result.rows.map(row => [row.source, row.count, row.errors]), [['api',2,1],['worker',1,0]]);
  assert.deepEqual(records, before);
});

test('main reads one file and emits summary', async () => {
  let output = '';
  const code = await main(['input.jsonl'], {readFile: async path => {assert.equal(path, 'input.jsonl'); return event('ERROR');}, stdout: text => output += text, stderr: text => assert.fail(text)});
  assert.equal(code, 0);
  assert.match(output, /Total: 1/);
  assert.match(output, /Errors: 1/);
});

test('argument failures avoid file access', async () => {
  let error = '';
  assert.equal(await main(['--unknown'], {readFile: () => assert.fail('unexpected read'), stderr: text => error += text}), 2);
  assert.match(error, /Unknown option/);
});

test('executable supports help', () => {
  const child = spawnSync(process.execPath, ['src/cli.js', '--help'], {encoding:'utf8',timeout:3000});
  assert.equal(child.status, 0);
  assert.match(child.stdout, /Usage: logtool/);
});
