import test from "node:test";
import assert from "node:assert/strict";
import { search } from "../src/search.js";

test("finds documents containing the query", () => {
  const results = search("pie");
  assert.ok(results.length > 0);
  assert.ok(results.every(result => typeof result.title === "string" && typeof result.score === "number"));
});
