/** Detached in-memory document storage for local demos, not a ticket API. */
export function createMemoryStore(seed = []) {
  let rows = new Map();
  let sequence = 0;
  for (const row of seed) {
    if (typeof row.id !== 'string' || rows.has(row.id)) throw new Error('Invalid seed id');
    rows.set(row.id, structuredClone(row));
  }
  let tail = Promise.resolve();
  return {
    get(id) {
      const row = rows.get(id);
      return row === undefined ? null : structuredClone(row);
    },
    list(predicate = () => true) {
      return [...rows.values()].map(row => structuredClone(row)).filter(predicate);
    },
    insert(value) {
      let id;
      do { id = 'row-' + ++sequence; } while (rows.has(id));
      const row = { ...structuredClone(value), id };
      rows.set(id, row);
      return structuredClone(row);
    },
    replace(id, value) {
      if (!rows.has(id)) return false;
      rows.set(id, { ...structuredClone(value), id });
      return true;
    },
    remove(id) {
      return rows.delete(id);
    },
    clear() {
      rows.clear();
    },
    async transaction(fn) {
      const run = tail.then(async () => {
        const draft = new Map([...rows].map(([id, row]) => [id, structuredClone(row)]));
        const tx = {
          get: id => draft.has(id) ? structuredClone(draft.get(id)) : null,
          put: row => draft.set(row.id, structuredClone(row)),
          remove: id => draft.delete(id),
          list: () => [...draft.values()].map(row => structuredClone(row)),
        };
        const result = await fn(tx);
        rows = draft;
        return structuredClone(result);
      });
      tail = run.catch(() => {});
      return run;
    },
    snapshot() {
      return { sequence, rows: [...rows.values()].map(row => structuredClone(row)) };
    },
  };
}
export function compareVersion(current, expected) {
  if (current !== expected) throw Object.assign(new Error('Version mismatch'), { code: 'VERSION' });
}
export function nextVersion(current) {
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Invalid version');
  }
  return current + 1;
}
