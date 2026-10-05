import { roundMoney, requireAmount } from './money.js';

const DAY = 86_400_000;

/** Pure validation: callers supply the time used by the accounting batch. */
export function validateRefund(invoice, quantity, now) {
  if (invoice.status !== 'paid') throw new Error('Only paid invoices can be refunded');
  if (now - invoice.paidAt > 30 * DAY) throw new Error('Refund window has closed');
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > invoice.quantity - invoice.refundedQuantity) {
    throw new RangeError('Invalid refund quantity');
  }
}

export function refundInvoice(invoice, quantity, now) {
  validateRefund(invoice, quantity, now);
  requireAmount(invoice.paidTotal);
  const cumulativeQuantity = invoice.refundedQuantity + quantity;
  const cumulativeAmount = roundMoney(invoice.paidTotal * cumulativeQuantity / invoice.quantity);
  const amount = roundMoney(cumulativeAmount - invoice.refundedAmount);
  return {
    amount,
    invoice: {
      ...invoice,
      refundedQuantity: cumulativeQuantity,
      refundedAmount: cumulativeAmount,
      status: cumulativeQuantity === invoice.quantity ? 'refunded' : 'paid',
    },
  };
}
