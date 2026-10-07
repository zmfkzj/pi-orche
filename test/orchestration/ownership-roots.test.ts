import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWrite, checkWriteRealPath, formatWriteRoots, WRITING_KINDS, type WriteCheck, type WriteRoot } from "../../src/orchestration/ownership.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** base/{repo (workspace), sibling (adjacent repository), scratch, outside}. */
async function layout() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orche-roots-")));
  dirs.push(base);
  const [cwd, sibling, scratch, outside] = ["repo", "sibling", "scratch", "outside"].map(name => join(base, name)) as [string, string, string, string];
  for (const dir of [cwd, sibling, scratch, outside]) await mkdir(dir);
  const roots: WriteRoot[] = [{ path: scratch, kind: "scratch" }, { path: sibling, kind: "root" }];
  const check = (path: string, options: { kind?: string; roots?: readonly WriteRoot[]; files?: string[]; toolName?: string } = {}) => checkWriteRealPath(request(cwd, path, options.roots ?? roots, options.kind ?? "implement", options.files ?? ["owned/"], options.toolName));
  return { base, cwd, sibling, scratch, outside, roots, check };
}
function request(cwd: string, path: string, extraRoots: readonly WriteRoot[], assignmentKind: string, files: string[], toolName = "write"): WriteCheck {
  return { toolName, input: { path }, cwd, agentId: "A1", assignmentKind, tasks: [{ id: "task", owner: "A1", description: "scope", files, status: "running" }], extraRoots };
}
async function link(context: TestContext, target: string, path: string, type: "file" | "dir" = "file") {
  try { await symlink(target, path, type); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) context.skip("symlink creation unavailable");
    else throw error;
  }
}
const KINDS = ["implement", "fix", "game-asset", "video", "explore", "answer", "verify", "review"];

