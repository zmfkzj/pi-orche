export function median(values) {
  if (!values.length) throw new Error('median of empty array');
  const sorted = values.slice().sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
