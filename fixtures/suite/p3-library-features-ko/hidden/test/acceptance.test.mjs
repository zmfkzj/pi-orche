import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize,union,subtract,intersect } from '../src/interval/index.mjs';
import { nextRun } from '../src/cron/index.mjs';
import { merge3 } from '../src/merge/index.mjs';
const conflict=(a,b,c)=>'<<<<<<< OURS\n'+a+'||||||| BASE\n'+b+'=======\n'+c+'>>>>>>> THEIRS\n';
test('interval: normalize merges touching and overlapping, ignores empty, sorts',()=>{
 assert.deepEqual(normalize([[4,6],[-0,2],[2,4],[9,9],[1,3]]),[[0,6]]);
 assert.deepEqual(union([[5,8]],[[1,2],[2,5]]),[[1,8]]);
});
test('interval: subtraction splits across multiple cuts and half-open endpoints',()=>{
 assert.deepEqual(subtract([[0,10],[20,30]],[[1,3],[5,8],[9,25]]),[[0,1],[3,5],[8,9],[25,30]]);
 assert.deepEqual(subtract([[1,2]],[[2,3]]),[[1,2]]);
 assert.deepEqual(subtract([[1,2]],[[0,9]]),[]);
});
test('interval: intersection handles disjoint, touching and fractional spans',()=>{
 assert.deepEqual(intersect([[-2,2],[4,8]],[[0.5,5],[7,9]]),[[0.5,2],[4,5],[7,8]]);
 assert.deepEqual(intersect([[1,2]],[[2,3]]),[]);assert.deepEqual(intersect([],[[2,3]]),[]);
});
test('interval: detached inputs and output',()=>{
 const a=Object.freeze([Object.freeze([3,5]),Object.freeze([1,2])]);const b=Object.freeze([Object.freeze([2,3])]);
 const out=union(a,b);out[0][0]=99;assert.deepEqual(a,[[3,5],[1,2]]);assert.deepEqual(union(a,b),[[1,5]]);
});
test('interval: precise input validation for every operation',()=>{
 for(const bad of [null,{},[[2,1]],[[0,Infinity]],[[NaN,1]],[[0,'1']],[[0,1,2]],[0,1]]) {
   assert.throws(()=>normalize(bad),{code:'INTERVAL_INPUT'});
   for(const fn of [union,subtract,intersect]) {assert.throws(()=>fn([],bad),{code:'INTERVAL_INPUT'});assert.throws(()=>fn(bad,[]),{code:'INTERVAL_INPUT'});}
 }
});
function run(expr,at) {let calls=0;const result=nextRun(expr,{now:()=>{calls++;return Date.parse(at);}});assert.equal(calls,1);return result?.toISOString() ?? null;}
test('cron: strictly next minute, injected once, UTC-only',()=>{
 assert.equal(run('* * * * *','2024-03-10T01:59:00Z'),'2024-03-10T02:00:00.000Z');
 assert.equal(run('* * * * *','2024-01-01T00:00:59.999Z'),'2024-01-01T00:01:00.000Z');
});
test('cron: lists, ranges, wildcard steps and numeric start steps',()=>{
 assert.equal(run('5,10-20/5 1-3/2 * * *','2024-01-01T01:10:00Z'),'2024-01-01T01:15:00.000Z');
 assert.equal(run('7/20 */2 * * *','2024-01-01T00:47:00Z'),'2024-01-01T02:07:00.000Z');
 assert.equal(run('00 00 * * 7','2024-01-05T00:00:00Z'),'2024-01-07T00:00:00.000Z');
});
test('cron: DOM DOW OR with literal wildcard distinction',()=>{
 assert.equal(run('0 0 13 * 1','2024-02-12T00:00:00Z'),'2024-02-13T00:00:00.000Z');
 assert.equal(run('0 0 13 * 1','2024-02-13T00:00:00Z'),'2024-02-19T00:00:00.000Z');
 assert.equal(run('0 0 * * 1','2024-02-13T00:00:00Z'),'2024-02-19T00:00:00.000Z');
 assert.equal(run('0 0 */1 * 1','2024-02-13T00:00:00Z'),'2024-02-14T00:00:00.000Z');
});
test('cron: leap years, month AND, impossible dates return null',()=>{
 assert.equal(run('0 0 29 2 *','2023-03-01T00:00:00Z'),'2024-02-29T00:00:00.000Z');
 assert.equal(run('0 0 31 4 *','2024-01-01T00:00:00Z'),null);
 assert.equal(run('0 0 * 12 1','2024-11-30T00:00:00Z'),'2024-12-02T00:00:00.000Z');
});
test('cron: malformed expression fails before reading clock',()=>{
 for(const expr of ['* * * *','* * * * * *','60 * * * *','*/0 * * * *','1,,2 * * * *','9-2 * * * *','0 24 * * *','0 0 0 * *','0 0 * 13 *','0 0 * * 8','0 0 * JAN *','@daily','-1 * * * *','1/ * * * *']) {
  let called=0;assert.throws(()=>nextRun(expr,{now:()=>{called++;return 0;}}),{code:'CRON_EXPRESSION'});assert.equal(called,0);
 }
});
test('cron: invalid clocks have exact code',()=>{
 assert.throws(()=>nextRun('* * * * *'),{code:'CRON_CLOCK'});
 for(const value of [-1,NaN,1.5,'0',8640000000000000]) assert.throws(()=>nextRun('* * * * *',{now:()=>value}),{code:'CRON_CLOCK'});
});
test('merge: clean fast paths preserve exact text and final LF',()=>{
 assert.deepEqual(merge3('a\n','a\n','b'),{text:'b',conflicts:0});
 assert.deepEqual(merge3('a','x\r\n','a'),{text:'x\r\n',conflicts:0});
 assert.deepEqual(merge3('a','z','z'),{text:'z',conflicts:0});
 assert.deepEqual(merge3('','',''),{text:'',conflicts:0});
});
test('merge: disjoint and adjacent changes merge without markers',()=>{
 assert.deepEqual(merge3('a\nb\nc\n','A\nb\nc\n','a\nb\nC\n'),{text:'A\nb\nC\n',conflicts:0});
 assert.deepEqual(merge3('a\nb\n','A\nb\n','a\nB\n'),{text:'A\nB\n',conflicts:0});
 assert.deepEqual(merge3('a\nb\nc\n','a\nc\n','a\nb\nC\n'),{text:'a\nC\n',conflicts:0});
});
test('merge: same-position inserts conflict or coalesce',()=>{
 assert.deepEqual(merge3('a\n','x\na\n','y\na\n'),{text:conflict('x\n','','y\n')+'a\n',conflicts:1});
 assert.deepEqual(merge3('a\nb\n','x\na\nb\n','x\na\nB\n'),{text:'x\na\nB\n',conflicts:0});
});
test('merge: deletion versus replacement includes base and empty side',()=>{
 assert.deepEqual(merge3('a\nb\nc\n','a\nc\n','a\nB\nc\n'),{text:'a\n'+conflict('','b\n','B\n')+'c\n',conflicts:1});
});
test('merge: separate conflicts counted separately and final LF markers',()=>{
 assert.deepEqual(merge3('a\nb\nc','A\nb\nC','X\nb\nZ'),{text:conflict('A\n','a\n','X\n')+'b\n'+conflict('C\n','c\n','Z\n'),conflicts:2});
});
test('merge: boundary insert is independent; internal insert conflicts',()=>{
 assert.deepEqual(merge3('a\nb\nc\n','a\nx\nb\nc\n','a\nB\nc\n'),{text:'a\nx\nB\nc\n',conflicts:0});
 assert.deepEqual(merge3('a\nb\nc\nd\n','a\nb\nx\nc\nd\n','a\nZ\nd\n'),{text:'a\n'+conflict('b\nx\nc\n','b\nc\n','Z\n')+'d\n',conflicts:1});
});
test('merge: repeated-line LCS tie and CR bytes are deterministic',()=>{
 assert.deepEqual(merge3('a\na\nb\n','a\nb\n','a\na\nB\n'),{text:'a\nB\n',conflicts:0});
 assert.deepEqual(merge3('a\r\nb\r\n','A\r\nb\r\n','a\r\nB\r\n'),{text:'A\r\nB\r\n',conflicts:0});
});
test('merge: strict string validation even on equal inputs',()=>{
 for(const args of [[null,'a','a'],['a',3,'a'],['a','a',[]],[null,null,null]]) assert.throws(()=>merge3(...args),{code:'MERGE_INPUT'});
});

test('interval: sparse endpoints are not finite numbers', () => {
  assert.throws(()=>normalize([new Array(2)]),{code:'INTERVAL_INPUT'});
});
test('cron: year rollover, duplicated weekday values and DOM-only rule', () => {
  assert.equal(run('0 0 1 1 *','2024-01-01T00:00:00Z'),'2025-01-01T00:00:00.000Z');
  assert.equal(run('0 0 * * 0,7','2024-01-07T00:00:00Z'),'2024-01-14T00:00:00.000Z');
});
test('merge: connected overlap groups span multiple edits', () => {
  assert.deepEqual(merge3('a\nb\nc\nd\ne\n','A\nb\nC\nd\ne\n','Z\nd\ne\n'), {
    text:conflict('A\nb\nC\n','a\nb\nc\n','Z\n')+'d\ne\n',conflicts:1,
  });
});
test('merge: large unchanged-side fast path needs no diff matrix', () => {
  const base='unchanged\n'.repeat(12000), theirs=base+'new\n';
  assert.deepEqual(merge3(base,base,theirs),{text:theirs,conflicts:0});
});
