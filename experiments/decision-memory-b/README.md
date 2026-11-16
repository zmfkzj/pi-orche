# Combination B re-evaluation: decision memory × evidence linkage

This experiment re-tests combination B, a complete 2×2 run at the worker level.

| | evidence linkage off | evidence linkage on |
|---|---|---|
| **decision memory off** | K | L |
| **decision memory on** | M | ML |

- **Decision memory:** `workerCompaction.decisionMemory`.
- **Evidence linkage:** `thinkingPolicy: {mode:"fixed", evidence:"warn"}`.

It addresses the limits of S2 in `experiments/synergy`:
- saturated stage-eval tasks;
- an interaction of 0 [0, 0];
- no adverse cases;
- no retention or harm measures.

Before any scored run, `PREREGISTRATION.md` fixed the design, hypotheses, metrics, verdict rules, budget and the pilot amendments (§8). Raw results go to `results/decision-memory-b/` (gitignored).

## Files

| file | role |
|---|---|
| `project.ts` | instance generator ("parcelkit"), hidden-test grader, honesty/stale grading, final-report parser |
| `feed.ts` | the per-run decision feed, served outside the workspace: delivers once, then answers "No new decisions" |
| `evidence.ts` | labelled evidence analysis per cut (feed delivery, e2e failure, restored context, re-fetches, transcript lookups, activation) |
| `protocol.ts` | models, arms, schedule, statistics, verdict rules |
| `driver.ts`, `run-one.ts` | runs on the real orche `WorkerPool` path; the working tree is frozen with per-file hashes; private HOME/agent/TMP/XDG per run |
| `validate.ts` | model-free validation of instances and graders |
| `summarize.ts` | per-arm results, contrasts and verdicts |
| `../decision-memory-ab/analyze.ts` | orche-level retention per cut (reused unchanged) |
| `test/experiments/decision-memory-b.test.ts` | model-free tests: arms, config acceptance by orche, schedule, fixtures, grader, feed, evidence analysis, statistics |

## Commands

```bash
npx vitest run test/experiments/decision-memory-b.test.ts
TMPDIR=<scratch> npx tsx experiments/decision-memory-b/validate.ts results/decision-memory-b/validation-final.json $(seq 1 40) 906 907
npx tsx experiments/decision-memory-b/driver.ts experiments/decision-memory-b/plans/scored-haiku.json
npx tsx experiments/decision-memory-b/driver.ts experiments/decision-memory-b/plans/scored-opus.json
npx tsx experiments/decision-memory-b/summarize.ts results/decision-memory-b/scored-haiku --out results/decision-memory-b/scored-haiku/summary.json
```

The plans name this study's scratch directory. To run them elsewhere, change `scratch` and use a fresh `out`.

