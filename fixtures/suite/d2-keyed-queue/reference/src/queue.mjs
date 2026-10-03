import {emit} from './events.mjs';import {validJob} from './jobs.mjs';
export function createQueue({onEvent}={}){
 const tails=new Map(),active=new Set();let closed=false,closing;const counters={accepted:0,completed:0,failed:0,running:0,pending:0};
 function submit(key,fn){if(closed)return Promise.reject(Object.assign(Error('closed'),{code:'QUEUE_CLOSED'}));if(!validJob(key,fn))return Promise.reject(new TypeError('invalid job'));counters.accepted++;counters.pending++;
 const result=(tails.get(key)||Promise.resolve()).then(async()=>{counters.pending--;counters.running++;emit(onEvent,'start',key);try{return await fn();}catch(error){counters.failed++;throw error;}finally{counters.running--;counters.completed++;emit(onEvent,'finish',key);}});
 const settled=result.then(()=>{},()=>{});tails.set(key,settled);active.add(settled);settled.then(()=>{active.delete(settled);if(tails.get(key)===settled)tails.delete(key);});return result;
 }
 const drain=()=>Promise.all([...active]).then(()=>{});
 return {submit,stats:()=>({...counters}),drain,close:()=>{closed=true;return closing??=drain();}};
}
