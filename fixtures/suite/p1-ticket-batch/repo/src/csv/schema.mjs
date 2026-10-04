/** CSV import profile: administration schema, distinct from the public algorithm API. */
export const fields = Object.freeze({
  "name": {
    "type": "string",
    "required": true
  },
  "delimiter": {
    "type": "string",
    "required": true
  },
  "columns": {
    "type": "array",
    "required": false
  },
  "description": {
    "type": "string",
    "required": false
  }
});
export const schemaVersion = 1;
const metadata = new Set(['id', 'revision', 'createdAt', 'updatedAt']);
function validType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === type;
}
export function validateRecord(record, { partial = false, stored = false } = {}) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [{ field: '', code: 'OBJECT' }];
  }
  for (const [name, spec] of Object.entries(fields)) {
    const value = record[name];
    if (value === undefined) {
      if (spec.required && !partial) errors.push({ field: name, code: 'REQUIRED' });
      continue;
    }
    if (!validType(value, spec.type)) {
      errors.push({ field: name, code: 'TYPE' });
      continue;
    }
    if (spec.type === 'string' && value.length > 4096) errors.push({ field: name, code: 'LENGTH' });
    if (name === 'name' && !value.trim()) errors.push({ field: name, code: 'EMPTY' });
    if (spec.type === 'array' && value.length > 10000) errors.push({ field: name, code: 'SIZE' });
  }
  for (const name of Object.keys(record)) {
    if (!Object.hasOwn(fields, name) && !(stored && metadata.has(name))) {
      errors.push({ field: name, code: 'UNKNOWN' });
    }
  }
  return errors;
}
export function assertRecord(record, options) {
  const errors = validateRecord(record, options);
  if (errors.length) {
    throw Object.assign(new Error('Invalid administration record'), { code: 'RECORD_INPUT', errors });
  }
  return record;
}
export function projectRecord(record) {
  const result = {};
  for (const name of [...Object.keys(fields), ...metadata]) {
    if (Object.hasOwn(record, name)) result[name] = structuredClone(record[name]);
  }
  return result;
}
export function normalizeRecord(record) {
  assertRecord(record);
  const result = projectRecord(record);
  result.name = result.name.trim().normalize('NFC');
  return result;
}
export function describeSchema() {
  return Object.entries(fields).map(([name, spec]) => ({ name, ...spec }));
}
export function migrateRecord(record, version) {
  if (version === schemaVersion) {
    assertRecord(record, { stored: true });
    return projectRecord(record);
  }
  if (version === 0) {
    const copy = structuredClone(record);
    if (copy.title !== undefined && copy.name === undefined) copy.name = copy.title;
    delete copy.title;
    assertRecord(copy, { stored: true });
    return projectRecord(copy);
  }
  throw Object.assign(new Error('Unsupported record schema'), { code: 'SCHEMA_VERSION' });
}
export function recordFingerprint(record) {
  const projected = projectRecord(record);
  return JSON.stringify(Object.keys(projected).sort().map(key => [key, projected[key]]));
}
export function changedFields(previous, next) {
  return Object.keys(fields).filter(name => JSON.stringify(previous[name]) !== JSON.stringify(next[name]));
}
