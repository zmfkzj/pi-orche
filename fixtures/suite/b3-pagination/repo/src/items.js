import { json, error } from './response.js';
import { validFields } from './middleware.js';

export function registerItems(router, store) {
  router.add('GET', '/items', async (req, res, params) => {
    const url = new URL(req.url, 'http://localhost');
    const page = Number(url.searchParams.get('page') ?? 1);
    const limit = Number(url.searchParams.get('limit') ?? 10);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(res, 400, 'invalid pagination');
    }
    const all = store.list();
    const start = (page - 1) * limit;
    json(res, 200, { items: all.slice(start, start + limit - 1), total: all.length, page, limit });
  });

  router.add('GET', '/items/:id', async (req, res, params) => {
    const item = store.get(params.id);
    if (!item) return error(res, 404, 'item not found');
    json(res, 200, item);
  });

  router.add('POST', '/items', async (req, res, params) => {
    if (!validFields(req.body)) return error(res, 400, 'invalid item');
    const fields = { name: req.body.name.trim(), quantity: req.body.quantity };
    if (store.hasName(fields.name)) return error(res, 409, 'name already exists');
    json(res, 201, store.add(fields));
  });

  router.add('DELETE', '/items/:id', async (req, res, params) => {
    if (!store.remove(params.id)) return error(res, 404, 'item not found');
    res.statusCode = 204;
    res.end();
  });
}
