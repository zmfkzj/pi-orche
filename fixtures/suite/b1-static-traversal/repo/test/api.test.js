import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { request } from './helpers.js';

test('health, inventory lifecycle and missing routes', async () => {
  const app = createApp();
  assert.deepEqual((await request(app, 'GET', '/health')).body, { status: 'ok' });
  const created = await request(app, 'POST', '/items', { name: ' pencil ', quantity: 3 });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: '1', name: 'pencil', quantity: 3 });
  assert.deepEqual((await request(app, 'GET', '/items/1')).body, created.body);
  assert.equal((await request(app, 'POST', '/items', { name: 'pencil', quantity: 1 })).status, 409);
  assert.equal((await request(app, 'POST', '/items', { name: '', quantity: 1 })).status, 400);
  assert.equal((await request(app, 'GET', '/items?page=0')).status, 400);
  assert.equal((await request(app, 'DELETE', '/items/1')).status, 204);
  assert.equal((await request(app, 'GET', '/items/1')).status, 404);
  assert.equal((await request(app, 'GET', '/missing')).status, 404);
});

test('lists and static assets', async () => {
  const app = createApp({ seed: [{ id: '1', name: 'pen', quantity: 4 }], publicDir: resolve('public') });
  const list = await request(app, 'GET', '/items');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.page, 1);
  assert.equal((await request(app, 'GET', '/static/help/guide.txt')).text, 'Inventory guide\n');
});
