import {readEvents,aggregate} from './index.mjs';import {parseOptions} from './options.mjs';
let options;try{options=parseOptions(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;}
if(options){try{const result=await aggregate(readEvents(process.stdin,{...options,onError:error=>console.error(JSON.stringify(error))}));console.log(JSON.stringify(result));}catch(error){process.exitCode=1;}}
