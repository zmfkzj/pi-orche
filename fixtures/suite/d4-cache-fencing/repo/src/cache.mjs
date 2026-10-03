import {keyOf} from './keys.mjs';
export function createCache({clock,ttl}){
 const entries=new Map(),counters={hits:0,misses:0,coalesced:0};
 function get(tenant,id,load){const key=keyOf(tenant,id),entry=entries.get(key);if(entry?.promise){counters.coalesced++;return entry.promise;}if(entry&&entry.expires>clock()){counters.hits++;return Promise.resolve(entry.value);}counters.misses++;const started=clock();const promise=Promise.resolve().then(load).then(value=>{entries.set(key,{tenant,value,expires:started+ttl});return value;},error=>{entries.delete(key);throw error;});entries.set(key,{tenant,promise});return promise;}
 return {get,invalidate:(tenant,id)=>entries.delete(keyOf(tenant,id)),clearTenant:tenant=>{for(const [key,value] of entries)if(value.tenant===tenant)entries.delete(key);},stats:()=>({...counters})};
}
