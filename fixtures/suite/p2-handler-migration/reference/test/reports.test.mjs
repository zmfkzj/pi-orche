import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers/reports.mjs';
test('reports regression: exclusive upper bound and first duplicate', async () => {
  const r=await handle({query:{from:'2024-01-01',to:'2024-01-02'},services:{reports:{list:async()=>[
    {id:'a',at:'2024-01-01T00:00:00Z',status:'paid',amount:2,customerId:'c'},
    {id:'a',at:'2024-01-01T01:00:00Z',status:'paid',amount:9,customerId:'c'},
    {id:'b',at:'2024-01-02T00:00:00Z',status:'paid',amount:9,customerId:'c'},
  ]}}});
  assert.equal(r.status,200);assert.deepEqual(r.body,{items:[{key:'2024-01-01',count:1,total:2}],total:2});
});
