# ultra stability and the analyst hand-off under one pinned route (experiments/ultra-ho, stages 2–3, 2026-10-24)

Harness: [`experiments/ultra-ho/README.md`](../experiments/ultra-ho/README.md).

- Every role is `cliproxyapi/gpt-6.1-sol` at effort `high`, never xhigh or max: main, the ultra orchestrator, analysts, basis
  builders, candidates and verifiers.
- This is checked per request on the wire: model, effort, response model, and the session attributed by prompt_cache_key.
- The settings differ from the historical ultra A/B study ([ultra-ab-bench.md](ultra-ab-bench.md): main high, orchestrator
  xhigh). Its numbers are not comparable with these.
- Records are in `results/ultra-ho/` (gitignored):
  - `live/` (stage 2)
  - `stage3/` (stage 3: `PREREGISTRATION.md`, `REPORT.md`, `chain.md`, runs)
  - `stage3-r2/` (stage 3 round 2: `PREREGISTRATION.md`, `REPORT.md`, `calibration/`, `validation/`)

## Stage 2: execution stability

Each failure below was recorded in the B arm of `results/ultra-ab/main`, reproduced against the current code by a deterministic
test, and then fixed minimally. The tests are `test/extension/ultra-continuity.test.ts` (WorkerPool path, faux models, real git;
it failed before the fix) and `test/orchestrator/ultra-lifecycle.test.ts` (recorded runs replayed through `createSpawnTool`,
`UltraRun` and the report gate). The behaviour is described in [orchestrator.md](orchestrator.md) 14.2, 14.4 and 14.5, and
in the CHANGELOG.

| failure (historical evidence) | cause found | fix |
|---|---|---|
| A continuation started over and the gate rejected the remembered candidates as unknown (sqlfluff-7615 B r1/r2) | With `single.ledger` off, the Resume line named no task. Evidence refs also restart with every assignment, while carried candidates kept their old spawn ref | Every ultra implement/answer assignment keeps a task ledger; identity is worker + task; carried candidates count as spawned at ref 0 |
| A round whose verifier disconnected counted, so the review a late adoption needed was refused (marshmallow-2925 B r1) | Rounds counted at the call, not at a finished verdict | A round counts once a verifier finished with a verdict. A call refused before any verifier ran counts nothing. A round where every verifier failed counts separately, against the same cap |
| A fix candidate (`from`) was refused as a stale base after its ancestor's adoption (6 of 12 B units with a fix round) | The workspace change since the base was the ancestor's own adoption | The base is accepted only when the workspace holds exactly the fix's recorded start state; every other change stays a conflict |
| Report schema friction: `review[].source` over 40 characters rejected (9 B units); stage `verification` refused | Label limit and stage names | Labels up to 300 characters (never evidence); `verification` is accepted as `review`; an incomplete report records no stage the run did not reach |

The following were kept unchanged: open-review blocking (`reproduced-open` keeps a task blocked; the d8 open reviews were
legitimate), fresh checks bound to content fingerprints, post-adoption review, protected-basis integrity, approval boundaries and
the stale-base refusal for every other workspace change.

### Live validation (`results/ultra-ho/live/VALIDATION.md`)

The runtime was `rt-fixed` (digest `fd01d201…`) on task `a1-rounding`, chosen by `pick-task`, with two concurrent units:

| unit | terminal | grade (visible, hidden) | integrity | primary | requests | USD |
|---|---|---|---|---|---|---|
| normal (default limits) | done | pass, pass | clean | pass | 130 | 1.36 |
| interrupted (12-minute assignments, no extension) | done | pass, pass | clean | pass | 118 | 1.22 |

The interrupted unit ran as follows:

1. The first assignment timed out after its adoption and review.
2. main continued it with `worker "W1"` and `task "T1"`, as the Resume line said.
3. The continuation carried the candidates, the adoption and the protected basis.
4. The gate refused the first report, which lacked fresh checks of the carried candidates and a review in this assignment.
5. The next report passed.

No stage that did not run was recorded. Route: 248/248 requests were Sol/high.

## Stage 3: analyst locations must reach the candidates

### Question and arms

The prevention is the [orchestrator.md](orchestrator.md) 14.2 rule "분석가 위치 hand-off":

- Every existing workspace file that a finished exploration analyst names in its full report must be handled before any candidate
  copy is made. Each file must be in a candidate's request or `files`, or in `excluded: [{path, reason, evidence}]` citing a later
  own check, or outside main's write scope.
