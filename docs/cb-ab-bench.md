# Contract-backward explorer vs ordinary `/orche strong` (experiments/cb-ab, stage 1)

## Question

Does MDSD's contract-backward search mechanism ([mdsd.md](mdsd.md): one read-only explorer with the operators INVERT and VALIDATE, direction backward), added to ordinary `/orche strong`, make the final defect report contain real known defects that strong alone misses, without more false or out-of-scope claims? And is any gain due to the contract-backward method rather than to one more worker's inference?

- **H1** (mechanism vs ordinary strong): B finds known defects that A misses.
- **H2** (method, not compute): B finds known defects that C misses.
- Only the search mechanism is tested. Full MDSD (adaptive rounds, seed accounting, integration machinery) does not run.

The protocol was declared before any case was examined and before any measured run: `results/cb-ab/PROTOCOL.md` (sha256 `59e38030f8d8…` in `results/cb-ab/study/manifest.json`; amendments A1 and A2 were made before the first measured run). Its pure rules are code in `experiments/cb-ab/protocol.ts`, also hashed into the manifest.

## Arms

The arms are identical except for an analysis step appended to the prompt.

| Arm | One-shot | Extra |
|---|---|---|
| A | `/orche strong <prompt>` | none (strong may still spawn sub-workers on its own) |
| B | `/orche strong <prompt><B step>` | one required read-only explorer, `contract-backward`, given `CB_BRIEF` and the full request verbatim, before the final answer |
| C | `/orche strong <prompt><C step>` | the same required explorer, `independent-explorer`, given `GENERIC_BRIEF` (the compute control) |

- **Texts** (`protocol.ts`): `diagnosisPrompt` (a read-only diagnosis of the verbatim bug report), `armSuffix`, `CB_BRIEF`, `GENERIC_BRIEF`. The appended step asks for exactly one `orche_spawn` (reason `isolation`, role `answer`) whose request is the brief plus the full request, verbatim.
- **`CB_BRIEF`:** state the contracts the reported behaviour must satisfy, work backward from each guaranteed outcome to every place that produces it, try to violate the contract there with a probe or rule it out with a precise trace, and report each violation with its evidence. It is derived from r1's INVERT+VALIDATE strategy in [mdsd-ab-bench.md](mdsd-ab-bench.md), the path that found that run's additional known defect.
- **`GENERIC_BRIEF`:** an independent investigation by the explorer's own judgment, with the same report format and evidence norm.
- B and C differ only in the brief and the explorer name. Declared reading: B > A without B > C is "supported, not isolated from compute".
- Compliance (one spawn, brief verbatim) is measured from the records; the analysis is by assigned arm (intention to treat), with non-compliant runs flagged.

## Conditions, identical for every arm

- **Model and effort:** every role on `cliproxyapi/gpt-6.1-sol` at `high`: main (`--thinking high`) and every orche tier (`protocol.ts` `orcheConfig`), sub-workers inheriting. No `xhigh` or `max` anywhere.
- **Verified on the wire:** a logging proxy per run records each request's model, request-level and configuration-update efforts, response model and usage, attributed to its session (main, orchestrator, explorer, other sub-workers). Every request must be `gpt-6.1-sol`/`high` with response model `gpt-6.1-sol`.
- **Configuration:** advisor off; Bash review off (its classifier model is outside the pinned route); `thinkingPolicy` fixed with `lengthRecovery: "redecompose"` (an output-limit stop never lowers effort); concurrent-session prompts off; ledger off.
- **Runtime:** orche as committed at `7bbd66b` (`git archive`: uncommitted edits excluded), frozen with a sha256 per file.
- **Isolation:** a bubblewrap sandbox per run (empty tmpfs home; read-only toolchain, provider and runtime; private agent dir, scratch and target). The arms cannot see this repository (fixtures with hidden tests and reference fixes, results, records), the rubric or the other runs. The network is needed for the model proxy only; tool calls are audited for forbidden paths and fetches.
- **Target:** the task's pre-fix source snapshot, copied fresh per run without git history; its virtualenv read-only, with `python`/`pytest` wrappers.
- **Limits:** orche 60 min plus up to 2 × 15 min extensions while active, a soft budget of 300 requests per assignment, a 150-min process-group guard. No dollar envelope; every request is priced at the catalog list price.
- **Retries:** only for infrastructure (no successful model request), at most once, keeping the failed attempt. Timeouts, blocked or failed tasks, provider errors during a run and non-compliance are never retried.

