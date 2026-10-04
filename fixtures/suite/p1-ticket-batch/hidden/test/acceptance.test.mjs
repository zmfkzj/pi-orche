import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv/index.mjs';
import { createLimiter } from '../src/ratelimit/index.mjs';
import { createCache } from '../src/cache/index.mjs';
import { satisfies } from '../src/semver/index.mjs';
const gate = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
test('csv: quoted newlines and escaped quotes preserve bytes', () => {
  assert.deepEqual(parseCsv('a,"b\r\nc\nd\re","say ""hi"""\r\n'), [['a','b\r\nc\nd\re','say "hi"']]);
});
test('csv: empty fields, blank rows, BOM and final terminators', () => {
  assert.deepEqual(parseCsv('\uFEFF,a,\r\n\r\nx,'), [['','a',''],[''],['x','']]);
  assert.deepEqual(parseCsv(''), []); assert.deepEqual(parseCsv('\uFEFF'), []);
  assert.deepEqual(parseCsv('\n'), [['']]); assert.deepEqual(parseCsv('a\n'), [['a']]);
  assert.deepEqual(parseCsv('""'), [['']]);
});
test('csv: custom delimiter and whitespace are literal', () => {
  assert.deepEqual(parseCsv(' a ;"b;c"; ',{delimiter:';'}), [[' a ','b;c',' ']]);
  assert.deepEqual(parseCsv('a\n b,c'), [['a'],[' b','c']]);
});
test('csv: malformed quoting and lone CR have exact codes', () => {
  for(const text of ['a"b','"x','"a"x','"a" ']) assert.throws(()=>parseCsv(text),{code:'CSV_QUOTE'});
  assert.throws(()=>parseCsv('a\rb'),{code:'CSV_NEWLINE'});
});
test('csv: input and delimiter validation', () => {
  for(const x of [null, 2, []]) assert.throws(()=>parseCsv(x),{code:'CSV_INPUT'});
  for(const delimiter of ['', 'ab', '"', '\r','\n', 2]) assert.throws(()=>parseCsv('a',{delimiter}),{code:'CSV_DELIMITER'});
});
test('ratelimit: capacity includes burst; rejects do not consume', () => {
  let t=0; const l=createLimiter({limit:2,burst:2,windowMs:100,now:()=>t});
  assert.deepEqual(l.take('a',3),{allowed:true,remaining:1,retryAfterMs:0});
  assert.deepEqual(l.take('a',2),{allowed:false,remaining:1,retryAfterMs:100});
  assert.equal(l.take('a').allowed,true); assert.equal(l.take('b',4).allowed,true);
});
test('ratelimit: weighted retry waits for enough expirations', () => {
  let t=0; const l=createLimiter({limit:5,windowMs:100,now:()=>t});
  l.take('a',2); t=20;l.take('a',3);t=50;
  assert.deepEqual(l.take('a',4),{allowed:false,remaining:0,retryAfterMs:70});
  t=100;assert.deepEqual(l.take('a',2),{allowed:true,remaining:0,retryAfterMs:0});
  t=120;assert.equal(l.take('a',3).allowed,true);
});
test('ratelimit: reset is scoped and does not reset clock', () => {
  let t=10,calls=0;const l=createLimiter({limit:1,windowMs:10,now:()=>{calls++;return t;}});
  l.take('a');l.take('b');l.reset('a');assert.equal(calls,2);
  assert.equal(l.take('a').allowed,true);assert.equal(l.take('b').allowed,false);
  t=9;l.reset('a');assert.throws(()=>l.take('a'),{code:'CLOCK_INVALID'});
});
test('ratelimit: invalid config/input/clock', () => {
  for(const patch of [{limit:0},{burst:-1},{windowMs:1.5},{now:0},{limit:Number.MAX_SAFE_INTEGER,burst:1}]) assert.throws(()=>createLimiter({limit:2,windowMs:10,now:()=>0,...patch}),{code:'LIMIT_CONFIG'});
  let calls=0;const l=createLimiter({limit:2,windowMs:10,now:()=>{calls++;return NaN;}});
  for(const [key,cost] of [['',1],['a',0],['a',3],['a',1.5]]) assert.throws(()=>l.take(key,cost),{code:'LIMIT_INPUT'});
  assert.equal(calls,0);assert.throws(()=>l.take('a'),{code:'CLOCK_INVALID'});
});
test('cache: size accounting, LRU and oversized replacement', () => {
  const c=createCache({maxSize:5,ttlMs:20,now:()=>0,sizeOf:v=>v.n});
  c.set('a',{n:2});c.set('b',{n:3});c.get('a');c.set('c',{n:2});
  assert.equal(c.get('b'),undefined);assert.deepEqual(c.snapshot(),{count:2,size:4});
  c.set('a',{n:6});assert.equal(c.get('a'),undefined);assert.deepEqual(c.snapshot(),{count:1,size:2});
});
test('cache: detached values and invalid size are atomic', () => {
  const c=createCache({maxSize:10,ttlMs:10,now:()=>0,sizeOf:v=>v.n});const v={n:2,x:[1]};
  c.set('a',v);v.x[0]=9;const got=c.get('a');got.x[0]=8;assert.deepEqual(c.get('a').x,[1]);
  assert.throws(()=>c.set('a',{n:0}),{code:'CACHE_SIZE'});assert.equal(c.get('a').n,2);
});
test('cache: stale and hard expiry boundaries with coalesced refresh', async () => {
  let t=0,calls=0;const g=gate();const c=createCache({maxSize:5,ttlMs:10,staleMs:10,now:()=>t});
  c.set('a',{n:1});t=10;assert.equal(c.get('a'),undefined);
  const loader=()=>{calls++;return g.promise;};
  assert.deepEqual(await c.getOrLoad('a',loader),{n:1});assert.deepEqual(await c.getOrLoad('a',loader),{n:1});
  assert.equal(calls,1);t=20;assert.deepEqual(c.snapshot(),{count:0,size:0});
  const waiting=c.getOrLoad('a',loader);g.resolve({n:2});assert.deepEqual(await waiting,{n:2});
  t=29;assert.equal(c.get('a').n,2);t=30;assert.equal(c.get('a'),undefined);
});
test('cache: cold coalescing, independent keys and retry after errors', async () => {
  const c=createCache({maxSize:5,ttlMs:10,now:()=>0});let calls=0;const g=gate();
  const loader=()=>{calls++;return g.promise;};const a=c.getOrLoad('a',loader),b=c.getOrLoad('a',loader);
  assert.equal(await c.getOrLoad('b',async()=>3),3);g.resolve({x:1});const [x,y]=await Promise.all([a,b]);
  x.x=8;assert.equal(y.x,1);assert.equal(calls,1);
  await assert.rejects(c.getOrLoad('z',async()=>{throw Error('bad');}),/bad/);
  assert.equal(await c.getOrLoad('z',async()=>7),7);
});
test('cache: failed background load keeps stale value and can retry', async () => {
  let t=0,calls=0;const c=createCache({maxSize:3,ttlMs:1,staleMs:5,now:()=>t});c.set('a',1);t=1;
  const loader=async()=>{calls++;throw Error('offline');};
  assert.equal(await c.getOrLoad('a',loader),1);await flush();
  assert.equal(await c.getOrLoad('a',loader),1);await flush();assert.equal(calls,2);
  t=6;assert.deepEqual(c.snapshot(),{count:0,size:0});
});
test('cache: set/delete/clear fence pending installation', async () => {
  for(const operation of ['set','delete','clear']) {
    const c=createCache({maxSize:3,ttlMs:10,now:()=>0});const g=gate();const p=c.getOrLoad('a',()=>g.promise);await flush();
    if(operation==='set')c.set('a',9);else if(operation==='delete')c.delete('a');else c.clear();
    g.resolve(1);assert.equal(await p,1);assert.equal(c.get('a'),operation==='set'?9:undefined);
  }
});
test('cache: config, keys, clock and zero TTL', async () => {
  for(const patch of [{maxSize:0},{ttlMs:-1},{staleMs:0.5},{now:1},{sizeOf:3}]) assert.throws(()=>createCache({maxSize:3,ttlMs:10,now:()=>0,...patch}),{code:'CACHE_CONFIG'});
  let t=1;const c=createCache({maxSize:3,ttlMs:0,now:()=>t});c.set('a',1);assert.equal(c.get('a'),undefined);
  assert.throws(()=>c.get(''),{code:'CACHE_INPUT'});await assert.rejects(c.getOrLoad('a',null),{code:'CACHE_INPUT'});
  t=0;assert.throws(()=>c.snapshot(),{code:'CLOCK_INVALID'});
});
test('semver: caret zero-major and partial bounds', () => {
  for(const [v,r,want] of [['1.9.0','^1.2.3',true],['2.0.0','^1.2.3',false],['0.2.9','^0.2.3',true],['0.3.0','^0.2.3',false],['0.0.4','^0.0.3',false],['0.0.9','^0.0',true],['0.1.0','^0.0',false],['0.9.0','^0',true],['1.0.0','^0',false]]) assert.equal(satisfies(v,r),want,`${v} ${r}`);
});
test('semver: tilde, suffix wildcards and partial equality', () => {
  for(const [v,r,want] of [['1.9.0','~1',true],['1.3.0','~1.2',false],['1.2.9','~1.2.3',true],['1.2.9','=1.2',true],['2.0.0','1.X',false],['3.1.0','*',true],['1.2.3','1.2.x',true],['1.2.3','^*',true],['1.2.3','~*',true]]) assert.equal(satisfies(v,r),want);
});
test('semver: hyphen bounds, comparator intersections and unions', () => {
  for(const [v,r,want] of [['2.3.9','1.2 - 2.3',true],['2.4.0','1.2 - 2.3',false],['2.3.4','1.0.0 - 2.3.4',true],['2.3.5','1.0.0 - 2.3.4',false],['1.5.0','>=1.0.0 <2.0.0 || 3.x',true],['3.2.0','>=1.0.0 <2.0.0 || 3.x',true],['4.0.0','* - 3',false],['9.0.0','1 - *',true]]) assert.equal(satisfies(v,r),want);
});
test('semver: prerelease ordering and clause-scoped admission', () => {
  for(const [v,r,want] of [['1.2.3-beta.2','>=1.2.3-beta.1 <2.0.0',true],['1.2.3-beta.10','>1.2.3-beta.2',true],['1.2.3-1','<1.2.3-a',true],['1.2.3-a','>1.2.3-a.1',false],['1.2.4-beta','>=1.2.3-beta <2.0.0',false],['1.2.3-beta','*',false],['1.2.3-beta','<1.0.0-rc || >=1.2.3',false],['1.2.3+build.001','1.2.3',true]]) assert.equal(satisfies(v,r),want,`${v} ${r}`);
});
test('semver: invalid versions and ranges reject with exact codes', () => {
  for(const v of ['1.2','01.2.3','1.2.3-01','1.2.3-a..b','1.2.3+','v1.2.3']) assert.throws(()=>satisfies(v,'*'),{code:'SEMVER_VERSION'});
  for(const r of ['', '1 ||','1 || nope','1.02','1.x.2','>=1.2','(1.2.3)','1,2','1.2-beta','1.2.3 || nope']) assert.throws(()=>satisfies('1.2.3',r),{code:'SEMVER_RANGE'});
});

