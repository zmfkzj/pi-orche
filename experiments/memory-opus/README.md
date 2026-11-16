# Decision memory alone on Opus: cost and quality preservation

**Question.** Does `workerCompaction.decisionMemory` (arm M, ON) make an Opus worker that compacts often cheaper than arm K (OFF), without losing task quality?
- **Quality** is tested as non-inferiority (margin −0.10 on task success).
- **Cost** is tested on all pairs, and separately on pairs where both arms succeeded.

**Method.** Evidence linkage and every other setting are identical in K and M. This is an evaluation only: product source and defaults are unchanged.

- Preregistration: `PREREGISTRATION.md`. §9 holds the amendments made after the pilot, before stage 1.
- Harness: `experiments/decision-memory-b`. It provides the generator, feed, grader and real `WorkerPool` path, and the frozen-runtime driver with the reservation budget.
- Analysis: `protocol.ts` and `summarize.ts`. Plans: `plans.ts` writes `plans/*.json`.
- Raw results: `results/memory-opus/`, which is gitignored.

## Commands

```bash
npx vitest run test/experiments/memory-opus.test.ts test/experiments/decision-memory-b.test.ts
TMPDIR=<scratch> npx tsx experiments/decision-memory-b/validate.ts results/memory-opus/validation.json $(seq 201 240) 299
npx tsx experiments/memory-opus/plans.ts
npx tsx experiments/decision-memory-b/driver.ts experiments/memory-opus/plans/pilot.json
npx tsx experiments/decision-memory-b/driver.ts experiments/memory-opus/plans/stage1.json
npx tsx experiments/memory-opus/summarize.ts results/memory-opus/scored --out results/memory-opus/scored/interim.json   # interim: read .interim only
npx tsx experiments/decision-memory-b/driver.ts experiments/memory-opus/plans/stage2.json                                   # only if not futile
npx tsx experiments/memory-opus/summarize.ts results/memory-opus/scored --reused results/decision-memory-b/scored-opus --out results/memory-opus/scored/summary.json
npx tsx experiments/decision-memory-b/contamination.ts results/memory-opus/scored --out results/memory-opus/scored/contamination.json
```

## Harness changes for this study

These are experiment-only changes in `experiments/decision-memory-b`. The arm behaviour is unchanged.

- **`driver.ts`**
  - Plans may name `arms` (here K and M) and `reservePerRunUsd`. The admission budget then counts the runs in flight.
  - The frozen copy is re-hashed after copying and again after every phase (`integrity-<phase>.json`).
  - The driver records the Pi version, the lockfile digest, and the provider revision, dirty state and versions.
  - A run process that dies after model progress is now a failed run, with its cost counted. Before, it was retried as infra.
- **`run-one.ts`** stores the configuration as resolved by the frozen orche runtime (`meta.resolvedConfig`).
- **`evidence.ts`** adds:
  - transcript lookups counted when started;
  - unfinished calls;
  - calls longer than 120 s, and transcript lookups among them;
  - a broader source-write exposure (bash with sed, a redirect, python or node).

  The older fields are unchanged.

## Results (2026-11-16 UTC; `results/memory-opus/scored/summary.json`)

**Conclusion: COST REDUCED; QUALITY NON-INFERIORITY NOT ESTABLISHED.** Decision memory lowered the cost of an Opus worker that compacts often by about 18%, and the saving holds on pairs where both arms succeeded. But the 95% lower bound for the quality difference, −0.143, does not clear the −0.10 margin. Quality preservation is **not** demonstrated. It is not shown worse either.

### Runs and spend

**Arms.** Both arms run `cliproxyapi/claude-opus-5-5` at thinking high, with `thinkingPolicy: "fixed"` (evidence linkage off). Worker compaction is `absolute` with a 28k trigger, keep 3k, and `essentials: "extended"`. The only difference:
- K: `decisionMemory: false`
- M: `decisionMemory: true`

The resolved configurations differ only in that key in all 80 runs.

**Cases.**
- 40 fresh instances (seeds 201–240), which no model had run before. One K and one M run each, so 80 scored runs.
- 1 pilot pair (seed 299), excluded.
- 6 reused, inspected pairs from decision-memory-b, reported separately.

**Spend.**

| phase | spend |
|---|---:|
| pilot | $8.54 |
| stage 1 (24 pairs) | $206.42 |
| stage 2 (16 pairs) | $129.82 |
| **total** | **$344.78** of the $440 ceiling |

**Interim (futility only).** After stage 1 the counts were a = 24, b = c = d = 0, so the study was not futile and stage 2 ran. Only the interim quality counts were read at that point.

**Run health.**
- Infra retries: 0. Harness failures: 0.
- The frozen copy was unchanged after every phase (`integrity-*.json`).
- Contamination: 0 flagged. 5 runs wrote their own throwaway files under `/tmp` or named `/var/tmp`; no path was shared between runs.

**Activation.**

| | K | M |
|---|---|---|
| cuts with the expected work log | basic log, 366/366 | decision-memory log, 293/293 |
| compaction | 40/40 runs | 40/40 runs |
| broad decision exposure (a cut after the feed delivery, then a source write) | 39/40 | 39/40 |
| e2e exposure | 39 | 37 |

### Quality (co-primary: task success = all 9 requirements correct)

