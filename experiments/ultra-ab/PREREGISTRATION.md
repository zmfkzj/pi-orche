# ultra vs single structure: pre-registration (A/B/C)

Part 1 below was written on 2026-10-10 before any model call of this study. Part 2 was added after the pilot and before the main study started. The SHA-256 of this file and of the main plan are recorded in `results/ultra-ab/main/plan-main.json` (`preregSha256`), which is written when the main study launches. Results land in `results/ultra-ab/` (local and untracked, as the repository's convention for results requires). The report is `docs/ultra-ab-bench.md`.

## Part 1 (before the pilot)

### Question
Does `/orche ultra` (B) produce better final results than the single structure on the same strong tier (A = `/orche strong`)? If it does, is the gain larger than what simply spending more attempts gives (C)? The comparison is about final quality and success, not cost.

### Conditions
Every condition gets the same task text, the same initial snapshot, the same visible tests, models, effort, tools, permissions and limits.

| | What runs | Notes |
|---|---|---|
| A | `pi --mode json "/orche strong <prompt>"` | Main hands the request to orche's single workflow on the strong tier (docs/orchestrator.md 14.1). Sub-workers may be spawned (`single.spawn: true`, the product default). |
| B | `pi --mode json "/orche ultra <prompt>"` | The same tier with the ultra pipeline (14.2). Its stages and tools are the treatment. |
| C | k independent A runs, each on its own copy of the same snapshot, then one selector run | The selector is a fresh Pi session on the same model. It has no orche and gets read/bash/grep/find/ls tools. It sees the base snapshot, each attempt's final files and diff, and each attempt's terminal status, and may run visible checks itself. It never sees transcripts, reports, grades or hidden tests. Its choice is sealed (sha256) before any attempt is graded. Fallback when it fails or returns no valid choice: the first attempt whose status is done, otherwise attempt 1. |

- **Prompt:** `userPrompt` in `experiments/ultra-ab/protocol.ts`: the task text plus one fixed constraints paragraph, identical in all three conditions.
- **Models:** every role uses `cliproxyapi/gpt-6.1-sol`, the canonical route; the `bts/` variant is never used.
  - Main runs at thinking `high`.
  - `models.strong-orchestrator` is `{gpt-6.1-sol, xhigh}`. `strong-worker` is unset, so sub-workers inherit xhigh.
  - The selector runs at `xhigh`.
  - `thinkingPolicy: "fixed"`.
  - The advisor is off (`single.advisor: false`). `models.advisor` is pinned to the same route anyway.
  - `concurrentSessions` is off, so runs cannot message each other.
- **Verification:** the routes are checked against what actually happened, not against configuration.
  - Each run gets its own logging proxy (`proxy.mjs`). It records the requested model, the effort, the HTTP status, the response model and the usage the provider reported.
  - Requests from orche workers are distinguished from main's by the worker prompt marker.
  - orche's `run.json` gives `assignment.mode/tier/model/thinking`.
  - Every deviation is listed (`summarizeWire().unexpected`). A missing response model is listed as "unverifiable".
- **Limits:** identical across conditions; for C they apply to each attempt.
  - orche: base 60 min per assignment, at most 2 extensions of 15 min while active, so the ceiling is 90 min.
  - Soft request budget: 300 per worker assignment.
  - Hard kill of the Pi process group at 150 min.
  - Selector: hard kill at 30 min.
- **Isolation:** each run gets a fresh process, a private agent dir (copied catalog and connection, a written `orche.config.json` and `settings.json`) and a fresh session, TMPDIR and workspace.
  - The workspace is a git repository whose only commit is the visible snapshot. Hidden tests and references stay in `fixtures/` outside it.
  - SWE tasks: `python`/`pytest` on PATH are wrappers that run the task's read-only virtualenv with the CURRENT project first on `PYTHONPATH`, that is, the nearest ancestor of the shell's directory that holds a root anchor of the snapshot.
  - Why the wrappers changed: the earlier harness pinned the first workspace. From a subdirectory of an ultra candidate copy it imported the original workspace's code (`validate.ts`: `legacyWrapperImportedFromCopyB = copy-a`). That would have biased B and C's checks. This harness defect was fixed before any run.
- **Product snapshot:** the working tree at launch, HEAD `2de1f04` plus the uncommitted ultra changes. It is copied into `<study>/rt` with per-file hashes and a digest (`rt/REVISION.json`), and every run of a study loads that copy. The harness itself is frozen into `<study>/harness`.

### Tasks
The tasks are drawn by `experiments/ultra-ab/draw-tasks.ts` (seed `ultra-ab-2026-10-10`, output `experiments/ultra-ab/tasks.json`) from the independent Opus 5.5 single-worker calibration (`experiments/advisor-reviewer/selection.json`). That calibration contains no strong/ultra data.

- **Eligible:** suite tasks graded by visible+hidden tests, and SWE-rebench tasks with a validated environment.
- **Not eligible:**
  - LiveCodeBench: public 2025 problems that all passed in calibration.
  - Tasks the calibration study excluded: spec gaps that require exact text, and one task with unreliable calibration.
- **Strata:**
  - hard: no calibration run passed.
  - medium: mixed results, or every run passed at a mean cost of at least $0.60.
  - easy: every run passed below $0.60.
- **Draw:** per stratum, a seeded shuffle. The first task goes to the pilot and the next 4 to the main study. A suite task is moved into each stratum's main draw when one is available.

| stratum | main | pilot |
|---|---|---|
| hard | sqlfluff__sqlfluff-7615, pycqa__isort-2491, d1-transactional-outbox, scientific-python__docstub-123 | nesquena__hermes-webui-2056 |
| medium | tox-dev__tox-3904, youssofal__mtplx-21, holoviz__param-1117, d8-build-graph | pypa__build-1027 |
| easy | a7-auth-rotation, stravalib__stravalib-709_interface, tobymao__sqlglot-7187, marshmallow-code__marshmallow-2925_interface | python-scim__scim2-models-126 |

- **Grader validation** (no model, `validate.ts`, `results/ultra-ab/validation.json`): for all 15 tasks, the starting snapshot fails the grade, the reference solution passes, and a removed assertion line in an original test is flagged. The SWE wrapper follows the copy the shell is in.
- **Not swapped after the fact:** no task is swapped after results are seen. A task whose environment breaks during the study is reported as such and stays in the denominator.

### Outcomes

**Primary (per top-level run):** a run passes only if all three hold:
1. The terminal status is `done`, meaning the LAST orche task the request started ended `done` in its `run.json`.
2. The independent grade passed.
3. There is no integrity violation.

The grader (`env.ts gradeWorkspace`) works as follows:
- It grades a copy of the final workspace in which every original test file and test-runner config is restored and any new conftest/pytest.ini/tox.ini is removed.
- Suite tasks: the original visible test files and the hidden test files run with `node --test` (TAP). Each set needs exit 0, at least one passing test and zero failures.
- SWE tasks: the hidden `test.patch` is applied (files it touches are first reset to the original), then the task's test command runs. Every FAIL_TO_PASS and every non-excluded PASS_TO_PASS id must pass; a parametrized prefix needs all its matches to pass. An abnormal pytest end (exit >1, a signal or a timeout) fails.

An integrity violation is any of the following:
- an original test file was deleted or had lines removed or changed;
- skip/only/xfail/collection-hook markers were added to a test file;
- the test-runner section of a config was changed;
- a new conftest.py, pytest.ini or tox.ini was added.

Added test lines are allowed and listed as "suspicious". Hard-coding cannot be detected mechanically; the hidden tests are the guard against it (limitation).

**Secondary outcomes:**
- grade pass regardless of status (artifact correctness);
- terminal-status distribution: done, blocked, failed, timeout, cancelled, no-task, harness-timeout, infra;
- integrity findings;
- wall time;
- requests, input/cached/output/reasoning tokens (from the wire);
- provider errors and latency per condition;
- for C: the selection choice and source, its cost, and the oracle reference ("would any attempt have passed"). The oracle is reported only and is never C's result.

**Not dropped:**
- blocked, timeout, harness-timeout, no-task and provider failures DURING a run count as primary failures;
- "not run" (a planned unit never completed) is reported as such and never counted as a pass.

### Infrastructure retries (fixed)
- **What counts as infra:** a run where no model request succeeded, the proxy or harness failed before the agent could work, or the run process died without completing.
- **Retry:** such a run runs again, at most once. Every failed attempt is kept (`<dir>.infra-<n>`). After the retry, infra counts as a failure.
- **Interrupted runs:** a run interrupted by a harness or machine stop (no completed meta) is kept as `<dir>.interrupted-<n>` and runs again.
- **Never retried:** timeouts, blocked/failed results, provider errors during a run, and grade failures.
- **Grader errors:** the run is regraded, never rerun.
- **No early stop:** the study does not stop early because interim results look favourable.

### Pilot (separate tasks; its results are not efficacy evidence)
- **Size:** 3 pilot tasks × {A, B} × 1 repeat, plus C with a provisional k=2 on the same tasks.
- **Purpose:** check that the harness works and measure B's compute.
- **Harness fixes:** harness defects found in the pilot are fixed and documented. Product defects are only recorded.
- **k rule (fixed now):** R = geometric mean over pilot tasks with both runs of (B wire output tokens / A wire output tokens), where output includes reasoning. k = clamp(round(R), 2, 4). If round(R) > 4, k = 4 and C is reported as compute-under-matched. The B/C token difference of the main study is reported as measured, not assumed equal.

### Main study
- **Size:** 12 tasks × {A, B, C} × 2 repeats = 72 top-level results. C also has 2×12×k internal attempts.
- **Order:** repeat-major. Within each (task, repeat) the conditions run in a seeded random order (`protocol.ts schedule`, seed `ultra-ab-2026-10-10`), with bounded concurrency.

### Analysis and verdict (fixed)
- **Per task:** the primary success rate over its repeats.
- **Paired comparisons:** B−A and B−C (and C−A as context).
  - mean over tasks of the per-task difference;
  - 95% percentile bootstrap resampling TASKS (10,000 draws; repeats stay inside their task);
  - exact two-sided sign test over tasks with a difference;
  - expected X-fail/Y-pass and X-pass/Y-fail counts.
- **Breakdowns:** by stratum, by source (suite/SWE) and by terminal status. These are descriptive, with no per-subgroup significance claims.

| Condition (95% task-bootstrap interval) | Verdict |
|---|---|
| B−A lower bound > 0 and B−C lower bound > 0 | ultra superior |
| B−A lower bound > 0, B−C not | total effect only (structure + extra compute; not separated from more attempts) |
| B−A upper bound < 0 | ultra inferior |
| otherwise | unconfirmed |

- "B ≈ C" is never stated as equality. An advantage seen only in some strata is reported descriptively as "possible advantage in some types", not as the verdict.
- 12 tasks is a small first study; the results do not generalize beyond this task set.

## Part 2 (after the pilot, before the main study; written 2026-10-10 07:50 KST)

**Pilot runs:** `results/ultra-ab/pilot`, 15 units, 2026-10-09 20:59–22:48 UTC. It ran 3 tasks × A/B × 1 repeat plus C with a provisional k=2, on the frozen runtime `5da2755ef90d`. These results are not efficacy evidence.

**Pilot outcomes** (primary):

| task | A | B | C |
|---|---|---|---|
| hermes-2056 | F | F | F |
| build-1027 | P | F | P |
| scim2-126 | P | F | P |

- In build-1027, B ended `done` but broke 2 existing PASS_TO_PASS tests.
- In scim2-126, B's workspace passed the grade but both of its orche tasks ended `blocked` ("final independent review remains incomplete; no additional round was authorized"), so it is a primary failure under the registered rule.
- Wall time per run: A 7–15 min, B 44–88 min, C attempts 6–10 min, selection 0.5–3.5 min.

**Model and route evidence (pilot):**
- All 1,175 model requests went to `gpt-6.1-sol`, and the response model was `gpt-6.1-sol` on every one.
- Main ran at `high`; every orche worker and sub-worker at `xhigh`; the selector at `xhigh`. Zero deviations.
- Every orche task record shows `mode strong|ultra`, `tier strong-orchestrator`, `cliproxyapi/gpt-6.1-sol`, `xhigh`.

**k:**
- Per-task B/A wire output-token ratios: 9.96, 5.39, 16.98. Geometric mean R = 9.69.
- round(R) = 10 > 4, so **k = 4** and C is compute-under-matched: at the pilot ratio, 4 strong attempts are about 40% of B's output tokens. The main study reports the measured difference.

**Harness defects found and fixed before the main study** (none of them is a product change):
1. The manifest writes of concurrent units raced (same temp file name). The first pilot launch crashed after 90 s and is kept as `results/ultra-ab/pilot-aborted-1`. Fix: writes are serialized and temp names are unique. Unit processes are stopped with the driver, and a stopped runner kills its Pi process group.
2. The proxy's usage parser read the nested per-item `attribution` usage instead of the final event's totals. It now parses the final `response.completed|incomplete|failed` event. This was fixed before the second launch, so all pilot runs have correct usage.
3. "Stream errors" were counted when Pi closed the socket after the final event. They are now computed from the raw wire as "HTTP 200 without a final `response.completed`". `analyze.ts` recomputes the wire summary from every raw `wire.jsonl`, so all phases share one definition.
4. Roles were classified by a worker-prompt marker that ultra sub-workers do not carry, which made B's sub-worker requests look like "main at xhigh". Roles now come from the session: the run's own `--session-id` is main and every other session is an orche worker or sub-worker.
5. Leak exposure: the SWE wrappers pointed into the repository (`results/advisor-reviewer/cache/swe/...`), and a B pilot run browsed venv sources there; it was library code only, with no hidden or solution access (raw-transcript grep). For the main study the 15 task environments are copied into scratch (`plan.sweCache`, re-staged after a reboot), and `validate.ts` was re-run against that copy (VALIDATION OK, `results/ultra-ab/validation-scratch-cache.json`). The leak patterns now flag any path into the repository's fixtures/results/experiments/docs/test and drop the noisy bare `reference/` pattern.

**Product observations** (recorded, not changed): the ultra runs of the pilot are slow (44–88 min) and, on the easy task, ended `blocked` at the verification-round cap.

**Main study (fixed now):**
- Settings: `experiments/ultra-ab/plans/main.json` with the 12 tasks of Part 1, conditions A/B/C, 2 repeats, k=4, seed `ultra-ab-2026-10-10` and concurrency 8.
- The frozen product runtime is the same working tree as in the pilot. Its digest is checked at launch and recorded in `plan-main.json`.
- Limits are unchanged from Part 1.
- The harness is frozen into `results/ultra-ab/main/harness` at launch. `plan-main.json` records the plan hash and this file's SHA-256 (`preregSha256`).
