import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFindTool } from "../../src/tools/find.js";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

const execFileAsync = promisify(execFile);
afterEach(cleanupWorkspaces);

describe("find Git ignore support", () => {
  it("honours root/nested ignores and negation, includes tracked ignored files, and preserves skipped dirs", async () => {
    const cwd = await tempWorkspace();
    await execFileAsync("git", ["init", "--quiet", cwd]);
    for (const dir of ["src", "ignored", ".github", "node_modules/pkg", ".orche/artifacts", ".git/test-data"]) {
      await mkdir(join(cwd, dir), { recursive: true });
    }
    await writeFile(join(cwd, ".gitignore"), "ignored/\n*.generated.ts\n!keep.generated.ts\n");
    await writeFile(join(cwd, "src/.gitignore"), "nested.ts\n");
    for (const file of ["visible.ts", "tracked.generated.ts", "hide.generated.ts", "keep.generated.ts", "ignored/hide.ts",
      "src/nested.ts", "src/visible.ts", ".github/visible.ts", "node_modules/pkg/hide.ts", ".orche/artifacts/hide.ts", ".git/test-data/hide.ts"]) {
      await writeFile(join(cwd, file), "const value = 1;\n");
    }
    await execFileAsync("git", ["-C", cwd, "add", "-f", "tracked.generated.ts", "node_modules/pkg/hide.ts", ".orche/artifacts/hide.ts"]);
    await writeFile(join(cwd, "deleted.ts"), "const value = 1;\n");
    await execFileAsync("git", ["-C", cwd, "add", "deleted.ts"]);
    await rm(join(cwd, "deleted.ts"));
    const [all, nested, limited] = await runToolScript(cwd, ["find"], [
      () => ({ name: "find", args: { pattern: "*.ts" } }),
      () => ({ name: "find", args: { pattern: "*.ts", path: "src" } }),
      () => ({ name: "find", args: { pattern: "*.ts", limit: 2 } }),
    ]);
    expect(all!.isError).toBe(false);
    expect(all!.text.split("\n").sort()).toEqual([".github/visible.ts", "keep.generated.ts", "src/visible.ts", "tracked.generated.ts", "visible.ts"]);
    expect(nested!.text).toBe("visible.ts");
    expect(limited!.isError).toBe(false);
    expect(limited!.text).toContain("2 results limit reached");
    expect(limited!.text.split("\n\n")[0]!.split("\n")).toHaveLength(2);
  });

  it.each(["untracked repo", "gitlink"])("searches inside a nested %s with its own ignore rules", async kind => {
    const cwd = await tempWorkspace();
    const nested = join(cwd, "nested");
    await execFileAsync("git", ["init", "--quiet", cwd]);
    await execFileAsync("git", ["init", "--quiet", nested]);
    await writeFile(join(nested, ".gitignore"), "ignored.ts\n");
    for (const file of ["tracked.ts", "untracked.ts", "ignored.ts"]) {
      await writeFile(join(nested, file), "const value = 1;\n");
    }
    await execFileAsync("git", ["-C", nested, "add", "tracked.ts", ".gitignore"]);
    const outside = await tempWorkspace();
    await writeFile(join(outside, "outside.ts"), "const value = 1;\n");
    await symlink(outside, join(nested, "link"), "dir");
    const skipped = join(cwd, "node_modules");
    await execFileAsync("git", ["init", "--quiet", skipped]);
    await writeFile(join(skipped, "hidden.ts"), "const value = 1;\n");
    if (kind === "gitlink") {
      await execFileAsync("git", ["-C", nested, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
      const { stdout } = await execFileAsync("git", ["-C", nested, "rev-parse", "HEAD"]);
      await execFileAsync("git", ["-C", cwd, "update-index", "--add", "--cacheinfo", `160000,${stdout.trim()},nested`]);
    }
    const [all, pathPattern, limited] = await runToolScript(cwd, ["find"], [
      () => ({ name: "find", args: { pattern: "*.ts" } }),
      () => ({ name: "find", args: { pattern: "nested/*.ts" } }),
      () => ({ name: "find", args: { pattern: "*.ts", limit: 1 } }),
    ]);
    expect(all!.isError).toBe(false);
    expect(all!.text.split("\n").sort()).toEqual(["nested/tracked.ts", "nested/untracked.ts"]);
    expect(pathPattern!.text.split("\n").sort()).toEqual(["nested/tracked.ts", "nested/untracked.ts"]);
    expect(limited!.isError).toBe(false);
    expect(limited!.text).toContain("1 results limit reached");
    expect(limited!.text.split("\n\n")[0]!.split("\n")).toHaveLength(1);
  });

  it("keeps the non-Git walker fallback, including dot paths", async () => {
    const cwd = await tempWorkspace();
    await mkdir(join(cwd, ".hidden"));
    await writeFile(join(cwd, ".hidden/a.ts"), "const value = 1;\n");
    const [result] = await runToolScript(cwd, ["find"], [() => ({ name: "find", args: { pattern: "**/*.ts" } })]);
    expect(result!.text).toBe(".hidden/a.ts");
  });

  it("rejects an already-cancelled search", async () => {
    const cwd = await tempWorkspace();
    const controller = new AbortController();
    controller.abort();
    await expect(createFindTool(cwd).execute("find", { pattern: "*.ts" }, controller.signal, undefined, undefined as never))
      .rejects.toThrow("aborted");
  });
});
