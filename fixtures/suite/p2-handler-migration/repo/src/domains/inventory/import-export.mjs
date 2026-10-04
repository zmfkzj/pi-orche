import { schemaVersion, validateRecord, projectRecord, migrateRecord } from './schema.mjs';
import { readJsonLines, stableJson } from '../../runtime/json-lines.mjs';
/** Administration import/export; it intentionally does not call the ticket API. */
export function exportBundle(repository) {
  const snapshot = repository.snapshot();
  return {
    format: 'inventory-records',
    version: schemaVersion,
    records: snapshot.records.map(projectRecord),
  };
}
export function inspectBundle(bundle) {
  const errors = [];
  if (!bundle || bundle.format !== 'inventory-records' || !Array.isArray(bundle.records)) {
    return [{ index: null, code: 'BUNDLE_FORMAT' }];
  }
  const ids = new Set(), names = new Set();
  bundle.records.forEach((record, index) => {
    for (const error of validateRecord(record, { stored: true })) errors.push({ index, ...error });
    if (ids.has(record.id)) errors.push({ index, code: 'DUPLICATE_ID' });
    if (names.has(record.name)) errors.push({ index, code: 'DUPLICATE_NAME' });
    ids.add(record.id);
    names.add(record.name);
  });
  return errors;
}
export function importBundle(repository, bundle) {
  const errors = inspectBundle(bundle);
  if (errors.length) throw Object.assign(new Error('Invalid bundle'), { code: 'BUNDLE_INPUT', errors });
  const migrated = bundle.records.map(row => migrateRecord(row, bundle.version));
  const snapshot = repository.snapshot();
  repository.restore({ sequence: snapshot.sequence, records: migrated });
  return { imported: migrated.length };
}
export async function importLines(repository, chunks, { stopOnError = true } = {}) {
  const result = { inserted: [], rejected: [] };
  for await (const { line, value } of readJsonLines(chunks)) {
    try {
      result.inserted.push(repository.insert(value));
    } catch (error) {
      result.rejected.push({ line, code: error.code || 'RECORD_INPUT' });
      if (stopOnError) break;
    }
  }
  return result;
}
export function bundleDigestInput(bundle) {
  return stableJson({
    format: bundle.format,
    version: bundle.version,
    records: bundle.records.map(projectRecord).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  });
}
export function selectExport(bundle, ids) {
  const selected = new Set(ids);
  return { ...bundle, records: bundle.records.filter(row => selected.has(row.id)).map(projectRecord) };
}
export function redactExport(bundle, fields) {
  const hidden = new Set(fields);
  return {
    ...bundle,
    records: bundle.records.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !hidden.has(key)))),
  };
}
