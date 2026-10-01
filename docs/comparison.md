# omp + om-orche vs pi + pi-orche: final comparison

## Scope and method

Twenty diverse task instructions were executed once per system in fresh, visible-only workspaces on 2026-09-30 (40 original executions), plus one post-fix Pi rerun of a3-refactor-tax. No additional solver calls were made to finish this report. The suite uses three zero-dependency Node ESM JavaScript repositories: checkout/cart/auth (a), HTTP/router/static files (b), and log-processing CLI (c). “Language” below means **instruction language**, not programming language: 16 English and 4 Korean instructions. Categories are analysis, bugfix, docs, feature, migration, performance, refactor, review, robustness, tests, and trivial. Fixtures and reference overlays live in [fixtures/suite](../fixtures/suite).

The same task.json instruction was supplied to both systems. Hidden tests, rubrics, and reference overlays never entered solver workspaces. Enabled checks comprise visible node --test, separately overlaid hidden tests, custom graders, blind all-items-required rubric judgments, and mustNotModify for read-only tasks. A pass requires runner completion, every enabled check, and valid captured model/effort. Rubric judging uses openai/gpt-6.1-sol at high; its requests and tokens are **excluded** from all system totals. Initial global concurrency was four; system order alternated by task. Each task had its recorded deadline and process-group outer timeout.

### Exact systems and instrumentation

- **omp + om-orche:** installed omp **18.4.4**, installed om-orche at /home/arthur/Code/oh-my-omp-plugins/om-orche. Invocation: bun --preload <run>/provider-observer.mjs /home/arthur/.bun/bin/omp -p <instruction> --cwd <workspace> --model openai-codex/gpt-6.1-sol --thinking high --config <run>/overlay.json --session-dir <run>/sessions --no-title --approval-mode yolo --mode json --max-time <task timeoutSec>. **PI_CODEX_WEBSOCKET=0** forced SSE. Per-run overlay sets defaultThinkingLevel high and every model role (default, task, smol, slow, plan, advisor, orche-advisor, verification-auditor, vision, commit, tiny, memory, image, web, speech, dictation, judge) to openai-codex/gpt-6.1-sol:high; modelFallback=false and all fallback chains empty. Workspace-local plugin overrides enable om-orche, disable omp-daybreak-delegate, and disable telemetry, without modifying global plugin/config state or copying credentials.
- **pi + pi-orche:** Pi SDK **0.99.1**, this repository's runOrchestrated via npx tsx src/eval/pi-runner.ts --child <run>/runner-input.json --result <run>/runner-result.json. Default and every explicit route (coordinator, explorer-path, explorer-cause, explorer-repro, verifier, implementer, answer) use **openai/gpt-6.1-sol, thinking high**. Exact routes, commands, versions, task hashes, and source/config SHA-256 revisions are preserved in each meta.json. Pi taskClass is reported per run rather than inferred from fixture category.

Provider-boundary records, not configuration alone, establish **every one of 1,397 captured sent requests across all 41 executions used gpt-6.1-sol/high** (omp 1,010; Pi 387 including 16 from its first a3 attempt). Latest attempts contain 1,381 sent requests. Omp's observer captures the decoded physical fetch body and final response usage, including unpersisted advisor/auditor calls; Pi captures its public ModelRuntime payload callback, endpoint, and response usage. There were **17 enforced omp task-label/title calls and zero blocked requests**; Pi had zero enforced or blocked calls. Omp's native task-label path disables reasoning independently of --no-title; the observer rewrote absent/non-high effort to high before dispatch, preserving other payload fields. These calls remain charged to omp's request/token totals. This does not represent an installed source patch.

Captured serving backends are **different**: omp uses chatgpt.com /backend-api/codex/responses (ChatGPT Codex OAuth); Pi uses api.openai.com /v1/responses. Therefore the traces do **not** establish the same backend endpoint, despite the same model name. Common underlying model hosting cannot be inferred from host/path alone. No endpoint query, authorization header, or credential is included in the evidence.

