import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { handle as users } from '../src/handlers/users.mjs';
import { handle as orders } from '../src/handlers/orders.mjs';
import { handle as inventory } from '../src/handlers/inventory.mjs';
import { handle as search } from '../src/handlers/search.mjs';
import { handle as uploads } from '../src/handlers/uploads-metadata.mjs';
import { handle as reports } from '../src/handlers/reports.mjs';
const headers={'content-type':'application/json'};
function error(r,status,code) { assert.deepEqual(r,{status,body:{error:{code}},headers}); }
function success(r,status,body,extra={}) { assert.deepEqual(r,{status,body,headers:{...headers,...extra}}); }
function bomb(code) { throw Object.assign(Error('SECRET stack database password'),{code}); }
function frozen(value) { for(const v of Object.values(value)) if(v && typeof v==='object') frozen(v); return Object.freeze(value); }
const userBody=()=>({email:' A@B.COM ',displayName:' Ada ',roles:['viewer','editor']});
test('users: normalization, projection, location and immutable input',async()=>{
 let args;const body=frozen(userBody());
 const r=await users({body,services:{users:{findByEmail:async email=>{assert.equal(email,'a@b.com');return null;},create:async data=>{args=data;return {id:'a/b',secret:1};}}}});
 assert.deepEqual(args,{email:'a@b.com',displayName:'Ada',roles:['editor','viewer']});
 success(r,201,{id:'a/b',...args},{location:'/users/a%2Fb'});
});
test('users: default roles and duplicate lookup/race',async()=>{
 const body={email:'a@b.c',displayName:'A'};let called=0;
 error(await users({body,services:{users:{findByEmail:async()=>({id:1}),create:async()=>called++}}}),409,'USER_EXISTS');assert.equal(called,0);
 error(await users({body,services:{users:{findByEmail:async()=>null,create:async()=>bomb('DUPLICATE')}}}),409,'USER_EXISTS');
 const r=await users({body,services:{users:{findByEmail:async()=>null,create:async data=>{assert.deepEqual(data.roles,['viewer']);return {id:'1'};}}}});assert.equal(r.status,201);
});
test('users: strict validation before I/O and sanitized failure',async()=>{
 for(const patch of [{email:'a b@c.d'},{displayName:' '},{roles:[]},{roles:['viewer','viewer']},{roles:['admin']},{extra:1}]) error(await users({body:{...userBody(),...patch},services:{}}),400,'USER_INPUT');
 error(await users({body:userBody(),services:{users:{findByEmail:async()=>bomb()}}}),500,'USER_INTERNAL');
});
const orderBody=()=>({customerId:' c ',items:[{sku:'A',quantity:2},{sku:'B',quantity:1},{sku:'A',quantity:1}],coupon:'SAVE10'});
test('orders: duplicate consolidation, integer discount and projection',async()=>{
 const reads=[];let draft;const r=await orders({body:frozen(orderBody()),services:{catalog:{get:async sku=>{reads.push(sku);return {price:sku==='A'?101:5};}},orders:{create:async d=>{draft=d;return {id:'o',secret:1};}}}});
 assert.deepEqual(reads,['A','B']);assert.deepEqual(draft,{customerId:'c',lines:[{sku:'A',quantity:3,unitPrice:101,total:303},{sku:'B',quantity:1,unitPrice:5,total:5}],subtotal:308,discount:30,total:278});success(r,201,{id:'o',...draft});
});
test('orders: strict nested validation and combined quantity limit',async()=>{
 for(const patch of [{items:[]},{items:[{sku:'a',quantity:1}]},{items:[{sku:'A',quantity:'1'}]},{items:[{sku:'A',quantity:1,extra:1}]},{items:[{sku:'A',quantity:600},{sku:'A',quantity:400}]},{coupon:'OTHER'},{extra:1}]) error(await orders({body:{...orderBody(),...patch},services:{}}),400,'ORDER_INPUT');
});
test('orders: missing SKU, unsafe totals and no create on error',async()=>{
 let creates=0;const services={catalog:{get:async()=>null},orders:{create:async()=>creates++}};
 error(await orders({body:orderBody(),services}),404,'ORDER_SKU');
 services.catalog.get=async()=>({price:Number.MAX_SAFE_INTEGER});error(await orders({body:orderBody(),services}),400,'ORDER_OVERFLOW');
 services.catalog.get=async()=>({price:-1});error(await orders({body:orderBody(),services}),500,'ORDER_INTERNAL');assert.equal(creates,0);
});
test('orders: safe maximum coupon and service exception sanitation',async()=>{
 const body={customerId:'x',items:[{sku:'A',quantity:1}],coupon:'SAVE10'};
 const r=await orders({body,services:{catalog:{get:async()=>({price:Number.MAX_SAFE_INTEGER})},orders:{create:async()=>({id:'x'})}}});assert.equal(r.body.discount,900719925474099);
 error(await orders({body,services:{catalog:{get:async()=>bomb()}}}),500,'ORDER_INTERNAL');
});
const adjustment=()=>({adjustments:[{sku:'A',delta:-2,expectedVersion:0},{sku:'B',delta:1,expectedVersion:2}]});
test('inventory: one atomic call and input-order projection',async()=>{
 let calls=0;const body=frozen(adjustment());const r=await inventory({body,services:{inventory:{apply:async a=>{calls++;assert.deepEqual(a,body.adjustments);return [{sku:'B',quantity:5,version:3,secret:1},{sku:'A',quantity:1,version:1}];}}}});
 assert.equal(calls,1);success(r,200,{items:[{sku:'A',quantity:1,version:1},{sku:'B',quantity:5,version:3}]});
});
test('inventory: validation rejects duplicates, zero delta and extra keys',async()=>{
 for(const adjustments of [[],[{sku:'A',delta:0,expectedVersion:0}],[{sku:'A',delta:1,expectedVersion:'0'}],[{sku:'A',delta:1,expectedVersion:0,extra:1}],[...adjustment().adjustments,adjustment().adjustments[0]]]) error(await inventory({body:{adjustments},services:{}}),400,'INVENTORY_INPUT');
});
test('inventory: service error mapping without details',async()=>{
 for(const [code,status,out] of [['NOT_FOUND',404,'INVENTORY_SKU'],['VERSION',409,'INVENTORY_VERSION'],['UNDERFLOW',409,'INVENTORY_STOCK'],['OTHER',500,'INVENTORY_INTERNAL']]) error(await inventory({body:adjustment(),services:{inventory:{apply:async()=>bomb(code)}}}),status,out);
});
const docs=[{id:'b',title:'Red blue',text:'red blue',secret:1},{id:'A',title:'RED BLUE',text:'red blue'},{id:'c',title:'red',text:'blue'},{id:'c',title:'red blue',text:'red blue'},{id:'d',title:'red',text:'green'}];
test('search: AND literals, unique terms, scores and stable pagination',async()=>{
 const rows=frozen(docs);const r=await search({query:frozen({q:' RED red Blue ',offset:'1',limit:'2'}),services:{search:{scan:async()=>rows}}});
 success(r,200,{items:[{id:'b',title:'Red blue',score:6},{id:'c',title:'red',score:3}],total:3,offset:1,limit:2});
 const literal=await search({query:{q:'.*'},services:{search:{scan:async()=>rows}}});assert.equal(literal.body.total,0);
});
test('search: first duplicate wins before filtering and default page',async()=>{
 const r=await search({query:{q:'red'},services:{search:{scan:async()=>[{id:'a',title:'no',text:'no'},{id:'a',title:'red',text:'red'}]}}});success(r,200,{items:[],total:0,offset:0,limit:20});
});
test('search: canonical pagination and sanitized failures',async()=>{
 for(const patch of [{q:' '},{offset:'01'},{offset:1},{offset:'-1'},{offset:'1000001'},{limit:'0'},{limit:'101'},{limit:' 2'},{extra:1}]) error(await search({query:{q:'red',...patch},services:{}}),400,'SEARCH_INPUT');
 error(await search({query:{q:'red'},services:{search:{scan:async()=>bomb()}}}),500,'SEARCH_INTERNAL');
});
const uploadBody=()=>({name:' Cafe\u0301.pdf ',size:1024,mime:'APPLICATION/PDF',sha256:'AB'.repeat(32),tags:[' Z ','a','A']});
test('uploads-metadata: NFC, digest, tags and safe projection',async()=>{
 let metadata;const r=await uploads({body:frozen(uploadBody()),services:{uploads:{save:async d=>{metadata=d;return {id:'u',secret:1};}}}});
 assert.deepEqual(metadata,{name:'Café.pdf',size:1024,mime:'application/pdf',sha256:'ab'.repeat(32),tags:['a','z']});success(r,201,{id:'u',...metadata});
});
test('uploads-metadata: path, control, size, type and tag validation',async()=>{
 for(const patch of [{name:'../x'},{name:'a\\b'},{name:'..'},{name:'a\u0000b'},{size:0},{size:10485761},{size:'2'},{mime:' image/png'},{sha256:'a'},{tags:[' ']},{tags:Array(11).fill('a')},{extra:1}]) error(await uploads({body:{...uploadBody(),...patch},services:{}}),400,'UPLOAD_INPUT');
});
test('uploads-metadata: optional tags and mapped exceptions',async()=>{
 const body=uploadBody();delete body.tags;
 const r=await uploads({body,services:{uploads:{save:async d=>{assert.deepEqual(d.tags,[]);return {id:'u'};}}}});assert.equal(r.status,201);
 for(const [code,status,out] of [['DUPLICATE',409,'UPLOAD_EXISTS'],['OTHER',500,'UPLOAD_INTERNAL']]) error(await uploads({body,services:{uploads:{save:async()=>bomb(code)}}}),status,out);
});
const reportQuery=()=>({from:'2024-02-28',to:'2024-03-02'});
const ledger=[{id:'1',at:'2024-02-28T00:00:00Z',customerId:'b',status:'paid',amount:3},{id:'2',at:'2024-02-29T23:00:00Z',customerId:'a',status:'paid',amount:5},{id:'2',at:'2024-03-01T00:00:00Z',customerId:'b',status:'paid',amount:99},{id:'3',at:'2024-03-02T00:00:00Z',customerId:'b',status:'paid',amount:10},{id:'4',at:'2024-03-01T00:00:00Z',customerId:'b',status:'void',amount:9},{id:'5',at:'bad',customerId:'b',status:'paid',amount:9}];
test('reports: leap day, half-open dates, dedup and immutable day totals',async()=>{
 const r=await reports({query:frozen(reportQuery()),services:{reports:{list:async q=>{assert.deepEqual(q,reportQuery());return frozen(ledger);}}}});success(r,200,{items:[{key:'2024-02-28',count:1,total:3},{key:'2024-02-29',count:1,total:5}],total:8});
});
test('reports: customer grouping, empty result and first duplicate filter',async()=>{
 const r=await reports({query:{...reportQuery(),groupBy:'customer'},services:{reports:{list:async()=>ledger}}});success(r,200,{items:[{key:'a',count:1,total:5},{key:'b',count:1,total:3}],total:8});
 const rows=[{id:'x',status:'void',at:'2024-02-29T00:00:00Z',amount:1},{id:'x',status:'paid',at:'2024-02-29T00:00:00Z',amount:2}];
 success(await reports({query:reportQuery(),services:{reports:{list:async()=>rows}}}),200,{items:[],total:0});
});
test('reports: real-date validation and bounded interval before I/O',async()=>{
 for(const patch of [{from:'2023-02-29'},{from:'2024-2-28'},{from:'2024-03-02'},{to:'2026-01-01'},{groupBy:'month'},{extra:1}]) error(await reports({query:{...reportQuery(),...patch},services:{}}),400,'REPORT_INPUT');
});
test('reports: overflow, bad included amount and service error',async()=>{
 const row={id:'x',at:'2024-02-29T00:00:00Z',status:'paid',customerId:'a',amount:Number.MAX_SAFE_INTEGER};
 error(await reports({query:reportQuery(),services:{reports:{list:async()=>[row,{...row,id:'y',amount:1}]}}}),500,'REPORT_OVERFLOW');
 error(await reports({query:reportQuery(),services:{reports:{list:async()=>[{...row,amount:-1}]}}}),500,'REPORT_INTERNAL');
 error(await reports({query:reportQuery(),services:{reports:{list:async()=>bomb()}}}),500,'REPORT_INTERNAL');
});

