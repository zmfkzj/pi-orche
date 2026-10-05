import { throttle, debounce } from './repo/src/rate.js';
let t = 0; const sent = []; const th = throttle(q => sent.push(q), 300, () => t);
for (const [time, q] of [[0, 'a'], [100, 'ab'], [200, 'abc']]) { t = time; th(q); }
if (sent.join() !== 'a') throw new Error('throttle ' + sent);
const timers = { q: [], setTimeout(f, ms) { const h = { f, at: t + ms }; this.q.push(h); return h; }, clearTimeout(h) { this.q = this.q.filter(x => x !== h); } };
const got = []; const db = debounce(q => got.push(q), 300, timers);
for (let i = 0; i < 10; i++) { t = i * 100; db('q' + i); timers.q.filter(h => h.at <= t).forEach(h => { timers.q = timers.q.filter(x => x !== h); h.f(); }); }
if (got.length !== 0) throw new Error('debounce fired while typing');
t = 2000; timers.q.forEach(h => h.f()); if (got.join() !== 'q9') throw new Error('debounce final ' + got);
console.log('ok i14');
