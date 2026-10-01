# pi-orche as a Pi package

`pi install /path/to/pi-orche` adds pi-orche to your normal interactive `pi` sessions. The package manifest (`package.json` → `pi.extensions`) loads `src/extension/index.ts`, which provides five things: tools, delegation modes for the main agent, the `/orche` command, the `orche_run` tool and the `orche_task` tool.

## 1. Tools in every session

- **`read` and `edit` replace Pi's built-ins** (an extension tool registered under a built-in name wins in Pi's tool registry). `read` prints `LINE#TAG|text`; `edit` takes those anchors. The registry has exactly one of each; the delegation mode can deactivate `edit`. See [tools.md](tools.md).
- **Added tools (active subject to the delegation mode below):** `find` (our in-process walk), `ast_search`, `ast_rewrite`, `diagnostics`. Pi's own `grep` and `ls` are switched on as well (`grep` needs `rg`, as in Pi). `bash` and `write` stay Pi's.
- **Long-output spill on every tool result:** results over 12,000 characters or 300 lines (except `read`, which pages itself) are cut to head + tail, and the full text is saved to `<cwd>/.orche/artifacts/<tool>-<id>.txt` (with a `.gitignore`/`.ignore` so it stays out of git and out of grep). The truncated result tells the model where the file is.
- If you start Pi with `--tools` / `defaultTools` that leave out any of our tools, that selection is respected and grep/find/ls are not added.
- The tools are bound to the working directory of each call, so a global install works in any project.

## 2. `/orche` commands

The command grammar is strict. `single`, `multi` and `direct` need a non-empty prompt; `mode` takes no argument or one of `auto|single|multi|direct`; `workers` and `cancel` take nothing after them; `stop` needs one worker id or `all`. Anything else (a bare `/orche <PROMPT>`, `/orche`, `/orche single`, `/orche stop`, `/orche mode turbo`, `/orche cancel now`) shows this usage and starts nothing:

```text
Usage: /orche single|multi|direct <PROMPT> | /orche mode [auto|single|multi|direct] | /orche workers | /orche stop <id>|all | /orche cancel
```

- **`/orche single <PROMPT>`**: hands the prompt to the **current Pi session as a normal user turn** (`pi.sendUserMessage`), with its model, thinking level and conversation, under a **one-turn override to `single`**: direct write tools and `orche_run` off, `orche_task` on. The main chooses the worker role and supervises the result; this is not a direct-edit turn. After the turn settles the session mode's tool set returns. While busy, the prompt is queued as a follow-up only in session mode `auto` or `single`; it keeps the session mode, not a one-turn override. In `multi` or `direct` it is refused: `orche single: refused. The agent is busy and this session is in mode <session mode>, where a queued turn could not delegate to one worker. Wait for the current turn, or switch with /orche mode single.`
- **`/orche direct <PROMPT>`**: the former `/orche single` behaviour. It starts the current session's turn with a **one-turn override to `direct`** (direct edits allowed, both delegation tools off); no orchestrator or worker is started by the command. The session mode's tool set returns when the turn settles, is aborted or fails. While busy it queues a follow-up only when the session mode is already `direct`; otherwise it is refused: `orche direct: refused. The agent is busy and this session is in mode <session mode>, where a queued turn could not edit files. Wait for the current turn, or switch with /orche mode direct.` Compatible busy commands notify `orche single: the agent is busy; the prompt is queued as a follow-up turn.` or `orche direct: the agent is busy; the prompt is queued as a follow-up turn.` They never apply an override to someone else's turn or run the queued prompt concurrently.
- **`/orche multi <PROMPT>`**: runs the multi-agent orchestrator (coordinator, parallel workers, independent verifier; see the README) on the session's working directory. Progress shows in the status line and a widget (`phase …`, `A1 started T1`, `verification passed`). When it ends, the final answer is posted into the conversation as a visible `orche-result` message. It is stored in the session and sent to the main model with its next turn, so you can follow up with "apply what orche found". The command itself starts no main-model turn. Failures (including "orche could not run: …") are posted as the same kind of message. A second activity is refused with a notice, including while an `orche_task` assignment is active. In the **interactive TUI** the run goes to the background and the command returns at once (Pi's editor queues input behind a pending command, which would postpone a typed `/orche cancel` until the run was over), so the editor stays usable while it runs; in print/json/RPC mode the command stays pending until the run ends.
- **`/orche mode [auto|single|multi|direct]`**: without an argument prints the current session mode and where it comes from (`config <path>`, `set with /orche mode in this session`, or `default`). With one it switches the session's mode at once (tool set, status line) and records the choice with `pi.appendEntry`, so it survives `/reload` and resuming the session.
- **`/orche workers`**: shows one line per live worker, for example `W1 idle · implement · 2 assignments · last: … · idle 3m`, or `no workers`. The line contains status, latest role, completed assignment count, the first 80 characters of the last summary (or `no result yet`) and whole idle minutes.
- **`/orche stop W1` / `/orche stop all`**: stops and disposes the named worker or all live workers, with `Disposed workers: W1` (or a comma-separated list). An unknown id reports `unknown worker <id>`; an empty pool with `all` reports `no workers`. `/orche stop` without an id prints the usage.
- **`/orche cancel`**: cancels the active `/orche multi` run, `orche_run` call or `orche_task` assignment. For multi, its `AbortSignal` fires, the coordinator, workers, verifier and advisor sessions are stopped and disposed, and a cancelled `/orche multi` posts `orche-result` with `details.cancelled: true` and the header `orche CANCELLED by user`. A cancelled delegation tool call ends with the error `cancelled by user`; a task worker returns to idle and stays reusable rather than being disposed. The notice is still `orche run cancelled` after cancellation completes, or `no active orche run` when nothing is active. A new activity can start after cancellation. To abort the main session's ordinary turn, including a one-turn override, use Pi's own Esc; an active delegation tool receives its abort signal.

