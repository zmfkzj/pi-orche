import { allow } from './limiter.js';
export function handle(req) {
  if (!allow(req.headers['x-api-key'])) return { status: 429 };
  return { status: 200 };
}
