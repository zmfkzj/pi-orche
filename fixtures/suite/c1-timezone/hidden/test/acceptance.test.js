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
test('UTC hour grouping is host-independent across offsets and date boundaries', async () => {
 const dir=await mkdtemp(join(tmpdir(),'logtool-tz-'));
 try {
  const file=join(dir,'input.jsonl');
  await writeFile(file,[event('2026-01-01T00:15:00+09:00','ERROR'),event('2025-12-31T10:45:00-05:00'),event('2025-12-31T16:10:00Z')].join('\n'));
  for (const TZ of ['Asia/Seoul','America/New_York']) {
   const child=spawnSync(process.execPath,['src/cli.js',file],{encoding:'utf8',env:{...process.env,TZ},timeout:5000});
   assert.equal(child.status,0,child.stderr);
   assert.match(child.stdout,/2025-12-31T15:00:00Z "api" count=2 errors=1/);
   assert.match(child.stdout,/2025-12-31T16:00:00Z "api" count=1 errors=0/);
  }
  const script="import {parseLogs} from './src/parser.js';import {aggregate} from './src/aggregate.js';import {readFileSync} from 'node:fs';console.log(JSON.stringify(aggregate(parseLogs(readFileSync(process.argv[1],'utf8')).records)));";
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',env:{...process.env,TZ:'Pacific/Honolulu'},timeout:5000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).rows.map(r=>[r.hour,r.count]),[['2025-12-31T15:00:00Z',2],['2025-12-31T16:00:00Z',1]]);
 } finally {await rm(dir,{recursive:true,force:true});}
});