## Cases

**Pool and order.** `fixtures/advisor-bench/swe` tasks with `validation.valid` and a prepared environment, not `_interface` and not exposed by earlier strong, ultra, MDSD or strong-reflection studies (`protocol.ts` `EXPOSED`), walked in a seeded order (`screeningOrder`, 15 tasks). The first three eligible tasks become c1, c2, c3. Declared eligibility:

- **E1:** the issue reports incorrect behaviour of existing functionality, is understandable offline from its text, and the hidden fail-to-pass tests fail before the reference fix and pass with it.
- **E2:** at least two known defects: distinct mechanisms the reference fix changes in non-test, non-documentation source, each with its own probe (or hidden test) that fails before the fix, passes with it, and still fails with only that item's hunks left out.
- **E3:** at least one known defect is not named by the issue (none of its file, function or class names appears in it).

**Amendment A1 (2026-10-23T20:35Z, before any measured run).** E1–E3 over the whole order found one eligible task, markdown-1587 (`results/cb-ab/cases/selection.md`). E3, a saturation-reduction heuristic outside H1/H2, was dropped; E1, E2 and the order stayed, nothing else was relaxed and no task was added. Under E1+E2:

| Case | Order | Task | Known defects |
|---|---|---|---|
| c1 | 3 | ucfopen__canvasapi-716 | 2, both in `obj_or_str`, which the issue names |
| c2 | 4 | python-markdown__markdown-1587 | 2 (`parse_comment`, `handle_comment`), neither named by the issue |
| c3 | 11 | hkuds__openharness-217 | 2, both in `DeviceCodeFlow._try_open_browser`, which the issue names |

c1 and c3 have both known defects inside the function the issue names, so their saturation risk was high; the saturation rule applied unchanged, and c1 and c2 formed the stopping gate. **Amendment A2** staggered the start: c2, whose rubric was complete before the first measured run, ran its six units first; c1 and c3 started only after their rubrics, completed by evaluator sessions that never read run outputs, were hashed into the manifest.

## Rubric and blind scoring

