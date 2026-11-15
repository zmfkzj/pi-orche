# Decision memory A/B with a real model

This experiment compares orche's `workerCompaction.decisionMemory` switched off (OFF) and on (ON). Both arms run real orche workers on a real model and actually compact mid-task. The model-free renderer comparison in `experiments/feature-effects/` is a separate study; its numbers are not real-model outcomes.

## Question

When a worker compacts mid-task, does decision memory change:
- task correctness,
- what the restored context keeps (evidence, unresolved failures),
- how the worker behaves after the cut,
- and its tokens, estimated cost, time and log size?

## What differs between the arms (only this)

Both arms run with `essentials: "extended"`. The only difference is `decisionMemory`. Turning it on changes two things, both reached through the real `WorkerPool` path:

1. **The restored work log.** ON restores `renderDecisionWorkLog` instead of `renderWorkLog` (`src/extension/workers.ts:540-564`).
2. **The summary request.** ON adds failure-handling rules to it (`src/pi/session-factory.ts:206`, `src/pi/summary-budget.ts:138-144`).

The test `protocol > the arms differ only in decisionMemory` asserts that the two arm configurations are otherwise identical.

## Fixed conditions

These were fixed before the main runs (`protocol.ts`).

**Model**
- `cliproxyapi/claude-opus-5-5`, thinking `high`: the user's default worker route.
- Requests go through the local CLIProxyAPI.
- The model declares a 128k window through the provider's `modelOverrides` in a private HOME.

**Compaction policy**
- orche's `absolute` worker policy: trigger at 28,000 tokens, keep the last 3,000 tokens.
- This is an EARLY trigger, so orche's preflight, loop guard and fallback apply. Every `compaction_cancelled` event is recorded.
- Why: pilot 1 used the stable 50% trigger (64k) and never compacted, because the worker finished within 36-48k tokens.

**orche settings**
- `single` mode with `spawn` and the advisor off.
- `thinkingPolicy` `fixed`.
- `limits.assignmentMs` 30 min, no extension.
- records on.

**Tasks** (`project.ts`)
- A generated, dependency-free JS library, "ledgerlib", about 56k tokens: 9 modules, a 29 KB spec and 369 tests.
- `bugfix`: 8 spec violations. 6 are visible as failing tests. 2 are spec-only. Hidden tests also check rules the visible tests do not cover.
- `feature`: implement `exportCsv` from SPEC §7 and fix 4 pre-existing lint violations.

**Grading**
- Hidden acceptance tests (20 for bugfix, 14 for feature) are written outside the workspace after the worker ends.
- The visible suite must pass, lint must pass (feature only), and `test/` and `tools/` must be unchanged.
- The self-test grades the reference solution 100% and the start state as failing.

**Schedule and retries**
- (task, repeat) pairs in repeat-major order. The arm order inside each pair is randomized with a seed and recorded in `plan-*.json`.
- 4 runs in parallel, so both arms of a pair run at about the same time.
- Same fixture digest in every run.
- Retry rule: infrastructure failures only, once. No run needed a retry.
- Cost cap: 80 USD per study (catalog estimate).

**Isolation** (`driver.ts`)
- Each run gets its own process and temp dir, with a private `PI_CODING_AGENT_DIR`: credentials copied, `orche.config.json` written there.
- Private HOME: the provider config with the window override, plus a copy of its model cache.
- Private TMPDIR and XDG directories. No `PI_*`, `ORCHE_*` or `XDG_*` variable is inherited.
- orche runs from a frozen `git archive` of HEAD (`4d33c72`) plus a frozen copy of this harness.
- The user's settings, caches, records and installation are never written.

## Commands

```bash
npx vitest run test/experiments/decision-memory-ab.test.ts     # model-free: graders, analysis, protocol, statistics
npx tsx experiments/decision-memory-ab/driver.ts results/decision-memory-ab/main.json      # 20 runs, linkage off
npx tsx experiments/decision-memory-ab/driver.ts results/decision-memory-ab/linkage.json   # 12 runs, evidence linkage "warn"
npx tsx experiments/decision-memory-ab/summarize.ts results/decision-memory-ab/<study>     # summary.json / summary.md
```

`summarize.ts` re-runs `analyze.ts` on each run's records. Its output:
- per-run rows
- per-arm aggregates
- per-pair differences (ON − OFF)
- an exact two-sided Wilcoxon signed-rank test and a bootstrap 95% CI of the mean pair difference

