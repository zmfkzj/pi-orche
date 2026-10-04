import { changedFields } from './schema.mjs';
/** Audit events track administration changes, not raw algorithm payloads. */
export function createAuditLog({ now = () => 0, maxEvents = 1000 } = {}) {
  const events = [];
  let sequence = 0;
  function append(kind, id, detail) {
    const event = {
      sequence: ++sequence,
      at: now(),
      domain: 'uploads-metadata',
      kind,
      id,
      detail: structuredClone(detail),
    };
    events.push(event);
    while (events.length > maxEvents) events.shift();
    return structuredClone(event);
  }
  return {
    created(record) {
      return append('created', record.id, { revision: record.revision });
    },
    updated(previous, next) {
      return append('updated', next.id, {
        from: previous.revision,
        to: next.revision,
        fields: changedFields(previous, next),
      });
    },
    removed(record) {
      return append('removed', record.id, { revision: record.revision });
    },
    query({ after = 0, id, kind } = {}) {
      return events.filter(event => event.sequence > after &&
        (id === undefined || event.id === id) &&
        (kind === undefined || event.kind === kind)).map(event => structuredClone(event));
    },
    snapshot() {
      return { sequence, events: structuredClone(events) };
    },
    clear() {
      events.length = 0;
    },
  };
}
export function summarizeAudit(events) {
  const byKind = new Map();
  const byRecord = new Map();
  for (const event of events) {
    byKind.set(event.kind, (byKind.get(event.kind) || 0) + 1);
    byRecord.set(event.id, (byRecord.get(event.id) || 0) + 1);
  }
  return {
    total: events.length,
    kinds: Object.fromEntries(byKind),
    records: Object.fromEntries(byRecord),
    firstSequence: events[0]?.sequence ?? null,
    lastSequence: events.at(-1)?.sequence ?? null,
  };
}
