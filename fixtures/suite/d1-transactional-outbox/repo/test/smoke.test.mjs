import test from 'node:test'; import assert from 'node:assert/strict'; import {Database,placeOrder} from '../src/index.mjs';
test('a basic order has a total',async()=>{const db=new Database();assert.equal((await placeOrder(db,{tenant:'a',idempotencyKey:'x',items:[{quantity:2,price:30}]})).total,60);});
