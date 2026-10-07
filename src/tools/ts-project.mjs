// Project planning shared by the TypeScript worker threads (diagnostics, code_nav): which tsconfig/jsconfig applies, which
// source files are the roots, and the compiler options. Plain JS so Node can load it in a worker without a TS loader.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const SKIPPED = new Set([".git", "node_modules", ".orche"]);

/** The nearest tsconfig.json / jsconfig.json from `startDir` up to `cwd`. */
export function findConfig(startDir, cwd) {
  let dir = startDir;
  for (;;) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dir === cwd || dirname(dir) === dir || !dir.startsWith(cwd)) return undefined;
    dir = dirname(dir);
  }
}

/** Source files under `dir` (sorted, depth first), skipping .git, node_modules, .orche and declaration files, at most `maxFiles`. */
export function listSources(dir, out, maxFiles) {
  if (out.length >= maxFiles) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= maxFiles) return;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) listSources(join(dir, entry.name), out, maxFiles);
    } else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(join(dir, entry.name));
  }
}

/** Options every orche TypeScript worker forces: JS included and checked, nothing emitted. */
export function forcedOptions() {
  return { allowJs: true, checkJs: true, noEmit: true, incremental: false, composite: false, declaration: false, declarationMap: false, emitDeclarationOnly: false, skipLibCheck: true };
}

/**
 * What a loaded `typescript` module lacks among the pieces the workers use (empty when usable). A project's TypeScript that
 * is half-installed (e.g. while `npm install` runs) can load as `{}` or without its enums.
 */
export function typeScriptProblems(ts) {
  if (!ts || (typeof ts !== "object" && typeof ts !== "function")) return ["the module itself"];
  const missing = [];
  if (typeof ts.version !== "string") missing.push("version");
  for (const [name, member] of [["ScriptTarget", "ES2022"], ["ModuleKind", "NodeNext"], ["ModuleResolutionKind", "NodeNext"], ["JsxEmit", "Preserve"], ["DiagnosticCategory", "Error"]])
    if (typeof ts[name]?.[member] !== "number") missing.push(`${name}.${member}`);
  for (const name of ["createProgram", "getParsedCommandLineOfConfigFile", "flattenDiagnosticMessageText", "OperationCanceledException"])
    if (typeof ts[name] !== "function") missing.push(name);
  if (!ts.sys || typeof ts.sys !== "object") missing.push("sys");
  return missing;
}

/**
 * The program to build: with explicit `files`, those files under the config nearest to the first; else the config's files, or
 * every source file under `cwd` when there is no config (default options).
 */
export function planProject(ts, { cwd, files, maxFiles }) {
  const forced = forcedOptions();
  const defaults = {
    ...forced,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
    resolveJsonModule: true,
    strict: false,
  };
  const explicit = files.map((f) => resolve(cwd, f));
  const configPath = findConfig(explicit.length > 0 ? dirname(explicit[0]) : cwd, cwd);
  if (!configPath) {
    const roots = explicit.length > 0 ? explicit : [];
    if (explicit.length === 0) listSources(cwd, roots, maxFiles);
    return { roots, options: defaults, config: undefined, errors: [] };
  }
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, forced, host);
  return {
    roots: explicit.length > 0 ? explicit : parsed.fileNames.filter((f) => !f.endsWith(".d.ts")).slice(0, maxFiles),
    totalConfigured: parsed.fileNames.length,
    options: { ...parsed.options, ...forced },
    config: relative(cwd, configPath),
    errors: parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error),
  };
}
