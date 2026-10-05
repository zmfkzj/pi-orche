import { median } from './repo/src/stats.js';
if (median([10, 2, 3]) !== 2) throw new Error('counterexample');
console.log('ok i20');
