/**
 * The tool boundary of a read node (docs/thinking-policy.md "Read nodes"): while a Task DAG node marked `read: true` runs at the read
 * level R (src/pi/thinking-policy.ts), and for the rest of every response that ran at R, only read-only tools run. An edit, a command,
 * a check, a spawn or any other tool is refused with what to do instead: finish the read node with task_plan and continue in a node
 * without read, which runs at the baseline from the next response. This is what makes "simple reading" a boundary the runtime holds
 * rather than a label: low effort never writes, runs or verifies anything. (What the model concludes in its reasoning while it reads
 * stays an instruction: record what the sources say, decide nothing.)
 */
import { thinkingStateOf } from "./thinking-state.js";

/** Tools a read node may call: reading and searching, the web page reader, the Task DAG, the report and notes. */
export const READ_NODE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "ast_search", "browser_fetch", "task_plan", "report_result", "send_message"]);

/** Whether `toolName` may run in a read node (also pi-codegraph's read-only query tools). */
export function readNodeAllows(toolName: string): boolean {
  return READ_NODE_TOOLS.has(toolName) || /(^|_)codegraph_/.test(toolName);
}

/** The refusal of `toolName` for `session` (undefined: allowed, or no read level in force). */
export function readNodeRefusal(session: object, toolName: string): string | undefined {
  const thinking = thinkingStateOf(session);
  const inRead = thinking.phase === "read";
  const fromRead = thinking.requestPhase === "read";
  if (!inRead && !fromRead) return undefined;
  if (readNodeAllows(toolName)) return undefined;
  const baseline = thinking.baseline ? `baseline (${thinking.baseline})` : "baseline";
  return inRead
    ? `Blocked: a read node is running at ${thinking.read ?? "low"} effort for simple reading, where only read-only tools run (read, grep, find, ls, ast_search, codegraph, browser_fetch). To edit, run a command, check or decide, finish the read node with task_plan (its checkpoint records what the sources say) and set a node without read:true running; it runs at your ${baseline} effort from your next response.`
    : `Blocked: this response ran at the read effort (${thinking.requestLevel ?? "low"}) of the read node it finished; ${toolName} runs from your next response, at your ${baseline} effort. Call it again then.`;
}
