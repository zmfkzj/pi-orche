# Problem A evaluation

> **역사 기록** — 2026-10-06 기준 제거/대체됨: src/eval 벤치마크 러너(suite.ts만 남음). 현재 구조: [docs/orchestrator.md](orchestrator.md). 아래 본문은 당시 기록 그대로다.

**Latest benchmarked-revision headline — R3 only:** orchestration completed and passed both grade suites in **3/3** trials; baseline completed and graded successfully in **1/3** (its workspaces passed hidden grading in 2/3). Mean recorded wall time was **142.254 s versus 165.104 s**, but two baseline failures make that aggregate an imperfect speed comparison. The one pair where both runners completed and graded successfully was **5.42% faster** orchestrated (148.716 s versus 157.234 s). Criterion 9 is met narrowly/descriptively by this latency observation on the provided live SDK task, **not** by an established significance claim or a demonstrated monetary-cost win.

## Post-R3 code changes (unbenchmarked)

R3 numbers describe the revision **before** two subsequent coordinator changes; they are **not a benchmark of the final tree**:

- Main-inbox NOTEs received after EXPLORE are now buffered and delivered exactly once to the next coordinator decision, rather than silently dropped.
- An invalid `backlog_proposal` payload now receives one bounded corrective re-assignment, then fails if still invalid.

Main's audit of saved `events.jsonl` found the former NOTE-drop path once in R2 orchestrated-1 during BACKLOG, and zero times in R3 or MVP runs. The malformed-proposal path did occur in failed MVP attempt 1: `results/mvp/2026-09-30T15-46-43.059Z/events.jsonl` line 68 records `data.items=[1,2,3]`, followed by FAILED; no corrective retry existed then. Neither changed path occurred in R3, so those recorded runs would not have exercised the new behavior. The new malformed-proposal recovery and NOTE buffering are covered only by deterministic faux-provider regressions in `test/orchestration/coordinator.test.ts`, not by live benchmarking; Main reports the full suite passing 71/71 and typecheck clean. No live reruns or metric changes were made for these post-R3 changes.


## Method and measurement contract

The benchmark uses real Pi SDK 0.99.1 sessions on the provided problem-A fixture. Each round runs `npx tsx src/eval/bench.ts --runs 3 --modes baseline,orchestrated` in b,o,b,o,b,o order. Every trial receives a fresh visible-only workspace and the same problem prompt; hidden tests and ground truth remain benchmark-only. Route configuration is captured once per round. All recorded runs, including failures, remain in summaries. No run was dropped or replaced: no recorded failure was an evidenced infrastructure outage. There was no round 4.

Baseline main plans three angles, waits for all exploration results, integrates a cause/backlog, dispatches dependency-ready task waves, then independently verifies. Every task/fix/verifier worker is fresh and lacks `send_message`. Task workers rotate the three explorer routes. Orchestration supports early convergence, persistent worker reuse and sparse direct peer notes. Both use the same AgentManager, Pi session factory, and one shared file-backed ModelRuntime per run; every session is disposed in `finally`.

Limits: 600,000 ms overall; 120,000 ms exploration; 180,000 ms assignments; 90,000 ms coordinator decisions; two structured-decision repairs; one fix round. Current AgentManager permits one bounded RESULT nudge under the same assignment when a worker settles without `report_result`; it applies symmetrically to both runners. Nudges are counted separately and never inflate assignment/reuse counts. Implement outcomes with missing `data.status` count as done, while explicit `status:blocked` remains blocked.

Wall time spans run-start to run-finish, excluding preparation/grading. Requests count worker and coordinator usage events. Input, output, cache-read and cache-write tokens remain separate. First-useful time is the first matching worker claim; accepted-cause time is the first matching coordinator acceptance. Wasted work counts only other agents' exploration usage strictly after the first matching claim, using assignment IDs rather than a worker's latest phase. Reuse counts assignment starts beyond an agent's first; peer NOTE messages and notes to main are separate. Assignment-kind breakdowns attribute all recorded usage to coordinator, explore, backlog_proposal, implement, fix or verify; unknown assignment identity is retained as unattributed rather than silently dropped.

