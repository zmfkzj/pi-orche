import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOrder } from '../src/estimate.js';
import { invoiceTotals } from '../src/invoice.js';
test('GB tax and exempt validation match the canonical contract', () => {
  assert.equal(estimateOrder(100, 'GB').tax, 20);
  assert.throws(() => invoiceTotals(100, 'unknown', true), /Unsupported tax region/);
});
