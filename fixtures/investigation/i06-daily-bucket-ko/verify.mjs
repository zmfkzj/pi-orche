import { readFileSync } from 'node:fs';
import { dailyTotals } from './repo/src/report.js';
const orders = JSON.parse(readFileSync(new URL('./repo/data/orders.json', import.meta.url), 'utf8'));
const now = dailyTotals(orders);
if (JSON.stringify(now) !== JSON.stringify({ '2026-03-01': 47000, '2026-03-02': 12000 })) throw new Error(JSON.stringify(now));
const kst = {}; for (const o of orders) { const d = new Date(Date.parse(o.createdAt) + 9 * 3600e3).toISOString().slice(0, 10); kst[d] = (kst[d] ?? 0) + o.amount; }
if (JSON.stringify(kst) !== JSON.stringify({ '2026-03-01': 30000, '2026-03-02': 29000 })) throw new Error(JSON.stringify(kst));
console.log('ok i06');
