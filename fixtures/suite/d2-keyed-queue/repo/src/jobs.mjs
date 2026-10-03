export function jobKey(record){return `${record.tenant}:${record.account}`;}
export function validJob(key,fn){return typeof key==='string'&&key.length>0&&typeof fn==='function';}