test('csv: only the first leading BOM is removed and quoted separators stay data', () => {
  assert.deepEqual(parseCsv('\uFEFF\uFEFFa,";",\uFEFF'), [['\uFEFFa',';','\uFEFF']]);
  assert.deepEqual(parseCsv('"a;b";;',{delimiter:';'}), [['a;b','','']]);
});
test('ratelimit: default burst and exact single-event boundary', () => {
  let t=0;const l=createLimiter({limit:1,windowMs:10,now:()=>t});l.take('x');
  t=9;assert.deepEqual(l.take('x'),{allowed:false,remaining:0,retryAfterMs:1});
  t=10;assert.deepEqual(l.take('x'),{allowed:true,remaining:0,retryAfterMs:0});
  assert.throws(()=>l.reset(''),{code:'LIMIT_INPUT'});
});
test('cache: stale get does not promote but stale getOrLoad does', async () => {
  let t=0;const c=createCache({maxSize:2,ttlMs:2,staleMs:20,now:()=>t});
  c.set('a',1);c.set('b',2);t=2;c.get('a');c.set('c',3);
  assert.deepEqual(c.snapshot(),{count:2,size:2});assert.equal(c.delete('a'),false);
  const g=gate();assert.equal(await c.getOrLoad('b',()=>g.promise),2);c.set('d',4);
  assert.equal(c.delete('c'),false);assert.equal(c.delete('b'),true);g.resolve(9);await flush();
  assert.equal(c.get('b'),undefined);
});
test('cache: invalid sizes do not overwrite and public operations purge', () => {
  let t=0;const c=createCache({maxSize:5,ttlMs:5,now:()=>t,sizeOf:v=>v.size});
  c.set('a',{size:2});for(const size of [-1,1.5,Infinity,NaN]) {
    assert.throws(()=>c.set('a',{size}),{code:'CACHE_SIZE'});
    assert.equal(c.get('a').size,2);
  }
  t=5;assert.equal(c.delete('a'),false);assert.deepEqual(c.snapshot(),{count:0,size:0});
});
test('cache: fenced old completion cannot displace a new load', async () => {
  const c=createCache({maxSize:2,ttlMs:10,now:()=>0});const old=gate(),fresh=gate();
  const a=c.getOrLoad('x',()=>old.promise);await flush();c.clear();
  const b=c.getOrLoad('x',()=>fresh.promise);await flush();fresh.resolve({v:2});
  assert.deepEqual(await b,{v:2});old.resolve({v:1});assert.deepEqual(await a,{v:1});
  assert.deepEqual(c.get('x'),{v:2});
});
test('semver: lexical/prefix prerelease order and ignored build metadata', () => {
  for(const [v,r,want] of [
    ['1.0.0-alpha','<1.0.0-alpha.1',true],
    ['1.0.0-beta','>1.0.0-alpha',true],
    ['1.0.0','>1.0.0-rc',true],
    ['1.0.0-10','>1.0.0-2',true],
    ['1.0.0+001.a','>=1.0.0 <=1.0.0',true],
  ]) assert.equal(satisfies(v,r),want);
  assert.throws(()=>satisfies('1.0.0','1.0.0+a..b'),{code:'SEMVER_RANGE'});
});
