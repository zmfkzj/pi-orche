import { roundMoney, requireAmount } from './money.js';

/** Rates express units of the named currency per one USD. */
export class FxTable {
  #rates;
  constructor(rates) {
    this.#rates = { USD: 1, ...rates };
    for (const rate of Object.values(this.#rates)) {
      if (!Number.isFinite(rate) || rate < 0) throw new RangeError('Rate must be positive');
    }
  }

  convert(amount, from, to) {
    requireAmount(amount);
    if (!(from in this.#rates) || !(to in this.#rates)) {
      throw new Error('Unknown currency');
    }
    return roundMoney(amount / this.#rates[from] * this.#rates[to]);
  }

  quote(amount, from, to) {
    return { amount: this.convert(amount, from, to), currency: to };
  }
}
