import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anchorMatches, formatTaggedLine, lineHash, lineTag, parseAnchor, TAG_LENGTH } from "../../src/tools/anchors.js";
import { createOrcheTools } from "../../src/tools/index.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

describe("compact anchors", () => {
  it("prints exact SHA-256 prefixes and untagged empty/whitespace lines", () => {
    expect(TAG_LENGTH).toBe(4);
    expect(lineTag("hello")).toBe("2cf2");
    expect(formatTaggedLine(1, "hello")).toBe("1#2cf2|hello");
    expect(formatTaggedLine(2, "")).toBe("2|");
    expect(formatTaggedLine(3, " \t")).toBe("3| \t");
  });
  it.each(["2", "2|", "2| \t"])("parses blank anchor %s", value => {
    expect(parseAnchor(value)).toEqual({ line: 2, tag: undefined });
  });
  it.each(["1#ABCD", "1#ABCD|pasted", "1#ABCDEF0123456789"])("accepts 4–16 case-insensitive hex: %s", value => {
    expect(parseAnchor(value)?.tag).toBe(value.split("#")[1]!.split("|")[0]!.toLowerCase());
  });
  it.each(["1#abc", "1#abcdef01234567890", "1#zzzz", "1#", "1#abcdx"])("rejects malformed tags: %s", value => {
    expect(parseAnchor(value)).toBeUndefined();
  });
  it("validates old 16-hex anchors using the full line hash", () => {
    expect(anchorMatches(parseAnchor(`1#${lineHash("hello").slice(0, 16)}`)!, "hello")).toBe(true);
    expect(anchorMatches(parseAnchor("1")!, "hello")).toBe(false);
  });
  it("reads blanks without tags, edits pasted blank lines, and keeps old anchors working", async () => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "a.txt");
    await writeFile(path, "hello\n \t\n\nend\n");
    const tools = createOrcheTools({ cwd });
    const read = tools.find(t => t.name === "read")!;
    const edit = tools.find(t => t.name === "edit")!;
    const result = await read.execute("r", { path: "a.txt" }, undefined, undefined, undefined as never);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("2| \t\n3|\n") }]);
    await edit.execute("e", { path: "a.txt", edits: [
      { op: "replace", at: "2| \t", text: "blank replaced" },
      { op: "replace", at: `1#${lineHash("hello").slice(0, 16).toUpperCase()}|hello`, text: "old compatible" },
    ] }, undefined, undefined, undefined as never);
    expect(await readFile(path, "utf8")).toBe("old compatible\nblank replaced\n\nend\n");
  });
  it("rejects bare N on a non-blank line and prints its current anchor", async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, "a.txt"), "hello\n");
    const edit = createOrcheTools({ cwd }).find(t => t.name === "edit")!;
    await expect(edit.execute("e", { path: "a.txt", edits: [{ op: "delete", at: "1" }] }, undefined, undefined, undefined as never))
      .rejects.toThrow(/non-blank lines need LINE#TAG from read[\s\S]*1#2cf2\|hello/);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("hello\n");
  });
});
