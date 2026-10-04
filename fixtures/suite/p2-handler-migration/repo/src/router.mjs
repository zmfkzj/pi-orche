/** Stable async handler ABI. Do not modify this module during migration. */
export const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
export function respond(status, body, headers = {}) {
  return { status, body, headers: { ...JSON_HEADERS, ...headers } };
}
export function failure(status, code) {
  return respond(status, { error: { code } });
}
export async function dispatch(handle, ctx) {
  try {
    const response = await handle(ctx);
    if (!response || !Number.isInteger(response.status) || !response.headers) {
      return failure(500, 'INTERNAL');
    }
    return response;
  } catch {
    return failure(500, 'INTERNAL');
  }
}
export function legacyAdapter(callbackHandler) {
  return ctx => new Promise((resolve, reject) => {
    callbackHandler(ctx, (error, value) => error ? reject(error) : resolve(respond(200, value)));
  });
}
