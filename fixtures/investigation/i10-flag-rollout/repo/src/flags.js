import { readFileSync } from 'node:fs';
import { bucket } from './hash.js';

const flags = JSON.parse(readFileSync(new URL('../config/flags.json', import.meta.url), 'utf8'));
const envName = flag => `FLAG_${flag.toUpperCase().replaceAll('-', '_')}`;

export function isEnabled(flag, userId, env = process.env) {
  const definition = flags[flag];
  if (!definition) return false;
  const override = env[envName(flag)];
  if (override === 'on') return true;
  if (override === 'off') return false;
  if (definition.users.deny.includes(userId)) return false;
  if (definition.users.allow.includes(userId)) return true;
  return bucket(flag, userId) < definition.rolloutPercent;
}
