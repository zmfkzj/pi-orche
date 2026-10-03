import {keyOf} from './keys.mjs';import {copy} from './values.mjs';
export function createCache({clock,ttl}){
 if(typeof clock!=='function'||!Number.isFinite(ttl)||ttl<=0)throw new TypeError('cache options');
 const entries=new Map(),counters={hits:0,misses:0,coalesced:0};
 function get(tenant,id,load){const key=keyOf(tenant,id),entry=entries.get(key);if(entry?.promise){counters.coalesced++;return entry.promise.then(copy);}if(entry&&entry.expires>clock()){counters.hits++;return Promise.resolve(copy(entry.value));}counters.misses++;const current={tenant};entries.set(key,current);current.promise=Promise.resolve().then(load).then(value=>{const snapshot=copy(value);if(entries.get(key)===current)entries.set(key,{tenant,value:snapshot,expires:clock()+ttl});return snapshot;},error=>{if(entries.get(key)===current)entries.delete(key);throw error;});return current.promise.then(copy);}
 return {get,invalidate:(tenant,id)=>entries.delete(keyOf(tenant,id)),clearTenant:tenant=>{for(const [key,value] of entries)if(value.tenant===tenant)entries.delete(key);},stats:()=>({...counters})};
}
