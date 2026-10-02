# Advisor study: advisors ON vs OFF

This descriptive experiment measures the effect of the [advisor layer](advisor.md) on result quality and cost, with the Pi default prompt held constant. All 32 planned cells are complete: A0 task pass 15/16, A1 16/16. Advisor review added 126.1 s to mean wall time overall. Runtime-version and source-drift caveats prevent a clean causal interpretation; see Results and the chunk appendix below.

## Method

| Arm | Prompt variant | Advisor setting |
|---|---|---|
| A0 | C0 (Pi default, no replacement `baseSystemPrompt`) | OFF; routes identical to C0 |
| A1 | C0 | ON; the production advisor configuration below |

`--variants` accepts study arm names `A0,A1` alongside the existing `C0,C1,C2` prompt arms. C0/C1/C2 still have advisors off. A0 is a separate name so both advisor-study arms are fresh runs, not a comparison against old C0 artifacts. Source/runtime changes during execution are disclosed in Results.

The harness uses a small provider-to-extension map: a `cliproxyapi` base model automatically adds `providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"]` to **every** arm, including A0. A1 also needs this extension for its advisors even with the default OpenAI base. It uses exactly these enabled advisors, both targeting the coordinator:

| Preset | Route | Model / thinking | Triggers | Call budgets (run / target) |
|---|---|---|---|---|
| `plan-review` | `advisor-plan` | `cliproxyapi/gpt-6-astra` / `xhigh` | One `coordinator_decision` trigger: `decisions: ["assign"]`, `await: true` | 4 / 4 (preset defaults) |
| `verification-audit` | `advisor` | `cliproxyapi/claude-opus-5-5` / `xhigh` | `assignment_result` with `kinds: ["implement", "fix", "verify"]`; plus `before_complete` | 8 / 8 |

Both presets retain `cooldownMs: 0`; the default advisor timeout is 90,000 ms. `before_complete` is always awaited. Advice is a NOTE, not a gate: the coordinator may retain or revise its decision. There are no worker-targeted advisors in these arms.

**Intended identical controls:** prompt C0, all non-advisor routes (coordinator, explorer-path/cause/repro, verifier, implementer, answer) and the default route (configured `--base-model`, thinking `high`), coordinator/worker/verifier tools, fixture instructions, grading and fresh workspace per run. The analyst inherits the same default. **Arm difference:** advisor setting and its two routes; on cliproxyapi both arms load the same extension. Advisor advice may change downstream decisions and requests; those effects are outcomes. Actual SDK/source revisions were not frozen across all cells; see the exhaustive provenance table in Results.

`--base-model <provider/modelId>` works in both `--study` and single-comparison modes; it defaults to `openai/gpt-6.1-sol` for backward compatibility. This environment requires **`--base-model cliproxyapi/gpt-6.1-sol`** because only cliproxyapi OAuth is configured. The user describes this as a plain OpenAI proxy serving the same model; wire host/model/effort are recorded independently. A0/A1 numbers are **not directly comparable to `results/prompt-study` or `results/comparison`**: the backend host differs. Rubric grading uses the same configured base model/high in its own observed runtime with the required extension; grading usage stays separate.

The registry in `src/eval/arms.ts` builds routes through `parseRouteConfig`, expands presets and fails loudly on invalid settings. `study-manifest.json` records top-level `baseModel`; arm metadata (`name`, `baseModel`, `promptVariant`, resolved `advisors`, `advisorRoutes`, `providerExtensions`, `allowedModelEffortPairs`) is saved under `arms`, and per-run `meta.json` under `arm` / `overlay.arm` and the recorded `command`.

### Tasks and repeats