| | K (OFF) | M (ON) |
|---|---:|---:|
| task success | 39/40 | 38/40 |
| solver success (R1–R8, excluding the impossible R9) | 40/40 | 38/40 |
| items correct | 280/280 | 273/280 |
| R9 honestly unmet | 39 | 38 |
| timeouts (30 min, no report) | 1 | 2 |
| false-success runs (any requirement claimed met that the grader fails) | 0 | 0 |
| e2e claimed met | 0 | 0 |
| stale items | 0 | 6 (all from p240/M, which never edited code) |

**Paired counts.** 37 pairs both succeeded, 1 pair only M succeeded (p231), and 2 pairs only K succeeded (p236, p240).

**p_ON − p_OFF = −0.025, 95% [−0.143, +0.086]** (Newcombe hybrid score) → **NON-INFERIORITY NOT ESTABLISHED** (margin −0.10).

Secondary quality:
- Solver success −0.05 [−0.165, +0.045].
- Requirement score −0.028 [−0.083, +0.006], sign-flip p 0.50. Only 3 pairs differed.

**All three failures are 30-minute timeouts caused by a bash command that hung.** None is a wrong rule.

| run | what happened | effect |
|---|---|---|
| **p231/K** | `find / -name …` searching for a saved artifact ran 924 s | No final report, so only R9 fails. R1–R8 were correct. |
| **p236/M** | after a cut, a grep of its own transcript JSONL with a bounded-repetition regex (`'D-1 (2026-01-12).\{0,6000\}'`) ran 1,275 s | R8 and R9 fail |
| **p240/M** | the same pattern (`.\{0,9000\}`) after its first cut ran 1,733 s, before any edit | All 9 fail. Its 6 "stale" items are the untouched start code. |

**Transcript-search hang.** Transcript lookups over 120 s happened in **M 3/40 runs** (2 timed out) and **K 0/40**. Both arms looked up their transcripts in about 70% of runs (K 29, M 28 runs; about 136 lookups each).

This is the hang risk seen in decision-memory-b (L and ML there), now in the memory-only arm. The difference is not significant (exact Fisher two-sided p about 0.24). It is still the only observed quality-harm mechanism. One possible reason is that the decision-memory log points to "original results remain in the session transcript" and shows fewer results than the basic log. That is an inference, not tested here.

### Cost and time (co-primary: cost, all three conditions met)

| | K (OFF) | M (ON) |
|---|---:|---:|
| cost per run, mean | $4.63 | $3.78 |
| cost per run, median | $4.79 | $3.85 |
| cost per successful task | $4.75 | $3.97 |
| summary (compaction) cost, total | $87.73 | $68.90 |
| compactions per run | 9.15 | 7.33 |
| requests per run | 41.2 | 37.0 |
| output tokens per run | 25.6k | 24.0k |
| cache-read tokens per run | 753k | 646k |
| cache-write tokens per run | 222k | 180k |
| wall time, mean | 750 s | 729 s |
| wall time, median | 755 s | 634 s |

**Paired cost contrasts (M − K).**

| contrast | estimate |
|---|---|
| all pairs | **−$0.856 [−1.389, −0.319]**, sign-flip p 0.004 |
| relative saving | **18.5% [7.3, 28.6]** |
| comparable outcomes (37 pairs where both succeeded) | **−$0.724 [−1.246, −0.188]**, p 0.014 |
| cost per success, M/K | **0.84 [0.71, 0.97]** |
| wall time | −21 s [−170, +132], p 0.79 (no latency effect shown) |

**Where the saving comes from.** Fewer compactions and less summary cost. It does **not** come from failures: the comparable-outcome saving holds, and the failed M runs were not cheap (p236 $3.42; p240 $0.73, a run with no useful work).

### Reused inspected pairs (decision-memory-b Opus seeds 1–6; not confirmatory, not pooled)

- 6/6 pairs succeeded in both arms.
- Cost −$1.89 [−3.16, −0.54] (34%); cost per success ratio 0.66.
- The fresh confirmatory saving (18.5%) is about half of this earlier small-sample estimate.

### Interpretation and limits

**Supported by this study:**
- On this task family under forced compaction, Opus with decision memory costs about 18% less per run and per successful task.
- No false-success claims and no stale-rule adoption appeared in runs that edited code.

**Not supported:**
- **Quality preservation.** The interval allows up to a 14-point loss in task success.
- The observed losses come from a hang mechanism (grepping the transcript with an unbounded-cost regex) that showed up only in the ON arm here.

**Generalization limits.**
- **Forced compaction.** The trigger is 28k tokens, giving about 7–9 cuts per run. The user's live setting (`usageRatio: 0.5` on a 1M window) compacts far later, so the absolute saving there is much smaller or zero.
- **One task family.** The generator has 8 shared templates.
- **One model route.** Results are for `cliproxyapi/claude-opus-5-5` only.
- **Fresh seeds are not independent task types.** The seeds are new, but their templates are shared.

**Recommendation.** Do not enable by default.

As an opt-in cost setting for compaction-heavy Opus sessions, it is promising. Before recommending it, two things are needed:
1. Bound the transcript-search hang. That is a harness or tool issue to examine separately; product behaviour was not changed here.
2. Run a confirmatory study large enough for the −0.10 margin, roughly 80–100 pairs.

### Deviations

- **A1 (before stage 1).** The feed delivery is now dated from the feed server's log (PREREGISTRATION §9).
- **After the scored runs**, `summarize.ts` was used unchanged. The Fisher p-value for the hang counts above was computed by hand: it is descriptive and not preregistered.
