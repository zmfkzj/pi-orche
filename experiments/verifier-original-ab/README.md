# Verifier original-evidence A/B with a real model

**Product decision after this study (2026-11-15).** The supplement is now opt-in: `"single": { "verifierOriginal": true }` in orche.config.json, default `false` (docs/handoff-evidence.md §4). The study's arms call `subWorkerPrompt` directly (`protocol.ts` `promptFor`), so they compare the same two behaviours whatever the setting.

**What is compared.** orche's verification supplement off and on. The supplement is `verifierOriginalBlock` in `src/orchestration/handoff-evidence.ts`, called from `subWorkerPrompt` in `src/extension/workers.ts` and committed as `6b30966`. When it is on, a verify sub-worker whose request lacks the user's Original request gets that request appended.

**How it runs.** Both arms run orche's real sub-worker runner on the user's verifier model. The two arms differ only in the `original` argument of the production prompt builder.

**What is scored.** Each verdict (`data.passed`) is scored against a ground truth established independently of any model.

**Fixed in advance.**
- Design, metrics, decision rule and stopping: [PREREGISTRATION.md](PREREGISTRATION.md) (study 1) and [PREREGISTRATION-2.md](PREREGISTRATION-2.md) (study 2).
- Every event after preregistration: [DEVIATIONS.md](DEVIATIONS.md).

## Result (2026-11-15)

**Verdict: no improvement.**
- The supplement did not improve verifier verdict accuracy by a material amount. Balanced accuracy changed by **+1.4 percentage points (98% CI −6.2 to +9.6)**.
- It moves verifiers toward strictness: fewer missed violations, more false rejections. Neither change is significant at the preregistered 98% level.
- Under the preregistered rule the final verdict is **INCONCLUSIVE**. The overall accuracy interval lies inside ±10 points, but a false-rejection increase of up to 16.7 points cannot be excluded. The "no material difference" verdict requires that bound to be 10 or less.

**Scope.** This is a controlled benchmark of 72 synthetic cases on one model. It is not production task success.

**Primary analysis** (PREREGISTRATION-2.md §4):
- Study 1 under label set (b) pooled with study 2: 72 cases in 44 scenarios.
- 352 scored runs: 176 per arm, 1–3 replicates per case.

| | OFF | ON |
|---|---|---|
| correct verdicts | 152/176 (86.4%) | 151/176 (85.8%) |
| missed violations | 8/74 runs | 2/74 runs |
| false rejections | 16/102 runs | 23/102 runs |
| no verdict / infra / contaminated | 0 / 0 / 0 | 0 / 0 / 0 |
| paired runs ON better / worse / same | 8 / 9 / 159 | |

Case-level effects, ON − OFF, with 98% bootstrap intervals and sign-flip p:

| metric | point | 98% CI | p |
|---|---|---|---|
| M1 missed-violation reduction (19 evidence-gain violation cases) | +13.2 pt | [0, +31.6] | 0.25 |
| M2 false-rejection increase (42 compliant cases) | +5.6 pt | [−4.8, +16.7] | 0.37 |
| M3 balanced accuracy | +1.4 pt | [−6.2, +9.6] | 0.68 |

**Each study and each label set.** All are INCONCLUSIVE.

| analysis | cases | M1 | M2 | M3 |
|---|---|---|---|---|
| study 1, preregistered labels, final look (3 replicates) | 34 | +11.1 [0, 44.4] | +11.7 [0, 28.3] | −2.3 [−13.3, +10.0] |
| study 1, label set (b) | 32 | +11.1 [0, 44.4] | +13.0 [0, 31.5] | −2.9 [−14.4, +10.0] |
| study 2 alone (2 replicates) | 40 | +15.0 [0, 40.0] | 0.0 [−12.5, +12.5] | +4.7 [−4.6, +16.1] |
| pooled, study-1 labels (a) | 74 | +13.2 [0, 31.6] | +5.3 [−4.5, +15.9] | +1.5 [−5.8, +9.7] |
| pooled, study-1 labels (c) | 73 | +13.2 [0, 31.6] | +5.6 [−4.8, +16.7] | +1.3 [−6.2, +9.3] |
| post hoc: contested labels also excluded | 69 | +13.2 [0, 31.6] | +4.3 [0, +12.8] | +2.0 [−4.3, +9.0] |

The last row also excludes slugify/ok, dedupe/ok and s2-b-color-changelog/ok.

**Heterogeneity.** Where the supplement changed the outcome, on the primary pool:

| | cases | which ones |
|---|---|---|
| ON better | 4 | `retry/bad`, `s2-b-leaderboard/bad`, `s2-b-split-bill/bad`, `s2-b-color-changelog/ok`* |
| ON worse | 4 | `slugify/ok`*, `dedupe/ok`*, `log-tz-silent/ok`, `s2-b-thumb-silent/ok` |

