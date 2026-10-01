import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { request, response } from './helpers.js';
test('all public handlers consume a single context', async () => {
  const app = createApp({ seed: [{ id: '1', name: 'pen', quantity: 4 }] });
  const invoke = async (method, path, params = {}, body) => {
    const route = app.routes.find(route => route.method === method && route.path === path);
    assert.ok(route, method + ' ' + path);
    const req = { method, url: path === '/items/:id' ? '/items/1' : path, body };
    const res = response();
    await route.handler({ req, res, params, url: new URL(req.url, 'http://localhost'), state: app.store });
    return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : undefined };
  };
  assert.deepEqual((await invoke('GET', '/health')).body, { status: 'ok' });
  assert.deepEqual((await invoke('GET', '/items')).body.items, [{ id: '1', name: 'pen', quantity: 4 }]);
  assert.deepEqual((await invoke('GET', '/items/:id', { id: '1' })).body, { id: '1', name: 'pen', quantity: 4 });
  assert.equal((await invoke('POST', '/items', {}, { name: 'book', quantity: 2 })).status, 201);
  assert.equal((await invoke('DELETE', '/items/:id', { id: '1' })).status, 204);
  assert.equal((await request(app, 'GET', '/items/1')).status, 404);
  assert.equal((await request(app, 'GET', '/items/2')).body.name, 'book');
});
test('dispatch supplies URL and app state to extension handlers', async () => {
  const app = createApp();
  app.routes.push({ method: 'GET', path: '/probe/:value', handler: async ctx => {
    assert.equal(ctx.req.method, 'GET');
    assert.equal(ctx.state, app.store);
    ctx.res.end(JSON.stringify({ value: ctx.params.value, query: ctx.url.searchParams.get('q') }));
  } });
  assert.deepEqual(JSON.parse((await request(app, 'GET', '/probe/a%20b?q=z')).text), { value: 'a b', query: 'z' });
});
