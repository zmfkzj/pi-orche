# Strong-reflection hard-task bench: pre-registration (2026-10-19)

Written before any model call of this bench. Results go to `results/strong-reflection/bench-2026-10-19/` (gitignored); the report is
`docs/strong-reflection.md` ("Hard-task bench").

## Question
In strong mode, on tasks where unmodified strong mode is right less than 60% of the time, does the user's four-line reflection prompt
placed before the worker's self-review (`single.strongReflection`) change the final correctness, compared with the same self-review
without it, starting from the same pre-review history?

## Model and settings (fixed)
- Strong tier `cliproxyapi/gpt-6-astra`, as in `~/.pi/agent/orche.config.json` `models.strong-orchestrator`. Thinking is **high**, not
  the configured `max`: the user said "effort는 high로 충분" (relayed by main, message M2 of this assignment, 2026-10-19).
- The other settings are the user's: `single.advisor: true` (advisor `gpt-6-astra`, thinking `main` = high), `single.maxSubWorkers: 8`,
  `single.spawn` default (on), `thinkingPolicy` default (fixed), orche default limits. The unused image/game-asset/video routes are
  left out. Config: `protocol.ts` `orcheConfig`.
- In-process orche stack (`WorkerPool.execute`, role implement, mode strong) on a frozen copy of the working tree
  (`<bench>/rt`, digest in `driver.log`). Main's hand-off is a fixed text (`protocol.ts` `handoff`). Main's own review after the worker
  reports is not part of the bench. No web or code-graph tools (the in-process harness has neither).
- The effort and model actually requested are read from the wire (`meta.wire.requested`), not taken from the config.

## Tasks (frozen)
Four tasks chosen BEFORE this bench from earlier studies of OTHER configurations. This is selection evidence only, not a
measurement of this configuration:
| task | kind | earlier evidence |
|---|---|---|
| pycqa__isort-2491 | SWE | Opus 5.5 worker calibration 0/2 (`experiments/advisor-reviewer/selection.json`); ultra-ab strong (gpt-6.1-sol xhigh, advisor off) 0/2 |
| scientific-python__docstub-123 | SWE | Opus 0/2; ultra-ab strong 0/2 |
| tox-dev__tox-3904 | SWE | Opus 1/1 pass; ultra-ab strong 0/2 |
| d1-transactional-outbox | suite | Opus 0/2; ultra-ab strong 1/2 |

Screened out before any run because their hidden tests check names, formats or messages that the task text does not give (missing
information, not difficulty): nesquena__hermes-webui-2056 (slug format), nolar__kopf-1225 (log text), pypa__twine-1309 (message text),
python-scim__scim2-models-120 (unstated errors), pallets-eco__wtforms-892_interface (exact HTML). sqlfluff-7615 was left out because
ultra-ab strong passed it 2/2.

## Units and arms
- 4 tasks × 4 repeats = 16 units. A unit runs at one fixed absolute live path; its arms run one after another:
  - **O**: unmodified strong mode to the end (its ordinary self-review included). `strongReflection` is on, but its hooks are
    patched to observe only. They return nothing to the model and mark the reflection point:
    - the first accepted task_plan that sets an integration node running, or
    - else the first report_result.
  - **R0** (control) and **R1** (reflection), in a seeded random order per unit (`orderOf`). O's recorded model responses
    (worker, advisor, sub-workers) are replayed with their recorded latency up to the reflection point; from the top worker's
    request at that point everything is live.
    - R0 has no `strongReflection` key.
    - R1 has `strongReflection: true`.
- A unit whose O reaches no reflection point (no report) has no R0/R1. Its O still counts in the baseline.

## Scoring (frozen)
- Independent grader `experiments/ultra-ab/env.ts gradeWorkspace`. It never involves a model, and it was validated model-free for
  these four tasks (`<bench>/validation.json`): the start state fails, the reference passes, a weakened test is flagged.
  - It runs the original tests and runner config on a restored copy, adds the hidden tests, and requires all FAIL_TO_PASS (every
    parametrized case with a truncated id) and all PASS_TO_PASS (SWE), or visible plus hidden `node --test` (suite).
- **pass** = terminal `done` AND grade passed AND no integrity violation (`protocol.ts primaryPass`).

## Primary results
1. **Baseline accuracy** = O passes / O runs over the 16 units. It qualifies as "below 60%" only if it is at most 9/16.
   - Also reported: the Wilson 95% interval and per-task counts.
   - Infra-only failures (no successful upstream response) are retried once per unit; any other failure counts as a fail.
2. **Paired comparison** over units with valid R0 and R1:
   - pass counts of R0 and R1;
   - the 2×2 table (R0 fail/R1 pass, R0 pass/R1 fail, both, neither) with an exact two-sided sign test on the discordant pairs;
   - the change from the checkpoint state to the final state in each arm. Changes are counted from the reflection point (the
     workspace hash and final grade), since the checkpoint state itself is not graded.
3. **Replay fidelity gate**, per unit: no top-worker divergence before the reflection point, and the same workspace hash at the
   reflection point in O, R0 and R1.
   - Units that fail the gate are reported and excluded from the paired comparison, never silently counted.
   - Also reported: the identity of the full top-worker request at the reflection point between R0 and R1 (R1 minus the reflection
     text) after normalizing run-specific ids/times.
4. Secondary: transitions O→R0 and O→R1, requests, tokens, billed (live) cost, wall time, leaks of hidden paths.

## Stopping and budget
- No new unit starts once billed live cost reaches 180 USD (`BUDGET_USD`).
- The driver kills an arm's process group after 170 min.
- A smoke unit (`smoke-d1-transactional`, outcome excluded) validates the harness first; no protocol change after the main units start.
- No conclusion about improvement beyond what the discordant counts support. With at most 16 pairs, only a large effect could reach
  significance; a null or negative result is a valid outcome.

## Amendment after the smoke unit (before any main unit)
The smoke unit (`smoke-d1-transactional`) ran on 2026-10-19 between 07:11 and 07:36 UTC. It validated the record/replay path:
- the reflection point was integration node `verify` (top-worker request 25);
- R0 and R1 had the same pre-review workspace hash as O, no divergences, and the same reflection-point request after normalization;
- R1 delivered the prompt there.

It also exposed one tool failure. The user's Bash safety review (`bashReview`, classifier `typesafe/jev-latest`) is not available
in the harness's agent dir, so every reviewed command (`node --test`) was blocked and all three arms reported `blocked`, although
their grade passed.
- The classifier is an external, non-replayable call outside the model's reasoning.
- `bashReview` is therefore off in every arm (`protocol.ts`). This is the only change. The smoke outcome is excluded.