\* contested label (DEVIATIONS.md D2, D5).

- **Where it helped.** The three violations ON caught are all choices in new code, and their deciding condition existed only in the user's words or a repository document.
  - On study 2's violation types: **new-code** violations were correct 68.8% → 87.5% (2 of 8 cases improved); **regression** violations were 100% → 100% (OFF already caught them from the diff).
- **Where it hurt.**
  - Two silently retracted conditions: ON enforced the stale original. The retracted stratum's compliant accuracy went from 81% to 57%.
  - Two compliant cases where ON became pedantic about the user's wording. The hidden stratum's compliant accuracy went from 90.9% to 75.8%.
- **No difference** in the doc, present, short and truncated strata. The late rule cut at 8,000 characters was invisible as designed.

**Cost and latency** of the primary-pool verifier runs (Pi `usage.cost` at catalog prices, not billed amounts):

| | total | median per run | median wall | median requests | median prompt |
|---|---|---|---|---|---|
| OFF | $10.94 | $0.060 | 16.8 s | 3 | 1,461 chars |
| ON | $12.18 (+11%) | $0.063 | 17.9 s | 3 | 1,833 chars |

**Total study spend: about $31.**
- Study 1: $14.03 (pilot $0.36 included).
- Study 2: $10.53.
- Two blind label adjudications: $2.50.
- Two case-writing sessions: $3.92.

There were 368 verifier sessions in all: 4 pilot, 204 in study 1 and 160 in study 2.

## What this does and does not show

- **The scope of the evidence.** Controlled and synthetic. It shows the supplement's effect on one model's verify sub-worker verdicts, for tasks built to contain the situations the hand-off audit found (docs/handoff-evidence.md).
- **It is not production evidence.**
  - It does not measure task success.
  - It does not measure how often real verifier requests omit a deciding condition, or how often violations occur. The stratum mix is a design choice, so per-stratum results are given for re-weighting.
- **"No improvement" here means** that a ≥10-point balanced-accuracy gain is excluded at 98%. A smaller benefit or harm is not excluded. M1 and M2 are not significant individually; that is not a proof that they are zero.
- **Ground truth.**
  - Labels come from hidden checks written by the case authors.
  - Blind adjudication by a fresh session of the same model agreed 33/34 (study 1) and 40/40 (study 2).
  - One study-1 label was objectively wrong and was found by deterministic reproduction (D2). Three labels are contested after the results were seen (D2, D5).
  - No human labeled the cases.
- **Other limits.**
  - One model and one thinking level.
  - Tiny repositories.
  - The two independent case authors converged on some similar domains.
  - Within-case variation was small, so the uncertainty comes from the number of cases, not the number of replicates.

## Files

| file | role |
|---|---|
| `cases.ts`, `cases-2a.ts`, `cases-2b.ts`, `cases-2.ts` | the 74 cases (+2 pilot) and their hidden checks |
| `fixture.ts` | materialize a case (git repo) and run its visible and hidden checks |
| `protocol.ts` | model, arms (`promptFor`), limits, schedule, decision rule, run classes |
| `run-one.ts` | one verifier run through `createSubWorkerRunner` in a private overlay |
| `driver.ts` | freeze, overlay, schedule, retry, budget |
| `analyze.ts` | per-case results, bootstrap, sign-flip, decision, label overrides, pooling |
| `scan.ts` | contamination scan of verifier transcripts |
| `adjudication.ts` | blind adjudication packet and scoring |
| `validate-scenarios.ts` | model-free validation of a scenario file |

Run artifacts are in `results/verifier-original-ab/`, which git ignores and which holds no private data (all fixtures are synthetic):
- `study-2026-11-15/`: study 1. Contains `frozen/`, `runs/{pilot,main}/<case>/<arm>/r<n>/{meta.json,session.jsonl}`, `summary-look{1,2,3}*.json`, `adjudicated-labels.json` and the label sets.
- `study2-2026-11-15/`: study 2. Contains `summary-study2.json`, `summary-final-pooled-{a,b,c}.json` and `summary-posthoc-contested.json`.
- `prereg*-hashes-*.txt`: hashes of the harness and preregistration files before the runs.

## Commands

```bash
npx vitest run test/experiments/verifier-original-ab.test.ts       # model-free: labels, blinding, arms, schedule, scoring, statistics
npx tsx experiments/verifier-original-ab/driver.ts results/verifier-original-ab/<plan>.json   # one replicate (real model)
npx tsx experiments/verifier-original-ab/analyze.ts results/verifier-original-ab/study-2026-11-15 \
  --with2 results/verifier-original-ab/study2-2026-11-15 \
  --labels results/verifier-original-ab/study-2026-11-15/labels-b-excluded.json   # primary analysis
```

Plans are `{ out, phase, set?, replicate, concurrency, scratch }`. The study-1 and study-2 plans are in `results/verifier-original-ab/`.