**Completion and grading are distinct.** Primary correctness rate requires run status done AND both visible/hidden suites passing. Grade pass rate is also shown independently. An early failed run can be shorter because it skipped work: its low wall time/request count is not a performance win. Numeric aggregates report population standard deviation; nulls are excluded with defined-observation counts, never invented.

### Routes (identical in the recorded rounds)

| Role | Model | Thinking |
|---|---|---|
| coordinator | openai/gpt-6-luna | low |
| explorer-path | openai/gpt-6-luna | low |
| explorer-cause | openai/gpt-6-luna | low |
| explorer-repro | deepseek/deepseek-flash | low |
| verifier | openai/gpt-6-luna | low |
| default | google/gemini-3.5-flash | minimal |

### Matcher revisions and replay disclosure

The lexical root-cause matcher was revised **after round 1**. The original version produced false negatives for substantially correct diagnoses (camel-case names and causal paraphrases), leaving accepted-cause timing mostly null. Name normalization was corrected first; MATCHER_V2 then broadened keyword groups to causal concepts. All historical metrics below were regenerated with MATCHER_V2 from the original events and grades; model runs were not repeated for scoring changes. Hidden acceptance grading, not lexical matching, remains the correctness gate. Post-hoc matcher changes are a validity threat, even though independent paraphrase/distractor tests accompany them.

Each source trial retains events.jsonl, report.json, grade.json and recomputable metrics.json. `npx tsx src/eval/bench.ts --recompute <round directory>` re-scores without model calls. `--combine <comma-separated round directories> --output <directory>` re-scores each source and builds a combined summary with round labels and source paths; it does not overwrite as-run report statuses.

## Latest benchmarked revision — R3 (headline, N=3/mode)

Artifacts: [`results/bench/2026-09-30T16-55-51.340Z`](../results/bench/2026-09-30T16-55-51.340Z/), with [exact aggregates](../results/bench/2026-09-30T16-55-51.340Z/summary.json) and [assignment-kind totals](../results/bench/2026-09-30T16-55-51.340Z/summary.md). R3 was launched only after Main's global verification of the corrected ownership audit, symmetric one-RESULT-nudge manager behavior, and completed-implementation status rule. R3 was re-scored using MATCHER_V2 after completion. R1/R2 results below are historical, not pooled into this headline.

### Every R3 trial

| Mode | Trial | Run status | Visible / hidden | Wall ms | Requests | Nudges | Input | Output | Cache read | First useful ms | Accepted cause ms |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 1 | failed | pass / fail | 126050 | 16 | 0 | 18248 | 9766 | 52864 | 40058 | null |
| orchestrated | 1 | done | pass / pass | 144652 | 39 | 0 | 47673 | 11173 | 141824 | 30536 | 37977 |
| baseline | 2 | failed | pass / pass | 212029 | 46 | 3 | 60057 | 11919 | 107264 | 29937 | 56036 |
| orchestrated | 2 | done | pass / pass | 133394 | 35 | 0 | 40316 | 13617 | 161152 | 31444 | 39819 |
| baseline | 3 | done | pass / pass | 157234 | 39 | 0 | 48943 | 13422 | 107136 | 29787 | 64220 |
| orchestrated | 3 | done | pass / pass | 148716 | 46 | 0 | 45475 | 18043 | 272128 | 25533 | 30691 |

| Mode | Trial | Wasted requests / input / output / cache read | Reuse | Peer notes | Notes to main | Accepted-cause match |
|---|---:|---|---:|---:|---:|---|
| baseline | 1 | 3 / 448 / 1885 / 21248 | 0 | 0 | 0 | null (no acceptance) |
| orchestrated | 1 | 4 / 2388 / 1134 / 12416 | 5 | 5 | 2 | true |
| baseline | 2 | 5 / 1179 / 3994 / 46976 | 0 | 0 | 0 | true |
| orchestrated | 2 | 4 / 4243 / 1066 / 8064 | 5 | 2 | 2 | true |
| baseline | 3 | 6 / 2489 / 5825 / 55808 | 0 | 0 | 0 | true |
| orchestrated | 3 | 3 / 247 / 928 / 8064 | 6 | 3 | 1 | true |

