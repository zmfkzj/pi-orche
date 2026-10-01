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
test('since is inclusive and compares instants across offsets', async () => {
 const text=[event('2026-04-01T09:59:59Z','ERROR'),event('2026-04-01T12:00:00+02:00','ERROR'),event('2026-04-01T10:00:01Z')].join('\n');
 for(const argv of [['--since','2026-04-01T10:00:00Z','input'],['input','--since','2026-04-01T05:00:00-05:00']]) {
  const result=await run(argv,text);
  assert.equal(result.code,0,result.stderr);
  assert.match(result.stdout,/Total: 2/);assert.match(result.stdout,/Errors: 1/);assert.match(result.stdout,/Error rate: 50.00%/);
 }
 const unchanged=await run(['input'],text);assert.match(unchanged.stdout,/Total: 3/);
 const empty=await run(['input','--since','2027-01-01T00:00:00Z'],text);assert.match(empty.stdout,/Total: 0/);
});
test('bad since values are usage errors before reading input', async () => {
 for(const argv of [['input','--since'],['--since','oops','input'],['input','--since','2026-01-01'],['input','--since','2026-01-01T12:00:00'],['input','--since','2026-13-01T00:00:00Z']]) {
  const result=await run(argv,'');assert.equal(result.code,2);assert.equal(result.reads.length,0);assert.match(result.stderr,/since|ISO|timestamp/i);
 }
 const help=await run(['--help'],'');assert.match(help.stdout,/--since/);
});
test('since works through executable', async () => {
 const dir=await mkdtemp(join(tmpdir(),'logtool-since-'));
 try {const file=join(dir,'logs');await writeFile(file,event('2026-01-01T00:00:00Z'));const child=spawnSync(process.execPath,['src/cli.js',file,'--since','2026-01-02T00:00:00Z'],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/Total: 0/);} finally {await rm(dir,{recursive:true,force:true});}
});
