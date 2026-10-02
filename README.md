# pi-orche

A thin MPLM-style multi-agent coding orchestrator on Pi SDK 1.0.0. A read-only LLM coordinator first classifies the instruction and chooses 1 to `workers.maxWorkers` (default 3) persistent workers proportionately. Questions and reviews produce evidence-backed answers without editing; clear changes go directly to implementation; unexplained defects use investigation, early convergence and worker reuse. Every change is independently verified, with one bounded fix round if necessary.

## Run

Requires Node.js, installed dependencies (`npm install`), and Pi credentials for the configured routes. Credentials use Pi's shared file-backed model runtime; this project does not change global Pi settings, persist model/thinking selections, or fork Pi. Change/diagnosis runs edit the supplied workspace: use a clean disposable copy when experimenting. Answer-class workers receive only read/grep/find/ls tools, never edit/write/bash.

```sh
npx tsx src/cli.ts --cwd /path/to/project --problem 'Analyze and fix the reported bug' --events events.jsonl
npx tsx src/cli.ts --cwd /path/to/project --problem-file ISSUE.md --config orche.config.json --route coordinator=openai/gpt-6.1-sol:high
```

The CLI prints a JSON final report and exits nonzero on failure. `--route` is repeatable; provider/model/thinking routing belongs exclusively in configuration. The shipped multi-run roles use `openai/gpt-6.1-sol` at `high`. Route roles include `coordinator`, `analyst`, `implementer`, `explorer-path`, `explorer-cause`, `explorer-repro`, `verifier`, and the `orche_task` specialists `game-asset` (game art/audio/model assets) and `video` (video production/editing). Explicit `routes` entries always win. With no specialist entry, a new task worker prefers `claude-opus-5-5` on the effective `default` route's provider, retaining its thinking and effective extended-context setting, only if the runtime resolves that model. Otherwise it uses the normal default-route fallback (or the usual no-route error). Session-source defaults use the session model's provider: `cliproxyapi/claude-opus-5-5` stays that route; `anthropic/x` prefers `anthropic/claude-opus-5-5`.

`workers` in `orche.config.json` shapes the team: `maxWorkers` (1–8, default 3) caps the coordinator's `workerCount`; `explorerRoles` (default `["explorer-path", "explorer-cause", "explorer-repro"]`) are the route roles of `diagnose_fix` explorers in order; `answerAngles` are the investigation angles of `answer` analysts in order. Both lists are reused cyclically when there are more workers than entries, so they do not have to be as long as `maxWorkers`. Each additional explorer role needs a route or the `default`. More workers only help with genuinely independent units: implementers share one working tree, ownership must stay disjoint, and the coordinator's context grows with every worker it coordinates.

### Raster image generation

