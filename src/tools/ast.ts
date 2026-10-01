import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath } from "./anchors.js";
import { walkFiles } from "./walk.js";

const LANGUAGES: Record<string, Lang> = {
  typescript: Lang.TypeScript,
  tsx: Lang.Tsx,
  javascript: Lang.JavaScript,
  html: Lang.Html,
  css: Lang.Css,
};
const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
};
const LANGUAGE_NAMES = Object.keys(LANGUAGES);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 100;
const MAX_REWRITES = 1000;
const MAX_SHOWN_CHANGES = 40;

const languageParam = Type.Optional(
  Type.String({ description: `Restrict to one language: ${LANGUAGE_NAMES.join(", ")} (default: chosen per file extension)` }),
);
const common = {
  pattern: Type.String({
    description: "ast-grep pattern: code with metavariables, e.g. `console.log($A)`; `$X` = one node, `$$$X` = zero or more nodes",
  }),
  path: Type.Optional(Type.String({ description: "File or directory to search (default: workspace root)" })),
  language: languageParam,
  selector: Type.Optional(
    Type.String({ description: "Tree-sitter node kind inside the pattern to match, for fragments that do not parse alone" }),
  ),
};

const searchSchema = Type.Object({
  ...common,
  limit: Type.Optional(Type.Number({ description: `Max matches (default ${MAX_MATCHES})` })),
});
const rewriteSchema = Type.Object({
  ...common,
  replacement: Type.String({ description: "Replacement code; may use the pattern's metavariables ($X, $$X). Empty string deletes the match." }),
  dryRun: Type.Optional(Type.Boolean({ description: "Report what would change without writing (default false)" })),
});

interface Target {
  file: string;
  display: string;
  lang: string;
}

async function collectTargets(root: string, path: string | undefined, language: string | undefined): Promise<Target[]> {
  if (language !== undefined && !(language in LANGUAGES))
    throw new Error(`Unsupported language "${language}". Supported: ${LANGUAGE_NAMES.join(", ")}`);
  const base = resolveWorkspacePath(root, path ?? ".");
  const targets: Target[] = [];
  await walkFiles(base, (rel, name) => {
    const lang = EXTENSIONS[extname(name).toLowerCase()];
    if (lang !== undefined && (language === undefined || language === lang)) {
      targets.push(
        rel === ""
          ? { file: base, display: path ?? name, lang }
          : { file: join(base, rel), display: join(path ?? "", rel), lang },
      );
    }
    return targets.length < MAX_FILES;
  });
  return targets;
}

function matcher(pattern: string, selector: string | undefined) {
  return selector === undefined ? pattern : { rule: { pattern: { context: pattern, selector } } };
}

async function parseTarget(target: Target) {
  const text = await readFile(target.file, "utf8");
  if (text.length > MAX_FILE_BYTES) return undefined;
  return { text, root: parse(LANGUAGES[target.lang]!, text).root() };
}

const oneLine = (text: string, max = 160) => {
  const first = text.split("\n")[0]!;
  const suffix = text.includes("\n") ? " …" : "";
  return (first.length > max ? first.slice(0, max) + "…" : first) + suffix;
};

