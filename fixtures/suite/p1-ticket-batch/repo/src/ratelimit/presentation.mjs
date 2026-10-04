import { describeSchema, projectRecord } from './schema.mjs';
import { formatTable, markdownTable } from '../runtime/format-table.mjs';
function columnDefinitions() {
  return [
    { key: 'id', title: 'ID' },
    ...describeSchema().map(field => ({
      key: field.name,
      title: field.name,
      align: field.type === 'integer' ? 'right' : 'left',
    })),
    { key: 'revision', title: 'Revision', align: 'right' },
  ];
}
export function recordsAsTable(records, options) {
  return formatTable(records.map(projectRecord), columnDefinitions(), options);
}
export function recordsAsMarkdown(records) {
  return markdownTable(records.map(projectRecord), columnDefinitions());
}
export function recordsAsJson(records, { pretty = false } = {}) {
  return JSON.stringify(records.map(projectRecord), null, pretty ? 2 : undefined);
}
export function describeRecord(record) {
  const projected = projectRecord(record);
  return Object.entries(projected).map(([key, value]) => ({
    field: key,
    value: Array.isArray(value) ? value.join(', ') : String(value),
  }));
}
export function recordSummary(records) {
  const result = { count: records.length, oldest: null, newest: null, arrays: {} };
  for (const record of records) {
    if (Number.isFinite(record.createdAt)) {
      result.oldest = result.oldest === null ? record.createdAt : Math.min(result.oldest, record.createdAt);
      result.newest = result.newest === null ? record.createdAt : Math.max(result.newest, record.createdAt);
    }
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value)) result.arrays[key] = (result.arrays[key] || 0) + value.length;
    }
  }
  return result;
}
export function compareRecords(previous, next) {
  const before = new Map(previous.map(row => [row.id, row]));
  const after = new Map(next.map(row => [row.id, row]));
  const added = [], removed = [], changed = [];
  for (const [id, row] of after) {
    if (!before.has(id)) added.push(projectRecord(row));
    else if (JSON.stringify(before.get(id)) !== JSON.stringify(row)) changed.push({
      id,
      before: projectRecord(before.get(id)),
      after: projectRecord(row),
    });
  }
  for (const [id, row] of before) if (!after.has(id)) removed.push(projectRecord(row));
  return { added, removed, changed };
}
export function renderRecords(records, format) {
  if (format === 'table') return recordsAsTable(records);
  if (format === 'markdown') return recordsAsMarkdown(records);
  if (format === 'json') return recordsAsJson(records, { pretty: true });
  throw new Error('Unsupported record output: ' + format);
}
