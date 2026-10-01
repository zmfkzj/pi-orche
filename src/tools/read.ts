import { readFile } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatTaggedLine, parseFileText, resolveWorkspacePath } from "./anchors.js";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)$/i;

const readSchema = Type.Object({
  path: Type.String({ description: "File path (relative to the workspace or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "First line to read, 1-indexed (default 1)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/** Replaces Pi's `read`: same parameters, but every text line carries a `LINE#TAG|` anchor for `edit`. */
export function createReadTool(cwd: string): ToolDefinition {
  const pi = createReadToolDefinition(cwd);
  return {
    name: "read",
    label: "read",
    description:
      `Read a file. Every text line is printed as \`LINE#TAG|text\`; edit addresses lines by LINE#TAG. Output is capped at ${READ_MAX_LINES} lines / ${READ_MAX_BYTES / 1024}KB: continue with offset. Use offset/limit for ranges. Images are returned as attachments.`,
    promptSnippet: "Read file contents with LINE#TAG anchors (offset/limit for ranges)",
    promptGuidelines: [
      "Use read, not cat/sed, to examine files; use offset/limit instead of reading huge files whole.",
    ],
    parameters: readSchema,
    async execute(toolCallId, params: Static<typeof readSchema>, signal, onUpdate, ctx) {
      const root = ctx?.cwd || cwd;
      if (IMAGE_PATH.test(params.path)) return pi.execute(toolCallId, params, signal, onUpdate, ctx);
      const absolute = resolveWorkspacePath(root, params.path);
      const buffer = await readFile(absolute, { signal });
      if (buffer.subarray(0, 8000).includes(0))
        throw new Error(`${params.path} looks like a binary file; read only supports text and images`);
      const { lines } = parseFileText(buffer.toString("utf8"));
      if (lines.length === 0) return { content: [{ type: "text", text: "(empty file)" }], details: undefined };
      const start = Math.max(1, Math.floor(params.offset ?? 1));
      if (start > lines.length)
        throw new Error(`Offset ${start} is beyond the end of the file (${lines.length} lines)`);
      const wanted = Math.min(
        READ_MAX_LINES,
        params.limit === undefined ? READ_MAX_LINES : Math.max(1, Math.floor(params.limit)),
      );
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
      const capped = last < lines.length && !(params.limit !== undefined && out.length >= wanted);
      const notice =
        last < lines.length
          ? `\n\n[Showing lines ${start}-${last} of ${lines.length}${capped ? " (output cap)" : ""}. Use offset=${last + 1} to continue.]`
          : "";
      return { content: [{ type: "text", text: out.join("\n") + notice }], details: undefined };
    },
  };
}