- Otherwise the candidates call is refused.
- The rule is always on in ultra. It does not apply to strong, single or MDSD.

The motivation was tox-3904 B r1 of the historical study: an analyst reported the TOML sibling
`src/tox/config/loader/toml/_replace.py`, the candidates were scoped to INI only, and the hidden TOML test failed.

- **F**: the stability-fixed runtime `rt-fixed`, frozen before any hand-off code existed.
- **H**: `rt-handoff` (digest `02aa85f4…`). Its diff against F (`stage3/runtime-diff.patch`) changes only the three files of
  the hand-off, and every hunk belongs to it.
- Otherwise identical:
  - `/orche ultra <prompt>` with the ultra-ab user prompt
  - advisor and Bash review off
  - limits 60 min + 2 × 15 min, 300 requests (soft), process guard 150 min
  - workspaces without any commit
  - all 14 units concurrent in a seeded order

The preregistration (`stage3/PREREGISTRATION.md`, sha256 in `stage3-manifest.json`) was written before the hand-off code and
before any stage-3 run. It covers:

| task | role | units per arm |
|---|---|---|
| tox-dev__tox-3904 | mechanism (exposed, not fresh evidence) | 2 |
| pytest-dev__pyfakefs-1286 | fresh, scope-related | 2 |
| line__line-bot-sdk-python-981_interface | fresh, scope-related | 1 |
| stravalib__stravalib-709_interface | passing control | 1 |
| tobymao__sqlglot-7187 | passing control | 1 |

Rules:

- **Mechanism shown** if an H tox unit reports, hands off, changes and passes the TOML site.
- **Efficacy** only if H has ≥ 2 more primary passes than F on the fresh units, no fewer on the controls, and no more terminal loss.
- **Regression flag**: a control that passes in F and fails in H, or an H unit ended by the rule's refusal.

### Result (`results/ultra-ho/stage3/REPORT.md`, `chain.md`)

| arm | terminal done | F2P pass | P2P regressions | integrity violations | primary | decisive locations dropped | requests | USD |
|---|---|---|---|---|---|---|---|---|
| F | 7/7 | 6/7 | 0 | 1 | 6/7 | 2 of 23 (tox r1) | 1158 | 16.94 |
| H | 7/7 | 7/7 | 0 | 1 | 6/7 | 0 of 25 | 1307 | 20.23 |

- **Mechanism on tox: shown, attribution limited.**
  - F r1 reproduced the historical loss on the fixed runtime: the TOML site was reported, then dropped as "not justification to
    expand this INI issue", the diff was INI only, and the TOML F2P test failed.
  - Both H units gave TOML to a candidate, changed it and passed.
  - The limit: TOML was in the H orchestrators' first proposals. H's three refusals named other files. F r2 also handled TOML
    without the rule.
- **Efficacy: not demonstrated.** On the fresh units F and H both scored 3/3: the baseline is at ceiling.
- **Regression flag: none.** Controls 2/2 in both arms. No H unit ended through a refusal: each refusal was resolved by the next
  call 19–26 s later.
- **Integrity.** One violation per arm, both the same edit: an import line in the existing `tests/config/loader/ini/test_factor.py`,
  made by an adopted candidate. It is unrelated to the hand-off.
- **How H met the rule.** H requests name a median of 20.5 workspace paths per candidate, against 0.5 in F.
  - 111 of 123 non-decisive and 6 of 25 decisive H locations were covered by a request mention only.
  - `excluded` was never used.
  - A mention delivers the information but gives an implement candidate no write ownership.
  - None of the 6 mention-only decisive files was changed, and the hidden tests still passed.
  - H diffs covered every reference source file in 2/7 units, against 4/7 in F (descriptive; n = 7).
- **Cost.**
  - H used +12.9% requests and +19.4% USD; one 3-assignment unit cost $5.98.
  - n = 7, so the difference is not attributable.
  - Route: 2465/2465 requests were Sol/high, 0 violations, 0 unattributed.

### Limitations and recommendation

- 7 units per arm. tox is an exposed task (mechanism validation only), and the fresh units and controls were at ceiling, so a
  pass-rate effect cannot be shown here.
- The rule checks path strings. Whether a candidate really handles a location it was given, and whether an exclusion's reason
  holds, are left to the model.
- Keep the rule as a narrowly scoped ultra safeguard (cheap, no terminal loss, no control regression, documented), but claim no
  efficacy.
- A stricter variant would need its own preregistered comparison on tasks where the baseline fails: an implement candidate must own
  a reported source file, or the file must be excluded with grounds.

