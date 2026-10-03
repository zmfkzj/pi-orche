import {createQueue} from './queue.mjs';import {jobKey} from './jobs.mjs';
export function createService(write,options){const queue=createQueue(options);return {save:record=>queue.submit(jobKey(record),()=>write(record)),flush:()=>queue.drain(),stop:()=>queue.close(),stats:()=>queue.stats()};}
