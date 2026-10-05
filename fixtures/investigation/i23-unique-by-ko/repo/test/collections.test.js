import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueBy } from '../src/collections.js';

test('removes duplicates', () => assert.equal(uniqueBy([{ id: 1 }, { id: 2 }, { id: 1 }], item => item.id).length, 2));
test('keeps order of first appearance', () => assert.deepEqual(uniqueBy([{ id: 2 }, { id: 1 }, { id: 2 }], item => item.id).map(item => item.id), [2, 1]));
test('no duplicates', () => assert.deepEqual(uniqueBy([{ id: 1 }, { id: 2 }], item => item.id), [{ id: 1 }, { id: 2 }]));
