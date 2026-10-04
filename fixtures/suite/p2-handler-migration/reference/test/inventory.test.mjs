import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers/inventory.mjs';
test('inventory regression: version failures are sanitized', async () => {
  const r=await handle({body:{adjustments:[{sku:'A',delta:-1,expectedVersion:2}]},services:{inventory:{
    apply:async()=>{throw Object.assign(Error('secret'),{code:'VERSION'});},
  }}});
  assert.deepEqual(r,{status:409,body:{error:{code:'INVENTORY_VERSION'}},headers:{'content-type':'application/json'}});
});
