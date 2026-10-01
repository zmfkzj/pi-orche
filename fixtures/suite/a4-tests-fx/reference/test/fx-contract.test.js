import test from 'node:test';
import assert from 'node:assert/strict';
import { FxTable } from '../src/fx.js';

test('cross-currency conversion, zero, identity and final rounding', () => {
  const rates = { EUR: 0.8, JPY: 120 };
  const fx = new FxTable(rates);
  rates.EUR = 0.2;
  assert.equal(fx.convert(8, 'EUR', 'JPY'), 1200);
  assert.equal(fx.convert(1, 'JPY', 'EUR'), 0.01);
  assert.equal(fx.convert(1.236, 'EUR', 'EUR'), 1.24);
  assert.equal(fx.convert(0, 'EUR', 'JPY'), 0);
  assert.deepEqual(fx.quote(8, 'EUR', 'JPY'), { amount: 1200, currency: 'JPY' });
});

test('invalid rates and conversion inputs are rejected', () => {
  for (const rate of [0, -1, NaN, Infinity]) assert.throws(() => new FxTable({ EUR: rate }));
  const fx = new FxTable({ EUR: 0.8 });
  for (const value of [-1, NaN, Infinity]) assert.throws(() => fx.convert(value, 'USD', 'EUR'));
  assert.throws(() => fx.convert(1, 'unknown', 'USD'));
  assert.throws(() => fx.convert(1, 'USD', 'unknown'));
});