for (const unit of ['users','orders','inventory','search','uploads-metadata','reports']) {
  test(unit + ': router contract remains byte-identical', async () => {
    const bytes = await readFile(new URL('../src/router.mjs', import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), 'f9717eb37052b41c9b4d65eff3a284f2f584d5025eb5ca0d4adcddfd94a89603');
  });
}

test('users: field lengths, object shape and complete validation before lookup', async () => {
  for(const body of [null,[],{}, {...userBody(),email:'a'.repeat(251)+'@b.c'}, {...userBody(),displayName:'x'.repeat(81)}, {...userBody(),roles:'viewer'}]) {
    error(await users({body,services:{}}),400,'USER_INPUT');
  }
});
test('orders: later invalid item prevents all I/O and persisted draft is detached', async () => {
  error(await orders({body:{customerId:'x',items:[{sku:'A',quantity:1},{sku:'B',quantity:0}]},services:{}}),400,'ORDER_INPUT');
  error(await orders({body:{customerId:'x',items:Array(101).fill({sku:'A',quantity:1})},services:{}}),400,'ORDER_INPUT');
  const body=frozen({customerId:'x',items:[{sku:'A',quantity:999}]});
  const r=await orders({body,services:{catalog:{get:async()=>({price:0})},orders:{create:async draft=>{draft.lines[0].quantity=1;return {id:'x',private:1};}}}});
  assert.equal(r.body.lines[0].quantity,999);assert.equal(r.body.discount,0);assert.equal(r.body.total,0);
});
test('inventory: detached batch and strict outer object validation', async () => {
  for(const body of [null,[],{...adjustment(),extra:1}]) error(await inventory({body,services:{}}),400,'INVENTORY_INPUT');
  const body=frozen(adjustment());const r=await inventory({body,services:{inventory:{apply:async batch=>{
    batch[0].delta=99;return [{sku:'A',quantity:0,version:1},{sku:'B',quantity:1,version:3}];
  }}}});assert.equal(r.status,200);assert.equal(body.adjustments[0].delta,-2);
});
test('search: query shape, q length, and beyond-end pagination', async () => {
  for(const query of [null,[],{}, {q:'x'.repeat(201)}]) error(await search({query,services:{}}),400,'SEARCH_INPUT');
  success(await search({query:{q:'red',offset:'1000000',limit:'100'},services:{search:{scan:async()=>docs}}}),200,{items:[],total:4,offset:1000000,limit:100});
});
test('uploads-metadata: length boundaries and detached service argument', async () => {
  for(const patch of [{name:'a'.repeat(129)},{name:'a\u007fb'},{tags:[2]},{tags:['x'.repeat(21)]}]) error(await uploads({body:{...uploadBody(),...patch},services:{}}),400,'UPLOAD_INPUT');
  const body=frozen({...uploadBody(),size:10485760});
  const r=await uploads({body,services:{uploads:{save:async metadata=>{metadata.tags.push('private');return {id:'u'};}}}});
  assert.deepEqual(r.body.tags,['a','z']);assert.equal(r.body.size,10485760);
});
test('reports: filtered bad amounts ignored and maximum interval accepted', async () => {
  const row={id:'1',at:'2024-01-01T00:00:00Z',status:'void',customerId:'a',amount:-1};
  success(await reports({query:{from:'2024-01-01',to:'2025-01-01'},services:{reports:{list:async()=>[row]}}}),200,{items:[],total:0});
  for(const query of [null,[],{}, {from:'2024-04-31',to:'2024-05-02'}]) error(await reports({query,services:{}}),400,'REPORT_INPUT');
});
