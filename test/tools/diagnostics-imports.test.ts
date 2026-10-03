import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

describe("diagnostics explicit-file imports", () => {
  it("reports errors in imported project sources, not unrelated files", { timeout: 40_000 }, async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, "entry.ts"), 'import { value } from "./bad.js";\nexport const result = value;\n');
    await writeFile(join(cwd, "bad.ts"), 'export const value = 1;\nconst n: number = "x";\n');
    await writeFile(join(cwd, "unrelated.ts"), 'const unrelated: number = "x";\n');
    const [result] = await runToolScript(cwd, ["diagnostics"], [
      () => ({ name: "diagnostics", args: { files: ["entry.ts"] } }),
    ]);
    expect(result!.isError).toBe(false);
    expect(result!.text).toContain("bad.ts:2:7 TS2322");
    expect(result!.text).not.toContain("unrelated.ts");
    expect(result!.text).toContain("1 errors in 2/2 files");
  });

  it("excludes dependency sources and declaration files from imported checks", { timeout: 40_000 }, async () => {
    const cwd = await tempWorkspace();
    await mkdir(join(cwd, "node_modules", "bad-dependency"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "bad-dependency", "index.ts"), 'export const value: number = "x";\n');
    await writeFile(join(cwd, "types.d.ts"), 'export declare const value: MissingType;\n');
    await writeFile(join(cwd, "entry.ts"), 'import { value } from "./node_modules/bad-dependency/index.js";\nimport type { value as declared } from "./types.js";\nexport const result = value;\n');
    const [result] = await runToolScript(cwd, ["diagnostics"], [
      () => ({ name: "diagnostics", args: { files: ["entry.ts"] } }),
    ]);
    expect(result!.isError).toBe(false);
    expect(result!.text).toMatch(/^No errors in 1\/1 files/);
  });
});
