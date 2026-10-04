import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers/users.mjs';
test('users regression: async response does not expose service secrets', async () => {
  const r=await handle({body:{email:' A@B.C ',displayName:' Ada '},services:{users:{
    findByEmail:async()=>null,create:async()=>({id:'u',password:'private'}),
  }}});
  assert.deepEqual(r,{status:201,body:{id:'u',email:'a@b.c',displayName:'Ada',roles:['viewer']},
    headers:{'content-type':'application/json',location:'/users/u'}});
});
