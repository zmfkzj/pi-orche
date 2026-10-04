export function createCache() {
  const values = new Map();
  return {
    set(key, value) { values.set(key, value); },
    get(key) { return values.get(key); },
    delete(key) { return values.delete(key); },
    clear() { values.clear(); },
    snapshot() { return { count: values.size, size: values.size }; },
    async getOrLoad(key, loader) {
      if (values.has(key)) return values.get(key);
      const value = await loader(key);
      values.set(key, value);
      return value;
    },
  };
}
