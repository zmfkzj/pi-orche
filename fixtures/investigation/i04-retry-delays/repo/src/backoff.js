/** Exponential backoff: baseMs * 2^attempt, clamped to capMs. attempt starts at 0. */
export function delayFor(attempt, baseMs = 100, capMs = 2000) {
  return Math.min(capMs, baseMs * 2 ** attempt);
}