## Latest-attempt results

| Task | Category / language | System | Pass | Wall s | Requests | Known input | Known output | Known cacheRead | Unknown | Pi taskClass | Revision |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| a1-rounding † | bugfix / en | omp | PASS | 420.21 | 68 | 116748 | 12873 | 692352 | 1 | — | 6540d8fee524 |
| a1-rounding | bugfix / en | pi | PASS | 229.86 | 20 | 26024 | 4734 | 44160 | 0 | change | 6540d8fee524 |
| a2-discount-codes † | feature / en | omp | PASS | 467.08 | 69 | 131279 | 13010 | 788096 | 1 | — | 6540d8fee524 |
| a2-discount-codes | feature / en | pi | PASS | 229.91 | 16 | 27836 | 4738 | 38144 | 0 | change | 6540d8fee524 |
| a3-refactor-tax | refactor / en | omp | PASS | 297.26 | 48 | 72105 | 8557 | 427136 | 1 | — | 6540d8fee524 |
| a3-refactor-tax | refactor / en | pi | PASS | 202.74 | 15 | 43006 | 4036 | 19328 | 0 | change | cdde0fa33460 |
| a4-tests-fx | tests / en | omp | PASS | 293.22 | 38 | 56582 | 8864 | 279040 | 1 | — | 6540d8fee524 |
| a4-tests-fx | tests / en | pi | PASS | 205.97 | 14 | 29190 | 4709 | 33152 | 0 | change | 6540d8fee524 |
| a5-refund-explain-ko | analysis / ko | omp | PASS | 165.71 | 34 | 44829 | 4406 | 255360 | 1 | — | 6540d8fee524 |
| a5-refund-explain-ko | analysis / ko | pi | PASS | 115.1 | 7 | 9771 | 2607 | 8448 | 0 | answer | 6540d8fee524 |
| a6-typo-message | trivial / en | omp | PASS | 82.98 | 25 | 51917 | 1765 | 107776 | 0 | — | 6540d8fee524 |
| a6-typo-message | trivial / en | pi | PASS | 72.28 | 12 | 12694 | 1040 | 12032 | 0 | change | 6540d8fee524 |
| a7-auth-rotation † | bugfix / en | omp | PASS | 527.33 | 65 | 117869 | 14026 | 963968 | 1 | — | 6540d8fee524 |
| a7-auth-rotation | bugfix / en | pi | PASS | 339.26 | 35 | 84768 | 8386 | 221440 | 2 | diagnose_fix | 6540d8fee524 |
| b1-static-traversal † ‡ | bugfix / en | omp | PASS | 451.23 | 70 | 86267 | 14662 | 872448 | 1 | — | 6540d8fee524 |
| b1-static-traversal ‡ | bugfix / en | pi | PASS | 292.48 | 27 | 37387 | 6184 | 98816 | 1 | diagnose_fix | 6540d8fee524 |
| b2-patch-endpoint | feature / en | omp | PASS | 323.62 | 44 | 75731 | 10773 | 405376 | 1 | — | b8b548187767 |
| b2-patch-endpoint | feature / en | pi | PASS | 219.36 | 18 | 48443 | 4541 | 37760 | 0 | change | b8b548187767 |
| b3-pagination | bugfix / ko | omp | PASS | 375.44 | 71 | 87904 | 10813 | 837632 | 1 | — | b8b548187767 |
| b3-pagination | bugfix / ko | pi | PASS | 264.44 | 23 | 39891 | 5529 | 66304 | 1 | diagnose_fix | b8b548187767 |
| b4-router-review | review / en | omp | PASS | 148.44 | 21 | 49456 | 4086 | 118144 | 1 | — | b8b548187767 |
| b4-router-review | review / en | pi | PASS | 98.25 | 7 | 12563 | 2245 | 10240 | 0 | answer | b8b548187767 |
| b5-ctx-migration | migration / en | omp | PASS | 344.49 | 46 | 109313 | 10203 | 480512 | 1 | — | b8b548187767 |
| b5-ctx-migration | migration / en | pi | PASS | 343.68 | 35 | 59211 | 8378 | 97920 | 0 | change | b8b548187767 |
| b6-route-cache † | performance / en | omp | PASS | 373.99 | 58 | 76964 | 9993 | 521344 | 1 | — | b8b548187767 |
| b6-route-cache | performance / en | pi | PASS | 201.29 | 17 | 32793 | 4460 | 34048 | 0 | change | b8b548187767 |
| b7-api-docs | docs / en | omp | PASS | 385.92 | 72 | 143734 | 13433 | 889600 | 1 | — | cdde0fa33460 |
| b7-api-docs | docs / en | pi | FAIL | 370.71 | 19 | 53678 | 9081 | 60032 | 0 | change | cdde0fa33460 |
| c1-timezone | bugfix / en | omp | PASS | 369.83 | 60 | 117576 | 10858 | 677248 | 1 | — | cdde0fa33460 |
| c1-timezone | bugfix / en | pi | PASS | 323.55 | 25 | 43261 | 6781 | 95488 | 1 | diagnose_fix | cdde0fa33460 |
| c2-since-flag-ko | feature / ko | omp | PASS | 446.45 | 53 | 77277 | 12033 | 595456 | 1 | — | cdde0fa33460 |
| c2-since-flag-ko | feature / ko | pi | PASS | 278.32 | 19 | 35214 | 6481 | 64128 | 0 | change | cdde0fa33460 |
| c3-rootcause-report-ko | analysis / ko | omp | PASS | 124.09 | 22 | 30688 | 3045 | 143360 | 1 | — | cdde0fa33460 |
| c3-rootcause-report-ko | analysis / ko | pi | PASS | 98.33 | 7 | 13512 | 2146 | 7296 | 0 | answer | cdde0fa33460 |
| c4-malformed-lines | robustness / en | omp | PASS | 279.38 | 52 | 99224 | 8160 | 497280 | 1 | — | cdde0fa33460 |
| c4-malformed-lines | robustness / en | pi | PASS | 205.41 | 18 | 30050 | 4313 | 47616 | 0 | change | cdde0fa33460 |
| c5-aggregate-perf | performance / en | omp | PASS | 279.29 | 52 | 56929 | 8990 | 572544 | 1 | — | cdde0fa33460 |
| c5-aggregate-perf | performance / en | pi | PASS | 320.77 | 19 | 49672 | 7370 | 46976 | 0 | change | cdde0fa33460 |
| c6-csv-export | feature / en | omp | PASS | 335.69 | 42 | 84782 | 9307 | 371968 | 1 | — | cdde0fa33460 |
| c6-csv-export | feature / en | pi | PASS | 237.26 | 18 | 23312 | 5217 | 56576 | 0 | change | cdde0fa33460 |

