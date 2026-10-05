# pi-orche as a Pi package

`pi install /path/to/pi-orche` adds pi-orche to your normal interactive `pi` sessions. The package manifest (`package.json` → `pi.extensions`) loads `src/extension/index.ts`, which provides four things: tools, delegation modes for the main agent, the `/orche` command and the `orche_task` tool.

**Removed (2026-10-04): the `auto` and `multi` modes, the `orche_run` tool and `/orche multi`.** Benchmarks (bench3, hard6, parallel3, multi-vs-single) showed the multi-agent orchestrator no more accurate than one worker on coupled or parallel tasks, at about twice the cost, so the Pi package now offers only `direct` (default) and `single`. A config or saved session choice of `auto`/`multi` is read as `single` with a one-time warning. The orchestration engine itself (`runOrchestrated`, the CLI, eval arms) remains as a library and is documented in the README.

## 1. Tools in every session

- **`read` and `edit` replace Pi's built-ins** (an extension tool registered under a built-in name wins in Pi's tool registry). `read` prints non-blank lines as `N#abcd|text` (four lowercase hex) and blanks as `N|text`; `edit` accepts these and old 16-hex anchors, maps earlier-read anchors across its own edits when possible, and prints a compact fresh-anchor echo with advisory syntax feedback. JS/TS/Markdown files up to 2 MB support `outline: true` then `symbol`; these options exclude each other and offset/limit. The registry has exactly one of each tool; the delegation mode can deactivate `edit`. See [tools.md](tools.md).
- **Added tools (active subject to the delegation mode below):** `find` (our in-process walk), `ast_search`, `ast_rewrite`, `diagnostics`. Pi's own `grep` and `ls` are switched on as well (`grep` needs `rg`, as in Pi). `bash` and `write` stay Pi's.
- **Recoverable output reduction:** bash test/compiler/linter results at least 2,000 characters or 60 lines are filtered when savings reach 20%, preserving failures/diagnostics and summaries; Pi grep groups repeated paths when savings reach 15%. Generic spill still triggers over 12,000 characters or 300 lines: bash/grep previews retain numbered head + diagnostic middle + tail; other tools get generic head/tail only. `read` stays exempt. Every reduction saves the full original to `<cwd>/.orche/artifacts/<tool>-<id>.txt` (with `.gitignore`/`.ignore`) and ends with a recovery notice. Bash exit/abort/timeout status and `isError` are preserved. Exact preview budgets and filters: [tools.md](tools.md).
- If you start Pi with `--tools` / `defaultTools` that leave out any of our tools, that selection is respected and grep/find/ls are not added.
- The tools are bound to the working directory of each call, so a global install works in any project.

## 2. `/orche` commands

The command grammar is strict. `single` and `direct` need a non-empty prompt; `mode` takes no argument or one of `single|direct`; `workers` and `cancel` take nothing after them; `stop` needs one worker id or `all`. Anything else (a bare `/orche <PROMPT>`, `/orche`, `/orche single`, `/orche stop`, `/orche mode turbo`, `/orche cancel now`) shows this usage and starts nothing:

```text
Usage: /orche single|multi|direct <PROMPT> | /orche mode [auto|single|multi|direct] | /orche workers | /orche stop <id>|all | /orche cancel
```

- **`/orche single <PROMPT>`**: hands the prompt to the **current Pi session as a normal user turn** (`pi.sendUserMessage`), with its model, thinking level and conversation, under a **one-turn override to `single`**: direct write tools off, `orche_task` on. The main chooses the worker role and supervises the result; this is not a direct-edit turn. After the turn settles the session mode's tool set returns. While busy, the prompt is queued as a follow-up only in session mode `single`; it keeps the session mode, not a one-turn override. In `multi` or `direct` it is refused: `orche single: refused. The agent is busy and this session is in mode <session mode>, where a queued turn could not delegate to one worker. Wait for the current turn, or switch with /orche mode single.`
- **`/orche direct <PROMPT>`**: the former `/orche single` behaviour. It starts the current session's turn with a **one-turn override to `direct`** (direct edits allowed, both delegation tools off); no orchestrator or worker is started by the command. The session mode's tool set returns when the turn settles, is aborted or fails. While busy it queues a follow-up only when the session mode is already `direct`; otherwise it is refused: `orche direct: refused. The agent is busy and this session is in mode <session mode>, where a queued turn could not edit files. Wait for the current turn, or switch with /orche mode direct.` Compatible busy commands notify `orche single: the agent is busy; the prompt is queued as a follow-up turn.` or `orche direct: the agent is busy; the prompt is queued as a follow-up turn.` They never apply an override to someone else's turn or run the queued prompt concurrently.
- **`/orche mode [auto|single|multi|direct]`**: without an argument prints the current session mode and where it comes from (`config <path>`, `set with /orche mode in this session`, or `default`). With one it switches the session's mode at once (tool set, status line) and records the choice with `pi.appendEntry`, so it survives `/reload` and resuming the session.
- **`/orche workers`**: shows one line per live worker, for example `W1 idle · implement · 2 assignments · last: … · idle 3m`, or `no workers`. The line contains status, latest role, completed assignment count, the first 80 characters of the last summary (or `no result yet`) and whole idle minutes.
- **`/orche stop W1` / `/orche stop all`**: stops and disposes the named worker or all live workers, with `Disposed workers: W1` (or a comma-separated list). An unknown id reports `unknown worker <id>`; an empty pool with `all` reports `no workers`. `/orche stop` without an id prints the usage.
- **`/orche cancel`**: cancels the active `orche_task` assignment. The tool call ends with the error `cancelled by user`; the worker returns to idle and stays reusable rather than being disposed. The notice is `orche task cancelled` after cancellation completes, or `no active orche task` when nothing is active. To abort the main session's ordinary turn, including a one-turn override, use Pi's own Esc; an active delegation tool receives its abort signal.

## 3. Delegation mode (`mainMode`)

The mode set is `single` and `direct`; the default is **`direct`**. Switch with `/orche mode single` when a task will fill the main window (see the context warning below).

| Mode | Main session tools | Rules injected into the system prompt |
| --- | --- | --- |
| `single` | `edit`, `write`, `ast_rewrite` **deactivated**; Bash allowlist; PowerShell unsupported; `orche_task` on | Intent/requirements hand-off with original user text; worker-owned sequential Task DAG; main checklist review and same-worker follow-ups, new worker only for repeated unmet items |
| `direct` (default) | `orche_task` **deactivated and guarded**; everything else on, subject to the user's tool selection | Make changes directly with the main's own tools, including user-requested paths outside the cwd/workspace |

