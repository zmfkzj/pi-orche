/** Stable text output for operators and shell pipelines. */
export function renderSummary(result, skipped = 0) {
  const rate = result.total === 0 ? 0 : result.errors / result.total * 100;
  const lines = [
    `Total: ${result.total}`,
    `Errors: ${result.errors}`,
    `Error rate: ${rate.toFixed(2)}%`,
    `Skipped: ${skipped}`,
  ];
  for (const row of result.rows) {
    lines.push(`${row.hour} ${JSON.stringify(row.source)} count=${row.count} errors=${row.errors}`);
  }
  return lines.join('\n') + '\n';
}
