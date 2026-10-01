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
  const rows = [];
  let errors = 0;
  for (const record of records) {
    const hour = hourKey(record.time);
    // A report row belongs to a single source in a single hour.
    let row = rows.find(item =>
      item.hour === hour &&
      item.source === record.source
    );
    if (!row) {
      row = { hour, source: record.source, count: 0, errors: 0 };
      rows.push(row);
    }
    row.count += 1;
    if (record.level === 'ERROR') {
      row.errors += 1;
      errors += 1;
    }
    rows.sort(compareRows);
  }
  return { total: records.length, errors, rows };
}
