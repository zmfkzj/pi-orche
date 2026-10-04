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

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate before consulting the directory; repository races report conflicts. */
/**
 * Async users handler: direct invocation uses the same ABI as dispatch.
 *
 * Directory creation accepts only public registration fields.
 * Email lookup uses normalized identity, never the original spelling.
 * Role order is canonical, but the request array is not sorted in place.
 * The service may race after lookup; DUPLICATE has the same public result.
 * Only the generated identifier is copied from a repository result.
 * Location encodes the identifier as one path segment.
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
  if (!exact(body, ['email', 'displayName', 'roles']) ||
      typeof body.email !== 'string' || typeof body.displayName !== 'string') {
    return failure(400, 'USER_INPUT');
  }
  const email = body.email.trim().toLowerCase();
  const displayName = body.displayName.trim();
  const roles = body.roles === undefined ? ['viewer'] : body.roles;
  if (email.length > 254 || !emailPattern.test(email) ||
      !displayName.length || displayName.length > 80 ||
      !Array.isArray(roles) || !roles.length ||
      roles.some(role => !['viewer', 'editor'].includes(role)) ||
      new Set(roles).size !== roles.length) {
    return failure(400, 'USER_INPUT');
  }
  try {
    const existing = await ctx.services.users.findByEmail(email);
    if (existing) {
      return failure(409, 'USER_EXISTS');
    }
    const registration = {
      email,
      displayName,
      roles: [...roles].sort(),
    };
    const saved = await ctx.services.users.create(registration);
    return respond(201, {
      id: saved.id,
      email,
      displayName,
      roles: [...roles].sort(),
    }, {
      location: '/users/' + encodeURIComponent(saved.id),
    });
  } catch (error) {
    if (error?.code === 'DUPLICATE') {
      return failure(409, 'USER_EXISTS');
    }
    return failure(500, 'USER_INTERNAL');
  }
}
