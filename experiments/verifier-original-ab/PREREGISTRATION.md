# Preregistration: does the verifier original-evidence supplement improve verifier verdicts?

Written 2026-11-15, before any model run of this study (the pilot uses separate cases and is never analysed). The production intervention, the cases, the scoring, the decision rule and the stopping policy below are fixed. `protocol.ts`, `cases.ts` and `analyze.ts` implement them, and `driver.ts` freezes them with their hashes (`<study>/frozen/frozen.json`).

## 1. Question and intervention

- **Question.** When a verification sub-worker's request does not carry the user's Original request verbatim, does appending it (`verifierOriginalBlock`, `src/orchestration/handoff-evidence.ts`, through `subWorkerPrompt` in `src/extension/workers.ts`) make the verifier's pass/fail verdict more often correct?
- **Arms.** The two arms differ in one argument only.
  - **OFF** = `subWorkerPrompt(planned, "W1", [], false, false, undefined)`. This is the behaviour before the change.
  - **ON** = the same call with `originalRequestOf(<orchestrator assignment>)`, exactly as the runtime passes it.
- **Fixed for the comparison.** The intervention is used as implemented, including the known provenance issue: its heading says "verbatim" even when main's section holds excerpts. Nothing is changed for this study.

## 2. Conditions held equal

- **Runner.** orche's real sub-worker runner (`createSubWorkerRunner`). Role `verify`, reason `verification`, the worker tool set, the write guard, `report_result` with the verify contract (`data.passed` boolean).
- **Model.** `cliproxyapi/claude-opus-5-5`, thinking `high`. This is the user's verifier route: no `models.worker`, so verifiers inherit `models.orchestrator`, whose thinking is "main" = high. Requests go through the local CLIProxyAPI.
- **Limits.** 15-minute session cap, no turn cap.
- **Isolation.** Each run has its own process, temp dir, private agent dir, HOME, TMPDIR and XDG dirs.
- **Code under test.** orche from the frozen working tree (the uncommitted production change).
- **Workspace.** The fixture repository only: base commit plus the orchestrator's uncommitted change. Nothing in it names the case, its stratum or its label.

## 3. Cases and labels (`cases.ts`)

**Case set.** 34 synthetic cases in 20 scenarios: 14 violating and 20 compliant. Each scenario has a base commit, the orchestrator's change, the assignment main wrote (Intent, R-lines, Original request), and the verify request an orchestrator would write.

**Labeling rule.** The verifier should pass the work iff it satisfies the user's **current, valid** requirements **within this assignment's scope**.
- A condition the user withdrew no longer applies.
- An item explicitly assigned elsewhere is out of scope.
- An action the assignment is not authorized to take (a commit without a git grant) is out of scope.

**Independent establishment of each label.** Done without any model:
- The visible suite (`npm test`) passes in every case.
- A hidden node:test check, kept outside the workspace, passes iff the work is compliant.

`test/experiments/verifier-original-ab.test.ts` asserts that every label agrees with its hidden check. The labels and checks were written by the same author as the fixtures. There was no separate human review.

**Strata.** These represent the observed limitations of the supplement (docs/handoff-evidence.md §3, earlier replay):

| stratum | scenarios | variants | ON adds deciding information? | what it tests |
|---|---|---|---|---|
| hidden | 6 | violating + compliant | yes | the condition exists only in the user's words |
| doc | 2 | violating + compliant | yes, but the repo README also states it | evidence already discoverable |
| present | 2 | violating + compliant | no: the request already states the condition (paraphrased) | redundant supplement |
| short | 2 | violating + compliant | no: the original is a short approval ("진행해") | the commonest real original (≤ 40 chars) |
| retracted | 3 | compliant only | no, it is stale: the user withdrew the condition after the hand-off (2 silent, 1 stated in the request) | harm from stale originals |
| scope | 3 | compliant only | no, it is out of scope: README item given to another worker, an excerpted multi-item list, a "commit" without a git grant | harm from scope or authorization |
| truncated | 2 | violating + compliant | early rule: yes; late rule (beyond 8,000 chars): no | truncation |

