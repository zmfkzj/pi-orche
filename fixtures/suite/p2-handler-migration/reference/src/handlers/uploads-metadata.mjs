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
const mimeTypes = new Set(['image/png', 'image/jpeg', 'application/pdf']);

/**
 * Async uploads-metadata handler: direct invocation uses the same ABI as dispatch.
 *
 * Metadata validation does not read or store file contents.
 * Name normalization precedes path and control-character rejection.
 * MIME types are lowercased but deliberately not whitespace-trimmed.
 * Hex digests are canonicalized before storage and output.
 * Tag duplicates are removed after trimming and case normalization.
 * The service receives a detached metadata object.
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
  if (!exact(body, ['name', 'size', 'mime', 'sha256', 'tags']) ||
      typeof body.name !== 'string' || !integer(body.size, 1) || body.size > 10485760 ||
      typeof body.mime !== 'string' || typeof body.sha256 !== 'string') {
    return failure(400, 'UPLOAD_INPUT');
  }
  const name = body.name.trim().normalize('NFC');
  const mime = body.mime.toLowerCase();
  const tags = body.tags === undefined ? [] : body.tags;
  if (
      !name.length ||
      name.length > 128 ||
      /[\/\\\x00-\x1f\x7f]/.test(name) ||
      name === '.' || name === '..' ||
      !mimeTypes.has(mime) ||
      !/^[a-fA-F0-9]{64}$/.test(body.sha256) ||
      !Array.isArray(tags) ||
      tags.length > 10 ||
      tags.some(tag => typeof tag !== 'string' || !tag.trim().length || tag.trim().length > 20)) {
    return failure(400, 'UPLOAD_INPUT');
  }
  const metadata = {
    name,
    size: body.size,
    mime,
    sha256: body.sha256.toLowerCase(),
    tags: [...new Set(tags.map(tag => tag.trim().toLowerCase()))].sort(),
  };
  try {
    const saved = await ctx.services.uploads.save(structuredClone(metadata));
    return respond(201, {
      id: saved.id,
      ...metadata,
    });
  } catch (error) {
    if (error?.code === 'DUPLICATE') {
      return failure(409, 'UPLOAD_EXISTS');
    }
    return failure(500, 'UPLOAD_INTERNAL');
  }
}
