export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
export function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function partition(items, predicate) {
  const accepted = [], rejected = [];
  for (const item of items) (predicate(item) ? accepted : rejected).push(item);
  return [accepted, rejected];
}
export function indexBy(items, keyOf) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (result.has(key)) throw new Error('Duplicate collection key');
    result.set(key, item);
  }
  return result;
}
export function sortBy(items, selectors) {
  return items.map((value, index) => ({ value, index })).sort((a, b) => {
    for (const selector of selectors) {
      const av = selector(a.value), bv = selector(b.value);
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return a.index - b.index;
  }).map(item => item.value);
}
export function page(items, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Invalid page bounds');
  }
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    next: offset + limit < items.length ? offset + limit : null,
  };
}
export function sumBy(items, selector) {
  let total = 0;
  for (const item of items) {
    const value = selector(item);
    if (!Number.isFinite(value)) throw new TypeError('Finite sum required');
    total += value;
  }
  return total;
}
export function frequencies(items) {
  const result = new Map();
  for (const item of items) result.set(item, (result.get(item) || 0) + 1);
  return result;
}