‡ **Regraded after fixture fix (post-hoc, disclosed)**: b1 was regraded for BOTH systems against the corrected contradictory hidden criteria, without changing either saved solution. Their fixture-regraded/{grade.json,original-grade.json,meta.json} retain prior grades (omp parser-recovered FAIL; Pi original PASS), original as-run grade, corrected fixture SHA-256, and the exact disclosure label. This is a post-hoc benchmark correction; unlike Pi b7's omission, the original b1 failure contradicted the task instruction.

† **Recomputed after parser fix (no model rerun)**: gradeTask ran on the preserved workspace-final; accounting replayed provider-requests and separately parsed saved sessions without double counting them. All original grade.json, usage.json, meta.json, pair-result.json, completion events, and original triage errors remain untouched. Recovered status “done” means final assistant completion evidence plus recovered grading/accounting; original parser failures did not save the runner exit code. Their original wall times are retained, including failed post-processing overhead. Full per-check pass/fail and details, enforced/blocked request identities, and full revisions are in [summary.json](../results/compare/full-2026-09-30/summary.json) and [summary.md](../results/compare/full-2026-09-30/summary.md).

## Aggregates

The following tables select the latest attempt of each task/system pair, **including failures**. Input excludes separately reported cacheRead under the runners' normalized usage contract. Every cacheWrite total is zero. Tokens are known usage, **not full billed totals**, for both systems.

