import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv/index.mjs';
import { satisfies } from '../src/semver/index.mjs';
test('toolkit basic exports', () => {
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
});
