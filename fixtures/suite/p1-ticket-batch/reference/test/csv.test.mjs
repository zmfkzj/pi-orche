import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv/index.mjs';
test('csv regression: quoted multiline field and trailing empty field', () => {
  assert.deepEqual(parseCsv('"a\r\nb",\r\n'), [['a\r\nb','']]);
  assert.throws(() => parseCsv('"x"z'), {code:'CSV_QUOTE'});
});
