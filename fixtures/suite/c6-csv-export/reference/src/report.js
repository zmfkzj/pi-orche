/** Stable text output for operators and shell pipelines. */
export function renderSummary(result, skipped = 0) {
  const rate = result.total === 0 ? 0 : result.errors / result.total * 100;
  const lines = [
    `Total: ${result.total}`,
    `Errors: ${result.errors}`,
    `Error rate: ${rate.toFixed(2)}%`,
  ];
  for (const row of result.rows) {
    lines.push(`${row.hour} ${JSON.stringify(row.source)} count=${row.count} errors=${row.errors}`);
  }
  return lines.join('\n') + '\n';
}

/** RFC 4180 quoting applies to every textual field, including source names. */
function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function renderCSV(result) {
  const lines = ['hour,source,count,errors'];
  for (const row of result.rows) {
    lines.push([row.hour, row.source, row.count, row.errors].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
