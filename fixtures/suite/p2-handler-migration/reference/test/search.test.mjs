import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers/search.mjs';
test('search regression: unique AND terms and ASCII score tie order', async () => {
  const r=await handle({query:{q:' red RED blue '},services:{search:{scan:async()=>[
    {id:'b',title:'Red blue',text:''},{id:'A',title:'red blue',text:''},{id:'c',title:'red',text:''},
  ]}}});
  assert.equal(r.status,200);assert.equal(r.body.total,2);
  assert.deepEqual(r.body.items.map(x=>x.id),['A','b']);assert.equal(r.body.items[0].score,4);
});
