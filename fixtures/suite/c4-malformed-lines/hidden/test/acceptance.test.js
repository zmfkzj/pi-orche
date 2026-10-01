import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { parseLogs, parseLine } from '../src/parser.js';
import { aggregate } from '../src/aggregate.js';
const event = (timestamp, level='INFO', source='api', message='ok') => JSON.stringify({timestamp,level,source,message});
async function run(argv, text, extra={}) {
  let stdout='', stderr='';
  const reads=[];
  const code=await main(argv,{readFile:async path=>{reads.push(path);return text;},stdout:s=>stdout+=s,stderr:s=>stderr+=s,...extra});
  return {code,stdout,stderr,reads};
}
test('invalid physical lines are skipped and blank lines are not counted', async () => {
 const invalid=['{broken','null','[]',JSON.stringify({timestamp:'not-a-date',level:'INFO',source:'api',message:'ok'}),event('2026-01-01T00:00:00Z','NOPE'),JSON.stringify({timestamp:'2026-01-01T00:00:00Z',level:'INFO',source:'api'})];
 for (const line of invalid) assert.throws(() => parseLine(line), 'parseLine must remain strict');
 const text=[event('2026-01-01T00:00:00Z','ERROR'),'',...invalid,'   ',event('2026-01-01T00:30:00Z')].join('\r\n')+'\r\n';
 const result=await run(['input'],text);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/Skipped: 6/);assert.match(result.stdout,/Total: 2/);assert.match(result.stdout,/Errors: 1/);assert.match(result.stdout,/Error rate: 50.00%/);
 const parsed=parseLogs(text);assert.equal(parsed.skipped,6);assert.equal(parsed.records.length,2);
});
test('empty, fully malformed and healthy input all succeed', async () => {
 for(const [text,total,skipped] of [['',0,0],['oops\n{}\n',0,2],[event('2026-01-01T00:00:00Z'),1,0]]) {const result=await run(['input'],text);assert.equal(result.code,0);assert.match(result.stdout,new RegExp('Total: '+total));assert.match(result.stdout,new RegExp('Skipped: '+skipped));}
 const failed=await run(['input'],'',{readFile:async()=>{throw new Error('permission denied');}});assert.equal(failed.code,1);assert.match(failed.stderr,/permission denied/);
});
test('executable continues past malformed lines', async () => {
 const dir=await mkdtemp(join(tmpdir(),'logtool-bad-'));try{const file=join(dir,'input');await writeFile(file,'bad\n'+event('2026-01-01T00:00:00Z'));const child=spawnSync(process.execPath,['src/cli.js',file],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/Skipped: 1/);}finally{await rm(dir,{recursive:true,force:true});}
});
