import { config } from './config.js';

const seen = new Map();

export function keyOf(event) {
  return `${event.source}:${event.id}`;
}

/** True when the same event was seen within the dedupe window. Records the event otherwise. */
export function isDuplicate(event, now = Date.now()) {
  const key = keyOf(event);
  const last = seen.get(key);
  if (last !== undefined && now - last < config.ttlSeconds) return true;
  seen.set(key, now);
  return false;
}

export function reset() { seen.clear(); }
