import {calculateInvoice,buildReport} from './index.mjs';
let text='';for await(const chunk of process.stdin)text+=chunk;try{console.log(JSON.stringify(buildReport(calculateInvoice(JSON.parse(text)))));}catch(error){console.error(error.message);process.exitCode=1;}
