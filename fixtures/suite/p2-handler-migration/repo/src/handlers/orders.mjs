/**
 * Legacy v1 callback handler.
 * Success passes raw domain values to cb(null, value).
 * Errors pass repository exceptions through to cb(error).
 * The return value is intentionally undefined; v1 callers must use cb.
 * Input coercion and response projection are still legacy behavior.
 */
export function handle(req, cb) {
  const work = async () => {
    const body = req.body || {};
    if (!Array.isArray(body.items) || !body.items.length) {
      throw Object.assign(new Error('Order needs items'), { code: 'INPUT' });
    }
    const lines = [];
    let subtotal = 0;
    for (const item of body.items) {
      const product = await req.services.catalog.get(item.sku);
      if (!product) {
        throw Object.assign(new Error('Missing product: ' + item.sku), { code: 'NOT_FOUND' });
      }
      const quantity = Number(item.quantity);
      const total = product.price * quantity;
      lines.push({ sku: item.sku, quantity, unitPrice: product.price, total });
      subtotal += total;
    }
    const discount = body.coupon === 'SAVE10' ? Math.round(subtotal * 0.1) : 0;
    const saved = await req.services.orders.create({
      customerId: body.customerId,
      lines,
      subtotal,
      discount,
      total: subtotal - discount,
    });
    return saved;
  };
  let finished = false;
  function finish(error, value) {
    if (finished) return;
    finished = true;
    // A missing callback is tolerated by old diagnostic tooling.
    if (typeof cb === 'function') cb(error, value);
  }
  work().then(
    value => finish(null, value),
    error => finish(error),
  );
}
export const apiVersion = 1;
