import { cloneJSON } from './clone.js';

export function createSession(userId, { ttlMs = 3_600_000, now = Date.now(), onExpire = () => {} } = {}) {
  return {
    userId,
    createdAt: new Date(now),
    expiresAt: new Date(now + ttlMs),
    flags: new Map([['beta', true]]),
    impersonatedBy: undefined,
    onExpire,
  };
}

export function isExpired(session, now = Date.now()) {
  return new Date(session.expiresAt).getTime() <= now;
}

/** A detached copy for the audit log and the session store. */
export function snapshot(session) {
  return cloneJSON(session);
}
