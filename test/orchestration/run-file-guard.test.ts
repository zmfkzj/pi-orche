import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import type { TaskItem } from "../../src/orchestration/backlog.js";
import { createPhaseState } from "../../src/orchestration/phases.js";
import { guardWriteFile, spawnWorker } from "../../src/orchestration/run/context.js";
import { defaultRunLimits, type RunContext } from "../../src/orchestration/run/types.js";
import * as rootOwnership from "../../src/orchestration/run/root-ownership.js";
import { fauxRuntime } from "../helpers/faux.js";
import { cleanupWorkspaces, tempWorkspace } from "../tools/harness.js";

const managers: AgentManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) await manager.dispose();
  await cleanupWorkspaces();
});

async function fixture(root = false) {
  const cwd = await tempWorkspace();
  await mkdir(join(cwd, "src/a"), { recursive: true });
  await writeFile(join(cwd, "src/a/allowed.ts"), "legacy(1);\n");
  await writeFile(join(cwd, "src/a/blocked.ts"), "legacy(2);\n");
  const f = await fauxRuntime();
  const manager = new AgentManager(f.runtime);
  managers.push(manager);
  const tasks: TaskItem[] = [
    { id: "own", owner: "A1", description: "own", files: [root ? "/" : "src/a/"], status: "running" },
    // Deliberately invalid overlap: even an unvalidated backlog must fail closed per file.
    { id: "other", owner: "A2", description: "other", files: ["src/a/blocked.ts"], status: "running" },
  ];
  const enter = vi.fn(async (_id: string, _name: string) => {});
  const sink = vi.fn();
  const ctx = {
    options: { problem: "p", cwd, routes: { routes: {}, default: { model: f.route.model } }, sink },
    limits: defaultRunLimits, startedAt: Date.now(), state: { ...createPhaseState(2, 3), tasks }, manager,
    activity: { enter, record: vi.fn() }, cancelled: false,
  } as unknown as RunContext;
  return { ctx, f, cwd, enter, sink };
}

describe("multi-run directory rewrite per-file guard", () => {
  it.each([false, true])("wires a pure per-file guard through worker startup (root scope: %s)", async root => {
    const { ctx, f, cwd, enter, sink } = await fixture(root);
    f.faux.setResponses([
      reply([call("ast_rewrite", { path: "src/a", pattern: "legacy($A)", replacement: "modern($A)" })], { stopReason: "toolUse" }),
      reply([call("report_result", { kind: "implement", summary: "done" })], { stopReason: "toolUse" }),
    ]);
    await spawnWorker(ctx, { id: "A1", role: "implementer", cwd, route: f.route, tools: ["ast_rewrite"], instructions: "test" });
    const session = ctx.manager.session("A1");
    ctx.manager.assign("A1", "implement", "go");
    expect(await ctx.manager.wait("A1", 3000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "ast_rewrite");
    expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("Rewrote 1 matches in 1 files") }] });
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Skipped files:\nsrc/a/blocked.ts: Blocked: src/a/blocked.ts is owned by another worker") }] });
    expect(await readFile(join(cwd, "src/a/allowed.ts"), "utf8")).toBe("modern(1);\n");
    expect(await readFile(join(cwd, "src/a/blocked.ts"), "utf8")).toBe("legacy(2);\n");
    // Only the tool-level guard enters activity; neither matching file enters it again.
    expect(enter.mock.calls.filter(([, name]) => name === "ast_rewrite")).toEqual([["A1", "ast_rewrite"]]);
    expect(sink.mock.calls.some(([event]) => event.type === "ownership_blocked")).toBe(false);
  });

  it("allows or blocks files without activity gating or ownership_blocked events", async () => {
    const { ctx, enter, sink } = await fixture();
    vi.spyOn(ctx.manager, "list").mockReturnValue([{ id: "A1", currentAssignment: { kind: "implement" } }] as ReturnType<AgentManager["list"]>);
    expect(await guardWriteFile(ctx, "A1", "src/a/allowed.ts")).toBeUndefined();
    expect(await guardWriteFile(ctx, "A1", "src/a/blocked.ts")).toContain("owned by another worker");
    expect(enter).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it.each(["run", "run signal", "tool signal"])("returns the cancellation message before resolving files (%s)", async source => {
    const { ctx, enter, sink } = await fixture();
    const controller = new AbortController();
    controller.abort();
    if (source === "run") ctx.cancelled = true;
    if (source === "run signal") ctx.signal = controller.signal;
    const check = vi.spyOn(rootOwnership, "checkRootWrite");
    expect(await guardWriteFile(ctx, "A1", "src/a/allowed.ts", source === "tool signal" ? controller.signal : undefined)).toBe("Run cancelled: no further tool writes are accepted");
    expect(check).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after pending filesystem resolution", async () => {
    const { ctx, enter, sink } = await fixture();
    const checked = Promise.withResolvers<undefined>();
    vi.spyOn(rootOwnership, "checkRootWrite").mockReturnValueOnce(checked.promise);
    const pending = guardWriteFile(ctx, "A1", "src/a/allowed.ts");
    ctx.cancelled = true;
    checked.resolve(undefined);
    expect(await pending).toBe("Run cancelled: no further tool writes are accepted");
    expect(enter).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });
});
