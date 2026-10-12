import { readFile, stat } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatTaggedLine, parseFileText, resolveWorkspacePath } from "./anchors.js";
import { AnchorRegistry } from "./anchor-registry.js";
import {
  buildOutline, findSymbols, formatOutline, isCodeOutlineSupported, isOutlineSupported, outlineTargetError, similarNames,
  type OutlineEntry,
} from "./outline.js";
import { coerceIntegerArguments } from "./prepare-arguments.js";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024;
/**
 * A read without offset/limit of a JS/TS file larger than this (roughly 4k tokens at 4 bytes per token) returns its
 * declaration outline first. `offset: 1` (or any offset/limit) reads the text as before; Markdown and other files are not affected.
 */
export const READ_OUTLINE_FIRST_BYTES = 16 * 1024;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)$/i;

const readSchema = Type.Object({
  path: Type.String({ description: "File path (relative to the workspace or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "First line to read, 1-indexed (default 1)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  outline: Type.Optional(Type.Boolean({ description: "List declarations/headings in JS/TS/Markdown (≤2 MB); excludes symbol and offset/limit" })),
  symbol: Type.Optional(Type.String({ description: "Read exact name, dotted name or Markdown heading (case-insensitive); excludes outline and offset/limit" })),
});

/**
 * A text result. `structuredContent` repeats the text for programmatic callers (codemode scripts), matching Pi's read
 * `outputSchema`: the text for text files, an image block for images.
 */
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, structuredContent: text });

/** Replaces Pi's read with anchored text, declaration outlines and symbol reads. */
export function createReadTool(cwd: string, registry = new AnchorRegistry()): ToolDefinition {
  const pi = createReadToolDefinition(cwd);
  return {
    name: "read",
    label: "read",
    description:
      "Read a file: non-blank lines print LINE#TAG|text (4 hex), blanks LINE|text; edit uses these anchors. Capped at 2000 lines / 50KB; continue with offset. Without offset/limit, a JS/TS file over 16KB returns its declaration outline first; offset: 1 reads its text. Use offset/limit for ranges, or outline:true then symbol for JS/TS/Markdown ≤2 MB. Outline/symbol exclude each other and offset/limit. Images are attachments.",
    promptSnippet: "Read anchored file ranges, declaration outlines or named symbols",
    promptGuidelines: [
      "Use read, not cat/sed, to examine files. Read what the task needs: after grep, read offset/limit around the matches; in a large JS/TS/Markdown file, outline then symbol. Read small files, images and documents you must read completely in full (Markdown is never outlined automatically).",
    ],
    parameters: readSchema,
    // Pi's read contract (string | { type: "image", data, mimeType, note }); codemode uses structuredContent only with it.
    outputSchema: pi.outputSchema,
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
      } else if (IMAGE_PATH.test(params.path)) return pi.execute(toolCallId, params, signal, onUpdate, ctx); // structuredContent: Pi's image block (or text when the image cannot be processed)
      const buffer = await readFile(absolute, { signal });
      if (buffer.subarray(0, 8000).includes(0))
        throw new Error(`${params.path} looks like a binary file; read only supports text and images`);
      const raw = buffer.toString("utf8");
      const { lines } = parseFileText(raw);
      if (declarationRead) {
        const entries = await buildOutline(params.path, raw);
        if (params.outline) return textResult(formatOutline(params.path, lines.length, entries));
        const matches = findSymbols(entries, params.symbol!);
        if (!matches.length) {
          const names = similarNames(entries, params.symbol!);
          throw new Error(`No symbol matching "${params.symbol}" in ${params.path}. Similar names: ${names.length ? names.join(", ") : "(none)"}.`);
        }
        const result = symbolRead(lines, matches);
        registry.recordShown(absolute, raw, lines, result.shown);
        return textResult(result.text);
      }
      if (params.offset === undefined && params.limit === undefined) {
        const first = await outlineFirst(params.path, buffer.length, raw, lines.length);
        if (first) return textResult(first);
      }
      registry.recordShown(absolute, raw, lines, []);
      if (lines.length === 0) return textResult("(empty file)");
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
      return textResult(out.join("\n") + notice + hint);
    },
  };
}

/**
 * The first view of a bare read of a large JS/TS file: its declaration outline and how to read on, or undefined to read
 * the text as before (small, unsupported or over the outline limit, or fewer than two declarations to choose from).
 * Nothing enters anchor history; the model reads a symbol or a range next, which returns anchors for edit.
 */
async function outlineFirst(path: string, sizeBytes: number, raw: string, totalLines: number): Promise<string | undefined> {
  if (sizeBytes <= READ_OUTLINE_FIRST_BYTES || !isCodeOutlineSupported(path) || outlineTargetError(path, sizeBytes)) return undefined;
  const entries = await buildOutline(path, raw);
  if (entries.length < 2) return undefined;
  return `${formatOutline(path, totalLines, entries)}\n\n[${path} is ${Math.round(sizeBytes / 1024)}KB, so this read without offset/limit shows `
    + "its declaration outline instead of the text. Next: symbol for a declaration, offset/limit for a range (for example "
    + "around a grep match), or offset: 1 for the text from the start.]";
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
