import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const TAG_LENGTH = 4;

/** SHA-256 of the exact line content, without its EOL. */
export function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

export function lineTag(line: string): string {
  return lineHash(line).slice(0, TAG_LENGTH);
}

export const isBlankLine = (line: string): boolean => /^\s*$/.test(line);
export function anchorMatches(anchor: Anchor, line: string): boolean {
  return anchor.tag === undefined ? isBlankLine(line) : lineHash(line).startsWith(anchor.tag);
}

export function formatAnchor(lineNumber: number, line: string): string {
  return isBlankLine(line) ? `${lineNumber}` : `${lineNumber}#${lineTag(line)}`;
}

/** `LINE#TAG|text` for non-blank lines, `LINE|text` for blank lines. */
export function formatTaggedLine(lineNumber: number, line: string, maxChars = 4000): string {
  const shown = line.length > maxChars ? `${line.slice(0, maxChars)}…[+${line.length - maxChars} chars]` : line;
  return `${formatAnchor(lineNumber, line)}|${shown}`;
}

export interface Anchor {
  line: number;
  tag?: string;
}

const ANCHOR = /^\s*(\d+)\s*(?:#\s*([0-9a-f]{4,16}))?(?:\s*\|.*)?$/is;

/** Accepts bare blank-line numbers, tagged anchors, and whole pasted read lines. */
export function parseAnchor(value: string): Anchor | undefined {
  const match = ANCHOR.exec(value);
  if (!match) return undefined;
  return { line: Number(match[1]), tag: match[2]?.toLowerCase() };
}

export interface ParsedFile {
  lines: string[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
  bom: boolean;
}

export function parseFileText(raw: string): ParsedFile {
  const bom = raw.startsWith("\uFEFF");
  const text = bom ? raw.slice(1) : raw;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.length === 0 || text.endsWith("\n");
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return { lines, eol, trailingNewline, bom };
}

export function serializeFile(file: ParsedFile): string {
  const body = file.lines.join(file.eol);
  const text = file.lines.length > 0 && file.trailingNewline ? body + file.eol : body;
  return (file.bom ? "\uFEFF" : "") + text;
}

export function resolveWorkspacePath(cwd: string, path: string): string {
  const cleaned = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}
