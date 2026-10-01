import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOrder } from '../src/estimate.js';
import { invoiceTotals } from '../src/invoice.js';
import { calculateTax } from '../src/tax.js';
import { Cart } from '../src/cart.js';
test('canonical tax behavior on all accounting paths', () => {
  for (const region of ['US', 'GB', 'CA']) {
    for (const amount of [0, 0.1, 12.34, 100]) {
      for (const fn of [estimateOrder, invoiceTotals]) {
        const tax = calculateTax(amount, region);
        assert.deepEqual(fn(amount, region), { amount, tax, total: Math.round((amount + tax) * 100) / 100 });
        assert.deepEqual(fn(amount, region, true), { amount, tax: 0, total: amount });
      }
      assert.equal(new Cart().add('item', amount).totals(region).tax, calculateTax(amount, region));
    }
  }
});
test('validation applies before exemptions', () => {
  for (const fn of [estimateOrder, invoiceTotals]) {
    for (const exempt of [false, true]) {
      assert.throws(() => fn(10, 'ZZ', exempt), /Unsupported tax region: ZZ/);
      for (const amount of [-1, NaN, Infinity]) assert.throws(() => fn(amount, 'US', exempt));
    }
  }
});