**Context warning (direct).** In `direct` the whole task lives in the main window, so after every turn orche checks the main session's context usage. When it first crosses 50% and again at 75% of the window it notifies the user (not the model): `orche: main context is at 52% of the window (…k/…k tokens). For remaining large work, switch with /orche mode single so a worker carries the context and this session keeps only results, or run /compact.` Each threshold warns once; the warnings re-arm after usage falls 10 points below the lowest threshold (compaction, new session). Other modes are silent. Configure it in the trusted project or user config with `"contextWarning": { "enabled": true, "thresholds": [50, 75] }` (1–5 strictly ascending percentages between 0 and 100); it is read at session start.

**Direct edits outside the workspace:** both `/orche direct <PROMPT>` (one turn) and `/orche mode direct` (persistent session choice) explicitly allow the main session to edit user-requested external paths, including absolute paths such as `/path/to/other/file` and relative paths such as `../other/file`. Delegated workers' workspace confinement is not a restriction on the main direct session. This is instruction-level permission, not OS privilege escalation: existing OS permissions, sandbox boundaries, other policies and the user's tool selection still apply. It does not authorize unrelated external changes or bypass another extension's protection. `auto`/`single`/`multi` still require delegation for changes, and delegated workers' workspace and ownership limits remain unchanged (§5).

**Breaking change:** `single` changed meaning. The old direct-edit `single` mode is now `direct`; an existing config with `"mainMode": "single"` now selects the **single-worker delegation mode**. Use `"mainMode": "direct"` for the old behaviour, and `/orche direct <PROMPT>` for the old one-turn command.

The **single workflow** applies to `single`. Main analyses the user's intent, purpose and requirements, inspecting only enough to state the task precisely. The `request` format is **Intent/Purpose; numbered testable requirements as lines `R1: …` with acceptance criteria; Constraints and non-goals; Assumptions (explicit when there is no UI); a final Original request section containing the user's original text verbatim**. References/findings go in `context`. Ask only about decisions main cannot reasonably make. Hand off one end-to-end assignment per round: `implement` for changes, `answer` for read-only questions; do not split into explore/implement/verify phases or end a turn without attempting a change because of size/risk. The standard-role worker creates its Task DAG, executes it sequentially, implements/tests/checks and reports without main intervention while it runs (§5).

Main reviews the result, its evidence and checklist and runs trusted project checks. Restate additional/corrected requirements in the same format with new or revised R-ids and pass the **same `worker` id**. If an R-id is unmet/partial for **two consecutive assignments of that worker**, hand **only the unmet items** to a **new worker** (omit `worker`), including relevant file references and previous evidence, not the whole task. Streaks are **per worker** and reset when an item is **met, omitted, renamed or textually revised**, or an **assignment fails** (including pre-dispatch failure). Text revisions include indented acceptance details following the requirement line; non-single-workflow assignments also break the streak. Independent `verify` assignments are only on explicit user request, in both workflows. Label unverified items as unverified.

Single never stops to ask for a mode switch or declines a change just because it is large/risky. Task notes keep follow-ups with the same worker. The `orche-delegation` prompt section is byte-stable per mode, without a changing roster/session state.

Delegation rules say **pass references, not copies**: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs. Worker summaries start with a 1–3 sentence conclusion, then `path:line` references and command outcomes; answer-kind summaries stay complete but cite source locations instead of long quotes.

In `single` the main keeps the conversation, inspection (`read`, `grep`, `find`, `ls`, `ast_search`, `diagnostics`, static Bash), trusted project checks that may create generated files, and composing the delegation request. Set `"mainMode"` to `"single"` or `"direct"` in the orche config (the same selected file as the routes: trusted project file, else user file; the standalone CLI ignores the key). An invalid value is reported at session start and the default `direct` applies unless a saved session choice overrides it; the removed values `auto`/`multi` are read as `single` with a warning. Effective-mode precedence is one-turn override, saved `/orche mode` choice, config, then `direct`. The status line shows `orche: <session mode>` with ` (one-turn single)` or ` (one-turn direct)` during an override.

**Enforcement in `single`, and what it is not.** Two layers: the tool set removes `edit`, `write`, `ast_rewrite` and any mode-disabled delegation tool from the active set, and a `tool_call` guard blocks them if something re-activates them. `direct` instead removes and guards `orche_task`. Only tools the mode itself removed are restored on a mode change, so a `--tools` selection stays yours. Guard messages start `Blocked by orche mode "<mode>":`; explicit mutations tell the main to delegate, not retry directly; unsupported commands are reported as unverified, not falsely declared mutating. Use `read` with offset/limit, `grep`, simple static commands or an available delegation tool for alternatives. PowerShell is unsupported in `single` until a dedicated parser exists; it is never parsed as Bash. Bash commands in those modes go through the unchanged **deny-by-default allowlist** (`src/extension/bash-policy.ts`): allowed are inspection commands (`ls`, `cat`, `grep`, `git status/diff/log/show...`, `find` without actions, `jq`, ...) and trusted test/lint/typecheck runners (`npm test`, `npm run test|lint|typecheck|check[:...]`, `node --test`, `vitest`, `tsc --noEmit`, `pytest`, `cargo test`, `go test`, ...), chained with `&&`, `;` or pipes. `npx`/`bunx` require explicit `--no-install` and a supported runner (for example `npx --no-install vitest run`); this does not guarantee containment or executable provenance. Everything else is blocked, as are output redirections (except static `/dev/null`/`2>&1`), active variables, brace/tilde expansions, bare globs, command/process substitutions, heredocs, subshells, background jobs, unknown syntax, and environment-variable prefixes other than `CI`, `NODE_ENV`, `TZ`, `NO_COLOR`, `FORCE_COLOR`. Quote literal patterns, for example `find . -name '*.ts'`; quoting a variable does not make its expansion supported. General `sed`/`awk` are unsupported. **This is a guard against habitual direct edits, not a sandbox.** Allowed checks execute project code/configuration and may create generated files, caches or reports; the allowlist is syntactic and cannot know what a script, alias or configuration does; and tools registered by other extensions are not restricted. Policy classification does not guarantee successful CLI execution. Do not rely on it as a security boundary.

### Shell allowlist: installed-CLI verification

Verified locally with TypeScript 5.9.3, Node 24.14.0, npm 11.16.0, Vitest 3.2.7, Git 2.43.0 and ripgrep 14.1.0, plus installed Bun, Ruff, Cargo and GNU coreutils. Probes used only temporary fixtures under `os.tmpdir()`; npm was forced offline with a temporary cache (no downloads). **Policy allows** and **CLI accepts** are different: an allowed command can fail because its fixture, repository history or optional dependency is absent. Trusted checks may write generated reports/caches; that is not permission for explicit source/config updates or arbitrary execution hooks.