All total and wasted cache-write counts were zero.

### R3 aggregates and variance

Mean [min, max]; population SD shown separately. Values rounded to two decimals; exact values and defined-observation counts are in summary.json. All rows have n=3 except baseline accepted-cause time (n=2).

| Metric | Baseline mean [min, max] | Baseline SD | Orchestrated mean [min, max] | Orchestrated SD |
|---|---:|---:|---:|---:|
| wallClockMs | 165104.33 [126050, 212029] | 35539.22 | 142254 [133394, 148716] | 6480.93 |
| requests | 33.67 [16, 46] | 12.81 | 40 [35, 46] | 4.55 |
| inputTokens | 42416 [18248, 60057] | 17681.43 | 44488 [40316, 47673] | 3083.50 |
| outputTokens | 11702.33 [9766, 13422] | 1500.40 | 14277.67 [11173, 18043] | 2843.31 |
| cacheRead | 89088 [52864, 107264] | 25614.29 | 191701.33 [141824, 272128] | 57415.04 |
| cacheWrite | 0 [0, 0] | 0 | 0 [0, 0] | 0 |
| timeToFirstUsefulResultMs | 33260.67 [29787, 40058] | 4806.83 | 29171 [25533, 31444] | 2599.03 |
| timeToRootCauseMs | 60128 [56036, 64220] | 4092 | 36162.33 [30691, 39819] | 3941.22 |
| wasted.requests | 4.67 [3, 6] | 1.25 | 3.67 [3, 4] | 0.47 |
| wasted.inputTokens | 1372 [448, 2489] | 844.34 | 2292.67 [247, 4243] | 1632.75 |
| wasted.outputTokens | 3901.33 [1885, 5825] | 1609.83 | 1042.67 [928, 1134] | 85.70 |
| wasted.cacheRead | 41344 [21248, 55808] | 14660.33 | 9514.67 [8064, 12416] | 2051.55 |
| wasted.cacheWrite | 0 [0, 0] | 0 | 0 [0, 0] | 0 |
| workerReuseCount | 0 [0, 0] | 0 | 5.33 [5, 6] | 0.47 |
| peerMessageCount | 0 [0, 0] | 0 | 3.33 [2, 5] | 1.25 |
| notesToMain | 0 [0, 0] | 0 | 1.67 [1, 2] | 0.47 |
| nudgeCount | 1 [0, 3] | 1.41 | 0 [0, 0] | 0 |
| Completed + visible/hidden pass | 1/3 (33.33%) | — | 3/3 (100%) | — |
| Visible pass | 3/3 (100%) | — | 3/3 (100%) | — |
| Hidden pass | 2/3 (66.67%) | — | 3/3 (100%) | — |
| Accepted-cause match | 2/2 defined, 1 null | — | 3/3 defined | — |

### R3 assignment-kind breakdown (totals across three trials per mode)

| Kind | Baseline requests | Baseline input | Baseline output | Baseline cache read | Orchestrated requests | Orchestrated input | Orchestrated output | Orchestrated cache read |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| coordinator | 6 | 12792 | 1280 | 3584 | 12 | 18630 | 1914 | 18432 |
| explore | 52 | 57778 | 30250 | 203776 | 53 | 58397 | 18343 | 127360 |
| backlog_proposal | 0 | 0 | 0 | 0 | 11 | 15227 | 6669 | 56448 |
| implement | 26 | 28470 | 2190 | 42496 | 38 | 26340 | 14787 | 368256 |
| fix | 4 | 6566 | 413 | 5120 | 0 | 0 | 0 | 0 |
| verify | 13 | 21642 | 974 | 12288 | 6 | 14870 | 1120 | 4608 |

The 19 extra orchestration requests (120 versus 101) decompose into +6 coordinator, +1 explore, +11 backlog proposals, +12 implementation, −4 fix and −7 verification. Extra output concentrates in backlog proposals (6669 additional tokens) and implementation (14787 versus 2190), despite exploration emitting 11907 fewer output tokens. Implementation also dominates orchestration cache reads (368256 versus 42496 baseline), consistent with retained exploration/proposal context being consumed during implementation. This association is not a controlled causal attribution.

