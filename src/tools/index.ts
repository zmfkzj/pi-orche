import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAstRewriteTool, createAstSearchTool } from "./ast.js";
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
export function createOrcheTools(options: { cwd: string }): ToolDefinition[] {
  return [
    createReadTool(options.cwd),
    createEditTool(options.cwd),
    createFindTool(options.cwd),
    createAstSearchTool(options.cwd),
    createAstRewriteTool(options.cwd),
    createDiagnosticsTool(options.cwd),
  ];
}
