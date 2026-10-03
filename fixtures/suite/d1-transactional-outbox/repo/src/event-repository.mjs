export function appendEvent(db, tx, order) {
 db.fault('event'); tx.events.push({id:String(++tx.sequence),tenant:order.tenant,type:'order.placed',orderId:order.id,payload:{total:order.total},status:'pending',attempts:0});
}
export function pending(tx) { return tx.events.filter(event => event.status !== 'delivered'); }
