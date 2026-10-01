import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createSyntheticSourceInfo,
  type Extension,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

export const SPILL_MAX_CHARS = 12_000;
export const SPILL_MAX_LINES = 300;
const HEAD_LINES = 40;
const TAIL_LINES = 80;
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 6_000;
const LINE_CHARS = 1_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_DIR = ".orche/artifacts";
/** `read` already caps itself and must stay able to page through artifacts. */
const EXEMPT_TOOLS = ["read"];

const clip = (line: string) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…[+${line.length - LINE_CHARS} chars]` : line);

function takeLines(lines: string[], fromEnd: boolean, maxLines: number, maxChars: number): string[] {
  const taken: string[] = [];
  let chars = 0;
  for (let i = 0; i < lines.length && taken.length < maxLines; i++) {
    const line = clip(lines[fromEnd ? lines.length - 1 - i : i]!);
    if (chars + line.length > maxChars && taken.length > 0) break;
    chars += line.length + 1;
    taken.push(line);
  }
  return fromEnd ? taken.reverse() : taken;
}

/** Head + tail of `text` with an omission marker, or undefined when it fits inline. */
export function previewText(text: string): string | undefined {
  const lines = text.split("\n");
  if (text.length <= SPILL_MAX_CHARS && lines.length <= SPILL_MAX_LINES) return undefined;
  const head = takeLines(lines, false, HEAD_LINES, HEAD_CHARS);
  const tail = takeLines(lines.slice(head.length), true, TAIL_LINES, TAIL_CHARS);
  const omitted = lines.length - head.length - tail.length;
  const marker = `… [${omitted} lines omitted from the middle] …`;
  return [...head, marker, ...tail].join("\n");
}

async function saveArtifact(cwd: string, toolName: string, text: string, sourceFile: string | undefined): Promise<string> {
  const dir = join(cwd, ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });
  // Keep the artifact out of git status and out of rg/fd searches.
  for (const name of [".gitignore", ".ignore"]) await writeFile(join(dir, name), "*\n", { flag: "a" });
  const id = `${toolName.replace(/[^\w-]/g, "_")}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const relative = `${ARTIFACT_DIR}/${id}.txt`;
  if (sourceFile) await copyFile(sourceFile, join(cwd, relative));
  else await writeFile(join(cwd, relative), text);
  return relative;
}

async function fullBashOutput(details: unknown): Promise<{ file: string; text: string | undefined } | undefined> {
  const file = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
  if (typeof file !== "string") return undefined;
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  return { file, text: info.size <= MAX_SOURCE_BYTES ? await readFile(file, "utf8") : undefined };
}

/** Spill an over-threshold tool result: keep head+tail inline, store the full text under .orche/artifacts. */
export interface SpillEvent {
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
}
export interface SpillResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}

export async function spillToolResult(event: SpillEvent, cwd: string): Promise<SpillResult | undefined> {
  if (EXEMPT_TOOLS.includes(event.toolName)) return undefined;
  const texts = event.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const rest = event.content.filter((part) => part.type !== "text");
  // Pi's bash already truncated what we see to its tail; its temp file holds the real full output.
  const full = event.toolName === "bash" ? await fullBashOutput(event.details).catch(() => undefined) : undefined;
  const piText = texts.join("\n");
  const text = full?.text ?? piText;
  // The full output file lacks Pi's trailing exit/abort status line; carry it over.
  const status = full ? /\n\n(Command [^\n]*)$/.exec(piText)?.[1] : undefined;
  const preview = previewText(text);
  if (preview === undefined && !full) return undefined;
  const inline = preview ?? text;
  let notice: string;
  try {
    const path = await saveArtifact(cwd, event.toolName, text, full?.file);
    notice = `[Output truncated (${text.split("\n").length} lines, ${text.length} chars). Full output saved to ${path}; use read with offset/limit or grep to inspect it.]`;
  } catch (error) {
    notice = `[Output truncated; saving the full output failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return { content: [{ type: "text", text: `${inline}\n\n${notice}${status ? `\n${status}` : ""}` }, ...rest] };
}

/** Session extension applying {@link spillToolResult} to every tool result (public `tool_result` hook). */
export function createSpillExtension(cwd: string): Extension {
  const path = "<orche:spill>";
  const handler = (event: ToolResultEvent) => spillToolResult(event, cwd);
  return {
    path,
    resolvedPath: path,
    hidden: true,
    sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([["tool_result", [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}
