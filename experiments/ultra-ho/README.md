# ultra-ho: a reproducible ultra/strong harness pinned to one model route

Based on the proven ultra-ab harness (`experiments/ultra-ab`, `docs/ultra-ab-bench.md`), which stays frozen as historical evidence.
Reused by import where identical and correct: `loadTask`, `gradeWorkspace`, `pythonWrappers`, `piEnv`, `protectedFiles`
(ultra-ab `env.ts`), `userPrompt`, `integrity`, `terminalOf`, `primaryPass`, `rng`/`shuffle`, `leakHits` (ultra-ab `protocol.ts`),
`taskRecords`, `finalText`, `redactTree`, `readJsonl` (ultra-ab `run-one.ts`). Not reused: ultra-ab's `THINKING` (xhigh) and
`orcheConfig` (older settings). `proxy.mjs` is a byte-identical copy of `experiments/mdsd-ab/proxy.mjs` (sha256 `97999688…20b0c7bf`
at the copy), run without a cap.

## The one route

Every role runs `cliproxyapi/gpt-6.1-sol` at effort **high**, never xhigh or max (`protocol.ts`):

- Pi: `--model cliproxyapi/gpt-6.1-sol --thinking high`; private `settings.json` with `defaultThinkingLevel: "high"`, SSE transport.
- Private `orche.config.json` (`orcheConfig`): `models.{main, orchestrator, worker, strong-orchestrator, strong-worker, advisor, strong-advisor}` and
  the `default` route all `{model: "cliproxyapi/gpt-6.1-sol", thinking: "high"}`; `single: {ledger: false, spawn: true, advisor: false}`
  (product default `maxSubWorkers`); `thinkingPolicy: {mode: "fixed", lengthRecovery: "redecompose"}`; `concurrentSessions` off;
  `bashReview: {enabled: false}`; `limits` from the plan (default: 60 min base per assignment + at most 2 × 15 min extensions while
  active, 300 requests; Pi process-group guard 150 min).
- Plans cannot name a model or an effort (unknown keys are refused).
- Verified per run on the wire (`classifyWire`): every POST model request names `gpt-6.1-sol`, request effort `high`, every
  `configuration_update` effort `high`, and the response (stream head and final event) names `gpt-6.1-sol` (a 200 without one is
  "unverifiable", also a violation). Requests are attributed by `prompt_cache_key` (the Pi session id) to main (the run's
  `--session-id`), the orchestrator `W<n>` and its sub-workers `W<n>.<m>` (their transcripts in the records); unknown keys are
  listed as unattributed. Usage and list-price USD (catalog prices, priced by the proxy) per role and per session.

## Commands

```sh
npx tsx experiments/ultra-ho/cli.ts freeze <out> <name>      # CURRENT working tree's src/, package.json, tsconfig.json → <out>/rt-<name>
npx tsx experiments/ultra-ho/cli.ts driver <plan.json> [--detach] [--rerun <unit>[,<unit>]]
npx tsx experiments/ultra-ho/cli.ts status <out>
npx tsx experiments/ultra-ho/cli.ts summarize <out>          # <out>/summary.{json,md}
npx tsx experiments/ultra-ho/cli.ts reextract <out>          # re-derive fidelity.json/tasks.json of completed units from their evidence (no model)
npx tsx experiments/ultra-ho/cli.ts pick-task                # the live-validation task rule
npx vitest run test/experiments/ultra-ho.test.ts             # model-free tests
```

- `freeze`: REVISION.json `{head, dirty (git status --porcelain), files (sha256 of the DESTINATION bytes), digest, frozenAt,
  sourceDiffers?}`; node_modules linked; an existing `rt-<name>` is never overwritten (the copy is renamed into place when complete).
  Units verify their runtime against REVISION.json before running.
