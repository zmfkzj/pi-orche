import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../src/stats.js';

test('odd length', () => assert.equal(median([3, 1, 2]), 2));
test('even length', () => assert.equal(median([4, 1, 3, 2]), 2.5));
test('single', () => assert.equal(median([7]), 7));
test('duplicates', () => assert.equal(median([5, 5, 1]), 5));
