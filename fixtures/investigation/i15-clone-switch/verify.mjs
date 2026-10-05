import { createSession, snapshot } from './repo/src/session.js';
const s = createSession('u');
const json = snapshot(s); if (typeof json.expiresAt !== 'string' || json.onExpire !== undefined) throw new Error('json');
let threw = false; try { structuredClone(s); } catch (e) { threw = e.name === 'DataCloneError'; }
if (!threw) throw new Error('structuredClone should throw');
console.log('ok i15');