| Group | System | Pass | Mean / median wall s | Requests total / mean | Known input total / mean | Known output total / mean | Known cacheRead total / mean | Unknown |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| overall | omp | 20/20 (100%) | 324.58 / 340.09 | 1010 / 50.5 | 1687174 / 84358.7 | 189857 / 9492.85 | 10496640 / 524832 | 19 |
| overall | pi | 19/20 (95%) | 232.45 / 229.88 | 371 / 18.55 | 712276 / 35613.8 | 102976 / 5148.8 | 1099904 / 54995.2 | 5 |

### By fixture category

| Group | System | Pass | Mean / median wall s | Requests total / mean | Known input total / mean | Known output total / mean | Known cacheRead total / mean | Unknown |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| analysis | omp | 2/2 (100%) | 144.9 / 144.9 | 56 / 28 | 75517 / 37758.5 | 7451 / 3725.5 | 398720 / 199360 | 2 |
| analysis | pi | 2/2 (100%) | 106.71 / 106.71 | 14 / 7 | 23283 / 11641.5 | 4753 / 2376.5 | 15744 / 7872 | 0 |
| bugfix | omp | 5/5 (100%) | 428.81 / 420.21 | 334 / 66.8 | 526364 / 105272.8 | 63232 / 12646.4 | 4043648 / 808729.6 | 5 |
| bugfix | pi | 5/5 (100%) | 289.92 / 292.48 | 130 / 26 | 231331 / 46266.2 | 31614 / 6322.8 | 526208 / 105241.6 | 5 |
| docs | omp | 1/1 (100%) | 385.92 / 385.92 | 72 / 72 | 143734 / 143734 | 13433 / 13433 | 889600 / 889600 | 1 |
| docs | pi | 0/1 (0%) | 370.71 / 370.71 | 19 / 19 | 53678 / 53678 | 9081 / 9081 | 60032 / 60032 | 0 |
| feature | omp | 4/4 (100%) | 393.21 / 391.07 | 208 / 52 | 369069 / 92267.25 | 45123 / 11280.75 | 2160896 / 540224 | 4 |
| feature | pi | 4/4 (100%) | 241.21 / 233.58 | 71 / 17.75 | 134805 / 33701.25 | 20977 / 5244.25 | 196608 / 49152 | 0 |
| migration | omp | 1/1 (100%) | 344.49 / 344.49 | 46 / 46 | 109313 / 109313 | 10203 / 10203 | 480512 / 480512 | 1 |
| migration | pi | 1/1 (100%) | 343.68 / 343.68 | 35 / 35 | 59211 / 59211 | 8378 / 8378 | 97920 / 97920 | 0 |
| performance | omp | 2/2 (100%) | 326.64 / 326.64 | 110 / 55 | 133893 / 66946.5 | 18983 / 9491.5 | 1093888 / 546944 | 2 |
| performance | pi | 2/2 (100%) | 261.03 / 261.03 | 36 / 18 | 82465 / 41232.5 | 11830 / 5915 | 81024 / 40512 | 0 |
| refactor | omp | 1/1 (100%) | 297.26 / 297.26 | 48 / 48 | 72105 / 72105 | 8557 / 8557 | 427136 / 427136 | 1 |
| refactor | pi | 1/1 (100%) | 202.74 / 202.74 | 15 / 15 | 43006 / 43006 | 4036 / 4036 | 19328 / 19328 | 0 |
| review | omp | 1/1 (100%) | 148.44 / 148.44 | 21 / 21 | 49456 / 49456 | 4086 / 4086 | 118144 / 118144 | 1 |
| review | pi | 1/1 (100%) | 98.25 / 98.25 | 7 / 7 | 12563 / 12563 | 2245 / 2245 | 10240 / 10240 | 0 |
| robustness | omp | 1/1 (100%) | 279.38 / 279.38 | 52 / 52 | 99224 / 99224 | 8160 / 8160 | 497280 / 497280 | 1 |
| robustness | pi | 1/1 (100%) | 205.41 / 205.41 | 18 / 18 | 30050 / 30050 | 4313 / 4313 | 47616 / 47616 | 0 |
| tests | omp | 1/1 (100%) | 293.22 / 293.22 | 38 / 38 | 56582 / 56582 | 8864 / 8864 | 279040 / 279040 | 1 |
| tests | pi | 1/1 (100%) | 205.97 / 205.97 | 14 / 14 | 29190 / 29190 | 4709 / 4709 | 33152 / 33152 | 0 |
| trivial | omp | 1/1 (100%) | 82.98 / 82.98 | 25 / 25 | 51917 / 51917 | 1765 / 1765 | 107776 / 107776 | 0 |
| trivial | pi | 1/1 (100%) | 72.28 / 72.28 | 12 / 12 | 12694 / 12694 | 1040 / 1040 | 12032 / 12032 | 0 |

