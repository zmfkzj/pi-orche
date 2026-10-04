function fail(code) {
  throw Object.assign(new Error(code), { code });
}
const positive = value => Number.isSafeInteger(value) && value > 0;

/**
 * Weighted sliding-window admission, not periodic-reset or token-bucket logic.
 * Every accepted event retains its timestamp and whole cost.
 * Events exactly one window old are no longer active.
 * Rejected requests neither consume capacity nor shift expiry boundaries.
 * Retry time is computed by accumulating expirations until THIS cost fits.
 * Events with the same timestamp may expire together; walking them in order
 * still yields the same earliest timestamp for sufficient reclaimed capacity.
 * The clock fence is instance-wide so different keys cannot hide a regression.
 * Reset removes a key's accounting without weakening that clock fence.
 * Burst is simply additional window capacity and is validated before use.
 * This implementation is deterministic under an injected integer clock.
 */
export function createLimiter({ limit, windowMs, burst = 0, now } = {}) {
  if (!positive(limit) || !positive(windowMs) ||
      !Number.isSafeInteger(burst) || burst < 0 ||
      !Number.isSafeInteger(limit + burst) || typeof now !== 'function') {
    fail('LIMIT_CONFIG');
  }
  const capacity = limit + burst;
  const queues = new Map();
  let previous = -1;
  function keyValid(key) {
    if (typeof key !== 'string' || !key.length) fail('LIMIT_INPUT');
  }
  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time < previous) {
      fail('CLOCK_INVALID');
    }
    previous = time;
    return time;
  }
  function active(key, time) {
    const events = (queues.get(key) || []).filter(event => event.at > time - windowMs);
    if (events.length) queues.set(key, events);
    else queues.delete(key);
    return events;
  }
  return {
    take(key, cost = 1) {
      keyValid(key);
      if (!positive(cost) || cost > capacity) fail('LIMIT_INPUT');
      const time = clock();
      const events = active(key, time);
      let used = events.reduce((sum, event) => sum + event.cost, 0);
      if (used + cost <= capacity) {
        events.push({ at: time, cost });
        queues.set(key, events);
        return {
          allowed: true,
          remaining: capacity - used - cost,
          retryAfterMs: 0,
        };
      }
      let retryAfterMs = 0;
      for (const event of events) {
        used -= event.cost;
        if (used + cost <= capacity) {
          retryAfterMs = event.at + windowMs - time;
          break;
        }
      }
      return {
        allowed: false,
        remaining: capacity - events.reduce((sum, event) => sum + event.cost, 0),
        retryAfterMs,
      };
    },
    reset(key) {
      keyValid(key);
      queues.delete(key);
    },
  };
}
