import { uniqueBy } from './collections.js';

/** Rows come from the CSV in file order; the first row for an email is the canonical one. */
export function importUsers(rows) {
  return uniqueBy(rows, row => row.email.toLowerCase()).map(row => ({ email: row.email, name: row.name, tier: row.tier }));
}
