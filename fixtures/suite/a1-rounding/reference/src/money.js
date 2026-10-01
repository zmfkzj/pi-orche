/** Currency amounts at API boundaries are major-unit numbers. */
export function roundMoney(value) {
  if (!Number.isFinite(value)) throw new TypeError('Amount must be finite');
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Math.round(Number(`${mantissa}e${Number(exponent) + 2}`)) / 100;
}

export function requireAmount(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Amount must be non-negative');
  }
  return value;
}

export function formatMoney(value, currency = 'USD') {
  return `${currency} ${roundMoney(value).toFixed(2)}`;
}
