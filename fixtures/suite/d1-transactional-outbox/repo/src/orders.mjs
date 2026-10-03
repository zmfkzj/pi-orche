import { validateRequest } from './values.mjs';
import { insertOrder } from './order-repository.mjs';
export async function placeOrder(db, input) {
 const total = validateRequest(input);
 return db.transaction(tx => insertOrder(db, tx, input, total));
}