## 3. Delegation mode (`mainMode`)

The main keeps the conversation and supervision while choosing single-worker or multi-agent delegation per request. The mode set is `auto`, `single`, `multi`, `direct`; the default is now **`auto`**, not the previous `multi`.

| Mode | Main session tools | Rules injected into the system prompt |
| --- | --- | --- |
| `auto` (default) | `edit`, `write`, `ast_rewrite` **deactivated**; Bash allowlist; PowerShell unsupported; `orche_task` and `orche_run` on | Delegate every change and multi-file investigation; choose one worker for a cohesive unit, investigation, answer, verification or follow-up; require multi under the criteria below |
| `single` | Like `auto`, but `orche_run` **deactivated and guarded** | Delegate with `orche_task`; when multi criteria hold, explain and ask the user to switch to `auto` or `multi` |
| `multi` | Like `auto`, but `orche_task` **deactivated and guarded** | Delegate every change with `orche_run` (the previous default behaviour) |
| `direct` | Both `orche_task` and `orche_run` **deactivated and guarded**; everything else on, subject to the user's tool selection | Make changes directly with the main's own tools |

**Breaking change:** `single` changed meaning. The old direct-edit `single` mode is now `direct`; an existing config with `"mainMode": "single"` now selects the **single-worker delegation mode**. Use `"mainMode": "direct"` for the old behaviour, and `/orche direct <PROMPT>` for the old one-turn command.

In `auto`, `orche_run` is required when any of these holds (the exact `MULTI_CRITERIA` from `src/extension/mode.ts`):

> the change spans two or more independent write sets or units with separate acceptance; the cause of a defect is unknown and needs parallel hypotheses; the change needs independent verification (user-visible behaviour, risky or wide changes, anything the user wants verified); the user asks for orchestration; a single worker reported blocked or a failed verification twice on the same unit.

Unclear scope prefers multi; the rules forbid splitting a multi-sized job into several `orche_task` calls to avoid it. In `single`, those criteria instead require asking the user to switch to `auto` or `multi`. The single-worker rules also call for judgment before production (start with `explore` or `answer` when cause or scope is unclear), actual reuse for follow-ups and supervision: a worker's report is not acceptance; inspect its key evidence, run trusted checks or dispatch `verify`, and label unverified items as unverified. The `orche-delegation` system-prompt section is byte-stable per effective mode; no worker roster or changing session state is inserted into it.

In `auto`/`single`/`multi` the main keeps the conversation, inspection (`read`, `grep`, `find`, `ls`, `ast_search`, `diagnostics`, static Bash), trusted project checks that may create generated files, and composing the delegation request. Set `"mainMode"` to `"auto"`, `"single"`, `"multi"` or `"direct"` in the orche config (the same selected file as the routes: trusted project file, else user file; the standalone CLI ignores the key). An invalid value is reported at session start and the default `auto` applies unless a saved session choice overrides it. Effective-mode precedence is one-turn override, saved `/orche mode` choice, config, then `auto`. The status line shows `orche: <session mode>` with ` (one-turn single)` or ` (one-turn direct)` during an override.