## Metrics (`analyze.ts`)

Every metric is taken at each actual compaction ("cut").

**Restored log, by kind and size**
- The work-log section is `Work log of this assignment` in OFF and `Decision-linked work evidence` in ON.
- Sizes are UTF-8 bytes of the work log, the whole essentials message and Pi's summary.

**Retention, counted three separate ways**
- **shown:** the restored log names the call.
- **recovered:** after the cut, the worker re-read a file it had already read before the cut.
- **resolved:** an unresolved failure later succeeds with the same tool and target.

**Evidence categories**
- Unresolved failures at the cut. Failing project checks (npm test / lint) are counted separately.
- Calls cited by Task DAG checkpoints that existed at the cut.
- Evidence the worker wrote after the cut that points back to calls made before it.

**Tokens and cost**
- Token usage of every assistant response, plus the compaction summary usage taken from the compaction entry.
- Estimated cost: Pi's `usage.cost`, computed from catalog prices (`totalFromProvider: false`). No response lacked a price.
- Billed cost is not available: the proxy reports no billing.

## Results (2026-11-14)

The OFF and ON runs had identical settings except `decisionMemory`.

**Main study** (evidence linkage off, the user's configuration): 2 tasks × 5 pairs = 20 runs.

| | OFF | ON |
|---|---|---|
| success (all criteria) | 10/10 | 10/10 |
| compactions (cancelled by loop guard) | 42 (1) | 36 (2) |
| work log, bytes per compaction | 3,929 | 2,187 (−44%) |
| essentials, bytes per compaction | 5,367 | 3,482 (−35%) |
| summary, bytes per compaction | 10,324 | 9,828 |
| unresolved failures shown | 36/36 | 11/43 |
| failing checks shown | 5/5 | 2/7 |
| checkpoint-cited calls shown | 159/239 (67%) | 22/133 (17%) |
| evidence cited later, still shown | 171/178 (96%) | 86/159 (54%) |
| re-reads after compactions | 45 | 35 |
| estimated cost, total (median) | $21.03 ($2.01) | $19.22 ($1.78) |
| wall time, median | 320 s | 281 s |
| requests, median | 24 | 27 |

Paired differences (ON − OFF, n = 10):

| Metric | Mean | ON lower / higher | Wilcoxon p | Bootstrap 95% |
|---|---|---|---|---|
| Cost | −$0.18 | 6 / 4 | 0.49 | [−0.62, 0.30] |
| Wall time | −22 s | 6 / 4 | 0.43 | [−89, 49] |
| Requests | +3.2 | 3 / 6 | 0.13 | [−0.1, 6.6] |
| Compactions | −0.6 | 6 / 4 | 0.56 | — |

**Linkage condition** (`thinkingPolicy: { mode: "fixed", evidence: "warn" }` in both arms): 2 tasks × 3 pairs = 12 runs.

This condition was added after the main study. In the main study no checkpoint evidence used a `T<n>` reference (0 items), because the fixed policy's default `evidence: "off"` attaches no `[orche ref T<n>]` to tool results. With linkage on, 83 of 114 evidence items cited references (main study: 0 of 227).

| | OFF | ON |
|---|---|---|
| success | 6/6 | 6/6 |
| compactions (cancelled) | 24 (1) | 18 (1) |
| work log, bytes per compaction | 3,732 | 2,466 |
| essentials, bytes per compaction | 5,329 | 3,796 |
| unresolved failures shown | 16/16 | 8/30 |
| failing checks shown | 1/1 | 3/12 |
| checkpoint-cited calls shown | 51/85 (60%) | 22/40 (55%) |
| evidence cited later, still shown | 55/67 (82%) | 24/30 (80%) |
| estimated cost, total | $12.65 | $9.85 |

Paired differences (n = 6): cost −$0.47 (p 0.69), wall time −73 s (p 0.69). Per task:
- bugfix: ON was cheaper and faster in all 3 pairs.
- feature: ON was more expensive in all 3 pairs.

### Per-run results

The "hidden" column counts hidden tests passed. Every run also passed the visible suite and (feature) lint, and left `test/` and `tools/` unchanged.

**Main study**

| run | hidden | wall s | req | est $ | cuts (cancelled) | work-log B | essentials B | summary B | unresolved shown | failing checks shown | cited shown | later-cited shown | re-reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bugfix/off/r1 | 20/20 | 493 | 27 | 3.17 | 7 (0) | 26701 | 37689 | 76759 | 7/7 | 0/0 | 41/55 | 50/51 | 6 |
| bugfix/off/r2 | 20/20 | 428 | 29 | 2.65 | 5 (0) | 21765 | 32034 | 56060 | 5/5 | 0/0 | 21/36 | 19/19 | 0 |
| bugfix/off/r3 | 20/20 | 307 | 24 | 1.78 | 3 (0) | 10460 | 15492 | 35673 | 0/0 | 0/0 | 6/9 | 6/7 | 0 |
| bugfix/off/r4 | 20/20 | 399 | 28 | 2.46 | 5 (0) | 20753 | 29409 | 56572 | 0/0 | 0/0 | 21/35 | 19/20 | 2 |
| bugfix/off/r5 | 20/20 | 451 | 30 | 2.62 | 5 (0) | 23182 | 30596 | 62486 | 5/5 | 5/5 | 23/39 | 28/30 | 4 |
| bugfix/on/r1 | 20/20 | 394 | 30 | 2.15 | 4 (0) | 9578 | 15410 | 44089 | 4/9 | 0/0 | 1/9 | 12/17 | 0 |
| bugfix/on/r2 | 20/20 | 388 | 34 | 2.59 | 4 (1) | 8898 | 14234 | 40027 | 0/0 | 0/0 | 0/0 | 12/18 | 6 |
| bugfix/on/r3 | 20/20 | 470 | 37 | 2.89 | 6 (0) | 12071 | 20693 | 65923 | 3/11 | 2/7 | 6/37 | 4/32 | 4 |
| bugfix/on/r4 | 20/20 | 495 | 36 | 2.93 | 6 (0) | 13396 | 21187 | 69521 | 2/6 | 0/0 | 4/16 | 13/23 | 3 |
| bugfix/on/r5 | 20/20 | 298 | 29 | 1.78 | 3 (0) | 7318 | 11912 | 31491 | 1/4 | 0/0 | 1/19 | 19/21 | 1 |
| feature/off/r1 | 14/14 | 265 | 24 | 1.94 | 4 (0) | 15332 | 19823 | 34797 | 6/6 | 0/0 | 14/26 | 27/28 | 11 |
| feature/off/r2 | 14/14 | 299 | 24 | 1.92 | 4 (0) | 14122 | 16830 | 39784 | 4/4 | 0/0 | 0/0 | 0/0 | 10 |
| feature/off/r3 | 14/14 | 333 | 22 | 2.08 | 5 (0) | 21005 | 27990 | 43243 | 5/5 | 0/0 | 26/30 | 2/2 | 3 |
| feature/off/r4 | 14/14 | 167 | 16 | 0.95 | 2 (0) | 5958 | 8454 | 15117 | 2/2 | 0/0 | 7/9 | 4/5 | 1 |
| feature/off/r5 | 14/14 | 173 | 19 | 1.47 | 2 (1) | 5750 | 7104 | 13097 | 2/2 | 0/0 | 0/0 | 16/16 | 8 |
| feature/on/r1 | 14/14 | 163 | 20 | 1.40 | 2 (1) | 3528 | 5466 | 11148 | 0/2 | 0/0 | 0/4 | 6/16 | 8 |
| feature/on/r2 | 14/14 | 180 | 19 | 1.06 | 2 (0) | 4670 | 6967 | 15677 | 1/2 | 0/0 | 3/9 | 3/4 | 2 |
| feature/on/r3 | 14/14 | 198 | 22 | 1.13 | 2 (0) | 4044 | 6673 | 15342 | 0/0 | 0/0 | 2/7 | 2/2 | 3 |
| feature/on/r4 | 14/14 | 244 | 23 | 1.79 | 4 (0) | 9201 | 13001 | 32729 | 0/4 | 0/0 | 3/12 | 12/15 | 7 |
| feature/on/r5 | 14/14 | 263 | 25 | 1.50 | 3 (0) | 6042 | 9823 | 27863 | 0/5 | 0/0 | 2/20 | 3/11 | 1 |

**Linkage condition**

| run | hidden | wall s | req | est $ | cuts (cancelled) | work-log B | essentials B | summary B | unresolved shown | failing checks shown | cited shown | later-cited shown | re-reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bugfix/off/r1 | 20/20 | 437 | 32 | 2.56 | 5 (0) | 19682 | 26491 | 60470 | 6/6 | 0/0 | 13/19 | 8/10 | 2 |
| bugfix/off/r2 | 20/20 | 704 | 38 | 4.39 | 9 (0) | 35478 | 53373 | 111176 | 1/1 | 0/0 | 16/34 | 27/35 | 13 |
| bugfix/off/r3 | 20/20 | 387 | 27 | 2.28 | 4 (0) | 16523 | 22131 | 51496 | 6/6 | 0/0 | 9/17 | 15/15 | 3 |
| bugfix/on/r1 | 20/20 | 324 | 28 | 1.83 | 3 (0) | 7397 | 12591 | 31362 | 0/3 | 0/0 | 6/15 | 7/7 | 6 |
| bugfix/on/r2 | 20/20 | 323 | 26 | 1.94 | 4 (0) | 9685 | 14436 | 41962 | 3/6 | 0/0 | 0/0 | 0/0 | 1 |
| bugfix/on/r3 | 20/20 | 300 | 25 | 1.63 | 3 (0) | 7012 | 11730 | 32537 | 0/0 | 0/0 | 6/11 | 7/8 | 1 |
| feature/off/r1 | 14/14 | 199 | 20 | 1.14 | 2 (0) | 5726 | 9218 | 14356 | 0/0 | 0/0 | 6/7 | 0/1 | 2 |
| feature/off/r2 | 14/14 | 177 | 19 | 0.95 | 2 (0) | 5962 | 8641 | 15905 | 1/1 | 1/1 | 7/8 | 1/2 | 1 |
| feature/off/r3 | 14/14 | 146 | 18 | 1.33 | 2 (1) | 6186 | 8044 | 11668 | 2/2 | 0/0 | 0/0 | 4/4 | 6 |
| feature/on/r1 | 14/14 | 328 | 31 | 1.97 | 4 (0) | 11535 | 17484 | 37198 | 4/16 | 3/12 | 10/14 | 5/8 | 6 |
| feature/on/r2 | 14/14 | 185 | 23 | 1.09 | 2 (0) | 5163 | 7145 | 14354 | 1/3 | 0/0 | 0/0 | 5/7 | 3 |
| feature/on/r3 | 14/14 | 154 | 20 | 1.38 | 2 (1) | 3594 | 4948 | 10523 | 0/2 | 0/0 | 0/0 | 0/0 | 8 |

**Pilots** are excluded from all results above.
- Pilot 1 (stable 64k trigger, 2 runs) never compacted.
- Pilot 2 (4 runs) checked the protocol: compaction succeeded, essentials were restored with the right work-log kind, and the worker made further requests and fixed work after the cut.

**Total estimated spend: $71.21** across 38 runs. Pilots $1.43 and $7.03, main study $40.25, linkage condition $22.50. These are catalog prices, not billed amounts.

## Interpretation and limits

**Correctness: no difference measured.** Every run passed in both arms (32/32), so these tasks hit the ceiling and cannot show a correctness effect either way.

**Restored context**

*Measured, consistently:*
- ON restores a smaller work log: −35% to −44% bytes per compaction.
- ON drops stale noise: of 29 unresolved `git status` failures (the workspace is not a git repository), ON names 3. OFF names all 17 of its own, at every compaction.

*Measured, also consistently:*
- ON names far fewer unresolved failures (19/73 against 52/52). Leaving out the `git status` noise, it still hides 14 of 19 failing project checks (npm test or lint) and 14 of 25 other unresolved failures. OFF names all of them (6/6 and 29/29).
- The hidden failing checks did not change the outcome: those workers re-ran the checks and passed.
- In the user's configuration (linkage off), ON names far fewer of the calls the worker later cited (54% against 96%).
- ON's checkpoint-citation selection matches only `T<n>` references. Without evidence linkage, no checkpoint uses them, so that part of decision memory does nothing in the default configuration.
- With linkage on, ON's retention is close to OFF's (80% against 82%) at about 30% fewer bytes.

**Cost, time and requests: no significant difference.** Paired differences point both ways and every 95% interval includes 0. There are signs of task dependence: in the linkage condition, all 3 bugfix pairs favoured ON and all 3 feature pairs favoured OFF.

**Limits**
- Only 2 synthetic task families, one model, n = 10 + 6 pairs.
- The compaction trigger was made earlier (28k) to force compaction in tasks of ordinary size. The user's real setting compacts at 50% of a 1M window.
- Prompt caching at the proxy and provider, and concurrent pairs, can shift costs.
- Re-reads and later citations are behavioural proxies, not ground truth for what the model "remembered".
