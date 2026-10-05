import { TtlCache } from './cache.js';

export const PROFILE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_FIELDS = ['name', 'avatar'];

export function cacheKey(id, fields = DEFAULT_FIELDS) {
  return `user:${id}:${fields.join(',')}`;
}

export function createProfiles(db, now) {
  const cache = new TtlCache(PROFILE_TTL_MS, now);
  return {
    getProfile(id, fields = DEFAULT_FIELDS) {
      const key = cacheKey(id, fields);
      const cached = cache.get(key);
      if (cached) return cached;
      const row = db.get(id);
      const profile = Object.fromEntries(fields.map(field => [field, row[field]]));
      cache.set(key, profile);
      return profile;
    },
    updateProfile(id, patch) {
      db.set(id, { ...db.get(id), ...patch });
      // Invalidate so the next read sees the edit.
      cache.delete(`user:${id}`);
    },
  };
}
