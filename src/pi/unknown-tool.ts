/**
 * "Tool X not found" with a suggestion. Workers called tools that do not exist under names such as `utility_read`, `minute_bash`,
 * `seek_write` or `notable_orche_spawn` (a word prefixed to a real tool name, learned from other harnesses). Pi answers
 * `Tool <name> not found` with no hint, and the next attempt is often another guess. The fix only rewrites that error text: the call
 * is never re-routed to the suggested tool, so a wrong guess cannot cause a write.
 */

const NOT_FOUND = /^Tool (\S+) not found$/;

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The one available tool `name` most likely meant, or undefined when there is no single plausible candidate. */
export function suggestToolName(name: string, available: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  const unique = (matches: readonly string[]) => matches.length === 1 ? matches[0] : undefined;
  const exact = unique(available.filter(tool => tool.toLowerCase() === lower));
  if (exact) return exact;
  // A prefix glued on with `_`, `__` or `.` (`utility_read`, `mcp__server__read`, `functions.read`): the longest matching suffix wins.
  const suffixed = available.filter(tool => lower.endsWith(`_${tool.toLowerCase()}`) || lower.endsWith(`.${tool.toLowerCase()}`));
  if (suffixed.length) {
    const longest = Math.max(...suffixed.map(tool => tool.length));
    const best = unique(suffixed.filter(tool => tool.length === longest));
    if (best) return best;
  }
  return unique(available.filter(tool => tool.length > 3 && editDistance(lower, tool.toLowerCase()) <= 2));
}

/** The replacement text of a `Tool X not found` result, or undefined when `text` is not one. */
export function unknownToolText(text: string, available: readonly string[]): string | undefined {
  const match = NOT_FOUND.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!;
  const suggestion = suggestToolName(name, available);
  const list = [...available].sort().join(", ");
  return `Tool ${name} not found.${suggestion ? ` Did you mean ${suggestion}? Call it by that exact name.` : ""} Available tools: ${list}.`;
}

interface ToolResultLike { role?: string; isError?: boolean; content?: unknown }

/** A `message_end` handler that rewrites Pi's bare `Tool X not found` results; `tools()` lists the session's active tools. */
export function unknownToolHandler(tools: () => readonly string[]) {
  return (event: { message: ToolResultLike }) => {
    const message = event.message;
    if (message.role !== "toolResult" || !message.isError || !Array.isArray(message.content) || message.content.length !== 1) return undefined;
    const part = message.content[0] as { type?: string; text?: string };
    if (part.type !== "text" || typeof part.text !== "string") return undefined;
    const text = unknownToolText(part.text, tools());
    return text ? { message: { ...message, content: [{ type: "text", text }] } } : undefined;
  };
}
