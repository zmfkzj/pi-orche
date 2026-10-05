/**
 * code_nav (docs/specialist-orchestration.md 5.2; the research's Code Navigator): deterministic code retrieval for single-workflow
 * sessions (the Primary worker, the Framer, the Verifier), never for the main session. TypeScript/JavaScript answers come from the
 * TypeScript LanguageService (`semantic`); other languages, and names the program does not know, from bounded regex search
 * (`heuristic`). Output is grouped by file as `line kind context`, so a session reads ranges instead of whole files.
 */
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath } from "./anchors.js";

export const CODE_NAV_TIMEOUT_MS = 25_000;
const MAX_FILES = 2_000;
const DEFAULT_LIMIT = 40;
const WORKER_URL = new URL("./code-nav-worker.mjs", import.meta.url);
export const CODE_NAV_OPS = ["def", "refs", "impl", "callers", "callees", "imports", "importers", "tests", "symbols", "locate", "overview"] as const;

const codeNavSchema = Type.Object({
  op: Type.Union(CODE_NAV_OPS.map(op => Type.Literal(op)), { description: "def/refs/impl/callers/callees/tests: of a symbol (name, or Class.member) or of a position (file + line [+ column]). symbols/imports/importers: of a file. locate: search symbol names (query). overview: the project's files with their top-level declarations." }),
  symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  file: Type.Optional(Type.String({ minLength: 1 })),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  column: Type.Optional(Type.Integer({ minimum: 1 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
type CodeNavParams = Static<typeof codeNavSchema>;
interface NavItem { file: string; line: number; kind: string; text: string }
interface NavResult { ok: true; items: NavItem[]; total: number; confidence: "semantic" | "heuristic" | "semantic+heuristic"; head: string[]; config?: string; timedOut: boolean }

function resolveTypeScript(cwd: string): string {
  try { return createRequire(join(cwd, "package.json")).resolve("typescript"); } catch { return createRequire(import.meta.url).resolve("typescript"); }
}

function runWorker(data: Record<string, unknown>, timeoutMs: number, signal: AbortSignal | undefined): Promise<NavResult | "timeout"> {
  const { promise, resolve, reject } = Promise.withResolvers<NavResult | "timeout">();
  const worker = new Worker(WORKER_URL, { workerData: { ...data, deadline: Date.now() + timeoutMs }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
  const finish = (fn: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); void worker.terminate(); fn(); };
  const timer = setTimeout(() => finish(() => resolve("timeout")), timeoutMs + 5000);
  const onAbort = () => finish(() => reject(new Error("Operation aborted")));
  signal?.addEventListener("abort", onAbort, { once: true });
  worker.once("message", (message: NavResult | { ok: false; error: string }) => finish(() => (message.ok ? resolve(message) : reject(new Error(message.error)))));
  worker.once("error", error => finish(() => reject(error)));
  worker.once("exit", code => finish(() => reject(new Error(`code_nav worker exited with code ${code}`))));
  return promise;
}

export function validateNavParams(params: CodeNavParams): string | undefined {
  const needsTarget = ["def", "refs", "impl", "callers", "callees", "tests"].includes(params.op);
  if (needsTarget && !params.symbol && !(params.file && params.line)) return `${params.op} needs symbol, or file and line.`;
  if (params.op === "tests" && !params.symbol && !params.file) return "tests needs symbol or file.";
  if (["symbols", "imports", "importers"].includes(params.op) && !params.file) return `${params.op} needs file.`;
  if (params.op === "locate" && !params.query) return "locate needs query.";
  return undefined;
}

export function formatNav(params: CodeNavParams, result: NavResult): string {
  const subject = params.symbol ?? params.query ?? (params.file ? `${params.file}${params.line ? `:${params.line}` : ""}` : "project");
  const files = new Set(result.items.map(item => item.file));
  const header = `code_nav ${params.op} ${subject} (${result.confidence}${result.config ? `, ${result.config}` : ""}): ${result.total} result${result.total === 1 ? "" : "s"}${files.size ? ` in ${files.size} file${files.size === 1 ? "" : "s"}` : ""}${result.total > result.items.length ? `, showing ${result.items.length}` : ""}${result.timedOut ? `; stopped at the ${CODE_NAV_TIMEOUT_MS / 1000}s limit` : ""}`;
  const groups = new Map<string, NavItem[]>();
  for (const item of result.items) groups.set(item.file, [...groups.get(item.file) ?? [], item]);
  const body = [...groups].flatMap(([file, entries]) => [file, ...entries.map(entry => `  ${entry.line} ${entry.kind}${entry.text ? `  ${entry.text}` : ""}`)]);
  const none = result.total === 0 ? [result.confidence === "heuristic" ? "Nothing found (heuristic search; try grep or a different name)." : "Nothing found."] : [];
  return [header, ...result.head, ...body, ...none].join("\n");
}

export function createCodeNavTool(cwd: string): ToolDefinition {
  return {
    name: "code_nav",
    label: "code_nav",
    description: `Navigate code without reading whole files: definitions, references, implementations, callers/callees, tests that cover a symbol or file, a file's symbols, imports and importers, symbol search, and a project overview. TypeScript/JavaScript use the TypeScript language service (semantic); other languages use bounded regex search (heuristic). Results are path, line, kind and the line's text, at most ${DEFAULT_LIMIT} by default; read the ranges you need afterwards.`,
    promptSnippet: "Code navigation: def/refs/callers/tests/symbols/importers/locate/overview",
    parameters: codeNavSchema,
    async execute(_id, params: CodeNavParams, signal, _onUpdate, ctx) {
      const root = ctx?.cwd || cwd;
      const invalid = validateNavParams(params);
      if (invalid) throw new Error(invalid);
      if (params.file) await access(resolveWorkspacePath(root, params.file)).catch(() => { throw new Error(`File not found: ${params.file}`); });
      const result = await runWorker({ tsPath: resolveTypeScript(root), cwd: root, op: params.op, symbol: params.symbol, file: params.file, line: params.line, column: params.column, query: params.query, limit: params.limit ?? DEFAULT_LIMIT, maxFiles: MAX_FILES }, CODE_NAV_TIMEOUT_MS, signal);
      if (result === "timeout") return { content: [{ type: "text", text: `code_nav timed out after ${CODE_NAV_TIMEOUT_MS / 1000}s; narrow it with file/line or use grep.` }], details: undefined };
      return { content: [{ type: "text", text: formatNav(params, result) }], details: undefined };
    },
  };
}
