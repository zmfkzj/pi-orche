import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { Lang, parseAsync } from "@ast-grep/napi";
import { Type, type Static } from "@sinclair/typebox";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  anchorMatches, formatTaggedLine, parseAnchor, parseFileText,
  resolveWorkspacePath, serializeFile, type Anchor,
} from "./anchors.js";
import { AnchorRegistry } from "./anchor-registry.js";

const MAX_EDITS = 100;
const CONTEXT = 1;
const MAX_SHOWN_LINES = 40;

const editSchema = Type.Object({
  path: Type.String({ description: "File to edit (must already exist; use write to create files)" }),
  edits: Type.Array(
    Type.Object({
      op: Type.Union(
        [Type.Literal("replace"), Type.Literal("delete"), Type.Literal("insert_after"), Type.Literal("insert_before")],
        { description: "replace/delete the lines at..to; insert text after/before the line at" },
      ),
      at: Type.String({
        description: "Anchor from read: LINE#TAG (4–16 hex), or LINE for blank lines. Pasted lines accepted. Inserts also accept BOF / EOF.",
      }),
      to: Type.Optional(Type.String({ description: "Last anchor of the range for replace/delete (default: same as at)" })),
      text: Type.Optional(Type.String({ description: "New content (without anchor prefixes); newlines separate lines. Required for replace and insert." })),
    }),
    { description: "Edits against ONE snapshot; earlier-read anchors are mapped across your own edits when possible" },
  ),
});
type EditInput = Static<typeof editSchema>["edits"][number];
interface Change { start: number; end: number; lines: string[]; index: number }
type Resolver = (label: string, value: string | undefined) => number | undefined;

function toChange(edit: EditInput, index: number, lines: string[], problems: string[], resolve: Resolver): Change | undefined {
  const where = `edit[${index}]`;
  const body = edit.text === undefined ? undefined : edit.text.split(/\r?\n/);
  if ((edit.op === "replace" || edit.op.startsWith("insert")) && body === undefined) {
    problems.push(`${where}: op "${edit.op}" requires text`);
    return undefined;
  }
  if (edit.op === "insert_after" || edit.op === "insert_before") {
    if (edit.to !== undefined) problems.push(`${where}: "to" is only valid for replace/delete`);
    const edge = edit.at.trim().toUpperCase();
    if (edge === "BOF" || edge === "EOF") {
      const position = edge === "BOF" ? 0 : lines.length;
      return { start: position, end: position, lines: body!, index };
    }
    const line = resolve(`${where}.at`, edit.at);
    if (line === undefined) return undefined;
    const position = edit.op === "insert_after" ? line : line - 1;
    return { start: position, end: position, lines: body!, index };
  }
  const first = resolve(`${where}.at`, edit.at);
  const last = edit.to === undefined ? first : resolve(`${where}.to`, edit.to);
  if (first === undefined || last === undefined) return undefined;
  if (last < first) {
    problems.push(`${where}: "to" (line ${last}) is before "at" (line ${first})`);
    return undefined;
  }
  return { start: first - 1, end: last, lines: edit.op === "delete" ? [] : body!, index };
}

export function createEditTool(cwd: string, registry = new AnchorRegistry()): ToolDefinition {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit an existing file by read anchors (LINE#TAG, or LINE for blank lines). Earlier-read anchors are mapped across your own edits when possible; otherwise re-read. Stale anchors reject the whole call. All edits address one snapshot and apply atomically. ops: replace/delete at..to, insert_after/insert_before at (BOF/EOF allowed). The result shows compact changed regions with fresh anchors and advisory syntax feedback.",
    promptSnippet: "Edit a file by read anchors (own-edit rebasing; stale anchors rejected)",
    promptGuidelines: [
      "Always read a file before editing it; copy anchors verbatim from read output.",
      "All edits in one call address one snapshot. Earlier-read anchors map across your own edits when possible; otherwise re-read.",
    ],
    parameters: editSchema,
    async execute(_id, params: Static<typeof editSchema>, _signal, _onUpdate, ctx) {
      const absolute = resolveWorkspacePath(ctx?.cwd || cwd, params.path);
      if (params.edits.length === 0) throw new Error("edits is empty");
      if (params.edits.length > MAX_EDITS) throw new Error(`Too many edits (${params.edits.length}); the limit is ${MAX_EDITS} per call`);
      return withFileMutationQueue(absolute, async () => {
        const raw = await readFile(absolute, "utf8");
        const file = parseFileText(raw);
        const problems: string[] = [];
        const excerpts = new Set<number>();
        const rebased = new Set<string>();
        const historyResolve = registry.resolver(absolute, raw);
        const near = (n: number): string => [-1, 0, 1]
          .map(d => n + d).filter(n => n >= 1 && n <= file.lines.length)
          .map(n => { excerpts.add(n); return `    ${formatTaggedLine(n, file.lines[n - 1]!, 200)}`; }).join("\n");
        const resolve: Resolver = (label, value) => {
          if (value === undefined) return undefined;
          const parsed = parseAnchor(value);
          if (!parsed) {
            problems.push(`${label} "${value}" is not a LINE#TAG anchor (copy it from read output; blank lines accept LINE)`);
            return undefined;
          }
          const mapped = historyResolve(parsed);
          if (mapped.changed) {
            problems.push(`${label}: line ${parsed.line} was changed by your earlier edit; use the anchors printed after it. Current excerpt:\n${near(parsed.line)}`);
            return undefined;
          }
          const anchor: Anchor = { ...parsed, line: mapped.line };
          const current = file.lines[anchor.line - 1];
          const name = anchor.tag === undefined ? `${anchor.line}` : `${anchor.line}#${anchor.tag}`;
          if (current === undefined) {
            problems.push(`${label} ${name}: file has only ${file.lines.length} lines`);
            return undefined;
          }
          if (!anchorMatches(anchor, current)) {
            problems.push(anchor.tag === undefined
              ? `${label} ${name}: non-blank lines need LINE#TAG from read; the file now has:\n${near(anchor.line)}`
              : `${label} ${name} is stale; the file now has:\n${near(anchor.line)}`);
            return undefined;
          }
          if (anchor.line !== parsed.line) rebased.add(`${parsed.line}->${anchor.line}`);
          return anchor.line;
        };
        const changes = params.edits.map((edit, i) => toChange(edit, i, file.lines, problems, resolve))
          .filter((c): c is Change => c !== undefined);
        if (problems.length > 0) {
          if (excerpts.size) registry.recordShown(absolute, raw, file.lines, excerpts);
          throw new Error(`Edit rejected, no changes made:\n- ${problems.join("\n- ")}\nRe-read the file and retry with current anchors.`);
        }
        changes.sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start) || a.index - b.index);
        const out: string[] = [];
        const regions: Array<[number, number]> = [];
        let cursor = 0;
        for (const change of changes) {
          if (change.start < cursor)
            throw new Error(`Edit rejected, no changes made: edit[${change.index}] overlaps another edit`);
          out.push(...file.lines.slice(cursor, change.start));
          regions.push([out.length, out.length + change.lines.length]);
          out.push(...change.lines);
          cursor = change.end;
        }
        out.push(...file.lines.slice(cursor));
        const next = { ...file, lines: out, trailingNewline: file.lines.length === 0 ? true : file.trailingNewline };
        const nextText = serializeFile(next);
        if (nextText === raw) throw new Error("Edit rejected: it would not change the file");
        await writeFile(absolute, nextText);
        registry.recordEdit(absolute, raw, nextText, changes);
        const summary = summarize(params.path, file.lines.length, out, regions);
        registry.recordShown(absolute, nextText, out, summary.shown);
        const syntax = await syntaxNote(absolute, raw, nextText, regions);
        const rebase = rebased.size ? `\nRebased anchors from before your earlier edit: ${[...rebased].join(", ")}.` : "";
        return { content: [{ type: "text", text: summary.text + rebase + syntax }], details: undefined };
      });
    },
  };
}

