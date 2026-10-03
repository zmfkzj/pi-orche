import { validateRequest, copy } from './values.mjs';
import { insertOrder, findKey, insertKey } from './order-repository.mjs';
import { appendEvent } from './event-repository.mjs';
export async function placeOrder(db,input){
 input=copy(input);const total=validateRequest(input);
 return db.transaction(tx=>{const previous=findKey(tx,input.tenant,input.idempotencyKey);
 if(previous){const order=tx.orders.find(row=>row.id===previous.orderId);if(JSON.stringify(order.items)!==JSON.stringify(input.items)){const error=new Error('idempotency conflict');error.code='IDEMPOTENCY_CONFLICT';throw error;}return order;}
 const order=insertOrder(db,tx,input,total);insertKey(db,tx,input,order);appendEvent(db,tx,order);return order;
 });
}
