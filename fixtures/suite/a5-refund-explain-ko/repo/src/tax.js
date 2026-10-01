import { roundMoney, requireAmount } from './money.js';

const rates = Object.freeze({ US: 0.07, GB: 0.2, CA: 0.13 });

export function calculateTax(amount, region, exempt = false) {
  requireAmount(amount);
  if (!(region in rates)) throw new Error(`Unsupported tax region: ${region}`);
  return exempt ? 0 : roundMoney(amount * rates[region]);
}
