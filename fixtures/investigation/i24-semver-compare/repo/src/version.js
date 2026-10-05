/** Returns a negative number, 0 or a positive number. */
export function compareVersions(a, b) {
  const left = a.split('.').map(part => parseInt(part, 10));
  const right = b.split('.').map(part => parseInt(part, 10));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
