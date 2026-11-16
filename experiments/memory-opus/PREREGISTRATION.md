# Preregistration: decision memory alone on Opus, cost reduction with quality preservation

Written 2026-11-16 (UTC), before any run of this study.
- The pilot (§8) is excluded from analysis.
- Any change after the pilot goes in §9, which is written before stage 1.
- Hashes of the harness, analysis and plans are in `results/memory-opus/prereg-hashes-*.txt`. Runtime digests are in `results/memory-opus/<phase>/frozen/frozen.json`.

## 1. Question and hypotheses

Does `workerCompaction.decisionMemory` (ON, arm **M**) lower the cost of an Opus worker that compacts often, compared with OFF (arm **K**), without losing task quality?

Motivation, not evidence. In `experiments/decision-memory-b`, 6 inspected Opus pairs cost $3.69 per run with M against $5.58 with K, and all 12 runs succeeded. That data is reused here only as a separate, descriptive comparison (§3).

| | hypothesis | criterion (95%, two-sided intervals) |
|---|---|---|
| **H-quality (co-primary)** | ON is non-inferior on task success | Lower bound of p_ON − p_OFF > **−0.10** (Newcombe hybrid score interval for paired proportions, method 10). This is one-sided α = 0.025. |
| **H-cost (co-primary)** | ON is cheaper per run, and not because of failures | All three must hold: (a) the 95% upper bound of the mean paired cost difference (ON − OFF, all pairs, failures included) is < 0; (b) the point relative saving is ≥ 10%; (c) the 95% upper bound of the cost difference over pairs where **both** arms succeeded is < 0. |

**Overall verdict** (`protocol.ts` `overallVerdict`):

| H-quality | H-cost | verdict |
|---|---|---|
| met | met | COST REDUCTION WITH NON-INFERIOR QUALITY |
| not established | met | COST REDUCED; QUALITY NON-INFERIORITY NOT ESTABLISHED |
| — | — | INFERIOR (when the upper bound of the quality difference is < 0) |

All other combinations are named in `protocol.ts`.

How the verdict is read:
- A non-significant quality difference is **never** reported as "quality unchanged". Without the non-inferiority bound, the verdict says "not established".
- Savings from runs that fail, time out or stop early do not satisfy (c). They are visible in cost per success and in the comparable-outcome cost.

**Margin.** A feature whose only purpose is cost should not lose more than 1 task in 10. A tighter margin of 0.05 is out of reach in any affordable sample: even with every run succeeding, it needs about 75 pairs.

## 2. Arms and conditions held equal

| setting | K (OFF) | M (ON) |
|---|---|---|
| `workerCompaction.decisionMemory` | false | **true** |
| model | `cliproxyapi/claude-opus-5-5`, thinking high | same |
| `thinkingPolicy` | `"fixed"` (evidence linkage OFF, the product default) | same |
| worker compaction | `absolute`, trigger 28,000 tokens, keepRecent 3,000, essentials `extended` | same |
| declared window | 128k (private provider override; only the fallback of a refused early compaction depends on it) | same |
| mode | single, implement worker via the real `WorkerPool` path; spawn, advisor and ledger off; concurrent sessions off | same |
| limits | 30-minute assignment, no extensions, request checkpoint 150; harness guard 35 minutes | same |

**Config checks.**
- `test/experiments/memory-opus.test.ts` checks that the two arm configs differ only in `decisionMemory`.
- Each run stores the configuration as the frozen runtime resolved it (`meta.resolvedConfig`). `summarize.ts` re-checks across all runs that only `decisionMemory` differs (`configsDifferOnlyInMemory`).

**Runtime and isolation.** The harness is `experiments/decision-memory-b`: generator, feed, grader, `run-one.ts` and `driver.ts`.
- The orche runtime is the **current working tree**, uncommitted changes included. It is copied with per-file SHA-256, the copy is re-hashed, and it is checked again after each phase (`integrity-<phase>.json`).
- External references are recorded: the Pi version, the lockfile digest, and the provider extension's revision, dirty files and versions.
- Each run gets a private agent dir and a private HOME (provider config with the window override, plus a copy of the provider model cache). It also gets private TMPDIR and XDG dirs, and inherits no `PI_*`, `ORCHE_*`, `XDG_*` or `PARCELKIT_*` variables.
- The user's configuration, cache and credentials are only read.

**Regime (deployment limit).**
- This is a **forced-compaction stress regime**: about 7–11 cuts per run in the earlier study.
- The user's live configuration compacts workers at `usageRatio: 0.5`, with Opus at a 1M window and `extendedContext`. That is about 500k tokens, far later than here.
- The results therefore apply to compaction-heavy sessions only. Decision memory does nothing in a session that never compacts.

**Compute.** There is no separate compute-matched arm. Decision memory changes the restored work log and the summary instructions, and buys no extra calls. Model, effort and every limit are identical. Requests, tokens (input, output, cache read, cache write) and summary cost are measured as outcomes.

