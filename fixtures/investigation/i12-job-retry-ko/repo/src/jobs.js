export const MAX_ATTEMPTS = 3;

export function createJob(id, payload) {
  return { id, payload, state: 'queued', attempts: 0, history: ['queued'] };
}

function move(job, state) {
  job.state = state;
  job.history.push(state);
  return job;
}

export function start(job) {
  if (job.state !== 'queued') throw new Error(`cannot start ${job.state} job`);
  job.attempts += 1;
  return move(job, 'running');
}

export function complete(job) {
  if (job.state !== 'running') throw new Error(`cannot complete ${job.state} job`);
  return move(job, 'succeeded');
}

export function fail(job, error) {
  if (job.state !== 'running') throw new Error(`cannot fail ${job.state} job`);
  move(job, 'failed');
  job.lastError = error.message;
  if (error.retryable === true && job.attempts < MAX_ATTEMPTS) return move(job, 'queued');
  return move(job, 'dead');
}
