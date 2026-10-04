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
    const q = String(query.q || '').trim();
    const limit = Number(query.limit || 20);
    const offset = Number(query.offset || 0);
    const rows = await req.services.search.scan();
    const terms = q.split(/\s+/);
    const matches = rows.filter(row => terms.some(term =>
      row.title.includes(term) || row.text.includes(term)));
    matches.sort((a, b) => a.title.localeCompare(b.title));
    return {
      items: matches.slice(offset, offset + limit),
      total: matches.length,
      offset,
      limit,
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
