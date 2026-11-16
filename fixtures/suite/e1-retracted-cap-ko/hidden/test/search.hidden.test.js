import test from "node:test";
import assert from "node:assert/strict";
import { search } from "../src/search.js";

test("returns every match, without a cap", () => {
  assert.equal(search("apple").length, 15);
  const many = Array.from({ length: 30 }, (_, index) => ({ title: `t${String(index).padStart(2, "0")}`, text: "x" }));
  assert.equal(search("x", many).length, 30);
});

test("orders by score, then title", () => {
  const results = search("apple");
  assert.deepEqual(results.slice(0, 3).map(result => [result.title, result.score]), [["doc e", 5], ["doc j", 5], ["doc o", 5]]);
  for (let index = 1; index < results.length; index++) {
    const [a, b] = [results[index - 1], results[index]];
    assert.ok(a.score > b.score || (a.score === b.score && a.title < b.title), `${a.title} before ${b.title}`);
  }
});

test("case-insensitive matching and counting", () => {
  const docs = [{ title: "b", text: "Pie PIE pie" }, { title: "a", text: "pie" }, { title: "c", text: "cake" }];
  assert.deepEqual(search("PIE", docs), [{ title: "b", score: 3 }, { title: "a", score: 1 }]);
});
