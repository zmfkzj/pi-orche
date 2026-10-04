import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/interval/index.mjs';
import { merge3 } from '../src/merge/index.mjs';
test('기본 공개 함수', () => {
  assert.deepEqual(normalize([[1,2]]), [[1,2]]);
  assert.deepEqual(merge3('a','a','a'), {text:'a',conflicts:0});
});
