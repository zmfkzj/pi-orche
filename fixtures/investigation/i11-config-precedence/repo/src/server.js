import { createServer } from 'node:http';
import { loadConfig } from './config.js';
const { port, host } = loadConfig();
createServer((_, res) => res.end('ok')).listen(port, host, () => console.log(`listening on ${host}:${port}`));
