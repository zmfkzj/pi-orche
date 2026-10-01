import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/catalog.js';
import { checkout } from '../src/checkout.js';
test('checkout reports the corrected empty-cart error', () => {
  assert.throws(() => checkout(new Catalog(), []), { name: 'Error', message: 'Cannot checkout an empty cart' });
});
