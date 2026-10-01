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
      (sum, line) => sum + Math.round(roundMoney(line.unitPrice) * 100) * line.quantity, 0) / 100);
    const tax = calculateTax(subtotal, region);
    return { currency: this.currency, subtotal, tax, total: roundMoney(subtotal + tax) };
  }
}
