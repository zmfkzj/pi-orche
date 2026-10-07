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

## Main-session task tools (Pi package)

The Pi package (`src/extension/index.ts`) gives the main session four delegation tools. Schemas: `orcheTaskParameters`
(`src/extension/workers.ts`) and the `registerTool` calls in `index.ts`; full contract in [pi-package.md](pi-package.md) 5.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `orche_task` | `role`, `request` (required); `context?`, `worker?`, `files?`, `task?`, `git?`, `gui?`, and: `wait?` (boolean), `writeRoots?` (≤10 paths), `verificationRounds?` (integer 1–5, default 2) | Delegates one assignment to one persistent worker. In interactive (`tui`) and RPC sessions it starts a **background job** (J1, …) and stays **attached**: it waits and returns the result like a blocking call, unless it is detached first (see below); a detached call returns `Started job J1: worker W1 implement (model · thinking level). Detached from J1 (…): <why and what to do>`. `wait: false` detaches at once. `wait: true`, and every other mode (`pi -p` print, `--mode json`, SDK sessions without a UI mode), **block** without a job and return the result (aborting cancels), because those processes end with the turn. Errors before the worker has its assignment (unknown worker, bad arguments, a job already running) fail the call itself in all paths. |
| `orche_task_attach` | `job?` (`J<n>`; default the running job) | Attaches to the running job and waits for its result like `orche_task`; detaches the same way. Refused (`Not attached …`, `details.attach: "pending"`) while user input or an undelivered woken peer note is queued; for a job that already ended it says so (`already-ended`) and repeats nothing. Never restarts or cancels the worker. |
| `orche_task_status` | `job?` (`J<n>`; default the running job, else the latest), `cancel?` (boolean) | Job state, elapsed time, attached/detached, latest progress and the worker's liveness, or the result summary when it ended; `cancel: true` cancels the running job (also `/orche cancel`). Never waits; only when the user asks. |
| `orche_task_message` | `message` (1–20,000 chars, self-contained), `job?` (default the running job) | Queues an extra or corrected instruction for the running job's worker (`Queued M1 for W1 (J1): …`). |

**Attach and detach.** Attaching and detaching only change whether a tool call waits; the job's worker is untouched. An attached
call detaches when: an `input` event arrives (an interactive prompt, steer or follow-up, an RPC `steer`/`follow_up`; the call
returns once Pi has queued the input, `ctx.hasPendingMessages()`, at the latest after 1 s), a `session-bus:message` event with
`wake` other than `suppressed` arrives (pi-session-bus emits it after queuing the note as a steer), the call's abort signal fires
(Esc, RPC `abort`), or the user runs `/orche detach`. The result says why (`details.attach: "detached"`, `details.reason`: `input`,
`followUp`, `session-bus`, `abort`, `command`, `background`, `shutdown`) and what main should do: answer the input, then attach
again when nothing else waits (not after `/orche detach` unless asked; after Esc only after answering the next message; after a
follow-up end the turn first so it is delivered). A woken note counts as waiting until its `session-bus.message` reaches the
context (`message_end`), at most 60 s, and is forgotten at `agent_end`.

**Result delivery.** Exactly once per job: settling and detaching are synchronous, so whichever happens first wins. A job that ends
while a call is attached returns its result to that call (the blocking text; `orche_task_attach` adds the header line). A job that
ends while detached delivers the same text, headed `[orche task result · J1 · W1 implement · done after 12m]`, as one
`orche-task-result` custom message (`pi.sendMessage`, `triggerTurn: true`, `deliverAs: "followUp"`): it starts main's next turn,
or waits behind a turn in progress; the user also gets a one-line notification. Main never sleeps or polls. Each start and end is
an `orche-job` session entry (not model context).

**Visibility.** The `orche-job` widget (`ctx.ui.setWidget`, plain strings) shows the job running attached (`◉`) or detached (`◌`) with
its elapsed time and latest progress line, then its end (`✓ done`, `✗ failed`, `⊘ cancelled`, `! interrupted`) and where the result
went, until the next user input. The TUI repaints it every second; in RPC it is re-sent only when its text changes (minutes, not
seconds). A detached tool block shows `⇥ detached after 4m 12s · J1 keeps running in the background` instead of `took …`.

