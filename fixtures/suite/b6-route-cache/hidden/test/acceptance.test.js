import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, stats } from '../src/router.js';
import { response } from './helpers.js';
test('repeated matching compiles once and keeps exact routing semantics', async () => {
  const router = createRouter();
  const seen = [];
  const add = (method, path, tag) => router.add(method, path, async (req, res, params) => seen.push({ tag, params }));
  add('GET', '/items/:id', 'first');
  add('POST', '/items/:id', 'post');
  add('GET', '/a.b', 'literal');
  const dispatch = (method, path) => router.dispatch({ method }, response(), new URL(path, 'http://localhost'));
  await dispatch('GET', '/items/a%20b');
  await dispatch('POST', '/items/c');
  await dispatch('GET', '/a.b');
  const before = stats.compilations;
  assert.ok(before > 0, 'actual route compilations must remain observable');
  for (let i = 0; i < 40; i++) {
    assert.equal(await dispatch('GET', '/items/a%20b'), true);
    assert.equal(await dispatch('POST', '/items/c'), true);
    assert.equal(await dispatch('GET', '/items/c/extra'), false);
    assert.equal(await dispatch('GET', '/axb'), false);
    assert.equal(await dispatch('DELETE', '/items/c'), false);
  }
  assert.equal(stats.compilations, before);
  add('GET', '/later/:id', 'later');
  add('GET', '/items/:id', 'duplicate');
  assert.equal(await dispatch('GET', '/later/z'), true);
  const after = stats.compilations;
  await dispatch('GET', '/later/z');
  await dispatch('GET', '/items/b');
  assert.equal(stats.compilations, after);
  assert.deepEqual(seen[0], { tag: 'first', params: { id: 'a b' } });
  assert.deepEqual(seen[1], { tag: 'post', params: { id: 'c' } });
  assert.equal(seen.at(-1).tag, 'first');
});
