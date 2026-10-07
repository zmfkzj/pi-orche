import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath } from "./anchors.js";

export const DIAGNOSTICS_TIMEOUT_MS = 30_000;
const MAX_ITEMS = 50;
const MAX_FILES = 400;
const WORKER_URL = new URL("./diagnostics-worker.mjs", import.meta.url);

interface WorkerResult {
  ok: true;
  items: Array<{ file: string; line: number; column: number; text: string }>;
  total: number;
  checked: number;
  files: number;
  configured?: number;
  config?: string;
  timedOut: boolean;
  /** Set when the project's TypeScript was skipped for the bundled one. */
  typescriptNote?: string;
}

interface TypeScriptChoice {
  /** The workspace's own TypeScript, when it resolves. */
  projectTsPath?: string;
  /** Why the workspace's node_modules/typescript could not even be resolved, when it exists. */
  projectTsUnresolved?: string;
  /** This package's TypeScript: the fallback, validated by the worker like the project's. */
  bundledTsPath: string;
}

/** The workspace's own TypeScript when it has one (matching its version), else this package's; the worker validates both. */
function resolveTypeScript(cwd: string): TypeScriptChoice {
  const bundledTsPath = createRequire(import.meta.url).resolve("typescript");
  try {
    return { projectTsPath: createRequire(join(cwd, "package.json")).resolve("typescript"), bundledTsPath };
  } catch (error) {
    // A half-installed package (no package.json or main file yet) does not resolve; one that is absent is not news.
    if (!existsSync(join(cwd, "node_modules", "typescript"))) return { bundledTsPath };
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
    return { projectTsUnresolved: `it could not be resolved (${reason})`, bundledTsPath };
  }
}

function runWorker(data: Record<string, unknown>, timeoutMs: number, signal: AbortSignal | undefined): Promise<WorkerResult | "timeout"> {
  const { promise, resolve, reject } = Promise.withResolvers<WorkerResult | "timeout">();
  const worker = new Worker(WORKER_URL, {
    workerData: { ...data, deadline: Date.now() + timeoutMs },
    resourceLimits: { maxOldGenerationSizeMb: 2048 },
  });
  const finish = (fn: () => void) => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    void worker.terminate();
    fn();
  };
  // The worker stops cooperatively at the deadline; the hard kill is a backstop for a stuck program build.
  const timer = setTimeout(() => finish(() => resolve("timeout")), timeoutMs + 5000);
  const onAbort = () => finish(() => reject(new Error("Operation aborted")));
  signal?.addEventListener("abort", onAbort, { once: true });
  worker.once("message", (message: WorkerResult | { ok: false; error: string }) =>
    finish(() => (message.ok ? resolve(message) : reject(new Error(message.error)))),
  );
  worker.once("error", (error) => finish(() => reject(error)));
  worker.once("exit", (code) => finish(() => reject(new Error(`diagnostics worker exited with code ${code}`))));
  return promise;
}

const diagnosticsSchema = Type.Object({
  files: Type.Optional(Type.Array(Type.String(), { description: "Files to check (default: whole project)" })),
});

export function createDiagnosticsTool(cwd: string): ToolDefinition {
  return {
    name: "diagnostics",
    label: "diagnostics",
    description:
      `Type and syntax errors from the TypeScript compiler for JS/TS files, without writing anything. Give files to check just those (plus what they import), or omit files to check the whole project (nearest tsconfig.json/jsconfig.json, else all source files under the workspace). JS files are type-checked too (allowJs+checkJs). Output is capped at ${MAX_ITEMS} errors and ${DIAGNOSTICS_TIMEOUT_MS / 1000}s; unresolved package imports and missing node typings are ignored. Run it after editing instead of running a full build.`,
    promptSnippet: "TypeScript/JavaScript type & syntax errors for files or the project",
    parameters: diagnosticsSchema,
    async execute(_id, params: Static<typeof diagnosticsSchema>, signal, _onUpdate, ctx) {
      const root = ctx?.cwd || cwd;
      const files = params.files ?? [];
      for (const file of files)
        await access(resolveWorkspacePath(root, file)).catch(() => {
          throw new Error(`File not found: ${file}`);
        });
      const result = await runWorker(
        { ...resolveTypeScript(root), cwd: root, files, maxFiles: MAX_FILES, maxItems: MAX_ITEMS },
        DIAGNOSTICS_TIMEOUT_MS,
        signal,
      );
      if (result === "timeout")
        return { content: [{ type: "text", text: `Diagnostics timed out after ${DIAGNOSTICS_TIMEOUT_MS / 1000}s; pass specific files.` }], details: undefined };
      const scope = `${result.checked}/${result.files} files${result.config ? ` (${result.config})` : " (default options)"}`;
      const capped = result.configured !== undefined && result.configured > result.files && files.length === 0 ? `; project has ${result.configured} files, only the first ${result.files} were checked` : "";
      const partial = result.timedOut ? `; stopped at the ${DIAGNOSTICS_TIMEOUT_MS / 1000}s time limit` : "";
      const text =
        (result.total === 0
          ? `No errors in ${scope}${capped}${partial}`
          : `${result.items.map((d) => `${d.file}${d.line ? `:${d.line}:${d.column}` : ""} ${d.text}`).join("\n")}\n\n${result.total} errors in ${scope}${result.total > result.items.length ? `; showing first ${result.items.length}` : ""}${capped}${partial}`)
        + (result.typescriptNote ? `\n${result.typescriptNote}` : "");
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
