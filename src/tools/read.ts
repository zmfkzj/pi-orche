import { readFile, stat } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatTaggedLine, parseFileText, resolveWorkspacePath } from "./anchors.js";
import { AnchorRegistry } from "./anchor-registry.js";
import {
  buildOutline, findSymbols, formatOutline, isOutlineSupported, outlineTargetError, similarNames,
  type OutlineEntry,
} from "./outline.js";
import { coerceIntegerArguments } from "./prepare-arguments.js";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)$/i;

const readSchema = Type.Object({
  path: Type.String({ description: "File path (relative to the workspace or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "First line to read, 1-indexed (default 1)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  outline: Type.Optional(Type.Boolean({ description: "List declarations/headings in JS/TS/Markdown (≤2 MB); excludes symbol and offset/limit" })),
  symbol: Type.Optional(Type.String({ description: "Read exact name, dotted name or Markdown heading (case-insensitive); excludes outline and offset/limit" })),
});

/** Replaces Pi's read with anchored text, declaration outlines and symbol reads. */
export function createReadTool(cwd: string, registry = new AnchorRegistry()): ToolDefinition {
  const pi = createReadToolDefinition(cwd);
  return {
    name: "read",
    label: "read",
    description:
      "Read a file: non-blank lines print LINE#TAG|text (4 hex), blanks LINE|text; edit uses these anchors. Capped at 2000 lines / 50KB; continue with offset. Use offset/limit for ranges, or outline:true then symbol for JS/TS/Markdown ≤2 MB. Outline/symbol exclude each other and offset/limit. Images are attachments.",
    promptSnippet: "Read anchored file ranges, declaration outlines or named symbols",
    promptGuidelines: [
      "Use read, not cat/sed, to examine files; use offset/limit or outline then symbol instead of reading huge files whole.",
    ],
    parameters: readSchema,
    // Models sometimes send offset/limit as strings ("290"); pi validates after this hook.
    prepareArguments: coerceIntegerArguments(["offset", "limit"]),
    async execute(toolCallId, params: Static<typeof readSchema>, signal, onUpdate, ctx) {
      const root = ctx?.cwd || cwd;
      if (params.symbol !== undefined && !params.symbol.trim())
        throw new Error("symbol must be a non-empty name or heading (not whitespace)");
      if (params.outline === true && params.symbol !== undefined)
        throw new Error("outline and symbol are mutually exclusive");
      if ((params.outline === true || params.symbol !== undefined) && (params.offset !== undefined || params.limit !== undefined))
        throw new Error("outline/symbol cannot be combined with offset/limit");
      const declarationRead = params.outline === true || params.symbol !== undefined;
      const absolute = resolveWorkspacePath(root, params.path);
      if (declarationRead) {
        const typeError = outlineTargetError(params.path, 0);
        if (typeError) throw new Error(typeError);
        const error = outlineTargetError(params.path, (await stat(absolute)).size);
        if (error) throw new Error(error);
      } else if (IMAGE_PATH.test(params.path)) return pi.execute(toolCallId, params, signal, onUpdate, ctx);
      const buffer = await readFile(absolute, { signal });
      if (buffer.subarray(0, 8000).includes(0))
        throw new Error(`${params.path} looks like a binary file; read only supports text and images`);
      const raw = buffer.toString("utf8");
      const { lines } = parseFileText(raw);
      if (declarationRead) {
        const entries = await buildOutline(params.path, raw);
        if (params.outline) return { content: [{ type: "text", text: formatOutline(params.path, lines.length, entries) }], details: undefined };
        const matches = findSymbols(entries, params.symbol!);
        if (!matches.length) {
          const names = similarNames(entries, params.symbol!);
          throw new Error(`No symbol matching "${params.symbol}" in ${params.path}. Similar names: ${names.length ? names.join(", ") : "(none)"}.`);
        }
        const result = symbolRead(lines, matches);
        registry.recordShown(absolute, raw, lines, result.shown);
        return { content: [{ type: "text", text: result.text }], details: undefined };
      }
      registry.recordShown(absolute, raw, lines, []);
      if (lines.length === 0) return { content: [{ type: "text", text: "(empty file)" }], details: undefined };
      const start = Math.max(1, Math.floor(params.offset ?? 1));
      if (start > lines.length)
        throw new Error(`Offset ${start} is beyond the end of the file (${lines.length} lines)`);
      const requested = params.limit === undefined ? Infinity : Math.max(1, Math.floor(params.limit));
      const wanted = Math.min(READ_MAX_LINES, requested);
      const out: string[] = [];
      let bytes = 0;
      let last = start - 1;
      for (let n = start; n <= lines.length && out.length < wanted; n++) {
        const text = formatTaggedLine(n, lines[n - 1]!);
        bytes += Buffer.byteLength(text) + 1;
        if (bytes > READ_MAX_BYTES && out.length > 0) break;
        out.push(text);
        last = n;
      }
      const capped = last < lines.length && out.length < requested;
      const notice = last < lines.length
        ? `\n\n[Showing lines ${start}-${last} of ${lines.length}${capped ? " (output cap)" : ""}. Use offset=${last + 1} to continue.]`
        : "";
      const hint = capped && isOutlineSupported(params.path)
        ? "\n[Hint: use outline: true, then symbol to read a declaration or heading.]"
        : "";
      registry.recordShown(absolute, raw, lines, Array.from({ length: last - start + 1 }, (_, i) => start + i));
      return { content: [{ type: "text", text: out.join("\n") + notice + hint }], details: undefined };
    },
  };
}

/** Headers count toward the normal output caps; only anchored lines enter history. */
function symbolRead(lines: string[], entries: OutlineEntry[]): { text: string; shown: number[] } {
  const out: string[] = [];
  const shown: number[] = [];
  let bytes = 0;
  let nextOffset: number | undefined;
  const append = (text: string): boolean => {
    const size = Buffer.byteLength(text) + 1;
    if (out.length >= READ_MAX_LINES || bytes + size > READ_MAX_BYTES) return false;
    out.push(text);
    bytes += size;
    return true;
  };
  matches: for (const entry of entries) {
    if (!append(`-- ${entry.kind} ${entry.name} (lines ${entry.docStartLine}-${entry.endLine})`)) {
      nextOffset = entry.docStartLine;
      break;
    }
    for (let n = entry.docStartLine; n <= entry.endLine; n++) {
      if (!append(formatTaggedLine(n, lines[n - 1]!))) {
        nextOffset = n;
        break matches;
      }
      shown.push(n);
    }
  }
  const notice = nextOffset === undefined ? ""
    : `\n\n[Symbol output cap: ${READ_MAX_LINES} lines / ${READ_MAX_BYTES / 1024}KB. Use offset=${nextOffset} with a normal read to continue.]`;
  return { text: out.join("\n") + notice, shown };
}
