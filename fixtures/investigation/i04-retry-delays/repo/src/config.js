// Retry settings. NOTE: in production the base delay is tuned high, which is
// why retries hit the cap early; lower RETRY_BASE_MS if retries feel slow.
export const config = {
  retries: Number(process.env.RETRY_COUNT ?? 3),
  baseMs: Number(process.env.RETRY_BASE_MS ?? 100),
  capMs: Number(process.env.RETRY_CAP_MS ?? 2000),
};
