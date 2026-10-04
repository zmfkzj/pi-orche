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
/** apply must be one atomic compare-and-adjust operation in the storage service. */
/**
 * Async inventory handler: direct invocation uses the same ABI as dispatch.
 *
 * Storage owns compare-and-adjust transaction semantics.
 * All adjustments are validated before the single apply call.
 * A duplicate SKU is rejected rather than silently combined.
 * Result ordering is independent of the service array ordering.
 * Only SKU, quantity and version are returned to the caller.
 * Known repository codes are mapped without exposing error messages.
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
  if (!exact(body, ['adjustments']) || !Array.isArray(body.adjustments) ||
      !body.adjustments.length || body.adjustments.length > 100) {
    return failure(400, 'INVENTORY_INPUT');
  }
  const skus = new Set();
  const adjustments = [];
  for (const item of body.adjustments) {
    if (!exact(item, ['sku', 'delta', 'expectedVersion']) ||
        typeof item.sku !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(item.sku) ||
        !Number.isSafeInteger(item.delta) || item.delta === 0 ||
        !integer(item.expectedVersion) || skus.has(item.sku)) {
      return failure(400, 'INVENTORY_INPUT');
    }
    skus.add(item.sku);
    adjustments.push({
      sku: item.sku,
      delta: item.delta,
      expectedVersion: item.expectedVersion,
    });
  }
  try {
    const rows = await ctx.services.inventory.apply(structuredClone(adjustments));
    const bySku = new Map(rows.map(row => [row.sku, row]));
    return respond(200, { items: adjustments.map(({ sku }) => {
      const row = bySku.get(sku);
      return {
        sku,
        quantity: row.quantity,
        version: row.version,
      };
    }) });
  } catch (error) {
    if (error?.code === 'NOT_FOUND') {
      return failure(404, 'INVENTORY_SKU');
    }
    if (error?.code === 'VERSION') {
      return failure(409, 'INVENTORY_VERSION');
    }
    if (error?.code === 'UNDERFLOW') {
      return failure(409, 'INVENTORY_STOCK');
    }
    return failure(500, 'INVENTORY_INTERNAL');
  }
}
