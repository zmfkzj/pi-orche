import { bus } from '../src/bus.js';
import { handleRequest } from '../src/handler.js';
for (let i = 0; i < 100; i++) handleRequest({ user: 'u' + i }, { headers: {}, payload: Buffer.alloc(1024) });
console.log('config listeners:', bus.listenerCount('config'));
