import { describe, expect, it } from "vitest";
import {
  buildOutline, findSymbols, formatOutline, isOutlineSupported, outlineTargetError, similarNames,
  type OutlineEntry,
} from "../../src/tools/outline.js";

const source = [
  "/** Greets a caller. */", // 1
  "export function greet(name: string) {", // 2
  "  function inner() { return name; }", // 3
  "  const local = () => name;", // 4
  "  return inner();", // 5
  "}", // 6
  "", // 7
  "/** Widget documentation. */", // 8
  "@decorate", // 9
  "export class Widget {", // 10
  "  /** Runs the widget. */", // 11
  "  @memo()", // 12
  "  run() { return 1; }", // 13
  "  get value() { return 1; }", // 14
  "  set value(v: number) {}", // 15
  "  constructor() {}", // 16
  "  arrow = () => 2;", // 17
  "}", // 18
  "export interface Shape { run(): void; }", // 19
  "export type ID = string;", // 20
  "export enum State { Ready, Done }", // 21
  "export const compute = (x: number) => x + 1;", // 22
  "export const title = 'widget';", // 23
  "let callback = function () { return true; };", // 24
  "let mutable = 1;", // 25
  "namespace Outer {", // 26
  "  export class Inner {", // 27
  "    run() {}", // 28
  "  }", // 29
  "  export const value = 2;", // 30
  "}", // 31
  "export default function main() { return 1; }", // 32
].join("\n");
const entry = (entries: OutlineEntry[], name: string) => entries.find((e) => e.qualifiedName === name)!;

describe("script outlines", () => {
  it("lists TS declarations, nested class/methods, namespaces, getters/setters and function initializers", async () => {
    const entries = await buildOutline("example.ts", source);
    expect(entries.map((e) => [e.kind, e.qualifiedName])).toEqual([
      ["function", "greet"], ["function", "greet.inner"],
      ["class", "Widget"], ["method", "Widget.run"], ["getter", "Widget.value"], ["setter", "Widget.value"],
      ["method", "Widget.constructor"], ["method", "Widget.arrow"],
      ["interface", "Shape"], ["method", "Shape.run"], ["type", "ID"], ["enum", "State"],
      ["function", "compute"], ["const", "title"], ["function", "callback"], ["let", "mutable"],
      ["namespace", "Outer"], ["class", "Outer.Inner"], ["method", "Outer.Inner.run"], ["const", "Outer.value"],
      ["default export", "main"],
    ]);
    expect(entry(entries, "greet")).toMatchObject({ startLine: 2, endLine: 6, depth: 0, docStartLine: 1 });
    expect(entry(entries, "greet.inner")).toMatchObject({ startLine: 3, endLine: 3, depth: 1 });
    expect(entry(entries, "Widget")).toMatchObject({ startLine: 10, endLine: 18, docStartLine: 8 });
    expect(entry(entries, "Widget.run")).toMatchObject({ startLine: 13, endLine: 13, docStartLine: 11, depth: 1 });
    expect(entry(entries, "Outer.Inner.run")).toMatchObject({ startLine: 28, endLine: 28, depth: 2 });
    expect(entries.some((e) => e.name === "local")).toBe(false);
  });

  it("finds dotted symbols and all duplicate names, case-insensitively and exactly", async () => {
    const entries = await buildOutline("example.ts", source);
    expect(findSymbols(entries, "WIDGET.RUN").map((e) => e.qualifiedName)).toEqual(["Widget.run"]);
    expect(findSymbols(entries, "run").map((e) => e.qualifiedName)).toEqual(["Widget.run", "Shape.run", "Outer.Inner.run"]);
    expect(findSymbols(entries, "Widget.value").map((e) => e.kind)).toEqual(["getter", "setter"]);
    expect(findSymbols(entries, "gree")).toEqual([]);
    expect(similarNames(entries, "grete")[0]).toBe("greet");
    expect(similarNames(entries, "unknown")).toHaveLength(20);
    expect(similarNames(entries, "unknown", 3)).toHaveLength(3);
  });

  it("formats source ranges and nesting with a 300-entry cap and no anchors", async () => {
    const entries = await buildOutline("example.ts", source);
    const outline = formatOutline("example.ts", 32, entries);
    expect(outline).toContain("example.ts: 32 lines, 21 declarations\n2-6 function greet");
    expect(outline).toContain("  13-13 method Widget.run");
    expect(outline).toContain("    28-28 method Outer.Inner.run");
    expect(outline).not.toMatch(/\d+#|\d+\|/);
    const many = Array.from({ length: 305 }, (_, i) => ({ ...entries[0]!, name: `f${i}`, qualifiedName: `f${i}` }));
    const capped = formatOutline("many.ts", 305, many);
    expect(capped.split("\n")).toHaveLength(302);
    expect(capped).toContain("305 declarations");
    expect(capped).toContain("function f299\n… 5 more");
    expect(capped).not.toContain("function f300");
  });

  it("includes JSDoc and consecutive leading comments/decorators but not blank-separated or trailing comments", async () => {
    const text = [
      "// first leading comment", "/** second leading comment */", "export function documented() {}",
      "function preceding() {} // trailing", "function next() {}", "// detached", "", "function detached() {}",
      "/** decorated */", "@memo(", "  'value'", ")", "class Decorated {}",
    ].join("\n");
    const entries = await buildOutline("docs.ts", text);
    expect(entry(entries, "documented").docStartLine).toBe(1);
    expect(entry(entries, "next").docStartLine).toBe(5);
    expect(entry(entries, "detached").docStartLine).toBe(8);
    expect(entry(entries, "Decorated")).toMatchObject({ startLine: 13, docStartLine: 9 });
  });

  it("handles anonymous default exports, named default classes and their methods", async () => {
    const anonymous = await buildOutline("default.js", "/** default docs */\nexport default class { run() {} }");
    expect(anonymous).toMatchObject([
      { kind: "default export", name: "default", startLine: 2, endLine: 2, docStartLine: 1 },
      { kind: "method", qualifiedName: "default.run", depth: 1 },
    ]);
    const named = await buildOutline("named.ts", "export default class Named { run() {} }");
    expect(named.map((e) => [e.kind, e.qualifiedName])).toEqual([["default export", "Named"], ["method", "Named.run"]]);
    expect(await buildOutline("expression.js", "export default () => 1;")).toMatchObject([{ kind: "default export", name: "default" }]);
  });

  it("includes ambient declarations, overloads, destructuring, and nested control-flow declarations", async () => {
    const entries = await buildOutline("advanced.ts", [
      "declare namespace Lib { export function check(): void; const version: string; }",
      "abstract class Abstract { abstract run(): void; }",
      "function overload(x: number): number;", "function overload(x: number) { return x; }",
      "const { a, key: renamed, nested: { b }, c = 2, ...rest } = obj, [first, ...others] = list;",
      "function outer() { if (true) { function nested() {} const hidden = 1; } }",
    ].join("\n"));
    expect(entries.map((e) => e.qualifiedName)).toEqual([
      "Lib", "Lib.check", "Lib.version", "Abstract", "Abstract.run", "overload", "overload",
      "a", "renamed", "b", "c", "rest", "first", "others", "outer", "outer.nested",
    ]);
    expect(findSymbols(entries, "overload")).toHaveLength(2);
    expect(entry(entries, "Lib").docStartLine).toBe(1);
  });

  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])("supports the .%s grammar", async (extension) => {
    const text = ["tsx", "jsx"].includes(extension) ? "export const View = () => <main />;" : "export const work = () => 1;";
    expect(isOutlineSupported(`code.${extension}`)).toBe(true);
    expect(await buildOutline(`code.${extension}`, text)).toMatchObject([{ kind: "function" }]);
  });

  it("returns an empty outline for text without declarations, ignoring declaration-looking strings/comments", async () => {
    expect(await buildOutline("empty.ts", "// function fake() {}\nconsole.log('class Fake {}');")).toEqual([]);
    expect(formatOutline("empty.ts", 2, [])).toBe("empty.ts: 2 lines, 0 declarations");
  });
});

