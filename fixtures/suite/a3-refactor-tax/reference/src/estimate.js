import { roundMoney } from './money.js';
import { calculateTax } from './tax.js';

export function estimateOrder(amount, region, exempt = false) {
  const tax = calculateTax(amount, region, exempt);
  return { amount, tax, total: roundMoney(amount + tax) };
}
