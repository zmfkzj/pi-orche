# Strong-mode reflection before the self-review (experiment)

`"single": { "strongReflection": true }` in orche.config.json (absent: off). Code: `src/single/reflection.ts`, wired in
`src/extension/workers.ts`; tests: `test/extension/strong-reflection.test.ts`; live trial harness:
`experiments/strong-reflection/trial.ts`.

## What it does

In `strong` mode (the effective mode of the assignment, a one-shot `/orche strong <PROMPT>` included) the implement/answer worker
receives this prompt once per assignment, verbatim, right before it reviews its own work:

```
지금까지의 대화를 한 걸음 떨어져 바라보라.
기존 판단을 옹호하거나 부정하려는 목적 없이, 대화에 드러난 전제와 판단 경향을 살펴보라.
무엇을 충분히 살폈고 무엇을 당연하게 넘겼는지 돌아보되, 장점이나 단점을 억지로 만들어내지 마라.
그 관찰에서 실제로 판단을 바꿀 이유가 발견되면 결과에 반영하라.
```

Strong is the single workflow on the strong tiers; it has no separate self-review API. The worker's observable self-review is
its Task DAG integration node (`phase: "integrate"`: compare every requirement with the actual changes and checks) before
`report_result`. Delivery points, in order:

1. **Integration start**: the first accepted `task_plan` (after validation and carry-over, so a rejected plan uses nothing and an
   omitted `phase` still counts) that sets an integration node running. The prompt is appended to that `task_plan` result; the
   model reads it in its next request, before the review's own tool calls.
2. **Fallback at the report**: the first `report_result` while no integration node had been set running (none planned, or one
   that went pending → done in one call). The report was already drafted, so the call is held once as a blocked tool call (not a
   validation error, no result retry) with the prompt and a request for a fresh self-review before sending it again.
3. A `report_result` sent in the same model response as the delivery was written before the prompt was read: it is held too.
   Pi runs a response's `tool_call` hooks before its tools, so a `task_plan` + `report_result` response gets the prompt through
   the report hold (2.).

Every later report goes through the existing gates unchanged (report rewrite at the baseline, data and checklist checks, the phase
gate's integration rule, the advisor's finalization). Single, ultra, mdsd and direct ignore the key; explore, verify, specialists
and `orche_spawn` sub-workers never get it. Results show `Reflection (single.strongReflection, experiment): …` and
`details.reflection` `{delivered: "integrate" | "report" | "none", node?, at?, sameResponseHolds?}`; records get a `reflection`
event.

## Status

An experiment, off by default. The deterministic tests show the wiring (text, placement, request boundary, mode and role
targeting, per-assignment reset, existing gates kept). They do not show that a real model reviews better with it.

## Live trial (2026-10-19)

Harness: `experiments/strong-reflection/trial.ts` (one process per cell, private agent dir, real `WorkerPool`, records on;
outputs in `results/strong-reflection/2026-10-19/`, gitignored). Fixture: a small `parseDuration` package; the request asks for
hours and combined forms (`1h30m`) while keeping existing behaviour, and the hand-off context carries a plausible false premise
("accepts only unit-suffixed strings"; the code and README also accept bare numbers, JSON numbers and surrounding whitespace).
10 hidden cases grade the result. Both arms: `cliproxyapi/gpt-6-astra`, thinking `high` (the user's strong tier model, at `high`
instead of its configured `max` to keep the trial bounded), strong mode, `single.spawn: false`, advisor off, thinking policy fixed,
20-minute cap; the only difference is `single.strongReflection`. 2 repeats per arm, run concurrently.

| cell | status | hidden grade | npm test | requests | input/output/cacheRead tokens | cost $ | wall s | reflection | tool calls after the prompt |
|---|---|---|---|---|---|---|---|---|---|
| off-r1 | done | 10/10 | pass | 12 | 16554/3143/66816 | 0.390 | 113 | off | – |
| off-r2 | done | 10/10 | pass | 15 | 12913/3295/98176 | 0.392 | 124 | off | – |
| on-r1 | done | 10/10 | pass | 15 | 23259/3333/89600 | 0.489 | 118 | integration node `verify` | bash, read, read, diagnostics, edit (a test assertion label), diagnostics, bash, task_plan, report_result |
| on-r2 | done | 10/10 | pass | 12 | 12038/3134/70272 | 0.347 | 107 | integration node `verify` | bash, diagnostics, read, task_plan, report_result |