**Steer semantics of `orche_task_message`.** Rejected (an error result) when no job runs, the named job is not running, the worker
is not running an assignment, has already reported, or is stopping, or the message is blank. Otherwise the message is sent into the
worker's session as a steering custom message: it is read after the worker's current tool calls and before its next model request.
It grants nothing: no git grant, no write scope, no new role. Guarantee: the job's result lists every message as `delivered` (it was
in a model request) or `undelivered`. When the worker's report is accepted, or the assignment ends, queued messages are withdrawn,
so they never leak into a later assignment. An undelivered message has to be re-sent as a follow-up `orche_task` to the same worker.

**Limits and lifecycle.** One job at a time (a second `orche_task` is refused while one runs). Worker and job ids are never reused
in a session branch, also across reloads. A session shutdown (reload, exit, switch) ends a running job as `interrupted` in its
`orche-job` entry and its `run.json`, without a message. A job found running at the next session start (the process crashed) is
closed then and announced once. `run.json` records left `running` by a process that no longer exists (`owner.pid`) are closed as
`interrupted` at session start. Naming a worker that is gone (idle expiry, eviction, `/orche stop`, reload, crash) starts a new
worker briefed with the gone worker's transcript path, last record and summary; unknown ids are still errors.

**`writeRoots` and scratch.** Every worker gets a private scratch directory `<os.tmpdir()>/pi-orche/<session>/<worker>` (mode
0700, symlinks refused, removed when the worker retires), writable by every role, named in its assignment. `writeRoots` opens
further directories outside the workspace for one implement/game-asset/video assignment (absolute, `~/…`, or relative to the cwd;
ignored with a note for read-only roles). `writeRoots` at the top level of `orche.config.json` applies to every writing assignment.
`/` and the home directory itself are rejected. Paths are checked lexically and by real path, so `..` traversal, symlinks out of a
root and prefix look-alikes (`/repo-other` vs `/repo`) are blocked.

**Worker bash writes.** Worker `bash` commands get the same outside-workspace policy for the write targets visible in the command
text: redirections and heredocs, `tee`, `cp`/`mv`/`install`, `touch`, `mkdir`, `rm`, `ln`, `sed -i`, `dd of=` and similar
(`src/orchestration/bash-writes.ts`). This is **not a sandbox**. Targets built at run time (`$VAR`, globs, command substitutions)
and files programs write by themselves are not seen. The workspace audit still reports changes inside the workspace afterwards.

**Quiet waits.** A worker `bash` call with an explicit `timeout` counts as active for deadline extensions while it runs within
that timeout plus 30 s, even without output. Without a timeout, a silent command looks idle after the 2-minute activity window,
as before. `limits.maxExtensions` still caps every assignment.

**Verification rounds.** An implement/answer orchestrator may start at most `verificationRounds` (default 2) fresh-verifier rounds
(`orche_spawn` with reason `verification`); other spawn reasons are not counted. Main raises the cap only when the user explicitly
asked for more review rounds. A refused round tells the orchestrator to fix clear in-scope defects, run the project checks itself
and report the rest. Its report must then carry `data.unresolved` (an explicit `[]` when nothing remains), or it is rejected. The
result adds `Verification cap: N verification rounds ran (cap N); 1 further round was refused.` and the `unresolved:` line, so
an unconverged review never reads as a clean pass.

**Output-limit recovery.** See [length-recovery.md](length-recovery.md). **Task DAG thinking policy** (`task_plan` node fields `phase: "integrate"`, `hard`, `checkpoint`; `"thinkingPolicy"` in the config): see [thinking-policy.md](thinking-policy.md).

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

## Tool event log (opt-in)

Set `PI_ORCHE_TOOL_EVENTS=/absolute/path/to/events.jsonl` to append metadata-only JSONL from main and worker `tool_result` hooks. The destination is read at each event; its parent directory must already exist. Unset (or empty) means no logging, alignment or additional file I/O. Analysis and one append per event are deferred, never awaited; failures are silently ignored, so this is best-effort telemetry, not a durable audit log. Model-visible results and saved artifacts are unchanged.

