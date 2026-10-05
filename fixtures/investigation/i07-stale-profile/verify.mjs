import { createProfiles, PROFILE_TTL_MS } from './repo/src/profiles.js';
let t = 0; const rows = new Map([[1, { name: 'A', avatar: 'x' }]]);
const p = createProfiles({ get: id => rows.get(id), set: (id, r) => rows.set(id, r) }, () => t);
p.getProfile(1); p.updateProfile(1, { name: 'B' });
if (p.getProfile(1).name !== 'A') throw new Error('expected stale');
t = PROFILE_TTL_MS + 1; if (p.getProfile(1).name !== 'B') throw new Error('expected fresh after TTL');
if (PROFILE_TTL_MS !== 300000) throw new Error('ttl');
console.log('ok i07');
