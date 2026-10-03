# Worker tool set

Implemented natively on Pi 0.99.1's public API (`ToolDefinition` custom tools + the `tool_result` extension hook); no OMP code or SDK. `createSession` registers `createOrcheTools({ cwd })` automatically and callers pick tools with an allowlist: `WORKER_TOOL_NAMES` (editing workers, the `AgentManager` default) or `READ_ONLY_TOOL_NAMES` (analyst/verifier/coordinator/advisor), both exported from `src/tools/index.ts`.

| Tool | Source | Purpose |
| --- | --- | --- |
| `read` | ours, replaces Pi's | Anchored text ranges, declaration outlines and symbol reads; 2000 lines / 50KB cap with continuation; images delegate to Pi's reader |
| `edit` | ours, replaces Pi's | Atomic anchored edits, own-edit anchor rebasing, compact fresh-anchor echo and advisory syntax feedback |
| `grep` | Pi built-in (ripgrep, enabled by allowlist) | Content search; needs `rg` (Pi uses a system `rg` or downloads one) |
| `find` | Pi's tool, in-process walk | Glob search without `fd`; skips `.git`, `node_modules`, `.orche`; sees dot-directories |
| `ls` | Pi built-in | Directory listing |
| `ast_search` | ours, `@ast-grep/napi` | Structural search (JS/TS/TSX/HTML/CSS) with metavariable patterns |
| `ast_rewrite` | ours, `@ast-grep/napi` | Structural rewrite across files, `dryRun`, nested matches skipped |
| `diagnostics` | ours, TypeScript compiler API | Type/syntax errors for files or project, in a worker thread |
| `bash`, `write` | Pi built-ins | unchanged |

The model sees exactly one `read` and one `edit`: custom tools registered under a built-in name replace it in Pi's registry (`customTools` are applied after built-ins), and the allowlist only names `read`/`edit` once.

## Anchored read/edit

`read` prints non-blank lines as `12#abcd|text`: four lowercase hex characters from the SHA-256 of the exact line content, without its EOL. Empty or whitespace-only lines print `12|<original whitespace>` with no tag. The line number and tag together detect stale content; identical lines share a tag.

`edit` accepts `N#tag` or a pasted `N#tag|text`, with **4–16 hex characters**, case-insensitively; old 16-hex anchors remain valid. A tag must match the beginning of the current line's full SHA-256. Bare `N` or pasted `N|text` is accepted **only for a blank line**; non-blank lines require `LINE#TAG`. Inserts also accept `BOF`/`EOF`. The pasted text is not used for validation.

For a changed non-blank line at the checked line number, a four-hex tag has a per-anchor accidental stale-detection miss probability of **2^-16** (1 in 65,536), on top of the line-number check. This is not cryptographic proof against intentional collisions. Blank anchors check blankness, not exact whitespace. Tags add only five characters (`#` plus four hex) to non-blank lines.

### Rebasing across your own edits

One history registry is shared by `read` and `edit` in each tool set. It records only lines actually shown by normal/symbol reads, edit echoes and stale-error excerpts. A matching anchor shown by a **read or symbol read in the current version always wins** and addresses its printed line directly. Otherwise, matching echo/excerpt and older-version showings are mapped through the tool's own edits and checked against current text. Unchanged lines shift with insertions/deletions; replaced/deleted lines have no image. A single surviving target is accepted; distinct targets (including blank-line anchors) are rejected as ambiguous. **After ambiguity rejection, re-read the lines you want to change**; that current read resolves the ambiguity. Successful rebasing adds, for example, `Rebased anchors from before your earlier edit: 50->52, 61->63.`

External changes (`bash`, `write`, `ast_rewrite`, another session) disable rebasing: anchors are validated against current text only. A read of changed text starts a new history segment. History is bounded to 16 versions per file, 64 files (LRU), and 20,000 shown-line entries per file; evicted or never-shown anchors fall back to current-text validation. Re-read when mapping is unavailable.

- After rebasing, all edits in one call still address **one snapshot**, not the results of earlier operations in the list. Operations apply atomically; overlapping ranges are rejected.
- Every anchor is validated first. A stale or out-of-range anchor aborts the whole call without changes; errors show nearby current lines with fresh anchors.
- CRLF, BOM and a missing trailing newline are preserved; edits use Pi's per-file mutation queue. Byte-identical edits are rejected.

### Compact echo and syntax advisory

The header stays `Edited <path>: <before> -> <after> lines. Current region (anchors are fresh):`. The echo shows one context line on each side of each changed region, at most **40 body lines**, with line text clipped at 300 characters. When one operation adds/replaces more than eight new lines, only its first two and last two are shown, separated by `… [k new lines not shown; read offset=X limit=k for their anchors] …`. Only printed anchored lines enter history; use the suggested read to obtain omitted anchors.

