import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createSyntheticSourceInfo,
  type Extension,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { filterOutput, genericPreview } from "./output-filter.js";

export { SPILL_MAX_CHARS, SPILL_MAX_LINES } from "./output-filter.js";
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_DIR = ".orche/artifacts";
/** `read` already caps itself and must stay able to page through artifacts. */
const EXEMPT_TOOLS = ["read"];

/** Generic head/tail preview for tools other than bash; read is exempt. */
export function previewText(text: string): string | undefined {
  return genericPreview(text, false)?.text;
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

/** Filter bash/grep results and spill oversized results, preserving full originals. */
export interface SpillEvent {
  toolName: string;
  input?: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  structuredContent?: ToolResultEvent["structuredContent"];
}
export interface SpillResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  structuredContent?: ToolResultEvent["structuredContent"];
}

export async function spillToolResult(event: SpillEvent, cwd: string): Promise<SpillResult | undefined> {
  if (EXEMPT_TOOLS.includes(event.toolName)) return undefined;
  const texts = event.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const rest = event.content.filter((part) => part.type !== "text");
  // Pi's bash already truncated what we see to its tail; its temp file holds the real full output.
  const full = event.toolName === "bash" ? await fullBashOutput(event.details).catch(() => undefined) : undefined;
  const piText = texts.join("\n");
  const text = full?.text ?? piText;
  // The full output file lacks Pi's trailing exit/abort/timeout status line.
  const statusEnd = piText.endsWith("\n") ? piText.length - 1 : piText.length;
  const statusStart = piText.lastIndexOf("\n", statusEnd - 1) + 1;
  const lastLine = piText.slice(statusStart, Math.min(statusEnd, statusStart + 100));
  const status = full && lastLine.startsWith("Command ")
    ? `${lastLine}${statusEnd - statusStart > 100 ? `…[+${statusEnd - statusStart - 100} chars]` : ""}` : undefined;
  const filtered = filterOutput(event.toolName, text, event.input);
  const preview = filtered ?? genericPreview(text, event.toolName === "bash" || event.toolName === "grep");
  if (!preview && !full) return undefined;
  // Never inline the recovered full file when no reduction applies.
  const inline = preview?.text ?? genericPreview(piText, event.toolName === "bash" || event.toolName === "grep")?.text ?? piText;
  let notice: string;
  try {
    const path = await saveArtifact(cwd, event.toolName, text, full?.file);
    const reason = preview?.reason ?? "Pi output truncation";
    notice = `[Output ${filtered ? "filtered" : "truncated"}: ${reason}${preview?.omittedLines ? ` (${preview.omittedLines} lines omitted)` : ""}. Full output saved to ${path}; use read with offset/limit or grep to inspect it.]`;
  } catch (error) {
    notice = `[Output ${filtered ? "filtered" : "truncated"}; saving the full output failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
  // Keep the status in the output, but end with one artifact notice.
  const resultText = `${inline}${status && !inline.endsWith(status) ? `\n${status}` : ""}\n\n${notice}`;
  return {
    content: [{ type: "text", text: resultText }, ...rest],
    ...(event.isError === undefined ? {} : { isError: event.isError }),
    // Pi's docs/extensions.md: replacing content alone drops structuredContent.
    // Omit it rather than returning text that could violate the tool's outputSchema.
  };
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
