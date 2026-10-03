import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkWriteRealPath, type WriteCheck } from "../../src/orchestration/ownership.js";
import { createAstRewriteTool } from "../../src/tools/ast.js";
import * as walker from "../../src/tools/walk.js";
import { cleanupWorkspaces, tempWorkspace } from "../tools/harness.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(realpath).mockReset();
  await cleanupWorkspaces();
});

async function project() {
  const cwd = await tempWorkspace();
  await mkdir(join(cwd, "src/a-nested"), { recursive: true });
  await writeFile(join(cwd, "src/a-nested/vanishing.ts"), "legacy(1);\n");
  await writeFile(join(cwd, "src/b-owned.ts"), "legacy(2);\n");
  const check: WriteCheck = {
    toolName: "ast_rewrite", input: { path: "src" }, cwd, agentId: "A1", assignmentKind: "implement",
    tasks: [{ id: "own", owner: "A1", description: "own", files: ["src/"], status: "running" }],
  };
  return { cwd, check };
}

function afterWalk(effect: () => Promise<void> | void) {
  const walk = walker.walkFiles;
  vi.spyOn(walker, "walkFiles").mockImplementationOnce(async (root, visit) => {
    await walk(root, visit);
    await effect();
  });
}

async function rewrite(check: WriteCheck) {
  const tool = createAstRewriteTool(check.cwd, { fileGuard: async path =>
    (await checkWriteRealPath({ ...check, input: { path } }))?.reason });
  const result = await tool.execute("rewrite", { path: "src", pattern: "legacy($A)", replacement: "modern($A)" }, undefined, undefined, undefined as never);
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

const errno = (code: string) => Object.assign(new Error(`${code}: simulated file churn`), { code });

describe("directory rewrite write-time ownership races", () => {
  it("checks the directory target without walking or resolving its children", async () => {
    const { cwd, check } = await project();
    const walk = vi.spyOn(walker, "walkFiles");
    expect(await checkWriteRealPath(check)).toBeUndefined();
    expect(walk).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalledWith(join(cwd, "src/a-nested/vanishing.ts"));
  });

  it.each(["ENOENT", "ENOTDIR"])("skips %s churn after walking and rewrites surviving files", async code => {
    const { cwd, check } = await project();
    afterWalk(async () => {
      await rm(join(cwd, "src/a-nested"), { recursive: true });
      if (code === "ENOTDIR") await writeFile(join(cwd, "src/a-nested"), "no longer a directory");
    });
    const text = await rewrite(check);
    expect(text).toContain("Rewrote 1 matches in 1 files");
    expect(text).toContain("Skipped files:\nsrc/a-nested/vanishing.ts:");
    expect(await readFile(join(cwd, "src/b-owned.ts"), "utf8")).toBe("modern(2);\n");
  });

  it("skips another worker's surviving file after a vanished candidate", async () => {
    const { cwd, check } = await project();
    afterWalk(() => rm(join(cwd, "src/a-nested"), { recursive: true }));
    const text = await rewrite({ ...check, tasks: [...check.tasks,
      { id: "other", owner: "A2", description: "other", files: ["src/b-owned.ts"], status: "running" },
    ] });
    expect(text).toContain("src/b-owned.ts: Blocked: src/b-owned.ts is owned by another worker");
    expect(await readFile(join(cwd, "src/b-owned.ts"), "utf8")).toBe("legacy(2);\n");
  });

  it("skips a real containment violation after a directory link swap", async () => {
    const { cwd, check } = await project();
    const outside = await tempWorkspace();
    await writeFile(join(outside, "vanishing.ts"), "legacy(3);\n");
    afterWalk(async () => {
      await rename(join(cwd, "src/a-nested"), join(cwd, "saved"));
      await symlink(outside, join(cwd, "src/a-nested"), "dir");
    });
    const text = await rewrite(check);
    expect(text).toContain("src/a-nested/vanishing.ts: outside the target directory");
    expect(await readFile(join(outside, "vanishing.ts"), "utf8")).toBe("legacy(3);\n");
    expect(await readFile(join(cwd, "src/b-owned.ts"), "utf8")).toBe("modern(2);\n");
  });

  it("skips an in-directory link swap to another owner's real file", async () => {
    const { cwd, check } = await project();
    await mkdir(join(cwd, "src/other"));
    await writeFile(join(cwd, "src/other/vanishing.ts"), "legacy(3);\n");
    afterWalk(async () => {
      await rename(join(cwd, "src/a-nested"), join(cwd, "saved"));
      await symlink(join(cwd, "src/other"), join(cwd, "src/a-nested"), "dir");
    });
    const text = await rewrite({ ...check, tasks: [...check.tasks,
      { id: "other", owner: "A2", description: "other", files: ["src/other/"], status: "running" },
    ] });
    expect(text).toContain("src/a-nested/vanishing.ts: Blocked: src/a-nested/vanishing.ts is a symlink to src/other/vanishing.ts, owned by another worker");
    expect(await readFile(join(cwd, "src/other/vanishing.ts"), "utf8")).toBe("legacy(3);\n");
    expect(await readFile(join(cwd, "saved/vanishing.ts"), "utf8")).toBe("legacy(1);\n");
    expect(await readFile(join(cwd, "src/b-owned.ts"), "utf8")).toBe("modern(2);\n");
  });

  it("reports resolution errors per file with the normal blocked-write advice", async () => {
    const { cwd, check } = await project();
    const tool = createAstRewriteTool(cwd, { fileGuard: async path => {
      if (path === "src/a-nested/vanishing.ts") vi.mocked(realpath).mockRejectedValueOnce(errno("EACCES"));
      return (await checkWriteRealPath({ ...check, input: { path } }))?.reason;
    } });
    const result = await tool.execute("rewrite", { path: "src", pattern: "legacy($A)", replacement: "modern($A)" }, undefined, undefined, undefined as never);
    const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
    expect(text).toContain("src/a-nested/vanishing.ts: Blocked: cannot resolve src/a-nested/vanishing.ts");
    expect(text).toContain('If the task really needs it, stop and report_result with data.status "blocked" and the reason.');
    expect(await readFile(join(cwd, "src/a-nested/vanishing.ts"), "utf8")).toBe("legacy(1);\n");
    expect(await readFile(join(cwd, "src/b-owned.ts"), "utf8")).toBe("modern(2);\n");
  });
});
