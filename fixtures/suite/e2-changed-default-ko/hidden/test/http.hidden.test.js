import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/http.js";

test("default timeout is 10 seconds", () => {
  assert.equal(createClient().timeoutMs, 10000);
  assert.equal(createClient({ baseUrl: "https://x" }).timeoutMs, 10000);
});

test("explicit timeout", () => {
  assert.equal(createClient({ timeoutMs: 2500 }).timeoutMs, 2500);
});

test("invalid timeouts throw TypeError", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) assert.throws(() => createClient({ timeoutMs: value }), TypeError, String(value));
});

test("baseUrl unchanged", () => {
  assert.equal(createClient({ baseUrl: "https://x" }).baseUrl, "https://x");
  assert.equal(createClient().baseUrl, "");
});
