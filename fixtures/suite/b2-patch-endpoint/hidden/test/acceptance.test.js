import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { request, response } from './helpers.js';
test('patch merges, normalizes and preserves identity', async () => {
  const app = createApp({ seed: [{ id: '1', name: 'pen', quantity: 4 }, { id: '2', name: 'book', quantity: 2 }] });
  const first = await request(app, 'PATCH', '/items/1', { quantity: 0 });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { id: '1', name: 'pen', quantity: 0 });
  assert.deepEqual((await request(app, 'PATCH', '/items/1', { name: ' pen ' })).body, first.body);
  assert.deepEqual((await request(app, 'PATCH', '/items/1', { name: ' ink ', quantity: 9 })).body, { id: '1', name: 'ink', quantity: 9 });
  assert.equal((await request(app, 'PATCH', '/items/1', { name: 'book', quantity: 99 })).status, 409);
  assert.deepEqual((await request(app, 'GET', '/items/1')).body, { id: '1', name: 'ink', quantity: 9 });
  assert.equal((await request(app, 'PATCH', '/items/nope', { quantity: 1 })).status, 404);
});
test('invalid patches are rejected before lookup and do not mutate', async () => {
  const app = createApp({ seed: [{ id: '1', name: 'pen', quantity: 4 }] });
  for (const body of [null, [], {}, { name: '' }, { name: '  ' }, { name: 3 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: '2' }, { id: '2' }, { name: 'ink', extra: true }]) {
    for (const id of ['1', 'missing']) assert.equal((await request(app, 'PATCH', '/items/' + id, body)).status, 400);
  }
  assert.equal((await request(app, 'PATCH', '/items/1', undefined, ['{'])).status, 400);
  assert.deepEqual((await request(app, 'GET', '/items/1')).body, { id: '1', name: 'pen', quantity: 4 });
});
