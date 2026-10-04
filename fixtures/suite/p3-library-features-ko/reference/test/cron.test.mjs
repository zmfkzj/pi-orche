import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRun } from '../src/cron/index.mjs';
test('cron 회귀: UTC 윤년과 DOM/DOW OR', () => {
  const now=()=>Date.parse('2024-02-12T00:00:00Z');
  assert.equal(nextRun('0 0 13 * 1',{now}).toISOString(),'2024-02-13T00:00:00.000Z');
  assert.equal(nextRun('0 0 29 2 *',{now}).toISOString(),'2024-02-29T00:00:00.000Z');
});