Baseline's post-claim redundant exploration consumed 14 requests, 4116 input, 11704 output and 124032 cache-read tokens. Orchestration consumed 11 requests, 6878 input, 3128 output and 28544 cache-read tokens there: 21.43% fewer requests, 73.27% less output and 76.99% fewer cache reads, **but 67.10% more uncached input**. Reduced exploration waste therefore does not mean every resource category improves.

### R3 failures, wins/losses and success criterion 9

Baseline-1 exhausted the bounded exploration wait for baseline-explore-2 (explorer-cause route), so no root cause was integrated and no fix was attempted; hidden grading failed. Its first matching worker claim still exists, so first-useful timing is defined while accepted-cause timing is null. The underlying timeout cause is unknown: no provider error/429 was recorded, so this was not classified as an evidenced infrastructure outage or replaced.

Baseline-2's patch passed hidden and visible grading, but its independent verifier twice reported that the visible suite had not been run. The one allowed fix round did not cure that validation failure, so the runner correctly remained failed. Three bounded RESULT nudges occurred on the first verifier, fixer and second verifier assignments; they obtained explicit results but did not ensure actual validation. Orchestration needed zero nudges in this small round. These observations do not establish that nudges caused the reliability difference.

**Latency/correctness wins, resource-proxy losses:** R3 orchestration completed and graded correctly 3/3 versus baseline 1/3. Mean recorded latency was 13.84% lower, first-useful time 12.30% lower, and accepted-cause time 39.86% lower (the latter compares n=3 against n=2). The all-run mean includes failures and incomplete work; it is not a clean equal-success benchmark. Mean requests were 18.81% higher, input 4.88% higher, output 22.01% higher, and cache reads 115.18% higher. No monetary-cost improvement is claimed.

**Criterion 9 verdict, based only on R3: met narrowly by observed latency on problem A.** Trial 3 is the one paired comparison where both modes completed and passed both grading suites: 148716 ms orchestrated versus 157234 ms baseline, an 8518 ms (5.42%) reduction. This is an actual live Pi/provider workload on the provided synthetic task, not a production-repository result. Only one equal-success pair supports that narrow claim; N=3 does not establish statistical significance or generalization. The baseline failures are retained and not repurposed as speed wins. R1/R2 results are not used to justify this current-revision verdict.

## Historical revisions — not the current-revision headline

- **R1, pre ownership-audit correction:** `results/bench/2026-09-30T16-12-45.096Z`. The audit incorrectly flagged same-owner writes into another task's file.
- **R2, corrected worker-owned-files audit but pre RESULT-nudge/status fixes:** `results/bench/2026-09-30T16-34-34.688Z`. A missing implementation status could block a genuinely completed task; no RESULT nudge existed.
- [Historical combined N=6/mode artifacts](../results/bench/combined-2026-09-30/summary.md) aggregate **mixed revisions**. They must not be presented as the performance or reliability of one current implementation.

### Every historical trial

| Round | Mode | Trial | As-run status | Visible / hidden | Wall ms | Requests | Input | Output | Cache read | First useful ms | Accepted cause ms |
|---:|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | baseline | 1 | done | pass / pass | 146994 | 38 | 48565 | 15045 | 116480 | 36231 | 68806 |
| 1 | orchestrated | 1 | done | pass / pass | 125990 | 42 | 46650 | 15609 | 240512 | 24765 | 29968 |
| 1 | baseline | 2 | done | pass / pass | 118362 | 35 | 49038 | 11823 | 72448 | 27471 | 57934 |
| 1 | orchestrated | 2 | failed | pass / pass | 127435 | 51 | 49929 | 19656 | 429440 | 49553 | 57594 |
| 1 | baseline | 3 | done | pass / pass | 169883 | 32 | 39602 | 13896 | 88192 | 37733 | 74641 |
| 1 | orchestrated | 3 | done | pass / pass | 140204 | 46 | 46219 | 18677 | 314624 | 33242 | 40439 |
| 2 | baseline | 1 | done | pass / pass | 196388 | 42 | 53711 | 16681 | 141440 | 37930 | 83583 |
| 2 | orchestrated | 1 | failed | pass / pass | 90189 | 35 | 40973 | 16348 | 191232 | 41019 | 46708 |
| 2 | baseline | 2 | done | pass / pass | 219442 | 50 | 53844 | 23077 | 217088 | 34915 | 83833 |
| 2 | orchestrated | 2 | failed | pass / fail | 41437 | 23 | 22517 | 7768 | 55808 | 31656 | 38184 |
| 2 | baseline | 3 | done | pass / pass | 147934 | 38 | 45902 | 15062 | 108544 | 24371 | 50287 |
| 2 | orchestrated | 3 | done | pass / pass | 133964 | 38 | 40068 | 16664 | 284416 | 36277 | 45171 |

