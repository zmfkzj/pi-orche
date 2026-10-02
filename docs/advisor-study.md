# Advisor study: advisors ON vs OFF

This descriptive experiment measures the effect of the [advisor layer](advisor.md) on result quality and cost, with the Pi default prompt held constant. The `smoke-2` A1 run completed and passed all grading checks after one harness-bug retry. The full study has now started: Chunk 1 completed 8/32 cells. Comparative conclusions remain pending until all four chunks finish; see Results below.

## Method

| Arm | Prompt variant | Advisor setting |
|---|---|---|
| A0 | C0 (Pi default, no replacement `baseSystemPrompt`) | OFF; routes identical to C0 |
| A1 | C0 | ON; the production advisor configuration below |

`--variants` accepts study arm names `A0,A1` alongside the existing `C0,C1,C2` prompt arms. C0/C1/C2 still have advisors off. A0 is a separate name so both advisor-study arms are fresh runs under the same source revision, not a comparison against old C0 artifacts.

The harness uses a small provider-to-extension map: a `cliproxyapi` base model automatically adds `providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"]` to **every** arm, including A0. A1 also needs this extension for its advisors even with the default OpenAI base. It uses exactly these enabled advisors, both targeting the coordinator:

| Preset | Route | Model / thinking | Triggers | Call budgets (run / target) |
|---|---|---|---|---|
| `plan-review` | `advisor-plan` | `cliproxyapi/gpt-6-astra` / `xhigh` | One `coordinator_decision` trigger: `decisions: ["assign"]`, `await: true` | 4 / 4 (preset defaults) |
| `verification-audit` | `advisor` | `cliproxyapi/claude-opus-5-5` / `xhigh` | `assignment_result` with `kinds: ["implement", "fix", "verify"]`; plus `before_complete` | 8 / 8 |

Both presets retain `cooldownMs: 0`; the default advisor timeout is 90,000 ms. `before_complete` is always awaited. Advice is a NOTE, not a gate: the coordinator may retain or revise its decision. There are no worker-targeted advisors in these arms.

**Identical:** prompt C0, all non-advisor routes (coordinator, explorer-path/cause/repro, verifier, implementer, answer) and the default route (configured `--base-model`, thinking `high`), coordinator/worker/verifier tools, fixture instructions, grading, fresh workspace per run, and source revision. The analyst inherits the same default. **Different:** only the advisor setting and its two routes; on cliproxyapi both arms load the same extension. Advisor advice may change downstream decisions and requests; those effects are outcomes, not changes to the baseline routes.

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

## Full study commands (prepared, not executed)

The successful smoke is available. These wider chunk commands are prepared **but were not executed**; the actual two-task Chunk 1 invocation is recorded under Results. Do not launch additional chunks implicitly.

```sh
npx tsx src/eval/compare.ts --study --tasks b7-api-docs,a3-refactor-tax,a7-auth-rotation,b5-ctx-migration \
  --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume
npx tsx src/eval/compare.ts --study --tasks c4-malformed-lines,a2-discount-codes,c5-aggregate-perf,b4-router-review \
  --variants A0,A1 --repeats 2 --concurrency 4 --base-model cliproxyapi/gpt-6.1-sol --out results/advisor-study/full --resume

# Reconcile all cells and refresh the manifest with the complete task list.
# If both chunks completed, this schedules zero new runs.
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

TODO: finish all four chunks (32 cells), reconcile the all-eight-task manifest, and report the complete descriptive quality/cost comparison. Interim chunk evidence is progress only, not a final advisor-effect conclusion.

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
