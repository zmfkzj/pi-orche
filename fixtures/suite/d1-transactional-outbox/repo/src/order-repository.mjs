export function insertOrder(db, tx, input, total) {
 db.fault('order'); const order = { id: String(++tx.sequence), tenant: input.tenant, items: input.items, total }; tx.orders.push(order); return order;
}
export function findKey(tx, tenant, key) { return tx.keys.find(row => row.tenant === tenant && row.key === key); }
export function insertKey(db, tx, input, order) { db.fault('key'); tx.keys.push({tenant:input.tenant,key:input.idempotencyKey,orderId:order.id}); }
