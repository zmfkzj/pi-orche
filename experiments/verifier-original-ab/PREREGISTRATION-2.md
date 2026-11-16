# Preregistration of study 2: more cases for the verifier original-evidence A/B

**Status when this was written.** 2026-11-15, after study 1 ended INCONCLUSIVE at its final preregistered look (3 replicates; see README.md and DEVIATIONS.md). It was written before any study-2 case existed and before any study-2 run.

**Why study 2.** Study 1's intervals are wide because it has few cases: 34 cases in 20 scenarios. Within-case variation was small (replicates 2 and 3 barely moved the estimates), so more replicates would not help. Study 2 adds new, independently written cases.

## 1. Unchanged from PREREGISTRATION.md

These carry over as fixed:
- the question, the intervention as committed (`6b30966`), and the two arms;
- the model `cliproxyapi/claude-opus-5-5` at thinking high, the real sub-worker runner and the limits;
- the isolation, the blinding of the workspace, and the scoring;
- the run classes (verdict / no-verdict / infra), the retry rule and the contamination rule;
- the metrics M1, M2 and M3, the decision rule with its order and its 10-point margin, and the 98% intervals;
- the bootstrap (M3 over scenarios; M1 and M2 over cases) and the descriptive sign-flip p-values.

## 2. New cases

**Authors.** Two fresh model sessions write the cases (`cases-2a.ts`, `cases-2b.ts`).
- They follow the study-1 schema, strata and labeling rule (PREREGISTRATION.md §3).
- They are told not to read study-1 results or DEVIATIONS.md.
- They see the study-1 cases only as a format example.

**Quotas.** 24 scenarios and 40 cases in total.

| stratum | scenarios | cases |
|---|---|---|
| hidden | 6 | 12 |
| doc | 3 | 6 |
| present | 2 | 4 |
| short | 3 | 6 |
| retracted | 4 | 4 (compliant only, about half silent, half stated in the request) |
| scope | 4 | 4 (compliant only) |
| truncated | 2 | 4 (one early-rule scenario, one late-rule scenario) |

Overall: 16 violating and 24 compliant cases.

**Diversity requirement given to the authors.**
- About half of the violating variants change behaviour that existed in the base commit (a regression visible in the diff). The other half are choices in newly written code with no earlier behaviour to compare against.
- Compliant variants must satisfy every requirement stated in the assignment and by the user, not just the deciding one.
- This requirement and its reason are disclosed here. It was set after study 1 and is meant to cover both kinds of violation; it does not favour either arm.

**Pre-run quality assurance.** Done before any study-2 run.
1. `validate-scenarios.ts` must pass for every case. It checks the visible suite, the hidden check against the label, an extractable original, that the request does not already carry the original, the truncation position, and that the workspace does not reveal the case.
2. A fresh model session adjudicates every study-2 case blind, as in DEVIATIONS.md D1: a neutral packet with no labels and no results.
3. Every case where the adjudicator disagrees with the label or marks it ambiguous is either fixed by me and re-adjudicated, or dropped. Each such case is listed in DEVIATIONS.md before the runs start.

## 3. Runs

- Every study-2 case gets 2 replicates per arm.
- This is a fixed sample with no interim look: 2 × 2 × 40 = 160 runs, in seeded random order with both arms of a pair adjacent, 6 at a time.
- Budget: study 2 stops launching runs above 60 USD of estimated spend. The combined spend of both studies stays below the 150 USD cap of the original preregistration.

## 4. Analysis and final judgement

**Primary analysis: the final look.**
- The data are pooled: study-1 cases under label set (b), which excludes `tokenize/ok` and `csv-stdout/ok` (DEVIATIONS.md D1 and D2, fixed before study 2), plus all study-2 cases that pass QA.
- The unit is the case. Scenarios are the clusters for M3.
- The decision rule is the preregistered one at 98%.

**Secondary analyses.**
- Study 2 alone.
- The pool with study-1 preregistered labels.
- The pool with study-1 adjudicated labels (c).
- Per-stratum results with improved/worsened counts.
- The violation types of the diversity requirement (regression versus new-code choice), using each study-2 scenario's declared type.

**Reporting.**
- The final judgement is the primary analysis's verdict, INCONCLUSIVE included. There is no further study.
- Heterogeneity is reported, not averaged away. In particular, M1 (benefit) and M2 (harm) are reported separately, each with its interval.
