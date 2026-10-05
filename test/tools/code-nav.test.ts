import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeNavTool, validateNavParams } from "../../src/tools/code-nav.js";

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "orche-nav-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "test"), { recursive: true });
  await mkdir(join(cwd, "py"), { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "nav-fixture", type: "module", scripts: { test: "node --test" } }));
  await writeFile(join(cwd, "src", "store.mjs"), [
    "export class Store {",
    "  constructor() { this.rows = []; }",
    "  claim(limit) { return this.rows.slice(0, limit); }",
    "}",
    "export function createStore() { return new Store(); }",
  ].join("\n"));
  await writeFile(join(cwd, "src", "dispatcher.mjs"), [
    "import { createStore } from './store.mjs';",
    "export async function dispatch(store, send) {",
    "  const batch = store.claim(10);",
    "  for (const event of batch) await send(event);",
    "  return batch.length;",
    "}",
    "export function run() { return dispatch(createStore(), async () => {}); }",
  ].join("\n"));
  await writeFile(join(cwd, "test", "dispatcher.test.mjs"), [
    "import { dispatch } from '../src/dispatcher.mjs';",
    "import { createStore } from '../src/store.mjs';",
    "await dispatch(createStore(), async () => {});",
  ].join("\n"));
  await writeFile(join(cwd, "py", "ledger.py"), ["class Ledger:", "    def post(self, amount):", "        return round(amount, 2)", "", "def make_ledger():", "    return Ledger()"].join("\n"));
});
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

const nav = async (params: Record<string, unknown>) => {
  const result = await createCodeNavTool(cwd).execute("id", params as never, undefined, undefined, { cwd } as never);
  return (result.content[0] as { text: string }).text;
};

describe("code_nav", () => {
  it("validates its parameters", () => {
    expect(validateNavParams({ op: "refs" })).toBe("refs needs symbol, or file and line.");
    expect(validateNavParams({ op: "symbols" })).toBe("symbols needs file.");
    expect(validateNavParams({ op: "locate" })).toBe("locate needs query.");
    expect(validateNavParams({ op: "refs", file: "a.ts", line: 3 })).toBeUndefined();
  });

  it("answers definitions, references, callers and tests semantically", async () => {
    const def = await nav({ op: "def", symbol: "dispatch" });
    expect(def).toContain("code_nav def dispatch (semantic): 1 result in 1 file");
    expect(def).toContain("src/dispatcher.mjs\n  2 function  export async function dispatch(store, send) {");
    const refs = await nav({ op: "refs", symbol: "dispatch" });
    expect(refs).toContain("src/dispatcher.mjs\n  2 definition");
    expect(refs).toContain("  7 ref  export function run() { return dispatch(createStore(), async () => {}); }");
    expect(refs).toContain("test/dispatcher.test.mjs");
    const member = await nav({ op: "refs", symbol: "Store.claim" });
    // Untyped JS hides `store.claim()` from the checker: textual matches complement the definition.
    expect(member).toContain("(semantic+heuristic)");
    expect(member).toContain("src/dispatcher.mjs\n  3 ref (text match)  const batch = store.claim(10);");
    const callers = await nav({ op: "callers", symbol: "dispatch" });
    expect(callers).toContain("called in run");
    expect(callers).toContain("test/dispatcher.test.mjs");
    const tests = await nav({ op: "tests", symbol: "createStore" });
    expect(tests).toContain("test/dispatcher.test.mjs");
    expect(tests).not.toContain("src/dispatcher.mjs");
    const atPosition = await nav({ op: "def", file: "src/dispatcher.mjs", line: 7, symbol: "createStore" });
    expect(atPosition).toContain("src/store.mjs\n  5 function");
  });

  it("lists a file's symbols, imports and importers, searches names and gives an overview", async () => {
    expect(await nav({ op: "symbols", file: "src/store.mjs" })).toContain("1 class  Store");
    expect(await nav({ op: "imports", file: "src/dispatcher.mjs" })).toContain("1 import  ./store.mjs → src/store.mjs");
    const importers = await nav({ op: "importers", file: "src/store.mjs" });
    expect(importers).toContain("src/dispatcher.mjs\n  1 import");
    expect(importers).toContain("test/dispatcher.test.mjs\n  2 test import");
    expect(await nav({ op: "locate", query: "createSt" })).toContain("createStore");
    const overview = await nav({ op: "overview" });
    expect(overview).toContain("package.json: nav-fixture; test: node --test");
    expect(overview).toContain("src/store.mjs\n  1 file  createStore, Store");
  });

  it("falls back to heuristic search for other languages", async () => {
    const def = await nav({ op: "def", symbol: "make_ledger" });
    expect(def).toContain("(heuristic)");
    expect(def).toContain("py/ledger.py\n  5 definition  def make_ledger():");
    expect(await nav({ op: "symbols", file: "py/ledger.py" })).toContain("1 declaration  class Ledger:");
    expect(await nav({ op: "refs", symbol: "Ledger" })).toContain("6 ref  return Ledger()");
  });
});
