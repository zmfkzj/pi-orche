// Runs in a worker thread so a slow program build never blocks the orchestrator's event loop;
// the parent terminates it at the deadline. Plain JS so Node can load it without a TS loader.
import { workerData, parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const { tsPath, cwd, files, maxFiles, deadline, maxItems } = workerData;
const ts = createRequire(import.meta.url)(tsPath);

// Noise that only says "this workspace lacks installed packages / node typings".
const IGNORED_CODES = new Set([2580, 2591, 2592, 2593]);
const MODULE_NOT_FOUND = 2307;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED = new Set([".git", "node_modules", ".orche"]);

class Deadline {
  isCancellationRequested() {
    return Date.now() > deadline;
  }
  throwIfCancellationRequested() {
    if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
  }
}

function findConfig(startDir) {
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

function listSources(dir, out) {
  if (out.length >= maxFiles) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= maxFiles) return;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) listSources(join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(join(dir, entry.name));
  }
}

const forced = { allowJs: true, checkJs: true, noEmit: true, incremental: false, composite: false, declaration: false, declarationMap: false, emitDeclarationOnly: false, skipLibCheck: true };
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

function plan() {
  const explicit = files.map((f) => resolve(cwd, f));
  const configPath = findConfig(explicit.length > 0 ? dirname(explicit[0]) : cwd);
  if (!configPath) {
    const roots = explicit.length > 0 ? explicit : [];
    if (explicit.length === 0) listSources(cwd, roots);
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

function render(d) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n").slice(0, 3).join("\n    ");
  const code = `TS${d.code}`;
  if (!d.file) return { file: "(config)", line: 0, column: 0, text: `${code} ${message}` };
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
  return { file: relative(cwd, d.file.fileName).split(sep).join("/"), line: line + 1, column: character + 1, text: `${code} ${message.slice(0, 400)}` };
}

function keep(d) {
  if (d.category !== ts.DiagnosticCategory.Error || IGNORED_CODES.has(d.code)) return false;
  if (d.code === MODULE_NOT_FOUND) {
    const spec = /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, "\n"))?.[1];
    return spec !== undefined && /^[./]/.test(spec);
  }
  return true;
}

try {
  const { roots, options, config, errors, totalConfigured } = plan();
  const token = new Deadline();
  const items = errors.map(render);
  let total = items.length;
  let checked = 0;
  let timedOut = false;
  let fileCount = roots.length;
  if (roots.length > 0) {
    const program = ts.createProgram({ rootNames: roots, options });
    const targets = files.length > 0
      ? program.getSourceFiles().filter((sf) => {
        const path = relative(cwd, sf.fileName);
        return !sf.isDeclarationFile && !program.isSourceFileDefaultLibrary(sf) && !program.isSourceFileFromExternalLibrary(sf)
          && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`) && !path.split(sep).includes("node_modules");
      })
      : roots.map((f) => program.getSourceFile(f)).filter((sf) => sf && !program.isSourceFileFromExternalLibrary(sf));
    if (files.length > 0) fileCount = targets.length;
    for (const sf of targets) {
      try {
        let found = program.getSyntacticDiagnostics(sf, token);
        if (found.length === 0) found = program.getSemanticDiagnostics(sf, token);
        for (const d of found.filter(keep)) {
          total++;
          if (items.length < maxItems) items.push(render(d));
        }
        checked++;
      } catch (error) {
        if (error instanceof ts.OperationCanceledException) {
          timedOut = true;
          break;
        }
        throw error;
      }
    }
  }
  parentPort.postMessage({ ok: true, items, total, checked, files: fileCount, configured: totalConfigured, config, timedOut });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
