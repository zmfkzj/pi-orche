import { start, complete, fail } from './jobs.js';

export async function runOnce(job, handler) {
  start(job);
  try {
    await handler(job.payload);
    complete(job);
  } catch (error) {
    fail(job, error);
  }
  return job;
}
