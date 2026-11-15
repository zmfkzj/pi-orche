import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWrite, checkWriteRealPath, exactPathHint, ownsPath } from "../../src/orchestration/ownership.js";
import { executeSpawn, OWNED_PATHS_SYNTAX, planSpawn, scopePaths, spawnParameters, ultraSpawnParameters, type SpawnContext } from "../../src/orchestrator/spawn.js";
import { orcheTaskParameters } from "../../src/extension/workers.js";

/**
 * Owned path without a trailing / (`.archify`) versus a directory scope (`.archify/`): the exact-path semantics stay, an existing
 * directory named without / is refused before any worker runs, and a write blocked under such a path names the `dir/` correction.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "orche-owned-dir-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".archify"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "a.ts"), "a\n");
  return cwd;
}
async function link(context: TestContext, target: string, path: string) {
  try { await symlink(target, path, "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) context.skip("symlink creation unavailable");
    else throw error;
  }
}
const tasks = (files: string[], owner = "W2") => [{ id: "t", owner, description: "scope", files, status: "running" as const }];
const write = (path: string, files: string[], kind = "implement") =>
  checkWrite({ toolName: "write", input: { path }, cwd: "/workspace", agentId: "W2", assignmentKind: kind, tasks: tasks(files) });
const TARGET = ".archify/workflow-labeling-flow-20261115-204714/candidate.json";

describe("owned path semantics (unchanged)", () => {
  it("keeps a path without / exact and a dir/ entry recursive, with no prefix-sibling match", () => {
    expect(ownsPath(".archify", TARGET)).toBe(false);
    expect(ownsPath(".archify", ".archify")).toBe(true);
    expect(ownsPath(".archify/", TARGET)).toBe(true);
    expect(ownsPath(".archify/", ".archify")).toBe(true);
    expect(ownsPath("src", "src2/a.ts")).toBe(false);
    expect(ownsPath("src/", "src2/a.ts")).toBe(false);
    expect(ownsPath("src/a.ts", "src/a.ts")).toBe(true);
  });

  it("canonicalizes the recursive aliases and leaves exact paths alone without a workspace", () => {
    expect(scopePaths([".archify/", ".archify/**", ".archify/**/*"])).toEqual([".archify/"]);
    // No cwd (SDK callers, ultra's analyst hand-off): no filesystem check, exact path kept.
    expect(scopePaths([".archify", "./src"])).toEqual([".archify", "src"]);
    expect(scopePaths([])).toEqual([]);
    expect(() => scopePaths(["src/*.ts"])).toThrow("Unsupported ownership path");
  });
});

describe("existing directory named without a trailing /", () => {
  it("is refused with the dir/ correction; directory syntax, files and missing paths pass", async () => {
    const cwd = await workspace();
    expect(() => scopePaths([".archify"], cwd)).toThrow('Owned path ".archify" is an existing directory, but a path without a trailing / owns only that exact path, not the files inside it. Use ".archify/" (or the same with /**)');
    expect(() => scopePaths(["./.archify"], cwd)).toThrow('Use ".archify/"');
    expect(() => scopePaths([".archify", "src", "src/a.ts"], cwd)).toThrow('Owned path ".archify", "src" are existing directories');
    expect(scopePaths([".archify/", ".archify/**", ".archify/**/*", "src/a.ts"], cwd)).toEqual([".archify/", "src/a.ts"]);
    // A directory that does not exist yet stays an exact path (it may be a new file); the denial hint covers it later.
    expect(scopePaths(["newdir", "newdir2/"], cwd)).toEqual(["newdir", "newdir2/"]);
    expect(scopePaths([], cwd)).toEqual([]);
  });

  it("does not follow a symlink to a directory (no new authority from the link target)", async context => {
    const cwd = await workspace();
    await link(context, "src", join(cwd, "linked"));
    expect(scopePaths(["linked"], cwd)).toEqual(["linked"]);
    // Writes through it stay blocked: the exact entry does not own linked/a.ts.
    expect((await checkWriteRealPath({ toolName: "write", input: { path: "linked/a.ts" }, cwd, agentId: "W2", assignmentKind: "implement", tasks: tasks(["linked"]) }))?.reason)
      .toContain("outside your owned files (linked)");
  });

  it("refuses orche_spawn writers before any id is used, with and without the workspace given", async () => {
    const cwd = await workspace();
    let ids = 0;
    const call = { reason: "isolation" as const, workers: [{ name: "w", role: "implement" as const, request: "x", files: [".archify"] }] };
    expect(() => planSpawn(call, { cwd, nextId: () => `W1.${++ids}` })).toThrow('Use ".archify/"');
    expect(ids).toBe(0);
    expect(planSpawn(call, { nextId: () => "W1.1" }).workers[0]!.files).toEqual([".archify"]);
    let started = 0;
    const context: SpawnContext = { orchestrator: "W1", cwd, nextId: () => `W1.${++ids}`, runWorker: async () => { started++; throw new Error("not reached"); } };
    await expect(executeSpawn(context, call, undefined)).rejects.toThrow('is an existing directory');
    expect(started).toBe(0);
  });
});

