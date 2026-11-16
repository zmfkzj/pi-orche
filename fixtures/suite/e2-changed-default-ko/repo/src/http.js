export const DEFAULT_TIMEOUT_MS = 30_000;

export function createClient(options = {}) {
  return { baseUrl: options.baseUrl ?? "", timeoutMs: DEFAULT_TIMEOUT_MS };
}
