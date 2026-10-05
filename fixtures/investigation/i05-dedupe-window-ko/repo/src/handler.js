import { isDuplicate } from './dedupe.js';

export function handle(event, process) {
  if (isDuplicate(event)) return { status: 'duplicate' };
  process(event);
  return { status: 'processed' };
}
