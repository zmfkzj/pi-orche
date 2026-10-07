import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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

  // A project whose `npm install typescript` is still running: the package resolves but is broken, or does not resolve yet.
  it.each([
    ["exports {}", { "package.json": JSON.stringify({ name: "typescript", version: "9.9.9", main: "index.js" }), "index.js": "module.exports = {};\n" }, /the project's \(node_modules\/typescript\/index\.js\) was skipped because it is incomplete \(missing version, ScriptTarget\.ES2022, ModuleKind\.NodeNext/],
    ["lacks enums", { "package.json": JSON.stringify({ name: "typescript", main: "index.js" }), "index.js": "module.exports = { version: '9.9.9', createProgram() {} };\n" }, /was skipped because it is incomplete \(missing ScriptTarget\.ES2022/],
    ["throws on load", { "package.json": JSON.stringify({ name: "typescript", main: "index.js" }), "index.js": "throw new Error('half installed');\n" }, /the project's \(node_modules\/typescript\/index\.js\) was skipped because it failed to load \(half installed\)/],
    ["does not resolve yet", { "README.md": "partial\n" }, /the project's \(node_modules\/typescript\) was skipped because it could not be resolved \(Cannot find module/],
  ] as const)("falls back to the bundled TypeScript when the project's %s, and says so", { timeout: 40_000 }, async (_name, pkg, note) => {
    const cwd = await tempWorkspace();
    await mkdir(join(cwd, "node_modules", "typescript"), { recursive: true });
    for (const [file, text] of Object.entries(pkg)) await writeFile(join(cwd, "node_modules", "typescript", file), text);
    await writeFile(join(cwd, "typed.js"), "/** @type {number} */\nlet count = 'seven';\nexport default count;\n");
    await writeFile(join(cwd, "clean.js"), "export const one = 1;\n");
    const [typed, clean] = await runToolScript(cwd, ["diagnostics"], [
      () => ({ name: "diagnostics", args: { files: ["typed.js"] } }),
      () => ({ name: "diagnostics", args: { files: ["clean.js"] } }),
    ]);
    expect(typed!.isError).toBe(false);
    expect(typed!.text).toMatch(/^typed\.js:2:5 TS2322 /);
    const lines = typed!.text.split("\n");
    expect(lines.at(-1)).toMatch(/^TypeScript: used orche's bundled \d+\.\d+\.\d+; /);
    expect(lines.at(-1)).toMatch(note);
    expect(lines.filter(line => line.startsWith("TypeScript:"))).toHaveLength(1);
    expect(clean!.text).toMatch(/^No errors in 1\/1 files .*\nTypeScript: used orche's bundled/);
  });

  it("uses a complete project TypeScript (a distinct module path) without a note", { timeout: 40_000 }, async () => {
    const cwd = await tempWorkspace();
    const dir = join(cwd, "node_modules", "typescript");
    await mkdir(dir, { recursive: true });
    const { createRequire } = await import("node:module");
    // A real compiler behind the project's own entry point, so the project path differs from orche's.
    const bundled = createRequire(import.meta.url).resolve("typescript");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "typescript", main: "index.js" }));
    await writeFile(join(dir, "index.js"), `module.exports = require(${JSON.stringify(bundled)});\n`);
    await writeFile(join(cwd, "typed.js"), "/** @type {number} */\nlet count = 'seven';\nexport default count;\n");
    const [typed] = await runToolScript(cwd, ["diagnostics"], [() => ({ name: "diagnostics", args: { files: ["typed.js"] } })]);
    expect(typed!.text).toMatch(/^typed\.js:2:5 TS2322 /);
    expect(typed!.text).not.toContain("TypeScript:");
  });
});
