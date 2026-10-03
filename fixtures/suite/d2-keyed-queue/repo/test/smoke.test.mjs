import test from 'node:test';import assert from 'node:assert/strict';import {createService} from '../src/index.mjs';
test('service saves one record',async()=>{const rows=[];const service=createService(async row=>rows.push(row));await service.save({tenant:'t',account:'a'});await service.flush();assert.equal(rows.length,1);});
