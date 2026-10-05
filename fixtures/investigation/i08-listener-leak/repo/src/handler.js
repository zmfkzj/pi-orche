import { bus } from './bus.js';

let currentConfig = { greeting: 'hello' };

export function handleRequest(req, res) {
  // Keep the response in sync if the config changes while we work.
  bus.on('config', next => {
    currentConfig = next;
    res.headers['x-config-version'] = next.version;
  });
  res.body = `${currentConfig.greeting}, ${req.user}`;
  return res;
}
