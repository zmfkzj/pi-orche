import { execFile } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Every piece of advisor input is capped; the advisor prompt is the sum of these bounds. */
export const LIMITS = { transcriptChars: 12_000, diffChars: 10_000, detailChars: 4_000, problemChars: 3_000, itemChars: 700 } as const;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part || typeof part !== "object") return "";
    if ("text" in part && typeof part.text === "string") return part.text;
    if ("type" in part && part.type === "toolCall" && "name" in part) {
      return `[call ${String(part.name)} ${clip(JSON.stringify("arguments" in part ? part.arguments : {}), 240)}]`;
    }
    return "";
  }).filter(Boolean).join(" ");
}
function renderMessage(message: AgentMessage): string {
  switch (message.role) {
    case "user": return `USER: ${clip(contentText(message.content), LIMITS.itemChars)}`;
    case "assistant": return `ASSISTANT: ${clip(contentText(message.content), LIMITS.itemChars)}`;
    case "toolResult": return `TOOL ${message.toolName}${message.isError ? " (error)" : ""}: ${clip(contentText(message.content), LIMITS.itemChars)}`;
    case "custom": return `NOTE: ${clip(contentText(message.content), LIMITS.itemChars)}`;
    default: return "";
  }
}
/** Messages [from, end) rendered compactly; the newest `maxChars` are kept. `next` is the cursor for the following call. */
export function renderTranscript(messages: readonly AgentMessage[], from: number, maxChars: number = LIMITS.transcriptChars): { text: string; next: number } {
  const lines = messages.slice(from).map(renderMessage).filter(Boolean);
  let text = lines.join("\n");
  if (text.length > maxChars) text = `[older transcript omitted]\n${text.slice(text.length - maxChars)}`;
  return { text, next: messages.length };
}

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("git", ["-C", cwd, ...args], { signal, timeout: 5000, maxBuffer: 2_000_000, killSignal: "SIGKILL" }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
  return promise;
}
/** Bounded view of the uncommitted workspace change: changed paths plus the head of `git diff`. */
export async function workspaceDiff(cwd: string, maxChars: number = LIMITS.diffChars, signal?: AbortSignal): Promise<string> {
  try {
    const exclude = ["--", ".", ":(exclude).orche"];
    signal?.throwIfAborted();
    const status = clip((await git(cwd, ["status", "--porcelain=v1", "-uall", "--", ".", ":(exclude).orche"], signal)).trim(), 1500);
    let diff: string;
    try { diff = await git(cwd, ["diff", "HEAD", "--no-color", ...exclude], signal); }
    catch { signal?.throwIfAborted(); diff = await git(cwd, ["diff", "--no-color", ...exclude], signal); }
    if (!status && !diff.trim()) return "(no uncommitted changes)";
    return `${status ? `changed paths:\n${status}\n\n` : ""}${clip(diff, Math.max(500, maxChars - status.length))}`;
  } catch {
    return "(workspace diff unavailable: not a git repository or git failed)";
  }
}
