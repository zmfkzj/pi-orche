import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

describe("search tools enabled on a worker session", () => {
  it("grep, find (no fd needed) and ls work; find skips node_modules/.orche and sees dot dirs", async () => {
    const cwd = await tempWorkspace();
    for (const dir of ["src/deep", "node_modules/x", ".github/workflows", ".orche/artifacts"]) await mkdir(join(cwd, dir), { recursive: true });
    await writeFile(join(cwd, "src/a.ts"), "export const NEEDLE = 1;\n");
    await writeFile(join(cwd, "src/deep/b.ts"), "// NEEDLE here\n");
    await writeFile(join(cwd, "node_modules/x/c.ts"), "NEEDLE\n");
    await writeFile(join(cwd, ".github/workflows/ci.yml"), "name: ci\n");
    await writeFile(join(cwd, ".orche/artifacts/o.ts"), "NEEDLE\n");
    const [grep, findTs, findYml, findRel, ls] = await runToolScript(cwd, ["grep", "find", "ls"], [
      () => ({ name: "grep", args: { pattern: "NEEDLE", glob: "*.ts" } }),
      () => ({ name: "find", args: { pattern: "**/*.ts" } }),
      () => ({ name: "find", args: { pattern: "**/*.yml" } }),
      () => ({ name: "find", args: { pattern: "src/*.ts" } }),
      () => ({ name: "ls", args: { path: "src" } }),
    ]);
    expect(grep!.text).toContain("src/a.ts");
    expect(grep!.text).toContain("src/deep/b.ts");
    expect(findTs!.text.split("\n").sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(findYml!.text).toBe(".github/workflows/ci.yml");
    expect(findRel!.text).toBe("src/a.ts");
    expect(ls!.text).toContain("a.ts");
    expect(ls!.text).toContain("deep/");
  });
});
