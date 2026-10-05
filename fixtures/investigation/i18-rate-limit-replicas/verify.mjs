import { allow } from './repo/src/limiter.js';
let ok = 0; for (let i = 0; i < 150; i++) if (allow('k', { now: 0 })) ok++;
if (ok !== 100) throw new Error(String(ok));
console.log('ok i18');