`tsc --noEmit` and `tsc --noEmit true` are accepted and do not emit JavaScript. `--noEmit=true` is **not** a TypeScript CLI spelling (TS5023), so the policy now rejects it as unsupported. `--noEmit false` is a boolean flag plus its value, not a filename: it actually emits, as does a repeated `--noEmit --noEmit false`; both stay blocked. `-b` emits and writes build information; `--init --noEmit` still creates a config, so both stay blocked.

Node executes a data-URL `--import` even with `--test`; the current policy already blocks it (not an open bypass). Separate `-r ./x.cjs` executes a preload; this Node rejects attached `-r./x.cjs`, but both remain blocked. Bun **does support** `bunx --no-install`: local Vitest runs and a missing binary fails without installation. `npx --package=` is not an empty harmless option: npm tries to resolve `undefined`; it stays blocked.

Vitest `-u`/`--update` update snapshots. `--outputFile=report.json` with a JSON reporter writes that report; coverage help specifies `./coverage` by default, configurable via `--coverage.reportsDirectory`. Coverage execution here could not complete because `@vitest/coverage-v8` is absent (not installed for the probe). Arbitrary output paths are not automatically audit artifacts: the unchanged artifact policy still applies. Coverage help also documents `--coverage.thresholds.autoUpdate` as a **configuration update**, now blocked. A temporary `--coverage.customProviderModule` was imported/executed even though its incomplete provider subsequently failed; that injection is now blocked, including forwarded npm project-check arguments.

Git `grep -Ocat` executes a pager, while `diff -Oorderfile` reads an ordering file. `git log --output=` creates its output even when the log fails on an unborn branch. ripgrep executes both `--pre` and `--hostname-bin`; `--pre-glob` alone is only a filter. GNU sort help documents `--compress-program` execution for temporary-file compression/decompression. GNU date help documents **both** `-s` and a numeric `MMDDhhmm[[CC]YY][.ss]` operand as clock setters; numeric setter operands are now blocked, even after `--`. Clock-setting commands were never executed. Cargo's accepted read-only `--version`/`-V` spellings are now allowed (`-v` is verbosity, not version).

The table separates real exit codes from policy verdicts. `A` = allowed; `B-M` = blocked mutation; `B-U` = blocked unsupported. Verdict arrows show corrections; `FP` = accepted by policy but rejected by CLI, `FN` = allowed explicit write/execution. `help-only` means the dangerous spelling was **not run**; the exit code belongs to `--help`.

| Probe command (temporary fixtures) | Exit | Observed behaviour | Policy / conclusion |
| --- | --- | --- | --- |
| `tsc --noEmit` | 0 | no JS | A / OK |
| `tsc --noEmit=true` | 1 | TS5023 unknown option | A → B-U / FP fixed |
| `tsc --noEmit true` | 0 | no JS | A / OK |
| `tsc --noEmit false` | 0 | creates JS | B-M / OK |
| `tsc --noEmit --noEmit false` | 0 | creates JS | B-M / OK |
| `tsc -b` | 0 | JS + `.tsbuildinfo` | B-M / OK |
| `tsc --init --noEmit` | 0 | existing config: TS5054; empty fixture: creates config | B-M / OK |
| `node --test x.test.cjs` | 0 | tiny test passes | A / OK |
| `node --test --import='data:text/javascript,…' x.test.cjs` | 0 | import marker printed | B-U / OK, already blocked |
| `node --test -r ./x.cjs x.test.cjs` | 0 | preload marker printed | B-U / OK |
| `node --test -r./x.cjs x.test.cjs` | 9 | bad option | B-U / OK, conservative block |
| `node -v` | 0 | v24.14.0 | A / OK |
| `tsc --version` | 0 | 5.9.3 | A / OK |
| `git --version` | 0 | 2.43.0 | A / OK |
| `rg --version` | 0 | 14.1.0 | A / OK |
| `npm --version` | 0 | 11.16.0 | A / OK |
| `npm test -- --flag` | 0 | script receives `--flag` | A / OK |
| `npx --no-install vitest --version` | 0 | local version | A / OK |
| `npx --no-install missing-tool-xyz` | 1 | ENOTCACHED, offline, no install | B-U / OK |
| `npx --no-install --package= vitest --version` | 1 | offline resolution of `undefined` fails | B-U / OK |
| `bunx --no-install vitest --version` | 0 | local version | A / OK |
| `bunx --no-install missing-tool-xyz` | 1 | explicitly stops because no-install | B-U / OK |
| `vitest run --version` | 0 | version | A / OK |
| `vitest run --help` | 0 | confirms `-u`/`--update`, `--outputFile` | A; update B-M / OK |
| `vitest run --help --coverage` | 0 | coverage dir + config auto-update documented | A; auto-update A → B-M / FN fixed (help-only) |
| `vitest run x.test.js --maxWorkers=1 --reporter=json --outputFile=report.json` | 0 | writes report | A / OK, generated artifact |
| `vitest run x.test.js --maxWorkers=1 --coverage` | 1 | coverage-v8 dependency absent | A / unverified coverage execution; location verified via help |
| `vitest run x.test.js --maxWorkers=1 --coverage --coverage.provider=custom --coverage.customProviderModule=./provider.mjs` | 1 | marker printed, then missing `getProvider` | A → B-U / FN fixed |
| `vitest run x.test.js --maxWorkers=1 --no-cache --reporter=json --outputFile=report.json` | 0 | isolated no-cache repeat writes temp report | A / OK |
| `vitest run x.test.js --maxWorkers=1 --no-cache --coverage` | 1 | same absent coverage-v8 dependency | A / unverified execution |
| `vitest run x.test.js --maxWorkers=1 --no-cache --coverage --coverage.provider=custom --coverage.customProviderModule=./provider.mjs` | 1 | import marker, then incomplete provider error | B-U / FN fix reconfirmed |
| `git init --quiet` (fixture setup only) | 0 | initializes empty temp repository; no commits/staging | B-M / OK, setup intentionally outside allowlist |
| `git grep --no-index -Ocat pattern x.txt` | 0 | pager prints fixture | B-U / OK |
| `git grep --no-index -O./pager.sh pattern x.txt` | 0 | pager execution marker | B-U / OK |
| `git diff -Oorderfile` | 0 | order file accepted | A / OK |
| `git log --output=log.txt` | 128 | no commits, **still writes** log file | B-M / OK |
| `git reflog` | 128 | no commits, syntax accepted | A / OK, fixture/history failure |
| `git fsck` | 0 | unborn HEAD notices | A / OK |
| `git bundle verify missing.bundle` | 1 | missing bundle | A / OK, fixture failure |
| `git config --get core.bare` | 0 | `false` | A / OK |
| `git branch --list 'x*'` | 0 | empty list | A / OK |
| `rg --pre=./pre.sh pattern x.txt` | 0 | execution marker file | B-U / OK |
| `rg --hostname-bin=./host.sh pattern x.txt` | 0 | execution marker file | B-U / OK |
| `rg --pre-glob='*.txt' pattern x.txt` | 0 | ordinary search, no execution hook | A / OK |
| `rg --help` | 0 | execution/filter semantics documented | A / OK |
| `ruff format --check x.py` | 1 | would reformat; source unchanged | A / OK, check failure |
| `ruff format --diff x.py` | 1 | prints diff; source unchanged | A / OK, check failure |
| `ruff check --fix x.py` | 0 | removes unused import | B-M / OK |
| `ruff clean` | 0 | removes temporary cache | B-M / OK |
| `cargo --version` | 0 | version | B-U → A / wrong block fixed |
| `cargo --help` | 0 | confirms `-V` version spelling | B-U / supported version rule verified |
| `cargo init --offline --vcs none --name tiny` (fixture setup only) | 0 | creates temp crate, no network | B-U / OK, setup outside allowlist |
| `cargo fmt --check` | 0 | temporary crate already formatted | A / OK |
| `sort --compress-program=…` (help-only) | help: 0 | executes PROG / PROG -d | B-M / OK |
| `file -C` (help-only attempted) | ENOENT | `file` also absent | B-M / unverified (tool absent) |
| `date -s …` (help-only) | help: 0 | clock setter documented | B-M / OK |
| `date 010100002020` (help-only) | help: 0 | numeric clock setter documented | A → B-M / FN fixed |
| `python3 -m pytest --version` | 1 | no module named pytest | A / unverified (tool absent) |