Observed: in both `on` cells the prompt arrived at the start of the integration node (request 10 of 15 and 10 of 12), before
any review tool call, and the model then ran its ordinary review (tests, diff check, diagnostics, re-reads) and reported; no
report was held. All four cells spotted the false premise while implementing (before any review: "기존 코드를 확인해 보니 숫자와
단위 없는 숫자 문자열도 초로 처리합니다"), so the trap did not reach the review and cannot separate the arms. The review shape
of `on-r1` (re-reads, one edit, re-run) matches `off-r2` without the prompt; no cell's report mentions the premise in the hand-off,
and none invented findings. Request, token and cost differences are within the spread between repeats.

Conclusion: the wiring works with a real model, and in this bounded trial the prompt changed neither outcome nor visible review
behaviour. Four cells of one easy task are no evidence of improvement or harm; a discriminating test needs tasks whose mistake
survives until the review, more repeats, and the same pre-review history for both arms (e.g. a forked session).

## Hard-task bench (2026-10-19)

The user asked for tasks on which strong mode is right less than 60% of the time. The protocol was pre-registered before any
model call: `experiments/strong-reflection/bench/PREREGISTRATION.md`, with one amendment after the smoke unit.
- Code: `bench/protocol.ts` (tasks, config, hand-off, scoring), `bench/wire.ts` (record/replay proxy), `bench/run-arm.ts`,
  `bench/driver.ts`, `bench/analyze.ts`.
- Tests: `test/experiments/strong-reflection-bench.test.ts`.
- Raw records (gitignored, 446 MB): `results/strong-reflection/bench-2026-10-19/`. It holds each arm's `meta.json`, `wire.jsonl`
  with every model request and response, `checkpoint-request.json`, `checkpoint.diff`, `final.diff`, the orche records and
  session JSONL, plus `summary.json`, `summary.md`, `driver.log` and the frozen runtime `rt/` (digest `3a6e926943cef850`).

**Settings.**
- Model: `cliproxyapi/gpt-6-astra`, the user's `models.strong-orchestrator`, at thinking **high**. The user said "effort는 high로 충분";
  the configured value is `max`.
- The rest are the user's settings: advisor on (gpt-6-astra, `main` = high), `maxSubWorkers: 8`, spawn on, fixed thinking policy
  and default limits.
- Every request on the wire was `gpt-6-astra/high`. There were 2 sessions per arm (worker and advisor); no sub-workers were
  spawned.
- Deviations from the user's setup:
  - The in-process `WorkerPool` replaces main's hand-off with a fixed text (`handoff`), and main's own review is not run.
  - There are no web or code-graph tools.
  - `bashReview` is off: its external classifier is not in the harness and blocked every test run in the smoke unit.

**Tasks.** Four tasks were fixed before the bench from earlier studies of other configurations, as selection evidence only:
- pycqa__isort-2491, scientific-python__docstub-123 and tox-dev__tox-3904 are SWE tasks with maintainers' hidden tests;
- d1-transactional-outbox is a suite task with hidden `node --test`.

Five further prior failures were screened out beforehand because their hidden tests check names or formats that the task text does
not give. The grader is `experiments/ultra-ab/env.ts gradeWorkspace` and involves no model. It was validated model-free for the four
tasks (`validation.json`: start fails, reference passes, a weakened test is flagged). **Pass** means terminal `done`, the grade
passed and there was no integrity violation.

**Design.** Each of the 16 units (4 tasks × 4 repeats) runs three arms one after another at the same absolute path.
- **O**: unmodified strong mode run to its end. The reflection hooks only observe and mark the reflection point, which was the
  integration node `verify` in all 16 units.
- **R0** and **R1**, in a seeded order: O's recorded model responses for both the worker and the advisor are replayed with their
  latency up to that point, then everything is live.
  - R0 has no `strongReflection` key.
  - R1 receives the four-line prompt.
- Fidelity gate, passed by all 16 units:
  - no divergence in the worker's call ids;
  - the same work-state hash at the reflection point in O, R0 and R1.
- At the reflection point, every model-written item, advisor note and item order was identical between R0 and R1 (0 differing
  items outside tool outputs).
- R0 and R1 differed only in the outputs of re-executed commands: durations, ports, Python set order, timestamps, pids and
  `rg` result order. That was 0–5 of 71–149 items after removing durations, addresses and ports.
- The checkpoint state, i.e. the work before the review, was graded with the same grader.

**Results.**

| task | O (unmodified strong) | pre-review state | R0 | R1 |
|---|---|---|---|---|
| d1-transactional-outbox | 4/4 | 4/4 | 4/4 | 4/4 |
| scientific-python__docstub-123 | 0/4 | 0/4 | 0/4 | 0/4 |
| pycqa__isort-2491 | 0/4 | 0/4 | 0/4 | 0/4 |
| tox-dev__tox-3904 | 0/4 | 0/4 | 0/4 | 0/4 |
| total | **4/16 = 25%** (Wilson 95% 10.2–49.5%) | 4/16 | 4/16 | 4/16 |

- The baseline is 4/16, so the pre-registered rule (at most 9/16) is met: unmodified strong mode is below 60%.
- Paired R0 versus R1 over 16 units: both passed 4, neither passed 12, R1 only 0, R0 only 0. The sign test is undefined because
  there are no discordant pairs (p = 1).
- From the pre-review state, no arm went wrong to right or right to wrong. The 12 wrong states stayed wrong in O, R0 and R1.
- The review changed the work in 10, 8 and 10 of 16 units (O, R0, R1), and none of those changes altered a grade.
- The live review stage of the worker, R0 versus R1: 114 vs 121 requests, 36,998 vs 36,670 output tokens, 163 vs 172 tool calls
  and 19 vs 22 edits.
- No R1 message or reasoning summary mentioned premises, assumptions or the reflection. No arm invented findings or reported
  blocked. There were no leaks and no integrity violations.
- Billed upstream cost was $77.25 for the main bench (O $43.49, R0 $16.83, R1 $16.93) plus $2.85 for the smoke unit. Replayed
  responses were not billed. An O arm took 3.3–12.1 min, mean 6.7.

**Reading.**
- On these tasks the self-review never turned a wrong pre-review state into a right one, with or without the prompt.
- The failures (for example an unhandled `Callable[[float, str], int, byte]` error case, or an implicit machine ISA factor
  removed) were not visible to the worker's own checks. The reflection gave it no route to them.
- The bench therefore shows no effect of the prompt in either direction: 0 corrections, 0 regressions and the same review
  effort.
- It cannot rule out a small effect. That would need many more units with failures that the review could catch.
- Three tasks at 0/4 and one at 4/4 mean that only a few task types contribute.
- The pre-review grade relies on the tests and runner restored by the grader. The workers' own visible suites had
  environment-related failures that also occur in the start state.

## Corrections to the hard-task reading (analysis of 2026-10-23)

The 2026-10-19 results above stand; three readings do not.
- "Not visible to the worker's own checks" is wrong for tox: in 4/4 repeats the worker's own tests assert the inverse of the
  maintainers' implicit-ISA expectation on the very input (`py39`). docstub never probed the arity/`Callback[...]` boundaries and
  never checked the stdlib; isort's own tests assert a contested short-line comment format. The common cause is an expected value
  fixed by the worker's interpretation and never checked against an independent authority; the same-model advisor concurred 16/16.
- The 12 failures are ~5 decision clusters shared by 3 continuations each (O, R0, R1 replay one history), so "0/36" is not 36
  independent trials: no pooled bound or Fisher test applies. The tasks were pre-selected as prior failures; 4/16 is a property of
  this oracle set.
- Withdrawn from the follow-up proposal: an unscoped "no authorizing sentence → keep the original behaviour" rule.

## Decision-audit rescue pilot (2026-10-23)

A mechanism pilot, not an efficacy benchmark: does a structured decision audit at the same reflection point repair the recorded
failures without breaking passing work? Pre-registration, frozen before any live call: `experiments/strong-reflection/bench/pilot/PREREGISTRATION.md`
(texts, schedule, budget, cluster read-out; two harness amendments before any live call). Code: `bench/pilot/` (protocol, fidelity
gate, budget ledger, driver, evaluate, diagnose, transcript) and the pilot branch of `bench/run-arm.ts` / gates of `bench/wire.ts`;
tests `test/experiments/strong-reflection-pilot.test.ts`. Results (gitignored): `results/strong-reflection/pilot-2026-10-23/`
(`summary.md`, `summary.json`, `adjudication.json`, `diagnostics/`, `transcripts/`, `frozen/`, `budget/`, per-arm `units/<unit>/<arm>/`).
- Arms on the recorded checkpoints, live on `cliproxyapi/gpt-6-astra`/high (not the current strong route): **A** the audit alone,
  **B** the four lines unchanged + the same audit, **C0** no text on the 4 tox units (contemporaneous control).
- Coverage: 32 of the 36 planned continuations ran, all valid: the whole tier 1 (tox ×4 with C0, docstub-r1, isort-r4, d1 ×4) and
  tier 2 isort-r1/r2, docstub-r2/r3. The pre-declared admission rule stopped before isort-r3 and docstub-r4 (committed 41.43 USD +
  5.93 reserved > 45): those 4 continuations were not run.
- Fidelity: strict replay, and before any live request the reflection-point request matched O's (all model-written items,
  instructions, tools, exactly the arm's text, the same work-state hash) in 32/32 arms; the text stayed in every later live request
  of A/B. Not byte-identical: re-executed tool outputs differed in every arm (3–12 items raw, 0–9 after the tool-noise rule, 0–3
  even ignoring line order; per arm in `summary.md`). Deviation for all arms alike: the live root moved from `…/W1/srb` to the
  same-length `…/W4/srb` (write scope); replayed responses were rewritten, O's encrypted reasoning items cannot be. A first dry
  attempt left workspaces for five units and a stale lock under `…/W1/srb` (outside the write scope; left in place).
- Spend (token-priced estimate at the gpt-6-astra list price; the provider reports tokens, not charges): 300 live requests, all
  `gpt-6-astra`/high with usage, 41.43 USD (A 17.79, B 17.69, C0 5.94) of the 50 cap. The ledger's settlements equal the wire
  usage exactly; no refusal, interrupted request, outstanding reservation or infra retry; dry runs forwarded nothing. The agents'
  own analysis and advisor sessions are not included and were not measured here.
- Outcomes: no grade flip anywhere. The 10 failing units stay failing in A and B, C0 tox 0/4; d1 8/8 still pass (no harm); no
  newly failing grader check or hidden test in any arm (per-test diagnostics). The review changed work in 7 A, 8 B and 2 C0 arms,
  never the failure-deciding behaviour. Pre-declared verdict **stop**: in both A and B the tier-1 coverage is complete, there is no
  grade flip in the reachable clusters, and the audit was carried out in 6/6 reachable units (`adjudication.json`: 1 full and
  5 partial in each arm; partial mostly lacks an explicit requested/necessary/collateral classification).
- Mechanism, observed in the transcripts:
  - **C1 tox:** in 8/8 A/B arms the worker named the removal of the implicit host ISA. It ran the distinguishing input (`py39` on a
    mocked host: original `arm64`, change neither) on both the original and the change, cited `docs/reference/config.rst:69–72`
    (only `sys.platform` is implicit) and kept the change. Every A, B and C0 report names the alternative "retain the host ISA unless
    an explicit one is named" and rejects it. The hidden patch adds the tests encoding the contract
    (`test_machine_isa_implicit_when_no_env_isa` and its TOML twin), and the documentation the audit consulted supports the
    worker's reading. This qualifies the correction above: C1 is a contested contract, not an expectation that was never checked.
    The audit also did not surface tox-r2's TOML scope (hidden F2P test).
  - **C2 docstub-r1:** the generic-grammar choice was named, but no audit probed its consequence: the hidden test requires
    `Callable[[float, str], int, byte]` to be rejected.
  - **C5 isort-r4:** the ordinary-comment input was run on the original and the change. The narrow scope was kept because existing
    tests (`tests/unit/test_wrap.py:24-50`) put ordinary comments on the continuation line, and the hidden test changes that
    contract. Here the audit's preference for independent evidence and existing behaviour pointed away from the hidden contract.
  - Policy clusters: docstub r2/r3 never surfaced `Callback[...]` (C3). isort r1/r2 (C4) changed the implementation during review,
    and isort-r2 A restored one collateral change on audit grounds, but no arm questioned the merged comment format.
  - d1: original-versus-change probes in all 8 audits. Two review changes (d1-r1 A removed an unrequested `TypeError`; d1-r2 B
    changed error construction and the options default), both still passing.
- Reading: the hypothesis that this audit repairs these consequential errors is **contradicted** within the pilot's scope. The
  audit was followed, but the failure-deciding expectations were either supported by the independent evidence the worker could see
  (tox docs, isort tests) or never reached by its probes (docstub arity). A and B did not differ (neither rescued anything), so
  nothing is said about the four lines. Limits: 4 task families, about 5 decision clusters, one continuation per unit and arm on
  shared histories, an audit written after seeing these failures, unrewritable encrypted reasoning, and possible model changes
  behind the same id. Efficacy on fresh tasks (the <60% baseline goal) is untested and not started.
- Verification: the outcomes are offline regrades and diagnostics of the saved patches (no model). The same agent that built the
  pilot did the adjudication, so it is not independent; the advisor sessions inspected only the plan and code.
- Reproduce: `node --import tsx experiments/strong-reflection/bench/pilot/driver.ts <pilot dir> --dry` (zero cost) or `--live`
  (spends; refuses a changed protocol), then `TMPDIR=<scratch> … pilot/diagnose.ts <pilot dir>`, `… pilot/transcript.ts <arm dir>
  <out.md> [--brief]` and `… pilot/evaluate.ts <pilot dir>`.

