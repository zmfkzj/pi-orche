# Synergy of inconclusive orche features (2×2 factorial studies)

**Question.** Among orche's experimental features whose effect is still undecided, do any two complement each other? Synergy means the combination beats what the two single features predict when added. It is not enough for the combination to beat the baseline with more spending.

- Preregistration: `PREREGISTRATION.md`. §8 holds the amendments, made after the pilot and before any scored run.
- Harness: `experiments/stage-eval`. That is a real `pi` CLI → main → `orche_task` → worker, graded independently by hidden tests.
- Results: `results/synergy/` (gitignored).

## 1. Inventory (sources, chronological where follow-ups exist)

| feature (experiment name) | current switch, default | evidence | class | runnable |
|---|---|---|---|---|
| plan advisor | `single.advisor`, off | advisor-reviewer bench 9/20 vs 12/20, not significant (docs/advisor-reviewer-bench.md); stage-eval C 10/24 vs D 12/24, CI includes 0, +$0.32/run (docs/stage-eval.md:29-33) | **inconclusive / underpowered** | yes |
| verifier original supplement | `single.verifierOriginal`, off | verifier-only A/B on 72 cases: balanced accuracy +1.4pp [−6.2, 9.6]; missed violations fell, false rejections rose (experiments/verifier-original-ab) | **inconclusive**. Task level: 0 of 56 stage-eval single runs started a sub-worker, so it would almost never activate there. | yes |
| phase thinking policy | `thinkingPolicy: "phase"`, `"fixed"` | "Real-model quality is not measured yet" (docs/thinking-policy.md:3-4) | **untested** (cost lever) | yes |
| decision memory | `workerCompaction.decisionMemory`, off (needs `essentials: "extended"`) | renderer-only replay (experiments/feature-effects), superseded by the real-model study experiments/decision-memory-ab: 6/6 vs 6/6; cost $12.65 vs $9.85, p 0.69; shown unresolved failures 16/16 → 8/30 | **inconclusive**, with a known risk of hiding failures | yes |
| evidence linkage | `thinkingPolicy: {mode:"fixed", evidence:"warn"}`, off in fixed | Checkpoint selection matches only `T<n>` references. Retention 54% → 80% with linkage, post hoc and not contemporaneous (decision-memory-ab) | **untested as a factor** | yes |
| strong reflection / decision audit | `single.strongReflection` (strong mode) | first trial: no change; preregistered bench: verdict **stop**, hypothesis **contradicted** (docs/strong-reflection.md:190,210) | negative, excluded | yes |
| ledger | `single.ledger`, off | G-L: no quality gain (docs/orchestrator.md:60) | no benefit, excluded | yes |
| MDSD mode | `mainMode`/mdsd | study verdict **not supported** (docs/mdsd-ab-bench.md:188) | rejected | yes |
| contract-backward explorer (CB) | experiment only | **not supported**, also on validation (docs/cb-ab-bench.md:77,162,190) | rejected | experiment only |
| ultra mode | ultra | pre-registered verdict **ultra-inferior** on interim data, user stop (results/ultra-ab/main/summary-main.md:17, STOPPED.md) | harmful as tested, excluded | yes |
| v2 Framer + risk Verifier | removed | G-X 22/24 vs 23/24 at 1.83× cost per success (docs/specialist-orchestration.md) | rejected | no |
| multi / coordinator, DAG parallel | removed | 72/84 vs 84/84 at 6× cost; Gate A NO-GO | rejected | no |
| mainReview, stage-eval #5 regression_check, #7 ambiguity rule | removed | report-only (G-M2); removed 2026-11-13 | rejected / superseded | no (frozen runtime only) |
| headroom pool, witness replay | experiment only | negative under the frozen promotion rule (docs/headroom-pool.md:15; results/witness-replay) | negative | no |
| image cleanup (#2), test-output reduction (#6) | product | measured behaviour gains (docs/stage-eval.md:34-41) | kept, beneficial | — |

## 2. Selected combinations and why

Both pairs use only inconclusive or untested features with current switches. They differ from each other in mechanism.

**S1: advisor × phase thinking policy.**
- The advisor adds one plan critique, at a cost of about +30%. It targets missed requirements and wrong plans.
- Phase runs exploration and implementation below baseline effort, gates `done` nodes on checkpoint evidence, and escalates on a report or a failure.
- Expected complementarity:
  - The plan critique protects against the risk of low-effort steps.
  - Phase's savings pay for the advisor.
- Plausible antagonism:
  - The advisor's re-plan resets effort.
  - The evidence gate rejects work redone after the advisor's notes.
  - Stale requirements get pushed. e1 and e2 are tasks where a requirement is withdrawn or changed while the README still states the old one.

**S2: decision memory × evidence linkage.**
- Decision memory restores a smaller, decision-linked work log after compaction. It selects cited calls by `T<n>`, which exists only with linkage.
- Without linkage it can drop the evidence behind later decisions (54% retention). With linkage, the earlier figure was 80%, but under different conditions.
- This pair has a direct mechanistic dependency, which makes it the cleanest synergy test.
- Plausible antagonism:
  - Hidden failing checks: decision memory hid 14 of 19 earlier.
  - Linkage text on every result.

**Excluded combinations.**
- **verifierOriginal × anything at task level.** Single-mode runs on these tasks never start verification sub-workers (0 of 56 stage-eval C/D runs), so the factor would be inert. Its verifier-level A/B is already done.
- **strongReflection, ledger, MDSD, CB, ultra, v2, multi, DAG.** Each is rejected, negative or without benefit. Pairing them would resurrect them.
- **advisor × decisionMemory.** The mechanisms do not touch each other: the advisor critiques the plan before work, while decision memory acts after compaction. That gives no reason to expect an interaction, and the budget is better spent on the dependent pair.

## 3. Design (details in PREREGISTRATION.md)

**Format.** Complete 2×2 sets, block-randomized per (task, repeat). Same model (`claude-opus-5-5`, high), same frozen runtime `syn` (working tree incl. uncommitted changes, digest `9bb42236…`), only the listed config keys differ (`protocol.ts`).

| study | arms | tasks | repeats | runs |
|---|---|---|---|---:|
| S1 | C / A / P / AP | 8 stage-eval + e1, e2 (adverse) | 3 | 120 |
| S2 | K / M / L / ML, forced compaction at 48k worker tokens | 8 stage-eval | 2 | 64 |

**Primary (A1).** Done ∧ independent grader pass. The strict stage-eval primary, which also requires no test-integrity violation, is the sensitivity analysis.

**Interaction.** I = AB − A − B + base per task, with a task bootstrap and an exact sign-flip test.

| verdict | rule |
|---|---|
| SYNERGY / ANTAGONISM | the 95% CI excludes 0 |
| NO MATERIAL INTERACTION | the CI lies inside ±0.15 |
| INCONCLUSIVE | otherwise |

**Practically useful.** All three must hold: AB − base has a CI above 0; AB is at least +10 points over the best single feature; cost is at most 1.5× the baseline.

**Budgets.** pilot S1 $15, pilot S2 $10, S1 $150, S2 $110 (total ≤ $285, catalog prices).

## 4. Fixtures

- `fixtures/suite/e1-retracted-cap-ko`: a docsearch relevance sort. The instruction withdraws the 10-result cap that the README still states.
- `fixtures/suite/e2-changed-default-ko`: `createClient` `timeoutMs`. The default changes from 30 s to 10 s, while the README says 30 s.
- Validation is model-free:

```bash
ADVISOR_BENCH_SWE_CACHE=<swe-cache> TMPDIR=<scratch> npx tsx experiments/ultra-ab/validate.ts results/synergy/validation-adverse.json e1-retracted-cap-ko e2-changed-default-ko
```

The checks: the start state fails, the reference passes, and a weakened test is flagged. The 8 stage tasks were re-validated the same way (`validation-stage8.json`).

## 5. Running

```bash
npx tsx experiments/synergy/plans.ts                       # regenerate plans/*.json
npx tsx experiments/stage-eval/driver.ts freeze results/synergy/s1 syn
npx tsx experiments/stage-eval/driver.ts run experiments/synergy/plans/s1.json
npx tsx experiments/synergy/analyze.ts results/synergy/s1 S1 --out results/synergy/s1/summary.json
npx vitest run test/experiments/synergy.test.ts            # model-free checks of arms, plans, contrasts, accounting
```

## 6. Experiment-only harness adaptations (no product change)

These were made during the pilot, before any scored run. The full account is in PREREGISTRATION §8 A0.

- **New provider package (since 2026-11-12).** The cliproxyapi bundle now wraps a provider package that:
  - expects a `/v1` base URL;
  - reads its model list only from a per-base-URL disk cache;
  - routes Claude through Anthropic Messages.
- **Harness changes.**
  - `stage-eval/env.ts` passes `<proxy>/v1`.
  - `seedProviderCatalog` copies the user's cached model-id list to the per-run proxy key and deletes it after the run. The user's own entry is only read.
  - `proxy.mjs` reads Anthropic usage, including cache writes.
  - `protocol.ts` prices cache writes at the catalog `cacheWrite` rate.
- **Consequence.** Claude requests have no session key, so the per-role cost split shows them as `other`. Totals are complete.

## 7. Results (2026-11-15; `results/synergy/{s1,s2}/summary.json`)

**Spend at catalog prices: $235.85**, within the $285 ceiling.

| item | cost |
|---|---:|
| pilot S1 | $7.61 |
| pilot S2 | $6.04 |
| smoke | $0.50 |
| S1 (120/120 runs) | $141.27 |
| S2 (64/64 runs) | $80.42 |

- Infra retries: 0.
- One S1 run hit the 120-minute harness guard (d8/AP/r2: a mutation-test bash command hung). Per the protocol it counts as a failure.
- Activation was complete:
  - S1: advisor 30/30 A, 29/30 AP (in the timed-out run the advisor made 6 requests, but its notes were never processed); phase 30/30 P and 30/30 AP; 0 in C.
  - S2: compaction in 9–10 of 16 runs per arm; linkage in 16/16 L and ML; `T<n>` citations in 15/16; decision-memory logs in 10/16 M and ML; none in the other arms.
- Unexpected wire events: 0. Leak-audit hits are the prompt's own word "hidden" (§8 A3).

### S1: advisor (A) × phase thinking (P), 10 tasks × 3 repeats

| arm | graded success | strict (no integrity violation) | cost/run | cost/success | median wall |
|---|---:|---:|---:|---:|---:|
| C base | 19/30 (63.3%) | 15/30 | $0.915 | $1.44 | 264 s |
| A advisor | 21/30 (70.0%) | 15/30 | $1.240 | $1.77 | 319 s |
| P phase | 19/30 (63.3%) | 15/30 | $1.130 | $1.78 | 278 s |
| AP both | 20/30 (66.7%) | 13/30 | $1.424 | $2.14 | 282 s |

**Success effects (task means, 95% task-bootstrap CI).**

| contrast | estimate |
|---|---|
| advisor main effect | +5.0pp [0, +13.3] |
| phase main effect | −1.7pp [−5.0, 0] |
| **interaction** | **−3.3pp [−23.3, +16.7]**, sign-flip p = 1 → **INCONCLUSIVE** |
| AP − C | +3.3pp [0, +10.0] |
| AP − best single | −3.3pp |

- Not practically useful. All three criteria fail: the AP − C lower bound is 0, AP − best single is −3.3pp, and the cost ratio is 1.56.
- Strict sensitivity: interaction −6.7pp [−33.3, +20.0], INCONCLUSIVE.

**Cost effects per run.**

| contrast | estimate |
|---|---|
| advisor | +$0.31 [0.23, 0.41] |
| phase | **+$0.20 [0.12, 0.30]** |
| interaction | −$0.03 [−0.11, +0.06] |

- No cost synergy: the interval of the cost interaction includes 0.
- Phase did not save cost. It raised it: Anthropic cache writes went from 1.65M to 3.05M tokens over 30 runs, at the $5/M write rate. Output tokens were unchanged (0.657M vs 0.647M). The wire log shows 342 of 808 requests below `high` (327 `medium`, 15 `low`). The extra writes, about $7.0 at $5/M, cover the $6.46 difference between P and C. That effort switches re-write the prompt cache is an inference from this wire data, not a direct observation.

**Adverse tasks (requirement withdrawn or changed).**
- e1 and e2 were graded 3/3 in every arm, so the advisor did not reintroduce the stale README requirement.
- Strict scores vary only through benign test edits.

**Saturation.** 7 of 10 tasks are identical across arms:
- all 0: d1, docstub;
- all 100: e1, e2, build, stravalib, tox.

Only d8, sqlfluff and mtplx carry information.

### S2: decision memory (M) × evidence linkage (L), forced compaction at 48k, 8 tasks × 2 repeats

| arm | graded success | strict | cost/run | cost/success | median wall |
|---|---:|---:|---:|---:|---:|
| K base | 8/16 | 5/16 | $1.219 | $2.44 | 386 s |
| M memory | 9/16 | 7/16 | $1.228 | $2.18 | 441 s |
| L linkage | 9/16 | 8/16 | $1.252 | $2.23 | 409 s |
| ML both | 10/16 | 8/16 | $1.329 | $2.13 | 408 s |

**Success effects.**

| contrast | estimate |
|---|---|
| memory main effect | +6.25pp [−12.5, +25.0] |
| linkage main effect | +6.25pp [0, +18.75] |
| **interaction** | **0 [0, 0]** → rule verdict **NO MATERIAL INTERACTION** |
| ML − K | +12.5pp [0, +31.25], sign-flip p = 0.5 |
| ML − best single | +6.25pp, below the +10pp threshold → not practically useful |

- Cost ratio: 1.09. Cost interaction: +$0.07 [−0.22, +0.33].
- Strict sensitivity: interaction −12.5pp [−31.25, 0], INCONCLUSIVE.
- **The equivalence is weak.**
  - 5 of 8 tasks are identical in all arms: d1 and docstub at 0; build, stravalib and tox at 100.
  - All 8 task-level interactions are exactly 0, so the bootstrap interval is degenerate.
  - A single flipped run moves the study interaction by 6.25pp (0.5/8).
- Not measured here: whether decision memory hides unresolved failures (the decision-memory-ab metric).

### Verdict

**Neither pair shows synergy.**
- **S1: INCONCLUSIVE.** The advisor's success effect is +5.0pp [0, +13.3], which is itself inconclusive, at +36% cost. Phase costs +24% on this Anthropic route with no measured quality gain.
- **S2: no material interaction under the preregistered rule.** That equivalence is fragile because of saturation. Decision memory plus linkage is cheap (+9%) and directionally positive (+12.5pp, CI touching 0).
- **Neither combination meets the usefulness rule. None is recommended for adoption.**
- **Phase failed as a cost lever on this route:** cost +$0.20/run, CI [0.12, 0.30], above 0. This is a secondary contrast with no preregistered verdict rule. Using phase to save money would first need effort changes that keep the cache.
- **Further targeted evaluation is justified only for S2.** It would need non-saturated, longer tasks with real compaction pressure, unresolved-failure cases, and many more tasks rather than repeats.
  - That re-evaluation is `experiments/decision-memory-b` (README §Results). It found no synergy: the score interaction was +0.006 [−0.086, +0.106] on 40 instances, which is INCONCLUSIVE. It also found no quality gain, but a cost reduction, mainly from decision memory.

**Independent check.** A fresh read-only verify sub-worker recomputed every number in this section from the raw `meta.json` and `wire.jsonl` files. It used its own scripts and its own port of the seed-7 bootstrap, and everything matched. It flagged wording that overstated the evidence; those passages were corrected.
