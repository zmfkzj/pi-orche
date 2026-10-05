// code_nav in a worker thread (a program build must never block the orchestrator's event loop; the parent kills it at the
// deadline). TypeScript/JavaScript answers come from the TypeScript LanguageService ("semantic"); other languages, and names the
// program does not know, fall back to bounded regex search ("heuristic"). Plain JS so Node can load it without a TS loader.
import { workerData, parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { planProject, SKIPPED, SOURCE } from "./ts-project.mjs";

const { tsPath, cwd, op, symbol, file, line, column, query, limit, maxFiles, deadline } = workerData;
const ts = createRequire(import.meta.url)(tsPath);

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)test_[^/]*\.py$|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)conftest\.py$/i;
const OTHER_SOURCE = /\.(py|rs|go|java|kt|kts|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|lua|sh|ex|exs|erl|hs|ml|dart|vue|svelte)$/i;
const rel = (path) => relative(cwd, path).split(sep).join("/");
const inside = (path) => { const r = relative(cwd, path); return r && !r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes("node_modules"); };
const overdue = () => Date.now() > deadline;
const lines = new Map();
function lineText(path, index) {
  if (!lines.has(path)) { try { lines.set(path, readFileSync(path, "utf8").split(/\r?\n/)); } catch { lines.set(path, []); } }
  return (lines.get(path)[index] ?? "").trim().slice(0, 160);
}
const items = [];
let total = 0;
const push = (path, zeroLine, kind, text) => { total++; if (items.length < limit) items.push({ file: rel(path), line: zeroLine + 1, kind, text: text ?? lineText(path, zeroLine) }); };

// ---- TypeScript LanguageService ----
let service, program, roots = [], config;
function semantic() {
  if (service !== undefined) return service;
  const planned = planProject(ts, { cwd, files: [], maxFiles });
  roots = planned.roots;
  config = planned.config;
  if (!roots.length) return (service = null);
  const snapshots = new Map();
  const host = {
    getScriptFileNames: () => roots,
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      if (!snapshots.has(name)) snapshots.set(name, existsSync(name) ? ts.ScriptSnapshot.fromString(readFileSync(name, "utf8")) : undefined);
      return snapshots.get(name);
    },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => planned.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
    getCancellationToken: () => ({ isCancellationRequested: overdue }),
  };
  service = ts.createLanguageService(host, ts.createDocumentRegistry());
  program = service.getProgram();
  return service;
}
const positionOf = (path, zeroLine, zeroColumn) => {
  const source = program.getSourceFile(path);
  return source ? ts.getPositionOfLineAndCharacter(source, Math.min(zeroLine, source.getLineStarts().length - 1), zeroColumn) : undefined;
};
const lineOf = (path, position) => { const source = program.getSourceFile(path); return source ? source.getLineAndCharacterOfPosition(position).line : 0; };