All historical cache-write totals and nudge counts were zero. All twelve accepted diagnoses match MATCHER_V2; root-cause telemetry must not be confused with the one failed hidden grade.

### Historical aggregates and variance (mixed revisions, N=6/mode)

Values are mean [min, max], rounded to two decimals. Each measurement has six observations; exact SDs and all per-run behavior metrics are in the linked historical summary.

| Metric | Baseline | Orchestrated |
|---|---:|---:|
| wallClockMs | 166500.50 [118362, 219442] | 109869.83 [41437, 140204] |
| requests | 39.17 [32, 50] | 39.17 [23, 51] |
| inputTokens | 48443.67 [39602, 53844] | 41059.33 [22517, 49929] |
| outputTokens | 15930.67 [11823, 23077] | 15787 [7768, 19656] |
| cacheRead | 124032 [72448, 217088] | 252672 [55808, 429440] |
| cacheWrite | 0 [0, 0] | 0 [0, 0] |
| timeToFirstUsefulResultMs | 33108.50 [24371, 37930] | 36085.33 [24765, 49553] |
| timeToRootCauseMs | 69847.33 [50287, 83833] | 43010.67 [29968, 57594] |
| wasted.requests | 6 [4, 9] | 3.67 [2, 5] |
| wasted.inputTokens | 3021.50 [1060, 5397] | 2670 [0, 7008] |
| wasted.outputTokens | 6932.50 [4239, 11401] | 947.17 [0, 2222] |
| wasted.cacheRead | 62570.67 [29184, 112640] | 10048 [0, 23424] |
| wasted.cacheWrite | 0 [0, 0] | 0 [0, 0] |
| workerReuseCount | 0 [0, 0] | 4.67 [3, 5] |
| peerMessageCount | 0 [0, 0] | 3.17 [1, 6] |
| notesToMain | 0 [0, 0] | 1.83 [1, 3] |
| nudgeCount | 0 [0, 0] | 0 [0, 0] |
| Completed + visible/hidden pass | 6/6 (100%) | 3/6 (50%) |
| Visible pass | 6/6 (100%) | 6/6 (100%) |
| Hidden pass | 6/6 (100%) | 5/6 (83.33%) |
| Accepted-cause lexical match | 6/6 (100%) | 6/6 (100%) |

Historical wall-time SD was 33,541.12 ms baseline and 34,495.10 ms orchestrated. The nominal 34.01% all-run latency reduction is heavily confounded by early failures. On the three completed, grading-passing matched pairs, orchestration averaged 133,386 ms versus 154,937 ms baseline (13.91% lower), but that selects successful runs. Those pairs used 16.67% more requests and 15.79% more output tokens, with 168.04% more cache reads. These are descriptive historical observations, not the verdict on the current revision.

### Historical assignment-kind usage (totals across six trials per mode)

