export function createLimiter({ limit, now }) {
  const counts = new Map();
  return {
    take(key, cost = 1) {
      now();
      const used = counts.get(key) || 0;
      counts.set(key, used + cost);
      return { allowed: used < limit, remaining: Math.max(0, limit - used - cost), retryAfterMs: 0 };
    },
    reset(key) { counts.delete(key); },
  };
}
