/** In-memory collection. Each application owns an independent store. */
export function createStore(seed = []) {
  const rows = new Map();
  let sequence = 0;
  for (const item of seed) {
    rows.set(String(item.id), { ...item, id: String(item.id) });
    sequence = Math.max(sequence, Number(item.id) || 0);
  }
  return {
    list() {
      return [...rows.values()].map(item => ({ ...item }));
    },
    get(id) {
      const item = rows.get(String(id));
      return item ? { ...item } : undefined;
    },
    hasName(name, exceptId) {
      return [...rows.values()].some(item => item.name === name && item.id !== exceptId);
    },
    add(fields) {
      const item = { id: String(++sequence), ...fields };
      rows.set(item.id, item);
      return { ...item };
    },
    update(id, fields) {
      const item = { ...rows.get(id), ...fields };
      rows.set(id, item);
      return { ...item };
    },
    remove(id) {
      return rows.delete(id);
    },
  };
}
