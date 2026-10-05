import { isDuplicate, reset } from './repo/src/dedupe.js';
const e = { source: 's', id: '1' };
reset(); isDuplicate(e, 0);
if (!isDuplicate(e, 59)) throw new Error('59ms should be dup');
reset(); isDuplicate(e, 0);
if (isDuplicate(e, 3000)) throw new Error('3s should NOT be dup (bug)');
console.log('ok i05');
