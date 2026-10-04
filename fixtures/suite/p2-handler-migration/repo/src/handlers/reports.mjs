/**
 * Legacy v1 callback handler.
 * Success passes raw domain values to cb(null, value).
 * Errors pass repository exceptions through to cb(error).
 * The return value is intentionally undefined; v1 callers must use cb.
 * Input coercion and response projection are still legacy behavior.
 */
export function handle(req, cb) {
  const work = async () => {
    const query = req.query || {};
    const rows = await req.services.reports.list({ from: query.from, to: query.to });
    const groups = new Map();
    let total = 0;
    for (const row of rows) {
      if (row.status !== 'paid') continue;
      const key = query.groupBy === 'customer' ? row.customerId : row.at.slice(0, 10);
      const group = groups.get(key) || { key, count: 0, total: 0 };
      group.count++;
      group.total += Number(row.amount);
      total += Number(row.amount);
      groups.set(key, group);
    }
    return {
      items: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
      total,
    };
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
