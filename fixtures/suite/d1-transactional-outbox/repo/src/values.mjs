export const copy = value => structuredClone(value);
export function validateRequest(input) {
 if (typeof input?.tenant !== 'string' || !input.tenant || typeof input?.idempotencyKey !== 'string' || !input.idempotencyKey || !Array.isArray(input.items) || !input.items.length) throw new TypeError('invalid order');
 for (const item of input.items) if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.price) || item.price < 0) throw new TypeError('invalid item');
 const total = input.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
 if (!Number.isSafeInteger(total)) throw new RangeError('total overflow');
 return total;
}
