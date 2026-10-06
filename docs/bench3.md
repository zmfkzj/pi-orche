# Three-system benchmark — 2026-10-02

> **역사 기록** — 2026-10-06 기준 제거/대체됨: 비교 대상이던 multi coordinator와 src/eval 러너. 현재 구조: [docs/orchestrator.md](orchestrator.md). 아래 본문은 당시 기록 그대로다.

**Status: full run launched; final results pending.** This extends the in-repo harness only: 28 tasks × 3 systems × 3 repeats = **252 executions**, global job concurrency 4. [Live/partial report](../results/compare/bench3-2026-10-02/summary.md), [JSON](../results/compare/bench3-2026-10-02/summary.json), [launch record](../results/compare/bench3-2026-10-02/launch.json).

**Backend parity is achieved in the corrected pilot, including Pi's real main session:** all 314 captured solver requests used `https://chatgpt.com/backend-api/codex/responses`, `gpt-6.1-sol`, reasoning `high`. Unlike [the previous comparison](comparison.md), no Pi-versus-OMP API-host gap remains. This is observed request parity, not a claim about undisclosed server-side model versions.

**Readiness incident disclosure:** before credential isolation was fixed, OMP startup automatically disabled unrelated global Anthropic credential rows 21/22. Thus the initial readiness pilot violated the intended no-global-credential-mutation condition. No manual modification/restoration was performed. The full runner now uses private read-only-source SQLite snapshots; a separate readiness rerun verified the global credential hash stayed unchanged. See [pilot-dispositions.json](../results/compare/bench3-pilot-2026-10-02/pilot-dispositions.json). This incident is not hidden by the corrected pilot's passing table.

## Method and arms

The fixed 20 existing tasks (`a1`–`c6`, explicit IDs in `src/eval/bench-stats.ts`) plus eight new `d*` tasks are used; no external benchmark is included. All repositories are zero-dependency Node ESM and use `node --test`. Instruction language means natural-language instructions, not source language; the new tasks include two Korean instructions. Each execution receives the same `task.json` instruction, model/effort and freshly prepared Git workspace. Only `repo/` is copied by `prepareTaskWorkspace`; hidden tests, references, rubrics and graders stay outside solver workspaces. This is workspace isolation, not a filesystem-security sandbox.

| Arm | Invocation path / treatment |
|---|---|
| `pi-solo` | Pi **1.0.0** CLI main session, native default system prompt and native default `read`, `bash`, `edit`, `write` tools; no extension or orchestration. |
| `pi-orche` | Identical Pi CLI invocation plus this repo's `src/extension/index.ts`; private `orche.config.json` sets `mainMode: auto`; exposes `orche_task`/`orche_run`. The extension's ordinary policy removes main-session write tools and delegates work; workers/coordinator have their usual prompts/tools. No orchestration behavior was tuned for this benchmark. |
| `omp` | Full installed OMP **18.4.4** CLI with native om-orche plugin from `/home/arthur/Code/oh-my-omp-plugins/om-orche`, normal product prompt/resources, all-role model overlay, workspace-local plugin overrides. |
| `pi-orche-direct` | Optional legacy SDK `runOrchestrated()` runner, bypassing Pi's product main session; **not part of the 252-run comparison**. Legacy `--systems pi` aliases this arm, not `pi-orche`. |

Both Pi main arms disable discovered extensions, skills, prompt templates and context files to avoid global/workspace prompt contamination; only `pi-orche` loads the explicitly named extension. The comparison therefore measures isolated Pi versus Pi+extension, and the installed OMP product configuration, not an identical-tool/prompt ablation across products. Pi advisors are disabled; OMP's native advisor/auditor calls remain enabled, pinned to the same model/effort, and counted.

