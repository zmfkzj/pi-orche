import { roundMoney } from './money.js';

export function estimateOrder(amount, region, exempt = false) {
  const rates = { US: 0.07, GB: 0.19, CA: 0.13 };
  if (!(region in rates)) throw new Error(`Unsupported tax region: ${region}`);
  const tax = exempt ? 0 : roundMoney(amount * rates[region]);
  return { amount, tax, total: roundMoney(amount + tax) };
}