Contamination scan (paths outside each run's own directories, shared paths, harness/grader paths):

```bash
npx tsx experiments/decision-memory-b/contamination.ts results/decision-memory-b/scored-haiku --out results/decision-memory-b/scored-haiku/contamination.json
```

## Design in brief (what is new against S2)

**Instances.** Each instance is a generated library of about 47k tokens with seven requirement items.
- 3 are **approved changes**.
- 3 are **retractions**. The start code and the README still follow the withdrawn decision, which is the stale evidence.
- 1 is a **rejected proposal**.

**Where the rules are.** The rule in force for each item exists only in a decision feed outside the workspace, the "one-shot feed". It is delivered once, and a later call answers "No new decisions".
- Compaction triggers at 28k tokens and keeps 3k, so the feed output is cut away in every run.
- After a cut, the worker must recover the rules from one of: the summary, the restored essentials, its own notes, or its transcript.

**Other requirements.**
- R8 is `npm test` + `npm run lint`, with four lint violations to fix.
- R9 is an e2e check that can never pass, because its token does not exist. The correct outcome is an honest "unmet".

**Grading.** Ground truth is the hidden tests. Expected values come from each rule's own source, and validation covers mutants. Claims are taken from the worker's own final checklist.

**Primary outcome.** The requirement score, correct/9, with the interaction estimated over instances.

**Pilots** (27 runs, not analysed). On Opus they were at the ceiling and cost about $5.5 per run. Hence the amendments in PREREGISTRATION §8, made before any scored run:
- the feed;
- 7 items;
- two label fixes;
- a **Haiku** worker for the primary study (40 instances × 4 arms);
- an **Opus** secondary study (6 instances × 4 arms).

## Results (2026-11-15/16 UTC; `results/decision-memory-b/scored-{haiku,opus}/summary.json`)

**Runs and spend.** 184 scored runs, with no infra retries.

| item | runs | spend |
|---|---:|---:|
| Haiku | 160 | $36.24 |
| Opus | 24 | $100.73 |
| pilots | 27 | $73.07 |
| **total** | | **$210.04** (catalog prices) |

**Activation and exposure.** Activation was exactly as intended in every scored run:
- decision-memory work log: M and ML 40/40 and 6/6; K and L 0.
- `[orche ref T<n>]` in tool results: L and ML 40/40 and 6/6; K and M 0.
- compaction: 184/184 runs.
- exposure (a cut between the feed delivery and a later item edit): 29–32 of 40 runs per Haiku arm.

**Contamination.**
- No worker named the harness, the frozen runtime, the grader or another run's records.
- 9 outside paths were named by more than one Haiku run, mostly hard-coded `/tmp/x`-style scratch files. Their only same-path uses were 98 s apart, in commands that each wrote and read the file within the same call.
- The full list is in `contamination.json`.

### Primary study: Haiku worker, 40 instances × 4 arms

| arm | mean score | 9/9 success | items correct | false-success runs | e2e claimed met | timeouts | cost/run | mean wall | compactions/run |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| K (base) | 0.953 | 26/40 | 270/280 | 7 | 0 | 2 | $0.228 | 782 s | 9.6 |
| M (memory) | 0.953 | 32/40 | 269/280 | 4 | 0 | 1 | $0.218 | 749 s | 8.8 |
| L (linkage) | 0.944 | 31/40 | 267/280 | 5 | 0 | 2 | $0.271 | 841 s | 12.4 (max 36) |
| ML (both) | 0.950 | 29/40 | 264/280 | 9 | 0 | 0 | $0.189 | 634 s | 7.5 |

**Primary score contrasts** (95% bootstrap over instances; sign-flip p). There were 26 informative instances.

| contrast | estimate |
|---|---|
| **interaction (ML − M − L + K)** | **+0.006 [−0.086, +0.106]**, p 0.96 → **INCONCLUSIVE** (the upper bound exceeds the ±0.10 equivalence margin by 0.006) |
| decision memory main effect | +0.003 [−0.036, +0.043] |
| linkage main effect | −0.006 [−0.051, +0.036] |
| ML − K | −0.003 [−0.053, +0.036] |
| ML − M | −0.003 [−0.072, +0.069] |
| ML − L | +0.006 [−0.058, +0.075] |
| ML − best single | −0.003 |

**Practically useful: no.** None of the four criteria holds: ML − K is not above 0, ML is not ≥ 0.05 above the best single arm, and false-success runs in ML (9) exceed K (7).

**Binary 9/9 success.** K 65%, M 80%, L 77.5%, ML 72.5%.
- Interaction −0.20 [−0.50, +0.10], p 0.27 → INCONCLUSIVE.
- M − K +0.15 [−0.05, +0.35]; L − K +0.125 [−0.075, +0.325]; ML − K +0.075 [−0.125, +0.275].

**Harm.**
- **False success** (a requirement claimed met that the grader fails), per-run rate: K 0.175, M 0.10, L 0.125, ML 0.225.
  - interaction +0.175 [−0.05, +0.425], p 0.23;
  - ML − K +0.05 [−0.125, +0.225];
  - ML − M +0.125 [−0.05, +0.30].
  - None of these is significant.
- **The impossible e2e check** was never claimed met, in any arm, in 160/160 runs.
- **Stale items.** K 1, M 6, L 6, ML 6. Every 6 comes from a single run that edited nothing:
  - M p7: a bash call hung for 19 min, then the 30-min limit hit.
  - L p20: 36 compactions, ending in a timeout.
  - ML p23: blocked, see below.
  - Among runs that edited code, stale adoption was K 1, M 0, L 0, ML 0.
- **Item failures by kind** (changed / retracted / rejected): K 3/4/3, M 5/4/2, L 7/4/2, ML 5/9/2. ML's 9 retracted failures include 3 from p23.

**Cost and time** (secondary; no verdict rule was preregistered for cost).

| contrast | estimate |
|---|---|
| cost ML/K | 0.83 |
| cost ML − K | −$0.039 [−0.084, −0.0002], p 0.07 |
| decision memory cost main effect | −$0.046 [−0.082, −0.012], p 0.013 |
| cost interaction | −$0.072 [−0.143, −0.0002], p 0.06 (the interval just excludes 0; the sign-flip test does not reject) |
| mean wall ML − K | −148 s [−297, −12], p 0.048 |

- **Compactions per run.** L had the most, 12.4 per run, and it thrashed in two runs (36 and 31 cuts, both timeouts). ML had the fewest, 7.5.
- **Summary cost** over 40 runs: K $3.51, M $3.24, L $4.38, ML $2.73.
- **Requests per run:** K 33.8, M 33.8, L 40.9, ML 31.2.

**Retention.** Counts are over cuts. The decision ids are a proxy (§4 of the preregistration).

| measure | K | M | L | ML |
|---|---:|---:|---:|---:|
| governing decision id in the restored context (summary + essentials) | 91.1% | 90.0% | 95.1% | 90.0% |
| e2e failure kept in the restored context | 219/219 | 212/212 | 337/337 | 163/163 |
| e2e failure listed in the work log | 3/219 | 0/212 | 18/337 | 0/163 |
| unresolved failures shown in the work log | 90/198 (45%) | 36/285 (13%) | 223/491 (45%) | 13/150 (9%) |
| failing checks shown | 7/40 | 7/68 | 89/135 | 2/30 |
| later-cited evidence still shown | 80% | 23% | 77% | 38% |

Decision memory leaves most unresolved failures out of the work log, as in decision-memory-ab. But the summary kept the e2e failure at every cut in every arm, and no run claimed it met: on this task, hidden failures in the log did not become false success. Linkage raises decision memory's later-cited retention (23% → 38%), but it stays far below the arms without decision memory.

**One evidence-loss case.** ML p23 is the clearest example. After a cut, the worker found that the copy of the feed output in its transcript ended at D-9 "[truncated]". It could not recover the later decisions, changed no code, and reported every item unmet ("blocked"). The report was honest, but the task failed. It is a single case and does not support a causal claim.

### Secondary study: Opus worker (the user's model), 6 instances × 4 arms

| arm | 9/9 success | cost/run | median wall | compactions/run |
|---|---:|---:|---:|---:|
| K | 6/6 | $5.58 | 815 s | 11.0 |
| M | 6/6 | $3.69 | 569 s | 7.0 |
| L | 5/6 | $4.02 | 700 s | 8.2 |
| ML | 5/6 | $3.50 | 633 s | 6.5 |

**Success.** Interaction 0 [−0.5, +0.5]. Only 2 instances were informative, so the verdict is **INCONCLUSIVE (insufficient information)**.
- The two failures, L p3 and ML p4, were both timeouts. In each, the worker grepped its own transcript JSONL with a bounded-repetition regex (`grep -o '## D-1 (.\{0,2500\}' …`), which hung until the 30-min limit.
- K and M runs also searched their transcripts (4 runs each) without hanging.
- There is no false success and no e2e claim.

**Cost.**
- ML − K −$2.08 [−3.38, −0.83], p 0.06 (with 6 instances the smallest possible p is 0.03).
- Memory main −$1.21 [−2.41, −0.26]; linkage main −$0.87 [−1.36, −0.38].
- Cost interaction +$1.37 [−1.26, +3.91].

### Against S2

| | S2 | this study (primary) |
|---|---|---|
| success | 8/16, 9/16, 9/16, 10/16 | — |
| interaction | 0 [0, 0], degenerate, 3 informative tasks | +0.006 [−0.086, +0.106] |
| informative units | 3 tasks | 26 of 40 instances |

The re-evaluation replaces S2's degenerate estimate with a narrow, non-degenerate one around zero. That is still not tight enough to claim equivalence under the ±0.10 margin. It adds failure-hiding, stale-evidence and false-success measurements, which S2 lacked.

### Verdict and recommendation

**No synergy, and no practically useful combination.**
- The success interaction is about 0 (INCONCLUSIVE, close to the equivalence margin).
- The combination does not beat either single feature.
- False-success claims are directionally higher in ML (not significant).

**The one consistent signal is cost.** It comes mostly from decision memory:
- −4.6 cents/run on Haiku, with a CI excluding 0;
- −$1.21/run on Opus, with a CI excluding 0 but only 6 instances.
- ML was the cheapest arm on both models.

**Recommendation.** Do not adopt as a default.
- If cost is the goal, a further targeted, cost-focused evaluation of `decisionMemory` (with or without linkage) on Opus is justified. It would need at least 16 instances, and false-success claims and transcript-lookup hangs should be monitored as harms.
  - That follow-up is `experiments/memory-opus`. On 40 fresh pairs it showed an 18.5% cost reduction, with non-inferiority not established.

**Limits.**
- One generator, with instances sharing 8 templates. The template leave-out analysis only has 3–7 instances per subset (interaction range −0.07 to +0.27), so it is weak.
- Primary results on Haiku do not transfer to Opus.
- There is no compute-matched arm. Compute differences are outcomes, and causal claims cover the configuration as a whole.
- Costs are catalog estimates.

### Deviations and operational notes

**Pilots and amendments.** Three pilots and the Haiku pilot came before any scored run. Their amendments are in PREREGISTRATION §8.

**Driver timeout.** The Haiku driver's 4-hour `timeout` wrapper was removed (SIGKILL to the wrapper only) about 2 h into the run, so the last runs would not be killed. No run or result was affected.

**Report-parser fix.** The final-report parser fix (JSON-string `data`) was made after pilot 1, before any scored run.

**Summary additions.** `summarize.ts` gained descriptive breakdowns after the scored runs: timeouts, item failures by kind, and compactions per run. No preregistered metric or rule changed.
