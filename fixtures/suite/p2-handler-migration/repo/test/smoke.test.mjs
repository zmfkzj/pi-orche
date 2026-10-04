import test from 'node:test';
import assert from 'node:assert/strict';
import { respond, dispatch } from '../src/router.mjs';
test('router async ABI', async () => {
  assert.deepEqual(await dispatch(async () => respond(200,{ok:true}),{}),
    {status:200,body:{ok:true},headers:{'content-type':'application/json'}});
});
