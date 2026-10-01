import { afterEach, describe, expect, it } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

describe("diagnostics tool", () => {
  it("finds planted type and syntax errors in plain JS, stays silent on clean files, writes nothing", { timeout: 40_000 }, async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, "clean.js"), "/** @param {number} n */\nexport function double(n) {\n  return n * 2;\n}\ndouble(2);\nconst fs = require('fs');\nimport pkg from 'not-installed';\n");
    await writeFile(join(cwd, "typed.js"), "/** @type {number} */\nlet count = 'seven';\nexport default count;\n");
    await writeFile(join(cwd, "broken.js"), "function oops( {\n  return 1;\n}\n");
    const before = (await readdir(cwd)).sort();
    const [clean, typed, broken, project] = await runToolScript(cwd, ["diagnostics"], [
      () => ({ name: "diagnostics", args: { files: ["clean.js"] } }),
      () => ({ name: "diagnostics", args: { files: ["typed.js"] } }),
      () => ({ name: "diagnostics", args: { files: ["broken.js"] } }),
      () => ({ name: "diagnostics", args: {} }),
    ]);
    expect(clean!.text).toMatch(/^No errors in 1\/1 files/);
    expect(typed!.text).toMatch(/^typed\.js:2:5 TS2322 Type 'string' is not assignable to type 'number'/);
    expect(broken!.text).toMatch(/^broken\.js:\d+:\d+ TS\d+/);
    expect(project!.text).toContain("typed.js:2:5");
    expect(project!.text).toContain("broken.js");
    expect(project!.text).not.toContain("clean.js");
    expect(project!.text).toMatch(/errors in 3\/3 files/);
    expect((await readdir(cwd)).sort()).toEqual(before);
  });

  it("uses the workspace tsconfig and rejects missing files", { timeout: 40_000 }, async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    await writeFile(join(cwd, "ignored.ts"), "const a: number = 'outside include';\n");
    await import("node:fs/promises").then((fs) => fs.mkdir(join(cwd, "src")));
    await writeFile(join(cwd, "src/x.ts"), "export const x: string = 1;\nexport function f(a) { return a; }\n");
    const [project, missing] = await runToolScript(cwd, ["diagnostics"], [
      () => ({ name: "diagnostics", args: {} }),
      () => ({ name: "diagnostics", args: { files: ["nope.ts"] } }),
    ]);
    expect(project!.text).toContain("src/x.ts:1:14 TS2322");
    expect(project!.text).toContain("TS7006"); // strict from tsconfig: implicit any
    expect(project!.text).toContain("(tsconfig.json)");
    expect(project!.text).not.toContain("ignored.ts");
    expect(missing!.isError).toBe(true);
    expect(missing!.text).toContain("File not found: nope.ts");
  });
});