/** Where the request points: an explicit file:line[:column] (the symbol's column on that line when given), else declarations of `symbol`. */
function targets() {
  const ls = semantic();
  if (!ls) return [];
  if (file) {
    const path = resolve(cwd, file);
    if (!program.getSourceFile(path)) return [];
    if (line === undefined) {
      if (!symbol) return [];
      const text = readFileSync(path, "utf8");
      const index = new RegExp(`\\b${escape(symbol.split(".").at(-1))}\\b`).exec(text)?.index;
      return index === undefined ? [] : [{ path, position: index }];
    }
    let col = column !== undefined ? column - 1 : 0;
    if (column === undefined && symbol) {
      const found = lineText(path, line - 1) ? (lines.get(path)[line - 1] ?? "").search(new RegExp(`\\b${escape(symbol.split(".").at(-1))}\\b`)) : -1;
      if (found >= 0) col = found;
    }
    const position = positionOf(path, line - 1, col);
    return position === undefined ? [] : [{ path, position }];
  }
  if (!symbol) return [];
  const parts = symbol.split(".");
  const name = parts.at(-1);
  const container = parts.length > 1 ? parts.at(-2) : undefined;
  return ls.getNavigateToItems(name, 50, undefined, true)
    .filter((item) => item.name === name && (!container || item.containerName === container) && inside(item.fileName))
    .map((item) => ({ path: item.fileName, position: namePosition(item), kind: item.kind, container: item.containerName }));
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A navigate-to item spans its whole declaration (`export async function f…`); the language service wants the name. */
function namePosition(item) {
  const source = program.getSourceFile(item.fileName);
  if (!source) return item.textSpan.start;
  const text = source.text.slice(item.textSpan.start, item.textSpan.start + item.textSpan.length);
  const match = new RegExp(`(^|[^\\w$])${escape(item.name)}(?![\\w$])`).exec(text);
  return match ? item.textSpan.start + match.index + match[1].length : item.textSpan.start;
}

function semanticOp() {
  const ls = semantic();
  if (!ls) return false;
  switch (op) {
    case "symbols": {
      const path = resolve(cwd, file);
      if (!program.getSourceFile(path)) return false;
      const walk = (node, depth) => {
        for (const child of node.childItems ?? []) {
          if (overdue()) return;
          const span = child.spans[0];
          push(path, lineOf(path, span.start), `${"  ".repeat(depth)}${child.kind}`, `${child.text}${child.kindModifiers ? ` (${child.kindModifiers})` : ""}`);
          if (depth < 2 && child.kind !== "function" && child.kind !== "method") walk(child, depth + 1);
        }
      };
      walk(ls.getNavigationTree(path), 0);
      return true;
    }
    case "locate": {
      for (const item of ls.getNavigateToItems(query, limit * 2, undefined, true).filter((entry) => inside(entry.fileName))) {
        const at = lineOf(item.fileName, namePosition(item));
        push(item.fileName, at, item.kind, `${item.containerName ? `${item.containerName}.` : ""}${item.name} — ${lineText(item.fileName, at)}`);
      }
      return total > 0;
    }
    case "imports": {
      const path = resolve(cwd, file);
      const source = program.getSourceFile(path);
      if (!source) return false;
      for (const imported of ts.preProcessFile(source.text, true, true).importedFiles) {
        const resolved = ts.resolveModuleName(imported.fileName, path, program.getCompilerOptions(), ts.sys).resolvedModule;
        const target = resolved && inside(resolved.resolvedFileName) ? rel(resolved.resolvedFileName) : resolved?.isExternalLibraryImport ? "(package)" : "(unresolved)";
        push(path, source.getLineAndCharacterOfPosition(imported.pos).line, "import", `${imported.fileName} → ${target}`);
      }
      return true;
    }
    case "importers": {
      const target = resolve(cwd, file);
      for (const source of program.getSourceFiles()) {
        if (overdue()) break;
        if (!inside(source.fileName) || source.isDeclarationFile) continue;
        for (const imported of ts.preProcessFile(source.text, true, true).importedFiles) {
          const resolved = ts.resolveModuleName(imported.fileName, source.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
          if (resolved && resolve(resolved.resolvedFileName) === target) push(source.fileName, source.getLineAndCharacterOfPosition(imported.pos).line, TEST_FILE.test(rel(source.fileName)) ? "test import" : "import");
        }
      }
      return true;
    }
    default: break;
  }
  const found = targets();
  if (!found.length) return false;
  if (op === "def") {
    for (const target of found) {
      const definitions = symbol && !file ? [{ fileName: target.path, textSpan: { start: target.position }, kind: target.kind }] : ls.getDefinitionAtPosition(target.path, target.position) ?? [];
      for (const definition of definitions) if (inside(definition.fileName)) push(definition.fileName, lineOf(definition.fileName, definition.textSpan.start), definition.kind || "definition");
    }
    return total > 0;
  }
  if (op === "refs" || op === "tests") {
    const seen = new Set();
    for (const target of found.slice(0, 3)) {
      for (const group of ls.findReferences(target.path, target.position) ?? []) {
        for (const reference of group.references) {
          if (overdue()) break;
          const key = `${reference.fileName}:${reference.textSpan.start}`;
          if (seen.has(key) || !inside(reference.fileName)) continue;
          seen.add(key);
          const isTest = TEST_FILE.test(rel(reference.fileName));
          if (op === "tests" && !isTest) continue;
          push(reference.fileName, lineOf(reference.fileName, reference.textSpan.start), reference.isDefinition ? "definition" : reference.isWriteAccess ? "write" : isTest ? "test" : "ref");
        }
      }
    }
    return true;
  }
  if (op === "impl") {
    for (const target of found.slice(0, 3)) for (const implementation of ls.getImplementationAtPosition(target.path, target.position) ?? []) {
      if (inside(implementation.fileName)) push(implementation.fileName, lineOf(implementation.fileName, implementation.textSpan.start), implementation.kind || "implementation");
    }
    return true;
  }
  if (op === "callers" || op === "callees") {
    for (const target of found.slice(0, 3)) {
      const calls = op === "callers" ? ls.provideCallHierarchyIncomingCalls(target.path, target.position) : ls.provideCallHierarchyOutgoingCalls(target.path, target.position);
      for (const call of calls ?? []) {
        const item = op === "callers" ? call.from : call.to;
        if (!inside(item.file)) continue;
        const spans = op === "callers" ? call.fromSpans : [item.selectionSpan];
        for (const span of spans.slice(0, 3)) {
          push(item.file, lineOf(item.file, span.start), op === "callers" ? `called in ${item.name}` : `calls ${item.name}`);
        }
      }
    }
    return true;
  }
  return false;
}

// ---- heuristic (regex) search ----
function walk(dir, out) {
  if (out.length >= maxFiles || overdue()) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= maxFiles) return;
    if (entry.isDirectory()) { if (!SKIPPED.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name), out); }
    else if ((SOURCE.test(entry.name) || OTHER_SOURCE.test(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(join(dir, entry.name));
  }
}
const DEFINITION = (name) => new RegExp(`\\b(def|class|fn|func|function|struct|enum|trait|interface|type|const|let|var|impl|module|object|record)\\s+${name}\\b|\\b${name}\\s*(=|:)\\s*(async\\s+)?(function|\\(|lambda)|^\\s*(pub\\s+)?(async\\s+)?fn\\s+${name}\\b`);
function heuristicOp() {
  const files = [];
  if ((op === "symbols" || op === "imports") && file) files.push(resolve(cwd, file)); else walk(cwd, files);
  const name = symbol ? escape(symbol.split(".").at(-1)) : query ? escape(query) : undefined;
  const definition = name ? DEFINITION(name) : /\b(def|class|fn|func|function|struct|enum|trait|interface|impl)\s+([A-Za-z_]\w*)/;
  const word = name ? new RegExp(`\\b${name}\\b`) : undefined;
  for (const path of files) {
    if (overdue()) break;
    let text;
    try { if (statSync(path).size > 2_000_000) continue; text = readFileSync(path, "utf8"); } catch { continue; }
    const all = text.split(/\r?\n/);
    lines.set(path, all);
    const isTest = TEST_FILE.test(rel(path));
    if (op === "tests" && !isTest && !(file && basename(path).includes(basename(file, extname(file))))) continue;
    all.forEach((content, index) => {
      if (op === "symbols") { if (definition.test(content)) push(path, index, "declaration"); return; }
      if (op === "imports") { if (/^\s*(import|from|use|require|#include)\b|\brequire\(/.test(content)) push(path, index, "import"); return; }
      if (op === "importers" && file) { const stem = basename(file, extname(file)); if (/^\s*(import|from|use|require)\b|\brequire\(/.test(content) && content.includes(stem)) push(path, index, isTest ? "test import" : "import"); return; }
      if (!word) return;
      if (op === "def" || op === "impl") { if (definition.test(content)) push(path, index, "definition"); return; }
      if (word.test(content)) push(path, index, definition.test(content) ? "definition" : isTest ? "test" : "ref");
    });
  }
}

function overview() {
  const files = [];
  walk(cwd, files);
  const byDir = new Map();
  for (const path of files) { const top = rel(path).includes("/") ? rel(path).split("/")[0] : "."; byDir.set(top, (byDir.get(top) ?? 0) + 1); }
  const head = [`${files.length}${files.length >= maxFiles ? "+" : ""} source files: ${[...byDir].map(([dir, count]) => `${dir} ${count}`).join(", ")}`];
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    head.push(`package.json: ${[pkg.name, pkg.main && `main ${pkg.main}`, pkg.exports && `exports ${JSON.stringify(pkg.exports).slice(0, 120)}`, pkg.bin && "bin", pkg.scripts?.test && `test: ${pkg.scripts.test}`].filter(Boolean).join("; ")}`);
  } catch { /* no package.json */ }
  for (const name of ["pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json", "jsconfig.json"]) if (existsSync(join(cwd, name))) head.push(`${name} present`);
  const ls = files.some((path) => SOURCE.test(path)) ? semantic() : null;
  for (const path of files.slice(0, 80)) {
    if (overdue()) break;
    if (ls && program.getSourceFile(path)) {
      const names = (ls.getNavigationTree(path).childItems ?? []).filter((child) => child.kind !== "alias").slice(0, 8).map((child) => child.text);
      push(path, 0, TEST_FILE.test(rel(path)) ? "test file" : "file", names.join(", ") || "(no top-level declarations)");
    } else push(path, 0, TEST_FILE.test(rel(path)) ? "test file" : "file", "");
  }
  return head;
}

try {
  let confidence = "semantic";
  let head = [];
  if (op === "overview") head = overview();
  else {
    const jsTarget = !file || SOURCE.test(file);
    let answered = false;
    if (jsTarget) {
      try { answered = semanticOp(); } catch (error) { if (!(error instanceof ts.OperationCanceledException)) head.push(`semantic lookup failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!answered) { items.length = 0; total = 0; confidence = "heuristic"; heuristicOp(); }
    else if ((op === "refs" || op === "tests") && symbol && !items.some((item) => item.kind !== "definition")) {
      // Untyped JavaScript often hides member uses (`store.claim()` on an untyped `store`) from the type checker: add textual matches.
      const known = new Set(items.map((item) => `${item.file}:${item.line}`));
      const before = items.length;
      heuristicOp();
      const added = items.splice(before).filter((item) => !known.has(`${item.file}:${item.line}`)).map((item) => ({ ...item, kind: `${item.kind} (text match)` }));
      total = before + added.length;
      items.push(...added);
      if (added.length) confidence = "semantic+heuristic";
    }
  }
  parentPort.postMessage({ ok: true, items, total, confidence, head, config, timedOut: overdue() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
