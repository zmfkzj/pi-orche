import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { request, response } from './helpers.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('static containment and ordinary encoded names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minihttp-'));
  try {
    await mkdir(join(dir, 'public', 'nested'), { recursive: true });
    await mkdir(join(dir, 'public-other'));
    await writeFile(join(dir, 'secret.txt'), 'private-data');
    await writeFile(join(dir, 'public-other', 'secret.txt'), 'private-data');
    await writeFile(join(dir, 'public', 'nested', 'a b.txt'), 'public-data');
    const app = createApp({ publicDir: join(dir, 'public') });
    for (const path of ['%2e%2e/secret.txt', '..%2fsecret.txt', '%2e%2e%2fsecret.txt', '%2E%2E%2Fsecret.txt', 'nested/%2e%2e/%2e%2e/secret.txt', '%2e%2e/public-other/secret.txt']) {
      const result = await request(app, 'GET', '/static/' + path);
      assert.ok(result.status >= 400 && result.status < 500, path);
      assert.ok(!result.text.includes('private-data'));
    }
    assert.equal((await request(app, 'GET', '/static/nested/a%20b.txt')).text, 'public-data');
    const contained = await request(app, 'GET', '/static/nested/../nested/a%20b.txt');
    assert.ok(
      (contained.status === 200 && contained.text === 'public-data')
      || (contained.status >= 400 && contained.status < 500),
      'contained dot segments may be served safely or rejected',
    );
    assert.ok(!contained.text.includes('private-data'));
    const malformed = await request(app, 'GET', '/static/%zz');
    assert.ok(malformed.status >= 400 && malformed.status < 500);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