| Kind | Baseline requests | Baseline input | Baseline output | Baseline cache read | Orchestrated requests | Orchestrated input | Orchestrated output | Orchestrated cache read |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| coordinator | 18 | 41214 | 3786 | 18432 | 21 | 36238 | 3485 | 26624 |
| explore | 106 | 110655 | 72685 | 504832 | 120 | 137197 | 48645 | 359040 |
| backlog_proposal | 0 | 0 | 0 | 0 | 25 | 19267 | 10250 | 141056 |
| implement | 87 | 100868 | 16807 | 193792 | 59 | 32119 | 30742 | 978560 |
| fix | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| verify | 24 | 37925 | 2306 | 27136 | 10 | 21535 | 1600 | 10752 |

Both modes recorded 235 requests overall, but fewer orchestration implementation/verification requests partly reflect unfinished work. Orchestration added 25 backlog-proposal requests and 10,250 output tokens, while implementation emitted 30,742 output tokens versus 16,807 baseline and dominated orchestration cache reads (978,560). Baseline exploration emitted 72,685 output tokens versus 48,645 orchestrated. Baseline post-claim wasted exploration alone consumed 36 requests, 41,595 output tokens and 375,424 cache-read tokens; orchestration recorded 22 requests, 5,683 output tokens and 60,288 cache-read tokens in that category. Thus early convergence reduced redundant exploration without guaranteeing lower end-to-end resource use. All phase totals reconcile exactly with run usage totals.

### Historical failures and audit-corrected classification

**R1 orchestrated-2 remains as-run failed.** Its three flagged writes were all A3 writing test/service.test.js, owned by A3's dependent regression task. Saved events show verification passed and state reached DONE; visible/hidden grading passed. Under the corrected worker-owned-files audit, the audit-corrected classification is **done** [INFERENCE] (counterfactual, not a rerun). Evidence is separately stored in `orchestrated-2/audit-correction.json`; original report.json and aggregate as-run correctness remain unchanged. Counting this counterfactual would yield 4/6 historical orchestrated completed-and-graded runs, not the reported as-run 3/6.

**R2 orchestrated-1 failed with Backlog blocked**, despite passing both grade suites. Its second implement outcome was completed and documented that regression coverage already existed, but omitted data.status. The old coordinator marked it blocked; the current status rule fixes this interpretation. It did not reach independent verification, so it is not retrospectively promoted to completion.

**R2 orchestrated-2 failed on backlog_proposal A1: no_result** with empty lastText, before implementation; hidden grading failed. No provider error/429 was recorded. The bounded RESULT nudge addresses this missing explicit-completion case in both runners. Neither R2 failure was an evidenced infrastructure outage; neither was replaced.

## Threats to validity

This is one small synthetic fixture, not a production-repository benchmark. N=3/mode per revision supports descriptive observations only, not established statistical significance or generalization. Sampling, route/model mix, warm caches, provider latency, rate limits and retries affect cost/time. Interleaving reduces drift but always puts baseline first rather than counterbalancing. Code revisions differ between rounds, so pooling is historical/mixed-revision only. Failed early runs skip work and can artificially improve time/token averages. Successful-only comparisons have selection bias. Matcher revisions were post-hoc and still lexical; hidden grading is the stronger correctness gate. Requests/tokens are resource proxies: differently priced models, cached input and output tokens cannot be equated to monetary cost without a pricing calculation. Passing fixture tests does not prove universal fix correctness.

## Verification and development evidence

Scoped metric/faux-provider tests exercise all-explorer join, no peer tool, fresh sessions, bounded malformed/timeout failures, disposal, explicit blocked outcomes, null/boundary/cache accounting, late usage attribution and nudges without reuse inflation. `npx vitest run test/eval/metrics.test.ts test/eval/baseline.test.ts` passed nine tests; `npx tsc --noEmit -p .` emitted no diagnostics after the final changes. Main independently verified 68 project tests before the final-round launch.

Development baseline smoke `results/bench/2026-09-30T15-50-02.685Z` passed both grade suites (239333 ms, 87 requests) but used an earlier baseline variant and is excluded from comparative rounds. Deliberate unknown-model smoke `results/bench/2026-09-30T15-59-03.195Z` retained both failed trials with zero requests. Replay/dependency-wave details are in `results/bench/replay-verification.txt`. The benchmark's combined-report smoke and completed historical combined summaries reconcile every phase usage total with recorded run totals.
