# Preregistration: synergy of inconclusive orche features (2026-11-15)

Written before any model run of this study. The pilot (§7) only checks the tooling and that each treatment is actually active. Its runs are never analysed.

**Fixed in code and hashed before the runs:**
- `experiments/synergy/protocol.ts`: arms, contrasts, intervals, verdict rules.
- `analyze.ts`.
- `plans/*.json`.
- The stage-eval `Arm.config` extension.
- The two new suite tasks `fixtures/suite/e1-retracted-cap-ko` and `fixtures/suite/e2-changed-default-ko`.

The hashes are in `results/synergy/prereg-hashes-*.txt`.

## 1. Candidates

The inventory and the reasons for each choice are in README.md §1-§2.

| study | factor x | factor y | mechanism hypothesis |
|---|---|---|---|
| S1 | plan advisor (`single.advisor`) | phase thinking policy (`thinkingPolicy: "phase"`) | The advisor critiques the plan once, at a cost of +30% (measured earlier). Phase runs steps below baseline effort and gates done nodes on verified checkpoint evidence. **Hypothesis H1:** the advisor's plan critique compensates for lower-effort steps, and phase's savings offset the advisor's cost. If both hold, the success interaction is ≥ 0 and the cost interaction is ≤ 0. |
| S2 | decision memory (`workerCompaction.decisionMemory`) | evidence linkage (`thinkingPolicy.evidence: "warn"`) | Decision memory's checkpoint-citation selection matches only `T<n>` references, and those exist only with linkage (experiments/decision-memory-ab: retention 54% without linkage, 80% with it, in conditions that were not contemporaneous). **Hypothesis H2:** with forced compaction, linkage makes decision memory's smaller restored context harmless or helpful, so the success interaction is ≥ 0. |

**Plausible negative interactions.**
- **S1.**
  - Advisor notes reset phase to baseline for the next plan, which adds cost.
  - Phase's checkpoint and evidence gate may reject work that the advisor caused to be redone.
  - The advisor may push stale or extra requirements. The adverse tasks e1 and e2 check this: there a requirement was withdrawn or changed, and the repository README still states the old one.
- **S2.**
  - Decision memory hid failing project checks in earlier runs (14 of 19).
  - Linkage adds reference text to every tool result.

## 2. Conditions held equal

- **Harness.** stage-eval (docs/stage-eval.md §2), unchanged except `Arm.config`:
  - the real `pi` CLI 1.5.2 (`/home/arthur/.bun/bin/pi`), with the task as the user's message;
  - main → `orche_task` → worker;
  - a logging proxy;
  - a private agent dir;
  - the fixed unattended clarification text.
- **Model.** `cliproxyapi/claude-opus-5-5`, thinking high, for main, worker and sub-workers. The advisor runs on `cliproxyapi/gpt-6-astra` with main's thinking, as in the user's configuration.
- **orche runtime.** The CURRENT WORKING TREE, frozen once as runtime `syn` (`results/synergy/<study>/runtimes/syn/REVISION.json`). It includes the uncommitted `single.verifierOriginal` option, which defaults to off and stays off.
- **What the arms change.** Only the `orche.config.json` keys listed in `protocol.ts` S1/S2. Everything else is the stage-eval single arm (mainCompaction 0.8, maxSubWorkers 8, product defaults).
- **S2 only.** Every S2 arm uses forced early worker compaction: `absolute` policy, trigger 48,000 tokens, keep 3,000, extended essentials.
  - This is not the user's setting. Without it decision memory never acts on these tasks.
  - A pilot-only adjustment of the trigger is allowed (§7). It must be recorded in README.md before the main S2 runs.

## 3. Tasks and ground truth

**S1 tasks (10).**
- The 8 stage-eval tasks: d8-build-graph, d1-transactional-outbox, sqlfluff-7615, docstub-123, tox-3904, build-1027, mtplx-21, stravalib-709.
  - Re-validated model-free today: `results/synergy/validation-stage8.json` is VALIDATION OK. The start state fails, the reference passes, and a weakened test is flagged.
  - Disclosure: they are **previously inspected**. docs/stage-eval.md ran them with and without the advisor; there the advisor was 12/24 against 10/24. Nothing was tuned on them, but they are not held-out for the advisor's main effect.
- 2 new adverse suite tasks (validation `results/synergy/validation-adverse.json` OK):
  - e1: a result cap that the instruction withdraws, while the README still states it.
  - e2: a default that the instruction changes from 30 s to 10 s, while the README still says 30 s.

**S2 tasks (8).** The 8 stage-eval tasks.

**Ground truth.** The primary outcome is stage-eval **primary success**: terminal `done`, the independent grader passing (original visible tests plus hidden tests, on a restored copy), and no integrity violation. The agents never see the grader. The labels come from hidden tests written before this study; for e1 and e2 I wrote them, and they are validated against the reference solutions.

## 4. Metrics

**Unit.** The task. Replicates are averaged within a task-cell. Infra runs are excluded after the harness's single infra retry; the first attempt and its cost are kept and reported. There is no other exclusion: no-task, failed, timeout and blocked runs count as failures.

**Primary, per study.** The success interaction `I = (xy − x − y + base)`, averaged over tasks, with:
- a 95% percentile bootstrap over tasks (20,000 draws);
- an exact sign-flip p-value over task-level interactions.

**Secondary.**
- Main effects.
- xy − base.
- xy − best single cell.
- Cost per run and its interaction.
- Cost per success.
- Median wall time.
- Per-task cells.
- Activation counts:
  - advisor processed;
  - phase policy;
  - requests below baseline;
  - compactions;
  - runs with `[orche ref T<n>]`;
  - leak and wire anomalies.
- For e1 and e2: success per arm, a harm check against stale requirements.

