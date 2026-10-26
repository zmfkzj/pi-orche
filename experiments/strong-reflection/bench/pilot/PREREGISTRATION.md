# Decision-audit rescue pilot: pre-registration (2026-10-23)

Written before any live model call of this pilot. Code: `pilot/protocol.ts` (texts, units, clusters, order, budget, read-out),
`pilot/fidelity.ts`, `pilot/budget.ts`, `pilot/driver.ts`, the pilot branch of `run-arm.ts`, the gates of `wire.ts`. Results:
`results/strong-reflection/pilot-2026-10-23/` (gitignored). The driver freezes this protocol into `frozen/manifest.json` (texts,
SHA-256 of the texts and of these files, schedule, budget, clusters, environment) at its first launch and refuses to run against a
changed protocol; harness-only fixes are recorded there as amendments.

## Status of the question
The hard-task bench of 2026-10-19 (`results/strong-reflection/bench-2026-10-19`, the source bench) left 12 of 16 units wrong before
the review, and none was corrected by O's own review, R0 or R1. The later analysis found that these failures were decided by the
worker's own interpretation and not checked against an independent authority (tox: own tests assert the inverse of the maintainers'
implicit-ISA expectation in 4/4; docstub: no boundary probe; isort: a contested comment format), and proposed a structured decision
audit at the same boundary. This pilot asks only: **does that audit, given at the recorded reflection point, repair consequential
errors that ordinary review and the four-line prompt left untouched, without breaking already-correct work?**

It is a rescue-among-known-failures mechanism pilot, not an efficacy benchmark and not a test of the four-line prompt. The audit
was designed after inspecting these very failures (and their hidden tests), so it is not blind to them; the texts are generic and
carry no task, domain or hidden-test content, but a rescue here shows mechanism plausibility at most, never a rate. The longer-term
goal (an independent efficacy test on fresh tasks where unmodified strong mode is below 60%) is not started here.

## Model, settings, history (preserved)
- Live continuation on `cliproxyapi/gpt-6-astra`, thinking **high** — the source bench's identity (`bench/protocol.ts` MODEL_REF,
  THINKING), not the user's current strong route. On the wire every request must be `gpt-6-astra` with `reasoning.effort: high`;
  the proxy refuses anything else before forwarding (fail closed).
- Everything else as the source bench: its frozen runtime `rt/` (read only; digest `3a6e926943cef850…`), `orcheConfig` of R1 (A, B)
  or R0 (C0), the fixed hand-off, advisor on (replayed before the checkpoint), `bashReview` off, the grader.
- History: O's recorded responses (worker and advisor) replayed with their recorded latency up to the recorded reflection point
  (integration node `verify` in all 16 units), at the unit's recorded live path (`O/meta.json` `live`, under the source bench's
  scratch root `/tmp/pi-orche/01a152d6-…/W1/srb`: replayed tool calls carry these absolute paths). The live workspace is rebuilt per
  arm as in the source bench, including its throwaway `Starting state` git commit inside the temporary workspace (none in the project).
- Historical O/R0/R1 are comparators, not randomized controls. Provider-side model changes behind the same id since 2026-10-19 are
  undetectable; C0 is the only contemporaneous control.

## Arms (texts frozen; exact text in `frozen/prompt-A.txt`, `frozen/prompt-B.txt`)
Delivered exactly where R1's prompt was: appended to the accepted task_plan result that starts the integration node, by the original
class's delivery rule (once; a held first report as fallback; a report of the same response held), only the text differs.
- **A**: header `Before your self-review (strong mode; integration node <node>):`, the six-step decision audit (`AUDIT`), trailer.
- **B**: the same header, the user's four lines verbatim (`FOUR_LINES`, identical to `src/single/reflection.ts`), a blank line, the
  identical audit, the same trailer. A and B differ only by the four lines.
- **C0** (tox units only): no text, R0's configuration; a contemporaneous no-extra-prompt continuation.

