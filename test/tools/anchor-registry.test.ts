import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AnchorRegistry } from "../../src/tools/anchor-registry.js";
import { lineTag } from "../../src/tools/anchors.js";
import { createOrcheTools } from "../../src/tools/index.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);
async function setup(text = "head\nb\nc\nd\ntarget\nf\n", name = "a.txt") {
  const cwd = await tempWorkspace();
  const path = join(cwd, name);
  await writeFile(path, text);
  const tools = createOrcheTools({ cwd });
  const read = tools.find(t => t.name === "read")!;
  const edit = tools.find(t => t.name === "edit")!;
  const runRead = async (offset?: number, limit?: number, symbol?: string) => read.execute("r", { path: name, offset, limit, symbol }, undefined, undefined, undefined as never);
  const runEdit = async (edits: unknown[]) => {
    const result = await edit.execute("e", { path: name, edits }, undefined, undefined, undefined as never);
    return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
  };
  return { path, runRead, runEdit };
}
const at = (n: number, text: string) => `${n}#${lineTag(text)}`;

describe("own-edit anchor rebasing", () => {
  it("rebases a pre-edit anchor below a +2-line insertion and reports N->N+2", async () => {
    const s = await setup();
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "new1\nnew2" }]);
    const result = await s.runEdit([{ op: "replace", at: at(5, "target"), text: "TARGET" }]);
    expect(result).toContain("Rebased anchors from before your earlier edit: 5->7.");
    expect((await readFile(s.path, "utf8")).split("\n")[6]).toBe("TARGET");
  });
  it("rejects an anchor whose line an earlier edit replaced", async () => {
    const s = await setup();
    await s.runRead();
    await s.runEdit([{ op: "replace", at: at(5, "target"), text: "changed" }]);
    await expect(s.runEdit([{ op: "delete", at: at(5, "target") }]))
      .rejects.toThrow("line 5 was changed by your earlier edit; use the anchors printed after it");
    expect(await readFile(s.path, "utf8")).toContain("changed");
  });
  it("disables rebasing after an external fs.writeFile", async () => {
    const s = await setup();
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "new1\nnew2" }]);
    await writeFile(s.path, (await readFile(s.path, "utf8")) + "external\n");
    await expect(s.runEdit([{ op: "delete", at: at(5, "target") }])).rejects.toThrow("stale");
    expect(await readFile(s.path, "utf8")).toContain("target");
  });
  it("rejects echo anchors with distinct older images as ambiguous", async () => {
    const s = await setup("same\npadding\nsame\ntail\n");
    await s.runRead();
    const echo = await s.runEdit([{ op: "insert_before", at: "BOF", text: "new1\nnew2" }]);
    expect(echo).toContain(`${at(3, "same")}|same`);
    await expect(s.runEdit([{ op: "replace", at: at(3, "same"), text: "WRONG" }]))
      .rejects.toThrow(`line ${at(3, "same")} matches lines 3 and 5 after your edits; re-read the lines you want to change`);
    expect(await readFile(s.path, "utf8")).not.toContain("WRONG");
  });
  it.each(["}", "", " \t"])("rejects dup2 ambiguity including blank anchors: %j", async duplicate => {
    const s = await setup(`a\nb\nc\nd\ne\nf\n${duplicate}\ng\n`);
    await s.runRead();
    const old = duplicate.trim() ? at(7, duplicate) : "7";
    await s.runEdit([{ op: "insert_after", at: at(3, "c"), text: `p\nq\nr\n${duplicate}` }]);
    const before = await readFile(s.path, "utf8");
    await expect(s.runEdit([{ op: "replace", at: old, text: "WRONG" }]))
      .rejects.toThrow(`line ${old} matches lines 7 and 11 after your edits; re-read the lines you want to change`);
    expect(await readFile(s.path, "utf8")).toBe(before);
    // Reading just the ambiguous region makes both fresh anchors authoritative.
    await s.runRead(7, 5);
    const fresh11 = duplicate.trim() ? at(11, duplicate) : "11";
    const result = await s.runEdit([
      { op: "replace", at: old, text: "NEW" }, { op: "replace", at: fresh11, text: "OLD" },
    ]);
    expect(result).not.toContain("Rebased anchors");
    const lines = (await readFile(s.path, "utf8")).split("\n");
    expect(lines[6]).toBe("NEW"); expect(lines[10]).toBe("OLD");
  });
  it("accepts a fresh echo anchor when older showings map to the same line", async () => {
    const s = await setup();
    await s.runRead();
    await s.runEdit([{ op: "replace", at: at(4, "d"), text: "D" }]);
    const result = await s.runEdit([{ op: "replace", at: at(5, "target"), text: "TARGET" }]);
    expect(result).not.toContain("Rebased anchors");
    expect(await readFile(s.path, "utf8")).toContain("TARGET");
  });
  it.each(["5", "5| \t"])("rebases blank-line anchor %s", async anchor => {
    const s = await setup("head\nb\nc\nd\n \t\nf\n");
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "new1\nnew2" }]);
    const result = await s.runEdit([{ op: "replace", at: anchor, text: "BLANK" }]);
    expect(result).toContain("5->7");
    expect((await readFile(s.path, "utf8")).split("\n")[6]).toBe("BLANK");
  });
  it("validates against current text unchanged when no history exists", async () => {
    const s = await setup();
    const result = await s.runEdit([{ op: "replace", at: at(5, "target"), text: "TARGET" }]);
    expect(result).not.toContain("Rebased anchors");
    expect(await readFile(s.path, "utf8")).toContain("TARGET");
  });
  it("records stale-error excerpts as fresh anchors", async () => {
    const s = await setup();
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "new1\nnew2" }]);
    await expect(s.runEdit([{ op: "delete", at: "5#0000" }])).rejects.toThrow(`${at(5, "c")}|c`);
    const result = await s.runEdit([{ op: "replace", at: at(5, "c"), text: "C" }]);
    expect(result).not.toContain("Rebased anchors");
  });
  it("accepts all 27 fresh anchors after re-reading six repeated blocks (t6)", async () => {
    const text = Array.from({ length: 6 }, (_, i) => `function f${i}() {\n  return ${i};\n}\n`).join("\n");
    const s = await setup(text, "a.ts");
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "// h1\n// h2\n// h3\n// h4" }]);
    const fresh = await s.runRead();
    const lines = fresh.content.flatMap(part => part.type === "text" ? part.text.split("\n").filter(line => /^\d+[#|]/.test(line)) : []);
    expect(lines).toHaveLength(27);
    for (const line of lines) {
      const separator = line.indexOf("|");
      await expect(s.runEdit([{ op: "replace", at: line.slice(0, separator), text: line.slice(separator + 1) }]))
        .rejects.toThrow("it would not change the file");
    }
  });

  it("lets a current symbol read override older brace and blank showings", async () => {
    const s = await setup("function f0() {\n  return 0;\n\n}\nfunction f1() {\n  return 1;\n\n}\n", "a.ts");
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "// h1\n// h2\n// h3\n// h4" }]);
    await s.runRead(undefined, undefined, "f0");
    const result = await s.runEdit([{ op: "replace", at: "7", text: "  // blank" }, { op: "replace", at: at(8, "}"), text: "} // fresh" }]);
    expect(result).not.toContain("Rebased anchors");
    expect((await readFile(s.path, "utf8")).split("\n")[7]).toBe("} // fresh");
  });

  it.each(["}", ""])("accepts an echo anchor with no conflicting older showing: %j", async duplicate => {
    const s = await setup("head\nb\nc\ntail\n");
    await s.runRead();
    await s.runEdit([{ op: "insert_after", at: at(3, "c"), text: duplicate }]);
    const result = await s.runEdit([{ op: "replace", at: duplicate ? at(4, duplicate) : "4", text: "FRESH" }]);
    expect(result).not.toContain("Rebased anchors");
    expect((await readFile(s.path, "utf8")).split("\n")[3]).toBe("FRESH");
  });

  it.each(["target", ""])("rebases an old anchor far below an edit: %j", async target => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`); lines[79] = target;
    const s = await setup(lines.join("\n"));
    await s.runRead();
    await s.runEdit([{ op: "insert_before", at: "BOF", text: "h1\nh2\nh3\nh4" }]);
    const result = await s.runEdit([{ op: "replace", at: target ? at(80, target) : "80", text: "TARGET" }]);
    expect(result).toContain("80->84");
  });

  it.each(["}", ""])("does not let a stale-error excerpt override echo ambiguity: %j", async duplicate => {
    const s = await setup(`a\nb\nc\nd\ne\nf\n${duplicate}\ng\n`);
    await s.runRead();
    await s.runEdit([{ op: "insert_after", at: at(3, "c"), text: `p\nq\nr\n${duplicate}` }]);
    await expect(s.runEdit([{ op: "delete", at: "7#0000" }])).rejects.toThrow("stale");
    const anchor = duplicate ? at(7, duplicate) : "7";
    await expect(s.runEdit([{ op: "delete", at: anchor }])).rejects.toThrow("matches lines 7 and 11");
    await s.runRead(7, 1);
    await expect(s.runEdit([{ op: "replace", at: anchor, text: duplicate }])).rejects.toThrow("it would not change the file");
  });

});

describe("bounded registry", () => {
  it("starts an unmapped segment on external reads", () => {
    const registry = new AnchorRegistry();
    registry.recordShown("/f", "target\n", ["target"], [1]);
    registry.recordEdit("/f", "target\n", "new\ntarget\n", [{ start: 0, end: 0, lines: ["new"] }]);
    registry.recordShown("/f", "external\nnew\ntarget\n", ["external", "new", "target"], [1]);
    expect(registry.resolve("/f", "external\nnew\ntarget\n", { line: 1, tag: lineTag("target") })).toEqual({ line: 1 });
  });
  it("evicts versions beyond 16", () => {
    const registry = new AnchorRegistry();
    let text = "target\n";
    registry.recordShown("/f", text, ["target"], [1]);
    for (let i = 0; i < 16; i++) {
      const after = `new${i}\n` + text;
      registry.recordEdit("/f", text, after, [{ start: 0, end: 0, lines: [`new${i}`] }]);
      text = after;
    }
    expect(registry.resolve("/f", text, { line: 1, tag: lineTag("target") })).toEqual({ line: 1 });
  });
  it("bounds shown entries to 20,000 per file", () => {
    const registry = new AnchorRegistry();
    const lines = Array.from({ length: 20_001 }, (_, n) => `line${n}`);
    const text = lines.join("\n");
    registry.recordShown("/f", text, lines, lines.map((_, n) => n + 1));
    registry.recordEdit("/f", text, "new\n" + text, [{ start: 0, end: 0, lines: ["new"] }]);
    expect(registry.resolve("/f", "new\n" + text, { line: 1, tag: lineTag("line0") })).toEqual({ line: 1 });
    expect(registry.resolve("/f", "new\n" + text, { line: 2, tag: lineTag("line1") })).toEqual({ line: 3 });
  });
  it("evicts the least recently used file beyond 64", () => {
    const registry = new AnchorRegistry();
    for (let i = 0; i < 64; i++) {
      registry.recordShown(`/f${i}`, "target", ["target"], [1]);
      registry.recordEdit(`/f${i}`, "target", "new\ntarget", [{ start: 0, end: 0, lines: ["new"] }]);
    }
    registry.resolve("/f0", "new\ntarget", { line: 1, tag: lineTag("target") });
    registry.recordShown("/extra", "extra", ["extra"], [1]);
    expect(registry.resolve("/f0", "new\ntarget", { line: 1, tag: lineTag("target") })).toEqual({ line: 2 });
    expect(registry.resolve("/f1", "new\ntarget", { line: 1, tag: lineTag("target") })).toEqual({ line: 1 });
  });
});