**Enforcement in `auto`/`single`/`multi`, and what it is not.** Two layers: the tool set removes `edit`, `write`, `ast_rewrite` and any mode-disabled delegation tool from the active set, and a `tool_call` guard blocks them if something re-activates them. `direct` instead removes and guards both delegation tools. Only tools the mode itself removed are restored on a mode change, so a `--tools` selection stays yours. Guard messages start `Blocked by orche mode "<mode>":`; explicit mutations tell the main to delegate, not retry directly; unsupported commands are reported as unverified, not falsely declared mutating. Use `read` with offset/limit, `grep`, simple static commands or an available delegation tool for alternatives. PowerShell is unsupported in `auto`/`single`/`multi` until a dedicated parser exists; it is never parsed as Bash. Bash commands in those modes go through the unchanged **deny-by-default allowlist** (`src/extension/bash-policy.ts`): allowed are inspection commands (`ls`, `cat`, `grep`, `git status/diff/log/show...`, `find` without actions, `jq`, ...) and trusted test/lint/typecheck runners (`npm test`, `npm run test|lint|typecheck|check[:...]`, `node --test`, `vitest`, `tsc --noEmit`, `pytest`, `cargo test`, `go test`, ...), chained with `&&`, `;` or pipes. `npx`/`bunx` require explicit `--no-install` and a supported runner (for example `npx --no-install vitest run`); this does not guarantee containment or executable provenance. Everything else is blocked, as are output redirections (except static `/dev/null`/`2>&1`), active variables, brace/tilde expansions, bare globs, command/process substitutions, heredocs, subshells, background jobs, unknown syntax, and environment-variable prefixes other than `CI`, `NODE_ENV`, `TZ`, `NO_COLOR`, `FORCE_COLOR`. Quote literal patterns, for example `find . -name '*.ts'`; quoting a variable does not make its expansion supported. General `sed`/`awk` are unsupported. **This is a guard against habitual direct edits, not a sandbox.** Allowed checks execute project code/configuration and may create generated files, caches or reports; the allowlist is syntactic and cannot know what a script, alias or configuration does; and tools registered by other extensions are not restricted. Policy classification does not guarantee successful CLI execution. Do not rely on it as a security boundary.

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

## 4. `orche_run` tool

Lets the main model delegate a request. The orchestrator **does not see the conversation**, so `request` must be self-contained: goal, decisions made so far, the relevant files and findings, constraints and acceptance criteria. An optional `context` string carries supporting background (findings, excerpts, earlier decisions; max 30,000 characters) and is appended to the problem the coordinator sees under "Context from the requesting session". The tool description and the injected rules both say this. Progress streams through the tool's partial updates; the final report is the tool result. A failed or cancelled orchestration is an **error** result. Pi's abort of the turn (Esc) cancels the run through the tool's `AbortSignal`: the coordinator and every worker and advisor session are stopped and disposed, and the result says `cancelled`. `/orche cancel` ends the call with the error result `cancelled by user`.

`orche_run` is always the multi-agent path. It shares the session's activity slot with `orche_task` and `/orche multi`; an active task prevents it from starting.

Multi progress (tool updates and `/orche multi` status/widget) retains the last eight milestones plus a current activity line: `A1 implement · 12 requests · last tool: edit` or `coordinator deciding (EXECUTE) · 3 requests`. Model-request/tool activity updates are throttled per actor to about five seconds, except tool-name changes. Decision prompts and advisor reconsideration are explicit milestones. A delivered advisor concern/blocker is queued and applied at the coordinator's **next decision**, not an immediate interruption of the current worker assignment. Manual cancellation keeps summary `cancelled`; optional report/details `cancellation` metadata snapshots stage, phase, elapsed time and workers' requests/last tool/activity before teardown, and the formatted outcome adds `Cancelled at EXECUTE after …s; active: …`.

## 5. `orche_task` and the worker pool

`orche_task` delegates one self-contained assignment to one persistent worker, without a classifier call or coordinator. It covers bounded units, investigations, questions, verification passes and follow-ups while the main retains the conversation and supervises the evidence. The main chooses the role; no automatic independent verification is added to an `implement` assignment.

### Parameters and assignment contract

