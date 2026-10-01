import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';
test('fixed discounts follow percentage discounts', () => {
  const discounts = { SAVE: { type: 'percentage', value: 10 }, LESS: { type: 'fixed', value: 5 } };
  assert.deepEqual(new Cart().add('item', 100).totals('US', { codes: ['LESS', 'SAVE'], discounts }), { currency: 'USD', subtotal: 100, tax: 5.95, total: 90.95, discount: 15 });
});
