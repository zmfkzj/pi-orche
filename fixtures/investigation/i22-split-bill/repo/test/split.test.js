import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../src/split.js';

test('even split', () => assert.deepEqual(splitCents(300, 3), [100, 100, 100]));
test('one person', () => assert.deepEqual(splitCents(999, 1), [999]));
test('zero', () => assert.deepEqual(splitCents(0, 4), [0, 0, 0, 0]));
