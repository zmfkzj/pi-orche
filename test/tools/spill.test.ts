import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { previewText } from "../../src/tools/spill.js";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

const artifactPath = (text: string) => /saved to (\.orche\/artifacts\/[\w.-]+\.txt)/.exec(text)?.[1];

describe("artifact spill", () => {
  it("spills long bash output (below and above Pi's own cap) to an artifact readable via read", async () => {
    const cwd = await tempWorkspace();
    const [mid, huge, small, page] = await runToolScript(cwd, ["bash", "read"], [
      () => ({ name: "bash", args: { command: "seq 1 5000" } }),
      () => ({ name: "bash", args: { command: "seq 1 40000" } }),
      () => ({ name: "bash", args: { command: "echo hi" } }),
      (_prev, all) => ({ name: "read", args: { path: artifactPath(all[1]!.text)!, offset: 39999, limit: 2 } }),
    ]);
    expect(mid!.text.length).toBeLessThan(12_000);
    expect(mid!.text).toContain("lines omitted from the middle");
    expect(mid!.text).toMatch(/^1\n2\n/);
    expect(mid!.text).toContain("\n5000\n");
    const midArtifact = artifactPath(mid!.text)!;
    expect(await readFile(join(cwd, midArtifact), "utf8")).toBe(Array.from({ length: 5000 }, (_, i) => i + 1).join("\n") + "\n");

    expect(huge!.text.length).toBeLessThan(12_000);
    const hugeArtifact = (await readFile(join(cwd, artifactPath(huge!.text)!), "utf8")).split("\n");
    expect(hugeArtifact[0]).toBe("1");
    expect(hugeArtifact.at(-2)).toBe("40000");

    expect(small!.text.trim()).toBe("hi");
    expect(page!.isError).toBe(false);
    expect(page!.text).toMatch(/^39999#[0-9a-f]{16}\|39999\n40000#[0-9a-f]{16}\|40000/);
    expect(page!.text).not.toContain("Output truncated");
    expect((await readdir(join(cwd, ".orche/artifacts"), { all: true } as never)).filter((n) => n.endsWith(".txt"))).toHaveLength(2);
  });

  it("keeps artifacts out of grep results", async () => {
    const cwd = await tempWorkspace();
    const [, grep] = await runToolScript(cwd, ["bash", "grep"], [
      () => ({ name: "bash", args: { command: "seq 1 5000" } }),
      () => ({ name: "grep", args: { pattern: "^4999$" } }),
    ]);
    expect(grep!.text).toMatch(/No matches/i);
  });

  it("keeps the exit status of spilled failing commands", async () => {
    const cwd = await tempWorkspace();
    const [failing] = await runToolScript(cwd, ["bash"], [
      () => ({ name: "bash", args: { command: "seq 1 3000 | sed 's/$/ line/' >&2; exit 3" } }),
    ]);
    expect(failing!.isError).toBe(true);
    expect(artifactPath(failing!.text)).toBeDefined();
    expect(failing!.text).toContain("Command exited with code 3");
  });
});

describe("previewText", () => {
  it("passes short text through and bounds long single-line text", () => {
    expect(previewText("a\nb")).toBeUndefined();
    const preview = previewText("x".repeat(100_000))!;
    expect(preview.length).toBeLessThan(3_000);
    expect(previewText("y\n".repeat(400))).toContain("lines omitted");
  });
});

describe("spillToolResult export", () => {
  it("returns undefined for small results and a truncated result with artifact for large ones", async () => {
    const { spillToolResult } = await import("../../src/tools/spill.js");
    const cwd = await tempWorkspace();
    expect(await spillToolResult({ toolName: "grep", content: [{ type: "text", text: "small" }] }, cwd)).toBeUndefined();
    const big = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n");
    const out = await spillToolResult({ toolName: "grep", content: [{ type: "text", text: big }] }, cwd);
    const text = (out!.content[0] as { text: string }).text;
    expect(text).toContain("lines omitted from the middle");
    expect(await readFile(join(cwd, artifactPath(text)!), "utf8")).toBe(big);
  });
});
