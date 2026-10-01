import { json } from './response.js';

export function registerHealth(router) {
  router.add('GET', '/health', async (ctx) => {
    const { req, res, params } = ctx;
    json(res, 200, { status: 'ok' });
  });
}
