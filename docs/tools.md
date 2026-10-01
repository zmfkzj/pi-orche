# Worker tool set

Implemented natively on Pi 0.99.1's public API (`ToolDefinition` custom tools + the `tool_result` extension hook); no OMP code or SDK. `createSession` registers `createOrcheTools({ cwd })` automatically and callers pick tools with an allowlist: `WORKER_TOOL_NAMES` (editing workers, the `AgentManager` default) or `READ_ONLY_TOOL_NAMES` (analyst/verifier/coordinator/advisor), both exported from `src/tools/index.ts`.

| Tool | Source | Purpose |
| --- | --- | --- |
| `read` | ours, replaces Pi's | Text lines as `LINE#TAG\|text`, `offset`/`limit`, 2000 lines / 50KB cap with a continuation hint; images delegate to Pi's reader |
| `edit` | ours, replaces Pi's | Anchored edit: `{op: replace\|delete\|insert_after\|insert_before, at, to?, text?}[]`, atomic, stale-tag rejection |
| `grep` | Pi built-in (ripgrep, enabled by allowlist) | Content search; needs `rg` (Pi uses a system `rg` or downloads one) |
| `find` | Pi's tool, in-process walk | Glob search without `fd`; skips `.git`, `node_modules`, `.orche`; sees dot-directories |
| `ls` | Pi built-in | Directory listing |
| `ast_search` | ours, `@ast-grep/napi` | Structural search (JS/TS/TSX/HTML/CSS) with metavariable patterns |
| `ast_rewrite` | ours, `@ast-grep/napi` | Structural rewrite across files, `dryRun`, nested matches skipped |
| `diagnostics` | ours, TypeScript compiler API | Type/syntax errors for files or project, in a worker thread |
| `bash`, `write` | Pi built-ins | unchanged |

The model sees exactly one `read` and one `edit`: custom tools registered under a built-in name replace it in Pi's registry (`customTools` are applied after built-ins), and the allowlist only names `read`/`edit` once.

## Anchored read/edit

`read` prints every line as `12#0123456789abcdef|text`. The tag is the first 64 bits of the SHA-256 of the line's exact content (16 hex chars); the line number plus tag pins a line to the content that was read. `edit` takes anchors verbatim (`12#0123456789abcdef`; a pasted `12#<tag>|text` line is tolerated, and inserts also accept `BOF`/`EOF`).

- All edits in one call address one snapshot of the file (line numbers are *not* shifted by earlier edits in the list) and are applied atomically. Overlapping ranges are rejected.
- Every anchor is validated first. A stale or out-of-range anchor aborts the whole call with no change and the error prints the current lines (with fresh tags) around each bad anchor.
- A successful edit prints the changed region with fresh anchors, so chained edits need no re-read.
- CRLF, BOM and a missing trailing newline are preserved; edits run inside Pi's per-file mutation queue.
- An edit that leaves the file byte-identical is rejected.

A line changed since the read keeps its anchor only on a 64-bit hash collision (about 2^-64), so a matching tag is treated as proof the content is unchanged. Identical lines share a tag; the line number disambiguates them. The tag adds 17 characters (`#` + 16 hex) to every line of read output.

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