- Plan (`plans/live.json`): `{out, phase, seed, repeats, concurrency, scratch, sweCache?, sweFixtures?, sweCacheSource?, tasks: [id | {task,
  kind}], arms: [{name, mode: "ultra"|"strong", runtime, limits?, piGuardMs?}]}`. `scratch` and `sweCache` must be outside the repository.
  `sweFixtures` (default `fixtures/advisor-bench/swe`) and `sweCacheSource` (default `results/advisor-reviewer/cache/swe`) name another
  SWE fixture root of the same layout and the cache its environments are staged from (relative: from the repository; part of the
  plan hash when given). The driver stages from them, gives the unit process `ADVISOR_BENCH_SWE_DIR` (only when `sweFixtures` is
  set; Pi never gets it), records both roots in `plan-<phase>.json` and `input.json`, and each unit records `fixtureRoot`,
  `sweCacheSource` and `sweCache` in `meta.json` (a SWE task read from another root fails the unit). A plan without them runs as before.
- Driver: lock per phase, atomic manifest, `plan-<phase>.json` (plan hash, runtimes, frozen provider, harness digest, upstream, Pi and
  Node versions), seeded unit order (repeat-major, arms shuffled per task/repeat), concurrency. Resume: completed units are reused; an
  incomplete unit directory is kept as `.interrupted-<n>` (a Pi process group it left alive is killed) and rerun. One infra retry, only
  for a run without any successful model request (kept as `.infra-<n>`); a unit process that died after successful requests is
  `harness-error` (not retried; `--rerun` after fixing the harness keeps the attempt as `.rerun-<n>`). Children stop with the driver
  (signals; a unit whose driver is gone stops its Pi group by itself); SIGHUP is ignored; `--detach` runs it in its own session.

## One unit (`run-one.ts`)

