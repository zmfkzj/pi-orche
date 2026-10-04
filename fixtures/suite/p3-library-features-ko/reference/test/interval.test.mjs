import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize,subtract,intersect } from '../src/interval/index.mjs';
test('interval 회귀: 반열린 경계와 구간 분할', () => {
  assert.deepEqual(normalize([[2,4],[0,2]]),[[0,4]]);
  assert.deepEqual(subtract([[0,8]],[[2,5]]),[[0,2],[5,8]]);
  assert.deepEqual(intersect([[0,2]],[[2,4]]),[]);
});