describe("extra write roots", () => {
  it("allows the scratch directory for every assignment kind, with any tool and new subdirectories", async () => {
    const { scratch, check } = await layout();
    for (const kind of KINDS) {
      expect(await check(join(scratch, "notes.md"), { kind }), kind).toBeUndefined();
      expect(await check(join(scratch, "deep/new/x.py"), { kind }), kind).toBeUndefined();
    }
    for (const toolName of ["edit", "write", "ast_rewrite", "generate_image"]) expect(await check(join(scratch, "a.png"), { toolName })).toBeUndefined();
    expect(await check(scratch, { toolName: "ast_rewrite", kind: "explore" })).toBeUndefined();
  });

  it("allows an extra root only for writing kinds, without owned-file restrictions", async () => {
    const { sibling, check } = await layout();
    for (const kind of KINDS) {
      const result = await check(join(sibling, "src/game.ts"), { kind, files: [] });
      if (WRITING_KINDS.has(kind)) expect(result, kind).toBeUndefined();
      else expect(result?.reason, kind).toContain(`is in the extra write root ${sibling}, but assignment ${kind} is read-only`);
    }
    expect(checkWrite(request("/w", "/r/x", [{ path: "/r", kind: "root" }], undefined as never, []))?.reason).toContain("assignment (none) is read-only");
  });

  it("blocks an adjacent repository without a root and allows it with one (relative and absolute paths)", async () => {
    const { cwd, sibling, scratch, check } = await layout();
    const scratchOnly: WriteRoot[] = [{ path: scratch, kind: "scratch" }];
    const blocked = await check("../sibling/src/game.ts", { roots: scratchOnly });
    expect(blocked).toMatchObject({ file: "../sibling/src/game.ts" });
    expect(blocked?.reason).toContain("is outside the workspace");
    expect(blocked?.reason).toContain(`Use your scratch directory ${scratch} for temporary files.`);
    expect(blocked?.reason).toContain(`If the user explicitly asked to change ${join(sibling, "src/game.ts")}, stop and report_result with data.status "blocked" so main can re-assign the task with writeRoots including it.`);
    expect(await check("../sibling/src/game.ts")).toBeUndefined();
    expect(await check(join(sibling, "src/game.ts"))).toBeUndefined();
    expect(cwd).not.toBe(sibling);
  });

  it("blocks /tmp outside the scratch directory with the new advice text", async () => {
    const { scratch, check } = await layout();
    const target = join(tmpdir(), "x.py");
    const blocked = await check(target, { kind: "explore" });
    expect(blocked?.reason).toBe(`Blocked: ${target} is outside the workspace. Use your scratch directory ${scratch} for temporary files. If the user explicitly asked to change ${target}, stop and report_result with data.status "blocked" so main can re-assign the task with writeRoots including it.`);
    // Without any root the advice still names how to get one.
    const bare = await check(target, { roots: [] });
    expect(bare?.reason).not.toContain("scratch directory");
    expect(bare?.reason).toContain("writeRoots");
  });

  it("blocks path traversal and prefix tricks", async () => {
    const { base, scratch, sibling, check } = await layout();
    await mkdir(join(base, "scratch-evil"));
    expect((await check(join(scratch, "../outside/x")))?.reason).toContain("is outside the workspace");
    expect((await check(`${scratch}/../../etc/x`))?.reason).toContain("is outside the workspace");
    expect((await check("../scratch/../outside/x"))?.reason).toContain("is outside the workspace");
    expect((await check(join(base, "scratch-evil/x")))?.reason).toContain("is outside the workspace");
    expect((await check(`${sibling}-evil/x`))?.reason).toContain("is outside the workspace");
    expect(checkWrite(request("/w", "/tmp/scratch-evil/x", [{ path: "/tmp/scratch", kind: "scratch" }], "implement", []))?.reason).toContain("outside the workspace");
    expect(checkWrite(request("/w", "/tmp/scratch/x", [{ path: "/tmp/scratch", kind: "scratch" }], "implement", []))).toBeUndefined();
    // A relative root is ignored: roots are absolute.
    expect(checkWrite(request("/w", "/tmp/scratch/x", [{ path: "tmp/scratch", kind: "scratch" }], "implement", []))?.reason).toContain("outside the workspace");
  });

  it("blocks a symlink inside the scratch directory or a root that points outside it", async context => {
    const { cwd, scratch, sibling, outside, check } = await layout();
    await writeFile(join(outside, "secret"), "x");
    await link(context, join(outside, "secret"), join(scratch, "file-link"));
    await link(context, outside, join(scratch, "dir-link"), "dir");
    await link(context, outside, join(sibling, "dir-link"), "dir");
    expect((await check(join(scratch, "file-link")))?.reason).toContain(`leaves its write root via a symlink to ${join(outside, "secret")}`);
    expect((await check(join(scratch, "dir-link/new.txt")))?.reason).toContain("leaves its write root via a symlink");
    expect((await check(join(sibling, "dir-link/new.txt")))?.reason).toContain("leaves its write root via a symlink");
    // `..` after a symlink: the kernel resolves the link first.
    await mkdir(join(outside, "sub"));
    await link(context, join(outside, "sub"), join(scratch, "sub-link"), "dir");
    expect((await check(`${scratch}/sub-link/../escaped.txt`))?.reason).toContain(`symlink to ${join(outside, "escaped.txt")}`);
    // A link from a root back into the workspace would bypass ownership.
    await mkdir(join(cwd, "unowned"));
    await link(context, join(cwd, "unowned"), join(sibling, "into-repo"), "dir");
    expect((await check(join(sibling, "into-repo/x.ts")))?.reason).toContain("resolves into the workspace via a symlink");
    // A link to another place inside the same root is fine.
    await mkdir(join(scratch, "real"));
    await link(context, join(scratch, "real"), join(scratch, "alias"), "dir");
    expect(await check(join(scratch, "alias/x.txt"))).toBeUndefined();
  });

  it("fails closed on a dangling symlink inside a root", async context => {
    const { scratch, check } = await layout();
    await link(context, join(scratch, "missing"), join(scratch, "dangling"));
    expect((await check(join(scratch, "dangling")))?.reason).toContain("cannot resolve");
    await link(context, join(scratch, "missing-dir"), join(scratch, "dangling-dir"), "dir");
    expect((await check(join(scratch, "dangling-dir/new.txt")))?.reason).toContain("cannot resolve");
  });

  it("refuses a root that is itself a symlink, or missing", async context => {
    const { base, outside, check } = await layout();
    const linkedRoot = join(base, "linked-scratch");
    await link(context, outside, linkedRoot, "dir");
    const roots: WriteRoot[] = [{ path: linkedRoot, kind: "scratch" }];
    expect((await check(join(linkedRoot, "x.txt"), { roots }))?.reason).toContain(`write root ${linkedRoot} cannot be used`);
    const missing: WriteRoot[] = [{ path: join(base, "nope"), kind: "root" }];
    expect((await check(join(base, "nope/x.txt"), { roots: missing }))?.reason).toContain("cannot be used");
    // The pure classifier fails closed without root evidence.
    expect(checkWrite(request("/w", "/r/x", [{ path: "/r", kind: "root" }], "implement", []), { cwd: "/w", target: "/r/x" })?.reason).toContain("cannot be used");
  });

  it("keeps workspace behaviour unchanged, even when a root contains the workspace", async () => {
    const { base, cwd, check } = await layout();
    const wide: WriteRoot[] = [{ path: base, kind: "root" }, { path: base, kind: "scratch" }];
    await mkdir(join(cwd, "owned"));
    expect(await check("owned/a.ts", { roots: wide })).toBeUndefined();
    expect((await check("other/a.ts", { roots: wide }))?.reason).toContain("outside your owned files (owned/)");
    expect((await check("owned/a.ts", { roots: wide, kind: "explore" }))?.reason).toContain("read-only");
    expect((await check(".", { roots: wide, toolName: "ast_rewrite" }))?.reason).toContain('is outside the workspace. If the task really needs it, stop and report_result with data.status "blocked" and the reason.');
    expect((await check(join(cwd, "other/a.ts"), { roots: wide }))?.reason).toContain("outside your owned files");
    // No extraRoots at all: today's checks.
    expect(checkWrite({ ...request(cwd, "owned/a.ts", [], "implement", ["owned/"]), extraRoots: undefined })).toBeUndefined();
  });

  it("formats the scratch directory and extra roots for the worker prompt", () => {
    expect(formatWriteRoots([])).toBe("");
    expect(formatWriteRoots([{ path: "/tmp/pi-orche/s/w", kind: "scratch" }])).toBe("Use your scratch directory /tmp/pi-orche/s/w for temporary files (not /tmp or the repository).");
    const both: WriteRoot[] = [{ path: "/tmp/pi-orche/s/w", kind: "scratch" }, { path: "/code/other", kind: "root" }];
    expect(formatWriteRoots(both)).toBe("Use your scratch directory /tmp/pi-orche/s/w for temporary files (not /tmp or the repository); extra write roots outside the workspace: /code/other.");
    expect(formatWriteRoots(both, "explore")).toBe("Use your scratch directory /tmp/pi-orche/s/w for temporary files (not /tmp or the repository).");
    expect(formatWriteRoots([{ path: "/code/other", kind: "root" }], "implement")).toBe("Extra write roots outside the workspace: /code/other.");
    expect(formatWriteRoots([{ path: "/code/other", kind: "root" }], "answer")).toBe("");
  });
});
