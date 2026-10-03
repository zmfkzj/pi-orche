import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AnchorRegistry } from "../../src/tools/anchor-registry.js";
import { lineTag } from "../../src/tools/anchors.js";
import { createReadTool, READ_MAX_BYTES, READ_MAX_LINES } from "../../src/tools/read.js";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);
const source = [
  "/** Widget documentation. */", "@decorate", "export class Widget {",
  "  /** Runs the widget. */", "  @memo()", "  run() {", "    return 1;", "", "  }",
  "  get value() { return 1; }", "  set value(v: number) {}", "}",
  "class Other {", "  run() { return 2; }", "}",
  "interface Shape { run(): void; }", "type ID = string;", "enum State { Ready }",
  "export const compute = () => 1;", "namespace Outer {", "  export function run() {}", "}",
  "export default function main() {}",
].join("\n") + "\n";
async function setup(text = source, path = "sample.ts") {
  const cwd = await tempWorkspace();
  await writeFile(join(cwd, path), text);
  const registry = new AnchorRegistry();
  const tool = createReadTool(cwd, registry);
  const read = async (args: Record<string, unknown>) => {
    const result = await tool.execute("r", { path, ...args }, undefined, undefined, undefined as never);
    return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
  };
  return { cwd, path, registry, read };
}
const anchorOf = (text: string, content: string) => text.split("\n").find(line => line.endsWith(`|${content}`))!.split("|")[0]!;

