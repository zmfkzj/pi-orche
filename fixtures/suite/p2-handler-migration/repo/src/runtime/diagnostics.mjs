const severity = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };
const sensitive = /password|secret|token|authorization/i;
function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sensitive.test(key) ? '[redacted]' : redact(item, seen);
  }
  return result;
}
/** Sink and clock are supplied so diagnostics remain testable. */
export function createLogger({ sink, now, level = 'info', context = {} }) {
  if (typeof sink !== 'function' || typeof now !== 'function') throw new TypeError('Logger hooks required');
  if (!Object.hasOwn(severity, level)) throw new Error('Invalid log level');
  const detached = structuredClone(context);
  function write(kind, event, data = {}) {
    if (severity[kind] < severity[level]) return;
    if (typeof event !== 'string' || !event) throw new TypeError('Event required');
    const record = {
      at: now(),
      level: kind,
      event,
      context: redact(detached),
      data: redact(data),
    };
    sink(JSON.stringify(record));
  }
  return Object.freeze({
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    child(extra) {
      return createLogger({ sink, now, level, context: { ...detached, ...extra } });
    },
  });
}
export function collectDiagnostics() {
  const records = [];
  return {
    sink(line) {
      records.push(JSON.parse(line));
    },
    records() {
      return structuredClone(records);
    },
    clear() {
      records.length = 0;
    },
    count(level) {
      return records.filter(record => record.level === level).length;
    },
  };
}
export function publicError(error, fallback = 'INTERNAL') {
  return { code: typeof error?.code === 'string' ? error.code : fallback };
}
export function summarizeDiagnostics(records) {
  const counts = {};
  for (const record of records) {
    counts[record.level] = (counts[record.level] || 0) + 1;
  }
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
}
