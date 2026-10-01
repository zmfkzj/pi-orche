import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenCache, AuthenticatedClient, InvoiceService, HttpError } from '../src/index.js';

test('cache shares a refresh and renews before expiry', async () => {
  let now = 0;
  let issued = 0;
  const tokens = new TokenCache({ clock: { now: () => now }, issueToken: async () => ({ value: 't' + ++issued, expiresAt: now + 5000 }) });
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get()]), ['t1', 't1']);
  now = 3999;
  assert.equal(await tokens.get(), 't1');
  now = 4000;
  assert.equal(await tokens.get(), 't2');
  assert.equal(issued, 2);
});

test('client renews credentials after a single unauthorized response', async () => {
  let issued = 0;
  const tokens = new TokenCache({ issueToken: async () => ({ value: 't' + ++issued, expiresAt: Date.now() + 60000 }) });
  const client = new AuthenticatedClient({ tokens, transport: async ({ headers }) => {
    if (headers.authorization === 'Bearer t1') throw new HttpError(401, 'expired');
    return [{ id: 'inv-1' }];
  } });
  assert.deepEqual(await new InvoiceService(client).listForAccounts(['north']), [{ id: 'inv-1' }]);
  assert.equal(issued, 2);
});

test('non-auth failures are not retried and account paths are escaped', async () => {
  const calls = [];
  const failure = new HttpError(429, 'rate limited');
  const tokens = new TokenCache({ issueToken: async () => ({ value: 't1', expiresAt: Date.now() + 60000 }) });
  const client = new AuthenticatedClient({ tokens, transport: async request => { calls.push(request.path); throw failure; } });
  await assert.rejects(client.get('/accounts/north/invoices'), error => error === failure);
  assert.deepEqual(calls, ['/accounts/north/invoices']);
  const paths = [];
  const service = new InvoiceService({ get: async path => { paths.push(path); return [{ id: path }]; } });
  assert.equal((await service.listForAccounts(['east/west', 'south'])).length, 2);
  assert.deepEqual(paths, ['/accounts/east%2Fwest/invoices', '/accounts/south/invoices']);
});
