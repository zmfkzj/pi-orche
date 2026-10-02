import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAstRewriteTool, createAstSearchTool } from "./ast.js";
import { createBashHeartbeatTool, type BashHeartbeatConfig } from "./bash.js";
import { createDiagnosticsTool } from "./diagnostics.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createReadTool } from "./read.js";

/** Full editing worker set: search + read + edit + ast + diagnostics + bash + write. */
export const WORKER_TOOL_NAMES: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "ast_search",
  "ast_rewrite",
  "diagnostics",
  "bash",
  "write",
];

/** Analysts / verifier / coordinator / advisor: search + read + ast search + diagnostics (no edit/write). */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "ast_search",
  "diagnostics",
];

/** Custom tools pi-orche adds on top of Pi built-ins (some replace built-ins by name). */
export function createOrcheTools(options: { cwd: string; bashHeartbeat?: BashHeartbeatConfig }): ToolDefinition[] {
  return [
    createReadTool(options.cwd),
    createEditTool(options.cwd),
    createFindTool(options.cwd),
    createAstSearchTool(options.cwd),
    createAstRewriteTool(options.cwd),
    createDiagnosticsTool(options.cwd),
    // Opt-in: orche-created sessions pass `bashHeartbeat`; the main Pi session (which registers these tools as extension
    // tools) does not, so its own `bash` stays Pi's.
    ...(options.bashHeartbeat ? [createBashHeartbeatTool({ cwd: options.cwd, ...options.bashHeartbeat })] : []),
  ];
}
