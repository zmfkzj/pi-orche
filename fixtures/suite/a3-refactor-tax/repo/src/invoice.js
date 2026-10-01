import { roundMoney } from './money.js';

export function invoiceTotals(amount, region, exempt = false) {
  const rates = { US: 0.07, GB: 0.2, CA: 0.13 };
  if (exempt) return { amount, tax: 0, total: amount };
  if (!(region in rates)) throw new Error(`Unsupported tax region: ${region}`);
  const tax = roundMoney(amount * rates[region]);
  return { amount, tax, total: roundMoney(amount + tax) };
}
