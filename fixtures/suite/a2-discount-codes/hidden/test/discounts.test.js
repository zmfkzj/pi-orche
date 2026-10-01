import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';
const cart = () => new Cart().add('item', 100);
const discounts = { TEN: { type: 'percentage', value: 10 }, HALF: { type: 'percentage', value: 50, minimumSubtotal: 100 }, FIVE: { type: 'fixed', value: 5 }, BIG: { type: 'fixed', value: 200 }, WAIT: { type: 'fixed', value: 40, minimumSubtotal: 101 } };

test('stacking, deduplication and original-subtotal eligibility', () => {
  const options = { codes: ['FIVE', 'TEN', 'HALF', 'TEN', 'WAIT', 'unknown', 'half'], discounts };
  const before = structuredClone(options);
  assert.deepEqual(cart().totals('US', options), { currency: 'USD', subtotal: 100, discount: 60, tax: 2.8, total: 42.8 });
  assert.deepEqual(options, before);
});

test('unknown codes, no codes and saturation', () => {
  assert.deepEqual(cart().totals('GB', { codes: ['missing'], discounts }), { currency: 'USD', subtotal: 100, discount: 0, tax: 20, total: 120 });
  assert.deepEqual(cart().totals('GB', { codes: [], discounts }), { currency: 'USD', subtotal: 100, tax: 20, total: 120 });
  assert.deepEqual(cart().totals('CA', { codes: ['BIG', 'TEN'], discounts }), { currency: 'USD', subtotal: 100, discount: 100, tax: 0, total: 0 });
});

test('percentage rounding follows the caller order', () => {
  const offers = { A: { type: 'percentage', value: 50 }, B: { type: 'percentage', value: 20 } };
  const small = new Cart().add('small', 0.03);
  assert.equal(small.totals('US', { codes: ['A', 'B'], discounts: offers }).discount, 0.01);
  assert.equal(small.totals('US', { codes: ['B', 'A'], discounts: offers }).discount, 0.02);
});
