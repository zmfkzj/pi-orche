/** Currency amounts at API boundaries are major-unit numbers. */
export function roundMoney(value) {
  if (!Number.isFinite(value)) throw new TypeError('Amount must be finite');
  return Math.round(value * 100) / 100;
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