export function createAstSearchTool(cwd: string): ToolDefinition {
  return {
    name: "ast_search",
    label: "ast_search",
    description:
      "Structural code search with ast-grep (JS/TS/TSX/HTML/CSS). The pattern is code with metavariables ($X one node, $$$X many); it matches syntax, not text, so formatting and comments do not matter. Returns path:line plus matched code and captures. Prefer over grep for call sites, imports, declarations.",
    promptSnippet: "Structural (AST) code search with metavariable patterns",
    parameters: searchSchema,
    async execute(_id, params: Static<typeof searchSchema>, _signal, _onUpdate, ctx) {
      const root = ctx?.cwd || cwd;
      const limit = Math.min(MAX_MATCHES, Math.max(1, Math.floor(params.limit ?? MAX_MATCHES)));
      const targets = await collectTargets(root, params.path, params.language);
      const lines: string[] = [];
      let matches = 0;
      let skipped = 0;
      for (const target of targets) {
        if (matches >= limit) break;
        const parsed = await parseTarget(target).catch(() => undefined);
        if (!parsed) {
          skipped++;
          continue;
        }
        let found: SgNode[];
        try {
          found = parsed.root.findAll(matcher(params.pattern, params.selector));
        } catch (error) {
          throw new Error(`Invalid pattern for ${target.lang}: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const node of found) {
          if (matches++ >= limit) break;
          const range = node.range();
          const captures = [...new Set(params.pattern.match(/\${1,3}[A-Z_][A-Z0-9_]*/g) ?? [])]
            .map((token) => {
              const name = token.replace(/^\$+/, "");
              if (token.startsWith("$$$")) {
                const parts = node.getMultipleMatches(name).filter((n) => n.isNamed());
                return parts.length === 0 ? undefined : `${token}=${oneLine(parts.map((n) => n.text()).join(", "), 100)}`;
              }
              const one = node.getMatch(name);
              return one ? `${token}=${oneLine(one.text(), 100)}` : undefined;
            })
            .filter((c): c is string => c !== undefined);
          lines.push(`${target.display}:${range.start.line + 1}: ${oneLine(node.text())}${captures.length ? `   [${captures.join("; ")}]` : ""}`);
        }
      }
      const reached = matches > limit ? ` (limit ${limit} reached; narrow pattern/path)` : "";
      const note = skipped > 0 ? `\n(${skipped} files skipped: unreadable or over ${MAX_FILE_BYTES / 1024 / 1024}MB)` : "";
      const text = lines.length === 0 ? `No matches in ${targets.length} files` : `${lines.join("\n")}\n\n${Math.min(matches, limit)} matches in ${targets.length} files${reached}`;
      return { content: [{ type: "text", text: text + note }], details: undefined };
    },
  };
}

const TOKEN = /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g;

/** Expand `$X` / `$$$X` in a replacement from the node's captures; template newlines keep the match's indent. */
function expand(template: string, node: SgNode, source: string): string {
  const range = node.range();
  const lineStart = source.lastIndexOf("\n", range.start.index - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, range.start.index))![0];
  let out = "";
  let last = 0;
  for (const token of template.matchAll(TOKEN)) {
    out += template.slice(last, token.index).replaceAll("\n", `\n${indent}`);
    last = token.index + token[0].length;
    if (token[1] !== undefined) {
      const parts = node.getMultipleMatches(token[1]);
      out += parts.length === 0 ? "" : source.slice(parts[0]!.range().start.index, parts.at(-1)!.range().end.index);
    } else {
      const one = node.getMatch(token[2]!);
      if (!one) throw new Error(`Replacement uses $${token[2]} which the pattern does not capture`);
      out += one.text();
    }
  }
  return out + template.slice(last).replaceAll("\n", `\n${indent}`);
}

export function createAstRewriteTool(cwd: string): ToolDefinition {
  return {
    name: "ast_rewrite",
    label: "ast_rewrite",
    description:
      "Structural rewrite with ast-grep (JS/TS/TSX/HTML/CSS): every match of `pattern` is replaced by `replacement`, where $X / $$$X reuse captured code (formatting of the rest is untouched). Writes files in place unless dryRun is true; nested matches are skipped (run again). Use for renames, call-signature changes and API migrations across many files; check with ast_search first.",
    promptSnippet: "Structural (AST) rewrite across files with metavariable patterns",
    parameters: rewriteSchema,
    async execute(_id, params: Static<typeof rewriteSchema>, _signal, _onUpdate, ctx) {
      const root = ctx?.cwd || cwd;
      const targets = await collectTargets(root, params.path, params.language);
      const shown: string[] = [];
      let rewrites = 0;
      let files = 0;
      let nested = 0;
      for (const target of targets) {
        if (rewrites >= MAX_REWRITES) break;
        const applied = await withFileMutationQueue(target.file, async () => {
          const parsed = await parseTarget(target).catch(() => undefined);
          if (!parsed) return 0;
          let found: SgNode[];
          try {
            found = parsed.root.findAll(matcher(params.pattern, params.selector));
          } catch (error) {
            throw new Error(`Invalid pattern for ${target.lang}: ${error instanceof Error ? error.message : String(error)}`);
          }
          const ordered = found.sort((a, b) => a.range().start.index - b.range().start.index);
          const edits: Array<{ start: number; end: number; text: string; before: string }> = [];
          let covered = -1;
          for (const node of ordered) {
            const { start, end } = node.range();
            if (start.index < covered) {
              nested++;
              continue;
            }
            covered = end.index;
            edits.push({ start: start.index, end: end.index, text: expand(params.replacement, node, parsed.text), before: node.text() });
          }
          if (edits.length === 0) return 0;
          let next = parsed.text;
          for (const edit of [...edits].reverse()) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
          if (!params.dryRun) await writeFile(target.file, next);
          for (const edit of edits) {
            if (shown.length < MAX_SHOWN_CHANGES) shown.push(`${target.display}:${parsed.text.slice(0, edit.start).split("\n").length}\n  - ${oneLine(edit.before)}\n  + ${oneLine(edit.text)}`);
          }
          return edits.length;
        });
        if (applied > 0) {
          files++;
          rewrites += applied;
        }
      }
      const verb = params.dryRun ? "Would rewrite" : "Rewrote";
      const text =
        rewrites === 0
          ? `No matches in ${targets.length} files; nothing changed`
          : `${verb} ${rewrites} matches in ${files} files${nested > 0 ? ` (${nested} nested matches skipped; rerun to rewrite them)` : ""}${rewrites >= MAX_REWRITES ? " (rewrite limit reached; rerun for the rest)" : ""}\n${shown.join("\n")}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
