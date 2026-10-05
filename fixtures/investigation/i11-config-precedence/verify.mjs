import { loadConfig } from './repo/src/config.js';
if (loadConfig(['--port', '9090'], { PORT: '8080' }).port !== 8080) throw new Error('env should win');
console.log('ok i11');
