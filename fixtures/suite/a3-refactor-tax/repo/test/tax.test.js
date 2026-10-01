import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOrder } from '../src/estimate.js';
import { invoiceTotals } from '../src/invoice.js';
test('US quotations and invoices agree', () => {
  assert.deepEqual(estimateOrder(100, 'US'), { amount: 100, tax: 7, total: 107 });
  assert.deepEqual(invoiceTotals(100, 'US'), { amount: 100, tax: 7, total: 107 });
});
