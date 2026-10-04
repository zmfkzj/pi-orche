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
function decimal(value, fallback, min, max) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const number = Number(value);
  return integer(number, min) && number <= max ? number : null;
}
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Async search handler: direct invocation uses the same ABI as dispatch.
 *
 * Search is a literal substring query, not a regular expression.
 * All terms must match a document, possibly in different fields.
 * Duplicate IDs are discarded before matching or ranking.
 * One title match and one text match may both score for a term.
 * ASCII ID ordering makes equal-score pagination deterministic.
 * The response count is measured before applying offset and limit.
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
  if (!exact(query, ['q', 'offset', 'limit']) || typeof query.q !== 'string') {
    return failure(400, 'SEARCH_INPUT');
  }
  const q = query.q.trim().toLowerCase();
  const offset = decimal(query.offset, 0, 0, 1000000);
  const limit = decimal(query.limit, 20, 1, 100);
  if (!q.length || q.length > 200 || offset === null || limit === null) {
    return failure(400, 'SEARCH_INPUT');
  }
  const terms = [...new Set(q.split(/\s+/))];
  try {
    const rows = await ctx.services.search.scan();
    const seen = new Set();
    const matches = [];
    for (const row of rows) {
      // Index may repeat IDs; the first occurrence defines the document.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const title = row.title.toLowerCase();
      const text = row.text.toLowerCase();
      if (!terms.every(term => title.includes(term) || text.includes(term))) continue;
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 2 : 0) + (text.includes(term) ? 1 : 0), 0);
      matches.push({ id: row.id, title: row.title, score });
    }
    matches.sort((a, b) => b.score - a.score || lex(a.id, b.id));
    return respond(200, { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit });
  } catch {
    return failure(500, 'SEARCH_INTERNAL');
  }
}
