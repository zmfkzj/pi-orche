import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { request, response } from './helpers.js';
import { resolve } from 'node:path';
test('health, collection reads and static content', async () => {
  const app = createApp({ seed: [{ id: '1', name: 'pen', quantity: 4 }], publicDir: resolve('public') });
  assert.deepEqual((await request(app, 'GET', '/health')).body, { status: 'ok' });
  assert.deepEqual((await request(app, 'GET', '/items')).body.items, [{ id: '1', name: 'pen', quantity: 4 }]);
  assert.equal((await request(app, 'GET', '/static/help/guide.txt')).text, 'Inventory guide\n');
  assert.equal((await request(app, 'GET', '/missing')).status, 404);
});
