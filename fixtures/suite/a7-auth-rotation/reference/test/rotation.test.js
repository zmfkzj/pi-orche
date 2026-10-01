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
