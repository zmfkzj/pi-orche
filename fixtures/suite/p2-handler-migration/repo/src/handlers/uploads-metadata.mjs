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
    if (!body.name || !body.sha256) {
      throw Object.assign(new Error('Missing upload identity'), { code: 'INPUT' });
    }
    const name = body.name.split('/').at(-1);
    const tags = [...new Set(body.tags || [])];
    const metadata = {
      ...body,
      name,
      tags,
      size: Number(body.size),
      mime: String(body.mime).toLowerCase(),
    };
    const saved = await req.services.uploads.save(metadata);
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
