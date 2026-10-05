export async function placeOrder({ db, broker, log = () => {} }, order) {
  await db.transaction(async tx => {
    await tx.insert('orders', { ...order, status: 'confirmed' });
    await tx.insert('order_lines', order.lines);
  });
  const event = { type: 'order.placed', idempotencyKey: order.id, order };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await broker.publish('orders', event, { timeoutMs: 2000 });
      return { ok: true };
    } catch (error) {
      log({ attempt, error: error.message });
    }
  }
  return { ok: true, warning: 'event not published' };
}
