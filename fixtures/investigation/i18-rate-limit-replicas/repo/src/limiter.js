const buckets = new Map();

/** Token bucket: `limit` tokens per `windowMs`, refilled continuously. */
export function allow(key, { limit = 100, windowMs = 60_000, now = Date.now() } = {}) {
  let bucket = buckets.get(key);
  if (!bucket) { bucket = { tokens: limit, at: now }; buckets.set(key, bucket); }
  const refill = ((now - bucket.at) / windowMs) * limit;
  bucket.tokens = Math.min(limit, bucket.tokens + refill);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
