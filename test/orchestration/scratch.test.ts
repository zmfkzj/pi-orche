import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCRATCH_BASE, ensureScratchDir, removeScratchDir, sanitizeScratchId } from "../../src/orchestration/scratch.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orche-scratch-")));
  dirs.push(root);
  return root;
}
const mode = async (path: string) => (await stat(path)).mode & 0o777;
async function link(context: TestContext, target: string, path: string) {
  try { await symlink(target, path, "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) context.skip("symlink creation unavailable");
    else throw error;
  }
}

describe("scratch directories", () => {
  it("creates <base>/<session>/<worker> with mode 0700 and returns its real path", async () => {
    const root = await temp();
    const base = join(root, "nested/pi-orche");
    const dir = await ensureScratchDir({ base, session: "session-1", worker: "W1.2" });
    expect(dir).toBe(join(base, "session-1", "W1.2"));
    for (const path of [base, join(base, "session-1"), dir]) expect(await mode(path), path).toBe(0o700);
    // Idempotent, and tightens a component that became wider.
    await chmod(join(base, "session-1"), 0o755);
    expect(await ensureScratchDir({ base, session: "session-1", worker: "W1.2" })).toBe(dir);
    expect(await mode(join(base, "session-1"))).toBe(0o700);
    expect(DEFAULT_SCRATCH_BASE).toBe(join(tmpdir(), "pi-orche"));
  });

  it("sanitizes session and worker ids into single safe components", async () => {
    expect(sanitizeScratchId("a/b\\c d$e")).toBe("a_b_c_d_e");
    expect(sanitizeScratchId("..")).toBe("_..");
    expect(sanitizeScratchId(".")).toBe("_.");
    expect(sanitizeScratchId("")).toBe("_");
    expect(sanitizeScratchId("ok-1.2_x")).toBe("ok-1.2_x");
    expect(sanitizeScratchId("x".repeat(300))).toHaveLength(100);
    const base = join(await temp(), "base");
    const dir = await ensureScratchDir({ base, session: "../../etc", worker: "../w" });
    expect(dir).toBe(join(base, ".._.._etc", ".._w"));
  });

  it("refuses a symlinked or foreign component", async context => {
    const root = await temp();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    const base = join(root, "base");
    await link(context, elsewhere, base);
    await expect(ensureScratchDir({ base, session: "s", worker: "w" })).rejects.toThrow("is a symlink");
    const base2 = join(root, "base2");
    await mkdir(join(base2), { mode: 0o700 });
    await link(context, elsewhere, join(base2, "s"));
    await expect(ensureScratchDir({ base: base2, session: "s", worker: "w" })).rejects.toThrow("is a symlink");
    await writeFile(join(base2, "file"), "x");
    await expect(ensureScratchDir({ base: base2, session: "file", worker: "w" })).rejects.toThrow("is not a directory");
    expect((await lstat(join(base2, "s"))).isSymbolicLink()).toBe(true);
  });

  it("refuses a component owned by another user", async context => {
    if (process.getuid?.() !== 0) context.skip("needs root to create a foreign-owned directory");
    const root = await temp();
    const base = join(root, "base");
    await mkdir(join(base, "s"), { recursive: true });
    const { chown } = await import("node:fs/promises");
    await chown(join(base, "s"), 12345, 12345);
    await expect(ensureScratchDir({ base, session: "s", worker: "w" })).rejects.toThrow("not owned by the current user");
  });

  it("removes only directories strictly inside the base and never throws", async context => {
    const root = await temp();
    const base = join(root, "base");
    const dir = await ensureScratchDir({ base, session: "s", worker: "w" });
    await writeFile(join(dir, "f.txt"), "x");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "x");

    await removeScratchDir(base, base);
    await removeScratchDir(outside, base);
    await removeScratchDir(join(base, ".."), base);
    await removeScratchDir(join(base, "s/../../outside"), base);
    await removeScratchDir(join(root, "base-evil"), base);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(join(outside, "keep.txt"))).isFile()).toBe(true);

    // A symlink inside base pointing outside is not followed.
    await link(context, outside, join(base, "s", "escape"));
    await removeScratchDir(join(base, "s", "escape"), base);
    expect((await stat(join(outside, "keep.txt"))).isFile()).toBe(true);

    await removeScratchDir(dir, base);
    await expect(stat(dir)).rejects.toThrow();
    expect((await stat(join(base, "s"))).isDirectory()).toBe(true);
    // Missing directory or base: no throw.
    await expect(removeScratchDir(dir, base)).resolves.toBeUndefined();
    await expect(removeScratchDir(join(root, "nobase/x"), join(root, "nobase"))).resolves.toBeUndefined();
  });
});
