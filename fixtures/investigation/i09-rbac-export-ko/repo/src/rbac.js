import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'));

function expand(role, seen = new Set()) {
  if (seen.has(role)) return seen;
  seen.add(role);
  for (const parent of policy.roles[role]?.inherits ?? []) expand(parent, seen);
  return seen;
}

const matches = (list, permission) => list.includes('*') || list.includes(permission);

export function can(user, permission) {
  const roles = new Set();
  for (const role of policy.users[user] ?? []) for (const r of expand(role)) roles.add(r);
  const entries = [...roles].map(role => policy.roles[role]);
  if (entries.some(entry => matches(entry.deny, permission))) return false;
  return entries.some(entry => matches(entry.allow, permission));
}
