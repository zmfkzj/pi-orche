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

## Delegation recovery and small changes

In extension `auto` mode, a failed `orche_run` (not a user/signal cancellation) transfers live implementer/verifier/explorer sessions to the `orche_task` pool as implement/verify/explore. Its **Handover** section lists usable `worker` ids, last tasks and remaining issues. Reuse those ids with `orche_task` for fixes and re-checks; do not repeat `orche_run` for the same failed request. `/orche workers`, idle expiry and `/orche stop` apply normally. Context stays intact, without task-output projection on transferred run sessions. Multi mode skips handover and says so; successful/cancelled runs and SDK calls without `RunOptions.onFailedHandover` keep normal disposal.

A `change` classified with `workerCount: 1` makes only that classification coordinator request. It deterministically assigns repository-wide ownership, executes and uses the usual independent V1 verification/audits. Pass summaries combine implementation and verification evidence. Failed verification reuses the implementer for fixes within `maxFixRounds` (default 1); exhausted issues or a blocked implementer fail immediately. Other task classes and worker counts keep their existing planning.

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

## Output filters and artifact spill

The `tool_result` hook (`src/tools/spill.ts`) reduces model-side text while saving the full original under `<cwd>/.orche/artifacts/<tool>-<id>.txt`. Artifact-directory `.gitignore` and `.ignore` files contain `*`, keeping artifacts out of git status and searches. Every reduction ends with one notice naming the omitted/collapsed content and artifact path; use `read` with offset/limit or grep to recover it.

**Specialized filters apply only to `bash` and Pi's built-in `grep`.** Bash classification uses both `input.command` and content. Test/compiler/linter filters require **at least 2,000 characters or 60 lines**, and keep the original if savings are less than **20%**:

Analysis clips each line to **2,000 characters** with a `…[+N chars]` suffix before classification/regex work and strips ANSI once; the artifact remains complete. Long lines also receive a linear whole-line diagnostic-word scan (no unclipped regexes), so diagnostics in clipped tails are kept or counted and prioritized. The notice counts long lines clipped at 2,000 characters. Content classification samples the first/last 400 lines. Outputs above **2 MB** skip specialized filters. A specialized summary still over the spill trigger falls back to the generic preview of the original output, preserving artifact line numbers, diagnostic priority and omitted-diagnostic counts; the notice says the summary was too large.

- **Tests:** vitest, jest, mocha, `node --test`, pytest, `go test`, `cargo test`. Passing/progress lines are omitted; failure headers, assertion/error messages, expected/received diffs, code frames, attached console output and final summaries remain, with up to ten stack-frame lines per failure. Pass-only output keeps the summary and an omitted-line count.
- **TypeScript:** plain `file(l,c): error TSnnnn` and pretty `file:l:c - error TSnnnn`. Keeps errors and indented message continuations, removes pretty source/underline frames, and collapses identical code/message errors into a count with up to five locations. Keeps `Found N errors`.
- **ESLint/Biome-style linters:** retains error entries and file headers; warnings collapse per rule into a count with up to three locations. Summaries remain.
- **Grep:** only when every line is a Pi match/context line (`path:N: text` / `path-N- text`) or a trailing notice. Groups repeated file paths under a file header with indented `N: text` / `N- text`. Paths may contain dashes/colons. Applies only when it saves **at least 15%** of characters; no 2,000-character/60-line minimum.

The generic spill trigger remains **over 12,000 characters or 300 lines**. For oversized bash/grep output (including when a specialized filter declines), fallback previews always keep a bounded head of **30 lines / 3,000 characters**, middle diagnostic lines matching `error|fail|warn|exception|panic|traceback|✗|×` (up to **40 lines / 3,000 characters**), and a tail of **60 lines / 4,000 characters**, each with original `[L123]` line numbers. Lines clip at 1,000 characters. The middle budget prioritizes errors/failures over warnings, then displays selected lines in original order. The notice counts matching diagnostic lines omitted and directs the model to grep the full artifact. Specialized filters never silently drop diagnostics; generic previews do not apply below the spill trigger.

`read` is exempt (it pages itself). Other tools, including delegation and browser tools, receive only generic head/tail spill at the unchanged trigger, without specialized filtering or numbered diagnostic-middle selection.

- Pi bash's full-output temp file is recovered before filtering; the artifact copies that file. Up to 32 MB is read for inline reduction; larger files use Pi's existing tail for the preview and retain the full copied artifact. If no reduction applies, only Pi's existing truncated text is inlined, never the recovered full output.
- Pi's trailing `Command exited with code N` / abort / timeout line and `isError` are preserved. Replacement results omit `structuredContent`: Pi drops the original when `content` alone is replaced, avoiding text that could violate a tool's output schema.
- If artifact saving fails, the result says so. `SPILL_MAX_CHARS` / `SPILL_MAX_LINES` remain exported.
- Reusable entry points: `spillToolResult(event, cwd)` (event includes `toolName`, `input`, `content`, `details`, `isError`, optional `structuredContent`) and `createSpillExtension(cwd)`. An undefined return leaves the original result unchanged.

## Base prompt switch

`SessionOptions.baseSystemPrompt` becomes the resource loader's system prompt, replacing Pi's default base prompt. Note Pi's structured prompt builder then omits its own tool/guideline sections entirely (only the custom preamble, the appended role instructions and cwd remain); the model still gets tool schemas and each tool's description through the API, but not the `promptSnippet`/`promptGuidelines` lines.

Run worker instructions are static per role/loadout for prompt-cache reuse. A run-context-tracked first-assignment briefing supplies identity and reply language, plus the user request if the assignment does not already contain it; later assignments do not repeat the briefing. Coordinator, advisor and `orche_task` system instructions are unchanged. Worker summaries start with a one-to-three-sentence conclusion, then `path:line` evidence and command outcomes, without pasted code/diffs/logs the reader can open. Answer summaries remain complete and cite source locations.
