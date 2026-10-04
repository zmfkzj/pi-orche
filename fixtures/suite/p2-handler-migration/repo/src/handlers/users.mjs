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
    if (!body.email || !body.displayName) {
      throw Object.assign(new Error('Email and name required'), { code: 'INPUT' });
    }
    const email = String(body.email).trim();
    const existing = await req.services.users.findByEmail(email);
    if (existing) {
      throw Object.assign(new Error('User already exists: ' + email), { code: 'DUPLICATE' });
    }
    const roles = body.roles || ['viewer'];
    const value = {
      email,
      displayName: body.displayName,
      roles,
      ...body,
    };
    const saved = await req.services.users.create(value);
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
