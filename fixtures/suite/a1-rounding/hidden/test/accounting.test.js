import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';

test('unit prices round before quantities, with decimal half cents', () => {
  for (const [price, quantity, subtotal] of [[1.005, 3, 3.03], [10.075, 2, 20.16], [0.004, 10, 0], [0.005, 10, 0.1], [0.335, 3, 1.02]]) {
    const result = new Cart().add('item', price, quantity).totals('US');
    assert.equal(result.subtotal, subtotal);
    assert.equal(result.tax, Math.round(subtotal * 7) / 100);
    assert.equal(result.total, Math.round((subtotal + result.tax) * 100) / 100);
  }
});

test('many decimal lines add in cents and snapshots remain stable', () => {
  const cart = new Cart();
  for (let i = 0; i < 1000; i++) cart.add(String(i), 0.105, 3);
  assert.deepEqual(cart.totals('GB'), { currency: 'USD', subtotal: 330, tax: 66, total: 396 });
  assert.equal(cart.lines[0].unitPrice, 0.105);
});
