import { delayFor } from './repo/src/backoff.js';
import { runJob } from './repo/src/runner.js';
const delays = [];
await runJob({ id: 'x', run: async () => { throw new Error('x'); } }, { sleep: async ms => { delays.push(ms); } }).catch(() => {});
if (delays.join() !== '0,2000,2000') throw new Error('observed ' + delays);
if ([0, 1, 2].map(n => delayFor(n, 100, 2000)).join() !== '100,200,400') throw new Error('intended');
console.log('ok i04');
