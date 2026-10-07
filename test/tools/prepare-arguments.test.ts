import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { coerceIntegerArguments } from "../../src/tools/prepare-arguments.js";
import { createReadTool } from "../../src/tools/read.js";
import { createFindTool } from "../../src/tools/find.js";
import { createAstSearchTool } from "../../src/tools/ast.js";
import { createBashHeartbeatTool } from "../../src/tools/bash.js";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

describe("coerceIntegerArguments", () => {
  const prepare = coerceIntegerArguments(["offset", "limit"]);
  it("turns integer strings of the listed keys into numbers and leaves everything else alone", () => {
    expect(prepare({ path: "a", offset: "290", limit: " 12 " })).toEqual({ path: "a", offset: 290, limit: 12 });
    expect(prepare({ offset: "-1" })).toEqual({ offset: -1 });
    for (const offset of ["1,", "ten", "1.5", "", " ", "1e3", "0x10", "99999999999999999999"])
      expect(prepare({ offset })).toEqual({ offset });
    expect(prepare({ path: "290" })).toEqual({ path: "290" });
  });
  it("returns the same object when nothing changes and never mutates the input", () => {
    const untouched = { path: "a", offset: 3 };
    expect(prepare(untouched)).toBe(untouched);
    const input = { offset: "3" };
    expect(prepare(input)).not.toBe(input);
    expect(input).toEqual({ offset: "3" });
    expect(prepare(undefined)).toBeUndefined();
    expect(prepare(["3"])).toEqual(["3"]);
  });
  it("runs the next hook on the coerced arguments", () => {
    const chained = coerceIntegerArguments(["limit"], args => ({ ...(args as object), seen: true }));
    expect(chained({ limit: "4" })).toEqual({ limit: 4, seen: true });
  });
});

describe("prepareArguments on orche tools", () => {
  it("survives pi's extension-tool wrapping (ToolDefinition -> AgentTool)", async () => {
    const cwd = await tempWorkspace();
    const tools = [createReadTool(cwd), createFindTool(cwd), createAstSearchTool(cwd), createBashHeartbeatTool({ cwd })];
    for (const tool of tools) {
      // The runner is only used lazily to build a tool context at execution time.
      const wrapped = wrapRegisteredTool({ definition: tool, sourceInfo: undefined } as never, {} as never);
      expect(wrapped.prepareArguments, tool.name).toBe(tool.prepareArguments);
    }
    expect(tools[0]!.prepareArguments!({ path: "a", offset: "290" })).toEqual({ path: "a", offset: 290 });
    expect(tools[1]!.prepareArguments!({ pattern: "*", limit: "5" })).toEqual({ pattern: "*", limit: 5 });
    expect(tools[2]!.prepareArguments!({ pattern: "x", limit: "5" })).toEqual({ pattern: "x", limit: 5 });
    expect(tools[3]!.prepareArguments!({ command: "true", timeout: "60" })).toEqual({ command: "true", timeout: 60 });
  });

  it("lets a real session accept string offset/limit for read and limit for find; other strings still fail validation", async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, "n.txt"), Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    await writeFile(join(cwd, "m.txt"), "x\n");
    const [read, find, bad] = await runToolScript(cwd, ["read", "find"], [
      () => ({ name: "read", args: { path: "n.txt", offset: "3", limit: " 2 " } }),
      () => ({ name: "find", args: { pattern: "*.txt", limit: "1" } }),
      () => ({ name: "read", args: { path: "n.txt", offset: "1," } }),
    ]);
    expect(read!.isError).toBe(false);
    expect(read!.text).toMatch(/^3#[0-9a-f]{4}\|l3\n4#[0-9a-f]{4}\|l4\n/);
    expect(find!.isError).toBe(false);
    expect(find!.text.split("\n").filter(line => line.endsWith(".txt"))).toHaveLength(1);
    expect(bad!.isError).toBe(true);
    expect(bad!.text).toContain("offset: must be number");
  });
});
