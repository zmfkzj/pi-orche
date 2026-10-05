import { bus } from './repo/src/bus.js';
import { handleRequest } from './repo/src/handler.js';
process.removeAllListeners('warning'); process.on('warning', () => {});
for (let i = 0; i < 100; i++) handleRequest({ user: 'u' }, { headers: {} });
if (bus.listenerCount('config') !== 100) throw new Error(String(bus.listenerCount('config')));
console.log('ok i08');
