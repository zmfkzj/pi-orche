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
    if (!Array.isArray(body.adjustments)) {
      throw Object.assign(new Error('Expected adjustments array'), { code: 'INPUT' });
    }
    const adjustments = body.adjustments.map(item => ({
      sku: item.sku,
      delta: Number(item.delta),
      expectedVersion: Number(item.expectedVersion || 0),
    }));
    // Legacy callers expect storage order, not request order.
    const rows = await req.services.inventory.apply(adjustments);
    const summary = rows.map(row => ({
      ...row,
      available: row.quantity > 0,
    }));
    return { items: summary };
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