The audit (scoped as recommended by the corrected analysis): list the consequential readings and behaviour changes with the expected
values the worker's own tests assert; run an input that distinguishes the readings on the original code and on the change; check
expected values against evidence independent of self-written tests (request wording/examples, original behaviour and existing tests,
docs/changelog/comments, language/stdlib/spec); classify each difference as requested, necessary (incl. the same fix for the same
pattern) or collateral, keep requested/necessary, keep collateral only with independent support; on conflicting or silent evidence
take the best-supported reading (if balanced, the smaller change of existing behaviour) and state the alternative as an open
uncertainty; change work only for a real reason. No "no literal sentence → never change" rule.

## Units, clusters, schedule
Clusters (pre-declared; analysis labels, never model-visible): reachable **C1** tox r1–r4 (implicit host-ISA factor removed; r2 also
TOML scope), **C2** docstub-r1 (extra `Callable` arity accepted), **C5** isort-r4 (comment scope); policy/disputed **C3** docstub r2–r4
(`Callback[...]`), **C4** isort r1–r3 (short-line comment format); **D** d1 r1–r4 (passing pre-review state: no-harm controls).

Jobs in priority order (a job = one unit, its arms one after another in a seeded order, `pilotOrder`), at most 8 jobs at a time:
tier 1 — tox-r1 (C0>A>B), d1-r1 (A>B), docstub-r1 (B>A), isort-r4 (A>B), tox-r2 (A>B>C0), d1-r2 (A>B), tox-r3 (C0>B>A),
d1-r3 (A>B), tox-r4 (C0>B>A), d1-r4 (A>B); tier 2 — isort-r1 (B>A), docstub-r2 (A>B), isort-r2 (A>B), docstub-r3 (A>B),
isort-r3 (B>A), docstub-r4 (B>A). 16 units × A/B + 4 × C0 = 36 continuations planned.

## Fidelity (gated before any live request of an arm)
- Strict prefix: before the reflection point the proxy serves only recorded responses; a request that would create new history
  (top-worker divergence, unmapped helper session, request without a recording, non-JSON POST) is refused, never forwarded.
- At the reflection point, before the switch request is forwarded, it is compared with O's recorded request at that point: every
  parameter except `prompt_cache_key`, the instructions, the tools and every non-tool-output item (hand-off, helper notes, replayed
  model messages, reasoning items, tool calls) must be identical after the run-id normalization; the delivering task_plan output must
  be O's output followed by exactly the arm's text (C0: nothing); no other item may carry an intervention; the work-state hash must
  equal O's. Otherwise the arm is refused (zero cost) and reported invalid. Re-executed tool outputs may differ; they are counted
  (raw, after the tool-noise rule, ignoring line order), kept in `fidelity.json`, and reported.
- Zero-cost dry replays first (offline proxy, stop at the reflection point): d1-r1 A, docstub-r1 B, isort-r4 A, tox-r1 C0, tox-r2 B.

## Budget (token-priced estimates; the provider reports tokens, not charges)
- Cap **USD 50** for all live spend of this pilot, at the source bench's gpt-6-astra list price (input 10, cache read 1, output 50
  per million tokens). A shared ledger (`budget/ledger.jsonl`) reserves every request before it is forwarded (a session's first
  request at the uncached price, later ones assuming ≥ 80% cache reads, plus 8,000 output tokens) and settles it at its usage price
  (an upstream error status without usage at 0; an interrupted stream at its reservation). A request is refused when committed spend
  plus its reservation would pass USD 49; an arm whose own committed spend would pass USD 6 is censored.
- Job admission: committed spend + the remaining reservations of running jobs + the new job's reservation (2 × the larger historical
  R0/R1 cost of the unit per A/B arm, 1.3 × for C0) ≤ USD 45. Strict order: no job starts before an earlier one; when the next job
  cannot fit while nothing runs, the run stops and the remaining jobs are reported as not run. Tier 1 is the pre-declared fallback
  subset; incomplete coverage is reported as such and cannot satisfy go or stop.
