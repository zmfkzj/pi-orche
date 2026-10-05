import { createJob } from './repo/src/jobs.js';
import { runOnce } from './repo/src/worker.js';
const job = createJob(1, {}); const err = Object.assign(new Error('x'), { retryable: true });
let runs = 0; while (job.state === 'queued') { runs++; await runOnce(job, async () => { throw err; }); }
if (runs !== 3 || job.state !== 'dead') throw new Error(runs + job.state);
if (job.history.filter(s => s === 'queued').length !== 3) throw new Error(job.history.join());
console.log('ok i12');