**Evidence-gain violation cases.** 9 cases: 6 hidden, 2 doc and `username-early/bad`.

## 4. Outcomes

**Run score.**
- A run is **correct** when its verdict (`data.passed`) equals the label.
- A run that started but gave no verdict (timeout, no `report_result`) is **no-verdict** and scored **incorrect**, in both arms alike.

**Primary metrics.** All three are differences ON − OFF, with the case as the unit.
- **M1**: missed-violation rate on the 9 evidence-gain violation cases, computed as OFF miss − ON miss. A positive value is a benefit.
- **M2**: false-rejection rate on the 20 compliant cases, computed as ON − OFF. A positive value is harm.
- **M3**: balanced accuracy = ½·(accuracy on the 14 violating cases) + ½·(accuracy on the 20 compliant cases).

**Secondary measures.** Not used in the decision.
- Per-stratum accuracy for each arm.
- Paired improved/worsened counts.
- Whether a verifier that rejected a violating case named the deciding condition (heuristic regex per case).
- Cost (Pi `usage.cost`, catalog prices), wall time, requests, prompt characters, no-verdict and infra counts.

## 5. Exclusions and failures

- **Infrastructure failures.** A run counts as infra when the model never answered, a provider or network error ended it, or the harness crashed. It is retried once; the first attempt and its cost are kept. A replicate pair with a remaining infra run is excluded from the paired analysis and reported.
- **Contamination.** The transcript's tool-call arguments are scanned for the study's own files (harness, cases, results, hidden checks). A pair with a contaminated run is excluded and reported. If any exist, the analysis is also reported with them included.
- **No other exclusion.** No run is excluded for its verdict, cost or length.

## 6. Analysis, decision and stopping

**Unit and inference.**
- **Unit.** The case. Replicates are averaged within a case; a replicate counts only if both arms of its pair were scored.
- **Intervals.** Percentile bootstrap with 20,000 draws at a **98% two-sided level** at every look, about Pocock for 3 looks at overall α 0.05.
  - M3 resamples scenarios, since a scenario's two variants share a fixture.
  - M1 and M2 resample their own cases.
- **p-values.** Monte-Carlo sign-flip p-values on case-level differences, descriptive.

**Decision.** The rules are checked in this order; margin = 10 percentage points.
1. **TRADE-OFF**: M1.lower > 0 and M2.lower > 0.
2. **IMPROVES**: M3.lower > 0 and M2.upper ≤ +0.10.
3. **HARMS**: M3.upper < 0, or (M2.lower > 0 and M2.point ≥ +0.10).
4. **NO MATERIAL DIFFERENCE**: M3 interval within [−0.10, +0.10] and M2.upper ≤ +0.10.
5. Otherwise **INCONCLUSIVE**.

**Sequential policy.**
- Stage *k* runs replicate *k* of all 34 cases in both arms (68 runs), in a seeded random order with both arms of a pair adjacent; 6 processes run concurrently.
- After each stage the decision is computed on all completed replicates.
- The study stops at the first verdict other than INCONCLUSIVE, after replicate 3, or when the estimated spend passes **150 USD** (no new runs are then launched). Then the last verdict is reported, INCONCLUSIVE included.
- More replicates reduce within-case noise. They do not add case diversity, which is a stated limitation.

## 7. What this benchmark represents

**It represents.** A controlled test of verifier verdict quality under the real runner and model, on synthetic tasks whose verifier requests omit, paraphrase or contradict the user's words in known ways.

**It does not measure.**
- Production task success.
- How often real verifier requests omit a deciding condition.
- How often violations occur.
- Long real repositories, other models or concurrent sub-workers.

**Weighting.** The stratum mix is a design choice, not the deployment mix. Results are reported per stratum so that they can be re-weighted.

## 8. Pilot (excluded)

- Two pilot-only cases (`pilot/pilot-trim/{bad,ok}`), one replicate per arm, capped at 10 USD.
- Purpose: tooling validation and cost per run.
- The pilot changes no case, rule or limit unless tooling fails. Any such change is recorded in README.md before the main runs.