Both schemas have `v: 1`, `type`, ISO `ts`, `pid`, `cwd`, `toolName`, `toolCallId` (null if unavailable), optional `sessionId`, and `isError`:

- **`output_reduced`**: `artifact` (workspace-relative notice path, or null on save failure), `mode` (`filtered`/`truncated`, matching the notice), `reducer` (`test`/`tsc`/`lint`/`grep`/`generic`/`pi-tail`), fixed reducer `reason`; `original`, `inline` (preview body), `visible` (including status/notice), each `{chars, lines}`; `omittedLines`, optional known `omittedDiagnostics` (numbered generic previews), `clippedLines` (original lines exceeding the 2,000-char analysis cap); `diagnostics: {original, visible}` counts matching `error|fail|warn|exception|panic|traceback|✗|×` after ANSI stripping, with visible counting only inline text; `shown`, `shownMethod`, `shownTruncated`, `transformed`, and optional status-line `exitCode`.
- **`artifact_access`**: deduplicated workspace-relative `artifacts`, `resultChars`, `resultLines`. Detects `read`/`grep`/`find`/`ls` path arguments, bash command path tokens, and other tools' string input values. Reads are logged even though exempt from spilling: `read: {offset, limit, mode: "range"|"outline"|"symbol", firstLine, lastLine, returnedLines}`; unspecified offset/limit and absent anchors are null, and returnedLines counts anchored `N#tag|` / `N|` rows. Grep adds `matchedLines` (first 2,000 `path:N:` rows, including Pi's basename form) and `matchedLinesTruncated`. Bash adds `bashForm` (`cat`/`head`/`tail`/`sed-range`/`grep`/`awk`/`other`); simple `sed -n 'a,bp'` and `head -n N` add `range: {firstLine, lastLine}`, and `tail -n N` adds `range: {lastLines}`. These are syntactic hints, not shell interpretation.

`shown` contains merged inclusive `[first, last]` ranges of **original 1-based output lines**, capped at 2,000 ranges with `shownTruncated`. Methods: `numbered` extracts exact `[Lnnn]` prefixes; `aligned` greedily matches content in order, allowing ANSI removal and the 2,000-char analysis / subsequent 1,000-char generic clips; `lossless` represents all grouped grep lines; `tail` matches unchanged Pi-tail content backwards to disambiguate repeated lines. Rewritten tsc/lint lines are not claimed to match original lines; `transformed` is true for tsc/lint/grep. Ranges describe represented lines, not proof that every character was shown. When a full file exceeds the 32 MB recovery cap (or only a secondary Pi-tail preview was reduced), `originalUnavailable: true` leaves `shown` empty; counts then describe the available analyzed text, not unknown full-file coordinates. Counts use JavaScript string lengths and split-on-newline lines, including trailing empty lines.

**Privacy:** no tool output, file contents, commands, search patterns, argument payloads, symbol names or error messages enter the log. Only counts, kinds, line numbers, normalized paths within this workspace's `.orche/artifacts` directory, cwd, tool names and ids are written. Paths/ids can still be sensitive; choose and protect the log destination accordingly.


## Base prompt switch

`SessionOptions.baseSystemPrompt` becomes the resource loader's system prompt, replacing Pi's default base prompt. Note Pi's structured prompt builder then omits its own tool/guideline sections entirely (only the custom preamble, the appended role instructions and cwd remain); the model still gets tool schemas and each tool's description through the API, but not the `promptSnippet`/`promptGuidelines` lines.

Run worker instructions are static per role/loadout for prompt-cache reuse. A run-context-tracked first-assignment briefing supplies identity and reply language, plus the user request if the assignment does not already contain it; later assignments do not repeat the briefing. Coordinator, advisor and `orche_task` system instructions are unchanged. Worker summaries start with a one-to-three-sentence conclusion, then `path:line` evidence and command outcomes, without pasted code/diffs/logs the reader can open. Answer summaries remain complete and cite source locations.
