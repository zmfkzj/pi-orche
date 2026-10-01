import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { parseLogs } from '../src/parser.js';
import { aggregate } from '../src/aggregate.js';
const event = (timestamp, level='INFO', source='api', message='ok') => JSON.stringify({timestamp,level,source,message});
async function run(argv, text, extra={}) {
  let stdout='', stderr='';
  const reads=[];
  const code=await main(argv,{readFile:async path=>{reads.push(path);return text;},stdout:s=>stdout+=s,stderr:s=>stderr+=s,...extra});
  return {code,stdout,stderr,reads};
}
test('200k records preserve grouping without repeated growing array scans', {timeout:20000}, () => {
 const script=`
 import assert from 'node:assert/strict';
 import {aggregate} from './src/aggregate.js';
 import {main} from './src/cli.js';
 const records=Array.from({length:200000},(_,i)=>({time:Date.parse(i%2?'2026-01-02T00:30:00Z':'2026-01-01T23:30:00Z'),source:'service-'+String(i%2000).padStart(4,'0'),level:i%5===0?'ERROR':'INFO',message:'ok'}));
 const text=records.map(r=>JSON.stringify({timestamp:new Date(r.time).toISOString(),source:r.source,level:r.level,message:r.message})).join('\\n');
 const original=Array.prototype.find;
 let scanned=0;
 Array.prototype.find=function(...args){scanned+=this.length;if(scanned>2000000)throw new Error('Repeated linear group lookup: '+scanned);return original.apply(this,args);};
 const result=aggregate(records);
 assert.equal(result.total,200000);assert.equal(result.errors,40000);assert.equal(result.rows.length,2000);
 assert.deepEqual(result.rows[0],{hour:'2026-01-01T23:00:00Z',source:'service-0000',count:100,errors:100});
 assert.deepEqual(result.rows.at(-1),{hour:'2026-01-02T00:00:00Z',source:'service-1999',count:100,errors:0});
 let output='';const code=await main(['input'],{readFile:async()=>text,stdout:s=>output+=s,stderr:s=>{throw new Error(s);}});
 assert.equal(code,0);assert.match(output,/Total: 200000/);assert.match(output,/Errors: 40000/);
 console.log('processed 200000 records');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 assert.equal(child.status,0,child.error?.message ?? child.stderr);assert.match(child.stdout,/processed 200000/);
});
test('aggregation matches independent oracle for mixed hours, Unicode and delimiter-like sources', () => {
 const records=Array.from({length:431},(_,i)=>({time:Date.UTC(2026,0,1,i%7,i%60),level:i%3?'INFO':'ERROR',source:['x|y','x','한글','a\nb',''][i%5],message:'m'}));
 const before=structuredClone(records), groups=new Map();let errors=0;
 for(const r of records){const hour=new Date(r.time).toISOString().slice(0,13)+':00:00Z';const key=JSON.stringify([hour,r.source]);const row=groups.get(key)??{hour,source:r.source,count:0,errors:0};row.count++;if(r.level==='ERROR'){row.errors++;errors++;}groups.set(key,row);}
 const rows=[...groups.values()].sort((a,b)=>a.hour<b.hour?-1:a.hour>b.hour?1:a.source<b.source?-1:a.source>b.source?1:0);
 assert.deepEqual(aggregate(records),{total:431,errors,rows});assert.deepEqual(records,before);assert.deepEqual(aggregate([]),{total:0,errors:0,rows:[]});
});
