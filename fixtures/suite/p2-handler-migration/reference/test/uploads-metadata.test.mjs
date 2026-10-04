import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers/uploads-metadata.mjs';
test('uploads-metadata regression: paths are rejected before service I/O', async () => {
  const r=await handle({body:{name:'../secret',size:1,mime:'image/png',sha256:'a'.repeat(64)},services:{}});
  assert.deepEqual(r,{status:400,body:{error:{code:'UPLOAD_INPUT'}},headers:{'content-type':'application/json'}});
});