Every explicit Pi role/route (coordinator, explorer-path, explorer-cause, explorer-repro, verifier, implementer, answer and default) is `openai-codex/gpt-6.1-sol/high`. OMP sets every discovered model role plus default/task/smol/slow/plan/advisor/orche-advisor/verification-auditor/vision/commit/tiny/memory/image/web/speech/dictation/judge to `openai-codex/gpt-6.1-sol:high`, `modelFallback: false`, with empty fallback chains. All arms use SSE (`PI_CODEX_WEBSOCKET=0`; Pi's runtime transport is explicitly `sse`). Provider guards reject other models; parity violations invalidate success.

### Exact solver invocations

Placeholders denote the per-run absolute artifact/workspace paths and the literal task instruction; every actual argv is saved in `meta.json`. Commands execute in the prepared workspace.

```sh
# Common Pi main argv; pi-solo omits ONLY the --extension pair below.
PI_CODING_AGENT_DIR=<private-pi-overlay> PI_CODEX_WEBSOCKET=0 PI_OFFLINE=1 \
COMPARE_TRACE_FILE=<run>/provider-requests.jsonl \
node --import <run>/provider-observer.mjs \
  <repo>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --print --mode json --provider openai-codex --model gpt-6.1-sol \
  --thinking high --session-dir <run>/sessions --offline --no-approve \
  --no-extensions --no-skills --no-prompt-templates --no-context-files \
  --extension <repo>/src/extension/index.ts -- <instruction>

PI_CODING_AGENT_DIR=<private-omp-overlay> PI_CODEX_WEBSOCKET=0 \
COMPARE_TRACE_FILE=<run>/provider-requests.jsonl \
bun --preload <run>/provider-observer.mjs /home/arthur/.bun/bin/omp \
  -p <instruction> --cwd <workspace> --model openai-codex/gpt-6.1-sol \
  --thinking high --config <run>/overlay.json --session-dir <run>/sessions \
  --no-title --approval-mode yolo --mode json --max-time <task.timeoutSec>

# Optional direct SDK arm (runner-input.json selects identical Codex/high routes).
npx tsx src/eval/pi-runner.ts --child <run>/runner-input.json \
  --result <run>/runner-result.json
# Select through the harness, outside the full benchmark directory:
npx tsx src/eval/compare.ts --tasks a1-rounding --systems pi-orche-direct \
  --repeats 1 --concurrency 1 --out <separate-out-dir>
```

Private Pi overlays obtain Codex OAuth via a read-only copy from Pi auth or enabled OMP SQLite credentials, with permissions 0700/0600; refresh writes stay temporary. OMP snapshots its auth/catalog SQLite database via read-only source backup and retains native config, APPEND_SYSTEM, MCP, extensions and skills. Secrets are not written to result artifacts; temporary overlays are cleaned up normally. OMP's project overrides enable om-orche, disable omp-daybreak-delegate and disable telemetry. `isolation.json` records before/after global config/plugin/credential fingerprints.

Success requires `status=done`, every enabled grading check passing, and valid observed provider parity. Completion and grading are distinct: a timeout remains a failure even when its saved patch passes tests. Existing tasks retain visible/hidden tests, custom graders, mustNotModify checks and blind all-required-item rubrics. The rubric judge uses Codex/high but writes separate `judge-requests.jsonl`/`judge-usage.json`; **judge usage is excluded from system totals**.

Task deadlines are fixed, with Pi activity-aware extensions disabled (`maxExtensions=0`). Pi main outer timeout is `timeoutSec`; OMP has `--max-time timeoutSec` plus a 30-second outer process-group shutdown grace. Driver outer bounds include grading/setup allowance. Wall time measures solver invocation, not workspace preparation or grading; this asymmetry/grace is disclosed rather than treated as identical product timeout semantics.

## Provider-boundary parity evidence

[Comprehensive pilot proof](../results/compare/bench3-pilot-2026-10-02/pilot-proof.json) is derived from `validated/<task>/<system>/r1/provider-requests.jsonl` and `parity.json`, not merely route configuration. A process-local observer captures actual decoded HTTP request model, reasoning effort, endpoint, offered tools, response tool calls and final usage, including coordinator/workers and non-session advisor calls. Pi's runtime `fetch` boundary is instrumented without replacing its default prompt/tools. Request traces never contain authorization headers or credentials.

| Corrected pilot arm | Requests | Observed endpoint | Model / effort | Tools evidence |
|---|---:|---|---|---|
| `pi-solo` | 25 | `https://chatgpt.com/backend-api/codex/responses` | `gpt-6.1-sol` / `high` | Offered/used only `bash, edit, read, write`; **zero `orche_*` offered or used**. |
| `pi-orche` | 117 | Same | Same | Main offers `orche_task, orche_run`; `orche_run` observed; coordinator/worker requests and `report_result`, `send_message`, edits/tests captured. |
| `omp` | 172 | Same | Same | Native `task` and `orche_advisor` offered and used; all native side calls included. |

Concrete evidence:

- `validated/a1-rounding/pi-solo/r1/parity.json`: 9 requests, sole endpoint/model/effort as above; tools offered `bash,edit,read,write`, used `bash,edit,read`, no violations.
- `validated/a1-rounding/pi-orche/r1/parity.json`: 41 requests, same endpoint/model/effort; observed `orche_run` plus worker/coordinator tools, no violations.
- `validated/a1-rounding/omp/r1/parity.json`: 59 requests, same endpoint/model/effort, no violations.
- [Post-isolation OMP readiness proof](../results/compare/bench3-pilot-2026-10-02/isolation-smoke/parity.json): 28 requests, same endpoint/model/high, native task/advisor usage. Its `isolation.json` verifies unchanged global credential hash `e0a7781d5036dad6e23bf7ea3e7009dea5c1fb715b7405e54a1429e810c6f644`.
- First full-run `a1-rounding/pi-solo/r1/parity.json`: 8 requests, same endpoint/model/high, default tools only, no violations.

**Instrumentation intervention:** OMP native cosmetic/task-label requests can omit high reasoning despite `--thinking high`/`--no-title`. The shared observer enforces high before dispatch, safely rewriting only reasoning effort (unsafe/signed payload rewrites are blocked). Corrected pilot: 3 enforced OMP requests, 0 Pi enforced requests, no blocked requests. These calls remain in OMP totals. Endpoint parity is proven for captured requests; default WebSocket performance and uninstrumented product behavior are not measured. Direct-arm parity was not part of this three-arm pilot.

## Repeats, statistics and price assumptions

Systems are interleaved per task, rotating the starting arm by `(taskIndex + repeat - 1) mod 3`; repetitions traverse the entire task list before the next repeat. `bench-manifest.json` preserves all 252 planned jobs and ordering. Layout: `<out>/<task>/<system>/r<repeat>/`, with additional attempts preserved if explicitly rerun. Resume skips any terminal repeat, **including failures**. Failures keep their `FailureClass`: `pi-orche defect`, `harness defect`, `omp-om-orche behavior`, `fixture problem`, or `infrastructure` (coarse existing labels also cover solo task failures).

The first terminal attempt for each planned repeat is the primary observation, never a success-only/latest-success selection. All attempts, including reruns/failures, remain in JSON and all-attempt accounting. System summaries report pass rate, per-task repeats/successes, wall-time statistics, requests, uncached input, output, cacheRead/cacheWrite tokens, unknown-usage counts, estimated cost and total cost/time divided by successful **task executions** (not unique task IDs). No-success denominators are null.

For a task with `n` observed repeats and `s` successes, `pass^k = choose(s,k)/choose(n,k)` for k=1..3; null when fewer than k observations exist. With all three planned repeats, pass^3 is 1 only for 3/3 success. The descriptive plug-in `(s/n)^3` is also saved; it is not the without-replacement estimate. All-k consistency reports the fraction of complete task cells passing every repeat; incomplete cells remain pending.

Paired comparisons are `pi-orche − pi-solo`, `pi-orche − omp`, `omp − pi-solo`. Match repeat indices within each task, average paired differences within that task, then bootstrap **tasks** (not individual repeats) with replacement: 10,000 draws, seed 20261002, percentile 95% intervals. Metrics: pass rate, wall ms, requests, all four token classes and estimated USD. Positive resource/time differences favor the right arm. The reports also break down category and old/new task sets. Partial summaries include only completed records and matched available repeats, with explicit progress; they do not impute missing runs. Small-cell CIs and multiple reported metrics are descriptive, not multiplicity-adjusted significance claims.

Pricing configuration: [src/eval/pricing.json](../src/eval/pricing.json), from the installed Pi 1.0.0 catalog `@earendil-works/pi-ai/dist/providers/data/openai-codex.json`, model `gpt-6.1-sol`, observed 2026-10-02.

| Token class | Assumed USD / million |
|---|---:|
| Uncached input | 2.00 |
| Output | 10.00 |
| Cache read | 0.10 |
| Cache write | 2.50 |

`estimated USD = (2×input + 10×output + 0.1×cacheRead + 2.5×cacheWrite)/1e6`. This is a **flat base-tier API-equivalent resource estimate, not actual OAuth subscription billing or an official price quote**. Long-context premiums above 272,000 input tokens are not modeled. Sent requests without final usage are counted as unknown; their tokens/cost are not fabricated. Reported totals are known lower bounds when unknowns remain; zero known cost does not imply zero actual cost. Judge cost is excluded.

## New harder tasks and mechanical validation

The eight tasks contain 88 visible repo files and 67 hidden named test cases; all have independently testable requirements without a model rubric. They are intended to create opportunities for useful division of labor, not to assume orchestration will win.

| Task | Category / language | Hidden cases | Rationale |
|---|---|---:|---|
| `d1-transactional-outbox` | feature / en | 8 | Atomic storage/service/outbox changes, idempotency, concurrent dispatch and lease fencing require coordinated cross-module work. |
| `d2-keyed-queue` | bugfix / en | 8 | Same-key completion races, rejection recovery, drain fences, closing and service adapters; plausible scheduler/observer decoys require causal diagnosis. |
| `d3-money-migration-ko` | migration / ko | 9 | BigInt/currency migration through arithmetic, codec, invoice, reporting and CLI; exact rounding and large quantities expose incomplete cutovers. |
| `d4-cache-fencing` | bugfix / en | 8 | Stale success/failure generation races, TTL boundary, tuple keys, tenant invalidation and cloning interact across cache/service modules. |
| `d5-streaming-ingest-ko` | robustness / ko | 8 | UTF-8 byte framing, parser error semantics, exact aggregation and atomic CLI behavior can be investigated/tested independently but must compose. |
| `d6-snapshot-pagination` | feature / en | 8 | Signed tuple cursors, tenant/filter binding, storage snapshots and strict HTTP parsing span independent security and consistency requirements. |
| `d7-config-reload` | robustness / en | 9 | Include-DAG validation/merge, immutable snapshots, atomic reload races and live consumers demand agreement on cross-module contracts. |
| `d8-build-graph` | performance / en | 9 | Reverse invalidation, content hashing, singleflight DAG builds, stale-generation fencing and artifact detachment combine performance and concurrency. |

Run `npm run validate:suite`. [Full saved validation output](../results/fixture-validation/validate-suite-2026-10-02.txt) proves hidden tests fail on each untouched repo and pass with reference overlay; visible tests pass on reference; prepared workspaces contain only byte-identical repo files, not hidden/reference paths or extra content. Untouched d1 hidden grading times out after explicit assertion failures; its reference completes cleanly.

```text
loadSuite PASS: 28 schema-valid tasks
VALIDATED d1-transactional-outbox: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d2-keyed-queue: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d3-money-migration-ko: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d4-cache-fencing: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d5-streaming-ingest-ko: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d6-snapshot-pagination: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d7-config-reload: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
VALIDATED d8-build-graph: untouched hidden FAIL; reference hidden+visible PASS; isolation PASS
Fixture validation: 8/8 passed; 0 violations
```

## Smoke pilot results

Corrected pilot command (concurrency 3 while an original pilot job was still running, keeping total global jobs ≤4):

```sh
npx tsx src/eval/compare.ts --tasks a6-typo-message,a1-rounding,d2-keyed-queue \
  --systems pi-solo,pi-orche,omp --repeats 1 --concurrency 3 \
  --out results/compare/bench3-pilot-2026-10-02/validated
```

All **9/9** corrected-cohort runs completed/graded successfully with observed parity. All cacheWrite counts are zero. Full [pilot table](../results/compare/bench3-pilot-2026-10-02/pilot-results.md) and [summary](../results/compare/bench3-pilot-2026-10-02/validated/summary.md).

| Task | Arm | Pass | Wall s | Requests | Known input | Output | Cache read | Unknown requests |
|---|---|---|---:|---:|---:|---:|---:|---:|
| a1-rounding | pi-solo | PASS | 94.45 | 9 | 10,599 | 2,212 | 18,048 | 0 |
| a1-rounding | pi-orche | PASS | 468.79 | 41 | 106,279 | 9,785 | 179,712 | 0 |
| a1-rounding | omp | PASS | 458.16 | 59 | 118,493 | 11,629 | 561,408 | 0 |
| a6-typo-message | pi-solo | PASS | 12.64 | 3 | 3,914 | 113 | 0 | 0 |
| a6-typo-message | pi-orche | PASS | 99.00 | 15 | 34,716 | 1,718 | 13,440 | 0 |
| a6-typo-message | omp † | PASS | 104.77 | 29 | 57,127 | 1,844 | 134,016 | 1 |
| d2-keyed-queue | pi-solo | PASS | 271.94 | 13 | 40,373 | 7,094 | 62,208 | 0 |
| d2-keyed-queue | pi-orche | PASS | 856.32 | 61 | 152,736 | 23,261 | 381,440 | 1 |
| d2-keyed-queue | omp | PASS | 713.04 | 84 | 160,462 | 18,615 | 1,093,120 | 1 |

| Arm | Pass | Mean wall s | Requests total | Estimated USD total |
|---|---:|---:|---:|---:|
| pi-solo | 3/3 | 126.34 | 25 | 0.2120 |
| pi-orche | 3/3 | 474.70 | 117 | 0.9926 |
| omp | 3/3 | 425.32 | 172 | 1.1719 |

These three selected pilot tasks provide readiness/ETA evidence only, not a quality ranking. Solo was cheaper/faster on all three; all passed, so the pilot does not establish an orchestration quality advantage.

### Pilot failures and fixes (all original artifacts retained)

- Initial OMP trials sent **zero** requests because the Pi judge's `PI_CODING_AGENT_DIR` overlay contaminated OMP's shared environment key, losing its model catalog. Classified as diagnosed harness failures, not solver-quality losses. Fixed by subprocess-local overlay activation and environment isolation; original cohort retained in the parent pilot directory.
- † Corrected a6 OMP emitted a legitimate top-level `message:string` diagnostic, rejected by the old parser. Parser regression fixed; saved workspace was graded and saved provider accounting replayed **without a solver rerun** (`--recompute ... --regrade a6-typo-message:omp`). Original terminal metadata/error remain; recovered `done` denotes final assistant-event evidence and saved-workspace grading, not a newly observed exit code.
- The global Anthropic auto-disable incident described prominently above led to private OMP SQLite overlays. Separate **non-comparative** `isolation-smoke/` a6 readiness execution passed grading/parity (28 requests), with unchanged global credential hash; it is not substituted into the corrected cohort's timing table.
- Initial `d2/pi-orche` genuinely timed out at **900.042 s**, despite passing hidden/visible tests (65 requests). That behavioral failure remains preserved and disclosed; no orchestration/scoring change fixed it. The independent corrected cohort's d2 finished at 856.324 s. The parent cohort is not pooled with the corrected readiness cohort or full-run results.

[Disposition evidence](../results/compare/bench3-pilot-2026-10-02/pilot-dispositions.json) supersedes diagnosed provisional harness classifications without rewriting original metadata. Full-run primary repeats retain failures; no successful retry selection is permitted.

## Full launch, monitoring, resume and ETA

Launched from `/home/arthur/Code/oh-my-pi-extensions/orche` on **2026-10-02T15:10:15.731Z**:

```sh
mkdir -p results/compare/bench3-2026-10-02
setsid nohup npx tsx src/eval/compare.ts --tasks all \
  --systems pi-solo,pi-orche,omp --repeats 3 --concurrency 4 \
  --out results/compare/bench3-2026-10-02 \
  > results/compare/bench3-2026-10-02/run.log 2>&1 < /dev/null &
```

- Detached launcher PID / process group / session: **1546235** (reparented to PID 1); benchmark driver PID **1546260**.
- Output: **`results/compare/bench3-2026-10-02/`**; `bench-manifest.json` confirms all 28 IDs, three arms, three repeats, 252 jobs, concurrency 4.
- At the launch check the driver was alive with four pair jobs; no pilot solvers remained. First completed run: **`a1-rounding/pi-solo/r1`**, `done`, visible/hidden grade PASS, parity PASS, **114.516 s / 8 requests**. Its `meta.json`, `grade.json`, `usage.json`, `parity.json`, provider trace, and final workspace are present.
- Log excerpt: `COMPARE_STARTED ... jobs=252 planned=252 concurrency=4`, then `a1-rounding/pi-solo/r1/attempt-1: done; grade=true; sent=8; unknown=0; wall=114516; revision=600eba0dcb2403357943a40708b79330d20b1c1a5e2c460bf7503ddad66263e2`.
- Offline partial summary command was tested successfully (exit 0): `expectedRuns=252`, `completedRepeats=1`, `finished=false`; Markdown explicitly says partial/provisional. [Check log](../results/compare/bench3-2026-10-02/partial-summary-check.log).
- Follow-up health check at **15:18:47Z** confirmed both PIDs alive and partial summary exit 0 with **4/252** complete, all PASS/parity-valid at the same source revision: a1 solo 114.516 s/8 requests, a1 orche 411.704 s/34, a2 solo 100.790 s/8, a2 orche 351.475 s/31. OMP jobs were still in flight. [Saved process/summary/log-tail evidence](../results/compare/bench3-2026-10-02/launch-health.log).

```sh
# Safe monitoring; no solver calls.
ps -p 1546235,1546260 -o pid,ppid,pgid,sid,etimes,args
tail -n 20 results/compare/bench3-2026-10-02/run.log

# Resume ONLY once the previous driver AND all solver descendants have stopped.
# Terminal failed runs are retained/skipped, not replaced.
npx tsx src/eval/compare.ts --tasks all --systems pi-solo,pi-orche,omp \
  --repeats 3 --concurrency 4 --out results/compare/bench3-2026-10-02 --resume
# For another detached launch, wrap that command with setsid nohup and APPEND (>>)
# to run.log. Never run two drivers on the same output at once.

# Offline, works during execution and after completion; writes summary.json/.md.
npx tsx src/eval/compare.ts --summary --out results/compare/bench3-2026-10-02
```

ETA from corrected pilot: mean per run **342.123 s** × 252 / 4 = **21,553.77 s = 5.99 h**. Plan **6–9 h** after launch (roughly 21:10Z on Oct 2 to 00:10Z on Oct 3), not a deadline guarantee. Only one new task was piloted, one task was trivial, grading/setup are excluded from the mean, and provider latency/caching/rate limits may lengthen execution. Unit verification ran alongside the launch and can slightly affect early host latency.

## Chunked execution

Run bounded chunks in the foreground, only after the previous driver and its descendants have drained:

```sh
set -o pipefail
npx tsx src/eval/compare.ts --tasks all --systems pi-solo,pi-orche,omp \
  --repeats 3 --out results/compare/bench3-2026-10-02 \
  --resume --max-minutes 15 --max-jobs 16 --concurrency 4 \
  2>&1 | tee -a results/compare/bench3-2026-10-02/run.log
```

Keep `--tasks all --systems pi-solo,pi-orche,omp --repeats 3` unchanged: chunk limits are invocation-only, never manifest settings. The driver launches at most 16 new jobs in the existing schedule order and stops launching after 15 minutes from invocation start, whichever comes first. In-flight runs finish and save normally; resume skips terminal failures too. Without either limit, execution remains unbounded over the planned schedule. `--max-jobs 0` permits a no-launch progress refresh.

Worst-case solver wall budget is **15 min + longest single run** (`timeoutSec` up to 900 s + 30 s grace), approximately **31 min**. Workspace preparation, grading and final artifact/summary writes add overhead; the driver’s outer pair bound includes grading allowances, so 31 min is not a strict whole-process deadline. SIGTERM/SIGINT sent to the driver alone also stop scheduling and drain; do not signal its process group.

At exit, reports are refreshed and one machine-readable line is printed:
`COMPARE_CHUNK_DONE launched=X completed=Y remaining=Z failed=F infra=I`.
Launched/completed/failed/infra refer to this invocation (failed includes grading or parity failures); remaining counts planned repeats without any terminal record, not missing successes or queued reruns.

Check cumulative progress without solver calls:

```sh
npx tsx src/eval/compare.ts --summary --out results/compare/bench3-2026-10-02
```

Read `progress.completedRepeats` / `progress.expectedRuns` in `summary.json`, or the completed-repeat count in `summary.md`. Repeat the foreground chunk command until **252/252**; never run two drivers against this output simultaneously.


## Verification and open risks

Final check on this tree: **`npm run typecheck` clean (exit 0); `npm test` 1,814 passed, 1 skipped, 83 passing files (exit 0)**. [Final verification log](../results/compare/bench3-2026-10-02/final-verification.log), 2026-10-02T15:10:53Z–15:12:33Z. New unit coverage includes arm selection/legacy aliasing, rotating repeat schedule, resume failure retention, deterministic bootstrap/pass^k/cost, parser recovery and private OMP SQLite isolation. Fixture validation was performed separately as linked above.

Open risks/limitations:

- In-repo synthetic tasks and graders/reference solutions share authorship; 8 harder tasks reduce but do not guarantee removal of the old suite's ceiling effect. Three repeats estimate consistency only coarsely; categories/languages have small cells.
- Same observed host/model/effort is a stronger control than the previous run, but does not remove native prompt/tool/advisor/resource/runtime differences, server-side drift, shared warm caches or concurrent-provider effects. This is a system comparison, not a pure orchestrator-only causal estimate across OMP/Pi.
- Unknown-token requests and unmodeled long-context premiums make cost a lower-bound resource proxy, not billing. Aborted side calls still consume resources. Failed early runs can look fast/cheap because they did less work; report success and time/cost per success together.
- Pi d2 approached its deadline and an initial trial timed out; larger new tasks may expose genuine completion failures. All full-run failures stay counted/classified; behavioral changes to improve scores are out of scope.
- The initial unintended global credential side effect remains a disclosed non-goal violation in readiness. Private overlays prevent known startup writes; OMP per-run before/after fingerprints test continued isolation. OAuth refresh/provider availability may still fail or drift during the multi-hour run.
- Workspace-hidden-data isolation is mechanically checked, not OS access control. A solver with shell access could technically access other host paths; no result here proves adversarial secrecy.
- Abrupt process-group termination can leave private temporary credentials until host cleanup; don't inspect or publish them. Resume requires no remaining old solver descendants, unchanged source/fixtures and stable product/provider versions to avoid mixed-revision contamination.
- SSE forcing and high-effort cosmetic-call enforcement change transport/default side-call behavior; conclusions do not apply directly to uninstrumented WebSocket runs. OMP's shutdown grace differs from Pi's hard process timeout.
- Partial completion order overrepresents short early tasks/arms. A partial report is operational evidence only; do not interpret its CIs/pass rate as final results.

## Final results — PENDING (placeholder)

**No final quality/speed/cost ranking is claimed yet.** The full-run driver updates reports on completion; the offline summary command above can regenerate them at any time. The canonical generated analysis is [summary.md](../results/compare/bench3-2026-10-02/summary.md) / [summary.json](../results/compare/bench3-2026-10-02/summary.json); the summary command does **not** rewrite this method document.

Once `progress.finished=true` and `completedRepeats=252`, write the final narrative here (or a separately linked report), including:

1. Three-arm pass rates, all-3 consistency and per-task success counts; all failure classes/dispositions.
2. Wall time, requests, input/output/cacheRead/cacheWrite, unknown usage, estimated cost, cost/time per successful execution.
3. All three paired task-bootstrap comparisons with 95% CIs; category and old/new breakdowns.
4. Observed parity across the complete provider traces, enforcement/blocked counts, global-state isolation evidence and revision stability.
5. Conclusions limited to this suite/configuration, with failures and caveats retained rather than replacing the primary repeats.
