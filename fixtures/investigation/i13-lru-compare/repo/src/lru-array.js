export class ArrayLru {
  constructor(capacity) { this.capacity = capacity; this.keys = []; this.values = new Map(); }
  get(key) {
    return this.values.get(key);
  }
  set(key, value) {
    const index = this.keys.indexOf(key);
    if (index >= 0) this.keys.splice(index, 1);
    this.keys.push(key);
    this.values.set(key, value);
    if (this.keys.length > this.capacity) this.values.delete(this.keys.shift());
  }
  has(key) { return this.values.has(key); }
}
