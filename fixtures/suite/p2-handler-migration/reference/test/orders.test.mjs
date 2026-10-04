import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers/orders.mjs';
test('orders regression: merge duplicate lines before applying discount', async () => {
  let calls=0;
  const r=await handle({body:{customerId:'c',items:[{sku:'A',quantity:1},{sku:'A',quantity:2}],coupon:'SAVE10'},services:{
    catalog:{get:async()=>{calls++;return {price:101};}},orders:{create:async()=>({id:'o'})},
  }});
  assert.equal(calls,1);assert.equal(r.status,201);
  assert.equal(r.body.lines[0].quantity,3);assert.equal(r.body.discount,30);
});
