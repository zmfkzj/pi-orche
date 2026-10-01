import { roundMoney, requireAmount } from './money.js';
import { calculateTax } from './tax.js';

/** A cart is a snapshot of prices, not a live view of the catalog. */
export class Cart {
  #lines = [];
  constructor(currency = 'USD') {
    this.currency = currency;
  }

  add(sku, unitPrice, quantity = 1) {
    requireAmount(unitPrice);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError('Quantity must be a positive integer');
    }
    this.#lines.push({ sku, unitPrice, quantity });
    return this;
  }

  remove(sku) {
    this.#lines = this.#lines.filter(line => line.sku !== sku);
  }

  get lines() {
    return this.#lines.map(line => ({ ...line }));
  }

  totals(region = 'US', options = {}) {
    const subtotal = roundMoney(this.#lines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity, 0));
    const { codes = [], discounts = {} } = options;
    const eligible = [...new Set(codes)].filter(code =>
      Object.hasOwn(discounts, code) && subtotal >= (discounts[code].minimumSubtotal ?? 0));
    let balance = subtotal;
    for (const type of ['percentage', 'fixed']) {
      for (const code of eligible) {
        const offer = discounts[code];
        if (offer.type !== type) continue;
        balance = type === 'percentage'
          ? roundMoney(balance * (1 - offer.value / 100))
          : roundMoney(Math.max(0, balance - offer.value));
      }
    }
    const tax = calculateTax(balance, region);
    const result = { currency: this.currency, subtotal, tax, total: roundMoney(balance + tax) };
    if (codes.length) result.discount = roundMoney(subtotal - balance);
    return result;
  }
}
