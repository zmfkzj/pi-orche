import { placeOrder } from './repo/src/orders.js';
const committed = []; const published = [];
const db = { transaction: async fn => { const rows = []; await fn({ insert: async (t, r) => rows.push(t) }); committed.push(rows); } };
const res = await placeOrder({ db, broker: { publish: async () => { throw new Error('down'); } } }, { id: 'o1', lines: [] });
if (committed.length !== 1 || res.ok !== true) throw new Error('loss scenario');
console.log('ok i17');