describe("markdown outlines", () => {
  it("lists heading section ranges and ignores backtick and tilde fenced heading-looking code", async () => {
    const text = [
      "# Guide", "intro", "## Setup", "details", "```ts", "# Not a heading", "## Nor this", "```", "### Run", "usage",
      "~~~", "# Also not a heading", "~~~~", "# Reference", "end",
    ].join("\n");
    const entries = await buildOutline("guide.md", text);
    expect(entries.map((e) => [e.name, e.startLine, e.endLine, e.depth])).toEqual([
      ["Guide", 1, 13, 0], ["Setup", 3, 13, 1], ["Run", 9, 13, 2], ["Reference", 14, 15, 0],
    ]);
    expect(findSymbols(entries, "sEtUp")).toMatchObject([{ kind: "heading", name: "Setup" }]);
    expect(findSymbols(entries, "Not a heading")).toEqual([]);
    expect(formatOutline("guide.md", 15, entries)).toContain("    9-13 heading Run");
  });

  it("supports setext headings, duplicate heading matches, closing hashes and CRLF", async () => {
    const text = "Title\r\n=====\r\n## Setup ##\r\ntext\r\n## Setup\r\nend\r\n";
    const entries = await buildOutline("guide.markdown", text);
    expect(entries.map((e) => [e.name, e.startLine, e.endLine])).toEqual([["Title", 1, 6], ["Setup", 3, 4], ["Setup", 5, 6]]);
    expect(findSymbols(entries, "setup")).toHaveLength(2);
    expect(similarNames(entries, "setu")[0]).toBe("Setup");
  });

  it("does not close a fence with a different marker or shorter run, or recognize indented code headings", async () => {
    const entries = await buildOutline("fences.MD", [
      "    # Indented code", "# Actual", "````", "```", "# Hidden", "~~~", "# Still hidden", "````", "## Visible",
    ].join("\n"));
    expect(entries.map((e) => e.name)).toEqual(["Actual", "Visible"]);
  });
});

describe("outline validation", () => {
  it("suggests offset/limit or grep for unsupported types and grep above two MB", async () => {
    expect(isOutlineSupported("image.png")).toBe(false);
    expect(outlineTargetError("data.json", 100)).toMatch(/offset\/limit or grep/);
    expect(outlineTargetError("code.ts", 2 * 1024 * 1024)).toBeUndefined();
    expect(outlineTargetError("code.ts", 2 * 1024 * 1024 + 1)).toMatch(/2 MB.*grep/);
    await expect(buildOutline("data.json", "{}")).rejects.toThrow(/offset\/limit or grep/);
    await expect(buildOutline("huge.md", "é".repeat(1024 * 1024 + 1))).rejects.toThrow(/2 MB.*grep/);
  });
});
