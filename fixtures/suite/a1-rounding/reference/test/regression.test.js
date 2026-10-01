import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';
test('fractional cents are rounded per unit', () => {
  assert.deepEqual(new Cart().add('item', 1.005, 3).totals(), { currency: 'USD', subtotal: 3.03, tax: 0.21, total: 3.24 });
});
