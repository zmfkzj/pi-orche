import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { request, response } from './helpers.js';
test('page partitions cover the collection exactly', async () => {
  for (const size of [0, 1, 5, 6, 11]) for (const limit of [1, 2, 5]) {
    const seed = Array.from({ length: size }, (_, i) => ({ id: String(i + 1), name: 'item-' + i, quantity: i }));
    const app = createApp({ seed });
    const collected = [];
    for (let page = 1; page <= Math.ceil(size / limit) + 1; page++) {
      const result = await request(app, 'GET', '/items?page=' + page + '&limit=' + limit);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { items: seed.slice((page - 1) * limit, page * limit), total: size, page, limit });
      collected.push(...result.body.items);
    }
    assert.deepEqual(collected, seed);
  }
  const app = createApp();
  for (const query of ['page=0', 'page=1.5', 'limit=0', 'limit=101', 'limit=no']) assert.equal((await request(app, 'GET', '/items?' + query)).status, 400);
});
