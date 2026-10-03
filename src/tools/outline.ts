import { extname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 300;
const LANGUAGES: Record<string, Lang> = {
  ".ts": Lang.TypeScript, ".mts": Lang.TypeScript, ".cts": Lang.TypeScript,
  ".tsx": Lang.Tsx, ".js": Lang.JavaScript, ".jsx": Lang.JavaScript,
  ".mjs": Lang.JavaScript, ".cjs": Lang.JavaScript,
};
const markdown = (path: string) => [".md", ".markdown"].includes(extname(path).toLowerCase());

/** All ranges are 1-indexed and inclusive. docStartLine includes attached comments/decorators. */
export interface OutlineEntry {
  kind: string;
  name: string;
  qualifiedName: string;
  depth: number;
  startLine: number;
  endLine: number;
  docStartLine: number;
}

export function isOutlineSupported(path: string): boolean {
  return markdown(path) || Object.hasOwn(LANGUAGES, extname(path).toLowerCase());
}

/** Validate before parsing; returned messages point callers at non-outline alternatives. */
export function outlineTargetError(path: string, sizeBytes: number): string | undefined {
  if (!isOutlineSupported(path)) return `Outline/symbol reads do not support ${extname(path) || "this file type"}; use offset/limit or grep instead.`;
  if (sizeBytes > MAX_BYTES) return "Outline/symbol reads are limited to 2 MB; use grep instead.";
  return undefined;
}

function sourceLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return text === "" ? [] : lines;
}

function markdownOutline(text: string): OutlineEntry[] {
  const lines = sourceLines(text);
  const entries: OutlineEntry[] = [];
  const stack: { level: number; entry: OutlineEntry }[] = [];
  let fence: { char: string; length: number } | undefined;
  let previousWasText = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      previousWasText = false;
      continue;
    }
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      previousWasText = false;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)\s*|\s*)$/.exec(line);
    const setext = previousWasText ? /^ {0,3}(=+|-+)[ \t]*$/.exec(line) : null;
    if (atx || setext) {
      const level = atx ? atx[1]!.length : setext![1]![0] === "=" ? 1 : 2;
      const name = atx ? (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim() : lines[i - 1]!.trim();
      const startLine = atx ? i + 1 : i;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop()!.entry.endLine = startLine - 1;
      const entry: OutlineEntry = {
        kind: "heading", name, qualifiedName: name, depth: level - 1,
        startLine, endLine: lines.length, docStartLine: startLine,
      };
      entries.push(entry); stack.push({ level, entry }); previousWasText = false;
    } else previousWasText = !!line.trim() && !/^ {4}|^\t/.test(line);
  }
  return entries;
}

const DECLARATIONS: Record<string, string> = {
  function_declaration: "function", generator_function_declaration: "function", function_signature: "function",
  class_declaration: "class", abstract_class_declaration: "class",
  interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum",
  internal_module: "namespace", module: "namespace",
  method_definition: "method", method_signature: "method", abstract_method_signature: "method",
};
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

