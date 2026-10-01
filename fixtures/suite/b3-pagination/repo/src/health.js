import { json } from './response.js';

export function registerHealth(router) {
  router.add('GET', '/health', async (req, res, params) => {
    json(res, 200, { status: 'ok' });
  });
}
