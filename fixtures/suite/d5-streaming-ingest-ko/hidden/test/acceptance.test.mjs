import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readEvents,aggregate} from '../src/index.mjs';
const event=(tenant='a',kind='x',duration='2',at=1)=>({tenant,kind,duration,at});
const collect=async iterable=>{const rows=[];for await(const row of iterable)rows.push(row);return rows;};
const chunks=text=>[Buffer.from(text)];

test('all byte splits preserve UTF-8 and CRLF including final unterminated row',async()=>{
 const row=event('한국','종류'),bytes=Buffer.from(JSON.stringify(row)+'\r\n\n'+JSON.stringify({...row,at:2}));
 for(let split=1;split<bytes.length;split++){
  assert.deepEqual(await collect(readEvents([bytes.subarray(0,split),bytes.subarray(split)])),[row,{...row,at:2}]);
 }
 assert.deepEqual(await collect(readEvents([...bytes].map(byte=>Buffer.from([byte])))),[row,{...row,at:2}]);
});
test('physical line diagnostics distinguish JSON and field errors',async()=>{
 const errors=[];
 const rows=await collect(readEvents(chunks('\nnot json\r\n'+JSON.stringify({...event(),duration:2})+'\n'+JSON.stringify(event())),{onError:e=>errors.push(e)}));
 assert.deepEqual(rows,[event()]);
 assert.deepEqual(errors,[{line:2,code:'INVALID_JSON'},{line:3,code:'INVALID_EVENT'}]);
});
test('oversize rows recover once and byte rather than character limits apply',async()=>{
 const good=JSON.stringify(event()),tooLong='한'.repeat(100),errors=[];
 const bytes=Buffer.from(tooLong+'\n'+good),parts=[...bytes].map(b=>Buffer.from([b]));
 assert.deepEqual(await collect(readEvents(parts,{maxLineBytes:Buffer.byteLength(good),onError:e=>errors.push(e)})),[event()]);
 assert.deepEqual(errors,[{line:1,code:'LINE_TOO_LONG'}]);
 assert.deepEqual(await collect(readEvents(chunks(good+'\r\n'),{maxLineBytes:Buffer.byteLength(good)})),[event()]);
});
test('strict errors expose physical line and do not consume later rows',async()=>{
 let later=false;
 async function* input(){yield Buffer.from(JSON.stringify(event())+'\n!\n');later=true;yield Buffer.from(JSON.stringify(event()));}
 await assert.rejects(collect(readEvents(input(),{strict:true})),{code:'INVALID_JSON',line:2});
 assert.equal(later,false);
});
test('validation rejects every invalid field and strips unrelated metadata',async()=>{
 const errors=[],values=[{...event(),tenant:''},{...event(),kind:1},{...event(),duration:'-1'},{...event(),at:1.5},{...event(),duration:'1e3'}];
 const rows=await collect(readEvents(chunks(values.map(JSON.stringify).join('\n')+'\n'+JSON.stringify({...event(),secret:'discard'})),{onError:e=>{errors.push(e);throw Error('observer');}}));
 assert.equal(errors.length,5);assert.deepEqual(rows,[event()]);
});
test('aggregation is exact ordered and tuple scoped',async()=>{
 const values=[event('z','x','9007199254740993',9),event('a:b','c','2',8),event('a','b:c','4',3),event('z','x','9007199254740993',1)];
 assert.deepEqual(await aggregate(values),[
 {tenant:'a',kind:'b:c',count:1,sumDuration:'4',maxDuration:'4',firstAt:3,lastAt:3},
 {tenant:'a:b',kind:'c',count:1,sumDuration:'2',maxDuration:'2',firstAt:8,lastAt:8},
 {tenant:'z',kind:'x',count:2,sumDuration:'18014398509481986',maxDuration:'9007199254740993',firstAt:1,lastAt:9}]);
});
test('CLI strict is atomic while tolerant emits diagnostics and aggregates',()=>{
 const input=JSON.stringify(event())+'\n!\n'+JSON.stringify(event());
 const strict=spawnSync(process.execPath,['src/cli.mjs','--strict'],{input,encoding:'utf8'});
 assert.equal(strict.status,1);assert.equal(strict.stdout,'');assert.deepEqual(JSON.parse(strict.stderr.trim()),{line:2,code:'INVALID_JSON'});
 const tolerant=spawnSync(process.execPath,['src/cli.mjs'],{input,encoding:'utf8'});
 assert.equal(tolerant.status,0);assert.equal(JSON.parse(tolerant.stdout)[0].count,2);
});
test('CLI rejects unknown and invalid limit options',()=>{
 for(const args of [['--oops'],['--max-line-bytes','0'],['--max-line-bytes']])
  assert.equal(spawnSync(process.execPath,['src/cli.mjs',...args],{input:'',encoding:'utf8'}).status,2);
});