function summarize(path: string, before: number, lines: string[], regions: Array<[number, number]>): { text: string; shown: number[] } {
  const wanted = new Set<number>();
  const omitted = new Map<number, { end: number; count: number }>();
  for (const [a, b] of regions) {
    const lo = Math.max(0, a - CONTEXT);
    const hi = Math.min(lines.length, b + CONTEXT);
    if (b - a > 8) {
      for (let i = lo; i < a + 2; i++) wanted.add(i);
      wanted.add(a + 2);
      omitted.set(a + 2, { end: b - 2, count: b - a - 4 });
      for (let i = b - 2; i < hi; i++) wanted.add(i);
    } else {
      for (let i = lo; i < hi; i++) wanted.add(i);
    }
  }
  const shown: number[] = [];
  const body: string[] = [];
  let previous = -1;
  for (const i of [...wanted].sort((a, b) => a - b)) {
    if (body.length >= MAX_SHOWN_LINES) break;
    const skip = omitted.get(i);
    if (skip) {
      body.push(`… [${skip.count} new lines not shown; read offset=${i + 1} limit=${skip.count} for their anchors] …`);
      previous = skip.end - 1;
      continue;
    }
    if (previous >= 0 && i > previous + 1) {
      body.push("...");
      if (body.length >= MAX_SHOWN_LINES) break;
    }
    body.push(formatTaggedLine(i + 1, lines[i]!, 300));
    shown.push(i + 1);
    previous = i;
  }
  return { text: `Edited ${path}: ${before} -> ${lines.length} lines. Current region (anchors are fresh):\n${body.join("\n")}`, shown };
}

async function syntaxNote(path: string, before: string, after: string, regions: Array<[number, number]>): Promise<string> {
  const extension = extname(path).toLowerCase();
  if (!/\.(?:[cm]?[tj]s|[tj]sx)$/.test(extension) || Math.max(Buffer.byteLength(before), Buffer.byteLength(after)) > 1024 * 1024) return "";
  try {
    const lang = extension === ".tsx" ? Lang.Tsx : /\.[cm]?ts$/.test(extension) ? Lang.TypeScript : Lang.JavaScript;
    const roots = await Promise.all([parseAsync(lang, before), parseAsync(lang, after)]);
    // Tree-sitter missing tokens appear as zero-width leaves; napi has no isMissing API.
    const errors = roots.map(root => root.root().findAll({ rule: { any: [{ kind: "ERROR" }, { regex: "^$" }] } })
      .filter(node => node.kind() === "ERROR" || (node.isLeaf() && node.kind() !== "program")));
    const count = errors[1]!.length - errors[0]!.length;
    if (count <= 0) return "";
    const locations = [...new Set(errors[1]!.map(n => n.range().start.line + 1))];
    const nearby = (n: number) => regions.some(([a, b]) => n >= a + 1 - 3 && n <= Math.max(a + 1, b) + 3);
    locations.sort((a, b) => Number(nearby(b)) - Number(nearby(a)) || a - b);
    return `\nSyntax check: ${count} new parse error(s) near line(s) ${locations.slice(0, 3).join(", ")}; the edit was applied, fix it if unintended.`;
  } catch { return ""; }
}
