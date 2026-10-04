function fail(code) {
  throw Object.assign(new Error(code), { code });
}
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const copy = value => structuredClone(value);

export function createCache({ maxSize, ttlMs, staleMs = 0, now, sizeOf = () => 1 } = {}) {
  if (!nonnegative(maxSize) || maxSize === 0 || !nonnegative(ttlMs) ||
      !nonnegative(staleMs) || typeof now !== 'function' || typeof sizeOf !== 'function') {
    fail('CACHE_CONFIG');
  }
  const entries = new Map();
  const pending = new Map();
  let size = 0;
  let last = -1;
  function keyCheck(key) {
    if (typeof key !== 'string' || !key.length) fail('CACHE_INPUT');
  }
  function time() {
    const t = now();
    if (!nonnegative(t) || t < last) fail('CLOCK_INVALID');
    last = t;
    for (const [key, entry] of entries) {
      if (t >= entry.hard) remove(key);
    }
    return t;
  }
  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    size -= entry.size;
    return entries.delete(key);
  }
  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
  }
  function install(key, value, t) {
    const detached = copy(value);
    const bytes = sizeOf(copy(detached), key);
    if (!nonnegative(bytes) || bytes === 0) fail('CACHE_SIZE');
    remove(key);
    if (bytes > maxSize) return;
    while (size + bytes > maxSize) remove(entries.keys().next().value);
    entries.set(key, {
      value: detached,
      size: bytes,
      fresh: t + ttlMs,
      hard: t + ttlMs + staleMs,
    });
    size += bytes;
  }
  function load(key, loader) {
    if (pending.has(key)) return pending.get(key).promise;
    const token = {};
    const promise = Promise.resolve().then(() => loader(key)).then(value => {
      if (pending.get(key) === token) install(key, value, time());
      return copy(value);
    }).finally(() => {
      if (pending.get(key) === token) pending.delete(key);
    });
    token.promise = promise;
    pending.set(key, token);
    return promise;
  }
  return {
    set(key, value) {
      keyCheck(key);
      const t = time();
      install(key, value, t);
      pending.delete(key);
    },
    get(key) {
      keyCheck(key);
      const t = time();
      const entry = entries.get(key);
      if (!entry || t >= entry.fresh) return undefined;
      touch(key, entry);
      return copy(entry.value);
    },
    delete(key) {
      keyCheck(key);
      time();
      pending.delete(key);
      return remove(key);
    },
    clear() {
      time();
      entries.clear();
      pending.clear();
      size = 0;
    },
    snapshot() {
      time();
      return { count: entries.size, size };
    },
    async getOrLoad(key, loader) {
      keyCheck(key);
      if (typeof loader !== 'function') fail('CACHE_INPUT');
      const t = time();
      const entry = entries.get(key);
      if (entry) {
        touch(key, entry);
        if (t >= entry.fresh) load(key, loader).catch(() => {});
        return copy(entry.value);
      }
      return copy(await load(key, loader));
    },
  };
}
