import { createPrices } from './repo/src/prices.js';
let dbPrice = 100; const store = new Map(); let gate;
const db = { readPrice: async () => { const v = dbPrice; await new Promise(r => (gate = r)); return v; }, writePrice: async (_, p) => { dbPrice = p; } };
const cache = { get: async k => store.get(k), set: async (k, v) => store.set(k, v), delete: async k => store.delete(k) };
const p = createPrices({ db, cache });
const reading = p.getPrice('x'); await new Promise(r => setTimeout(r, 0));
await p.updatePrice('x', 120); gate(); await reading;
if (store.get('price:x') !== 100) throw new Error('expected stale set');
console.log('ok i19');
