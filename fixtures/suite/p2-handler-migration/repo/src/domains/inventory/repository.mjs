import { normalizeRecord, assertRecord, projectRecord } from './schema.mjs';
/** Local metadata repository. Never implements the unit's algorithm. */
export function createRepository({ now = () => 0, seed = [] } = {}) {
  const records = new Map();
  let sequence = 0;
  for (const row of seed) {
    assertRecord(row, { stored: true });
    if (!row.id || records.has(row.id)) throw new Error('Duplicate seed identifier');
    records.set(row.id, projectRecord(row));
  }
  function read(id) {
    const row = records.get(id);
    return row ? projectRecord(row) : null;
  }
  function findName(name, except) {
    return [...records.values()].find(row => row.name === name && row.id !== except);
  }
  function conflict(code) {
    throw Object.assign(new Error('Metadata repository conflict'), { code });
  }
  return {
    get: read,
    list({ prefix = '', offset = 0, limit = 100 } = {}) {
      const rows = [...records.values()].filter(row => row.name.startsWith(prefix));
      rows.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      return { items: rows.slice(offset, offset + limit).map(projectRecord), total: rows.length };
    },
    insert(input) {
      const value = normalizeRecord(input);
      if (findName(value.name)) conflict('RECORD_EXISTS');
      let id;
      do { id = 'inventory-' + ++sequence; } while (records.has(id));
      const time = now();
      records.set(id, { ...value, id, revision: 1, createdAt: time, updatedAt: time });
      return read(id);
    },
    update(id, patch, expectedRevision) {
      assertRecord(patch, { partial: true });
      const current = records.get(id);
      if (!current) conflict('RECORD_MISSING');
      if (current.revision !== expectedRevision) conflict('RECORD_REVISION');
      const input = Object.fromEntries(Object.entries(current).filter(([key]) =>
        !['id', 'revision', 'createdAt', 'updatedAt'].includes(key)));
      const value = normalizeRecord({ ...input, ...structuredClone(patch) });
      if (findName(value.name, id)) conflict('RECORD_EXISTS');
      records.set(id, {
        ...value,
        id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: now(),
      });
      return read(id);
    },
    remove(id, expectedRevision) {
      const current = records.get(id);
      if (!current) return false;
      if (current.revision !== expectedRevision) conflict('RECORD_REVISION');
      return records.delete(id);
    },
    findByName(name) {
      const found = findName(name);
      return found ? projectRecord(found) : null;
    },
    snapshot() {
      return { sequence, records: [...records.values()].map(projectRecord) };
    },
    restore(snapshot) {
      const next = new Map();
      for (const row of snapshot.records) {
        assertRecord(row, { stored: true });
        if (next.has(row.id)) conflict('RECORD_EXISTS');
        next.set(row.id, projectRecord(row));
      }
      records.clear();
      for (const [id, row] of next) records.set(id, row);
      sequence = snapshot.sequence;
    },
  };
}
