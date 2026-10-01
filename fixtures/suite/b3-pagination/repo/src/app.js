import { resolve } from 'node:path';
import { createRouter } from './router.js';
import { createStore } from './store.js';
import { readJson } from './middleware.js';
import { registerItems } from './items.js';
import { registerHealth } from './health.js';
import { serveStatic } from './static.js';
import { error } from './response.js';

/** Build an isolated application; pass its handler to node:http. */
export function createApp({ seed = [], publicDir = resolve('public') } = {}) {
  const store = createStore(seed);
  const router = createRouter();
  registerHealth(router);
  registerItems(router, store);
  const handler = async (req, res) => {
    try {
      if (await serveStatic(req, res, publicDir)) return;
      const url = new URL(req.url, 'http://localhost');
      if (['POST', 'PATCH'].includes(req.method) && !await readJson(req, res)) return;
      if (!await router.dispatch(req, res, url)) error(res, 404, 'route not found');
    } catch {
      if (!res.writableEnded) error(res, 500, 'internal error');
    }
  };
  return { handler, routes: router.routes, store };
}
