// Runs in a worker thread so a slow program build never blocks the orchestrator's event loop;
// the parent terminates it at the deadline. Plain JS so Node can load it without a TS loader.
import { workerData, parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { isAbsolute, relative, sep } from "node:path";
import { planProject, typeScriptProblems } from "./ts-project.mjs";

const { projectTsPath, projectTsUnresolved, bundledTsPath, cwd, files, maxFiles, deadline, maxItems } = workerData;
/** @type {any} */
let ts;

const firstLine = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);

/**
 * The project's TypeScript when it loads and has every piece the worker uses; else orche's own (`bundledTsPath`), with a
 * note saying why the project's was skipped (e.g. a half-finished `npm install typescript`).
 */
function loadTypeScript() {
  const load = createRequire(import.meta.url);
  const shown = (path) => {
    const rel = relative(cwd, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : path;
  };
  // Set by the parent when the project has node_modules/typescript that does not even resolve.
  let skipped = projectTsUnresolved;
  let label = "node_modules/typescript";
  if (projectTsPath && projectTsPath !== bundledTsPath) {
    label = shown(projectTsPath);
    try {
      const candidate = load(projectTsPath);
      const missing = typeScriptProblems(candidate);
      if (missing.length === 0) return { ts: candidate };
      skipped = `it is incomplete (missing ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""})`;
    } catch (error) {
      skipped = `it failed to load (${firstLine(error)})`;
    }
  }
  const bundled = load(bundledTsPath);
  const missing = typeScriptProblems(bundled);
  if (missing.length) throw new Error(`TypeScript at ${bundledTsPath} is incomplete (missing ${missing.join(", ")})${skipped ? `; the project's (${label}) was skipped because ${skipped}` : ""}`);
  return { ts: bundled, note: skipped ? `TypeScript: used orche's bundled ${bundled.version}; the project's (${label}) was skipped because ${skipped}.` : undefined };
}

// Noise that only says "this workspace lacks installed packages / node typings".
const IGNORED_CODES = new Set([2580, 2591, 2592, 2593]);
const MODULE_NOT_FOUND = 2307;

class Deadline {
  isCancellationRequested() {
    return Date.now() > deadline;
  }
  throwIfCancellationRequested() {
    if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
  }
}

const plan = () => planProject(ts, { cwd, files, maxFiles });

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
  const loaded = loadTypeScript();
  ts = loaded.ts;
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
  parentPort.postMessage({ ok: true, items, total, checked, files: fileCount, configured: totalConfigured, config, timedOut, typescriptNote: loaded.note });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
