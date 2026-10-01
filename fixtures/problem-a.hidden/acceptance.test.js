import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenCache, AuthenticatedClient, HttpError } from '../src/index.js';

function deferred() {
  return Promise.withResolvers();
}

test('late rejection of an old credential preserves the successful replacement', { timeout: 2000 }, async () => {
  let issued = 0;
  const entered = deferred();
  const release = deferred();
  const tokens = new TokenCache({ clock: { now: () => 0 }, issueToken: async () => {
    issued += 1;
    if (issued > 2) throw new HttpError(429, 'identity budget exceeded');
    return { value: 'credential-' + issued, expiresAt: 60000 };
  } });
  await tokens.get();
  const client = new AuthenticatedClient({ tokens, transport: async ({ path, headers }) => {
    if (headers.authorization === 'Bearer credential-1') {
      if (path === '/slow') { entered.resolve(); await release.promise; }
      throw new HttpError(401, 'rotated');
    }
    return { path, credential: headers.authorization };
  } });
  const slow = client.get('/slow');
  const slowOutcome = slow.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  try {
    assert.deepEqual(await client.get('/fast'), { path: '/fast', credential: 'Bearer credential-2' });
  } finally {
    release.resolve();
  }
  const outcome = await slowOutcome;
  assert.equal(outcome.error, undefined, 'old unauthorized response must not consume another refresh');
  assert.deepEqual(outcome.value, { path: '/slow', credential: 'Bearer credential-2' });
  assert.equal(await tokens.get(), 'credential-2');
  assert.equal(issued, 2);
});

test('overlapping unauthorized responses share an in-flight replacement', { timeout: 2000 }, async () => {
  let issued = 0;
  let rejected = 0;
  const refreshing = deferred();
  const bothRejected = deferred();
  const release = deferred();
  const tokens = new TokenCache({ clock: { now: () => 0 }, issueToken: async () => {
    const generation = ++issued;
    if (generation === 2) { refreshing.resolve(); await release.promise; }
    return { value: 'credential-' + generation, expiresAt: 60000 };
  } });
  await tokens.get();
  const client = new AuthenticatedClient({ tokens, transport: async ({ headers }) => {
    if (headers.authorization === 'Bearer credential-1') {
      if (++rejected === 2) bothRejected.resolve();
      throw new HttpError(401, 'rotated');
    }
    return headers.authorization;
  } });
  const calls = Promise.all([client.get('/a'), client.get('/b')]);
  await Promise.all([refreshing.promise, bothRejected.promise]);
  release.resolve();
  assert.deepEqual(await calls, ['Bearer credential-2', 'Bearer credential-2']);
  assert.equal(issued, 2);
});

test('a rejected replacement is propagated and future calls can recover', { timeout: 2000 }, async () => {
  let issued = 0;
  const tokens = new TokenCache({ clock: { now: () => 0 }, issueToken: async () => {
    const generation = ++issued;
    if (generation === 2) throw new HttpError(503, 'issuer unavailable');
    return { value: 'credential-' + generation, expiresAt: 60000 };
  } });
  const client = new AuthenticatedClient({ tokens, transport: async ({ headers }) => {
    if (headers.authorization === 'Bearer credential-1') throw new HttpError(401, 'rotated');
    return headers.authorization;
  } });
  await assert.rejects(client.get('/first'), { status: 503 });
  assert.equal(await client.get('/later'), 'Bearer credential-3');
  assert.equal(issued, 3);
});

test('replacement credentials remain subject to expiry and retry limit', { timeout: 2000 }, async () => {
  let now = 0;
  let issued = 0;
  let calls = 0;
  const tokens = new TokenCache({ clock: { now: () => now }, issueToken: async () => ({ value: 'credential-' + ++issued, expiresAt: now + 5000 }) });
  const client = new AuthenticatedClient({ tokens, transport: async () => { calls += 1; throw new HttpError(401, 'rejected'); } });
  await assert.rejects(client.get('/denied'), { status: 401 });
  assert.equal(calls, 2);
  assert.equal(issued, 2);
  now = 4000;
  assert.equal(await tokens.get(), 'credential-3');
});
