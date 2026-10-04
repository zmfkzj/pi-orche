import test from 'node:test';
import assert from 'node:assert/strict';
import { satisfies } from '../src/semver/index.mjs';
test('semver regression: zero-major caret and prerelease admission', () => {
  assert.equal(satisfies('0.2.9','^0.2.3'),true);
  assert.equal(satisfies('0.3.0','^0.2.3'),false);
  assert.equal(satisfies('1.2.3-beta','*'),false);
  assert.equal(satisfies('1.2.3-beta.2','>=1.2.3-beta.1 <2.0.0'),true);
});
