export class TtlCache {
  constructor(ttlMs, now = () => Date.now()) { this.ttlMs = ttlMs; this.now = now; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key, value) { this.map.set(key, { value, at: this.now() }); }
  delete(key) { return this.map.delete(key); }
}
