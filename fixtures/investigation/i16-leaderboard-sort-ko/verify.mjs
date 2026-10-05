import { quickSortBy } from './repo/src/legacy-sort.js';
import { rank } from './repo/src/leaderboard.js';
const input = [{ u: 'u1', score: 5 }, { u: 'u2', score: 9 }, { u: 'u3', score: 5 }];
const q = quickSortBy(input.map(x => ({ ...x })), (a, b) => b.score - a.score).map(x => x.u).join();
const b = rank(input).map(x => x.u).join();
if (b !== 'u2,u1,u3') throw new Error('builtin ' + b);
if (q.indexOf('u3') > q.indexOf('u1')) throw new Error('legacy should be unstable here: ' + q);
console.log('ok i16', q);
