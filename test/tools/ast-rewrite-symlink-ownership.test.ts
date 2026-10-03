import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkWriteRealPath } from "../../src/orchestration/ownership.js";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";
import * as walker from "../../src/tools/walk.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupWorkspaces();
});

describe("directory ast_rewrite symlink safety", () => {
  it.each(["outside", "other owner"])("skips and reports links to an %s file without changing its target", async where => {
    const cwd = await tempWorkspace();
    const targetRoot = where === "outside" ? await tempWorkspace() : join(cwd, "other");
    await mkdir(join(cwd, "src"));
    await mkdir(targetRoot, { recursive: true });
    const target = join(targetRoot, "target.ts");
    await writeFile(target, "legacy(1);\n");
    await writeFile(join(cwd, "src/owned.ts"), "legacy(2);\n");
    await symlink(target, join(cwd, "src/escape.ts"));
    const input = { path: "src", pattern: "legacy($A)", replacement: "modern($A)" };
    // Exercise the same pre-execution ownership guard as orchestration workers.
    expect(await checkWriteRealPath({
      toolName: "ast_rewrite", input, cwd, agentId: "A1", assignmentKind: "implement",
      tasks: [
        { id: "own", owner: "A1", description: "own", files: ["src/"], status: "running" },
        { id: "other", owner: "A2", description: "other", files: ["other/"], status: "running" },
      ],
    })).toBeUndefined();
    const [rewrite, search] = await runToolScript(cwd, ["ast_rewrite", "ast_search"], [
      () => ({ name: "ast_rewrite", args: input }),
      () => ({ name: "ast_search", args: { path: "src", pattern: "legacy($A)" } }),
    ]);
    expect(rewrite!.isError).toBe(false);
    expect(rewrite!.text).toContain("Rewrote 1 matches in 1 files");
    expect(rewrite!.text).toContain("Skipped files:\nsrc/escape.ts: symlink");
    expect(await readFile(target, "utf8")).toBe("legacy(1);\n");
    expect(await readFile(join(cwd, "src/owned.ts"), "utf8")).toBe("modern(2);\n");
    expect(search!.text).toContain("src/escape.ts:1: legacy(1)");
  });

  it.each(["absolute", "directory symlink"])("rewrites an outside target directory in the main session (%s)", async mode => {
    const cwd = await tempWorkspace();
    const outside = await tempWorkspace();
    await writeFile(join(outside, "target.ts"), "legacy(1);\n");
    if (mode === "directory symlink") await symlink(outside, join(cwd, "src"), "dir");
    const path = mode === "absolute" ? outside : "src";
    const input = { path, pattern: "legacy($A)", replacement: "modern($A)" };
    // Workers still reject the outside directory before execution.
    expect(await checkWriteRealPath({
      toolName: "ast_rewrite", input, cwd, agentId: "A1", assignmentKind: "implement",
      tasks: [{ id: "own", owner: "A1", description: "own", files: ["src/"], status: "running" }],
    })).toMatchObject({ reason: expect.stringContaining("outside the workspace") });
    const [result] = await runToolScript(cwd, ["ast_rewrite"], [() => ({ name: "ast_rewrite", args: input })]);
    expect(result!.isError).toBe(false);
    expect(result!.text).toContain("Rewrote 1 matches in 1 files");
    expect(result!.text).not.toContain("Skipped files:");
    expect(await readFile(join(outside, "target.ts"), "utf8")).toBe("modern(1);\n");
  });

  it("skips a file if a directory component is swapped for an outside link after the walk", async () => {
    const cwd = await tempWorkspace();
    const outside = await tempWorkspace();
    await mkdir(join(cwd, "src/nested"), { recursive: true });
    await writeFile(join(cwd, "src/own.ts"), "legacy(1);\n");
    await writeFile(join(cwd, "src/nested/target.ts"), "legacy(2);\n");
    await writeFile(join(outside, "target.ts"), "legacy(3);\n");
    const walk = walker.walkFiles;
    vi.spyOn(walker, "walkFiles").mockImplementationOnce(async (root, visit) => {
      await walk(root, visit);
      await rename(join(cwd, "src/nested"), join(cwd, "saved"));
      await symlink(outside, join(cwd, "src/nested"), "dir");
    });
    const [result] = await runToolScript(cwd, ["ast_rewrite"], [
      () => ({ name: "ast_rewrite", args: { path: "src", pattern: "legacy($A)", replacement: "modern($A)" } }),
    ]);
    expect(result!.text).toContain("Rewrote 1 matches in 1 files");
    expect(result!.text).toContain("Skipped files:\nsrc/nested/target.ts: outside the target directory");
    expect(await readFile(join(outside, "target.ts"), "utf8")).toBe("legacy(3);\n");
    expect(await readFile(join(cwd, "saved/target.ts"), "utf8")).toBe("legacy(2);\n");
    expect(await readFile(join(cwd, "src/own.ts"), "utf8")).toBe("modern(1);\n");
  });
});