**Unverified (tool absent):** pnpm, yarn, eslint, prettier (including `--check --write`), jest, mocha, pytest (also unavailable via `python3 -m pytest`), go, fd, tree, `python`, and `file`. Their existing classifier specimens are policy expectations, **not** evidence that these CLIs accept the spellings; no absent-tool rules were changed. The cheap `test/extension/bash-policy-cli.test.ts` regression reruns only tsc/node/git/rg, skips absent binaries, and uses temporary directories with no network.

The final Vitest report/provider probes used `--no-cache` and a physical temporary `node_modules` directory (only the Vitest package was linked for reading). This replaced an initial whole-dependency-directory link that could route Vitest's default cache into ignored repository dependencies; existing repository caches were not reverted or removed.

## 4. `orche_run` tool (removed)

The `orche_run` tool and `/orche multi` were removed from the Pi package; see the note at the top. Use `orche_task` (mode `single`) for delegation, or the CLI/`runOrchestrated` for the multi-agent engine.

## 5. `orche_task` and the worker pool

`orche_task` delegates one self-contained assignment to one persistent worker, without a classifier call or coordinator. It covers bounded units, investigations, questions, verification passes, game assets, video production and follow-ups while the main retains the conversation and supervises the evidence. The main chooses the role; no automatic independent verification is added to a writing assignment.

### Parameters and assignment contract

- **`role`** (required): `explore | answer | implement | verify | game-asset | video`. `explore` investigates and reports evidence (optionally `cause`); `answer` produces an evidence-backed answer; `implement` changes files and runs local checks, reporting `status: done|blocked`; `verify` independently reviews and runs `verifyCommands`, or discovers the project's checks, reporting `passed` and evidence/issues. `game-asset` creates/modifies game art, audio, models and engine import/metadata files, detecting engine conventions and validating assets and previews with local tooling; third-party asset downloads require permission and source/license records. `video` plans, produces/edits and encodes video, including subtitles, audio and thumbnails, with draft renders, explicit encode settings, ffprobe checks and frame inspection. Both specialists report required `data.status: "done" | "blocked"` and `outputs: [{path,type,spec}]` (each field a non-empty descriptive string), plus optional `reason` and `evidence`; blocked reports may have an empty outputs list. Both leave no unrequested temporary/intermediate files in the workspace.
- **`request`** (required, non-empty): workers do not see the conversation. For the single workflow use **Intent/Purpose / numbered testable requirements R1..Rn / Constraints and non-goals / Assumptions / Original request (verbatim final section)**. Pass references, not copies: paths with line ranges/symbols, reproduction commands, artifact/run-record paths; only short decisive irreproducible snippets inline, never whole files, diffs or long logs. The original user request is deliberately kept verbatim, rather than only paraphrased.
- **`context?`**: supporting findings, decisions and references (same no-copy rule), at most 30,000 characters; non-blank context is appended under `## Context from the requesting session`.
- **`worker?`**: reuse a live id such as `W1`, retaining the session's history. Standard roles in the single workflow switch to main's current model/thinking before each assignment; other roles keep their routes (see below). Omit it to start a new worker. Unknown or retired ids are errors, not fabricated reuse: `Unknown worker <id>; live workers: <list>. Omit worker to start a new one.` The list contains live ids, statuses and roles, or `none`. A running worker errors with `Worker <id> is running; wait for its assignment to finish.` (the shared activity guard can refuse earlier).
- **`files?`**: write scope for `implement`, `game-asset` and `video`, using concrete workspace-relative files or recursive directory areas `dir/`, `dir/**`, `dir/**/*` (canonicalized to `dir/`). Other globs, absolute areas and outside-workspace areas are rejected. Omission permits writes anywhere **inside the workspace**; an explicit empty list grants no write scope. For read-only roles the field is ignored with `Note: files ignored for read-only role.`

