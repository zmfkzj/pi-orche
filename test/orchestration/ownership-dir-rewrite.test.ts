import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateBacklog, type TaskItem } from "../../src/orchestration/backlog.js";
import { checkWriteRealPath } from "../../src/orchestration/ownership.js";
import { cleanupWorkspaces, tempWorkspace } from "../tools/harness.js";

afterEach(cleanupWorkspaces);

describe("directory rewrite per-file ownership", () => {
  it("rejects nested other-worker scopes, and checks each file rather than blocking the directory", async () => {
    const cwd = await tempWorkspace();
    await mkdir(join(cwd, "src/nested"), { recursive: true });
    await writeFile(join(cwd, "src/own.ts"), "legacy(1);\n");
    await writeFile(join(cwd, "src/nested/other.ts"), "legacy(2);\n");
    const tasks: TaskItem[] = [
      { id: "own", owner: "A1", description: "own", files: ["src/"], status: "running" },
      { id: "other", owner: "A2", description: "other", files: ["src/nested/"], status: "running" },
    ];
    expect(validateBacklog(tasks, ["A1", "A2"])).toContainEqual({
      type: "file_overlap", taskIds: ["own", "other"], files: ["src/", "src/nested/"],
    });
    expect(await checkWriteRealPath({
      toolName: "ast_rewrite", input: { path: "src" }, cwd, agentId: "A1", assignmentKind: "implement", tasks,
    })).toBeUndefined();
    expect(await checkWriteRealPath({
      toolName: "ast_rewrite", input: { path: "src/nested/other.ts" }, cwd, agentId: "A1", assignmentKind: "implement", tasks,
    })).toMatchObject({ file: "src/nested/other.ts", reason: expect.stringContaining("owned by another worker") });
  });

  it("allows a regular nested file when all directory contents belong to the same worker", async () => {
    const cwd = await tempWorkspace();
    await mkdir(join(cwd, "src/nested"), { recursive: true });
    await writeFile(join(cwd, "src/nested/own.ts"), "legacy(1);\n");
    expect(await checkWriteRealPath({
      toolName: "ast_rewrite", input: { path: "src" }, cwd, agentId: "A1", assignmentKind: "implement",
      tasks: [{ id: "own", owner: "A1", description: "own", files: ["src/"], status: "running" }],
    })).toBeUndefined();
  });
});
