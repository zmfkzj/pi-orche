import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { createAstRewriteTool } from "../../src/tools/ast.js";
import { createOrcheTools } from "../../src/tools/index.js";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

const input = { path: "src", pattern: "legacy($A)", replacement: "modern($A)" };
afterEach(cleanupWorkspaces);

async function project(blocked = "legacy(1);\n", allowed = "legacy(2);\n") {
  const cwd = await tempWorkspace();
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/a-blocked.ts"), blocked);
  await writeFile(join(cwd, "src/b-allowed.ts"), allowed);
  return cwd;
}

async function rewrite(tool: ToolDefinition, args = input, signal?: AbortSignal) {
  const result = await tool.execute("rewrite", args, signal, undefined, undefined as never);
  return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
}

describe("directory ast_rewrite file guards", () => {
  it("skips a blocked matching file, forwarding relative paths and the signal through createOrcheTools", async () => {
    const cwd = await project("legacy(legacy(1));\n", "legacy(legacy(2));\n");
    const signal = new AbortController().signal;
    const fileGuard = vi.fn(async (path: string) => path === "src/a-blocked.ts" ? "owned by another worker" : undefined);
    const tool = createOrcheTools({ cwd, astRewriteFileGuard: fileGuard }).find(t => t.name === "ast_rewrite")!;
    const text = await rewrite(tool, input, signal);
    expect(fileGuard.mock.calls).toEqual([["src/a-blocked.ts", signal], ["src/b-allowed.ts", signal]]);
    expect(text).toContain("Rewrote 1 matches in 1 files (1 nested matches skipped");
    expect(text).toContain("Skipped files:\nsrc/a-blocked.ts: owned by another worker");
    expect(text).not.toContain("  - legacy(legacy(1))");
    expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("legacy(legacy(1));\n");
    expect(await readFile(join(cwd, "src/b-allowed.ts"), "utf8")).toBe("modern(legacy(2));\n");
  });

  it.each(["sync", "async", "non-Error"])("skips a file when its guard throws (%s) and continues rewriting", async mode => {
    const cwd = await project();
    const fileGuard = (path: string) => {
      if (path !== "src/a-blocked.ts") return undefined;
      if (mode === "async") return Promise.reject(new Error("guard unavailable"));
      if (mode === "non-Error") throw "guard unavailable";
      throw new Error("guard unavailable");
    };
    const text = await rewrite(createAstRewriteTool(cwd, { fileGuard }));
    expect(text).toContain("Rewrote 1 matches in 1 files");
    expect(text).toContain("Skipped files:\nsrc/a-blocked.ts: guard unavailable");
    expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("legacy(1);\n");
    expect(await readFile(join(cwd, "src/b-allowed.ts"), "utf8")).toBe("modern(2);\n");
  });

  it("never checks files without matches", async () => {
    const cwd = await project("unrelated(1);\n");
    const fileGuard = vi.fn(() => undefined);
    await rewrite(createAstRewriteTool(cwd, { fileGuard }));
    expect(fileGuard.mock.calls).toEqual([["src/b-allowed.ts", undefined]]);
    expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("unrelated(1);\n");
  });

  it("does not charge skipped matches against the rewrite limit", async () => {
    const blocked = "legacy(1);\n".repeat(1000);
    const cwd = await project(blocked);
    const text = await rewrite(createAstRewriteTool(cwd, { fileGuard: path => path === "src/a-blocked.ts" ? "blocked" : undefined }));
    expect(text).toContain("Rewrote 1 matches in 1 files");
    expect(text).not.toContain("rewrite limit reached");
    expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe(blocked);
    expect(await readFile(join(cwd, "src/b-allowed.ts"), "utf8")).toBe("modern(2);\n");
  });

  it("still stops at the rewrite limit after allowed files", async () => {
    const cwd = await project("legacy(1);\n", "legacy(2);\n".repeat(1000));
    await writeFile(join(cwd, "src/c-rest.ts"), "legacy(3);\n");
    const fileGuard = vi.fn((path: string) => path === "src/a-blocked.ts" ? "blocked" : undefined);
    const text = await rewrite(createAstRewriteTool(cwd, { fileGuard }));
    expect(text).toContain("Rewrote 1000 matches in 1 files (rewrite limit reached");
    expect(fileGuard).toHaveBeenCalledTimes(2);
    expect(await readFile(join(cwd, "src/c-rest.ts"), "utf8")).toBe("legacy(3);\n");
  });

  it("leaves single-file writes and dry runs outside the per-file guard", async () => {
    const cwd = await project();
    const fileGuard = vi.fn(() => "blocked");
    const tool = createAstRewriteTool(cwd, { fileGuard });
    expect(await rewrite(tool, { ...input, dryRun: true } as typeof input)).toContain("Would rewrite 2 matches in 2 files");
    expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("legacy(1);\n");
    expect(await rewrite(tool, { ...input, path: "src/a-blocked.ts" })).toContain("Rewrote 1 matches in 1 files");
    expect(fileGuard).not.toHaveBeenCalled();
  });

  it("checks inside the mutation queue, after reading the latest matching content", async () => {
    const cwd = await project("unrelated(1);\n");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queued = withFileMutationQueue(join(cwd, "src/a-blocked.ts"), async () => {
      entered.resolve();
      await release.promise;
      await writeFile(join(cwd, "src/a-blocked.ts"), "legacy(1);\n");
    });
    await entered.promise;
    const fileGuard = vi.fn(() => undefined);
    const running = rewrite(createAstRewriteTool(cwd, { fileGuard }));
    try {
      expect(fileGuard).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await queued;
    }
    expect(await running).toContain("Rewrote 2 matches in 2 files");
    expect(fileGuard).toHaveBeenCalledTimes(2);
    expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("modern(1);\n");
  });

  it("forwards SessionOptions.writeFileGuard without invoking toolGuard per file", async () => {
    const cwd = await project();
    const f = await fauxRuntime();
    f.faux.setResponses([reply([call("ast_rewrite", input)], { stopReason: "toolUse" }), reply("done")]);
    const toolGuard = vi.fn(() => undefined);
    const writeFileGuard = vi.fn((path: string) => path === "src/a-blocked.ts" ? "session ownership block" : undefined);
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["ast_rewrite"], instructions: "test", toolGuard, writeFileGuard });
    try {
      await session.prompt("go");
      // Once for the call (with its tool call id, which ultra's integrity probes pair with the call's end), never per file.
      expect(toolGuard.mock.calls).toEqual([["ast_rewrite", input, expect.any(String)]]);
      expect(writeFileGuard).toHaveBeenCalledTimes(2);
      const result = session.messages.find(m => m.role === "toolResult");
      expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("src/a-blocked.ts: session ownership block") }] });
      expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("legacy(1);\n");
      expect(await readFile(join(cwd, "src/b-allowed.ts"), "utf8")).toBe("modern(2);\n");
    } finally {
      session.dispose();
    }
  });

  it("fails closed for guarded sessions without a per-file guard, allowing dry runs and single files", async () => {
    const cwd = await project();
    const f = await fauxRuntime();
    f.faux.setResponses([
      reply([call("ast_rewrite", input)], { stopReason: "toolUse" }),
      reply([call("ast_rewrite", { ...input, dryRun: true })], { stopReason: "toolUse" }),
      reply([call("ast_rewrite", { ...input, path: "src/b-allowed.ts" })], { stopReason: "toolUse" }),
      reply("done"),
    ]);
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["ast_rewrite"], instructions: "test", toolGuard: () => undefined });
    try {
      await session.prompt("go");
      const results = session.messages.filter(m => m.role === "toolResult");
      expect(results[0]).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("Skipped files:\nsrc/a-blocked.ts: Blocked: directory ast_rewrite requires a per-file write guard") }] });
      expect(results[1]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Would rewrite 2 matches in 2 files") }] });
      expect(results[2]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Rewrote 1 matches in 1 files") }] });
      expect(await readFile(join(cwd, "src/a-blocked.ts"), "utf8")).toBe("legacy(1);\n");
      expect(await readFile(join(cwd, "src/b-allowed.ts"), "utf8")).toBe("modern(2);\n");
    } finally {
      session.dispose();
    }
  });
});
