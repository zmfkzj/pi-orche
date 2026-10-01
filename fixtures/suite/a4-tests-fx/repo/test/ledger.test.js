import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';
import { Catalog } from '../src/catalog.js';
import { checkout } from '../src/checkout.js';
import { FxTable } from '../src/fx.js';
import { refundInvoice } from '../src/refunds.js';

test('cart snapshots and calculates ordinary orders', () => {
  const cart = new Cart().add('book', 10, 2);
  const lines = cart.lines;
  lines[0].quantity = 9;
  assert.deepEqual(cart.totals(), { currency: 'USD', subtotal: 20, tax: 1.4, total: 21.4 });
  cart.remove('book');
  assert.equal(cart.totals().total, 0);
});

test('catalog supports checkout without exposing stored data', () => {
  const catalog = new Catalog([{ sku: 'pen', price: 2 }]);
  catalog.find('pen').price = 50;
  assert.equal(checkout(catalog, [{ sku: 'pen', quantity: 3 }]).total, 6.42);
  assert.throws(() => catalog.find('missing'), /Unknown product/);
});

test('FX converts a USD quote', () => {
  assert.deepEqual(new FxTable({ EUR: 0.8 }).quote(10, 'USD', 'EUR'), { amount: 8, currency: 'EUR' });
});

test('paid orders can be partially refunded without mutating input', () => {
  const invoice = { status: 'paid', paidAt: 0, paidTotal: 20, quantity: 2, refundedQuantity: 0, refundedAmount: 0 };
  const result = refundInvoice(invoice, 1, 1000);
  assert.equal(result.amount, 10);
  assert.equal(result.invoice.status, 'paid');
  assert.equal(invoice.refundedQuantity, 0);
});
