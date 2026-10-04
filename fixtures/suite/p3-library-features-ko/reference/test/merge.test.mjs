import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from '../src/merge/index.mjs';
test('merge 회귀: 분리된 수정과 빈 충돌 쪽', () => {
  assert.deepEqual(merge3('a\nb\n','A\nb\n','a\nB\n'),{text:'A\nB\n',conflicts:0});
  assert.deepEqual(merge3('a\n','','b\n'),{
    text:'<<<<<<< OURS\n||||||| BASE\na\n=======\nb\n>>>>>>> THEIRS\n',conflicts:1,
  });
});
