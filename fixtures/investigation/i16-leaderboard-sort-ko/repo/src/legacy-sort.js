/** In-place quicksort (Lomuto partition) by compare(a, b). */
export function quickSortBy(items, compare) {
  const sort = (lo, hi) => {
    if (lo >= hi) return;
    const pivot = items[hi];
    let i = lo;
    for (let j = lo; j < hi; j++) {
      if (compare(items[j], pivot) < 0) {
        [items[i], items[j]] = [items[j], items[i]];
        i++;
      }
    }
    [items[i], items[hi]] = [items[hi], items[i]];
    sort(lo, i - 1);
    sort(i + 1, hi);
  };
  sort(0, items.length - 1);
  return items;
}