### Round 2 rule

Round 2 (`stage3-r2/PREREGISTRATION.md`: intervention H2, amendment H2-A1; runtime `stage3-r2/rt-handoff2`) tests that stricter
variant against F. Each reported file is a finding of its exploration round, and a later round that reports it again makes a new
finding. A finding is handed off (assigned) only when one implement candidate owns it through its `files` and names it in its
request; a mention alone or ownership alone is refused. Otherwise it needs `reference` (read-only context, named in a request) or
`excluded`, each with a reason and an own later check whose arguments or output name the file, or it lies outside main's write
scope. The rule is always on in ultra ([orchestrator.md](orchestrator.md) 14.2). `chain.ts` classifies every finding in both arms
as assigned, reference, excluded, out of scope, mention-only, owned-only or dropped. A transfer counts as gate-caused only when a
refusal named the finding, the next accepted call assigned it, and no earlier proposal had. `chain.ts` never writes into
`results/ultra-ho/stage3/` (round-1 outputs stay as they are; `--dest` writes a re-analysis elsewhere).

### Round 2 result (`results/ultra-ho/stage3-r2/REPORT.md`)

**Calibration.** One F unit ran per fresh multi-file task, 9 tasks.

- Four passed their hidden tests.
- A task qualified when F failed F2P and left a decisive source file untouched. Three tasks qualified first in pool order:
  narwhals-3478, huggingface_hub-4056 and smolvm-172. A fourth, kubeflow-13112, was not used.

**Validation.** 16 of 16 preregistered units ran, all outcomes:

- F × 2 and H2 × 2 per headroom task;
- H2 × 2 on the exposed tox-3904;
- H2 × 1 per control.

Every outcome request was `gpt-6.1-sol`/`high` on the wire.

- **Efficacy: not demonstrated.** Primary passes were H2 1 of 6 against F 0 of 6. The rule needs at least 2 more.
  - Terminal loss was 0 and 0, and integrity violations 3 and 3.
  - The one pass (narwhals H2/r2) was not caused by the gate.
- **Mechanism (tox): not shown by the frozen readout.**
  - H2/r1 assigned and changed the TOML site and passed both F2P tests, but broke 2 existing pass-to-pass tests. That meets the
    preregistration's literal primary but not the grade.
  - H2/r2 never reported the site.
  - Gate attribution is 0.
- **Regression flag: not raised.** Both controls passed, and no unit ended because of a refusal.
- **Chain.** H2 gave every decisive finding an accountable disposition: 34 assigned, 3 reference, 3 excluded, 0 dropped of 40.
  - F left 15 of 22 owned but named in no request, and dropped 3.
  - All 136 H2 reference/excluded dispositions cite a real read of the file.
  - Accountability did not raise correctness. smolvm H2 changed every decisive file and still failed. On hf_hub, H2 excluded a file
    the reference fix needed, with grounds, and failed like F.
- **Run conditions.**
  - Two gateway outages occurred: an upstream overload followed by about a minute of 503 `auth_unavailable`.
    - Capacity stops were rerun under amendment H2-A2, symmetrically for both arms.
    - Two units that started during an outage were sent to the gateway's other id `bts/gpt-6.1-sol`. They were voided and rerun
      (H2-A3).
    - The unit proxy now refuses off-route model requests (`proxy.mjs` envelope `route`).
  - Stage 3 round 2 cost $71.10 at Sol list price, including stops and void units.
- **Recommendation.** Keep the rule as a cheap accountability safeguard that causes no regression. Claim no efficacy.

## Reproduce

```sh
npx tsx experiments/ultra-ho/cli.ts freeze results/ultra-ho/stage3 handoff     # rt-<name>, never overwritten
npx tsx experiments/ultra-ho/cli.ts driver experiments/ultra-ho/plans/stage3a.json --detach
npx tsx experiments/ultra-ho/cli.ts driver experiments/ultra-ho/plans/stage3b.json --detach
npx tsx experiments/ultra-ho/cli.ts status results/ultra-ho/stage3
node --import tsx experiments/ultra-ho/chain.ts results/ultra-ho/stage3       # chain.md, chain.json
# round 2 (results/ultra-ho/stage3-r2/REPORT.md "Reproduce"): r2.ts attempts | select | decide | grounding | costs
npx vitest run test/experiments/ultra-ho.test.ts test/experiments/ultra-ho-chain.test.ts test/experiments/ultra-ho-r2.test.ts test/orchestrator/ultra-handoff.test.ts
```
