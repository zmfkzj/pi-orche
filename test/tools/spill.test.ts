import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewText, spillToolResult } from "../../src/tools/spill.js";
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
    expect(mid!.text).toMatch(/^\[L1\] 1\n\[L2\] 2\n/);
    expect(mid!.text).toContain("[L5000] 5000");
    const midArtifact = artifactPath(mid!.text)!;
    expect(await readFile(join(cwd, midArtifact), "utf8")).toBe(Array.from({ length: 5000 }, (_, i) => i + 1).join("\n") + "\n");

    expect(huge!.text.length).toBeLessThan(12_000);
    const hugeArtifact = (await readFile(join(cwd, artifactPath(huge!.text)!), "utf8")).split("\n");
    expect(hugeArtifact[0]).toBe("1");
    expect(hugeArtifact.at(-2)).toBe("40000");

    expect(small!.text.trim()).toBe("hi");
    expect(page!.isError).toBe(false);
    expect(page!.text).toMatch(/^39999#[0-9a-f]{4}\|39999\n40000#[0-9a-f]{4}\|40000/);
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

  it("bounds several MB of recovered full bash output with excess diagnostics and saves the whole artifact", async () => {
    const cwd = await tempWorkspace();
    const lines = Array.from({ length: 16_000 }, (_, i) => `ordinary row ${i} ${"x".repeat(220)}`);
    for (let i = 100; i < 160; i++) lines[i] = `Error: independent failure ${i}`;
    lines[8_000] = "full-output-private-sentinel";
    const full = lines.join("\n");
    expect(full.length).toBeGreaterThan(3 * 1024 * 1024);
    const file = join(cwd, "full-output.txt");
    await writeFile(file, full);
    const out = await spillToolResult({
      toolName: "bash", details: { fullOutputPath: file }, isError: true,
      content: [{ type: "text", text: "Pi tail only\n\nCommand exited with code 1" }],
    }, cwd);
    const text = (out!.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(11_000);
    expect(text).not.toContain(full);
    expect(text).not.toContain("full-output-private-sentinel");
    expect(text.match(/Error:/g)).toHaveLength(40);
    expect(text).toContain("20 more matching diagnostic lines omitted; grep the artifact");
    expect(text).toContain("Command exited with code 1");
    expect(out!.isError).toBe(true);
    expect(await readFile(join(cwd, artifactPath(text)!), "utf8")).toBe(full);
  });

  it("inlines only Pi's truncated text when recovered output has no applicable reduction", async () => {
    const cwd = await tempWorkspace();
    const full = "recovered output that must not be inlined";
    const file = join(cwd, "full-output.txt");
    await writeFile(file, full);
    const piText = "Pi truncated tail\n\nCommand aborted";
    const out = await spillToolResult({
      toolName: "bash", details: { fullOutputPath: file }, isError: true,
      content: [{ type: "text", text: piText }],
    }, cwd);
    const text = (out!.content[0] as { text: string }).text;
    expect(text).toBe(`${piText}\n\n[Output truncated: Pi output truncation. Full output saved to ${artifactPath(text)}; use read with offset/limit or grep to inspect it.]`);
    expect(text).not.toContain(full);
    expect(out!.isError).toBe(true);
    expect(await readFile(join(cwd, artifactPath(text)!), "utf8")).toBe(full);
  });

  it.each([
    ["5 MB single line", "x".repeat(5 * 1024 * 1024)],
    ["spaces", " ".repeat(200_000) + "x"],
    ["lint spaces", "1:1 error x" + " ".repeat(200_000)],
    ["digits", "a:" + "1".repeat(200_000)],
    ["passed words", "passed ".repeat(50_000)],
    ["unterminated ANSI", "\x1b[" + "0".repeat(200_000)],
  ])("spills %s in under 1.5 seconds with the complete artifact", async (_name, original) => {
    const cwd = await tempWorkspace();
    const start = performance.now();
    const out = await spillToolResult({ toolName: "bash", input: { command: "vitest" }, content: [{ type: "text", text: original! }] }, cwd);
    expect(performance.now() - start).toBeLessThan(1_500);
    const text = (out!.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(11_000);
    expect(await readFile(join(cwd, artifactPath(text)!), "utf8")).toBe(original);
  });

  it("reduces a 5 MB mixed fullOutputPath file in under 1.5 seconds without specializing", async () => {
    const cwd = await tempWorkspace();
    const original = ["Test Files 100 passed", "Error: decisive middle", "1:1 error " + " ".repeat(200_000), "x".repeat(5 * 1024 * 1024)].join("\n");
    const file = join(cwd, "full-output.txt");
    await writeFile(file, original);
    const start = performance.now();
    const out = await spillToolResult({ toolName: "bash", input: { command: "vitest" }, details: { fullOutputPath: file }, content: [{ type: "text", text: "Pi tail\n\nCommand exited with code 1" }], structuredContent: { output: original } }, cwd);
    expect(performance.now() - start).toBeLessThan(1_500);
    const text = (out!.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(11_000);
    expect(text).toContain("[L2] Error: decisive middle");
    expect(text).toContain("Command exited with code 1");
    expect(out).not.toHaveProperty("structuredContent");
    expect(await readFile(join(cwd, artifactPath(text)!), "utf8")).toBe(original);
  });


  it("bounds oversized Pi tails and status lines even when recovered text is small", async () => {
    const cwd = await tempWorkspace();
    const full = "recovered private output";
    const file = join(cwd, "full-output.txt");
    await writeFile(file, full);
    const out = await spillToolResult({ toolName: "bash", details: { fullOutputPath: file }, content: [{ type: "text", text: "Pi tail\nCommand exited " + "x".repeat(200_000) }] }, cwd);
    const text = (out!.content[0] as { text: string }).text;
    expect(text.split("\n\n[Output ")[0]!.length).toBeLessThan(10_500);
    expect(text).not.toContain(full);
    expect(await readFile(join(cwd, artifactPath(text)!), "utf8")).toBe(full);
  });

});
