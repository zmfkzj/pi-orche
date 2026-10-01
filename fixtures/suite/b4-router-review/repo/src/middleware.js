import { error } from './response.js';

/** Read JSON for write requests. Empty and malformed bodies are rejected. */
export async function readJson(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) {
      error(res, 413, 'body too large');
      return false;
    }
    chunks.splice(0, chunks.length, Buffer.from(chunk));
  }
  try {
    req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return true;
  } catch {
    error(res, 400, 'invalid JSON');
    return false;
  }
}

export function validFields(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && typeof body.name === 'string' && body.name.trim().length > 0
    && Number.isInteger(body.quantity) && body.quantity >= 0
    && Object.keys(body).every(key => ['name', 'quantity'].includes(key));
}