Fresh workspace from the task's visible snapshot: `git init` + `git add -A`, **no commit anywhere** (an unborn branch), initial tree id
from `git write-tree`. SWE tasks: python wrappers (ultra-ab), environments staged into `plan.sweCache`. Private agent dir (catalog
and provider connection only, base URL = the run's proxy). `pi --mode json` with the one-shot `/orche ultra|strong <ultra-ab userPrompt>`
and the frozen provider and runtime. Evidence in `<out>/runs/<task>/<arm>/r<n>/`:

| file | content |
|---|---|
| `meta.json` | everything below in short; `status: "completed"` is written last |
| `events.jsonl`, `stderr.txt` | Pi's JSON event stream |
| `wire.jsonl`, `wire.jsonl.totals.json`, `envelope.json` | the proxy log (no bodies, no headers), totals, list prices |
| `fidelity.json` | sessions by prompt_cache_key, route violations, unattributed requests, usage/USD by role and session |
| `records/`, `sessions/`, `main-artifacts/` | orche records (run.json, events.jsonl, worker transcripts), main's session, full texts of spilled tool results |
| `tasks.json` | per orche task (main's orche_task call): assignment number, worker, task id main passed, carried or not, carried candidates, `Ultra:` lines, Resume lines, ultra gate events (records events.jsonl `type: "ultra"`), adoptions with the last fresh check before each, report stages the runtime record does not show |
| `final.diff`, `workspace-final/` | diff against the initial tree (private index; `.orche`, installs and caches excluded); the final files |
| `grade.json` | ultra-ab `gradeWorkspace` (independent of any model) and integrity |

Terminal status: ultra-ab `terminalOf` over the request's orche tasks (the last one's status; guard; no task; infra). Primary pass:
terminal done, grade passed, no integrity violation. Secrets (the provider key) are redacted from every text file.

## Dry run (no model)

`node experiments/ultra-ho/dry-upstream.mjs 0` prints a port; launching the driver with `ULTRA_HO_UPSTREAM=http://127.0.0.1:<port>`
forwards only the provider's model listing and refuses every model request (503), so the whole plumbing runs without any model.
Each unit and plan record the upstream; a phase never mixes upstreams. `results/ultra-ho/dry` holds the dry run made before the live
validation (`results/ultra-ho/dry-closed-port`: an earlier attempt with a closed port, where Pi could not register the provider's models).

## Live validation (2026-10-24)

`plans/live.json`: runtime `fixed` = the working tree with the ultra execution-stability fixes, task `a1-rounding` (`pick-task`: the
first fixtures/suite task ultra-ab's loadTask accepts that no earlier study used), two concurrent ultra units: `normal` (default
limits) and `interrupted` (assignment = overall = 12 min, no extension, Pi guard 90 min). Results: `results/ultra-ho/live/`
(`VALIDATION.md`, `summary.md`): both units done, graded pass (visible and hidden tests), integrity clean, primary pass, 0 route
violations, $1.36 and $1.22 at list prices. In `interrupted`, the first assignment timed out after its adoption and review; main
continued it with `worker "W1"` and `task "T1"` as the Resume line said; the continuation carried the candidates and the adoption,
the gate refused a report without fresh checks and a fresh review, then passed. `reextract` re-derived `tasks.json` afterwards
(as-collected files kept as `*.collected.json`).

## Stage 3: hand-off F/H study (2026-10-24)

`plans/stage3a.json` (tox-3904 ×2, pyfakefs-1286 ×2) and `plans/stage3b.json` (line-bot-981, stravalib-709, sqlglot-7187), arms F
(`rt-fixed`) and H (`rt-handoff`, + the analyst hand-off rule), preregistered in `results/ultra-ho/stage3/PREREGISTRATION.md`.
`chain.ts <out>` measures each link from the raw records (analyst report → candidate coverage/exclusion → final diff → grade →
process); the reference fix is gold for that analysis only. Results: `results/ultra-ho/stage3/REPORT.md` and
[docs/ultra-ho-bench.md](../../docs/ultra-ho-bench.md). The mechanism was shown on the exposed tox task, efficacy was not
demonstrated (fresh units at ceiling) and no regression was flagged.
The round-1 harness is kept byte for byte in `results/ultra-ho/stage3/harness/`.

## Stage 3 round 2: H2 (2026-10-24)

Preregistered in `results/ultra-ho/stage3-r2/PREREGISTRATION.md`: arm F (`rt-fixed`) against H2 (`rt-handoff2`, the corrected rule of
[docs/orchestrator.md](../../docs/orchestrator.md) 14.2: a finding is handed off only when one implement candidate owns it and names
it). Fresh tasks come from `fixtures/advisor-bench/swe-r2` with caches in `results/advisor-reviewer/cache/swe-r2` (plan keys
`sweFixtures`, `sweCacheSource`). `chain.ts <out> [--dest <dir>]` classifies every finding (an orchestrator's exploration round and a
path) in both arms by H2's test on every candidates call after its report: assigned, reference, excluded, out of scope (main's
`files` or the runtime's record), mention-only, owned-only or dropped; it keeps the first proposal, the refusals that named the finding
and gate attribution (a refusal named it, the next accepted call assigned it, no earlier proposal had), and cross-checks H2's
recorded dispositions. The gold is read under each unit's own fixture root. It never writes into `results/ultra-ho/stage3/`: round 1's
outputs stay as they are, and a re-analysis of those units goes to `--dest`.

`r2.ts` (model-free) applies round 2's frozen rules from the unit records:

- `attempts <out>`: each unit's attempts and their class:
  - an outcome;
  - a provider-capacity stop (H2-A2: an HTTP 429/5xx or capacity provider error ends a non-done unit);
  - void (H2-A3: any request off the pinned model or effort);
  - harness or interrupted.

  It prints the `--rerun` list. Stops and voids share a bound of 2 reruns. An unfinished attempt under a live driver is running and
  is never rerun.
- `select <calibration out> <plan>`: H2-A1 item 5 and the first three qualifying tasks in pool order. It is final only when every
  planned unit is accounted for.
- `decide <validation out> <selection.json>`: the decision rules, and completeness against the 4k + 4 preregistered units. A missing
  unit makes the result inconclusive, never a failure.
- `grounding <out>`: a descriptive audit of what each H2 reference/excluded disposition's cited check really was.
- `costs <out>...`: requests, provider errors, off-route requests and list-price cost of every attempt, current and kept.

The unit proxy enforces the route. `run-one.ts` writes `route: { model, effort }` into `envelope.json`. `proxy.mjs` then refuses any
model request for another model id, request effort or configuration_update effort before it reaches the gateway (HTTP 400, logged
`refused: "route"`).
