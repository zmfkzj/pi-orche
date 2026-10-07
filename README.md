# pi-orche

A [Pi](https://github.com/earendil-works/pi) package that keeps the main session's context small by handing work to one worker at a time, and lets that worker split the task only when it pays off.

- **`single`** (default delegation mode): main clarifies the request into numbered requirements and hands it to one `orche_task` worker. For an `implement`/`answer` task that worker is the **orchestrator**: it decides whether the task needs splitting by three criteria (Parallelism, Isolation, Independent verification), does the work itself by default, and starts sub-workers with `orche_spawn` only when a criterion clearly holds (parallel independent parts, a game-asset/video specialist or separate checkout, a fresh verifier). It reports back to main, which reviews the report.
- **`direct`**: main works with its own tools, like plain Pi.
- **Light requests**: a quick question or a one-line edit does not need a worker. Use `/orche direct <PROMPT>` for that one turn (or `/orche mode direct` for a while); handing it to a worker costs an extra hand-off for no benefit.

Design, measurements and the reasons behind it: [docs/orchestrator.md](docs/orchestrator.md). The Pi package in detail: [docs/pi-package.md](docs/pi-package.md). Earlier designs (the multi-worker coordinator `orche_run`, advisors, workflow policies, the v2 pipeline) were removed; their documents under `docs/` are kept as history.

### Install into Pi

```sh
pi install /path/to/pi-orche     # after `npm install` here; uninstall with: pi remove /path/to/pi-orche
```

Every normal `pi` session then has anchored `read`/`edit` (replacing Pi's), `find`, `ast_search`, `ast_rewrite`, `diagnostics`, `grep`, `ls`, long-output spill and a **delegation mode** (`mainMode`): `single` (default) removes `edit`/`write`/`ast_rewrite`, restricts Bash to static inspection and trusted project checks, and delegates each task to one reusable `orche_task` worker; `direct` edits with the main's own tools. In `direct` the user is warned when the main context crosses 50%/75% of the window (configurable with `contextWarning`), the point to switch back with `/orche mode single`. `/orche single <PROMPT>` and `/orche direct <PROMPT>` override the mode for one turn; `/orche workers`, `/orche stop <id>|all`, `/orche records`, `/orche splits [days]` (the orchestrator's split decisions over all sessions, from the split log), `/orche models` (the main, orchestrator and worker models and where each comes from), `/orche cancel` and `/orche detach` manage workers; `orche_task` runs in the background in interactive/RPC sessions (attached until new input detaches it; see Background tasks below). **The `auto` and `multi` modes, the `orche_run` tool and `/orche multi` were removed:** benchmarks showed the multi-agent orchestrator no more accurate than one worker at about twice the cost; the coordinator, its CLI and `runOrchestrated` followed in 0.2.0. A config or saved choice of `auto`/`multi` is read as `single` with a warning. Details: [docs/pi-package.md](docs/pi-package.md).

In the **single workflow** (`single`), main first classifies the message by **work type** (`src/single/work-types.ts`): *respond* (only restate or reformat its previous reply: answered directly), *investigation* (information only: `answer`), *execution* (a requested or authorized change, an approved proposal, or a bare bug report to diagnose and fix: `implement`) or *creation* (open-ended creative artifacts: `game-asset`/`video`, else `implement`). It then analyses the user's intent, purpose and requirements and hands off **one end-to-end assignment per round**. The request contains Intent/Purpose, testable numbered requirements as lines **`R1: …`**, constraints/non-goals, explicit assumptions when there is no UI, and a final **Original request** section with the user's text **verbatim**. Standard roles (`explore/answer/implement/verify`) receive **`task_plan`** and compact above **50%** context; specialists and library-run workers keep ordinary tools/compaction behaviour. The worker builds a bounded sequential DAG (1–60 nodes, title ≤200 characters, note ≤500), then implements, tests and checks without main intervention. Unknown coverage ids are rejected; uncovered request ids warn. Plans reset each assignment; reporting without one is allowed but notes **no Task DAG recorded**, with no `details.plan`. Standard roles inherit main's **current model and thinking at hand-off**, including extended context, unless `models.orchestrator` sets their model (below); specialists keep routes. Unresolvable main models fall back to routes visibly; absent main models warn and keep an existing worker's model/effort, or use routes for a new worker. Compaction restores requirements, original request and that assignment's DAG verbatim under a historical label, **superseded by any later Assignment message**; reused prompts explicitly supersede previous ids/plans.

Main reviews the result's **checklist** (`met|unmet|partial` plus evidence per R-id), the checks the worker names and the readings it chose, checks those readings against the user's wording, and sends corrected/additional requirements to the **same `worker`**. It does not re-read the changed code or re-run checks itself: in benchmarks of 48 tasks per arm this kept quality (48/48 vs 46/48) at 0.41× the main context and 0.97× the cost (the `single.mainReview` setting is gone; this is the only behaviour). Only requirement declarations at line starts (`R1:`, `R1.`, `R1)`, `R1 -`) outside the original-request section make a checklist mandatory for implement/answer; incidental prose/path ids do not. After an item remains unmet/partial for **two consecutive assignments of that worker**, hand **only the unmet items** to a **new worker** (omit `worker`) with file references and previous evidence. Streaks are per worker and reset when an item is met, omitted, renamed or textually revised, or an assignment fails. An independent review the user asks for up front goes into the request (the orchestrator runs it, below); a separate `verify` assignment after a result requires an explicit user request. Single never stops for a mode switch.

**Task ledger (opt-in, `"single": { "ledger": true }`).** Each single-workflow task keeps a ledger outside every LLM context: the user's original requests, every assignment's requirements with the status the worker last reported, the readings it chose for ambiguous requirements, and a short history. Results name the task (`Task ledger T1, assignment 2: …`); pass that id in `task` for follow-ups of the same task, also when another or a new worker takes it over, and omit it for a different task, which then gets its own ledger even on a reused worker. The ledger is saved as small `orche-ledger` event entries (one per hand-off, result or failure; not sent to the model; they follow forks and are replayed after a reload). A worker that compacts gets its task's ledger back next to its verbatim assignment, the main session gets a short ledger summary after its own compaction, and a task whose worker is gone (reload, idle expiry, pool eviction) continues with a new worker briefed from the ledger. Off by default; see [docs/specialist-orchestration.md](docs/specialist-orchestration.md).

**Orchestrator (`single.spawn`, default on).** The `implement`/`answer` worker of the single workflow is the task's **orchestrator** ([docs/orchestrator.md](docs/orchestrator.md)). Before it works it checks three criteria and, by default, does **not** split: **Parallelism** (two or more parts that need none of each other's results, write disjoint files and are each substantial, roughly ten minutes or more), **Isolation** (a part needs another environment or tool set: a game-asset/video specialist, or a separate checkout) and **Independent verification** (the user explicitly asks for it, or a wrong result would be irreversible or costly and the project's tests cannot establish correctness). When one clearly holds it calls **`orche_spawn`** `{reason, workers:[{name, role, request, files}]}`: up to 4 sub-workers in fresh one-shot sessions at the same time; the call returns when all have reported. Sub-workers see only their own request, cannot spawn (depth 1: no `orche_spawn` in their sessions, and their guard refuses it), and standard roles run on `models.worker` when it is set, otherwise on the orchestrator's current model and thinking, while `game-asset`/`video` use their own routes (with `generate_image` when images are configured). Writers must own files; overlapping ownership refuses the call, every write outside a sub-worker's own files (a sibling's included) is blocked, and a workspace diff around the call warns about changes outside every owner's files. A `verification` call takes role `verify` only: a fresh read-only verifier that never saw how the work was done. The orchestrator then reviews the reports, runs the checks itself and reports one result with `data.split` (`{decision: "none"|"split", criteria, reason}`; required and checked once it spawned); the result shows a `Split:` line and the sub-workers (`details.split`, `details.spawned`; records list them as agents with their transcripts and a `spawn` event). The split instruction is the variant a pre-registered one-turn evaluation chose (45 labelled tasks: 98.9% correct, 0% unnecessary splits on claude-opus-5-5; the three questions alone split 24% of tasks that should not be split). A second pre-registered evaluation (labels by measured work size, judged after reading the repository through the product prompt) kept it. End to end it left small independent tickets (1–3 minutes each) unsplit, and on three independent 15–25-minute ports it did not split either; a split run of that task finished 11% sooner at 1.6× the cost. An explicit user request for parallel workers or an independent review is followed ([docs/orchestrator.md](docs/orchestrator.md) 6–9). The orchestrator is not told it "works alone" (that line made gpt-6.1-sol refuse valid splits). `"single": { "spawn": false }` keeps the earlier single worker exactly. **Removed:** the single pipeline v2 (Framer, risk-gated Verifier, `code_nav` registration), the workflow policies (investigation critic, creation divergence; `orche_task` `type`/`candidates`/`then`) and `single.mainReview`; their config keys (`pipeline`, `frame`, `checker`, `nav`, `mainReview`, `investigation`, `creation`) still load, are ignored and produce a warning.

**Model tiers (`models`).** `main`, `orchestrator` and `worker` can each get their own model in `orche.config.json`, with the fields of a route (`model`, optional `thinking` and `extendedContext`). Every tier is optional and an unset tier inherits as before, so a config without `models` behaves exactly as earlier versions:

```json
"models": {
  "main": { "model": "provider/model-a", "thinking": "high" },
  "orchestrator": { "model": "provider/model-b", "thinking": "high" },
  "worker": { "model": "provider/model-c", "thinking": "medium" }
}
```

- `main` is the Pi session's own model. Orche sets it with Pi's extension API (`pi.setModel`, `pi.setThinkingLevel`, for the current session only, so Pi's `settings.json` default stays) when a fresh session starts: at Pi start-up and at `/new`, on a session without messages. A resumed, forked or reloaded session keeps its model, `--model`/`--models`/`--provider`/`--thinking` on the command line win, and a model you pick during the session (`/model`, the cycle keys) is never put back. It must be a model Pi lists in `/model`; one Pi does not know, or without credentials, is a warning and the session keeps its model. In `direct` mode only `main` matters.
- `orchestrator` is the model of the single workflow's standard-role worker (`explore`/`answer`/`implement`/`verify`; the orchestrator); unset, it inherits main's current model and thinking at each hand-off. `worker` is the model of the orchestrator's `orche_spawn` sub-workers, the fresh verifier included; unset, they inherit the orchestrator's model and thinking. A tier without `thinking` takes the thinking of the tier above it; without `extendedContext` it takes the top-level `extendedContext`.
- `{ "model": "main" }` in `orchestrator` or `worker` says so explicitly: that tier runs on **main's current model and thinking** at each hand-off, as before. With `thinking` it keeps main's model but uses that thinking level, e.g. `{ "model": "main", "thinking": "medium" }`. For `worker` it means main's model, not the orchestrator's: with `"orchestrator": { "model": "provider/model-b" }` and `"worker": { "model": "main" }` the orchestrator runs on model-b and its sub-workers on main's model. A real model id always has the form `provider/id`, so `main` cannot be mistaken for one. `extendedContext` does not go with `"main"` (main's model comes with main's context window), and `models.main` cannot be `"main"`; both are config errors.
- `"thinking": "main"` in `orchestrator` or `worker` keeps the tier's own model but takes **main's current thinking** at each hand-off (orchestrator) or spawn (worker), so `/thinking` or the cycle keys in main control the effort of a different model, e.g. `"orchestrator": { "model": "cliproxyapi/gpt-6.1-sol", "thinking": "main" }`. In `worker` it is main's thinking, not the orchestrator's. A model without that level runs the nearest one it supports (Pi's clamp; a non-reasoning model runs `off`), and the level actually used is recorded. `{ "model": "main", "thinking": "main" }` is the same as `{ "model": "main" }`. In `routes`, `default` and `models.main` it is a config error. Without `thinking` nothing changes: the orchestrator follows main's thinking, sub-workers the orchestrator's.
- `game-asset` and `video` (as `orche_task` roles and as sub-workers) keep their own routes; `models` does not change them.
- A configured orchestrator or worker model that orche's own runtime cannot resolve is replaced by the inherited one, with a warning in the task result (right below its first line) and in `run.json`. For `"main"` that means main's model: an orchestrator then falls back as without `models`, sub-workers to the orchestrator's model.
- `run.json` records the model of every assignment with `modelSource` (`config`, `config:main`, `main` or `route`) and each sub-worker's (`config`, `config:main`, `orchestrator` or `route`); `config:main` is main's model named with `{ "model": "main" }`, `main` and `orchestrator` are inheritance from an unset tier. The split log records them too (`modelSource`, `workerModels`). Next to each model, `thinking` is the level actually used and `thinkingSource` where it came from, with the same values (`config:main`: main's current thinking named with `"thinking": "main"` or a level-less `{ "model": "main" }`). `/orche models` shows the three tiers now, where each comes from, and which tiers main's current thinking reaches. Details: [docs/orchestrator.md](docs/orchestrator.md) 12.

`read` uses four-hex anchors (`N#abcd|text`, blank lines `N|text`), with old 16-hex anchors still accepted. Earlier-read anchors can map across your own `edit` calls; edit echoes are compact and syntax feedback is advisory. JS/TS/Markdown reads support `outline: true` then `symbol` for targeted inspection. Bash test/compiler/linter output and repeated grep paths are reduced with recoverable full-output artifacts; other tools keep generic spill and `read` remains exempt. Details and thresholds: [docs/tools.md](docs/tools.md).

**Pass references, not copies** in delegation `request`/`context`: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text), never whole files, diffs or long logs. Worker reports start with a 1–3 sentence conclusion, then `path:line` evidence and command outcomes; full answer summaries remain complete without long source quotes.

Reused `orche_task` workers clear large earlier tool outputs at assignment starts once newly clearable output reaches ~10,000 estimated tokens. Calls/arguments, small results and prompts remain; placeholders retain artifact paths so a worker can repeat the call. Reasoning after the earliest newly cleared result is omitted for signature safety, with matching Responses item IDs dropped while call pairing remains intact. The cumulative request-only projection changes only at boundaries with new clears; raw transcripts stay complete. Configure `"taskContext": { "clearBetweenAssignments": true, "minClearTokens": 10000 }` in the trusted project or user config; changes apply to the next task. `false` means **no new clears**: an existing projection stays applied unchanged until compaction resets it, while a never-cleared worker stays unprojected. Compaction discards all index-based projection state; no projection is applied mid-assignment afterward, and the next assignment plans afresh on the compacted transcript. Other sessions do not project context.

In `single`, PowerShell is unsupported until it has a dedicated parser. Bash rejects bare globs, variables and substitutions; quote literal patterns (for example `find . -name '*.ts'`). `npx`/`bunx` runners require `--no-install` (for example `npx --no-install vitest run`); this is not a containment or executable-provenance guarantee. Permitted tests/linters can execute project configuration and create generated files, caches or reports. Policy acceptance does not guarantee a successful CLI invocation.

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

Changing a reused worker's image capability/configuration starts a fresh worker so tools and old raster instructions cannot leak into other roles. Normal reuse is unchanged when images are unset.

Each worker assignment has a soft model-request budget (`limits.assignmentRequests`, default 150; 0 disables). When the budget is reached, the worker gets a wrap-up notice. At 1.5× the budget its turn is stopped and it is asked once to report what it has, partial or `blocked`. If it is still running 5 requests later without a RESULT, the assignment fails. A request that already calls `report_result` is never cut off.

Configure run limits with the top-level `limits` object in `orche.config.json` (time values are **milliseconds**):

```json
"limits": { "overallMs": 1800000, "extensionMs": 1800000, "maxExtensions": 10, "activityWindowMs": 120000 }
```

Defaults: overall 1800 seconds (30 minutes), exploration 600 seconds, assignment 1800 seconds; extension 1800 seconds, at most 10 extensions (a 5 h 30 min hard ceiling: 30 min + 10 × 30 min), activity window 120 seconds (see below). Precedence is hardcoded defaults < `config.limits`. Explicit values are merged first; only missing `explorationMs`, `assignmentMs` and `decisionMs` derive from the effective `overallMs` at one third, all, and one half respectively. For example, `overallMs: 120000` derives 40000/120000/60000; an explicit config `decisionMs` survives an API overall override unless the API also overrides that cap.

**Activity-aware timeouts.** `overallMs` and the caps derived from it are the *base* deadline of one `orche_task` assignment. When a deadline expires while the work is still actively working, it is extended instead of timing out: `extensionMs` (default `1800000`, 30 minutes) is added, at most `maxExtensions` times (default `10`; a non-negative integer, `0` turns extension off). "Actively working" means that, within the last `activityWindowMs` (default `120000`, 2 minutes) before the deadline, the worker produced model output, started or finished a tool, streamed tool output or had a progressing command (a long `bash` counts only while it shows output or CPU/IO progress), or has a model request or a non-bash tool in flight within its bound. The budget belongs to one assignment and is **shared by all of its deadlines**, so an assignment lasts at most `overallMs + maxExtensions × extensionMs` (30 minutes + 10 × 30 minutes = 5 hours 30 minutes with the defaults). A phase cap whose extension would reach past the current overall deadline extends the overall deadline too, and that counts as one extension, not two. An assignment that is idle at its deadline, or has used all its extensions, times out exactly as before, and the timeout message says why it was not extended: `not extended: no activity in the last 2m` or `extension budget 10/10 used`. User cancellation always wins at once, also while an extension would have been granted. Every extension is reported: a `deadline_extended` event (`events.jsonl` of the task record), a progress line such as `⏱ timeout extended 1/10 (+30m): W2 bash running 12m, cpu progressing`, the extension list in `run.json` and in the tool result (`extensions`).

**Changing timeout extension.** Both knobs live in the `limits` object of the orche config file, next to the `routes` that file already has (times in **milliseconds**):

```json
{ "limits": { "maxExtensions": 5, "extensionMs": 600000 } }
```

- `maxExtensions`: how many times an expired deadline may be pushed out while the work is still active. A non-negative integer; default `10`; `0` turns extension off.
- `extensionMs`: how far each extension pushes the deadline, in milliseconds; a finite non-negative number; default `1800000` (30 minutes).
- Hard ceiling of one `orche_task` assignment: `overallMs + maxExtensions × extensionMs` (an assignment uses `assignmentMs`, which defaults to `overallMs`). The example above gives 30 min + 5 × 10 min = 80 min; the defaults give 30 min + 10 × 30 min = 5 h 30 min.
- Where: the **project** file `<project>/.pi/orche.config.json` (only when Pi trusts the project) wins over the **user** file `<agent dir>/orche.config.json` (`~/.pi/agent/orche.config.json`; `PI_CODING_AGENT_DIR` is honored). The first file that exists is used as a whole, keys are not merged between the two: a project file without `limits` means the defaults, not the user file's `limits`.
- The file is read at the start of every `orche_task` call, so an edit applies to the next call without reloading Pi; a call that is already running keeps its limits. A bad value (`maxExtensions: 1.5`, a negative number, an unknown key) is an error such as `config.limits.maxExtensions: expected a non-negative integer (0 disables extensions)`, and nothing starts.

These are ceilings, not additive time slices: every wait is clamped to the remaining overall budget (the current, possibly extended, overall deadline), and messages do not reset deadlines. Time **0 is not unlimited**; it gives no waiting budget. Only `assignmentRequests: 0` disables the request budget (and `maxExtensions: 0` the timeout extension). `maxFixRounds` (default 1), `decisionRepairs` (default 2, maximum 2), `assignmentRequests` (default 150) and `maxExtensions` (default 10) may also be configured; counts must be non-negative integers (request counts safe integers), times finite non-negative numbers, and unknown fields are rejected. All sessions are disposed in `finally`. Pi abort requires tool cooperation; arbitrary JavaScript tools ignoring abort cannot be forcibly killed by this wrapper. There is no provider fallback. Reload the Pi extension to use changed code defaults; an already-running invocation retains its existing limits.

### Concurrent pi sessions

It is common to have several `pi` sessions open on one repository, or on its superproject (this repository is a submodule of its parent) or one of its submodules. Their edits and commits can land while an `orche_task` is working. When a task **starts**, orche looks for other pi sessions that were written recently and whose working directory is inside the run's git toplevel, inside its superproject chain (`git rev-parse --show-superproject-working-tree`), or inside a submodule of those. If it finds any it does not block anything: the tool result starts with a warning such as

```
⚠ 2 other pi sessions active in this repository (cwd /work/repo, /work/repo/packages/a, last write 12s ago); their changes are classified as external where possible
```

and the task's changed-file report marks changes it cannot attribute to the worker. Detection is repeated while the work goes on: an `orche_task` asks again when it ends, answered from a cache for at least 30 seconds in between, so a session that starts mid-run is taken into account too (a progress warning appears the first time one shows up); a repeated detection that fails keeps what was already known.

Detection reads pi's session store only: it stats `<sessions dir>/<encoded cwd>/*.jsonl` (at most 2000 files, newest names first), reads just the first line of files written inside the window, ignores the current session, and spawns git for the run's own directory and for a few candidates whose path it cannot place. The sessions directory is `PI_CODING_AGENT_SESSION_DIR` when set, otherwise `<agent dir>/sessions` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Any error (missing or unreadable directory, malformed files, no git repository, a timeout of 5 seconds) means "no concurrent sessions" and no warning. A session that was closed within the window still counts, and sessions in another worktree of the same repository do not.

Configure it with the top-level `concurrentSessions` object of the Pi agent or trusted project `orche.config.json` (not in a file passed to the CLI's `--config`):

```json
"concurrentSessions": { "enabled": true, "windowMinutes": 10 }
```

`enabled` (default `true`) switches detection and the warning off with `false`; `windowMinutes` (default `10`, a number greater than 0 and at most 1440) is how recently a session file must have been written to count as active. Unknown fields and values of the wrong type are rejected like the other settings.

### Background tasks: attach, detach, messages to a running worker

In an interactive (TUI) or RPC session `orche_task` runs as a background job (J1, J2, …) and the call stays **attached** to it: it waits like a blocking call, its tool block shows the worker's progress and a live timer, and it returns the result exactly as a blocking `orche_task` would. The call **detaches** — returns at once while the worker keeps running — when

- the user types a new prompt (Enter steers, Alt+Enter queues a follow-up) or an RPC client sends `steer`/`follow_up`;
- another Pi session's note arrives through [pi-session-bus](../session-bus) and wakes this session (a suppressed note — wake off, hop or rate limit — does not detach);
- the user presses Esc (aborts the turn) or runs `/orche detach`.

Main then answers the input. Afterwards, if the job is still running and nothing else waits, it calls `orche_task_attach {job?}` to wait again (the rule in main's system prompt; Pi gives extensions no way to start a tool call themselves). It does not re-attach on its own after `/orche detach`, and after Esc only once it answered the user's next message. `orche_task_attach` refuses while user input or an undelivered peer note is queued. A job that ends while detached delivers its result once as an `orche-task-result` message — the result text with a header `[orche task result · J1 · W1 implement · done after 12m]` — that starts main's next turn (queued behind a turn in progress), with a one-line notification. Exactly once: a job's result goes either to the attached call or into that message, never both; attaching to a job that already ended says so and repeats nothing.

The widget above the editor shows the job the whole time:

```
◉ orche J1 · W1 implement · running 4m 12s · attached: waiting for the result (Esc detaches, /orche cancel stops it)
  W1 implement · 14 requests · last tool: edit
◌ orche J1 · W1 implement · running 6m 03s · detached: works in the background, the result arrives as a message (/orche cancel stops it)
✓ orche J1 · W1 implement · done after 12m 40s · result returned to the attached call
```

(`✗ failed`, `⊘ cancelled`, `! interrupted`; the end line stays until the next user input.) The TUI repaints it every second; RPC clients get it as a string-array widget only when its text changes, with minutes instead of seconds. A detached tool block reads `⇥ detached after 4m 12s · J1 keeps running in the background` instead of a duration, and the result message has its own renderer (status header, first lines collapsed).

Detaching never cancels: only `orche_task_status {cancel: true}` and `/orche cancel` do (an attached call then returns the cancelled result). More tools for the running job:

- `orche_task_message {job?, message}` — an additional or corrected instruction for the running worker. It is steered into the worker's session after its current tool calls, before its next model request, and grants nothing (no git grant, no write scope). A message the worker could not read before it reported is withdrawn (never carried into a later assignment) and the result lists it as `undelivered`; resend it as a follow-up `orche_task`. Messages that reached the worker are listed as `delivered`.
- `orche_task_status {job?, cancel?}` — progress, liveness and attached/detached state of the job, or `cancel: true` to stop it. It never waits; main calls it only when the user asks.

One job runs at a time. `wait: false` starts the job detached (the call returns once the worker has its assignment). `wait: true` keeps the blocking call that cannot detach (aborting it cancels the task); print and JSON modes (`pi -p`, `--mode json`) always block, because the process exits when the turn ends. Every job start and end is a small `orche-job` session entry (not model context).

Known limits: Esc during an attached call also clears Pi's queued messages (a woken peer note queued at that moment can be dropped; Pi core behaviour); input that another extension consumes after pi-orche saw it detaches anyway after a 1 s grace, and main simply attaches again.

**Lifecycle.** Worker and job ids are never reused within a session branch, also across reloads. Naming a worker that is gone (idle expiry after 30 minutes, LRU eviction, `/orche stop`, a reload or a crash) is no longer an error: a new worker continues, briefed with the gone worker's transcript path, last record and last summary, and the result says `Note: W1 was gone (…); W4 continued its work … Name W4 from now on.` Unknown ids are still errors. A session shutdown (reload, exit, session switch) ends running jobs as `interrupted` in their `orche-job` entry and their `run.json`; a job found running at the next session start (the process crashed) is closed then and announced once. `run.json` records left `running` by a process that no longer exists (`owner.pid`) are closed as `interrupted` at session start.

### Write scope outside the workspace

File tools of a worker write inside the workspace (and its owned files) as before. Outside it:

- every worker has a private scratch directory `<tmpdir>/pi-orche/<session>/<worker>` (0700, removed when the worker retires) for temporary files, writable for every role; the assignment prompt names it;
- `writeRoots` — in `orche.config.json` (top level, absolute or relative to the task cwd) or as an `orche_task` parameter for one implement/game-asset/video assignment — opens further directories (e.g. a sibling repository the user asked to change). `/` and the home directory are rejected;
- anything else outside is blocked with advice to use the scratch dir or report `blocked` so main can re-assign with `writeRoots`.

Worker bash follows the same policy for the write targets it can see statically (redirections and heredocs, `tee`, `cp`/`mv`/`install`, `touch`, `mkdir`, `rm`, `ln`, `sed -i`, `dd of=`, …). It is **not a sandbox**: dynamic targets (`$VAR`, globs, substitutions) and what programs write on their own are not checked; the workspace audit still reports changes inside the workspace. Paths are checked lexically and by real path (symlinks out of a root, `..` traversal and prefix tricks are blocked).

### Verification rounds

An implement/answer orchestrator may run at most two fresh-verifier rounds (`orche_spawn` with reason `verification`) per assignment; a third is refused, and the report must then list what stays open in `data.unresolved` (`[]` when nothing remains), which the result shows next to a `Verification cap:` line. When the user explicitly asks for more review rounds, main passes `verificationRounds` (up to 5) to `orche_task`. Tool reference: [docs/tools.md](docs/tools.md) "Main-session task tools".

### Output-limit recovery and long quiet waits

A response that hits the model's output limit while still reasoning is no longer "recovered" by compacting a context that is far from full: the worker gets at most two next-step continuations (the second one thinking a level lower), then one forced report, then an explicit `Output limit` failure. Real context overflows keep Pi's compact-and-retry. Survey of other agents, benchmark and decision: [docs/length-recovery.md](docs/length-recovery.md).

A bash command started with an explicit `timeout` counts as a declared quiet wait: while it runs within that timeout it keeps the worker active for deadline extensions, even without output. Without a timeout a silent command looks idle after two minutes, as before; the extension budget (`limits.maxExtensions`) still caps every assignment.

### Run records

The sessions orche starts itself (the persistent `orche_task` workers and their sub-workers) used to live in memory only, so afterwards there was no way to see what a worker did, which model each role really used, how many requests each made, or what a failed run cost. Now every `orche_task` leaves a **record**, by default under `<agent dir>/orche/records/` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — outside pi's own `sessions/` directory, so it never shows up in `/resume` or in concurrent-session detection, and never inside the workspace:

```
<records root>/<parent session id | no-session>/
  <ISO timestamp>_<run|task>-<short id>/
    run.json        manifest, written when the run starts (status "running") and rewritten when it ends — done, failed or cancelled
    events.jsonl    the task's event stream (liveness, deadline extensions, spawns), one bounded JSON object per line
    (records of the removed orche_run also had sessions/ with one JSONL per coordinator, worker and advisor)
  workers/<worker id>-<spawn timestamp>.jsonl   an orche_task worker: one stable session file across all its assignments
```

`run.json` holds the kind (`task`; `run` in records of the removed `orche_run`), the request and context as given, the working directory, the calling pi session (id and file), where the routes came from, the model and thinking level per role, start/end/duration, status, summary or failure, one entry per agent (`id`, `role`, `model`, `thinking`, `requests`, the models that actually answered, `durationMs`, `status`, `sessionFile`), the workspace changes / external changes / ownership violations, and the cleanup result. The session files are normal pi session files (`{"type":"session",...}` header, then messages), including the system prompt each agent ran with; one that was cut off by a cancellation or timeout keeps what was written and ends with an `orche:disposed` marker. Every `orche_task` result carries one line `Record: <directory>` and `details.record` (error results too), and `/orche records` lists the last ten records of the current pi session (time, kind, status, summary, path).

Transcripts can contain whatever tool output contained, including secrets, so directories are created `0700` and files `0600`. Writing is best effort: a records directory that cannot be created or written never fails a run or task, the sessions then simply stay in memory. The `orche_run`/`orche_task` code paths of the extension record by default; the eval and benchmark runners (`src/eval/`, `runOrchestrated`/`createSession` used as a library) write nothing unless the caller passes `records` / `sessionDir` / `sessionFile` explicitly (`PiRunnerOptions.recordsDir` for the Pi eval runner).

Configure it with the top-level `records` object of the Pi agent or trusted project `orche.config.json` (not in a file passed to the CLI's `--config`):

```json
"records": { "enabled": true, "dir": "/home/me/orche-records", "retentionDays": 30, "maxBytes": 1073741824 }
```

`enabled` (default `true`) switches recording off with `false`. `dir` (absolute, or starting with `~/`; default `<agent dir>/orche/records`) moves the root; a directory inside the run's workspace (or one that contains it, the filesystem root or the home directory) is refused and records are then off for that run. `retentionDays` (default `30`, a number greater than 0 and at most 3650): when the first run of a process starts, record directories and worker session files that have not been modified for that long are deleted. `maxBytes` (optional, a positive integer): after that, the oldest remaining records are deleted until the root fits. The cleanup only ever touches names orche created (`<timestamp>_<run|task>-<id>` directories and `workers/<id>-<timestamp>.jsonl`) inside the records root, never follows symlinks, never deletes anything written in the last hour, is bounded in entries, deletions and time (3 seconds), and ignores errors. Unknown fields and values of the wrong type are rejected like the other settings.

### Commits and pushes from `orche_task`

In `single` the main session cannot run `git commit` or `git push` itself, and workers never commit unless the assignment says so. `orche_task` therefore takes an optional per-assignment grant:

```json
{ "role": "implement", "request": "…", "files": ["src/a.ts"], "git": { "commit": true } }
{ "role": "implement", "request": "…", "git": { "push": true, "remote": "origin", "branch": "main" } }
```

`commit` allows `git commit`; `push` allows `git push` and implies `commit` (`push: true` with `commit: false` is an error); `remote` and `branch` name the push target and need `push` (a `branch` alone means `origin/<branch>`, a `remote` alone pushes the current branch to it, and with neither the current branch goes to its upstream). Only `implement`, `game-asset` and `video` accept `git`; `explore`, `answer` and `verify` reject it with an error. The main agent is told to set it only when the user explicitly asked to commit or push in this conversation, and to scope the commit to the task's `files`.

The grant is per assignment. Task workers are told to commit only when the current assignment authorizes it, and every assignment prompt (new or reused worker) ends with either an authorization line (stage paths explicitly, no `git add -A` of unrelated files, no force-push, history rewrite or git config change) or `Git commit/push is NOT authorized for this assignment; do not commit.` Library-run workers are unchanged: they never commit, and the run audit relies on that to tell a commit made elsewhere from their own work.

With a grant the result also reports, read-only and bounded, what happened in the task's directory: the commits created since the task started (`git log --oneline`, at most 20 listed, plus the true count), submodule gitlinks those commits changed, and whether a push was detected. A push is detected when a remote-tracking ref (the upstream, or the granted `remote/branch`) moved to a commit now contained in HEAD; this sees only pushes that update that ref, so "not detected" is not proof that nothing was pushed. The same data is in `details.git`. Outside a git work tree the report says it is unavailable.

## Architecture

- `src/extension/`: the Pi package entry (`/orche`, `orche_task`, tool replacement, spill hook), delegation modes, config discovery, the task controller, the persistent worker pool (`workers.ts`) and the run records (`records.ts`); see [docs/pi-package.md](docs/pi-package.md).
- `src/orchestrator/`: the orchestrator's split instruction (`instructions.ts`), `orche_spawn` and its sub-workers (`spawn.ts`, `sub-worker.ts`) and the split log (`split-log.ts`); see [docs/orchestrator.md](docs/orchestrator.md).
- `src/single/`: the single workflow's work types and task ledger. `src/specialists/`: game-asset/video sessions.
- `src/orchestration/`: what the workers share: routing and config (`routing.ts`, `limits.ts`), owned files (`backlog.ts`, `ownership.ts`), git snapshots (`workspace.ts`), deadlines and activity (`run/extension.ts`, `run/activity.ts`), worker prompts and result schemas.
- `src/agent/`: worker sessions (`agent-manager.ts`, `agent-handle.ts`), liveness and session records. `src/pi/`: Pi session factory, providers, extended context. `src/tools/`: the anchored read/edit, search, AST and diagnostics tools. `src/messaging/`: NOTE messages.
- `src/eval/suite.ts`: the benchmark suite loader and grader used by `scripts/validate-suite.ts` and `experiments/workflow/driver.ts`; `experiments/`: evaluation harnesses (`judgment/`, `orchestrator-smoke/`, `workflow/`) and earlier experiments.

Tests: `npx tsc --noEmit` and `npx vitest run` (deterministic; real Pi sessions with faux providers, no network).
