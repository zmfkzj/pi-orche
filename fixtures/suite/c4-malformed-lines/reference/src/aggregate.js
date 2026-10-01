/** UTC hour labels allow reports from separate collectors to be merged. */
export function hourKey(time) {
  return new Date(time).toISOString().slice(0, 13) + ':00:00Z';
}

function compareRows(a, b) {
  if (a.hour !== b.hour) return a.hour < b.hour ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
}

/** Group by both hour and source; callers retain ownership of records. */
export function aggregate(records) {
  const groups = new Map();
  let errors = 0;
  for (const record of records) {
    const hour = hourKey(record.time);
    let sources = groups.get(hour);
    if (!sources) {
      sources = new Map();
      groups.set(hour, sources);
    }
    let row = sources.get(record.source);
    if (!row) {
      row = { hour, source: record.source, count: 0, errors: 0 };
      sources.set(record.source, row);
    }
    row.count += 1;
    if (record.level === 'ERROR') {
      row.errors += 1;
      errors += 1;
    }
  }
  const rows = [];
  for (const sources of groups.values()) {
    for (const row of sources.values()) rows.push(row);
  }
  rows.sort(compareRows);
  return { total: records.length, errors, rows };
}
