import { respond, failure } from '../router.mjs';

/** JSON object guards intentionally do not coerce strings, numbers or arrays. */
function object(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function exact(value, keys) {
  if (!object(value)) {
    return false;
  }
  return Object.keys(value).every(key => keys.includes(key));
}

function integer(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}
/** All prices are integer cents; duplicate SKUs coalesce in first-seen order. */
/**
 * Async orders handler: direct invocation uses the same ABI as dispatch.
 *
 * Prices and quantities are integer cents and whole units.
 * Input consolidation completes before any catalog I/O.
 * Catalog calls follow first-seen SKU order, not completion order.
 * Every total is checked before the create side effect.
 * BigInt discount arithmetic does not change the integer response ABI.
 * The persisted draft and response use separate mutable object graphs.
 *
 * @param {object} ctx Validated at the boundary; unrelated fields are ignored.
 * @param {object} ctx.services Injected asynchronous storage/search services.
 * @returns {Promise<{status:number, body:object, headers:object}>}
 *
 * Validation errors perform no service I/O.
 * Successful response construction projects only documented public fields.
 * Service rejections are always handled here, not delegated to the router.
 * The callback ABI is intentionally absent from the migrated implementation.
 */
export async function handle(ctx) {
  const body = ctx?.body;
  if (!exact(body, ['customerId', 'items', 'coupon']) ||
      typeof body.customerId !== 'string' || !body.customerId.trim() ||
      !Array.isArray(body.items) || !body.items.length || body.items.length > 100 ||
      (body.coupon !== undefined && body.coupon !== 'SAVE10')) {
    return failure(400, 'ORDER_INPUT');
  }
  const quantities = new Map();
  for (const item of body.items) {
    if (!exact(item, ['sku', 'quantity']) || typeof item.sku !== 'string' ||
        !/^[A-Z0-9-]{1,32}$/.test(item.sku) || !integer(item.quantity, 1)) {
      return failure(400, 'ORDER_INPUT');
    }
    const quantity = (quantities.get(item.sku) || 0) + item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > 999) {
      return failure(400, 'ORDER_INPUT');
    }
    quantities.set(item.sku, quantity);
  }
  try {
    const lines = [];
    let subtotal = 0;
    for (const [sku, quantity] of quantities) {
      const product = await ctx.services.catalog.get(sku);
      if (!product) {
        return failure(404, 'ORDER_SKU');
      }
      if (!integer(product.price)) {
        return failure(500, 'ORDER_INTERNAL');
      }
      const lineTotal = product.price * quantity;
      if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
        return failure(400, 'ORDER_OVERFLOW');
      }
      subtotal += lineTotal;
      lines.push({ sku, quantity, unitPrice: product.price, total: lineTotal });
    }
    // BigInt prevents an unsafe intermediate subtotal * 10.
    const discount = body.coupon === 'SAVE10' ? Number(BigInt(subtotal) / 10n) : 0;
    const draft = { customerId: body.customerId.trim(), lines, subtotal, discount, total: subtotal - discount };
    const saved = await ctx.services.orders.create(structuredClone(draft));
    return respond(201, { id: saved.id, ...draft });
  } catch {
    return failure(500, 'ORDER_INTERNAL');
  }
}
