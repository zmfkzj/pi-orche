/** Decode one JSON log record from the application collector. */
const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseLine(line) {
  const record = JSON.parse(line);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Log record must be an object');
  }
  if (typeof record.timestamp !== 'string' || !ISO.test(record.timestamp)) {
    throw new Error('Log record requires an ISO timestamp with an offset');
  }
  const time = Date.parse(record.timestamp);
  if (!Number.isFinite(time)) throw new Error('Invalid log timestamp');
  if (typeof record.level !== 'string' || !LEVELS.has(record.level)) {
    throw new Error('Unknown log level');
  }
  if (typeof record.source !== 'string' || !record.source.length) {
    throw new Error('Log record requires a source');
  }
  if (typeof record.message !== 'string') {
    throw new Error('Log record requires a message');
  }
  return { time, level: record.level, source: record.source, message: record.message };
}

/** Empty physical lines are separators, not application events. */
export function parseLogs(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(parseLine(line));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

/** Timestamp policy shared by filtering and hourly reporting. */
export function parseInstant(value) {
  if (typeof value !== 'string' || !ISO.test(value)) {
    throw new Error('Expected an ISO timestamp with an explicit offset');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid ISO timestamp');
  return time;
}