- **`role`** (required): `explore | answer | implement | verify`. `explore` investigates and reports evidence (optionally `cause`); `answer` produces an evidence-backed answer; `implement` changes files and runs local checks, reporting `status: done|blocked`; `verify` independently reviews and runs `verifyCommands`, or discovers the project's checks, reporting `passed` and evidence/issues.
- **`request`** (required, non-empty): workers do not see the main's conversation. The injected rules ask for a self-contained contract with sections **Goal / Scope and non-goals / Decided and open / Inputs and dependencies / Acceptance and verification / Return**.
- **`context?`**: supporting background, at most 30,000 characters; non-blank context is appended under `## Context from the requesting session`.
- **`worker?`**: reuse a live id such as `W1`, retaining that session's context and original model even when its role changes. Omit it to start a new worker. Unknown or retired ids are errors, not fabricated reuse: `Unknown worker <id>; live workers: <list>. Omit worker to start a new one.` The list contains live ids, statuses and roles, or `none`. A worker with a running assignment errors with `Worker <id> is running; wait for its assignment to finish.` (the shared activity guard can refuse the request earlier).
- **`files?`**: write scope for `implement`, using concrete workspace-relative files or recursive directory areas `dir/`, `dir/**`, `dir/**/*` (canonicalized to `dir/`). Other globs, absolute areas and outside-workspace areas are rejected. Omission permits writes anywhere **inside the workspace**; an explicit empty list grants no write scope. For read-only roles the field is ignored with `Note: files ignored for read-only role.`

Workers have ids `W1`, `W2`, …, increasing monotonically within the Pi session's in-memory pool and never reused. Each is spawned with the full worker tool set, but **no peer messaging** (`send_message` is absent). The per-assignment write-tool guard makes `explore`, `answer` and `verify` read-only and allows `implement` only within its `files`, or within the workspace when omitted. Outside-workspace targets and mutating `ast_rewrite` calls without an explicit path remain blocked; `ast_rewrite` with `dryRun: true` does not write and bypasses that guard. The guard checks `edit`, `write`, `ast_rewrite`, not arbitrary Bash behaviour; role instructions and the audit are not a shell sandbox.
Both lexical and real paths must remain inside the real workspace root and the original declared scope (including the requested-path scope when `files` is omitted); new files resolve via the nearest existing ancestor, and dangling links, loops or other resolution errors are blocked. Directory `ast_rewrite` checks only its target, not its tree; symlink-reachable files receive the per-file guard when edited individually, and workspace auditing remains a post-hoc backstop, but Git stores links without following them, so writes through links may change targets outside the snapshot.

### Pool lifetime and reuse

