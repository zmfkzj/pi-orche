import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlaps } from '../src/booking.js';

test('disjoint', () => assert.equal(overlaps({ start: 540, end: 600 }, { start: 660, end: 720 }), false));
test('nested', () => assert.equal(overlaps({ start: 540, end: 720 }, { start: 600, end: 660 }), true));
test('partial', () => assert.equal(overlaps({ start: 540, end: 630 }, { start: 600, end: 660 }), true));
