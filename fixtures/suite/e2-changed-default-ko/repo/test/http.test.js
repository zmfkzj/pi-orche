import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/http.js";

test("base url", () => {
  assert.equal(createClient({ baseUrl: "https://x" }).baseUrl, "https://x");
  assert.equal(createClient().baseUrl, "");
});
