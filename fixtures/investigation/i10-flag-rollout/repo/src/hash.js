/** FNV-1a 32-bit. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const bucket = (flag, userId) => fnv1a(`${flag}:${userId}`) % 100;