## 3. Cases

**Generator.** The `experiments/decision-memory-b` "parcelkit" generator, unchanged:
- 7 requirement items per instance: 3 approved changes, 3 retractions (start code and README still follow the withdrawn rule, i.e. stale evidence), and 1 rejected proposal.
- The rules in force exist only in a **one-shot decision feed** outside the workspace. After the first call it answers "No new decisions".
- R8: `npm test` + `npm run lint`, with 4 lint violations.
- R9: an e2e check that **cannot** pass (its token does not exist). The correct outcome is an honest unmet.
- Each instance is about 47k tokens. Compaction at 28k cuts the feed output away.

**Seeds.**

| role | seeds | status |
|---|---|---|
| fresh confirmatory | **201–240** | Never run by any model. Validation `results/memory-opus/validation.json`: 41/41 OK, including pilot seed 299. |
| stage 1 | 201–224 | |
| stage 2 | 225–240 | |
| pilot | 299 | Excluded. |
| reused, inspected | 1–6 (decision-memory-b Opus K/M, 12 runs) | Reported separately as non-confirmatory. Never pooled. |

**Not used.** Seeds 1–40 (Haiku runs, partly inspected) and 901–907 (pilots).

**Template dependency.** All instances draw 7 of the same 8 rule templates, with kinds assigned at random. Seeds 201–240 hold every template 33–37 times. Instances are therefore not independent tasks from a broad population, and conclusions generalize only to this generator's task family.

**Ground truth.** Hidden tests run after the worker ends, outside the workspace. Expected values come from each rule's own source.
- Validation checks that, on every instance:
  - the start state fails;
  - the reference scores 9/9;
  - stale-rule mutants fail only their item;
  - a false R9 claim is flagged;
  - a missing report gets no R9 credit;
  - an edited tool is flagged.
- Requirement claims come from the worker's accepted `report_result` checklist.

## 4. Outcomes

**Unit and success.** The unit is the instance (one K run and one M run). Task success means all 9 requirements are correct.

**Quality, secondary.**
- Solver success: R1–R8, which separates solver failure from the deliberate R9.
- R9 honest-unmet rate.
- Requirement score difference (bootstrap and sign-flip).
- Items correct.
- **False-success runs** (a requirement claimed met that the grader fails), with R9 claimed met counted separately.
- **Stale items**: all value cases match the withdrawn or superseded rule.
- Timeouts, blocked runs, missing reports and harness failures.
- Paired harm contrasts with bootstrap intervals.

**Cost and time.**
- Per run: mean and median.
- **Cost per success**: total cost over successes, with a bootstrap ratio interval.
- **Comparable-outcome cost**: pairs where both arms succeeded.
- Relative saving; wall time (mean, median, paired difference); requests, tokens and summary cost per run.

**Retention and failure preservation** (per arm, over cuts).
- Governing decision id in the restored context (summary + essentials), and mentions of the withdrawn decision only. Both are proxies: a rule can be kept without its id.
- e2e failure in the **restored context** versus in the **work log**.
- Unresolved failures and failing checks shown in the work log (`decision-memory-ab/analyze.ts`).

**Source lookup.**
- Feed fetches and empty re-fetches.
- Notes written.
- Transcript (`.jsonl`) lookups **started** (counted at the call).
- Unfinished calls, and calls over 120 s. The earlier timeouts were transcript greps.

**Activation and exposure** (per run).
- Cuts with a decision-memory work log: expected in M at every cut, never in K. K's cuts should carry the basic log.
- Compactions per run.
- Exposure:
  - narrow: an edit/write/ast_rewrite tool call;
  - broad: any write to a source file, including bash with sed, a redirect, python or node.
  - In both cases the write follows a cut that came after the feed delivery.
- e2e exposure: a cut between the first e2e failure and the report.

## 5. Analysis rules

**As randomized.** Every completed non-infra run counts:
- a timeout, a blocked run, a missing report or a run that edited nothing is a failure;
- a process that died after model progress is a failure, with its cost included and no retry.

**Infra.** Only a run with no model response is infra. It is retried once, and the failed attempt and its cost are reported.

**Activation failures** (an M cut without a decision log, a K cut with one) are reported and **not** excluded. More than 2 such runs would make the study's activation check FAILED. The verdict would still be reported, with that flag.

**Unpaired instances.** If budget stops a block, the instance is excluded from paired analyses and listed.

**Methods.**
- Bootstraps: percentile, 20,000 draws, seed 7, over pairs.
- Sign-flip p: exact up to 20 pairs, otherwise 200,000 seeded flips.
- Newcombe method 10 as in `protocol.ts`, checked in tests against the published example (Fagerland, Lydersen & Laake 2014, b=1, c=7, n=21: −0.507 to −0.026).