At most **3 live workers** are retained. A fourth new-worker request retires the least-recently-used idle worker and names it in the result: `W2 retired: least-recently-used idle worker (pool cap 3).` A running worker is never an eviction candidate; if none is idle the request fails. Idle workers expire after **30 minutes** (the timer is unref'd, so it does not keep Pi alive). After an assignment, if the worker's latest model request used **at least 70%** of its effective context window (`input + cacheRead`), it is retired and the result says `W1 retired: context nearly full; start a new worker with the contract and evidence`.

The pool is in-memory only: workers and retained context are gone after `/reload` or session resume, and `session_shutdown` disposes the pool. `/orche stop` explicitly stops and disposes workers; `/orche cancel` only cancels the current assignment and leaves its worker idle and reusable. Idle pool workers persist alongside and after multi runs; they are not the multi orchestrator's own workers.

In a git work tree each assignment takes before/after workspace snapshots through a **private index**, leaving the user's index, HEAD and stash untouched. The diff covers tracked and non-ignored untracked files (excluding `.orche` artifacts), and the result lists `Changed files: …` or `No files changed`. Outside git the result says `Workspace audit unavailable (not a git work tree)`. Unlike a multi run, a task does not create a baseline recovery ref. On reuse, the new assignment prompt starts with `## Stale context: workspace changes since your previous assignment`, listing files changed since that worker's previous assignment as `path (status)` and asking it to re-read changed evidence; with no changes it says `No files changed.`, or reports the audit unavailable outside git.

### Routing, limits and result

Discovery and provider registration use the same config and file-backed runtime as `orche_run` (below), including the same `NoRouteError` message when the session's model cannot be resolved: it names `.pi/orche.config.json` and recommends explicit routing and `providerExtensions`. New workers route `answer` → `analyst`, `explore` → the first `workers.explorerRoles` entry (default `explorer-path`), `implement` → `implementer`, `verify` → `verifier`, falling back to the config's `default` when the route is absent. Reuse does not reroute an existing worker. The common limit resolver supplies `assignmentMs` for the result wait and `assignmentRequests` for the soft request budget (default 150; 0 disables it); tasks have no coordinator phases or multi-run overall deadline. `providerExtensions` are loaded through the same provider-host mechanism; task hosts are cached by package list until pool disposal, rather than disposed after each assignment.

Progress appears through tool updates and the `orche` status. Successful assignment text has this header (seconds rounded to the nearest integer):

```text
orche task W1 (<role>, <s>s, <n> requests; <config source>)
```

It then contains the worker's summary, any supplied role data (`status`, `reason`, `passed`, `issues`, `cause`), the changed-file/audit line, `Workers: <roster>` and any retirement lines or notes. The compact roster is `W1 idle (implement: <summary>)`, comma-separated for multiple workers, or `no workers`. `details` is `{ worker, role, status, durationMs, requests, changes, roster, retired? }`; `changes` contains `{ path, status }` entries (`added`, `modified`, `deleted`), and `retired` lists ids when retirement occurred. Assignment failures, timeouts and cancellation are error tool results.

The escalation note `Note: consider orche_run (multi) — …` appears only when the worker reports `status: blocked` (`the worker reported blocked`), `verify` reports `passed: false` (`verification failed`), or `implement` changes at least 4 audited files (`the implementation changed four or more files`), in that priority order. It is advice, not an automatic multi run or proof of acceptance.

## Concurrency

One orche **activity** per Pi session: `orche_task`, `orche_run` and `/orche multi` share a slot and refuse to start while another is active. `OrcheBusyError` reads `An orche <kind> is already active in this session; wait for it to finish or cancel it (/orche cancel).`, where `<kind>` is the active `task` or `run`. `/orche cancel` frees the slot after cancellation; idle pool workers remain available alongside and after multi runs. The one-turn `/orche single` and `/orche direct` commands start ordinary main-session turns, subject to their busy rules above; delegation tools used during those turns still obey the activity slot.

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

Both `/orche multi` and `orche_run` use the discovered file's limits, passed through `routes` to the common run resolver; there is no separate fixed tool timeout. `orche_task` uses that same resolver's assignment wait and soft request budget, as described in §5. Add this top-level field to that file:

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
- `/orche multi` result details include `models`: model requests per actor (`coordinator`, `A1`, `V1`, `advisor:<name>`), so you can check which model served which role.

### Extended context (`extendedContext`)

The catalog advertises a 272K context window for `gpt-6.1-sol` and `gpt-6-astra`, but the provider accepts much more input (OpenAI documents 922K input of 1.05M total); the 272K figure is the **standard-price threshold**, and input above it is billed at the premium long-context tier: **2x the input price** (visible in the models' cost tiers). Pi uses the advertised window locally: it clamps a request's output budget to `contextWindow - estimated input - 4096`, so past roughly 268K tokens of context the output cap collapses to 1 token, and it drives overflow detection and compaction thresholds. Orche sessions run with compaction off, so without help a long run would simply break at that point.

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
- The effective window is recorded as a `context_window` event per actor (`{actor, model, contextWindow, advertisedContextWindow, extended}`) and in the `/orche multi` result details as `contextWindows`.
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

- `test/extension/mode.test.ts`: the complete tool matrix for all four modes; default `auto`; mode-specific guard diagnostics, PowerShell rejection and Bash inspection/mutation handling; config precedence/validation and saved mode restoration; byte-stable policy per mode; the explicit multi/reuse/supervision criteria; `/orche single` and `/orche direct` one-turn overrides and their busy rules in every session mode (including direct restoration after abort/model error).
- `test/extension/task.test.ts`: `orche_task` registration, spawn/result/roster and context delivery; session reuse across roles with stale workspace context; implement ownership before writes and changed-file audit; read-only role enforcement and ignored `files`; unsupported globs; unknown/disposed ids with live-worker lists; LRU eviction at cap 3 and monotonic ids; injectable idle TTL; context-full retirement (text/details, removal from the roster/pool, and retired-id reuse error with the live-worker list); mutual exclusion with multi; `/orche cancel` during a task leaving its worker reusable; tool abort signals and running-worker refusal; `/orche workers`/`/orche stop` including malformed stop; idempotent `session_shutdown` disposal; the multi nudge for blocked/failed verification and its absence for successful verification/exploration.
- `test/extension/extension.test.ts`: tool exposure and spill; `/orche direct` as a main-session turn and compatible busy follow-up; `/orche multi`, usage errors that start nothing, `/orche cancel` during multi/`orche_run` and while idle, a new run after cancel, TUI-mode background multi, `orche_run` progress/results/errors, abort/disposal, session-model fallback and unresolvable-model diagnostics.

These are deterministic regressions, not live-model verification of the new delegation modes or single-worker pool. The interactive terminal UI (status line, widget, message rendering) has not been driven by automation.
