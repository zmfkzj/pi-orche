import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lineTag } from "../../src/tools/anchors.js";
import { createEditTool } from "../../src/tools/edit.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);
async function edit(text: string, edits: unknown[], path = "a.txt") {
  const cwd = await tempWorkspace();
  await writeFile(join(cwd, path), text);
  const result = await createEditTool(cwd).execute("e", { path, edits }, undefined, undefined, undefined as never);
  return { output: result.content.map(c => c.type === "text" ? c.text : "").join("\n"), text: await readFile(join(cwd, path), "utf8") };
}
const at = (line: number, content: string) => `${line}#${lineTag(content)}`;

describe("compact edit echo", () => {
  it("shows ±1 context and fresh anchors", async () => {
    const r = await edit("one\ntwo\nthree\nfour\nfive\n", [{ op: "replace", at: at(3, "three"), text: "THREE" }]);
    expect(r.output).toContain("Edited a.txt: 5 -> 5 lines. Current region (anchors are fresh):");
    expect(r.output).toContain("|two\n");
    expect(r.output).toContain("|THREE\n");
    expect(r.output).toContain("|four");
    expect(r.output).not.toContain("|one");
    expect(r.output).not.toContain("|five");
  });
  it("collapses >8 inserted lines to first/last two and a read marker", async () => {
    const body = Array.from({ length: 12 }, (_, n) => `new${n + 1}`).join("\n");
    const r = await edit("before\nafter\n", [{ op: "insert_after", at: at(1, "before"), text: body }]);
    expect(r.output).toContain("|new1\n");
    expect(r.output).toContain("|new2\n");
    expect(r.output).toContain("… [8 new lines not shown; read offset=4 limit=8 for their anchors] …");
    expect(r.output).toContain("|new11\n");
    expect(r.output).toContain("|new12\n");
    expect(r.output).not.toContain("|new3");
    expect(r.text).toBe(`before\n${body}\nafter\n`);
  });
  it("does not collapse exactly eight new lines", async () => {
    const r = await edit("before\n", [{ op: "insert_after", at: "EOF", text: Array.from({ length: 8 }, (_, n) => `n${n}`).join("\n") }]);
    expect(r.output).not.toContain("new lines not shown");
    expect(r.output.match(/^\d+#/gm)).toHaveLength(9);
  });
  it("caps the echo body at 40 shown lines", async () => {
    const lines = Array.from({ length: 100 }, (_, n) => `line${n}`);
    const r = await edit(lines.join("\n"), Array.from({ length: 25 }, (_, n) => ({
      op: "replace", at: at(n * 4 + 2, lines[n * 4 + 1]!), text: `changed${n}`,
    })));
    expect(r.output.split("\n").slice(1)).toHaveLength(40);
    expect(r.output.match(/^\d+#/gm)!.length).toBeLessThanOrEqual(40);
    expect(r.text).toContain("changed24");
  });
  it("clips individual echoed lines to 300 chars while preserving the tag", async () => {
    const body = "x".repeat(400);
    const r = await edit("old\n", [{ op: "replace", at: at(1, "old"), text: body }]);
    expect(r.output).toContain(`1#${lineTag(body)}|${"x".repeat(300)}…[+100 chars]`);
  });
});

describe("advisory edit syntax feedback", () => {
  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])("notes a newly broken %s edit without rejecting it", async extension => {
    const r = await edit("const x = 1;\n", [{ op: "replace", at: at(1, "const x = 1;"), text: "const x = ;" }], `a.${extension}`);
    expect(r.output).toContain("Syntax check: 1 new parse error(s) near line(s) 1; the edit was applied, fix it if unintended.");
    expect(r.text).toBe("const x = ;\n");
  });
  it("counts missing tokens as parse errors", async () => {
    const r = await edit("function f() {}\n", [{ op: "replace", at: at(1, "function f() {}"), text: "function f() {" }], "a.ts");
    expect(r.output).toContain("Syntax check: 1 new parse error(s)");
  });
  it("prints no syntax note for a valid edit", async () => {
    const r = await edit("const x = 1;\n", [{ op: "replace", at: at(1, "const x = 1;"), text: "const x = 2;" }], "a.ts");
    expect(r.output).not.toContain("Syntax check:");
  });
  it("prints no syntax note when an already-broken file gains no errors", async () => {
    const r = await edit("const x = ;\nconst y = 1;\n", [{ op: "replace", at: at(2, "const y = 1;"), text: "const y = 2;" }], "a.ts");
    expect(r.output).not.toContain("Syntax check:");
  });
  it("does not syntax-check other file types", async () => {
    const r = await edit("const x = 1;\n", [{ op: "replace", at: at(1, "const x = 1;"), text: "const x = ;" }]);
    expect(r.output).not.toContain("Syntax check:");
  });
  it("skips files over 1 MB", async () => {
    const r = await edit("const x = 1;\n//" + "a".repeat(1024 * 1024) + "\n", [{ op: "replace", at: at(1, "const x = 1;"), text: "const x = ;" }], "a.ts");
    expect(r.output).not.toContain("Syntax check:");
  });
});
