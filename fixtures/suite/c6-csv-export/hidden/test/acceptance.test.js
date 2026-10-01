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
function decodeCSV(text) {
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++) {const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;}else if(c==='"'){quoted=true;}else if(c===','){row.push(field);field='';}else if(c==='\r'&&text[i+1]==='\n'){row.push(field);rows.push(row);row=[];field='';i++;}else {assert.notEqual(c,'\n','bare record LF');field+=c;}}
 assert.equal(quoted,false);assert.equal(field,'');assert.equal(row.length,0);return rows;
}
test('CSV export round trips commas, quotes, CR and LF with the required header', async () => {
 const sources=['a,comma','b"quote','c\nline','d\rreturn','e\r\nboth','plain'];
 const text=sources.map((s,i)=>event('2026-01-01T00:15:00Z',i%2?'ERROR':'INFO',s)).join('\n');
 for(const argv of [['input','--csv','output.csv'],['--csv','output.csv','input']]) {
  let csv;const result=await run(argv,text,{writeFile:async(path,data)=>{assert.equal(path,'output.csv');csv=data;}});
  assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/Total: 6/);assert.match(result.stdout,/Errors: 3/);
  const rows=decodeCSV(csv);assert.deepEqual(rows[0],['hour','source','count','errors']);assert.deepEqual(rows.slice(1),sources.map((s,i)=>['2026-01-01T00:00:00Z',s,'1',String(i%2)]));
  assert.match(csv, /"b""quote"/);assert.match(csv,/"a,comma"/);assert.ok(csv.endsWith('\r\n'));
 }
});
test('empty exports, usage and write failures', async () => {
 let csv;assert.equal((await run(['input','--csv','out'],'',{writeFile:async(_,s)=>csv=s})).code,0);assert.equal(csv,'hour,source,count,errors\r\n');
 const bad=await run(['input','--csv'],'');assert.equal(bad.code,2);assert.equal(bad.reads.length,0);assert.match(bad.stderr,/csv|value|file/i);
 const failure=await run(['input','--csv','out'],'',{writeFile:async()=>{throw new Error('disk full');}});assert.equal(failure.code,1);assert.match(failure.stderr,/disk full/);
 assert.match((await run(['--help'],'')).stdout,/--csv/);
});
test('executable creates an actual export file', async () => {
 const dir=await mkdtemp(join(tmpdir(),'logtool-csv-'));try{const input=join(dir,'input'),output=join(dir,'report.csv');await writeFile(input,event('2026-01-01T00:00:00Z','ERROR','api'));const child=spawnSync(process.execPath,['src/cli.js',input,'--csv',output],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.deepEqual(decodeCSV(await readFile(output,'utf8')),[['hour','source','count','errors'],['2026-01-01T00:00:00Z','api','1','1']]);}finally{await rm(dir,{recursive:true,force:true});}
});
