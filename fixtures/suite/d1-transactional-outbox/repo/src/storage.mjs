import { copy } from './values.mjs';
export class Database {
  constructor() { this.state = { orders: [], keys: [], events: [], sequence: 0 }; this.failure = null; }
  failNext(stage) { this.failure = stage; }
  fault(stage) { if (this.failure === stage) { this.failure = null; throw new Error(`injected ${stage}`); } }
  rows(table) { return copy(this.state[table]); }
  async transaction(fn) { return fn(this.state); }
}
