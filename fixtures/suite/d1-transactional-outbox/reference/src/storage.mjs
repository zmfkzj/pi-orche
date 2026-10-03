import { copy } from './values.mjs';
export class Database {
 constructor(){this.state={orders:[],keys:[],events:[],sequence:0};this.failure=null;this.tail=Promise.resolve();}
 failNext(stage){this.failure=stage;}
 fault(stage){if(this.failure===stage){this.failure=null;throw new Error(`injected ${stage}`);}}
 rows(table){return copy(this.state[table]);}
 transaction(fn){const operation=this.tail.then(async()=>{const tx=copy(this.state);const result=await fn(tx);this.state=tx;return copy(result);});this.tail=operation.catch(()=>{});return operation;}
}
