import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/version.js';

test('major', () => assert.ok(compareVersions('2.0.0', '1.9.9') > 0));
test('multi-digit', () => assert.ok(compareVersions('1.10.0', '1.9.0') > 0));
test('equal', () => assert.equal(compareVersions('1.2.3', '1.2.3'), 0));