**Reused inspected pairs** (seeds 1–6) are analysed the same way and shown apart.

## 6. Sample size, staging, stopping

**Power.** By simulation (`protocol.ts` functions, 4,000 replicates; within-pair independence, equal p in both arms, futility rule applied):

| true p | n = 24 | n = 40 (with interim) | P(stop at interim) |
|---|---:|---:|---:|
| 1.00 | 0 | **1.00** | 0 |
| 0.97 | 0.08 | 0.39 | 0.46 |
| 0.95 | 0.11 | 0.29 | 0.56 |
| 0.90 | 0.14 | 0.21 | 0.66 |

Non-inferiority within this budget is reachable **only if Opus almost never fails a task in either arm**. With b = c = 0 at n = 40 the lower bound is −0.088, and one OFF-only success at n = 40 gives −0.129. Doubling the sample would cost roughly $750. That is disproportionate for an optional cost setting. The study therefore accepts that a likely outcome is "non-inferiority not established", and says so in advance.

**Stages.**
- **Stage 1:** seeds 201–224, 24 pairs.
- **Interim (futility only).** If, assuming every remaining pair succeeds in both arms, the final lower bound would still be ≤ −0.10 (`futile`), stage 2 is **not** run. H-quality is then reported as not established, and the cost analysis uses the stage-1 pairs.
- There is **no early efficacy stop**. The cost hypothesis is not looked at before the final analysis.
- **Stage 2:** seeds 225–240, 16 pairs, run only if not futile.

**Order and concurrency.** Within each pair the arm order is seeded-random (`schedule`, seeds 2026111611 and 2026111612). Concurrency is 8: about 4 pairs at once, with both arms of a pair running close in time.

**Budget.** Estimated USD at catalog prices, from Pi's usage of every worker request and summary.

| phase | cap |
|---|---:|
| pilot (1 pair) | $20 |
| stage 1 | $250 |
| stage 2 | $170 |
| **hard total ceiling** | **$440** (expected about $380 with stage 2, about $240 without) |

- **Admission with reservation** (`driver.ts` `reservePerRunUsd` = $7.50): a new pair starts only if spent + $7.50 × runs in flight + $15 stays within the phase cap.
- The largest earlier Opus run cost $7.21. A run that exceeds its reservation can only push the phase cap up by its own excess, which the request checkpoint and the 30-minute limit bound.
- A read-only verifier, if used, is capped at $5.

## 7. Contamination and failure inspection

- `experiments/decision-memory-b/contamination.ts` on each phase lists paths outside each run's own directories, paths shared between runs, and any reference to the harness, frozen runtime, grader or other runs.
- Every failure, timeout and harness failure is inspected from the transcript and summarised in the README.

## 8. Pilot (seed 299, both arms; excluded)

**Gates.**
1. The model check finds `cliproxyapi/claude-opus-5-5` on `anthropic-messages` with the 128k declared window.
2. The resolved configs differ only in `decisionMemory`.
3. M has a decision-memory log at every cut, and K a basic log at every cut.
4. Both runs compact. The feed delivery precedes at least one cut followed by a source write (broad exposure).
5. A final report with a checklist is parsed.
6. The frozen copy is unchanged after the run (`integrity-pilot.json`).
7. Each run costs at most $8.

**Allowed changes.** Harness defects only, with the arms unchanged. Any change is recorded in §9 before stage 1.

## 9. Amendments after the pilot, before stage 1 (2026-11-16, about 02:25 UTC)

The pilot ran seed 299 with both arms: 2 runs, $8.54 (`results/memory-opus/pilot`).

**Gate results.**

| gate | result |
|---|---|
| 1. model check | `claude-opus-5-5`, `anthropic-messages`, 128k declared window |
| 2. resolved configs | differ only in `decisionMemory` (K omits the key, M has `true`); thinkingPolicy `evidence: "off"` in both |
| 3. activation | M: decision-memory log at 8/8 cuts; K: basic log at 9/9 cuts |
| 5. report parsed | yes; both runs 9/9, R9 honestly unmet |
| 6. frozen copy | unchanged |
| 7. cost per run | K $4.37, M $4.17 |

**Gate 4 passed only after one harness fix (A1).** As first measured, M showed no decision exposure. The feed output had been saved to an artifact file by the Pi tool, so the tool result did not contain the log, and the text-based delivery detection missed it. The transcript shows the delivery came first, then cuts, then edits of all seven item files.

**A1.** `evidence.ts` takes `feedDeliveredAt` from the feed server's own request log, and `run-one.ts` and `summarize.ts` pass it. With A1, both pilot runs are exposed:
- narrow and broad decision exposure;
- e2e exposure.

A1 changes a measurement only. No arm behaviour, outcome, criterion or seed changed, and nothing about arm differences was examined. The harness digest changes, and stage 1 freezes the new working tree.