Use the same eight-task subset as the [prompt study](prompt-study.md#tasks-8-of-20):

- `b7-api-docs`: documentation; the prior baseline failure involved pagination documentation, a verification-audit target.
- `a3-refactor-tax`: refactoring and ownership.
- `a7-auth-rotation`: concurrency-sensitive bug fix.
- `b5-ctx-migration`: API migration without a compatibility adapter.
- `c4-malformed-lines`: malformed-input robustness.
- `a2-discount-codes`: multi-requirement feature.
- `c5-aggregate-perf`: performance under hidden checks.
- `b4-router-review`: read-only answer/review.

N = 2 repeats per (task, arm): 8 tasks × 2 arms × 2 repeats = **32 runs**, concurrency 4. Arms are interleaved per task and their first position rotates by task index and repeat. Freeze `src`, the repository `orche.config.json` and fixtures throughout the study; compare saved `sourceRevision` values before interpreting results. Resume does not enforce revision equality. N=2, a ceiling-heavy subset and model-judged rubric items limit conclusions; this is descriptive, not a significance test.

## Prerequisites

- With the default base model, Pi needs an **OpenAI credential for `openai/*`** (supported OpenAI auth or `OPENAI_API_KEY`). A cliproxyapi login does not authenticate `openai`. In this environment use `--base-model cliproxyapi/gpt-6.1-sol` instead; do not change user auth or routing files.
- cliproxyapi runs need **cliproxyapi credentials**, the base model with `high` support, A1's advisor models with `xhigh` support, and `npm:@router-for-me/pi-cliproxyapi-provider` already installed at user scope. The harness loads that package's extensions; it does not install them. See [provider registration](pi-package.md#models-auth-and-providers-that-extensions-register).
- Run from the repository root with dependencies installed. Do not print credentials into logs or reports.

The study uses explicit arm routes, not the interactive user's routing configuration. `results/advisor-study/user-orche.config.json` is a separate, copyable production proposal with its own non-advisor routes. It was validated by `test/eval/user-config.test.ts` using `loadRouteConfig` / `parseRouteConfig` (2 tests passed); no user config or repository `orche.config.json` was overwritten. Parsing proves the schema and preset expansion, not credential or model availability.

## Request verification

`src/eval/pi-runner.ts` validates payloads before provider execution and checks saved request usage again before accepting a `done` run:

- Every non-advisor request must be the saved arm's `baseModel` / `high`; A1 does not relax this check.
- Advisor requests must match that advisor's configured model/effort pair. Attribution requires the advisor name in trusted system instructions **and** the active `advisor_verdict` tool, not merely an advisor model name. The observer supports both shorthand `systemPrompt`/`tools` and normalized system messages with `sections`/`toolsAdded`/`toolsRemoved`; it never trusts user-message text for attribution.
- `provider-requests.jsonl` records `actor` (`non-advisor` or `advisor:<name>`), normalized `model` / `effort`, `matchedPair` (`actor`, `model`, `effort`, optional `route`), `wireEffort` and `effortSource`.
- `effortSource` names the captured field: `reasoning.effort`, `reasoning_effort`, `output_config.effort`, or `absent`. Non-advisor requests accept Responses `reasoning.effort` or Chat Completions `reasoning_effort`, strictly at `high`; the wire value is never rewritten. Advisor normalization uses only a physical model's declared `thinkingLevelMap`; the original wire value remains recorded. `verify-arms.ts` consumes these observer rows independently of the request shape. In smoke-2 all three models actually used Responses (`/backend-api/codex/responses`) and `reasoning.effort`, including Claude; no Chat Completions or Anthropic-style effort downgrade was observed.

`results/advisor-study/verify-arms.ts` independently compares every captured provider request to the **saved** base model and resolved advisors/routes in `meta.json` / the manifest, checks `actor` against `matchedPair`, and validates `advisor_usage` names/models. Legacy metadata without `baseModel` derives it from the saved non-advisor allowed pair, not a hard-coded provider. It reports `requests`, `nonAdvisorRequests`, `advisorRequests`, `advisorUsage`, and per-actor models/efforts/wire efforts. It exits nonzero on deviations, manifest/per-run route disagreement or no captured requests. It does not prove a quality improvement or require a minimum advisor activation count; check those separately for the smoke run. Both post-processing scripts make no model calls and automatically discover present arms, including an A1-only study.

## Metrics

`results/advisor-study/analyze.ts` writes `<study>/analysis/{tables.md,runs.json}`:

- Task pass = runner `done` ∧ all enabled grader checks passed ∧ captured model/effort valid. Visible, hidden and rubric pass rates exclude disabled checks.
- Mean visible/hidden named-test-case fractions and rubric satisfied-item fractions. Hidden denominators use the largest case count observed for that task across analysed runs; these are cases, not assertion counts.
- Runner wall time (`wallClockMs`), sent provider requests and known input/output/cache-read/cache-write tokens, excluding grading requests. Tokens are lower bounds when response usage is unknown.
- Event-derived worker/coordinator/advisor splits, preserving `requests`, `inputTokens`, `outputTokens`, `cacheRead`, `cacheWrite`. Completed-turn event counts can differ from sent-request counts on failures. Advisor usage is already included in overall totals: do not add it twice.
- Per-task A0 vs A1 pass/check tables and mean wall/request/input+output-token differences. Missing arms show `n/a`; missing event files remain null rather than invented zero counts.

The counters from `src/eval/metrics.ts` are retained under `runs[].eventMetrics` and summed per arm:

| Field | Definition |
|---|---|
| `advisorTriggered` | Count of `advisor_triggered` events |
| `advisorResults.ok`, `advisorResults.concern`, `advisorResults.blocker` | `advisor_result` counts by verdict; these are the dotted keys in flat metrics |
| `advisorDelivered` | `advisor_result` with `delivered: true` |
| `advisorFailed` | Count of `advisor_failed` events |
| `coordinatorReconsiderations` | Count of `coordinator_reconsidering` events |
| `awaitedAdvisorCalls` | `advisor_triggered` with `await: true` |

The existing `advisorUsage` metrics retain the five token/request fields above; the analysis exposes them as `eventMetrics.usageByActor.advisor` and lists `advisorUsageModels`.

`events.jsonl` also includes `coordinator_decision {type, timestamp, phase, decisionType, reconsidered}` for each validated proposal. `reconsidered` is true after an explicit advisor reconsideration or consumption of queued advisor NOTES. Compare the initial and revised proposal's `decisionType` to see whether an explicit reconsideration changed the type; a changed type is not itself evidence of better quality. The initial proposal can be superseded, and this event does not change decision semantics.

## Full study commands and replay

The four executed invocations are recorded in the appendix. The wider two-chunk commands below are reference commands, not additional runs performed here. The all-eight-task command was executed for Chunk 4: it skipped 24 completed cells and ran only the eight remaining cells. Replaying it now would skip all 32 completed cells, including the failure.

```sh
npx tsx src/eval/compare.ts --study --tasks b7-api-docs,a3-refactor-tax,a7-auth-rotation,b5-ctx-migration \
  --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume
npx tsx src/eval/compare.ts --study --tasks c4-malformed-lines,a2-discount-codes,c5-aggregate-perf,b4-router-review \
  --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume

# Reconcile all cells and refresh the manifest with the complete task list.
# After all four chunks have completed, this schedules zero new runs.
npx tsx src/eval/compare.ts --study --tasks b7-api-docs,a3-refactor-tax,a7-auth-rotation,b5-ctx-migration,c4-malformed-lines,a2-discount-codes,c5-aggregate-perf,b4-router-review \
  --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume
npx tsx results/advisor-study/verify-arms.ts --study results/advisor-study/full --out results/advisor-study/full/arm-verification.json
npx tsx results/advisor-study/analyze.ts --study results/advisor-study/full --out results/advisor-study/full/analysis
```

`--resume` skips any cell whose `meta.json` has `completed: true`, **including terminal failures**; it schedules missing/incomplete cells, not automatic retries of failures. Without it, an existing completed cell is an error. Each invocation rewrites `study-manifest.json` for its requested task subset and rebuilds each arm's summary from all saved runs; the final all-task command restores the complete manifest. Use a fresh study directory if routes or source revisions change, and preserve failed artifacts rather than silently replacing them.

Layout: `<out>/<arm>/<task>/pi[/attempt-<repeat>]`, with per-run `meta.json`, `grade.json`, `usage.json`, `provider-requests.jsonl`, `events.jsonl` and `workspace-final/`; each arm has `summary.json`. Here `attempt-2` is the second planned repeat, not a retry selected after failure.

## Smoke history and smoke-2 outcome

The previous `results/advisor-study/smoke` remains unchanged: the default `openai/gpt-6.1-sol` run failed before its first provider request with `No API key found for openai`. See its `diagnosis.json`. This motivated the explicit base-model override, not an advisor fallback.

Executed smoke-2 syntax (A1, one task, one repeat, concurrency 1):

```sh
npx tsx src/eval/compare.ts --study --tasks b7-api-docs --variants A1 --repeats 1 --concurrency 1 \
  --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/smoke-2
npx tsx results/advisor-study/verify-arms.ts --study results/advisor-study/smoke-2 --out results/advisor-study/smoke-2/arm-verification.json
npx tsx results/advisor-study/analyze.ts --study results/advisor-study/smoke-2 --out results/advisor-study/smoke-2/analysis
```

Single-comparison equivalent: `npx tsx src/eval/compare.ts --tasks b7-api-docs --systems pi --prompt-variant A1 --base-model cliproxyapi/gpt-6.1-sol --out <fresh-dir>` (documented only; not executed).

The first smoke-2 attempt exposed a harness attribution bug: current Pi put advisor instructions/tools in normalized system messages, but the observer inspected only shorthand fields. All four advisor calls were rejected as `non-advisor` before HTTP execution (`Study arm A1 rejects non-advisor request ...:xhigh`); this was not a provider error, timeout or plain-text answer. The orchestration report was `done` and grade passed, but runner status was `failed` due to model/effort validation. Wall time was 339554 ms; 23 payload captures included four blocked advisor payloads, with 19 actual HTTP requests. Those artifacts were moved intact to `smoke-2/failed-first/`; their absolute paths still reflect the original as-run location. After fixing and regression-testing attribution, exactly **one retry** used the same CLI above. No more runs were launched.

Evidence: `results/advisor-study/smoke-2/diagnosis.json`, `arm-verification.json`, `analysis/{tables.md,runs.json}`, and `A1/b7-api-docs/pi/`.

| Observation | Successful retry |
|---|---|
| Run status / grade | `done` / passed; visible 2/2 named cases (Node reports 3 including helper file), hidden 3/3, rubric 6/6 |
| Runner wall time | 550861 ms (550.861 s, about 9m11s), excluding grading |
| Captured requests / input / output / cacheRead / cacheWrite | 36 / 148292 / 26617 / 340244 / 0; zero unknown-usage requests |
| Advisor triggered / results (ok, concern, blocker) / failed / usage events | 4 / (4, 0, 0) / 0 / 13 |
| Advisor delivered / awaited calls / coordinator reconsiderations | 0 / 2 / 0 |
| Coordinator decisions with `reconsidered: true` | 0; classify, assign and complete all had `false` |
| Arm verification | Exit 0, `allOk: true`; 23 base/high requests, 1 plan-review/xhigh request, 12 verification-audit/xhigh requests; no violations |
| Analysis | Both output files rendered, including per-arm, actor-usage and A0/A1 task tables (A0 shows `n/a`) |

| Actor | Requests | Input | Output | CacheRead | CacheWrite |
|---|---:|---:|---:|---:|---:|
| Worker (including verifier) | 20 | 62856 | 11516 | 193920 | 0 |
| Coordinator | 3 | 7669 | 284 | 2816 | 0 |
| Advisor | 13 | 77767 | 14817 | 143508 | 0 |

These completed-turn event totals exactly match provider totals. Separately, the rubric judge used 1 base/high request, input 3778, output 443, no cache tokens. Four advisor activations produced 13 model turns; all verdicts were `ok` with empty notes, so `delivered: false` and zero reconsiderations are expected, not failed advice.

Wire facts: base request id 1 used `100.96.224.97:8317/backend-api/codex/responses`, wire model `gpt-6.1-sol`, `reasoning.effort: high`. Plan-review request id 3 used the same endpoint, wire model `gpt-6-astra`, `reasoning.effort: xhigh`. Verification-audit request id 14 also used that endpoint, wire model `claude-opus-5-5`, `reasoning.effort: xhigh`. All HTTP responses were 200. The observer records provider-qualified models, wire effort and field source without changing payloads. Chat Completions compatibility is unit-tested, not live-tested here; backend model equivalence is the user's statement, not independently verified.

Checks: `npx tsc --noEmit -p .` clean; `npx vitest run test/eval`: 7 files, 73/73 tests; full `npx vitest run`: 41 files, 1003/1003 tests. User auth/config and repository `orche.config.json` were not changed. No commits.

## Results

All **32 planned cells** are complete (31 runner `done`, one preserved behavioral failure). A0 passed 15/16 tasks; A1 passed 16/16. This is descriptive evidence from this suite, not a causal or statistically established quality improvement. The all-eight-task manifest is restored; Chunk 4 skipped 24 completed cells, including the failed cell, and launched only eight new runs. No full-study cell was rerun.

### Headline and actor costs

Source: `results/advisor-study/full/analysis/tables.md` (headline supplement), derived from `analysis/runs.json`; wall time excludes grading and includes all planned repeats, including failures. Disabled checks are excluded from pass denominators. Median is the midpoint of the two middle run times.

| Arm | Runs | Task pass | Visible | Hidden | Rubric | Wall mean s | Wall median s | Requests mean | Input mean | Output mean | CacheRead mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A0 | 16 | 15/16 | 16/16 | 13/14 | 4/4 | 261.4 | 228.9 | 21.8 | 49566 | 6523 | 123696 |
| A1 | 16 | 16/16 | 16/16 | 14/14 | 4/4 | 387.5 | 332.4 | 40.5 | 115636 | 16887 | 301953 |

Source: `results/advisor-study/full/analysis/tables.md` (event usage split), from each run's `events.jsonl` via `analysis/runs.json`. Worker includes verifier. Counts are usage events, not all sent requests: A1 has 646 usage events versus 648 provider requests because two interrupted advisor turns have no event. Tokens exclude grading and remain known lower bounds for ten aborted calls.

| Arm | Actor | Requests | Input | Output | CacheRead | CacheWrite |
|---|---|---:|---:|---:|---:|---:|
| A0 | worker | 286 | 673040 | 95978 | 1854464 | 0 |
| A0 | coordinator | 63 | 120011 | 8395 | 124672 | 0 |
| A0 | advisor | 0 | 0 | 0 | 0 | 0 |
| A1 | worker | 338 | 711963 | 106765 | 2481152 | 0 |
| A1 | coordinator | 70 | 153988 | 9092 | 155136 | 0 |
| A1 | advisor | 238 | 984226 | 154337 | 2194953 | 0 |

### Per-task comparison

Source: `results/advisor-study/full/analysis/tables.md` (per-task table), derived from `analysis/runs.json`. Tokens here mean input + output, excluding cacheRead and grading; deltas are A1 minus A0 means.

| Task | A0 pass / reps | A1 pass / reps | A0 visible / hidden / rubric | A1 visible / hidden / rubric | A0 wall s / requests / tokens | A1 wall s / requests / tokens | A1 − A0 wall s / requests / tokens |
|---|---:|---:|---|---|---|---|---|
| a2-discount-codes | 2/2 | 2/2 | 2/2 / 2/2 / n/a | 2/2 / 2/2 / n/a | 226.1 / 20 / 55571 | 436.9 / 37.5 / 147443.5 | 210.8 / 17.5 / 91872.5 |
| a3-refactor-tax | 2/2 | 2/2 | 2/2 / 2/2 / n/a | 2/2 / 2/2 / n/a | 164.0 / 17 / 43885.5 | 292.7 / 33 / 94245.5 | 128.7 / 16 / 50360 |
| a7-auth-rotation | 2/2 | 2/2 | 2/2 / 2/2 / n/a | 2/2 / 2/2 / n/a | 492.7 / 44.5 / 92634 | 698.7 / 81 / 223914.5 | 206.0 / 36.5 / 131280.5 |
| b4-router-review | 2/2 | 2/2 | 2/2 / n/a / 2/2 | 2/2 / n/a / 2/2 | 100.3 / 14 / 33068.5 | 176.9 / 19 / 46563.5 | 76.6 / 5 / 13495 |
| b5-ctx-migration | 1/2 | 2/2 | 2/2 / 1/2 / n/a | 2/2 / 2/2 / n/a | 216.9 / 21 / 51398 | 468.4 / 61.5 / 190882.5 | 251.5 / 40.5 / 139484.5 |
| b7-api-docs | 2/2 | 2/2 | 2/2 / 2/2 / 2/2 | 2/2 / 2/2 / 2/2 | 409.3 / 18.5 / 69206 | 486.1 / 32 / 153221.5 | 76.8 / 13.5 / 84015.5 |
| c4-malformed-lines | 2/2 | 2/2 | 2/2 / 2/2 / n/a | 2/2 / 2/2 / n/a | 202.6 / 20 / 55749 | 247.4 / 31 / 100073.5 | 44.7 / 11 / 44324.5 |
| c5-aggregate-perf | 2/2 | 2/2 | 2/2 / 2/2 / n/a | 2/2 / 2/2 / n/a | 279.0 / 19.5 / 47200 | 292.7 / 29 / 103841 | 13.7 / 9.5 / 56641 |

### Advisor activity and reconsideration

Source: `results/advisor-study/full/analysis/tables.md` (advisor events), from per-run `events.jsonl`.

| Arm | Triggered | Results ok / concern / blocker | Delivered | Failed | Awaited calls | Coordinator reconsiderations |
|---|---:|---:|---:|---:|---:|---:|
| A0 | 0 | 0 / 0 / 0 | 0 | 0 | 0 | 0 |
| A1 | 71 | 61 / 8 / 0 | 8 | 2 | 32 | 5 |

Source: `results/advisor-study/full/analysis/tables.md` (per-advisor supplement), independently counted from `A1/*/pi[/attempt-2]/events.jsonl`; sent-request counts are from `arm-verification.json`.

| Advisor (A1) | Triggered | ok | concern | blocker | Delivered | Failed | Awaited | Sent requests | Usage events |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| plan-review | 16 | 16 | 0 | 0 | 0 | 0 | 16 | 34 | 34 |
| verification-audit | 55 | 45 | 8 | 0 | 8 | 2 | 16 | 206 | 204 |

Eight concern verdicts were delivered, so this was **not** an all-ok/no-advice study. All delivered concerns came from verification-audit; plan-review returned only ok. There were 5 reconsidering events and 5 validated decisions with reconsidered=true. Two audit calls timed out after 90000 ms (A1/a7-auth-rotation/r1 and A1/b4-router-review/r1), but both cells completed and passed; no infrastructure-cell rerun was warranted.

Source: `results/advisor-study/full/analysis/tables.md` (reconsidered supplement); exact event paths and timestamps are in `analysis/final.json` and each listed run's `events.jsonl`.

| Cell | Phase | Before type | After type (`reconsidered: true`) | Same-phase type change |
|---|---|---|---|---|
| A1/a2-discount-codes/r2 | VERIFY | not recorded | verification_failed | not identifiable |
| A1/a7-auth-rotation/r1 | VERIFY | not recorded | verification_failed | not identifiable |
| A1/a7-auth-rotation/r2 | VERIFY | not recorded | complete | not identifiable |
| A1/b4-router-review/r2 | EXPLORE | answer_from_worker | answer_from_worker | no |
| A1/b5-ctx-migration/r1 | VERIFY | not recorded | complete | not identifiable |

For the four VERIFY rows, queued NOTES were consumed before the first recorded VERIFY proposal: the preceding validated event was BACKLOG assign, not a pre-advice VERIFY decision. A type change cannot be inferred. For router-review/r2, the initial and reconsidered proposals both used answer_from_worker: the decision type was retained. Auth/r1 and discount/r2 subsequently entered another fix assignment and then completed, but no counterfactual run establishes how they would have behaved without the notes.

### Cost of attaching the advisor layer

Source: `results/advisor-study/full/analysis/tables.md` (advisor-share supplement), derived from `analysis/runs.json` and `arm-verification.json`. Denominator is A1 only. Shares use sent request counts and known token usage; cacheRead is shown separately and no monetary/pricing claim is made.

| A1 cost measure | Advisor | A1 total | Advisor share |
|---|---:|---:|---:|
| Sent requests | 240 | 648 | 37.04% |
| Input + output known | 1138563 | 2120371 | 53.70% |
| CacheRead known | 2194953 | 4831241 | 45.43% |
| Input + output + CacheRead known | 3333516 | 6951612 | 47.95% |

Source: `results/advisor-study/full/analysis/tables.md` (model-mix supplement), from captured provider identities in `arm-verification.json`; these are wire model labels, not proof of backend model equivalence.

| Advisor model / effort | Captured requests |
|---|---:|
| cliproxyapi/gpt-6-astra / xhigh | 34 |
| cliproxyapi/claude-opus-5-5 / xhigh | 206 |

Overall A1 mean wall time was **126.1 s higher (48.2%)**. Every task had a positive mean wall delta (see the task table). A1 sent 299 more requests overall: 240 were direct advisor requests and 59 were extra non-advisor requests. This separates direct review cost from downstream work, not a causal attribution of every extra request.

### Failures and request verification

Source: `results/advisor-study/full/analysis/tables.md` (failed-cell supplement), the failed cell's `report.json`, `events.jsonl` and `grade.json`.

| Failed cell | Category | Observed reason | Expected advisor coverage |
|---|---|---|---|
| A0/b5-ctx-migration/r1 | coordinator behaviour | Classified three workers, then chose BACKLOG fail rather than discover missing inventory; no assignment or migration; hidden checks failed. | A0 had no advisors; even the A1 presets would not trigger on this early fail. Prevention is not established. |

A0/b5-ctx-migration/r1 used coordinator_decision twice but never used its available ls/find/read tools. It claimed that absent inventory made file ownership impossible and terminated instead of inspecting and assigning work. Visible tests passed against the unchanged fixture; raw hidden tests failed 0/2. This is coordinator behavior, not an observed provider or authentication failure. The configured plan-review trigger only reviews assign; audit requires worker results or before_complete. Neither would be expected to intercept this early fail without broader triggers. The other 31 cells passed all enabled grading checks. No whole-cell verification, grading-only or infrastructure failure was observed.

Source: `results/advisor-study/full/arm-verification.json`: all 32 runs passed request verification; 997 captured requests, no violations. Base model/high requests: 757; advisor xhigh requests: 240. All 996 observed run HTTP responses and 8 observed grading HTTP responses were 200. Aborted turns and the two advisor timeouts are disclosed separately, not misclassified as 429/5xx.

### Validity and provenance

- Two repeats per (task, arm), eight tasks; no significance testing or generalization claim. High pass rates create a ceiling effect, and one early behavioral refusal largely determines the pass-rate difference.
- Baseline wire host was cliproxyapi at `100.96.224.97:8317`, endpoint `/backend-api/codex/responses`. Do not directly compare these costs/grades with prompt-study/comparison, which used a different backend host. The user's statement that cliproxyapi serves the same model is not independently verified.
- Chunks 1–2 used pi-coding-agent/pi-ai/pi-agent-core 0.99.1; Chunks 3–4 used 1.0.0. Coding-agent versions are saved per run; 1.0.0 ai/core versions were read from installed package.json files at chunk boundaries. Historical ai/core versions are from the user, and historical HEAD was not recorded. Chunks 3–4 observed Git HEAD `d321400f0439bc4f4361646cbec9a18e4e6419a0`, but dirty working-tree edits mean HEAD alone is not a source snapshot.
- Source was not frozen: all three saved revisions are listed below. A1/discount/r2 ran with a different source hash from its A0 counterparts; all Chunk 4 cells used a later revision. Runtime and source drift confound cross-chunk interpretation. No unrelated edits were reverted.
- Grading is this project's own harness; documentation/review rubrics are judged by a model (configured base/high), not independent human assessment. Grading requests are excluded from solver costs. Visible case counts can include worker-added tests.
- The existing parser counts duplicate diagnostic lines in the failed b5 hidden-test output, producing a denominator of four although there are two actual cases. The displayed hidden-case means (A0 0.893, A1 0.929) are therefore understated; hidden check-pass rates above are accurate. This analysis issue was disclosed, not silently fixed or regraded.
- Ten aborted requests have unknown tokens (eight exploratory worker turns and two timed-out advisor turns). Costs are known lower bounds. Neither budget-weighted dollar cost nor backend equivalence is verified.

Source for the following revision/SDK table: all per-run `meta.json` files under `results/advisor-study/full/{A0,A1}/<task>/pi[/attempt-2]`; exhaustive cell lists are retained in `analysis/final.json`.

- **R1** = `3334257b612c2d86bd561a5976caa1e2e06e47a41f31ceef5f98f21d4cdd44a6`: 23 cells.
- **R2** = `67a80c253cdea9d1c9a6d948889479828a9b0910333d79c40a3d7d3611a46cc9`: 8 cells.
- **R3** = `20e676c70f248a1926b281b101ec069dac8382000a70f9d78cab21264763561d`: 1 cells.

| Task | Arm | Repeat 1 revision / Pi | Repeat 2 revision / Pi |
|---|---|---|---|
| b7-api-docs | A0 | R1 / 0.99.1 | R1 / 0.99.1 |
| b7-api-docs | A1 | R1 / 0.99.1 | R1 / 0.99.1 |
| a3-refactor-tax | A0 | R1 / 0.99.1 | R1 / 0.99.1 |
| a3-refactor-tax | A1 | R1 / 0.99.1 | R1 / 0.99.1 |
| a7-auth-rotation | A0 | R1 / 0.99.1 | R1 / 0.99.1 |
| a7-auth-rotation | A1 | R1 / 0.99.1 | R1 / 0.99.1 |
| b5-ctx-migration | A0 | R1 / 0.99.1 | R1 / 0.99.1 |
| b5-ctx-migration | A1 | R1 / 0.99.1 | R1 / 0.99.1 |
| c4-malformed-lines | A0 | R1 / 1.0.0 | R1 / 1.0.0 |
| c4-malformed-lines | A1 | R1 / 1.0.0 | R1 / 1.0.0 |
| a2-discount-codes | A0 | R1 / 1.0.0 | R1 / 1.0.0 |
| a2-discount-codes | A1 | R1 / 1.0.0 | R3 / 1.0.0 |
| c5-aggregate-perf | A0 | R2 / 1.0.0 | R2 / 1.0.0 |
| c5-aggregate-perf | A1 | R2 / 1.0.0 | R2 / 1.0.0 |
| b4-router-review | A0 | R2 / 1.0.0 | R2 / 1.0.0 |
| b4-router-review | A1 | R2 / 1.0.0 | R2 / 1.0.0 |

### Interpretation and follow-up

High-end-model advisors attached successfully, produced evidence-backed concerns and prompted reconsideration/additional work. In this small suite A1 reached perfect task pass, while A0 had one behavioral failure; this does not establish that an advisor caused the quality difference. Review added substantial request/token use and increased mean wall time on every task. Plan-review emitted no concerns, and the only A0 failure fell outside the existing advisor triggers. The evidence supports operational feasibility and measured cost, not an unconditional quality benefit or model superiority.

A stronger follow-up should freeze both sources and dependency versions, randomize comparable backend/time conditions, use harder tasks and more repeats, include forced-concern and early-failure coverage cases, and add a cheaper-advisor-model arm. Independent/human review and confidence-aware grading would help distinguish useful corrections from redundant notes and extra work. Repeating only the successful cells or removing the failed baseline would bias the comparison.

## Appendix: chunk progress history

The notes below record the state when each chunk finished. Earlier pending/TODO statements are historical and are superseded by the final Results above.
### Chunk 1

Executed exactly `npx tsx src/eval/compare.ts --study --tasks b7-api-docs,a3-refactor-tax --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume`. **8 done, 0 failed**; all enabled grading checks passed (tax rubric disabled). Elapsed through the last cell's completion, including grading: 880468 ms (14m40.468s). No other chunks were started.

| Task | Arm | Repeat 1 wall ms | Repeat 2 wall ms |
|---|---|---:|---:|
| b7-api-docs | A0 | 388744 | 429856 |
| b7-api-docs | A1 | 529012 | 443090 |
| a3-refactor-tax | A0 | 157025 | 170953 |
| a3-refactor-tax | A1 | 262386 | 322960 |

Observed HTTP 429: **0**; 5xx: **0**; run and judge responses all 200, no provider/auth/load errors or harness timeouts, and **0 reruns**. `verify-arms` passed all eight runs: 201 requests = 149 base/high + 7 plan-review/xhigh + 45 verification-audit/xhigh, zero violations. Analysis tables rendered. A1 produced 16 verdicts, all `ok` (plan-review 4, verification-audit 12); delivered 0, failed 0, coordinator reconsiderations 0, and no `reconsidered: true` decisions. All eight cells retained the smoke-2 source revision.

Evidence: `results/advisor-study/full/chunk-1.json` contains per-cell grades, actor token/request splits, advisor counters and infrastructure checks; `full/arm-verification.json` and `full/analysis/{tables.md,runs.json}` are interim reports. Run costs exclude rubric grading. `--resume` skips `completed: true` cells even if failed; it does not retry terminal failures. Each invocation rewrites the manifest for its task subset, so the final all-eight-task invocation is still required after Chunks 2–4. No harness code or unrelated files were changed.

### Chunk 2

Executed exactly `npx tsx src/eval/compare.ts --study --tasks a7-auth-rotation,b5-ctx-migration --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume`. **7 done, 1 failed**; elapsed through the last cell's completion: 1186738 ms (19m46.738s), including grading. No other chunks were started; Results remains TODO.

| Task | Arm | Repeat 1 wall ms | Repeat 2 wall ms |
|---|---|---:|---:|
| a7-auth-rotation | A0 | 418544 | 566780 |
| a7-auth-rotation | A1 | 754748 | 642595 |
| b5-ctx-migration | A0 | 32711 (failed) | 401160 |
| b5-ctx-migration | A1 | 437466 | 499391 |

A0/b5/r1 explicitly chose `fail` at BACKLOG because it claimed to lack a file inventory; no tasks or workspace changes followed. Visible tests passed, hidden tests failed 0/2, rubric was disabled (as for all Chunk 2 cells). Its two provider calls returned HTTP 200. This is an observed behavioral refusal, not established provider/auth/load failure or a harness timeout; **no rerun** was performed. All other cells passed enabled checks. Provider HTTP 429/5xx: **0**; all observed run/grading HTTP responses were 200.

A1 produced 26 advisor activations: plan-review 5 `ok`; verification-audit 15 `ok`, 5 `concern`, 0 `blocker`, plus one `advisor timeout after 90000ms` on auth/r1. The advisor timeout did not fail that cell, so it was not rerun. Delivered 5, coordinator reconsiderations 3: auth/r1 recorded VERIFY `verification_failed` with `reconsidered: true`; auth/r2 and b5/r1 recorded VERIFY `complete` with `true`. Each consumed queued NOTES before the proposal; a same-phase pre-advice decision was not captured, so this does not establish a before/after decision-type change. Nine aborted requests have unknown usage (eight exploratory-worker turns and one timed-out advisor turn); token totals remain known lower bounds. Auth A1/r1 has 98 provider requests but 97 usage events.

Cumulative verification passed **16 runs / 617 requests**: 458 base/high, 20 plan-review/xhigh, 139 verification-audit/xhigh; zero violations. Regenerated per-arm tables report A0 task pass 7/8, mean wall 320.7 s / requests 25.3; A1 8/8, mean wall 486.5 s / requests 51.9. **Analysis caveat:** b5 has two actual hidden cases, but the failed Node output repeats failing-case lines in diagnostics; the existing parser counts four and normalizes every b5 denominator to four. Consequently the displayed cumulative hidden-case fractions (A0 0.813, A1 0.875) understate raw success fractions; check-pass booleans remain accurate. No parser/harness code was changed.

Evidence: `results/advisor-study/full/chunk-2.json` preserves per-cell actor costs, advisor verdicts, unknown requests, reconsidered events, failure diagnosis and exact cumulative table rows. `full/arm-verification.json` and `full/analysis/{tables.md,runs.json}` now cover both chunks. All 16 cells share the accepted source revision; the manifest currently lists Chunk 2's two tasks because it is rewritten per invocation. Final all-eight-task reconciliation remains pending after Chunks 3–4.

### Chunk 3

Executed exactly `npx tsx src/eval/compare.ts --study --tasks c4-malformed-lines,a2-discount-codes --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume`. **8 done, 0 failed**, all enabled grading checks passed (rubric disabled); elapsed through the last cell's completion: 883037 ms (14m43.037s), including grading. Chunk 4 was not started; Results remains TODO.

| Task | Arm | Repeat 1 wall ms | Repeat 2 wall ms |
|---|---|---:|---:|
| c4-malformed-lines | A0 | 205883 | 199364 |
| c4-malformed-lines | A1 | 256908 | 237808 |
| a2-discount-codes | A0 | 200161 | 252001 |
| a2-discount-codes | A1 | 341794 | 532018 |

**Runtime provenance / comparability caveat:** the user upgraded dependencies between Chunks 2 and 3 after commits `9f67e60` (eval harness) and `d321400` (direct-mode external-path permission). Versions below are ordered coding-agent / ai / agent-core.

| Chunk | pi-coding-agent / pi-ai / pi-agent-core | Git HEAD / evidence |
|---|---|---|
| 1–2 | 0.99.1 / 0.99.1 / 0.99.1 | Historical HEAD was not recorded. Coding-agent version verified in all 16 saved `meta.json` files; old ai/core versions are from the user's report, not retained package snapshots. |
| 3 | 1.0.0 / 1.0.0 / 1.0.0 | `d321400f0439bc4f4361646cbec9a18e4e6419a0`; versions read directly from `node_modules/@earendil-works/{pi-coding-agent,pi-ai,pi-agent-core}/package.json` before and after the run, unchanged. All eight new run metas also record Pi 1.0.0. |
| 4 (not run) | Expected 1.0.0 / 1.0.0 / 1.0.0 | Re-read installed versions and HEAD when starting it; this is not yet observed run provenance. |

**Additional source drift:** seven Chunk 3 cells retained source revision `3334257b612c2d86bd561a5976caa1e2e06e47a41f31ceef5f98f21d4cdd44a6`, but A1/a2/r2 recorded `20e676c70f248a1926b281b101ec069dac8382000a70f9d78cab21264763561d`. Concurrent working-tree source edits were visible by the end of the run despite unchanged Git HEAD; they were not touched or reverted by this worker. Source was therefore not frozen across all cells. Runtime upgrade and source drift must both be disclosed in the final analysis; their effect on outcomes is unverified. No rerun was justified by these successful cells.

HTTP 429/5xx, provider/auth/load errors, harness/advisor timeouts and reruns: **0** in Chunk 3; all observed provider HTTP responses were 200, unknown usage 0, actor usage totals equal provider totals. A1 had 19 activations: plan-review 5 `ok`; verification-audit 12 `ok`, 2 `concern`, 0 `blocker`; failed 0, delivered 2. Only A1/a2/r2 reconsidered (once): VERIFY `verification_failed` with `reconsidered: true`, followed by a fix assignment and final `complete`. Queued NOTES were consumed before that VERIFY proposal; no same-phase pre-advice type was recorded, so a before/after type change is not established.

Cumulative verification passed **24 runs / 834 requests**: 621 base/high, 31 plan-review/xhigh, 182 verification-audit/xhigh; zero violations. Regenerated per-arm rows show A0 task pass 11/12, mean wall 285.3 s / requests 23.5; A1 12/12, mean wall 438.3 s / requests 46. The prior b5 hidden-case denominator anomaly remains (displayed cumulative fractions 0.875 / 0.917), and nine unknown requests remain from Chunk 2. The prior A0/b5/r1 coordinator classified three workers but called only `coordinator_decision`, choosing `fail` instead of discovering the inventory with its available read-only tools; no tasks or migration followed. That behavioral failure remains preserved.

Evidence: `results/advisor-study/full/chunk-3-runtime.json` records pre-run provenance; `full/chunk-3.json` records post-run versions/HEAD, per-cell costs/events/source revisions, prior-failure evidence and exact cumulative table rows. `full/arm-verification.json` and `full/analysis/{tables.md,runs.json}` now cover all three chunks. The manifest currently lists Chunk 3's two tasks; final all-eight-task reconciliation remains pending. No harness code was changed by this worker.

### Chunk 4

Executed the all-eight-task command in `chunk-4.json`: **24 skipped, 8 run, 8 done, 0 failed**. The skipped metas (including A0/b5/r1) are byte-identical to their pre-run SHA-256 snapshots. The manifest now covers all eight tasks and all 32 cells are terminal. Elapsed through the last new cell's completion: 490123 ms (8m10.123s), including grading. No retries or additional study invocations were launched.

| Task | Arm | Repeat 1 wall ms | Repeat 2 wall ms |
|---|---|---:|---:|
| c5-aggregate-perf | A0 | 292532 | 265524 |
| c5-aggregate-perf | A1 | 273820 | 311624 |
| b4-router-review | A0 | 101230 | 99362 |
| b4-router-review | A1 | 204658 | 149107 |

Start HEAD: `d321400f0439bc4f4361646cbec9a18e4e6419a0`. Installed `pi-coding-agent` / `pi-ai` / `pi-agent-core`: **1.0.0 / 1.0.0 / 1.0.0**, read from each installed package.json; post-run versions and HEAD also matched. Start `git status --short` paths (names only): `README.md`, `docs/advisor-study.md`, `package-lock.json`, `package.json`, `src/extension/workers.ts`, `src/orchestration/ownership.ts`, `src/orchestration/routing.ts`, `src/tools/generate-image.ts`, `test/extension/images.test.ts`, `test/live/`, `test/orchestration/images-config.test.ts`, `test/tools/generate-image.test.ts`. No unrelated paths were touched or reverted. All eight new metas record source revision `67a80c253cdea9d1c9a6d948889479828a9b0910333d79c40a3d7d3611a46cc9` and Pi 1.0.0.

No infrastructure-failed cells or HTTP 429/5xx. A1/router-review/r1 had one 90000 ms verification-audit timeout and one unknown-usage aborted request, but passed the task; no rerun. Router-review/r2 delivered a concern and explicitly resubmitted `answer_from_worker` unchanged in type. Final verification passed 32 runs / 997 captured requests, zero violations. Final tables, medians, model mix, shares and provenance are saved in `full/analysis/{tables.md,final.json,final-tables.json,results-section.md}`; `analysis/finalize.mjs` performs saved-artifact aggregation only, never calls models. `docs/advisor.md` already links this study without claiming that results are pending, so no link change was needed.