- **Rubric** (frozen before any measured run, outside every model-visible mount): per case the known defects with mechanism, pre-fix locations, triggering scenario and probe. Points per defect: M (mechanism right), L (right file and function, or within ±10 lines of the cited range), S (a concrete trigger). **Found** = M = 1 and L = 1. A scope note defines in-scope additional findings (the same behaviour or contract, including variants a complete fix must handle).
- **Frozen reports:** each run's final report (the last report of the worker of the last completed orche task, plus main's final text) is hashed before scoring.
- **Blind scoring:** `score.ts packets` labels each report randomly, redacts explorer and spawn wording (a report may still describe its own process) and seals the key. Fresh scorers outside the pipeline (the task manager's claude-opus-5-5 sub-workers) never see arm, repeat or transcripts. They give the K points and classify every other distinct claimed defect as **V** (in scope, confirmed by their own reproduction on the pre-fix snapshot or an unambiguous code trace), **F** (refuted that way, or out of scope) or **U** (in scope, neither confirmed nor refuted), merging restatements and recording the evidence of each V/F. `score.ts analyze` unblinds and applies the rules below.

## Decision rules (`protocol.ts` `summarizeCase`, `stopAfterTwo`, `verdict`)

- **Units:** 3 cases × 3 arms × 2 repeats = 18, in one batch (`protocol.ts` `units`: case-major, repeat-major, seeded arm order per block). No expansion beyond these 18.
- **Per case:** an arm found a known defect when at least one of its two repeats found it; "found by both repeats" is reported as reproducibility. **B-unique** = found by B and by neither A repeat; **A-unique** the reverse; **B-vs-C-unique** = found by B and by neither C repeat.
- **Saturated case:** both A repeats found every known defect. Such a case cannot show a known-defect gain and is reported as such.
- **Stopping rule** (an evidence gate after both repeats of every arm of c1 and c2 are scored, before c3 is scored): B-unique empty in c1 and c2, and not both of them saturated → "not supported (stopped by rule)"; c3 is then reported descriptively only.
- **Verdict:** *regression* when ΣA-unique > ΣB-unique, or B's mean F per run exceeds A's by more than 1; *supported* when B-unique is non-empty in at least 2 cases and ΣB-unique > ΣA-unique (with the F condition holding), "cb-specific" when B-vs-C-unique is also non-empty in at least 2 cases, otherwise "not isolated from compute"; *not supported* otherwise.
- Three cases and two repeats allow no statistical inference: a supported verdict would mean "on these cases", not general efficacy.

## Result (2026-10-23/24)

Source: `results/cb-ab/REPORT.md`; the unblinded analysis is `results/cb-ab/study/scoring/analysis.json`.

**Verdict: not supported (stopped by the rule).** In c1 and c2 B found no known defect that A missed (B-unique 0 in both). c1 was saturated; c2 was not saturated only because one A run produced no report, so the evidence gate fixes the verdict. Descriptively over all three cases the result is the same: B-unique, A-unique and B-vs-C-unique are 0 in every case. No regression by the predeclared F rule.

| Case | Known defects | A found | B found | C found | Saturated | Mean K points A/B/C (of 6) | Mean V A/B/C | Mean F A/B/C |
|---|---|---|---|---|---|---|---|---|
| c1 canvasapi-716 | K1, K2 | both, 2/2 runs | both, 2/2 | both, 2/2 | yes | 6 / 6 / 6 | 3 / 2.5 / 4 | 0 / 0 / 0 |
| c2 markdown-1587 | K1, K2 | both, 1/2 runs (r1: no report, provider stop) | both, 2/2 | both, 2/2 | no (only through r1) | 3 / 6 / 6 | 1 / 1.5 / 2 | 0.5 / 1 / 2.5 |
| c3 openharness-217 | K1, K2 | both, 2/2 | both, 2/2 | both, 2/2 | yes | 6 / 6 / 6 | 0 / 0 / 0 | 1 / 2.5 / 1 |

- Every completed report of every arm found every known defect with full M/L/S points.
- The only miss is c2/A/r1: the provider stopped its orchestrator after 7 requests with a "flagged for possible cybersecurity risk" policy error (`results/cb-ab/study/runs/c2/A/r1`). Under the protocol it is not retried and scores 0. Excluding it changes nothing in the comparison (A r2 found both).
- Pooled F per run: A 0.50, B 1.17, C 1.17. The extra F of B and C are mostly out-of-scope or refuted variant claims (`results/cb-ab/study/scoring/c*/scores.md`).
- **Route fidelity:** 0 violations in 18 runs; every request `gpt-6.1-sol` at effort `high`, response model `gpt-6.1-sol` (`results/cb-ab/study/runs/*/*/r*/route.json`).
- **Compliance:** every B and C run spawned its explorer once with the brief verbatim. In c1 the orchestrators changed the appended prompt copy by one character or more (`promptVerbatim: false`, brief verbatim); the explorer still received the full task.
- **Audit:** the hits are a run reading its own sub-worker transcript in its private agent dir (c2/B/r2) and probe strings containing URLs (c3); no access to evaluator material. The target was unchanged in every run.

## Cost (list price, every request metered at the run's proxy)

| Arm | Runs | USD total | USD per run | Requests | Mean wall | Explorer USD |
|---|---|---|---|---|---|---|
| A | 6 | 2.91 | 0.49 | 181 | 548 s | – |
| B | 6 | 4.65 | 0.78 | 267 | 921 s | 1.41 |
| C | 6 | 5.01 | 0.84 | 300 | 1010 s | 1.43 |

Measured runs $12.57 (748 requests; 27.9M input tokens of which 25.7M cached, 0.56M output); the toy preflight (all attempts, `results/cb-ab/preflight/README.md`) $1.27 (108 requests). The task manager's analysis outside the pipeline is reported separately (claude-opus-5-5 sub-workers: case screening and harness $29.81, rubrics c1/c3 $10.67, blind scoring $20.39).

## Limitations

- On these three real cases the Sol/high strong baseline is at ceiling for the known defects, so the test has almost no sensitivity for a known-defect gain. The result is "no gain observed, baseline saturated", not proof that the mechanism never helps.
- The contract-backward explorer cost +60% per run (B) and added more out-of-scope or refuted claims. The generic explorer (C) cost the same and behaved alike, so nothing here distinguishes the contract-backward method from one more worker.
- Selection: A1 dropped E3 because only one of the 15 pool tasks met it. c1 and c3 then have both known defects inside the function the issue names, the likely cause of the saturation. No expansion was run (predeclared).
- Full MDSD (adaptive rounds, integration machinery) was not tested, and nothing here supports a default rollout of MDSD behaviour.

## Reproduce

`unit` and `driver` always run the study's frozen harness copy (`<study>/harness/experiments/cb-ab/run.ts`), so a later edit of the live files never reaches a run. Measured units refuse to start until `<study>/manifest.json` exists (hashes of `PROTOCOL.md`, `protocol.ts`, the cases, the rubrics, the harness and the runtime), which the task manager writes before the first measured unit.

```sh
S=results/cb-ab/study        # a fresh study directory (prepare refuses a prepared one)
C=results/cb-ab/cases        # case.json, rubric.json/.md and probes per case; selection.md
node --import tsx experiments/cb-ab/run.ts selfcheck                  # which copy runs, its harness intact
node --import tsx experiments/cb-ab/run.ts prepare $S                 # freeze runtime (git archive HEAD), provider, harness, catalog
# preflight in its own study directory P on the toy case T (no manifest needed)
node --import tsx experiments/cb-ab/run.ts toy-case T                 # written once
node --import tsx experiments/cb-ab/run.ts unit P T A 1 --preflight   # and B 1
# measured units, after $S/manifest.json: c2 first (A2), one process per unit, each arm A|B|C and repeat 1|2
node --import tsx experiments/cb-ab/run.ts unit $S $C/c2-python-markdown__markdown-1587 A 1
node --import tsx experiments/cb-ab/run.ts driver $S --cases $C/c1-ucfopen__canvasapi-716,$C/c3-hkuds__openharness-217 --concurrency 12
node --import tsx experiments/cb-ab/run.ts status $S
node --import tsx experiments/cb-ab/run.ts summarize $S               # summary.json, summary.md
node --import tsx experiments/cb-ab/score.ts packets $S $C            # blinded packets per case and the sealed scoring/key.json
# fresh scorers write $S/scoring/<case>/scores.json from the packets and the rubric, then:
node --import tsx experiments/cb-ab/score.ts analyze $S $C            # unblinds and applies the rules: scoring/analysis.json
```

Records (`results/cb-ab/`, gitignored): `PROTOCOL.md`, `REPORT.md`, `cases/` (selection and screening logs, case files, rubrics, probes), `preflight/` and `study/` (the manifest, per-unit evidence in `runs/<case>/<arm>/r<n>`: prompt, config, wire log and totals, records, sessions, final report, audits; `scoring/`; `summary.md`). Model-free tests of the harness and the rules: `test/experiments/cb-ab.test.ts`, `test/experiments/cb-ab-score.test.ts`.

## Round 2, Part R: Sol/high re-adjudication (2026-10-24)

Part R follows `results/cb-ab/PROTOCOL-R2.md` with Amendment R2-A1. Round 1 was scored by claude-opus-5-5 task-manager sub-workers,
which the user's model rule does not allow for scoring. Those scores stay unchanged and are labelled in
`results/cb-ab/study/scoring/LABEL.md`. Part R re-scores the 17 frozen reports with two fresh, blind Sol/high scorer sessions per case:
S1 (primary) and S2 (sensitivity). c2/A/r1 is missing (a provider stop) and is never scored.

**Harness** (`experiments/cb-ab/`):

- `sol-session.ts` runs one plain Pi session: provider only, `cliproxyapi/gpt-6.1-sol` at `high`.
  - It runs in bubblewrap with private PID and network namespaces. The only network path is a Unix socket to the session's own
    logging proxy.
  - Every request is route-checked. An infrastructure retry happens at most once.
- `sol-score.ts` is the blind scorer.
  - Packets come in a seeded order per scorer.
  - It mounts the rubric, and the probes without reference-fix or hidden-test material.
  - It never mounts the key, scores, transcripts, fixtures or the repository.
  - An incomplete packet triggers one re-run; still incomplete means unscored, never zero.
- `analysis-r2.ts` gives every run an explicit status: completed, missing or non-compliant.
  - It builds the analysis set and computes saturation only with both A repeats.
  - Reproducibility is defined only with two repeats.
  - The protocol.ts gate and verdict run on that set.
- The round-2 screening and selection tools are `screen.ts` and `verify.ts`.
- `run.ts driver --arms A` and `score.ts packets --arms A` run arm A alone for calibration. The defaults are unchanged.

**Results** (`results/cb-ab/study/scoring-sol/README.md`):

- **Route.** 6 sessions made 143 requests. Every one was `gpt-6.1-sol` at `high`, answered by `gpt-6.1-sol` and attributed to its
  session. Cost: $1.97 at list price. Every packet was scored in the first session.
- **Verdict.** Not supported, for S1 and for S2. The gate does not stop because c2 has B-unique K1:
  - both scorers gave c2/A/r2 M = 0 for K1, and c2/A/r1 is missing;
  - B-unique appears in one case only.
- **Saturation.** c1 and c3 are saturated. c2's saturation is unknown.
- **S1 vs S2.** FOUND agrees in 34 of 34 comparisons. V/F/U counts agree in 8 of 17 packets. The result is not scorer-sensitive.
- **Against round 1** (descriptive). FOUND agrees in 33 of 34 comparisons; the difference is c2/A/r2 K1.
- **Interpretation** (fixed in PROTOCOL-R2). Round 1 stays saturation-limited and is not a discriminating test.
- **Screener preflight** (`results/cb-ab/preflight-sol/`). On markdown-1587 the screener produced two candidates. The deterministic
  verifier verified both, and they match round-1 K1 and K2 by hunk set.
- **Tests.** `test/experiments/cb-ab-sol.test.ts` and `test/experiments/cb-ab-r2.test.ts`.

## Round 2: headroom-screened cases and validation (2026-10-24)

Source: `results/cb-ab/REPORT-R2.md`; protocol `results/cb-ab/PROTOCOL-R2.md` (R2-A1 to R2-A3). Every screener, calibration and
validation arm role, and every scorer, ran `cliproxyapi/gpt-6.1-sol` at `high`, with 0 route violations over 3,146 metered requests.

**Cases with measured headroom.**

- Pool P2 (`results/swe-pool/r2/`) holds fresh SWE-rebench 2026 records.
- Screening: one Sol/high screener per record, and deterministic probe verification of every candidate defect.
  - T1: 16 records, 4 eligible (at least two verified defects).
  - T2 (expansion): 17 records, 4 eligible.
- Calibration: arm A × 2 per eligible case, scored by S1. A case qualified when a calibration report missed a verified defect.
  - T1: only tox-3846 qualified.
  - T2: schemathesis-3933, docsight-437 and moto-9727 qualified.
  - The other four eligible cases were saturated.
- Selected in pool order: c1 tox-3846, c2 schemathesis-3933, c3 docsight-437.

**Validation** (18 units, the same arms, texts, runtime and limits as round 1; S1 primary, S2 sensitivity). Verdict **not supported**,
under both scorers, and not scorer-sensitive:

- No case saturated. The gate did not stop, because c2 has B-unique K2.
- B-unique vs A: c2 K2, but the generic explorer C found it too.
- A-unique vs B: c3 K4. B-unique vs C: c3 K6, which A also found.
- No arm found c1 K2 or c3 K5.
- Mean false or out-of-scope claims per report (S1): A 7.5, B 4.5, C 6.0.
- FOUND agreement S1 vs S2: 60 of 60.

Sol list price for stage 1 round 2: $54.50, of which $23.95 is the validation units and $6.91 all Sol scorer sessions (Part R, calibration, validation). In short: on three cases
with measured headroom, the contract-backward explorer did not find known defects that ordinary strong and a generic explorer
missed.
