import { uniqueBy } from './repo/src/collections.js';
import { importUsers } from './repo/src/import.js';
const r = uniqueBy([{ id: 1, v: 'a' }, { id: 1, v: 'b' }], i => i.id);
if (r.length !== 1 || r[0].v !== 'b') throw new Error(JSON.stringify(r));
const u = importUsers([{ email: 'A@x.io', name: 'first', tier: 'gold' }, { email: 'a@x.io', name: 'second', tier: 'free' }]);
if (u[0].name !== 'second') throw new Error('import');
console.log('ok i23');
