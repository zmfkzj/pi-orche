/** Intervals are { start, end } in minutes since midnight, half-open [start, end). */
export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

export function canBook(existing, candidate) {
  return existing.every(booking => !overlaps(booking, candidate));
}
