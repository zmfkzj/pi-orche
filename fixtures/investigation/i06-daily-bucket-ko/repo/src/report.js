// createdAt values are stored in KST by the order service, so the ISO date is
// already the business date.
export function dayKey(order) {
  return new Date(order.createdAt).toISOString().slice(0, 10);
}

export function dailyTotals(orders) {
  const totals = {};
  for (const order of orders) {
    const day = dayKey(order);
    totals[day] = (totals[day] ?? 0) + order.amount;
  }
  return totals;
}