In the single workflow (`single` and auto's `orche_task` path), `implement` first analyses requirements and creates the Task DAG with `task_plan`, covering every requirement id. It executes nodes sequentially in dependency order, updates statuses, implements completely, adds/updates tests, runs project checks and iterates until they pass, preserving unrelated changes within scope. Main does not intervene while it runs. Both `implement` and `answer` finish with `report_result` and an evidence-backed requirement checklist when the request contains R-ids.

**Worker-only `task_plan`:** input `{ nodes: [{ id, title, dependsOn: string[], covers: string[], status, note? }] }`, where `covers` contains R-ids and `status` is `pending|running|done|blocked|skipped`. Each call replaces the whole plan. Plans contain **1–60 nodes**, with title **≤200 characters**, note **≤500**, ids **≤100**, dependency/coverage arrays **≤60 unique entries**, and at most **one running node**. Unexpected fields and payloads above **64 KiB serialized UTF-8** are rejected to bound plan events, result details and compaction re-injection. Duplicate ids, unknown dependencies, cycles, invalid statuses and `done` nodes with unfinished dependencies are rejected with repair instructions; skipped dependencies count as finished. If the assignment declares R-ids, unknown `covers` ids are rejected and uncovered request ids produce a warning. The response renders nodes in topological order and identifies the next ready pending node. The pool **resets the plan at every assignment boundary**, records accepted replacements as `task_plan` events and returns `details.plan` only for this round's plan. A report without any successful plan call is accepted with **Note: no Task DAG recorded in this assignment.**, without `details.plan` or a fabricated plan event. Only standard single-workflow task roles **explore/answer/implement/verify** get this tool; library run workers and **game-asset/video specialists** do not. Handed-over run workers gain it at their first standard single-workflow task; role/mode changes disable it outside that workflow.

**Checklist:** optional RESULT `data.checklist: [{id:"R1", status:"met"|"unmet"|"partial", evidence:string}]`. It is required for single-workflow task `implement`/`answer` only when the request has requirement declarations: lines starting with **`R<n>` followed by `:`, `.`, `)` or ` -`**, outside the original-request section. Case-insensitive headers `Original request`, `Original user request`, `Original request (verbatim):`, with or without Markdown `#`/bold, end the declarations. Prose `R1`, paths such as `docs/R1.md` and `R2D2` never require a checklist. Required checklists have one unique item per required id and non-empty evidence; malformed/missing coverage is rejected inside `report_result` with the actual implement/answer schema hint so the worker can repair it in the same assignment. Both schemas accept absent data/checklists for legacy requests. The tool returns `Checklist: K/N met; unmet: R4 (partial: reason)` and `details.checklist`. An unmet/partial streak of two adds the explicit new-worker note (§3); it is guidance for main, not an automatic new assignment.

Workers have ids `W1`, `W2`, …, increasing monotonically within the Pi session's in-memory pool and never reused. Each is spawned with the full worker tool set, but **no peer messaging** (`send_message` is absent). The per-assignment write-tool guard makes `explore`, `answer` and `verify` read-only and allows `implement`, `game-asset` and `video` only within their `files`, or within the workspace when omitted. Outside-workspace targets and mutating `ast_rewrite` calls without an explicit path remain blocked; `ast_rewrite` with `dryRun: true` does not write and bypasses that guard. The guard checks `edit`, `write`, `ast_rewrite`, not arbitrary Bash behaviour; role instructions and the audit are not a shell sandbox.
Both lexical and real paths must remain inside the real workspace root and the original declared scope (including the requested-path scope when `files` is omitted); new files resolve via the nearest existing ancestor, and dangling links, loops or other resolution errors are blocked. Directory `ast_rewrite` checks only its target, not its tree; symlink-reachable files receive the per-file guard when edited individually, and workspace auditing remains a post-hoc backstop, but Git stores links without following them, so writes through links may change targets outside the snapshot.

### Pool lifetime and reuse

At most **3 live workers** are retained. A fourth new-worker request retires the least-recently-used idle worker and names it in the result: `W2 retired: least-recently-used idle worker (pool cap 3).` A running worker is never an eviction candidate; if none is idle the request fails. Idle workers expire after **30 minutes** (the timer is unref'd). Standard single-workflow task workers **do not retire at 70% context**: they compact instead (below). Other workers, including specialists, retain retirement after a latest request using at least 70% of the effective window (`input + cacheRead`), with `W1 retired: context nearly full; start a new worker with the contract and evidence`.

The pool is in-memory only: workers and retained context are gone after `/reload` or session resume, and `session_shutdown` disposes the pool. `/orche stop` explicitly stops and disposes workers; `/orche cancel` only cancels the current assignment and leaves its worker idle and reusable. Idle pool workers persist alongside and after multi runs; they are not the multi orchestrator's own workers.

In a git work tree each assignment takes before/after workspace snapshots through a **private index**, leaving the user's index, HEAD and stash untouched. The diff covers tracked and non-ignored untracked files (excluding `.orche` artifacts), and the result lists `Changed files: …` or `No files changed`. Outside git the result says `Workspace audit unavailable (not a git work tree)`. Unlike a multi run, a task does not create a baseline recovery ref. On reuse, the new assignment prompt starts with `## Stale context: workspace changes since your previous assignment`, listing files changed since that worker's previous assignment as `path (status)` and asking it to re-read changed evidence; with no changes it says `No files changed.`, or reports the audit unavailable outside git.

**Bounded earlier tool output.** Starting with the second assignment, the exact append position of its first user prompt (including the stale-context prefix) separates earlier history from current work. Earlier tool results with more than 600 text characters or any images are candidates, except `report_result`. When newly clearable output reaches `minClearTokens` (text characters / 4 plus 1,000 per image), all earlier candidates become deterministic placeholders. Tool calls/arguments, pairing, error flags, text and prompts remain; the first `.orche/artifacts/` path remains recoverable. Repeat the call to restore needed output in the current assignment. At a boundary with new clears, earlier assistant thinking/reasoning strictly after the earliest newly cleared result is omitted, including signatures; reasoning before it and all current work remain. For those assistant messages, Responses tool-call item IDs are dropped from both calls and matching results, preserving call IDs and pairing. Removed reasoning and ID rewrites are cumulative. A boundary with no new clears changes nothing.

Configure the extension-level setting in the trusted project or user `orche.config.json`:

```json
"taskContext": { "clearBetweenAssignments": true, "minClearTokens": 10000 }
```

Defaults are enabled and 10,000; the flag must be boolean and the threshold a nonnegative integer. Unknown fields/invalid values fail before dispatch; validation is shared with the library run path. The selected file wins as a whole (trusted project, else user, else defaults), and is read at every task call. `clearBetweenAssignments: false` means **no new clears**: an existing projection stays applied unchanged until compaction, while a never-cleared worker stays unprojected. Re-enabling permits new clears at later boundaries. The plan is cached per assignment and applied through Pi's non-persisted `context` event, not `context_edit`: earlier history is stable while raw records keep original results. This projects only persistent task workers, not multi-run actors or main.

**50% compaction:** only standard single-workflow task roles **explore/answer/implement/verify** enable Pi auto-compaction with `reserveTokens = floor(resolvedContextWindow × 0.5)`; Pi triggers when context exceeds `contextWindow − reserveTokens`. `keepRecentTokens` stays at Pi's default unless the threshold is smaller. After successful manual/automatic compaction, a synchronous persisted `orche:task-essentials` message restores requirements, original request and this assignment's bounded DAG **verbatim before the next model call**, independently of summary quality. It is labelled **Assignment in progress at compaction time (superseded by any later Assignment message)**. The full hand-off and context are preserved; reused-worker Assignment prompts explicitly supersede earlier requirements and plans. Old plans can appear only as historical evidence, not in the next round's details or plan events. Projection indices reset on compaction; **no projection applies again until the next assignment boundary**, which plans afresh on the post-compaction transcript. `details.compactions` has `{count, events:[{tokensBefore,tokensAfter}]}` for the assignment; tokens after are estimates including restored essentials, and records include each `compaction` event and final counts. Reused workers update the threshold after a model switch. Library run workers and **game-asset/video** keep automatic compaction disabled; switching an existing task worker to a specialist disables the workflow tools and auto-compaction, and switching back enables them again.

**Task ledger (opt-in).** With `"single": { "ledger": true }` in the trusted project or user `orche.config.json` (default `false`; read at every task call), each single-workflow task (standard roles) gets a ledger `T1`, `T2`, … kept outside every LLM context (`src/single/ledger.ts`): the original-request sections of its hand-offs (verbatim, deduplicated), each assignment's requirement declarations with the status/evidence/`verifiedBy` the worker last reported (ids restart per assignment, so the identity is assignment + id; a requirement restated unchanged carries its last status), the readings chosen in `data.ambiguities`, and a history of results and failures. **Task boundaries are explicit:** every result names its task (`Task ledger T1, assignment 2: pass task "T1" …`, `details.task`); `orche_task` with `task: "T1"` continues that task, also with another worker or a new one (omit `worker`); without `task` the assignment starts a new task, even on a reused worker. An unknown `task` is an error before any worker runs; with the ledger off, `task` is ignored with a note. **Persistence is an event log:** one `orche-ledger` custom session entry per change (`create`, `handoff` with the new original request and requirement declarations, `result` with statuses/readings/history, `failure`), never a copy of the whole ledger; the model never sees them, they follow forks, and session start replays them (entries written as whole-ledger snapshots are still read). The worker's `orche:task-essentials` message after compaction adds its task's rendered ledger (at most 8,000 characters: oldest history, then earlier requirements, then earlier original requests, then oldest readings are dropped first) next to the verbatim assignment. After the main session compacts in single mode, an `orche-ledger-summary` message (one line per task, newest five) puts the tasks' state back. When a task changes hands (its worker is gone after a reload, idle expiry or pool eviction, or main hands it to a new worker), the new worker's first prompt starts with `## Continuing task T…` and the ledger as it stood before this assignment, and the result notes it (`details.continuedFrom`). A gone worker id is accepted only together with a `task` it worked on; otherwise it stays an unknown-worker error, whose message names the worker's last task. Restored ledgers never hand their old worker ids to new workers. Bounds: 10 original requests (the first and the newest), 60 requirements, 30 readings, 50 history items.

When anything is cleared at assignment start the result adds `Context: cleared K earlier tool results (~T tokens est.) and N thinking blocks at assignment start; repeat a call to restore its output.`, with `{results, estTokens, thinkingBlocks}` in `details.contextCleared` and a `context_cleared` task-record event. Nothing is reported when nothing was cleared.

### Routing, limits and result

Discovery, limits and provider registration use the same config and file-backed runtime as the library run path. In the single workflow, task roles **explore/answer/implement/verify inherit main's current `ctx.model` and `pi.getThinkingLevel()` at call time**, even when configured routes differ. Orche resolves that model in its **own runtime**, carrying the main's effective extended context window. If it cannot resolve main, normal routing applies with a visible warning and `details.warnings`; without any usable configured route, the usual `NoRouteError` still names `.pi/orche.config.json` and `providerExtensions`. New workers spawn with that model/effort; reused workers call `AgentSession.setModel`/`setThinkingLevel` before dispatch when needed, retaining history. Pi handles cross-model reasoning/item ids. A switch failure errors and suggests omitting `worker` to start anew. Effective model and thinking are recorded per assignment (`details.model`, `details.thinking`, manifest/outcome).

When **`ctx.model` is absent**, a warning is included in text/details/records. A reused worker with a model **keeps its current model, thinking and context window**, regardless of current routes or the supplied thinking level; it never silently switches back to a route. A new worker uses configured routing with a warning.

SDK tasks without an effective single mode, and **game-asset/video specialists** retain configured routing. Standard route-role names are `answer` → `analyst`, `explore` → first `workers.explorerRoles` (default `explorer-path`), `implement` → `implementer`, `verify` → `verifier`. Explicit specialist routes win; otherwise game-asset/video prefer `<defaultProvider>/claude-opus-5-5` if resolvable, retaining default thinking/extendedContext, else the normal default/no-route error. Specialists are not switched to main. Limits still supply `assignmentMs` and `assignmentRequests` (default 150; 0 disables budget), without coordinator phases or a multi-run overall deadline. Provider hosts are cached by package list until pool disposal.

Progress appears through tool updates and the `orche` status. Successful assignment text has this header (seconds rounded to the nearest integer):

```text
orche task W1 (<role>, <s>s, <n> requests; <config source>)
```

It then contains the summary, supplied role data (`status`, `reason`, `passed`, `issues`, `cause`, number of `outputs`), short checklist summary, workspace audit, `Workers: <roster>` and retirement/other notes. The roster is `W1 idle (implement: <summary>)`, comma-separated, or `no workers`. Details include worker/role/status, duration/requests, effective model/thinking, changes, roster and optional checklist/plan/compactions/warnings/retired ids. Assignment failures, timeouts and cancellation are error tool results with structured details.

In the single workflow, a same-worker follow-up note appears for `status: blocked` (**using the reported reason** when present) or failed `verify`: `Note: follow up with the same worker — <reason>`. There is **no four-or-more-files size note** in either single or auto. The separate repeated-unmet note after two consecutive assignments directs main to hand **only unmet items** to a new worker. SDK tasks without a mode retain their earlier advisory notes. Notes are advice, not automatic orchestration or acceptance.

## Concurrency

One orche **activity** per Pi session: `orche_task` and library runs started through the controller share a slot and refuse to start while another is active. `OrcheBusyError` reads `An orche <kind> is already active in this session; wait for it to finish or cancel it (/orche cancel).`, where `<kind>` is the active `task` or `run`. `/orche cancel` frees the slot after cancellation; idle pool workers remain available alongside and after multi runs. The one-turn `/orche single` and `/orche direct` commands start ordinary main-session turns, subject to their busy rules above; delegation tools used during those turns still obey the activity slot.

Orche worker transcripts are in-memory and are not persisted in the main Pi session history; posted `orche-result` messages, tool results and mode/tool-selection entries are stored there. No global model/thinking settings are written. Workers use the session cwd; multi uses the CLI's ownership/audit rules, and tasks use the assignment scope and audit above. A multi run in git additionally keeps pre-run contents at `refs/pi-orche/baseline` and a failed run prints `git restore`/`rm` recovery commands. Ignored files are not covered, so a clean working tree is still the safest start.

For **multi runs only**, new unowned source/config files (including `.txt`, `.env*`, `.npmrc`) are workspace ownership violations with `created: true`, also in read-only phases. New source files inside backlog-owned areas are allowed during implementation. New generated artifacts instead produce `workspace_unowned_file` warnings and stay listed for cleanup; modifying/deleting existing files outside ownership still violates, even for artifacts. Own required source paths in the backlog, or add generated output to `"audit": {"artifacts": ["notes.md", "reports/", "generated/**", "*.trace"]}` in `orche.config.json`. Extras accept cwd-relative concrete paths, `dir/`, `dir/**` and simple `*.ext` basename globs at any depth; unsupported globs, negation, absolute paths and traversal are rejected. This does not add failures to the single-worker pool's per-assignment changed-file list.
The explicit artifact defaults are directories `coverage/`, `.nyc_output/`, `.pytest_cache/`, `__pycache__/`, `.mypy_cache/`, `.ruff_cache/`, `.cache/`, `node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.turbo/`, `.next/`, `.vite/`, `__snapshots__/` (whole directory segments at any depth), and basenames `.eslintcache`, `*.tsbuildinfo`, `*.log`, `*.pyc`, `*.orig`, `*.rej`, `*.tmp`, `*.swp`, `.DS_Store`, `junit*.xml`, `*.lcov`, `coverage*.json`, `report.json`, `*-report.*` (at any depth; `.env*`/`.npmrc` remain config outside artifact directories). Everything else defaults to source; `audit.artifacts` extends, rather than replaces, these defaults.

## Which models and settings orche uses

Config discovery, first match wins:

1. `<cwd>/.pi/orche.config.json`, only if Pi trusts the project (a project file can choose models and enable advisors, so an untrusted project cannot). An untrusted project file is reported as ignored in multi-run result details.
2. `~/.pi/agent/orche.config.json` (`PI_CODING_AGENT_DIR` is honored).
3. Otherwise every orche role uses the session's current model and thinking level.

The file has the same format as the repository's `orche.config.json` (`routes`, `default`, optional `advisors`, `providerExtensions`, `extendedContext`, `verifyCommands`, `workers`, `mainMode` and `limits`; see [advisor.md](advisor.md)). `verifyCommands` is a list of 1–8 shell commands the verifier must run (for example `["npm test", "npm run lint"]`); without it the verifier discovers the project's own checks. An existing file that fails validation is an error; there is no silent fallback.

### Run limits (`limits`)

Library runs (`runOrchestrated` via the controller or CLI) use the discovered file's limits, passed through `routes` to the common run resolver; there is no separate fixed tool timeout. `orche_task` uses that same resolver's assignment wait and soft request budget, as described in §5. Add this top-level field to that file:

```json
"limits": { "overallMs": 3600000 }
```

Time fields are **milliseconds**. Defaults are `overallMs: 3600000` (3600s), `explorationMs: 1200000` (1200s), `assignmentMs: 3600000` (3600s, worker result waits), and `decisionMs: 1800000` (1800s). Precedence: hardcoded defaults < discovered config `limits` < programmatic `RunOptions.limits`. All explicit values merge first, then missing phase caps derive from the effective overall limit (one third / all / one half). An explicit phase cap stays in force when only the overall limit is overridden. The standalone CLI and evaluation baseline use the same resolution, so explicit benchmark budgets still take precedence.

Phase caps are ceilings, not additive slices; waits are clamped to the remaining overall budget and messages never reset deadlines. Time 0 gives no waiting budget, **not unlimited time**. Additional fields: `maxFixRounds` (default 1), `decisionRepairs` (default 2, maximum 2), `assignmentRequests` (default 150; **0 disables only the request budget**). Counts must be non-negative integers (request counts safe integers), times finite non-negative numbers; invalid objects, values and unknown fields are rejected with key-specific errors. Config discovery and project trust rules are unchanged. Reload the Pi extension after source changes; an in-flight run keeps its old limits.

The orchestrated deadline covers runtime/provider/session startup, phases, owned Git calls, final audit and teardown; config discovery precedes it. Timeout progress and optional result `timeouts` metadata distinguish overall/phase and name the stage, elapsed/caps and available worker activity. User cancellation still means `cancelled`, not timeout. Teardown adds no grace beyond the remaining overall budget: `cleanup.incomplete`/`pending` exposes unfinished SDK creation/abort/audit cleanup. Late sessions are disposed and new assignments, RESULT/NOTE and guarded tool calls are fenced. Synchronous JS and uncooperative in-process SDK/tools are not forcibly isolated and can outlive the report; avoid reusing a workspace with pending work. RESULT kind must match the current assignment (even without a data schema); mismatches share the existing same-assignment bounded repair budget.

### Models, auth and providers that extensions register

Orche runs use **their own `ModelRuntime`** (created lazily, once per Pi session, with `ModelRuntime.create()`): Pi's public, file-backed runtime, so the same `~/.pi/agent` credentials with Pi's own locking and refresh, exactly like the standalone CLI. Orche does not reach into the session's model registry (no private API).

That runtime knows Pi's built-in providers and `models.json`, but not providers that **another Pi extension registers into your session** (for example a gateway package such as `@router-for-me/pi-cliproxyapi-provider`). To use those, list the extension's Pi package in the config:

```json
{
  "providerExtensions": ["npm:@router-for-me/pi-cliproxyapi-provider"],
  "default": { "model": "cliproxyapi/gpt-6.1-sol", "thinking": "high" },
  "routes": { "verifier": { "model": "cliproxyapi/claude-sonnet-5-5", "thinking": "medium" } }
}
```

How it works (Pi's public resource-loading and session APIs only): each source must be **installed at user scope** (`pi install <source>`; it is resolved with `getInstalledPath`, so nothing is downloaded). A `DefaultResourceLoader` with `noExtensions: true` and just those packages' paths (the same as `pi --no-extensions -e <package>`) loads **only those packages' extensions**, never the rest of your extension set, and never pi-orche itself (a source whose package name is `pi-orche` is refused to avoid recursion). A hidden, tool-less, in-memory session binds them to orche's runtime and registers their providers; it makes no model call. Multi creates that host at run start and disposes it at run end (about one second of start-up); the task pool caches hosts by `providerExtensions` list and disposes them with the pool. Credentials stay where the provider package keeps them (`~/.pi/agent/auth.json` / its own config), so they must be present there.

Consequences:

- All extension files the package declares are loaded into that hidden session (package granularity), so its own hooks/commands exist there but not in your session.
- Providers registered by an extension you did **not** list, and credentials that live only in memory, are not visible to orche runs.
- If a route names a model that does not resolve, the run fails with `Unknown model: <provider>/<id>`. If no orche config exists and the session's current model cannot be resolved (rule 3), the run fails with a message naming `.pi/orche.config.json` and `providerExtensions`.
- Library run result details include `models`: model requests per actor (`coordinator`, `A1`, `V1`, `advisor:<name>`), so you can check which model served which role.

### Extended context (`extendedContext`)

The catalog advertises a 272K context window for `gpt-6.1-sol` and `gpt-6-astra`, but the provider accepts much more input (OpenAI documents 922K input of 1.05M total); the 272K figure is the **standard-price threshold**, and input above it is billed at the premium long-context tier: **2x the input price**. Pi uses model metadata for output clamps, overflow detection and compaction. Multi-run sessions keep compaction off; single-workflow task workers compact above 50% of the inherited/resolved effective window.

```json
{
  "extendedContext": true,
  "default": { "model": "cliproxyapi/gpt-6.1-sol", "extendedContext": true },
  "routes": { "coordinator": { "model": "cliproxyapi/gpt-6-astra", "extendedContext": true },
              "verifier": { "model": "cliproxyapi/claude-sonnet-5-5", "extendedContext": false } }
}
```

- `extendedContext` is a boolean at the top level (default for all routes) and per route/`default` (the route's own value wins; an unlisted role takes `default`'s value, then the top-level value; otherwise off).
- When on, the session's model is a **copy of the catalog model with `contextWindow` raised to a curated per-model maximum** (a table in `src/pi/extended-context.ts`: `gpt-6.1-sol` and `gpt-6-astra` → 922,000). Nothing is sent to the provider differently (there is no request field for it, in omp either); only Pi's local limits change, and the window is never lowered.
- **Models without a table entry are unchanged**: `gpt-6-luna`, `gpt-6-sol` and all Claude models keep their advertised window, even with `extendedContext: true`. The table is explicit on purpose; a wrong guess would turn into overflow errors.
- Applies to every orche session on a matching route: coordinator, workers (implementers, explorers, analysts, verifier) and advisors.
- The effective window is recorded as a `context_window` event per actor (`{actor, model, contextWindow, advertisedContextWindow, extended}`) and in library run result details as `contextWindows`.
- Cost: only requests whose input exceeds 272K tokens are affected, and they are billed at the 2x tier.

## Install, check, remove

```sh
pi install /path/to/pi-orche      # writes the package source to ~/.pi/agent/settings.json "packages"
pi list
pi remove /path/to/pi-orche       # uninstall (same source string as installed)
pi -e /path/to/pi-orche           # try for one invocation without installing
```

A local path is loaded in place (not copied or modified), so run `npm install` in the repository once: the package's runtime dependencies (`@ast-grep/napi`, `@sinclair/typebox`, `typescript`) come from its `node_modules`. The `@earendil-works/*` packages are `peerDependencies` (Pi supplies its own copies to extensions) and also `devDependencies` so the standalone CLI and the tests keep working.

## Verification status

Covered by automated tests with faux providers and real `AgentSession`s:

- `test/extension/mode.test.ts`: the complete tool matrix for all four modes; default `direct`; mode-specific guard diagnostics, PowerShell rejection and Bash inspection/mutation handling; config precedence/validation and saved mode restoration; byte-stable policy per mode; the explicit multi/reuse/supervision criteria; `/orche single` and `/orche direct` one-turn overrides and their busy rules in every session mode (including direct restoration after abort/model error); external absolute/`../` path writes and anchored edits in one-turn and persistent direct mode, with prompt permission/limits and non-direct blocking regressions.
- `test/extension/single-mode.test.ts`: unchanged multi/direct snapshots, end-to-end single behaviour, guard recovery, real main/worker turns in print/TUI contexts and same-worker follow-ups. `test/extension/delegation-rules.test.ts` holds explicit new single/auto expected strings. `test/extension/task.test.ts` checks the new single/auto implement instruction and retains the omitted-mode SDK instruction against HEAD.
- `test/extension/task-plan.test.ts`: unique ids, unknown dependencies, cycles, done/dependency ordering, enum validation, replacement, rendering and next-ready. `test/extension/single-workflow.test.ts`: worker-only registration/hand-over upgrades, plan persistence, checklist repair/summary/streak reset, main model/effort inheritance and switching/fallback/specialists, 50% threshold and 70% retirement exemption, real manual/mid-assignment automatic compaction with preserved essentials and records. `test/orchestration/result-schemas.test.ts` covers optional/valid/invalid checklists and required R-id coverage; `test/pi/context-projection.test.ts` includes stale-index reset and fresh post-compaction boundaries.
- `test/tools/edit.test.ts`: actual anchored edits to absolute and `../` external paths in isolated temporary directories, plus anchor validation and atomicity regressions.
- `test/extension/task.test.ts`: `orche_task` registration, spawn/result/roster and context delivery; session reuse across roles with stale workspace context; implement ownership before writes and changed-file audit; read-only role enforcement and ignored `files`; unsupported globs; unknown/disposed ids with live-worker lists; LRU eviction at cap 3 and monotonic ids; injectable idle TTL; context-full retirement (text/details, removal from the roster/pool, and retired-id reuse error with the live-worker list); mutual exclusion with multi; `/orche cancel` during a task leaving its worker reusable; tool abort signals and running-worker refusal; `/orche workers`/`/orche stop` including malformed stop; idempotent `session_shutdown` disposal; the multi nudge for blocked/failed verification and its absence for successful verification/exploration.
- `test/extension/task-context-clearing.test.ts` and `test/pi/context-projection.test.ts`: real-provider-request projection, assignment-local byte stability, monotonic thresholds, reasoning/signature removal, recoverable artifact paths, full raw persistence, dynamic disable/re-enable, unchanged multi sessions, pairing and observability.
- `test/extension/extension.test.ts`: tool exposure and spill; `/orche direct` as a main-session turn and compatible busy follow-up; usage errors that start nothing, `/orche cancel` while idle and strict command parsing (removed `multi`/`auto` tokens are usage errors).

These are deterministic regressions, not live-model verification of the new delegation modes or single-worker pool. The interactive terminal UI (status line, widget, message rendering) has not been driven by automation.
