/** Removes items with a duplicate key, keeping the first item for each key and preserving order. */
export function uniqueBy(items, key) {
  return [...new Map(items.map(item => [key(item), item])).values()];
}