function nodeName(node: SgNode): string | undefined {
  const name = node.field("name")?.text();
  return name?.replace(/^(["'])(.*)\1$/, "$2").replace(/\s+/g, " ");
}

function bindingNames(node: SgNode): string[] {
  if (["identifier", "shorthand_property_identifier_pattern"].includes(String(node.kind()))) return [node.text()];
  if (String(node.kind()) === "pair_pattern") {
    const value = node.field("value");
    return value ? bindingNames(value) : [];
  }
  if (["assignment_pattern", "object_assignment_pattern"].includes(String(node.kind()))) {
    const left = node.field("left") ?? node.namedChildren()[0];
    return left ? bindingNames(left) : [];
  }
  return node.namedChildren().flatMap(bindingNames);
}

/** Use standalone adjacent comments/decorators, never a previous declaration's trailing comment. */
function documentationStart(node: SgNode, lines: string[], text: string): number {
  let start = node.range().start.line + 1;
  let current = node;
  for (let previous = current.prev(); previous; previous = current.prev()) {
    if (!["comment", "decorator"].includes(String(previous.kind()))) break;
    const before = previous.range(), after = current.range();
    const gap = text.slice(before.end.index, after.start.index);
    if (gap.trim() || (gap.match(/\n/g)?.length ?? 0) > 1) break;
    if (String(previous.kind()) === "comment" && lines[before.start.line]?.slice(0, before.start.column).trim()) break;
    start = before.start.line + 1; current = previous;
  }
  return start;
}

interface Work {
  node: SgNode;
  scope: string[];
  moduleLevel: boolean;
  wrapper?: SgNode;
}

async function scriptOutline(path: string, text: string): Promise<OutlineEntry[]> {
  const root = (await parseAsync(LANGUAGES[extname(path).toLowerCase()]!, text)).root();
  const lines = sourceLines(text);
  const entries: OutlineEntry[] = [];
  const pending: Work[] = [{ node: root, scope: [], moduleLevel: true }];
  let visited = 0;
  const pushChildren = (parent: SgNode, scope: string[], moduleLevel: boolean) => {
    for (const node of parent.namedChildren().reverse()) pending.push({ node, scope, moduleLevel });
  };
  const add = (work: Work, kind: string, name: string): OutlineEntry => {
    const node = work.wrapper ?? work.node;
    const range = node.range();
    // Some grammars include class decorators in the declaration itself. Show
    // declaration ranges from the first non-decorator token, but read the docs too.
    const firstToken = work.node.children().find((child) => !["decorator", "comment"].includes(String(child.kind())));
    const startLine = (firstToken ?? work.node).range().start.line + 1;
    const entry: OutlineEntry = {
      kind, name, qualifiedName: [...work.scope, name].join("."), depth: work.scope.length,
      startLine, endLine: Math.max(startLine, range.end.line + (range.end.column === 0 ? 0 : 1)),
      docStartLine: documentationStart(node, lines, text),
    };
    entries.push(entry); return entry;
  };
  while (pending.length) {
    // Parsing happens off-thread; yield during unusually large declaration walks too.
    if (++visited % 500 === 0) await setImmediate();
    const work = pending.pop()!;
    const { node, scope, moduleLevel } = work;
    const nodeKind = String(node.kind());
    if (nodeKind === "export_statement") {
      const declaration = node.field("declaration") ?? node.field("value");
      if (node.children().some((child) => String(child.kind()) === "default")) {
        const name = declaration ? nodeName(declaration) ?? "default" : "default";
        const entry = add({ ...work, node: declaration ?? node, wrapper: node }, "default export", name);
        const body = declaration?.field("body");
        if (body) pushChildren(body, [...scope, entry.name], false);
      } else if (declaration) pending.push({ ...work, node: declaration, wrapper: work.wrapper ?? node });
      continue;
    }
    if (nodeKind === "ambient_declaration") {
      for (const child of node.namedChildren().reverse()) if (String(child.kind()) !== "comment") pending.push({ ...work, node: child, wrapper: work.wrapper ?? node });
      continue;
    }
    const declarationKind = DECLARATIONS[nodeKind];
    if (declarationKind) {
      const name = nodeName(node);
      if (!name) continue;
      const tokens = node.children();
      const kind = declarationKind === "method" && tokens.some((child) => String(child.kind()) === "get") ? "getter"
        : declarationKind === "method" && tokens.some((child) => String(child.kind()) === "set") ? "setter" : declarationKind;
      const entry = add(work, kind, name);
      const body = node.field("body");
      if (body) pushChildren(body, [...scope, entry.name], kind === "namespace");
      continue;
    }
    if (nodeKind === "lexical_declaration") {
      if (!moduleLevel) continue;
      const kind = node.field("kind")?.text() === "let" ? "let" : "const";
      for (const variable of node.namedChildren()) {
        if (String(variable.kind()) !== "variable_declarator") continue;
        const nameNode = variable.field("name"), value = variable.field("value");
        if (!nameNode) continue;
        for (const name of bindingNames(nameNode)) {
          const entry = add(work, value && FUNCTION_VALUES.has(String(value.kind())) ? "function" : kind, name);
          const body = value && FUNCTION_VALUES.has(String(value.kind())) ? value.field("body") : undefined;
          if (body?.kind() === "statement_block") pushChildren(body, [...scope, entry.name], false);
        }
      }
      continue;
    }
    if (["public_field_definition", "field_definition"].includes(nodeKind)) {
      const value = node.field("value"), name = nodeName(node);
      if (name && value && FUNCTION_VALUES.has(String(value.kind()))) {
        const entry = add(work, "method", name), body = value.field("body");
        if (body?.kind() === "statement_block") pushChildren(body, [...scope, entry.name], false);
      }
      continue;
    }
    if (["program", "statement_block", "class_body", "interface_body"].includes(nodeKind)) pushChildren(node, scope, moduleLevel);
    else if (nodeKind === "expression_statement") {
      for (const child of node.namedChildren().reverse()) if (["internal_module", "module"].includes(String(child.kind()))) pending.push({ ...work, node: child, wrapper: work.wrapper ?? node });
    } else if (nodeKind.endsWith("statement") || nodeKind.endsWith("clause")) {
      // Nested declarations in control-flow blocks are not module-level bindings.
      for (const child of node.namedChildren().reverse()) if (String(child.kind()) === "statement_block" || String(child.kind()).endsWith("statement") || String(child.kind()).endsWith("clause")) pending.push({ node: child, scope, moduleLevel: false });
    }
  }
  return entries.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);
}

/** Pure text-to-declaration API; native parsing is asynchronous and never loads TypeScript. */
export async function buildOutline(path: string, text: string): Promise<OutlineEntry[]> {
  const error = outlineTargetError(path, Buffer.byteLength(text, "utf8"));
  if (error) throw new Error(error);
  return markdown(path) ? markdownOutline(text) : scriptOutline(path, text);
}

export function formatOutline(displayPath: string, totalLines: number, entries: OutlineEntry[]): string {
  const shown = entries.slice(0, MAX_ENTRIES).map((entry) => `${"  ".repeat(entry.depth)}${entry.startLine}-${entry.endLine} ${entry.kind} ${entry.qualifiedName}`);
  if (entries.length > MAX_ENTRIES) shown.push(`… ${entries.length - MAX_ENTRIES} more`);
  return [`${displayPath}: ${totalLines} lines, ${entries.length} declarations`, ...shown].join("\n");
}

export function findSymbols(entries: OutlineEntry[], query: string): OutlineEntry[] {
  const name = query.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase() === name || entry.qualifiedName.toLowerCase() === name);
}

/** Bounded, deterministic suggestions: prefer substring/prefix and shared name letters. */
export function similarNames(entries: OutlineEntry[], query: string, max = 20): string[] {
  const needle = query.toLowerCase().slice(0, 120);
  const score = (name: string) => {
    const lower = name.toLowerCase().slice(0, 120);
    let prefix = 0;
    while (prefix < Math.min(lower.length, needle.length) && lower[prefix] === needle[prefix]) prefix++;
    const shared = [...new Set(needle)].filter((char) => lower.includes(char)).length;
    return (lower.includes(needle) && needle ? 1_000 : 0) + prefix * 10 + shared - Math.abs(lower.length - needle.length);
  };
  return [...new Set(entries.map((entry) => entry.qualifiedName))]
    .map((name) => ({ name, score: score(name) }))
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.min(20, Math.max(0, Math.floor(max)))).map((entry) => entry.name);
}
