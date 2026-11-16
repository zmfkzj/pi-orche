# Deviations and events after preregistration

Recorded in order of occurrence. PREREGISTRATION.md itself is unchanged (hashes: `results/verifier-original-ab/prereg-hashes-*.txt`).

## D0. HEAD moved before the pilot (2026-11-15 13:46 UTC, not part of this study)

- The repository owner committed the production change under test as `6b30966` ("fix(orche): preserve original requests in verifier handoffs").
- The frozen copy (`frozen/frozen.json`) records HEAD `6b30966`. The working tree's `src/` equals that commit: `git status` shows only this study's new files.
- The intervention is therefore the committed one. Its hashes are in `frozen.json` → `intervention`.

## D1. Ground-truth audit added after look 1 (recorded 2026-11-15 14:05 UTC, before replicate 2 was launched)

- **What happened.** Look 1 (replicate 1) was INCONCLUSIVE.
- **What the reports showed.** Reading the verifier reports of the incorrect runs showed that some preregistered labels may be wrong or debatable: the hidden checks test only the deciding condition, while the fixtures can have other defects.
  - `csv-stdout/ok`: the CLI crashes without `--delimiter`. Both arms rejected it.
  - `slugify/ok`: `normalize("NFC")` changes the slugs of NFD-encoded accented English titles, which arguably breaks the user's "no existing English slug may change". ON rejected it.
  - `tokenize/ok`: emoji with modifiers or flags split into several tokens. Both arms rejected it.
  - `username-*/ok`: the verify request's criterion 1 conflicts with the notes' leading-digit rule, and non-string inputs are accepted. Both arms rejected it.
  - `dedupe/ok`: `trim()` changes the stored spelling. ON rejected it.
- **Decision, made before seeing any later result.**
  1. Continue the preregistered sequential policy unchanged: replicate 2 now, replicate 3 only if look 2 is INCONCLUSIVE.
  2. Get an **independent blind adjudication** of all 34 labels by a fresh model session.
     - It sees a neutral packet per case: shuffled codes; the repository diff and files; everything the user said, including the messages relayed during the task in the retracted cases; the assignment's scope and authorization; and the labeling rule.
     - It sees no preregistered label, hidden check, stratum or verifier result.
  3. Report the decision under three label sets:
     - (a) preregistered labels: the preregistered primary analysis;
     - (b) **excluding every case whose adjudicated label differs from the preregistered one**, or which the adjudicator marks ambiguous;
     - (c) adjudicated labels.
  4. The final judgement states (a) as the preregistered result. It relies on (b) where (a) and (b) disagree, because a case without a defensible single ground truth cannot measure verdict quality.
- **What is not changed.** No case, fixture, scoring rule, metric, threshold or stopping rule. The audit adds analyses; it removes nothing from (a).

## D2. Adjudication result and one objectively defective label (2026-11-15 14:10-14:20 UTC)

**The adjudicator.** One fresh `orche_spawn` verification sub-worker on the same model (`cliproxyapi/claude-opus-5-5`, high) ran blind on the packet (`adjudication.ts`).
- It covered 34 cases in 213 s, with 33 requests, at an estimated $1.09.
- Its tool calls touched nothing outside the packet, as checked by scanning its transcript for repository or results paths.
- Codes mapped back to cases: `study-2026-11-15/adjudicated-labels.json`.

**Agreement.** It agreed with 33 of the 34 preregistered labels. It marked `tokenize/ok` AMBIGUOUS: whether "an emoji is its own token" covers ❤️, 👍🏽 and 🇰🇷.

**An objective defect it missed.** `csv-stdout/ok` crashes when run without `--delimiter`. Reproduction: `node src/cli.js sample.json` gives `ERR_INVALID_ARG_TYPE`. The cause is a fixture bug: `index !== at + 1` with `at = -1` drops the file argument. This breaks the assignment's agreed R1 ("default comma"), so the preregistered label `pass` is wrong. The adjudicator judged PASS without running the default path.

**Label sets, fixed now.**
- (b) excludes `tokenize/ok` (ambiguous) and `csv-stdout/ok` (defective label).
- (c) relabels `csv-stdout/ok` as `fail`, with evidenceGain false because the deciding condition is in the request, and excludes `tokenize/ok`.

Files: `labels-b-excluded.json` and `labels-c-adjudicated.json`.

**Contested, label unchanged.** `slugify/ok`, where ON verifiers flagged NFD-encoded accented English titles (the adjudicator judged it PASS), and `dedupe/ok` (`trim()`, judged PASS). Their labels stay as preregistered and adjudicated; their per-run outcomes are reported.

**Study 1 at its final preregistered look (replicate 3).** INCONCLUSIVE under (a), (b) and (c) alike: `summary-look3*.json`.

## D3. Study 2 (2026-11-15, after study 1 ended)

**Why.** The study-1 intervals are wide because there are few cases. Replicates barely moved the estimates.

**Plan.** Study 2, preregistered in PREREGISTRATION-2.md before any study-2 case existed, adds 40 new cases. Two fresh sessions write them without access to study-1 results. They are pooled for the final judgement.

**Tooling changes, none of which affect study-1 runs.**
- `cases.ts` exports its helpers and `casesOf`. The hash of the study-1 `CASES` content is unchanged (`a09be915…` before and after).
- `analyze.ts` gained label overrides and pooling.

**Study-1 replicate 3 run.** `adjudication.ts` was moved out of the harness directory for the replicate-3 run. That kept the frozen-harness guard satisfied without altering any frozen file; the script was not used by the runs.

## D4. Study-2 pre-run quality assurance (2026-11-15, before any study-2 run)

**Case authors.** Two fresh sessions wrote `cases-2a.ts` and `cases-2b.ts`: 12 scenarios and 20 cases each.
- `validate-scenarios.ts` passed for all 40 cases.
- They report 4 regression and 4 new-code violations each.
- Independent authors converged on some similar domains: byte-size units, phone masking, bill splitting, parking fees and thumbnails appear in both files, as different fixtures and requests. This lowers case diversity and is reported as a limitation.

**Blind adjudication.** A fresh session (`label-adjudicator-2`, same model) adjudicated the 40 cases from a neutral packet (seed 515151): 40 of 40 agreed with the labels, none ambiguous. Its tool calls touched nothing outside the packet. No case was fixed or dropped.

**Harness extensions for study 2, none of which change study-1 semantics.**
- `run-one.ts` also finds `CASES_2`.
- `driver.ts` has `set: "s2"`.
- `protocol.ts` has `LIMITS.study2CostCapUsd = 60`.
- Study 2 runs from its own frozen copy (`study2-2026-11-15/frozen`).

## D5. Study-2 runs and a label contested after the results (2026-11-15 14:33-14:43 UTC)

**Runs.** Two replicates of the 40 study-2 cases ran as preregistered: 160 runs, estimated $10.53. There were 0 infra, 0 no-verdict and 0 contaminated runs.

**Contested label.** `s2-b-color-changelog/ok` (scope stratum, label pass, adjudicated pass).
- Both OFF runs rejected it because `hexToRgb` accepts input without `#` and non-strings, against R2 "Invalid input throws".
- Both ON runs passed it and noted that the CHANGELOG item is out of scope.

**Treatment.** The label is not changed. It is reported as contested, together with `slugify/ok` and `dedupe/ok` (D2), in a post-hoc sensitivity analysis that excludes all five disputed cases (`labels-posthoc-contested.json`). That analysis is not the primary one.

**Final judgement.** The primary analysis (pooled, label set (b)) is INCONCLUSIVE under the preregistered rule. See README.md.
