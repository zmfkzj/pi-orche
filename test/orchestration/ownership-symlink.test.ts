import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWrite, checkWriteRealPath } from "../../src/orchestration/ownership.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), "orche-symlink-"));
  dirs.push(base);
  const cwd = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const check = (path: string, files = ["owned/"], toolName = "write", root = cwd) => checkWriteRealPath({
    toolName, input: { path }, cwd: root, agentId: "A1", assignmentKind: "implement",
    tasks: [{ id: "task", owner: "A1", description: "scope", files, status: "running" }],
  });
  return { base, cwd, outside, check };
}
async function link(context: TestContext, target: string, path: string, type: "file" | "dir" = "file") {
  try { await symlink(target, path, type); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) context.skip("symlink creation unavailable");
    else throw error;
  }
}

describe("symlink-aware ownership guard", () => {
  it("blocks an owned file linked to an unowned workspace file without expanding scope", async context => {
    const { cwd, check } = await workspace();
    await writeFile(join(cwd, "other.txt"), "unchanged");
    await link(context, "other.txt", join(cwd, "allowed.txt"));
    expect(await check("allowed.txt", ["allowed.txt"])).toMatchObject({
      file: "allowed.txt", reason: expect.stringContaining("outside your owned files (allowed.txt)"),
    });
    expect((await check("allowed.txt", ["allowed.txt"]))?.reason).toContain("symlink to other.txt");
  });

  it("blocks a link inside an owned directory to a file outside the workspace", async context => {
    const { cwd, outside, check } = await workspace();
    await mkdir(join(cwd, "owned"));
    await writeFile(join(outside, "target.txt"), "outside");
    await link(context, join(outside, "target.txt"), join(cwd, "owned/link.txt"));
    const blocked = await check("owned/link.txt");
    expect(blocked?.reason).toContain("outside the workspace");
    expect(blocked?.reason).toContain(`symlink to ${join(outside, "target.txt")}`);
  });

  it("blocks ast_rewrite on a symlinked directory outside the workspace", async context => {
    const { cwd, outside, check } = await workspace();
    await mkdir(join(cwd, "owned"));
    await link(context, outside, join(cwd, "owned/link"), "dir");
    expect((await check("owned/link", ["owned/"], "ast_rewrite"))?.reason).toContain("outside the workspace");
  });

  it("allows a new file below an owned real directory, including missing intermediate directories", async () => {
    const { cwd, check } = await workspace();
    await mkdir(join(cwd, "owned"));
    expect(await check("owned/new.ts")).toBeUndefined();
    expect(await check("owned/new/deeper/new.ts")).toBeUndefined();
  });

  it("blocks new files and ast_rewrite when the owned directory links to an unowned directory", async context => {
    const { cwd, check } = await workspace();
    await mkdir(join(cwd, "vendor/pkg"), { recursive: true });
    await link(context, "vendor/pkg", join(cwd, "owned"), "dir");
    expect((await check("owned/new.ts"))?.reason).toContain("outside your owned files (");
    expect((await check("owned/new/deeper.ts"))?.reason).toContain("symlink to vendor/pkg/new/deeper.ts");
    expect((await check("owned", ["owned/"], "ast_rewrite"))?.reason).toContain("symlink to vendor/pkg");
  });

  it("fails closed on a dangling file symlink", async context => {
    const { cwd, check } = await workspace();
    await link(context, "missing.txt", join(cwd, "allowed.txt"));
    expect((await check("allowed.txt", ["allowed.txt"]))?.reason).toContain("cannot resolve allowed.txt");
  });

  it("fails closed on a new file below a dangling directory symlink", async context => {
    const { cwd, check } = await workspace();
    await link(context, "missing-dir", join(cwd, "owned"), "dir");
    expect((await check("owned/new/deeper.ts"))?.reason).toContain("cannot resolve");
  });

  it("fails closed on a symlink loop rather than throwing", async context => {
    const { cwd, check } = await workspace();
    await link(context, "allowed.txt", join(cwd, "allowed.txt"));
    expect((await check("allowed.txt", ["allowed.txt"]))?.reason).toContain("cannot resolve");
  });

  it("keeps ordinary owned files allowed for write, edit and ast_rewrite", async () => {
    const { cwd, check } = await workspace();
    await writeFile(join(cwd, "allowed.txt"), "owned");
    for (const tool of ["write", "edit", "ast_rewrite"]) expect(await check("allowed.txt", ["allowed.txt"], tool)).toBeUndefined();
    expect(await check("new.txt", ["new.txt"])).toBeUndefined();
  });

  it("requires lexical ownership even if a link resolves to an owned file", async context => {
    const { cwd, check } = await workspace();
    await writeFile(join(cwd, "allowed.txt"), "owned");
    await link(context, "allowed.txt", join(cwd, "unowned.txt"));
    expect((await check("unowned.txt", ["allowed.txt"]))?.reason).toContain("outside your owned files (");
  });

  it("allows a link only if both lexical and real files are declared owned", async context => {
    const { cwd, check } = await workspace();
    await writeFile(join(cwd, "other.txt"), "owned too");
    await link(context, "other.txt", join(cwd, "allowed.txt"));
    expect(await check("allowed.txt", ["allowed.txt", "other.txt"])).toBeUndefined();
  });

  it("resolves a symlinked workspace root without misclassifying its files", async context => {
    const { base, cwd, check } = await workspace();
    await writeFile(join(cwd, "allowed.txt"), "owned");
    const alias = join(base, "workspace-alias");
    await link(context, cwd, alias, "dir");
    expect(await check("allowed.txt", ["allowed.txt"], "write", alias)).toBeUndefined();
    expect(await check("new.txt", ["new.txt"], "write", alias)).toBeUndefined();
  });

  it("preserves dry-run and non-write bypasses without filesystem resolution", async () => {
    const check = { cwd: "/does-not-exist", agentId: "A1", assignmentKind: "explore", tasks: [] };
    expect(await checkWriteRealPath({ ...check, toolName: "ast_rewrite", input: { dryRun: true } })).toBeUndefined();
    expect(await checkWriteRealPath({ ...check, toolName: "read", input: {} })).toBeUndefined();
    expect(checkWrite({ ...check, toolName: "write", input: { path: "new.txt" } })?.reason).toContain("read-only");
  });
});