### By instruction language

| Group | System | Pass | Mean / median wall s | Requests total / mean | Known input total / mean | Known output total / mean | Known cacheRead total / mean | Unknown |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| en | omp | 16/16 (100%) | 336.25 / 340.09 | 830 / 51.88 | 1446476 / 90404.75 | 159560 / 9972.5 | 8664832 / 541552 | 15 |
| en | pi | 15/16 (93.75%) | 243.3 / 229.88 | 315 / 19.69 | 613888 / 38368 | 86213 / 5388.31 | 953728 / 59608 | 4 |
| ko | omp | 4/4 (100%) | 277.92 / 270.57 | 180 / 45 | 240698 / 60174.5 | 30297 / 7574.25 | 1831808 / 457952 | 4 |
| ko | pi | 4/4 (100%) | 189.05 / 189.77 | 56 / 14 | 98388 / 24597 | 16763 / 4190.75 | 146176 / 36544 | 1 |

### First attempt versus latest

| Group | System | Pass | Mean / median wall s | Requests total / mean | Known input total / mean | Known output total / mean | Known cacheRead total / mean | Unknown |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| first attempts (parser/fixture-corrected) | omp | 20/20 (100%) | 324.58 / 340.09 | 1010 / 50.5 | 1687174 / 84358.7 | 189857 / 9492.85 | 10496640 / 524832 | 19 |
| first attempts (parser-recovered) | pi | 18/20 (90%) | 231.69 / 229.88 | 372 / 18.6 | 698327 / 34916.35 | 102843 / 5142.15 | 1120768 / 56038.4 | 5 |
| latest attempts | omp | 20/20 (100%) | 324.58 / 340.09 | 1010 / 50.5 | 1687174 / 84358.7 | 189857 / 9492.85 | 10496640 / 524832 | 19 |
| latest attempts | pi | 19/20 (95%) | 232.45 / 229.88 | 371 / 18.55 | 712276 / 35613.8 | 102976 / 5148.8 | 1099904 / 54995.2 | 5 |

Pi a3-refactor-tax is the only different attempt: first revision 6540d8fee524, failed decomposition with four ownership violations despite passing checks, 187.51 s / 16 requests / 29,057 known input / 3,903 output / 40,192 cacheRead; post-fix attempt 2 revision cdde0fa33460 passed, 202.74 s / 15 requests / 43,006 input / 4,036 output / 19,328 cacheRead. The extra execution is excluded from latest and first pair aggregates, but retained in the all-attempt aggregate (Pi 21 executions, 387 requests) and artifacts.

