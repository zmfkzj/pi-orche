import { overlaps, canBook } from './repo/src/booking.js';
if (overlaps({ start: 540, end: 600 }, { start: 600, end: 660 }) !== true) throw new Error('adjacent');
if (canBook([{ start: 540, end: 600 }], { start: 600, end: 660 }) !== false) throw new Error('canBook');
console.log('ok i21');
