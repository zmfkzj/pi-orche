/**
 * Readable continuation of one pilot (or source-bench) arm: the delivered text and everything the top worker did after the
 * reflection point (reasoning summaries, messages, tool calls, truncated tool results), from its session record. For the manual
 * adherence/mechanism adjudication (PREREGISTRATION.md "Read-out"); nothing here is ever model-visible.
 *
 *   node --import tsx experiments/strong-reflection/bench/pilot/transcript.ts <arm dir> [out file]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)} …[+${text.length - max}]` : text;
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.type === "text" ? part.text : "").join("") : "";

/** The top worker's session file of an arm (records/<session>/workers/W1-*.jsonl). */
export function topSession(armDir: string): string | undefined {
  const records = join(armDir, "records");
  if (!existsSync(records)) return undefined;
  for (const entry of readdirSync(records, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workers = join(records, entry.name, "workers");
    if (!existsSync(workers)) continue;
    const file = readdirSync(workers).find(name => /^W1-.*\.jsonl$/.test(name));
    if (file) return join(workers, file);
  }
  return undefined;
}

/** Messages of the session after the reflection point: assistant responses from ordinal `from` on, with their tool results. */
export function continuation(sessionFile: string, from: number, limits = { tool: 1500, args: 1200, thinking: 2500 }): string {
  // Messages and custom messages (helper notes) in session order; a custom message is shown as role "custom".
  const messages = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .flatMap((entry: any) => entry?.type === "message" ? [entry.message] : entry?.type === "custom_message" ? [{ role: "custom", content: entry.content, customType: entry.customType }] : []);
  const out: string[] = [];
  let assistant = -1, started = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant") assistant++;
    if (!started && message.role === "assistant" && assistant === from) {
      started = true;
      // The tool results that carried the delivered text (the task_plan result right before the first live response).
      for (let j = i - 1; j >= 0 && messages[j].role === "toolResult"; j--) if (messages[j].toolName === "task_plan") out.push(`### delivered with task_plan result\n${clip(textOf(messages[j].content), 8000)}\n`);
    }
    if (!started) continue;
    if (message.role === "assistant") {
      out.push(`### response ${assistant}${message.usage ? ` (in ${message.usage.input}, cached ${message.usage.cacheRead}, out ${message.usage.output})` : ""}`);
      for (const part of message.content ?? []) {
        if (part.type === "thinking" && part.thinking) out.push(`[thinking] ${clip(part.thinking, limits.thinking)}`);
        else if (part.type === "text" && part.text) out.push(`[text] ${part.text}`);
        else if (part.type === "toolCall") out.push(`[call ${part.name}] ${clip(JSON.stringify(part.arguments), limits.args)}`);
      }
    } else if (message.role === "toolResult") out.push(`[result ${message.toolName}${message.isError ? " ERROR" : ""}] ${clip(textOf(message.content), limits.tool)}`);
    else if (message.role === "user" || message.role === "custom") out.push(`[${message.role}] ${clip(textOf(message.content), limits.tool)}`);
  }
  return out.join("\n");
}

/** The audit-relevant lines only: the worker's messages, short reasoning summaries, its commands and edits, the resolved ambiguities. */
export function brief(full: string, resultText: string): string {
  const keep = full.split("\n").filter(line => /^(### response|\[thinking\]|\[call (bash|edit|write)\])/.test(line)).map(line => line.startsWith("[thinking]") ? line.slice(0, 300) : line.startsWith("[call") ? line.slice(0, 900) : line);
  const texts: string[] = [];
  let inText = false;
  for (const line of full.split("\n")) {
    if (line.startsWith("[text]")) { inText = true; texts.push(line); continue; }
    if (/^(\[|### )/.test(line)) inText = false;
    else if (inText) texts.push(line);
  }
  const ambiguities = resultText.split("\n").filter(line => /^(Ambiguities resolved|status:|reason:|Advisor:)/.test(line));
  return [...keep, "", "#### messages", ...texts, "", "#### result", ...ambiguities].join("\n");
}

if (process.argv[1]?.endsWith("pilot/transcript.ts")) {
  const [armDir, outFile, mode] = process.argv.slice(2);
  if (!armDir) throw new Error("usage: transcript.ts <arm dir> [out file]");
  const meta = JSON.parse(readFileSync(join(armDir, "meta.json"), "utf8"));
  const session = topSession(armDir);
  if (!session) throw new Error(`${armDir}: no top-worker session record`);
  const full = continuation(session, meta.checkpoint.ordinal);
  const body = mode === "--brief" ? brief(full, String(meta.resultText ?? "")) : `${full}\n\n### result text\n${meta.resultText ?? ""}`;
  const text = `# ${meta.unit} ${meta.arm} — terminal ${meta.terminal}, grade ${meta.grade?.passed}, live $${meta.wire?.liveCostUsd}\n\n${body}\n`;
  if (outFile) writeFileSync(outFile, text); else console.log(text);
}