- Infra rule: an arm that ends without a result and without any successful upstream response is retried once. No second round,
  no expansion, no re-run of a valid arm.

## Grading and diagnostics
- Objective verdict: `experiments/ultra-ab/env.ts gradeWorkspace` (unchanged; no model): pass = terminal `done` AND grade passed AND
  no integrity violation (`primaryPass`). Pre-review state = the source bench's grade of O's checkpoint patch.
- Offline diagnostics after the runs (never model-visible): failing hidden tests re-run on the saved checkpoint and final patches
  with tracebacks (`pilot/diagnose.ts`), per-check and per-test transitions, checkpoint→final diff of each arm.

## Read-out (pre-declared; per arm; descriptive; no significance test, no pooling over shared histories)
- **Grade flip**: pre-review fail → final pass. **Rescue**: a grade flip in a reachable cluster whose decisive change is supported by
  the arm's audit trace — manual adjudication (`adjudication.json`, each with file:line evidence) that the transcript after the text
  surfaces the failure-deciding decision AND either changes its expected value/implementation on the audit's grounds (a
  distinguishing input or the requested/collateral classification) or cites an independent authority for the change. A flip without
  such a trace is an *unexplained pass*; a flip in C3/C4 is a *policy pass*; neither counts as a rescue.
- **Adherence** (manual): full = decisions listed, a distinguishing input run on the original and the change, independent evidence
  checked, differences classified; partial = some of these visibly done; none = no visible audit.
- **Harm**: a d1 unit (pre-review pass) whose final state fails, in A or B. Also reported for every unit: newly failing checks/tests.
- **Go** for arm X: tier-1 coverage complete (all 6 reachable units and 4 d1 units valid in X, 4 C0 valid) AND rescues in ≥ 2
  distinct reachable clusters AND ≥ 2 distinct C1 units rescued (repeats of the same decision; A and B on one unit never add up)
  AND C1 rescues exceed C0 tox passes AND no harm in A or B.
- **Stop** for arm X: coverage complete AND 0 grade flips in reachable clusters AND the audit carried out (full/partial) in ≥ 4 of
  the 6 reachable units.
- Pilot verdict: **go** if A or B meets go; **stop** if both meet stop; otherwise **inconclusive** (e.g. one rescue, rescues without a
  trace, rescues only in C3/C4, harm, incomplete coverage). A vs B is descriptive only (one continuation per unit and arm, ~5
  decision clusters): no claim that the four lines contribute or not.
- Go means mechanism plausibility worth a stage-2 design (fresh tasks with adjudicated contracts, an unmodified <60% baseline,
  ≥ 3 matched continuations per unit and arm); it is not launched by this pilot.

## Amendments before any live call (harness only; texts, schedule, budget and read-out unchanged)
1. 2026-10-23, after the first dry attempt (0 requests forwarded; every arm stopped at start-up because the provider's model-list
   GET was refused offline): a dry arm answers that GET (no model call) from one snapshot taken by the driver; offline refusals no
   longer halt the proxy; a halt before the reflection point ends the arm as invalid at once.
2. 2026-10-23, same time: the source live root `/tmp/pi-orche/01a152d6-…/W1/srb` lies outside this pilot's write scope (the
   assignment's scratch directory is `…/W4`), so arms run at the recorded live path moved to `…/W4/srb` (same length). The proxy
   rewrites the root in every replayed response (whole events; streamed argument/text fragments per stream with their original
   boundaries), recorded helper sessions are matched with it applied, state hashes are taken with the root mapped back, and the
   fidelity gate applies the same mapping to O's request. Not rewritable: the encrypted reasoning items replayed from O, which may
   refer to the old root internally. This is a deviation from the source bench's exact history, identical for A, B and C0.
   The first dry attempt had created `…/W1/srb/{d1-transactional-r1,docstub-123-r1,isort-2491-r4,tox-3904-r1,tox-3904-r2}`
   (workspaces, empty records, one stale lock); they were left in place (outside the write scope) and are reported.
