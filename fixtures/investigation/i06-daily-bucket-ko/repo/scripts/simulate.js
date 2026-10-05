import { readFileSync } from 'node:fs';
import { dailyTotals } from '../src/report.js';
const orders = JSON.parse(readFileSync(new URL('../data/orders.json', import.meta.url), 'utf8'));
console.log(dailyTotals(orders));