For `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, when both old and new text are at most 1 MB, async ast-grep parsing compares ERROR/missing-node counts. Only an increased count adds `Syntax check: n new parse error(s) near line(s) L1[, L2, L3]; the edit was applied, fix it if unintended.` It lists at most three positions, preferring positions within three lines of edited regions. This is advisory, not a typecheck: it never rejects or rolls back an edit. An unchanged error count or a parse failure produces no note.

## Outline and symbol reads

For JS/TS extensions listed above and `.md`/`.markdown`, files up to **2 MB** support:

- `read({path, outline: true})`: `<path>: N lines, k declarations`, then `<start>-<end> <kind> <qualified name>`, indented two spaces per nesting level. Lists functions, classes, methods/getters/setters, interfaces, types, enums, namespaces, top-level const/let bindings (function initializers shown as functions), and default exports. Markdown headings show section ranges and ignore fenced code. At most 300 entries print, then `… k more`. Outlines have **no anchors** and record no anchor history.
- `read({path, symbol: "Class.method"})`: case-insensitive exact match on the short name, dotted qualified name or Markdown heading text. Each match prints `-- <kind> <name> (lines a-b)` and normal anchored lines, including attached leading comments/JSDoc/decorators. All matches print within the normal 2000-line / 50KB cap; continuation uses a normal read with `offset`. These anchors enter history and can be edited. No match is an error with up to 20 similar names.

`outline: true` and `symbol` cannot be supplied together or with `offset`/`limit`; `outline: false` is unset. Empty or whitespace-only symbols are rejected. Unsupported types suggest offset/limit or grep; files over 2 MB suggest grep. A normal read cut by its line/byte cap hints at `outline: true`, then `symbol`.

## ast tools

Languages: TypeScript, TSX, JavaScript(JSX), HTML, CSS (built into the napi binding; other grammars would need separate `@ast-grep/lang-*` packages). `ast_rewrite` expands `$X` / `$$$X` itself from the captures (the binding's `replace` does not substitute metavariables); template newlines inherit the match's indentation. Limits: 2000 files, 2MB per file, 100 search matches, 1000 rewrites per call.

## diagnostics

Runs the workspace's own `typescript` when resolvable from `<cwd>/package.json`, else this repo's (hence `typescript` is a runtime dependency). Work happens in a `worker_threads` Worker (`diagnostics-worker.mjs`) so a slow program build cannot block the orchestrator; per-file checking is cancelled cooperatively at 30s and the worker is hard-killed 5s later. Nothing is written to the workspace.

- With `files`: checks those files (and resolves what they import). Without: the nearest `tsconfig.json`/`jsconfig.json` between the files and the workspace root (never above it), else all JS/TS sources (cap 400 files).
- `allowJs` and `checkJs` are always forced on and emit/incremental/composite off, so plain JS projects get real type errors; `strict` etc. come from the config, defaults when there is none (ES2022, NodeNext, non-strict).
- Syntax errors in a file suppress its semantic diagnostics (cascades are noise). Output capped at 50 errors.
- Ignored as environment noise: `Cannot find module` for bare package specifiers and missing node typings (`require`, `process`, ...). Relative-import errors are kept.
- Cost: about 1.5s per call (typescript load + default libs).

## Artifact spill

An extension (`src/tools/spill.ts`, registered by `createSession`) hooks `tool_result` for every tool. A result over 12,000 chars or 300 lines is replaced by the first 40 + last 80 lines (capped by chars) with an omission marker and `[Output truncated (...). Full output saved to .orche/artifacts/<tool>-<id>.txt; use read with offset/limit or grep to inspect it.]`. The artifact lives under the session cwd and has `.gitignore` and `.ignore` (`*`) so it stays out of `git status` and out of grep/find. Details:

- `read` is exempt: it caps itself with offset continuation, and exempting it lets artifacts be paged without being re-spilled.
- Pi's bash already keeps only the last 2000 lines/50KB and writes the real full output to a temp file; for that case the artifact is a copy of Pi's temp file (up to 32MB are used for the inline preview, bigger files keep Pi's tail as preview) and Pi's trailing `Command exited with code N` / abort / timeout status line is carried over. `isError` is preserved.
- If saving the artifact fails the result is still truncated and says so.
- The exported thresholds are `SPILL_MAX_CHARS` and `SPILL_MAX_LINES`.
- Reusable entry point: `spillToolResult(event: { toolName, content, details? }, cwd): Promise<{ content, details? } | undefined>` (`undefined` = leave the result unchanged); `createSpillExtension(cwd)` is a thin `tool_result` wrapper over it, so Pi extensions can call it with the event they receive.

## Base prompt switch

`SessionOptions.baseSystemPrompt` becomes the resource loader's system prompt, replacing Pi's default base prompt. Note Pi's structured prompt builder then omits its own tool/guideline sections entirely (only the custom preamble, the appended role instructions and cwd remain); the model still gets tool schemas and each tool's description through the API, but not the `promptSnippet`/`promptGuidelines` lines.
