import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../src/cli.js';
test('export quotes source names and retains summary',async()=>{
 let csv,summary='';const line=JSON.stringify({timestamp:'2026-01-01T00:00:00Z',level:'ERROR',source:'a,"b"',message:'ok'});
 assert.equal(await main(['input','--csv','out'],{readFile:async()=>line,writeFile:async(_,text)=>csv=text,stdout:text=>summary+=text}),0);
 assert.equal(csv,'hour,source,count,errors\r\n2026-01-01T00:00:00Z,"a,""b""",1,1\r\n');assert.match(summary,/Errors: 1/);
});
