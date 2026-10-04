function fail(code) {
  throw Object.assign(new Error(code), { code });
}
const bounds = [[0,59],[0,23],[1,31],[1,12],[0,7]];
function number(text) {
  if (!/^\d+$/.test(text)) {
    fail('CRON_EXPRESSION');
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    fail('CRON_EXPRESSION');
  }
  return n;
}
function field(text, min, max, weekday) {
  const values = new Set();
  for (const item of text.split(',')) {
    const parts = item.split('/');
    if (parts.length > 2 || !parts[0]) fail('CRON_EXPRESSION');
    const step = parts.length === 2 ? number(parts[1]) : 1;
    if (step < 1) fail('CRON_EXPRESSION');
    const base = parts[0];
    let low, high;
    if (base === '*') {
      low = min;
      high = max;
    } else if (base.includes('-')) {
      const pair = base.split('-');
      if (pair.length !== 2) fail('CRON_EXPRESSION');
      low = number(pair[0]);
      high = number(pair[1]);
    } else {
      low = number(base);
      high = parts.length === 2 ? max : low;
    }
    if (low < min || high > max || low > high) fail('CRON_EXPRESSION');
    for (let n = low; n <= high; n += step) {
      values.add(weekday && n === 7 ? 0 : n);
    }
  }
  return values;
}

/** Calendar stepping skips days and hours, not elapsed local-time durations. */
export function nextRun(expression, { now } = {}) {
  if (typeof expression !== 'string') fail('CRON_EXPRESSION');
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) fail('CRON_EXPRESSION');
  const fields = tokens.map((token,i) => field(token,...bounds[i],i === 4));
  if (typeof now !== 'function') fail('CRON_CLOCK');
  const start = now();
  if (!Number.isSafeInteger(start) || start < 0 || start > 8640000000000000 - 5 * 366 * 86400000) {
    fail('CRON_CLOCK');
  }
  const stop = start + 5 * 366 * 86400000;
  const candidate = new Date(Math.floor(start / 60000) * 60000 + 60000);
  const [minutes,hours,days,months,weekdays] = fields;
  function dayMatch(date) {
    const dom = days.has(date.getUTCDate());
    const dow = weekdays.has(date.getUTCDay());
    if (tokens[2] === '*' && tokens[4] === '*') return true;
    if (tokens[2] === '*') return dow;
    if (tokens[4] === '*') return dom;
    return dom || dow;
  }
  while (candidate.getTime() <= stop) {
    if (!months.has(candidate.getUTCMonth() + 1) || !dayMatch(candidate)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0,0,0,0);
      continue;
    }
    if (!hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1,0,0,0);
      continue;
    }
    if (minutes.has(candidate.getUTCMinutes())) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1,0,0);
  }
  return null;
}
