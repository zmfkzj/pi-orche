export const DEFAULT_TIMEOUT_MS = 10_000;

export function createClient(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");
  return { baseUrl: options.baseUrl ?? "", timeoutMs };
}
