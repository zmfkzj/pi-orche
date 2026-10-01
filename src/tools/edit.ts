import { readFile, writeFile } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  formatTaggedLine,
  lineTag,
  parseAnchor,
  parseFileText,
  resolveWorkspacePath,
  serializeFile,
  type Anchor,
} from "./anchors.js";

const MAX_EDITS = 100;
const CONTEXT = 2;
const MAX_SHOWN_LINES = 80;

const editSchema = Type.Object({
  path: Type.String({ description: "File to edit (must already exist; use write to create files)" }),
  edits: Type.Array(
    Type.Object({
      op: Type.Union(
        [Type.Literal("replace"), Type.Literal("delete"), Type.Literal("insert_after"), Type.Literal("insert_before")],
        { description: "replace/delete the lines at..to; insert text after/before the line at" },
      ),
      at: Type.String({
        description: "Anchor LINE#TAG exactly as printed by read (a line number, #, 16 hex chars; e.g. 12#0123456789abcdef). Inserts also accept BOF / EOF.",
      }),
      to: Type.Optional(
        Type.String({ description: "Last LINE#TAG of the range for replace/delete (default: same as at)" }),
      ),
      text: Type.Optional(
        Type.String({ description: "New content (without LINE#TAG prefixes); newlines separate lines. Required for replace and insert." }),
      ),
    }),
    { description: "Edits against ONE snapshot of the file; line numbers refer to the last read, not to earlier edits in the list" },
  ),
});
type EditInput = Static<typeof editSchema>["edits"][number];

interface Change {
  start: number;
  end: number;
  lines: string[];
  index: number;
}

function resolveAnchor(label: string, value: string | undefined, lines: string[], problems: string[]): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseAnchor(value);
  if (!parsed) {
    problems.push(`${label} "${value}" is not a LINE#TAG anchor (copy it from read output)`);
    return undefined;
  }
  return checkAnchor(label, parsed, lines, problems);
}

function checkAnchor(label: string, anchor: Anchor, lines: string[], problems: string[]): number | undefined {
  const current = lines[anchor.line - 1];
  if (current === undefined) {
    problems.push(`${label} ${anchor.line}#${anchor.tag}: file has only ${lines.length} lines`);
    return undefined;
  }
  if (lineTag(current) !== anchor.tag) {
    const near = [-1, 0, 1]
      .map((d) => anchor.line + d)
      .filter((n) => n >= 1 && n <= lines.length)
      .map((n) => `    ${formatTaggedLine(n, lines[n - 1]!, 200)}`)
      .join("\n");
    problems.push(`${label} ${anchor.line}#${anchor.tag} is stale; the file now has:\n${near}`);
    return undefined;
  }
  return anchor.line;
}

function toChange(edit: EditInput, index: number, lines: string[], problems: string[]): Change | undefined {
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
    const line = resolveAnchor(`${where}.at`, edit.at, lines, problems);
    if (line === undefined) return undefined;
    const position = edit.op === "insert_after" ? line : line - 1;
    return { start: position, end: position, lines: body!, index };
  }
  const first = resolveAnchor(`${where}.at`, edit.at, lines, problems);
  const last = edit.to === undefined ? first : resolveAnchor(`${where}.to`, edit.to, lines, problems);
  if (first === undefined || last === undefined) return undefined;
  if (last < first) {
    problems.push(`${where}: "to" (line ${last}) is before "at" (line ${first})`);
    return undefined;
  }
  return { start: first - 1, end: last, lines: edit.op === "delete" ? [] : body!, index };
}

export function createEditTool(cwd: string): ToolDefinition {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit an existing file by line anchors. Anchors are LINE#TAG exactly as printed by read; a tag no longer matching the file is rejected and nothing is changed (re-read, then retry). All edits in one call address the file as last read and are applied atomically. ops: replace (lines at..to become text), delete (remove lines at..to), insert_after / insert_before (add text next to the line at; BOF/EOF allowed). To replace one line only, give at; for a block give at and to. The result shows the changed region with fresh anchors, so chained edits need no re-read.",
    promptSnippet: "Edit a file by LINE#TAG anchors from read (stale anchors are rejected)",
    promptGuidelines: [
      "Always read a file before editing it; copy anchors verbatim from read output.",
      "Edit anchors in one call refer to the last read snapshot; after a successful edit use the anchors the result prints.",
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
        const changes = params.edits
          .map((edit, i) => toChange(edit, i, file.lines, problems))
          .filter((c): c is Change => c !== undefined);
        if (problems.length > 0)
          throw new Error(
            `Edit rejected, no changes made:\n- ${problems.join("\n- ")}\nRe-read the file and retry with current anchors.`,
          );
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
        return {
          content: [{ type: "text", text: summarize(params.path, file.lines.length, out, regions) }],
          details: undefined,
        };
      });
    },
  };
}

function summarize(path: string, before: number, lines: string[], regions: Array<[number, number]>): string {
  const shown: number[] = [];
  let remaining = MAX_SHOWN_LINES;
  const spans: Array<[number, number]> = [];
  for (const [a, b] of regions) {
    const lo = Math.max(0, a - CONTEXT);
    const hi = Math.min(lines.length, b + CONTEXT);
    const prev = spans.at(-1);
    if (prev && lo <= prev[1]) prev[1] = Math.max(prev[1], hi);
    else spans.push([lo, hi]);
  }
  for (const [lo, hi] of spans) {
    if (shown.length > 0) shown.push(-1);
    for (let i = lo; i < hi && remaining > 0; i++, remaining--) shown.push(i);
  }
  const body = shown.map((i) => (i < 0 ? "..." : formatTaggedLine(i + 1, lines[i]!, 300))).join("\n");
  return `Edited ${path}: ${before} -> ${lines.length} lines. Current region (anchors are fresh):\n${body}`;
}
