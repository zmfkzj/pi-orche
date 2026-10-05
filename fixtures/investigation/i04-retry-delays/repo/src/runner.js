import { config } from './config.js';
import { delayFor } from './backoff.js';

export async function runJob(job, { sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      return await job.run();
    } catch (error) {
      lastError = error;
      if (attempt === config.retries) break;
      const delay = delayFor(config.baseMs, attempt);
      log({ job: job.id, attempt, delay });
      await sleep(delay);
    }
  }
  throw lastError;
}