## 5. Verdict rules (fixed)

**Interaction**, from the 95% interval of I:

| verdict | condition |
|---|---|
| SYNERGY | lower bound > 0 |
| ANTAGONISM | upper bound < 0 |
| NO MATERIAL INTERACTION | interval inside [−0.15, +0.15] |
| INCONCLUSIVE | otherwise |

**Practically useful combination.** All three must hold:
- the 95% interval of xy − base lies above 0;
- xy is at least 10 points above the best single cell, at the point estimate;
- xy costs at most 1.5× the baseline per run.

**Cost synergy (reported, S1).** The 95% interval of the cost interaction lies below 0.

**Inference.** A non-significant result is reported as INCONCLUSIVE, not as "no effect". "No material interaction" is claimed only by the equivalence rule above.

## 6. Design, resources, stopping

- **Design.** Complete 2×2 sets, block-randomized: inside each (task, repeat) block the four arms run in a seeded random order (stage-eval `schedule`, seed `synergy-2026-11-15`).
  - S1: 10 tasks × 4 arms × 3 repeats = 120 runs.
  - S2: 8 tasks × 4 arms × 2 repeats = 64 runs.
  - Fixed sample, no interim look.
- **Admission budgets.** Catalog-price estimates from the wire log, all roles included. Beyond a budget, no new run starts; a run already in flight may exceed it.

| phase | budget | maxRuns |
|---|---|---|
| pilot S1 | $15 | 10 |
| pilot S2 | $10 | 6 |
| S1 | $150 | 135 |
| S2 | $110 | 75 |

  The total ceiling is $285. Blind label adjudication is not planned: the ground truth is hidden tests, validated model-free.
- **Stopping.** A study ends when all its runs are done or a budget or maxRuns limit is reached. An incomplete study is analysed on the complete task sets only (a task with all four cells), and the gap is reported.
- **Infra.** One retry for runs with no successful model request, or a harness failure (stage-eval rule).

## 7. Pilot (excluded from analysis)

- **Runs.** S1: e2 and d8, 1 repeat of each arm (8 runs). S2: build-1027, 1 repeat of each arm (4 runs).
- **Checks.**
  - The advisor ran in A and AP only.
  - Phase is active in P and AP only.
  - S2: compaction happened.
  - T-refs appear in L and ML only.
  - Decision memory is set in M and ML only.
  - No leak or wire anomaly.
  - Grades are produced.
- **Allowed adaptations.** Only tooling fixes, and the S2 trigger (if no compaction happens, or the runs spend more than about 3× the pilot S1 runs per run). Any adaptation is recorded in README.md before the main runs, and the plans are regenerated before launch.

## 8. Amendments after the pilot, before any scored run (2026-11-15 ~16:00 UTC)

Pilot data are excluded (§7). Each amendment is fixed before `results/synergy/s1` and `results/synergy/s2` are launched; hashes in `results/synergy/prereg-hashes-*-amended.txt`.

- **A0 Harness repair (provider switch, tooling only).**
  - The first two pilot launches returned 404 (`/chat/completions` without `/v1`), then `Unknown model: cliproxyapi/claude-opus-5-5` in every `orche_task`.
  - Cause: on 2026-11-12, after the stage-eval study, the cliproxyapi bundle switched its upstream provider package. The new provider:
    - expects a `/v1` base URL;
    - reads its model list only from a disk cache keyed by base URL;
    - routes Claude through Anthropic Messages.
  - Experiment-only repairs:
    - `stage-eval/env.ts` passes `<proxy>/v1`;
    - `seedProviderCatalog` copies the user's cached model-id list to the run's proxy key, read-only on the user's entry, and removes it after the run;
    - `proxy.mjs`/`protocol.ts` read Anthropic Messages usage, pricing cache writes at the catalog `cacheWrite` rate.
  - Those failed attempts cost $0. They are archived under `results/synergy/attempts/`.
  - Consequence: wire roles of Claude requests are `other`. Anthropic requests carry no `prompt_cache_key`, so the per-role cost split is unavailable, but total cost is complete. Model and effort checks still run.
- **A1 Primary outcome: done ∧ grader pass.**
  - In the pilot, 5 of 12 runs that the grader passed (original tests restored, hidden tests added) failed stage-eval's strict primary only through an integrity violation. The violations were benign test edits, such as extending the `import { createClient }` line or a fixture helper signature.
  - The grader restores the original tests, so a test edit cannot make a run pass.
  - The strict stage-eval primary (also no integrity violation) becomes the preregistered **sensitivity** analysis (`strictSensitivity`), with the same rules. Integrity violations are still counted per arm.
- **A2 Activation measures.** `analyze.ts` now counts the following from transcripts:
  - evidence linkage from tool *results* only (the tool schema quotes `[orche ref T12]`);
  - checkpoint citations of `T<n>`;
  - decision-memory work logs, via the heading "Decision-linked work evidence".
  - Pilot activation was as intended. Advisor: A 2/2, AP 2/2, C/P 0. Phase: P/AP only. S2: compaction in 4/4 runs, linkage and citations in L/ML only, decision-memory logs in M/ML only.
- **A3 Unchanged.**
  - S2 trigger 48k: compaction happened in all 4 pilot runs, at $1.2–2.1 per run.
  - Tasks, arms, repeats, budgets.
  - `leakAudit` hits come from the task prompt's own word "hidden". Same as the stage-eval baseline, so they are not counted as leaks.
- **Limits stated in advance.**
  - **Compute.** No compute-matched control. A success effect of the advisor or AP cannot be separated from the added model calls; the cost interaction is reported instead.
  - **S2 task mix.** S2 has no adverse task. e1 and e2 never reach 48k worker tokens in the pilot.
