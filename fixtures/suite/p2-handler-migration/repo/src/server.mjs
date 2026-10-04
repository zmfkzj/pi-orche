import { dispatch, failure } from './router.mjs';
import { handle as users } from './handlers/users.mjs';
import { handle as orders } from './handlers/orders.mjs';
import { handle as inventory } from './handlers/inventory.mjs';
import { handle as search } from './handlers/search.mjs';
import { handle as uploads } from './handlers/uploads-metadata.mjs';
import { handle as reports } from './handlers/reports.mjs';

/** HTTP-shaped local dispatcher; no listener, socket or ambient clock. */
const routes = new Map([
  ['POST /users', users],
  ['POST /orders', orders],
  ['POST /inventory', inventory],
  ['GET /search', search],
  ['POST /uploads-metadata', uploads],
  ['GET /reports', reports],
]);
export function createLocalServer({ services, now = () => 0, logger } = {}) {
  let sequence = 0;
  const counters = { accepted: 0, rejected: 0, failed: 0 };
  return {
    async request(input) {
      const requestId = 'request-' + ++sequence;
      if (!input || typeof input.method !== 'string' || typeof input.path !== 'string') {
        counters.rejected++;
        return failure(400, 'REQUEST_INPUT');
      }
      const method = input.method.toUpperCase();
      const route = routes.get(method + ' ' + input.path);
      if (!route) {
        counters.rejected++;
        return failure(404, 'ROUTE_UNKNOWN');
      }
      counters.accepted++;
      const ctx = {
        requestId,
        method,
        path: input.path,
        body: structuredClone(input.body),
        query: structuredClone(input.query || {}),
        params: {},
        services,
        now,
      };
      logger?.info('request.started', { requestId, method, path: input.path });
      const response = await dispatch(route, ctx);
      if (response.status >= 500) counters.failed++;
      logger?.info('request.completed', { requestId, status: response.status });
      return response;
    },
    snapshot() {
      return { ...counters, sequence };
    },
    describeRoutes() {
      return [...routes.keys()].sort().map(key => {
        const [method, path] = key.split(' ');
        return { method, path };
      });
    },
  };
}