describe("denial of a write under an exact owned path", () => {
  it("names the dir/ correction and asks for a re-assignment, also for a directory that does not exist", async () => {
    const reason = write(TARGET, [".archify"])?.reason ?? "";
    expect(reason).toContain(`Blocked: ${TARGET} is outside your owned files (.archify)`);
    expect(reason).toContain('Your owned path .archify has no trailing /, so it owns only that exact path, not the files under it');
    expect(reason).toContain('ask main to re-assign with files [".archify/"]');
    expect(reason).toContain("Do not widen your scope yourself");
    // Real-path variant in a workspace without the directory: the hint is lexical.
    const cwd = await mkdtemp(join(tmpdir(), "orche-owned-dir-"));
    dirs.push(cwd);
    const real = await checkWriteRealPath({ toolName: "write", input: { path: "newdir/a.ts" }, cwd, agentId: "W2", assignmentKind: "implement", tasks: tasks(["newdir"]) });
    expect(real?.reason).toContain('files ["newdir/"]');
  });

  it("keeps exact files, dir/ scopes, prefix siblings, read-only and other owners as before", () => {
    expect(write(".archify", [".archify"])).toBeUndefined();
    expect(write(TARGET, [".archify/"])).toBeUndefined();
    expect(write("src/a.ts", ["src/a.ts"])).toBeUndefined();
    const sibling = write("src2/a.ts", ["src"])?.reason ?? "";
    expect(sibling).toContain("outside your owned files (src)");
    expect(sibling).not.toContain("trailing /");
    expect(write("src/b.ts", ["src/a.ts"])?.reason).not.toContain("trailing /");
    expect(write(TARGET, [".archify"], "answer")?.reason).toBe("Blocked: assignment answer is read-only; only implement/fix/game-asset/video assignments may write files.");
    expect(write(TARGET, [], "implement")?.reason).toContain("outside your owned files (none)");
    const shared = checkWrite({ toolName: "write", input: { path: "src/a.ts" }, cwd: "/workspace", agentId: "W2", assignmentKind: "implement",
      tasks: [...tasks(["src/"]), ...tasks(["src/a.ts"], "W3")] });
    expect(shared?.reason).toContain("owned by another worker");
    expect(exactPathHint(["src", "lib/"], "lib/x.ts")).toBe("");
    expect(exactPathHint(["./src"], "src/x.ts")).toContain('files ["src/"]');
  });
});

describe("public files contract", () => {
  it("states exact versus recursive syntax in orche_task and the orche_spawn schemas", () => {
    expect(OWNED_PATHS_SYNTAX).toContain("a path without a trailing / owns exactly that one path");
    expect(OWNED_PATHS_SYNTAX).toContain("dir/ (dir/** and dir/**/* mean the same), also for a directory that does not exist yet");
    expect(OWNED_PATHS_SYNTAX).toContain("An existing directory named without / is refused");
    const task = orcheTaskParameters.properties.files as { description?: string };
    expect(task.description).toContain(OWNED_PATHS_SYNTAX);
    expect(task.description).toContain("Omitted: anywhere inside the workspace; []: no write scope");
    expect(JSON.stringify(ultraSpawnParameters)).toContain(JSON.stringify(OWNED_PATHS_SYNTAX).slice(1, -1));
    // The strong/single orche_spawn schema stays frozen (ultra-handoff.test.ts) and already names the directory syntax.
    expect(JSON.stringify(spawnParameters)).toContain("Owned files or directories (dir/ or dir/**)");
  });
});