## Error log and dispositions

| Error / task | Classification | Fix / revision | Rerun or recompute | Result |
|---|---|---|---|---|
| omp a1-rounding: parser rejected string message.content | Harness defect | Fixed parser accepts legitimate string system-notice/IRC content; accounting revision recorded in recomputed/meta.json | Saved-workspace grade and provider/session replay; no rerun | Visible + hidden PASS; 68 requests |
| omp a2-discount-codes: same parser error | Harness defect | Same parser fix | Same recompute | Visible + hidden PASS; 69 requests |
| omp a7-auth-rotation: same parser error | Harness defect | Same parser fix | Same recompute | Visible + hidden PASS; 65 requests |
| omp b1-static-traversal: same parser error | Harness defect, then uncovered fixture defect | Parser fixed; no omp/plugin fix | Same recompute | Initial recovered visible PASS / hidden FAIL; corrected-fixture visible + hidden PASS; 70 requests |
| omp b6-route-cache: same parser error | Harness defect | Same parser fix | Same recompute | Visible + hidden PASS; 58 requests |
| Pi a3-refactor-tax: four ownership violations although grade checks passed | Diagnosed pi-orche defect | Ownership src/** globs were treated as literal filenames; canonical directory ownership fix. Initial 6540d8fee524 → post-fix b8b548187767; rerun cdde0fa33460 | Pi-only fresh attempt 2 | PASS; initial failed execution retained |
| Pi b7-api-docs: omitted partial final page | Genuine quality failure | Verifier reviewed content but missed required pagination documentation; no fix | No rerun | Visible PASS, rubric FAIL |
| b1-static-traversal: hidden grader demanded safe dot-segment serving and exactly 400 for malformed encoding | Diagnosed shared fixture defect | Instruction explicitly says to block dot segments and only requires 4xx; corrected hidden checks accept contained serving or safe 4xx rejection and any malformed-encoding 4xx, with escape checks unchanged | BOTH saved system workspaces regraded, no model rerun; original grades retained | Both PASS under corrected fixture |

The first four parser failures used as-run revision **6540d8fee524321e87531488580d61effac2e9f7d37159ecbc71eaa8b0e4a94c**; b6 used **b8b5481877673631780b86ca0b7879f09b59fb460598fd10f10f7cdbc34c8f89**. Pi b7 and Pi a3 attempt 2 used **cdde0fa33460133dc438cd7da25a05aba7ea8abb19951b8012d8f64a0202ec08**. Both systems' b2–b6 executions used b8b548187767; b7 and all c tasks used cdde0fa33460. These are source/config content hashes, not Git commit IDs; omp's hash identifies the harness sources, not an installed omp/plugin revision. Original [triage.json](../results/compare/full-2026-09-30/triage.json) deliberately retains its as-run provisional classifications; the diagnosed dispositions above supersede them without rewriting historical evidence.

Pilot readiness errors are outside the full-run aggregates: missing SSE Content-Type caused initial capture failures (fixed by recognizing SSE directly); Pi read-only analysis timed out after its worker answered (deadline-aware caps/answer_from_worker fixed, Pi pair rerun passed); omp native cosmetic labels lacked high effort and were initially blocked (invalid pilot attempts retained, final enforced-high policy rerun passed). The selected two-task pilot and enforcement/isolation evidence remain in [pilot-proof.json](../results/compare/pilot-proof.json) and [rewrite-smoke](../results/compare/rewrite-smoke/). They are not extra trials in these tables.

## Limitations and descriptive conclusions

- **N=1 per task/system** (except one Pi-specific fix rerun), small category/language cells, no confidence interval or statistical ranking; concurrency, provider conditions, and revisions were not held fixed across every pair.
- Omp has **19 unknown-token sent requests**, normally shutdown-aborted verification-auditor calls; one run has complete usage. Pi also has **five unknown-token aborted requests across four runs**: a7-auth-rotation (2), b1-static-traversal, b3-pagination, c1-timezone (1 each); 16/20 Pi runs have complete usage. Both token totals are lower bounds. Unknown is never zero cost. Session counts represent transport scopes, not necessarily persisted AgentSession objects.
- SSE was forced for omp to capture whole-process usage; the comparison is not evidence about its default WebSocket performance. Label-call high enforcement is an instrumentation intervention, and its requests/tokens are included.
- Pi results mix pre/post ownership-fix revisions; b2 onward and a3 attempt 2 used post-fix sources. Parser recovery changes accounting/grading, not solver work or as-run revision. Parser-affected runs lack recorded exit codes/commands in original meta.json; their overlay and events remain available.
- Different serving backends are a **material fairness caveat**: wall-clock differences may partly reflect the backend, so these observations cannot isolate orchestrator overhead from provider/backend differences. No normalized dollar-cost estimate is justified.
- Rubric judgments are blind but still model judgments; judge costs excluded. Fixtures, grading, reference solutions, and harness were authored by the same project, not an external benchmark.

On these selected latest executions, **omp passed 20/20 and Pi passed 19/20** under the disclosed corrected fixture; Pi failed pagination documentation. Omp originally failed the contradictory b1 hidden criterion after parser recovery, not the instruction-compatible corrected criterion. Pi recorded lower mean/median wall time (232.45/229.88 s versus 324.58/340.09 s), fewer requests (371 versus 1,010), and lower known token totals. These are descriptive observations for this suite and configuration, not a general quality, speed, or cost superiority claim.

## Artifacts and reproducibility

- [Full summary JSON](../results/compare/full-2026-09-30/summary.json): all 41 attempts, latestRuns, first/latest/all aggregates, category/language groups; [summary Markdown](../results/compare/full-2026-09-30/summary.md): checks, timings, accounting, taskClass, and provenance.
- Per-task/system directories under [full-2026-09-30](../results/compare/full-2026-09-30) retain provider requests, events/sessions, workspaces, grades, metadata, and judge-only traces. The five affected omp directories contain recomputed/{grade.json,usage.json,sessions.json,meta.json}; each metadata file labels recovery, original error/status, original solver revision, and current accounting SHA-256. Pi's a3 rerun lives in a3-refactor-tax/pi/attempt-2.
- [Final provider/accounting proof](../results/compare/full-2026-09-30/final-proof.json) and [diagnosed dispositions](../results/compare/full-2026-09-30/final-dispositions.json) supplement, but do not replace, original records.
- [completion-events.jsonl](../results/compare/full-2026-09-30/completion-events.jsonl), [driver.log](../results/compare/full-2026-09-30/driver.log), and [triage.json](../results/compare/full-2026-09-30/triage.json) are unchanged original records. New accounting-only files for other runs are under recomputed/ and do not overwrite original usage.

Offline recovery command: npx tsx src/eval/compare.ts --recompute results/compare/full-2026-09-30 --regrade a1-rounding:omp,a2-discount-codes:omp,a7-auth-rotation:omp,b1-static-traversal:omp,b6-route-cache:omp. Fixture correction replay: npx tsx src/eval/compare.ts --recompute results/compare/full-2026-09-30 --fixture-regrade b1-static-traversal:omp,b1-static-traversal:pi. Subsequent --recompute without regrade flags reloads saved recovered and fixture-corrected grades. Neither path invokes a solver or judge; rubric/git-history snapshot regrading is refused.

Verification: actual offline recovery CLI graded all five preserved workspaces and replayed all provider traces; both b1 workspaces passed the disclosed fixture regrade, and subsequent CLI replay reloaded those saved final grades; npx vitest run test/eval passed **54 tests in 5 files**, including preserved-original recovery regression; npx tsc --noEmit -p . passed without diagnostics. No new model runs were made during recovery/reporting.
