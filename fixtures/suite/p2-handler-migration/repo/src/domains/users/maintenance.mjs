import { createRepository } from './repository.mjs';
import { createAuditLog, summarizeAudit } from './audit.mjs';
import { exportBundle, importBundle } from './import-export.mjs';
import { recordSummary } from './presentation.mjs';
/** Administration facade used by the local CLI. Algorithm functions stay separate. */
export function createMaintenance(options = {}) {
  const repository = createRepository(options);
  const audit = createAuditLog(options);
  return {
    create(input) {
      const record = repository.insert(input);
      audit.created(record);
      return record;
    },
    update(id, patch, revision) {
      const before = repository.get(id);
      const record = repository.update(id, patch, revision);
      audit.updated(before, record);
      return record;
    },
    remove(id, revision) {
      const before = repository.get(id);
      const removed = repository.remove(id, revision);
      if (removed) audit.removed(before);
      return removed;
    },
    get(id) {
      return repository.get(id);
    },
    list(options) {
      return repository.list(options);
    },
    backup() {
      return exportBundle(repository);
    },
    restore(bundle) {
      return importBundle(repository, bundle);
    },
    diagnostics() {
      return {
        domain: 'users',
        records: recordSummary(repository.snapshot().records),
        audit: summarizeAudit(audit.query()),
      };
    },
    history(id) {
      return audit.query({ id });
    },
  };
}
export function registerMaintenance(registry, maintenance) {
  registry.register('users-list', {
    description: 'List Directory administration record metadata',
    run: input => maintenance.list(input || {}),
  });
  registry.register('users-create', {
    description: 'Create Directory administration record metadata',
    run: input => maintenance.create(input),
  });
  registry.register('users-diagnostics', {
    description: 'Summarize Directory administration record metadata',
    run: () => maintenance.diagnostics(),
  });
}
