import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache/index.mjs';
test('cache regression: stale load returns immediately and is fenced by set', async () => {
  let t=0,release;
  const pending=new Promise(resolve=>{release=resolve;});
  const cache=createCache({maxSize:2,ttlMs:1,staleMs:5,now:()=>t});
  cache.set('a',1);t=1;
  assert.equal(await cache.getOrLoad('a',()=>pending),1);
  cache.set('a',9);release(2);
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(cache.get('a'),9);
});