The `cliproxyapi-images/gpt-image-2.5` image model (CLIProxyAPI gateway, from [pi-images](https://github.com/zmfkzj/pi-images)) is **bundled with pi-orche**: `pi install git:github.com/zmfkzj/pi-orche` brings its provider along, so there is no separate install and no `providerExtensions` entry. Set the model in `orche.config.json` (merge into your existing file, retaining `routes` and `default`):

```json
{
  "images": { "model": "cliproxyapi-images/gpt-image-2.5", "timeoutMs": 180000 }
}
```

When `images.model` names `cliproxyapi-images`, orche registers the bundled provider into its own runtime (separate from the main Pi session) the first time a **game-asset** or **video** task needs it. This is lazy: nothing is registered, and no config or credential file is read, when `images` is unset, for other roles, or for another provider. It is also idempotent, and it is skipped when that provider is already registered, so also listing `git:github.com/zmfkzj/pi-images` in `providerExtensions` is harmless but unnecessary.

Credentials come from the `CLIPROXYAPI_API_KEY` and `CLIPROXYAPI_BASE_URL` environment variables, or from `cliproxyapi.json` (`apiKey`/`baseUrl`) or the `cliproxyapi` entry of `auth.json` in the Pi agent directory (the same one orche uses for its own config). They are resolved when an image is requested and never go in this routing file.

`providerExtensions` is needed only for **other** image providers. Install the provider's Pi package first (`pi install <source>`, since `providerExtensions` loads only packages installed at user scope), list it, and point `images.model` at its model:

```json
{
  "providerExtensions": ["npm:@scope/pi-other-image-provider"],
  "images": { "model": "other-images/some-model" }
}
```

Sources use Pi package syntax (`npm:`, `git:`, or local paths resolved relative to `~/.pi/agent`). `images.model` must be `provider/modelId`; the optional timeout is a positive finite number of milliseconds (default 180000). Unknown image fields or invalid values are errors.

Only `orche_task` **game-asset** and **video** workers get `generate_image`, and only when `images.model` is configured. It accepts a prompt, workspace-relative `.png`/`.webp`/`.jpg` output path, optional workspace raster `references` (sent as image-edit inputs), background (`transparent`, `opaque`, `auto`), width/height, fit (`contain` default, `cover`, `fill`, `inside`) and resize kernel (`lanczos3` default, `nearest` for pixel art). All writes use the existing real-path ownership guard; references cannot escape the workspace, including via symlinks. PNG/WebP retain alpha. Output includes the saved image, final/original dimensions, token usage and elapsed time. The gateway ignores requested size and returns roughly 1254x1254: always specify width/height for exact sprites/icons, request transparent backgrounds, inspect outputs with `read`, and record the prompt in `outputs[].spec`. Keep procedural/SVG tools for vector or pixel-exact assets.

Changing a reused worker's image capability/configuration starts a fresh worker so tools and old raster instructions cannot leak into other roles. Normal reuse is unchanged when images are unset. `orche_run` currently spawns only coding/investigation roles, not game-asset/video specialists.


Programmatic entry point: `runOrchestrated({problem, cwd, routes, sink?, modelRuntime?, limits?, baseSystemPrompt?, signal?, workspaceAudit?})`. `signal` cancels the run: sessions are stopped and disposed and a failed report with summary `cancelled` is returned. `baseSystemPrompt` replaces Pi's default base prompt in the coordinator and every worker session (advisors and judges keep their own); absent = Pi default. JSONL events include worker usage, coordinator usage, advisor triggers/results/usage, messages, assignment outcomes, phase changes, backlog ownership, and verification. Reports include ownership violations as decomposition failures, not silently approved writes.
`RunReport.taskClass` is `answer`, `change`, or `diagnose_fix` (`unclassified` only if classification fails); `RunReport.answer` is the full user-facing answer or a concise change/verification report, in the user's language. `request_classified` events record class, worker count, language and reason.
For read-only requests, the coordinator can approve `answer_from_worker` to pass an existing complete worker answer through unchanged; it only generates full answer text when substantive edits or multi-worker synthesis are needed.
During implementation/fixes, file ownership is per worker across all of that worker's current backlog tasks, not just its active task. Ownership is enforced in two layers:

- **Before execution (write tools).** Every `edit`, `write`, `ast_rewrite` and specialist `generate_image` call goes through Pi's blocking `tool_call` hook. A call is blocked, and the model gets the reason as the tool error, when the assignment is not `implement`/`fix`/`game-asset`/`video` (exploration, proposals, verification and answers are read-only), when the path is outside the workspace or outside the worker's owned files, or when `ast_rewrite` has no explicit path (its default is the whole workspace) and is not a dry run. Nothing reaches the disk, so a blocked call is an `ownership_blocked` event, not a violation.
  Both the lexical path and its real path must stay inside the real workspace root and the original declared ownership scope (links never expand ownership); new files resolve through their nearest existing ancestor, and dangling links, loops or other resolution errors fail closed. Directory `ast_rewrite` checks only the directory itself, without walking its tree; symlink-reachable files are checked when edited individually, with workspace auditing as a post-hoc backstop, but Git stores symlinks as links rather than following them, so writes through links can change targets outside the snapshot.
- **After each phase (any means).** In a git work tree the run snapshots the workspace through a private copy of the index; your index, HEAD, stash and worktree are not touched. Snapshots are taken at the start, after exploration/proposals or answers, after each backlog execution and after each verification. A tracked or untracked non-ignored file that is modified or deleted outside ownership is a violation with `via: "workspace"`; modifications/deletions during a read-only phase also count. This also catches writes through `bash`. The violation names every worker active in that phase, because a shared working tree cannot attribute the change to a single worker. A new unowned **source/config** file is also a violation (`created: true`), including during read-only phases; a new file inside a backlog-owned area is allowed during implementation. Only new **generated artifacts** are warned as `workspace_unowned_file` and listed for cleanup, without failing the run. All other new files, including `.txt`, `.env*` and `.npmrc`, default to source. Ignored files are not covered. During execution a shell write into another worker's owned file looks the same as that owner's own change, so it is not flagged.
  The explicit artifact defaults are directories `coverage/`, `.nyc_output/`, `.pytest_cache/`, `__pycache__/`, `.mypy_cache/`, `.ruff_cache/`, `.cache/`, `node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.turbo/`, `.next/`, `.vite/`, `__snapshots__/` (whole directory segments at any depth), and basenames `.eslintcache`, `*.tsbuildinfo`, `*.log`, `*.pyc`, `*.orig`, `*.rej`, `*.tmp`, `*.swp`, `.DS_Store`, `junit*.xml`, `*.lcov`, `coverage*.json`, `report.json`, `*-report.*` (at any depth; `.env*`/`.npmrc` remain config outside artifact directories). To allow genuine source creation, own the path in the backlog. For additional generated output, set `"audit": {"artifacts": ["notes.md", "reports/", "generated/**", "*.trace"]}` in `orche.config.json`: extras accept cwd-relative concrete paths, `dir/`, `dir/**` and simple `*.ext` basename globs at any depth; other globs, negation, absolute paths and traversal are rejected. These exemptions apply only to creation, never modification/deletion of existing files.

The pre-run snapshot is recorded as a commit and kept at `refs/pi-orche/baseline`, which each run overwrites. `RunReport.workspace` lists every changed file with that baseline. A failed run's report includes `git restore --source=<baseline>` / `rm` commands that bring those files back to their pre-run contents. Outside git, or with `workspaceAudit: false`, only the pre-execution guard applies. Violation events identify every backlog task whose file area contains the path.
Ownership accepts concrete repository-relative files and recursive directory areas: `src/`, `src/**` and `src/**/*` all canonicalize to `src/` before overlap validation and write auditing. Other glob patterns are rejected during backlog validation rather than misinterpreted as literal file names.
Each worker assignment has a soft model-request budget (`limits.assignmentRequests`, default 150; 0 disables). When the budget is reached, the worker gets a wrap-up notice. At 1.5× the budget its turn is stopped and it is asked once to report what it has, partial or `blocked`. If it is still running 5 requests later without a RESULT, the assignment fails. A request that already calls `report_result` is never cut off.

Configure run limits with the top-level `limits` object in `orche.config.json` (time values are **milliseconds**):

```json
"limits": { "overallMs": 3600000 }
```

Defaults: overall 3600 seconds, exploration 1200 seconds, assignment/result wait 3600 seconds, coordinator decision 1800 seconds. Precedence is hardcoded defaults < `routes/config.limits` < programmatic `RunOptions.limits`, for the CLI, `/orche multi`, `orche_run` and direct API (also the evaluation baseline). Explicit values are merged first; only missing `explorationMs`, `assignmentMs` and `decisionMs` derive from the effective `overallMs` at one third, all, and one half respectively. For example, `overallMs: 120000` derives 40000/120000/60000; an explicit config `decisionMs` survives an API overall override unless the API also overrides that cap.

These are ceilings, not additive time slices: every wait is clamped to the remaining overall budget, and messages do not reset deadlines. Time **0 is not unlimited**; it gives no waiting budget. Only `assignmentRequests: 0` disables the request budget. `maxFixRounds` (default 1), `decisionRepairs` (default 2, maximum 2) and `assignmentRequests` (default 150) may also be configured; counts must be non-negative integers (request counts safe integers), times finite non-negative numbers, and unknown fields are rejected. All sessions are disposed in `finally`. Pi abort requires tool cooperation; arbitrary JavaScript tools ignoring abort cannot be forcibly killed by this wrapper. There is no provider fallback. Reload the Pi extension to use changed code defaults; an already-running invocation retains its existing limits.

The orchestrated run's deadline starts before runtime/provider/session preparation and stays active through phases, owned Git auditing, final audit and teardown. Cancellation fences new assignments, RESULT/NOTE side effects and guarded tool calls; late-created sessions/providers are disposed, and losing promises are observed. Owned Git children receive the run AbortSignal (also a 30s per-call safety timeout; advisors retain 5s). Cleanup waits use only the real remaining budget, **no extra grace**; `RunReport.cleanup` lists incomplete/pending cleanup, so a final workspace snapshot is not claimed complete when work is pending. `timeouts` and `run_timeout` events identify overall versus phase caps, stage/phase, elapsed/configured/effective milliseconds and available worker assignment/task/request/activity metadata, never prompts. Manual cancellation remains `cancelled`. These are bounded asynchronous waits, not hard process isolation: synchronous JS/event callbacks and uncooperative SDK/tool work cannot be forcibly stopped in-process; pending work may outlive the report. Do not reuse a workspace with pending work until it settles. Extension config discovery happens before the run deadline; runtime creation happens inside it. The old 600s caller budget persists until extension reload; raising configuration alone does not establish why earlier hangs occurred.

### Install into Pi

```sh
pi install /path/to/pi-orche     # after `npm install` here; uninstall with: pi remove /path/to/pi-orche
```

Every normal `pi` session then has anchored `read`/`edit` (replacing Pi's), `find`, `ast_search`, `ast_rewrite`, `diagnostics`, `grep`, `ls`, long-output spill and a **delegation mode** (`mainMode`, default `auto`): `auto` removes `edit`/`write`/`ast_rewrite`, restricts Bash to static inspection and trusted project checks, and lets the main choose `orche_task` (one reusable worker) or `orche_run` (multi) per request; `single` additionally disables `orche_run`, `multi` disables `orche_task`, and `direct` disables both delegation tools and permits direct edits (a guard against habitual edits, not a sandbox). **Breaking change:** the old `single` behaviour is now `direct`; an existing `"mainMode": "single"` now selects single-worker delegation, and the default was `multi`. `/orche single <PROMPT>` and `/orche direct <PROMPT>` override the current session's mode for one turn; `/orche multi <PROMPT>` runs the orchestrator and posts its result; `/orche workers` lists live workers, `/orche stop <id>|all` disposes them, and `/orche cancel` stops the active task or multi run. Invalid forms print `Usage: /orche single|multi|direct <PROMPT> | /orche mode [auto|single|multi|direct] | /orche workers | /orche stop <id>|all | /orche cancel` and start nothing. Both delegation tools need a self-contained `request` (they do not see the conversation) and accept optional `context`; routing comes from `.pi/orche.config.json`, `~/.pi/agent/orche.config.json`, or the session's current model. Details, busy rules, worker lifetime and the auth model: [docs/pi-package.md](docs/pi-package.md).

In `auto`/`single`/`multi`, PowerShell is unsupported until it has a dedicated parser. Bash rejects bare globs, variables and substitutions; quote literal patterns (for example `find . -name '*.ts'`). `npx`/`bunx` runners require `--no-install` (for example `npx --no-install vitest run`); this is not a containment or executable-provenance guarantee. Permitted tests/linters can execute project configuration and create generated files, caches or reports. Policy acceptance does not guarantee a successful CLI invocation.

### Concurrent pi sessions

It is common to have several `pi` sessions open on one repository, or on its superproject (this repository is a submodule of its parent) or one of its submodules. Their edits and commits can land while an `orche_run` or `orche_task` is working. When a run or task **starts**, orche looks for other pi sessions that were written recently and whose working directory is inside the run's git toplevel, inside its superproject chain (`git rev-parse --show-superproject-working-tree`), or inside a submodule of those. If it finds any it does not block anything: the tool result starts with a warning such as

```
⚠ 2 other pi sessions active in this repository (cwd /work/repo, /work/repo/packages/a, last write 12s ago); their changes are classified as external where possible
```

and an `orche_run` is flagged as having concurrent activity. In `change`/`diagnose_fix` runs of a flagged run, a file that changed while a worker's bash command was in flight, that is not in that worker's ownership and that no worker `edit`/`write` call wrote is reported as `external` (reason `concurrent session active; ambiguous`) instead of as an ownership violation. Writes through worker `edit`/`write` outside ownership remain violations either way, and without concurrent sessions the audit is as strict as before. Detection is repeated while the work goes on: an `orche_run` asks again at each workspace audit point and an `orche_task` when it ends, answered from a cache for at least 30 seconds in between, so a session that starts mid-run is taken into account too (a progress warning appears the first time one shows up); a repeated detection that fails keeps what was already known.

Detection reads pi's session store only: it stats `<sessions dir>/<encoded cwd>/*.jsonl` (at most 2000 files, newest names first), reads just the first line of files written inside the window, ignores the current session, and spawns git for the run's own directory and for a few candidates whose path it cannot place. The sessions directory is `PI_CODING_AGENT_SESSION_DIR` when set, otherwise `<agent dir>/sessions` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Any error (missing or unreadable directory, malformed files, no git repository, a timeout of 5 seconds) means "no concurrent sessions" and no warning. A session that was closed within the window still counts, and sessions in another worktree of the same repository do not.

Configure it with the top-level `concurrentSessions` object of the Pi agent or trusted project `orche.config.json` (not in a file passed to the CLI's `--config`):

```json
"concurrentSessions": { "enabled": true, "windowMinutes": 10 }
```

`enabled` (default `true`) switches detection and the warning off with `false`; `windowMinutes` (default `10`, a number greater than 0 and at most 1440) is how recently a session file must have been written to count as active. Unknown fields and values of the wrong type are rejected like the other settings.

### Run records

The sessions orche starts itself (the coordinator, every worker and verifier, advisor calls, and the persistent `orche_task` workers) used to live in memory only, so afterwards there was no way to see what a worker did, which model each role really used, how many requests each made, or what a failed run cost. Now every `orche_run` and `orche_task` leaves a **record**, by default under `<agent dir>/orche/records/` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — outside pi's own `sessions/` directory, so it never shows up in `/resume` or in concurrent-session detection, and never inside the workspace:

```
<records root>/<parent session id | no-session>/
  <ISO timestamp>_<run|task>-<short id>/
    run.json        manifest, written when the run starts (status "running") and rewritten when it ends — done, failed or cancelled
    events.jsonl    the orche_run event stream, one bounded JSON object per line
    sessions/       one regular pi session JSONL per agent: coordinator.jsonl, A1.jsonl, V1.jsonl, advisor-<name>-<n>.jsonl, ...
  workers/<worker id>-<spawn timestamp>.jsonl   an orche_task worker: one stable session file across all its assignments
```

`run.json` holds the kind (`run`/`task`), the request and context as given, the working directory, the calling pi session (id and file), where the routes came from, the model and thinking level per role, start/end/duration, status, summary or failure, one entry per agent (`id`, `role`, `model`, `thinking`, `requests`, the models that actually answered, `durationMs`, `status`, `sessionFile`), the workspace changes / external changes / ownership violations, and the cleanup result. The session files are normal pi session files (`{"type":"session",...}` header, then messages), including the system prompt each agent ran with; one that was cut off by a cancellation or timeout keeps what was written and ends with an `orche:disposed` marker. Every `orche_run` / `orche_task` result carries one line `Record: <directory>` and `details.record` (error results too), and `/orche records` lists the last ten records of the current pi session (time, kind, status, summary, path).

Transcripts can contain whatever tool output contained, including secrets, so directories are created `0700` and files `0600`. Writing is best effort: a records directory that cannot be created or written never fails a run or task, the sessions then simply stay in memory. The `orche_run`/`orche_task` code paths of the extension record by default; the eval and benchmark runners (`src/eval/`, `runOrchestrated`/`createSession` used as a library) write nothing unless the caller passes `records` / `sessionDir` / `sessionFile` explicitly (`PiRunnerOptions.recordsDir` for the Pi eval runner).

Configure it with the top-level `records` object of the Pi agent or trusted project `orche.config.json` (not in a file passed to the CLI's `--config`):

```json
"records": { "enabled": true, "dir": "/home/me/orche-records", "retentionDays": 30, "maxBytes": 1073741824 }
```

`enabled` (default `true`) switches recording off with `false`. `dir` (absolute, or starting with `~/`; default `<agent dir>/orche/records`) moves the root; a directory inside the run's workspace (or one that contains it, the filesystem root or the home directory) is refused and records are then off for that run. `retentionDays` (default `30`, a number greater than 0 and at most 3650): when the first run of a process starts, record directories and worker session files that have not been modified for that long are deleted. `maxBytes` (optional, a positive integer): after that, the oldest remaining records are deleted until the root fits. The cleanup only ever touches names orche created (`<timestamp>_<run|task>-<id>` directories and `workers/<id>-<timestamp>.jsonl`) inside the records root, never follows symlinks, never deletes anything written in the last hour, is bounded in entries, deletions and time (3 seconds), and ignores errors. Unknown fields and values of the wrong type are rejected like the other settings.

### Commits and pushes from `orche_task`

In `auto`/`single` the main session cannot run `git commit` or `git push` itself, and workers never commit unless the assignment says so. `orche_task` therefore takes an optional per-assignment grant:

```json
{ "role": "implement", "request": "…", "files": ["src/a.ts"], "git": { "commit": true } }
{ "role": "implement", "request": "…", "git": { "push": true, "remote": "origin", "branch": "main" } }
```

`commit` allows `git commit`; `push` allows `git push` and implies `commit` (`push: true` with `commit: false` is an error); `remote` and `branch` name the push target and need `push` (a `branch` alone means `origin/<branch>`, a `remote` alone pushes the current branch to it, and with neither the current branch goes to its upstream). Only `implement`, `game-asset` and `video` accept `git`; `explore`, `answer` and `verify` reject it with an error. The main agent is told to set it only when the user explicitly asked to commit or push in this conversation, and to scope the commit to the task's `files`.

The grant is per assignment. Task workers are told to commit only when the current assignment authorizes it, and every assignment prompt (new or reused worker) ends with either an authorization line (stage paths explicitly, no `git add -A` of unrelated files, no force-push, history rewrite or git config change) or `Git commit/push is NOT authorized for this assignment; do not commit.` `orche_run` workers are unchanged: they never commit, and the run audit relies on that to tell a commit made elsewhere from their own work.

With a grant the result also reports, read-only and bounded, what happened in the task's directory: the commits created since the task started (`git log --oneline`, at most 20 listed, plus the true count), submodule gitlinks those commits changed, and whether a push was detected. A push is detected when a remote-tracking ref (the upstream, or the granted `remote/branch`) moved to a commit now contained in HEAD; this sees only pushes that update that ref, so "not detected" is not proof that nothing was pushed. The same data is in `details.git`. Outside a git work tree the report says it is unavailable.

## Architecture

- `src/pi/`: Pi session factory and runtime adapter; persistent contexts, lifecycle events, abort and context-only messages. Sessions are in memory unless given a `sessionDir`/`sessionFile` (see Run records).
- `src/agent/`: AgentManager; assignment epochs, exactly-once outcomes, NOTE inbox, direct peer messaging, shared authenticated runtime, per-agent manifest entries (`agentRecord`) and the neutral records hooks (`records.ts`: `SessionRecords`, `SessionTarget`) that `RunOptions.records` and `AgentManagerOptions.records` use.
- `src/messaging/`: typed NOTE / REDIRECT / STOP messages and process-local ID deduplication.
- `src/orchestration/phases.ts`, `backlog.ts`, `routing.ts`: pure transitions, proposal deduplication, ownership/dependency validation and model routing.
- `src/orchestration/coordinator.ts`: `runOrchestrated`, the run setup/teardown and class dispatch. The phase flows are in `src/orchestration/run/`: `answer.ts`, `diagnose.ts` (planned explorers, convergence, proposals) and `change.ts` (backlog execution, replan, verification and fix rounds), plus `decisions.ts` (coordinator session, structured decisions with bounded repair), `context.ts` (events, time caps, spawning, outcome waits, write guard), `audit.ts` (workspace audit) and `types.ts`.
- `src/orchestration/prompts.ts`, `events.ts`, `team.ts`, `ownership.ts`, `workspace.ts`, `result-schemas.ts`: worker protocols, the shared event contract, team settings, the ownership rules, git snapshots and RESULT data contracts.
- `src/advisor/`: configurable multi-advisor (triggers, domains, budgets) with the OMP plan-review and verification-audit roles as presets; see [docs/advisor.md](docs/advisor.md).
- `src/extension/`: the Pi package entry (`/orche`, `orche_run`, `orche_task`, tool replacement, spill hook), delegation modes, config discovery, the shared task/run controller, the persistent single-worker pool and the run records (`records.ts`: layout, `run.json`, `events.jsonl`, retention); see [docs/pi-package.md](docs/pi-package.md).
- `src/eval/`: visible-only problem-A workspaces, isolated hidden grading, fork-join baseline, metrics and benchmark runner. Hidden grading data never enters worker prompts or workspaces.
- `test/`: pure tests plus deterministic real-AgentSession faux-provider lifecycle and coordinator regressions.

Every phase change goes through the pure `transition()` function. Classification selects one of these paths:

| Class | Workers and phases | Result |
| --- | --- | --- |
| `answer` | 1–max read-only analysts; `EXPLORE → DONE` | Evidence-backed explanation, analysis or review; no implementation or verification assignments; no authorized writes. |
| `change` | 1–max implementers; `EXPLORE → BACKLOG → EXECUTE → VERIFY → DONE` | Direct canonical backlog; no root-cause exploration/proposals. A trivial one-line edit uses one implementer. |
| `diagnose_fix` | 1–max explorers; `EXPLORE → CONVERGE → BACKLOG → EXECUTE → VERIFY → DONE` | Early root-cause acceptance, preemption, proposals and reused worker implementation. |

Failed verification returns to `BACKLOG` within the fix cap. When implementation tasks report `blocked`, the coordinator is asked to `replan` or `fail`, again within the fix cap; past the cap the run fails with the blocked reasons and the coordinator is not asked. A replan returns to `BACKLOG` with the blocked reasons and counts as a fix round, and a `fail` keeps the workers' reasons in the summary. A ready task whose owner is still settling an interruption waits for it instead of failing the backlog. The verifier runs `verifyCommands` from the config when set (e.g. `["npm test"]`); otherwise it discovers the project's own checks (package scripts, Makefile, pyproject, Cargo, go.mod, CI). An invalid exploration plan is repaired like other decisions, with bounded feedback, and an identical decision schema is not resent to the persistent coordinator session. Workers never co-edit a shared backlog document; the coordinator owns its validated canonical backlog. Shared files belong to one worker, and dependencies are dispatched only after predecessors finish.

Backlogs require regression coverage; documentation tasks are proposed only when the user's problem requests them. Implementation interface NOTES target only dependent owners on other workers, never the sender itself.
Worker RESULT payloads are checked against a per-kind `data` contract inside `report_result` (`src/orchestration/result-schemas.ts`): `backlog_proposal` and `verify` (`passed: boolean`) are required, `explore` and `implement`/`fix` (`status: "done" | "blocked"`) are optional, `answer` is free. The task specialists `game-asset` and `video` require `status: "done" | "blocked"` and `outputs: [{path,type,spec}]` (non-empty descriptive strings), with optional `reason` and `evidence`. An invalid payload is rejected as a tool error with the validation errors and the expected shape, and the worker corrects it in the same turn, with no new assignment. After 3 corrections the 4th invalid payload fails the assignment, and the failure summary includes the validation errors. Each rejection emits a `result_rejected` event.
`report_result.kind` must exactly match the current assignment kind, even without a data schema. A mismatch names expected/received kinds and shares the same bounded correction budget as invalid data; identity stays unchanged, and only the first valid accepted result wins. New/redirected assignments reset that budget.

## Advisors

`advisors` in `orche.config.json` configures any number of advisory reviewers. Each has `domains` (what to look at: `plan`, `verification`, `correctness`, `security`, `performance`, `tests`, `scope`, `docs`, or your own `{id, instructions}`), `targets` (who receives the advice: `coordinator`, `workers`, `role:<role>`, `agent:<id>`), `triggers` (`coordinator_decision`, `assignment_started`, `assignment_result`, `turn_end` every N, `tool_error`, `interval`, `before_complete`) and finite budgets (`cooldownMs`, `maxCallsPerRun`, `maxCallsPerTarget`). An advisor call is a short read-only session on the `advisor` route that answers `ok`, `concern` or `blocker`; `ok` injects nothing, anything else becomes exactly one NOTE from `advisor:<name>` to the target. Advisors are advisory only: they never redirect, stop or gate; calls run beside the workers, and only `await` decision triggers and `before_complete` make the coordinator wait (and reconsider at most once). The two OMP roles ship as presets `plan-review` and `verification-audit`, both disabled; set `"enabled": true` to turn one on. Full schema, preset definitions and semantics: [docs/advisor.md](docs/advisor.md).

## Message semantics

- **NOTE**: information only. A worker calls `send_message` directly to a relevant peer or `main`; recipient tool work is not cancelled and no new turn is forced. Sender-framed context is delivered at Pi's safe boundary. A strong cause uses signal `root_cause_found` immediately, before RESULT.
Main-inbox NOTES received after exploration are buffered and included once, with sender/content/signal, in the next coordinator decision context rather than discarded by outcome waits.
- **REDIRECT**: coordinator-only abort plus a new assignment on the same session. The superseded assignment has exactly one outcome; retained context survives.
- **STOP**: explicitly ends unnecessary work; session disposal is separate.
- **RESULT**: worker calls `report_result` alone. First accepted result wins; a result rejected by the kind's data contract does not count and does not end the turn. Lifecycle settlement delivers its outcome separately from message delivery. Completed implementation/fix outcomes finish their task unless the worker explicitly reports `data.status: "blocked"`; blocked runs retain the worker's reason in the failure summary.

For an isolated check: `npx vitest run test/orchestration`. Regressions exercise real AgentSessions with faux providers, including read-only English/Korean answers, direct trivial changes and actual Node verification, variable worker counts, early NOTE convergence, dependency ordering/context retention, proposal repair, main-inbox NOTE delivery, invalid decisions, timeout failures and disposal. Live MVP and benchmark evidence is under `results/` (local only: not versioned, so paths cited in `docs/` exist only where those runs were made); Pi experiment observations are in `docs/pi-sdk-findings.md`.