describe("read declaration modes", () => {
  it("prints a compact nested outline with ranges and no anchors or history", async () => {
    const s = await setup();
    const record = vi.spyOn(s.registry, "recordShown");
    const output = await s.read({ outline: true });
    expect(output).toMatch(/^sample\.ts: 23 lines, \d+ declarations\n3-12 class Widget/);
    expect(output).toContain("  6-9 method Widget.run");
    expect(output).toContain("16-16 interface Shape");
    expect(output).toContain("17-17 type ID");
    expect(output).toContain("18-18 enum State");
    expect(output).toContain("19-19 function compute");
    expect(output).toContain("20-22 namespace Outer");
    expect(output).toContain("23-23 default export main");
    expect(output).not.toMatch(/^\d+(?:#[0-9a-f]+)?\|/m);
    expect(record).not.toHaveBeenCalled();
  });
  it("caps outlines at 300 declarations", async () => {
    const s = await setup(Array.from({ length: 305 }, (_, n) => `function f${n}() {}`).join("\n"));
    const output = await s.read({ outline: true });
    expect(output).toContain("305 declarations");
    expect(output).toContain("function f299\n… 5 more");
    expect(output).not.toContain("function f300");
  });
  it("reads a dotted symbol including leading JSDoc/decorators and untagged blanks", async () => {
    const s = await setup();
    const output = await s.read({ symbol: "wIdGeT.rUn" });
    expect(output).toMatch(/^-- method run \(lines 4-9\)\n4#[0-9a-f]{4}\|  \/\*\* Runs the widget\. \*\//);
    expect(output).toContain(`5#${lineTag("  @memo()")}|  @memo()`);
    expect(output).toContain("8|\n");
    expect(output).not.toContain("return 2");
  });
  it("records symbol-read anchors so they can be rebased and edited in a real session", async () => {
    const s = await setup();
    const results = await runToolScript(s.cwd, ["read", "edit"], [
      () => ({ name: "read", args: { path: s.path, symbol: "Widget.run" } }),
      () => ({ name: "edit", args: { path: s.path, edits: [{ op: "insert_before", at: "BOF", text: "// new1\n// new2" }] } }),
      (_, all) => ({ name: "edit", args: { path: s.path, edits: [
        { op: "replace", at: anchorOf(all[0]!.text, "    return 1;"), text: "    return 3;" },
        { op: "replace", at: "8", text: "    // formerly blank" },
      ] } }),
    ]);
    expect(results.map(r => r.isError)).toEqual([false, false, false]);
    expect(results[2]!.text).toContain("Rebased anchors from before your earlier edit: 7->9, 8->10.");
    expect(results[2]!.text).toContain("|    return 3;");
    expect(results[2]!.text).toContain("|    // formerly blank");
  });
  it("prints every exact unqualified match and excludes nonmatching declarations", async () => {
    const s = await setup();
    const output = await s.read({ symbol: "run" });
    expect(output.match(/^-- /gm)).toHaveLength(4);
    expect(output).toContain("-- method run (lines 4-9)");
    expect(output).toContain("-- method run (lines 14-14)");
    expect(output).toContain("-- method run (lines 16-16)");
    expect(output).toContain("-- function run (lines 21-21)");
    expect(output).not.toContain("|type ID");
  });
  it("lists at most 20 similar names for a no-match error", async () => {
    const s = await setup(Array.from({ length: 25 }, (_, n) => `function symbol${n}() {}`).join("\n"));
    await expect(s.read({ symbol: "symbol_typo" })).rejects.toThrow(/No symbol matching "symbol_typo".*Similar names: symbol/);
    try { await s.read({ symbol: "symbol_typo" }); } catch (error) {
      const names = (error as Error).message.split("Similar names: ")[1]!.replace(/\.$/, "").split(", ");
      expect(names).toHaveLength(20);
    }
  });
  it("handles empty supported files in outline and no-match modes", async () => {
    const s = await setup("");
    expect(await s.read({ outline: true })).toBe("sample.ts: 0 lines, 0 declarations");
    await expect(s.read({ symbol: "missing" })).rejects.toThrow("Similar names: (none)");
  });
  it("uses Markdown section ranges, ignores fenced heading-like code, and matches heading text case-insensitively", async () => {
    const text = "# Guide\nintro\n## Setup\n```ts\n# Hidden\n```\nusage\n## Next\nend\n";
    const s = await setup(text, "guide.md");
    const outline = await s.read({ outline: true });
    expect(outline).toBe("guide.md: 9 lines, 3 declarations\n1-9 heading Guide\n  3-7 heading Setup\n  8-9 heading Next");
    const symbol = await s.read({ symbol: "sEtUp" });
    expect(symbol).toContain("-- heading Setup (lines 3-7)");
    expect(symbol).toContain(`5#${lineTag("# Hidden")}|# Hidden`);
    expect(symbol).not.toContain("|## Next");
  });
  it("prints duplicate Markdown headings as separate matches", async () => {
    const s = await setup("# Repeat\none\n# Repeat\ntwo\n", "guide.markdown");
    const output = await s.read({ symbol: "repeat" });
    expect(output.match(/^-- heading Repeat/gm)).toHaveLength(2);
    expect(output).toContain("(lines 1-2)");
    expect(output).toContain("(lines 3-4)");
  });
});

describe("read declaration validation and caps", () => {
  it.each([
    { outline: true, symbol: "Widget" },
  ])("rejects mutually exclusive options: %j", async args => {
    const s = await setup();
    await expect(s.read(args)).rejects.toThrow("mutually exclusive");
  });
  it.each([
    { outline: true, offset: 1 }, { outline: true, limit: 1 },
    { symbol: "Widget", offset: 1 }, { symbol: "Widget", limit: 1 },
  ])("rejects outline/symbol with offset/limit: %j", async args => {
    const s = await setup();
    await expect(s.read(args)).rejects.toThrow("cannot be combined with offset/limit");
  });
  it("allows outline:false as an ordinary read", async () => {
    const s = await setup("const x = 1;\n");
    expect(await s.read({ outline: false })).toMatch(/^1#[0-9a-f]{4}\|const x = 1;/);
  });
  it.each([{ outline: false, offset: 1 }, { outline: false, limit: 1 }, { outline: false, symbol: "Widget" }])("treats outline:false as unset: %j", async args => {
    const s = await setup();
    expect(await s.read(args)).toContain("Widget");
  });
  it.each(["", " ", "\t\n"])("rejects an empty or whitespace-only symbol: %j", async symbol => {
    const s = await setup();
    await expect(s.read({ symbol })).rejects.toThrow("symbol must be a non-empty name or heading");
  });
  it.each(["a.json", "a.py", "a.png"])("suggests offset/limit or grep for unsupported %s", async path => {
    const s = await setup("text", path);
    await expect(s.read({ outline: true })).rejects.toThrow("offset/limit or grep");
    await expect(s.read({ symbol: "x" })).rejects.toThrow("offset/limit or grep");
  });
  it("rejects outline and symbol files above 2 MB with a grep suggestion", async () => {
    const s = await setup("//" + "x".repeat(2 * 1024 * 1024));
    await expect(s.read({ outline: true })).rejects.toThrow("2 MB; use grep");
    await expect(s.read({ symbol: "x" })).rejects.toThrow("2 MB; use grep");
  });
  it("caps symbol output by line count and records only anchors actually printed", async () => {
    const text = ["function huge() {", ...Array.from({ length: 2100 }, (_, n) => `  // row${n}`), "}"].join("\n");
    const s = await setup(text);
    const record = vi.spyOn(s.registry, "recordShown");
    const output = await s.read({ symbol: "huge" });
    expect(output.split("\n\n")[0]!.split("\n")).toHaveLength(READ_MAX_LINES);
    expect(output.match(/^\d+#/gm)).toHaveLength(READ_MAX_LINES - 1);
    expect(output).toContain("Use offset=2000 with a normal read to continue");
    expect(record).toHaveBeenCalledOnce();
    expect([...record.mock.calls[0]![3]]).toHaveLength(READ_MAX_LINES - 1);
  });
  it("caps symbol output by bytes and prints a continuation notice", async () => {
    const text = ["function huge() {", ...Array.from({ length: 200 }, (_, n) => `  // ${n} ${"x".repeat(1000)}`), "}"].join("\n");
    const s = await setup(text);
    const output = await s.read({ symbol: "huge" });
    expect(Buffer.byteLength(output.split("\n\n")[0]!)).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(output).toMatch(/Symbol output cap: 2000 lines \/ 50KB\. Use offset=\d+ with a normal read/);
  });
  it("adds outline/symbol hints when normal reads hit the line cap, including oversized explicit limits", async () => {
    const s = await setup(Array.from({ length: 2100 }, (_, n) => `// ${n}`).join("\n"));
    for (const args of [{}, { limit: 2500 }]) {
      const output = await s.read(args);
      expect(output).toContain("(output cap)");
      expect(output).toContain("use outline: true, then symbol");
    }
  });
  it("adds the hint when normal reads hit the byte cap", async () => {
    const s = await setup(Array.from({ length: 100 }, (_, n) => `// ${n} ${"x".repeat(1000)}`).join("\n"));
    expect(await s.read({})).toContain("use outline: true, then symbol");
  });
  it("does not hint for explicit short ranges, complete reads, or unsupported capped files", async () => {
    const s = await setup();
    expect(await s.read({ limit: 2 })).not.toContain("Hint:");
    expect(await s.read({})).not.toContain("Hint:");
    const plain = await setup(Array.from({ length: 2100 }, (_, n) => `line${n}`).join("\n"), "plain.txt");
    expect(await plain.read({})).not.toContain("Hint:");
  });
});
