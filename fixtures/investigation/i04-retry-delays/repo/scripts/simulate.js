import { runJob } from '../src/runner.js';
const delays = [];
const job = { id: 'demo', run: async () => { throw new Error('boom'); } };
await runJob(job, { sleep: async ms => { delays.push(ms); }, log: entry => console.log(JSON.stringify(entry)) }).catch(() => {});
console.log('delays', delays.join(', '));
