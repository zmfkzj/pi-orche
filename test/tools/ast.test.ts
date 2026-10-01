import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

async function project() {
  const cwd = await tempWorkspace();
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "node_modules/dep"), { recursive: true });
  await writeFile(join(cwd, "src/a.ts"), "export function f(x: number) {\n  console.log(x, 'a');\n  return legacy(x, 1, 2);\n}\n");
  await writeFile(join(cwd, "src/b.js"), "const y = legacy(legacy(3, 5), 4);\nconsole.log('b');\n");
  await writeFile(join(cwd, "node_modules/dep/i.js"), "legacy(9);\n");
  return cwd;
}

describe("ast tools", () => {
  it("ast_search matches syntax across JS and TS, reports captures, skips node_modules", async () => {
    const cwd = await project();
    const [search, lang, bad] = await runToolScript(cwd, ["ast_search"], [
      () => ({ name: "ast_search", args: { pattern: "legacy($A, $$$REST)" } }),
      () => ({ name: "ast_search", args: { pattern: "console.log($A)", language: "typescript" } }),
      () => ({ name: "ast_search", args: { pattern: "console.log($A)", language: "cobol" } }),
    ]);
    expect(search!.text).toContain("src/a.ts:3: legacy(x, 1, 2)   [$A=x; $$$REST=1, 2]");
    expect(search!.text).toContain("src/b.js:1: legacy(legacy(3, 5), 4)");
    expect(search!.text).not.toContain("node_modules");
    expect(lang!.text).toContain("No matches in 1 files"); // console.log(x, 'a') has two args
    expect(bad!.isError).toBe(true);
    expect(bad!.text).toContain("Unsupported language");
  });

  it("ast_rewrite dry-run leaves files alone; real run rewrites with captured args and skips nested matches", async () => {
    const cwd = await project();
    const before = await readFile(join(cwd, "src/a.ts"), "utf8");
    const [dry, real] = await runToolScript(cwd, ["ast_rewrite"], [
      () => ({ name: "ast_rewrite", args: { pattern: "legacy($A, $$$REST)", replacement: "modern({ value: $A, rest: [$$$REST] })", dryRun: true } }),
      () => ({ name: "ast_rewrite", args: { pattern: "legacy($A, $$$REST)", replacement: "modern({ value: $A, rest: [$$$REST] })" } }),
    ]);
    expect(dry!.text).toContain("Would rewrite 2 matches in 2 files");
    expect(real!.text).toContain("Rewrote 2 matches in 2 files (1 nested matches skipped");
    expect(before).toContain("legacy(x, 1, 2)");
    expect(await readFile(join(cwd, "src/a.ts"), "utf8")).toBe(
      "export function f(x: number) {\n  console.log(x, 'a');\n  return modern({ value: x, rest: [1, 2] });\n}\n",
    );
    expect(await readFile(join(cwd, "src/b.js"), "utf8")).toBe(
      "const y = modern({ value: legacy(3, 5), rest: [4] });\nconsole.log('b');\n",
    );
    expect(await readFile(join(cwd, "node_modules/dep/i.js"), "utf8")).toBe("legacy(9);\n");
  });
});
