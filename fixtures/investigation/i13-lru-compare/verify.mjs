import { MapLru } from './repo/src/lru-map.js';
import { ArrayLru } from './repo/src/lru-array.js';
for (const [C, evicted] of [[MapLru, 'b'], [ArrayLru, 'a']]) {
  const c = new C(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  if (c.has(evicted)) throw new Error(C.name);
}
console.log('ok i13');
