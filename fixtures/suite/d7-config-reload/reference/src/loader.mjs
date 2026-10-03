import {resolve,dirname} from 'node:path';import {DEFAULTS} from './defaults.mjs';import {merge,freeze,safe,isObject} from './merge.mjs';import {validate,invalid} from './validation.mjs';
export async function loadConfig(path,{read,defaults=DEFAULTS}){const active=new Set();
 async function visit(path){path=resolve(path);if(active.has(path))throw Object.assign(Error('include cycle'),{code:'CONFIG_CYCLE'});active.add(path);try{let data;const text=await read(path);try{data=JSON.parse(text);}catch{invalid();}if(!isObject(data))invalid();safe(data);const includes=Object.hasOwn(data,'include')?data.include:[];if(!Array.isArray(includes)||includes.some(p=>typeof p!=='string'||!p))invalid();let result={};for(const include of includes)result=merge(result,await visit(resolve(dirname(path),include)));const own={...data};delete own.include;return merge(result,own);}finally{active.delete(path);}}
 return freeze(validate(merge(defaults,await visit(path))));
}
