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
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const time = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    return null;
  }
  return time;
}

/**
 * Async reports handler: direct invocation uses the same ABI as dispatch.
 *
 * The reporting period is half-open and evaluated in UTC.
 * Date validation rejects calendar overflow rather than normalizing it.
 * The first record for an ID is authoritative even when excluded.
 * Only paid in-period rows participate in amount validation.
 * Both per-group totals and overall totals require safe integers.
 * Group keys are sorted without host locale dependence.
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
  const query = ctx?.query;
  if (!exact(query, ['from', 'to', 'groupBy'])) {
    return failure(400, 'REPORT_INPUT');
  }
  const from = date(query.from), to = date(query.to);
  const groupBy = query.groupBy === undefined ? 'day' : query.groupBy;
  if (from === null || to === null || from >= to || to - from > 366 * 86400000 ||
      !['day', 'customer'].includes(groupBy)) return failure(400, 'REPORT_INPUT');
  try {
    const rows = await ctx.services.reports.list({ from: query.from, to: query.to });
    const seen = new Set(), groups = new Map();
    let total = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const time = Date.parse(row.at);
      if (!Number.isFinite(time) || time < from || time >= to || row.status !== 'paid') continue;
      if (!integer(row.amount)) {
        return failure(500, 'REPORT_INTERNAL');
      }
      const key = groupBy === 'day' ? new Date(time).toISOString().slice(0, 10) : row.customerId;
      const group = groups.get(key) || { key, count: 0, total: 0 };
      if (!Number.isSafeInteger(group.total + row.amount) || !Number.isSafeInteger(total + row.amount)) {
        return failure(500, 'REPORT_OVERFLOW');
      }
      group.count++;
      group.total += row.amount;
      total += row.amount;
      groups.set(key, group);
    }
    const items = [...groups.values()].sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return respond(200, { items, total });
  } catch {
    return failure(500, 'REPORT_INTERNAL');
  }
}
