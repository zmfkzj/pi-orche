import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lineTag } from "../../src/tools/anchors.js";
import { createOrcheTools } from "../../src/tools/index.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

type Edit = { op: string; at: string; to?: string; text?: string };
const RETRY_DIRECTLY = "retry with their LINE#TAG anchors directly (no re-read needed)";

async function setup(text: string) {
  const cwd = await tempWorkspace();
  const path = join(cwd, "a.txt");
  await writeFile(path, text);
  const tools = createOrcheTools({ cwd });
  const read = tools.find(t => t.name === "read")!;
  const edit = tools.find(t => t.name === "edit")!;
  return {
    path,
    read: async () => (await read.execute("r", { path: "a.txt" }, undefined, undefined, undefined as never)).content.map(c => c.type === "text" ? c.text : "").join(""),
    edit: (edits: Edit[]) => edit.execute("e", { path: "a.txt", edits }, undefined, undefined, undefined as never),
    /** The rejection text of an edit call (fails the test if the edit was applied). */
    reject: async (edits: Edit[]): Promise<string> => {
      try {
        await edit.execute("e", { path: "a.txt", edits }, undefined, undefined, undefined as never);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("edit was not rejected");
    },
  };
}
const anchorIn = (text: string, content: string) => {
  const line = text.split("\n").map(l => l.trim()).find(l => l.endsWith(`|${content}`));
  if (!line) throw new Error(`no line "${content}" in:\n${text}`);
  return line.slice(0, line.indexOf("|"));
};

describe("edit rejections that carry what the retry needs", () => {
  it("stale anchor after an external shift: the error shows where the content is now, and its anchor works without a re-read", async () => {
    const s = await setup("alpha\nbeta\ngamma\ndelta\n");
    const read = await s.read();
    await writeFile(s.path, "new1\nnew2\nnew3\nnew4\nalpha\nbeta\ngamma\ndelta\n");
    const message = await s.reject([{ op: "replace", at: anchorIn(read, "beta"), text: "BETA" }]);
    expect(message).toContain(`is stale; the file now has:`);
    expect(message).toContain(`A line with tag ${lineTag("beta")} is at line 6; if that is the line you meant, use 6#${lineTag("beta")}:`);
    expect(message).toContain(`6#${lineTag("beta")}|beta`);
    expect(message).toContain(RETRY_DIRECTLY);
    // Nothing was applied to the moved line by the rejection itself.
    expect(await readFile(s.path, "utf8")).toBe("new1\nnew2\nnew3\nnew4\nalpha\nbeta\ngamma\ndelta\n");
    await s.edit([{ op: "replace", at: anchorIn(message, "beta"), text: "BETA" }]);
    expect(await readFile(s.path, "utf8")).toBe("new1\nnew2\nnew3\nnew4\nalpha\nBETA\ngamma\ndelta\n");
  });

  it("stale anchor whose content moved by one line points at the excerpt line", async () => {
    const s = await setup("alpha\nbeta\ngamma\n");
    const read = await s.read();
    await writeFile(s.path, "zero\nalpha\nbeta\ngamma\n");
    const message = await s.reject([{ op: "delete", at: anchorIn(read, "beta") }]);
    expect(message).toContain(`use 3#${lineTag("beta")} (shown above).`);
    await s.edit([{ op: "delete", at: anchorIn(message, "beta") }]);
    expect(await readFile(s.path, "utf8")).toBe("zero\nalpha\ngamma\n");
  });

  it("does not guess when the stale tag is gone or ambiguous; edited content is never relocated", async () => {
    const s = await setup("x\nkeep\ny\n");
    const read = await s.read();
    await writeFile(s.path, "x\nkept\ny\n");
    const gone = await s.reject([{ op: "delete", at: anchorIn(read, "keep") }]);
    expect(gone).not.toContain("A line with tag");
    await writeFile(s.path, "dup\nx\ndup\n");
    const twice = await s.reject([{ op: "delete", at: `2#${lineTag("dup")}` }]);
    expect(twice).not.toContain("A line with tag");
    expect(await readFile(s.path, "utf8")).toBe("dup\nx\ndup\n");
  });

  it("bare LINE on a non-blank line names that line's LINE#TAG, which then works directly", async () => {
    const s = await setup("one\ntwo\nthree\n");
    const message = await s.reject([{ op: "replace", at: "2", text: "TWO" }]);
    expect(message).toContain(`non-blank lines need LINE#TAG from read; line 2 is 2#${lineTag("two")}.`);
    expect(message).toContain(RETRY_DIRECTLY);
    await s.edit([{ op: "replace", at: `2#${lineTag("two")}`, text: "TWO" }]);
    expect(await readFile(s.path, "utf8")).toBe("one\nTWO\nthree\n");
  });

  it("non-anchor values: a line number with a placeholder tag or quoted text show the current anchored lines", async () => {
    const s = await setup("function a() {}\nvoid emit(event, payload);\nfunction b() {}\n");
    const placeholder = await s.reject([{ op: "delete", at: "2#?" }]);
    expect(placeholder).toContain(`"2#?" is not a LINE#TAG anchor`);
    expect(placeholder).toContain(`line 2 is 2#${lineTag("void emit(event, payload);")} now:`);
    expect(placeholder).toContain(RETRY_DIRECTLY);
    const text = await s.reject([{ op: "delete", at: "void emit(...)" }]);
    expect(text).toContain("line containing that text:");
    expect(text).toContain(`2#${lineTag("void emit(event, payload);")}|void emit(event, payload);`);
    const nothing = await s.reject([{ op: "delete", at: "no such text" }]);
    expect(nothing).toContain("Re-read the file and retry with current anchors.");
    await s.edit([{ op: "delete", at: anchorIn(text, "void emit(event, payload);") }]);
    expect(await readFile(s.path, "utf8")).toBe("function a() {}\nfunction b() {}\n");
  });

  it("an anchor past the end shows the last lines", async () => {
    const s = await setup("a\nb\nc\n");
    const message = await s.reject([{ op: "delete", at: "99#0123" }]);
    expect(message).toContain("file has only 3 lines; the last lines are:");
    expect(message).toContain(`3#${lineTag("c")}|c`);
  });

  it("overlap errors name both edits and their line ranges", async () => {
    const s = await setup("a\nb\nc\nd\ne\n");
    const read = await s.read();
    const message = await s.reject([
      { op: "replace", at: anchorIn(read, "b"), to: anchorIn(read, "d"), text: "X" },
      { op: "insert_after", at: anchorIn(read, "a"), text: "fine" },
      { op: "delete", at: anchorIn(read, "c") },
    ]);
    expect(message).toBe("Edit rejected, no changes made: edit[2] (delete line 3) overlaps edit[0] (replace lines 2-4). All anchors are current; merge them into one edit or make the ranges disjoint and retry (no re-read needed).");
    expect(await readFile(s.path, "utf8")).toBe("a\nb\nc\nd\ne\n");
  });
});
