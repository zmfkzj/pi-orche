import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/ratelimit/index.mjs';
test('ratelimit regression: weighted rejection and expiry', () => {
  let t=0; const limiter=createLimiter({limit:2,burst:1,windowMs:10,now:()=>t});
  assert.equal(limiter.take('a',3).allowed,true);
  assert.deepEqual(limiter.take('a'),{allowed:false,remaining:0,retryAfterMs:10});
  t=10; assert.equal(limiter.take('a',3).allowed,true);
});
