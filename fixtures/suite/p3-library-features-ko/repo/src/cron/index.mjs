export function nextRun(expression, { now }) {
  return new Date(now() + 60000);
}
