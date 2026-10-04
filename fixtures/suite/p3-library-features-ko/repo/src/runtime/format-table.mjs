function display(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function truncate(text, width) {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + '…';
}
/** Plain text output with no terminal escape sequences or locale dependence. */
export function formatTable(rows, columns, { maxWidth = 40, header = true } = {}) {
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 1) throw new RangeError('Invalid column width');
  const values = rows.map(row => columns.map(column => display(row[column.key])));
  const widths = columns.map((column, i) => Math.min(maxWidth,
    Math.max(column.title.length, ...values.map(row => row[i].length))));
  function line(row) {
    return row.map((cell, i) => {
      const text = truncate(cell.replace(/[\r\n\t]/g, ' '), widths[i]);
      return columns[i].align === 'right' ? text.padStart(widths[i]) : text.padEnd(widths[i]);
    }).join(' | ');
  }
  const output = [];
  if (header) {
    output.push(line(columns.map(column => column.title)));
    output.push(widths.map(width => '-'.repeat(width)).join('-+-'));
  }
  output.push(...values.map(line));
  return output.join('\n');
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid byte count');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return (unit ? bytes.toFixed(2) : String(bytes)) + ' ' + units[unit];
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid duration');
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(2) + 's';
  return Math.floor(ms / 60000) + 'm ' + ((ms % 60000) / 1000).toFixed(0) + 's';
}
export function formatSummary(entries) {
  const width = Math.max(0, ...Object.keys(entries).map(key => key.length));
  return Object.entries(entries).map(([key, value]) => key.padEnd(width) + ': ' + display(value)).join('\n');
}
export function escapeMarkdown(text) {
  return String(text).replace(/[|\\`*_]/g, match => '\\' + match).replace(/\r?\n/g, '<br>');
}
export function markdownTable(rows, columns) {
  const header = '| ' + columns.map(column => escapeMarkdown(column.title)).join(' | ') + ' |';
  const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map(row => '| ' + columns.map(column => escapeMarkdown(display(row[column.key]))).join(' | ') + ' |');
  return [header, separator, ...body].join('\n');
}
