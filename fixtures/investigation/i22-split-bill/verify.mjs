import { splitCents } from './repo/src/split.js';
const a = splitCents(100, 3), b = splitCents(200, 3);
if (a.join() !== '33,33,33' || b.join() !== '67,67,67') throw new Error(a + ' ' + b);
console.log('ok i22');
