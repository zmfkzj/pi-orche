# Prompt study: does an OMP-style system prompt change pi-orche task success?

This is a descriptive experiment, not a verdict. It measures pi-orche with three different **base system prompts** on a fixed subset of the 20-task suite and reports task success, finer pass fractions, and cost. No other part of the harness changes between arms.

## Arms

| Arm | Base system prompt | File | Bytes | SHA-256 |
|---|---|---|---:|---|
| C0 | Pi default (no `baseSystemPrompt`) | – | 0 | – |
| C1 | Compact "engineering discipline" rules distilled from OMP's prompt; generic, only Pi's three tool-usage notes (read/edit) | `prompts/c1-engineering-discipline.md` | 1776 | `110f4fb3d5b892b951307f338876b9fe73bace41475ec20c3a0e7c517d1453be` |
| C2 | OMP's rendered prompt adapted to pi-orche's tool names; everything not tied to a missing tool is kept | `prompts/c2-omp-derived.md` | 6837 | `113eadf16a86553ebed314f9671953d747631d5b611a0825eb9ab58de1bf6d7b` |

`RunOptions.baseSystemPrompt` replaces Pi's default base prompt for the coordinator and every spawned worker (not the rubric judge; advisors stay disabled). Role instructions are still appended by `createSession`, and Pi still appends the working directory. Consequence worth knowing when reading results: Pi's default base prompt also carries a tool-snippet list, Pi usage rules ("Be concise", "Show file paths clearly") and Pi documentation pointers. A custom base prompt drops all of those (see `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`, `buildSystemPromptSections`); tool *definitions* are still sent in the request's `tools` array, unchanged. So C1/C2 differ from C0 by "prompt content replaced", not by "prompt content added".

### Extraction source (C2)

OMP's main-session system prompt is **not persisted** by the benchmark (main session JSONL has no `session_init`). The `task` sub-agent sessions are: 17 of them contain a `session_init` record with the full rendered `systemPrompt` (`results/compare/full-2026-09-30/*/omp/sessions/*/<Agent>.jsonl`). The first 10,241 characters, up to `§ Role\nWorker agent`, are **byte-identical in all 17** and are OMP's base template render (the sub-agent-specific Role/Context/Coop/Completion sections follow). That base is saved read-only as `results/prompt-study/source/omp-rendered-base.txt` (SHA-256 `966d942b7a3c6732fe946a2f05f3f9ee04c4cd7a2039b0858ec58102ba2c9b06`); the complete worker render is `omp-rendered-task-worker-full.txt` for reference. It matches the installed template `@oh-my-pi/pi-coding-agent/src/prompts/system/system-prompt.md` (read only). The om-orche plugin also injected a "policy" system section into the omp main session; only its hash is recorded (`om-orche-policy-exposure`), its text is not, so it is not part of C2.

C2 adaptation (against that render):
- **Removed** (reference tools or mechanisms pi-orche lacks): Skills & Rules, Internal URLs (`skill://`, `agent://`, `history://`, `artifact://`, `local://`, `proc://`, `ssh://`, `issue://`, `mcp://`, `omp://`), `xd://` tool devices, MCP server/route sections, tool inventory entries `eval`, `glob`, `wait`, `web_search`, `yield`, `review_findings`, `orche_advisor`, `ast_edit`, `debug`, the "`i` intent" tool I/O rule, browser/UI verification bullets, the workstation/model block, and the "read relevant skills first" step.
- **Renamed to pi-orche tools**: `glob` → `find`, `xd://ast_edit` → `ast_rewrite`/`ast_search`, added `ls`, `diagnostics`, `report_result`/`coordinator_decision`/`plan_exploration`/`send_message`; "yield" wording became "report completion". Identity line: "omp's trusted coding assistant" → "a trusted coding assistant".
- **Kept verbatim**: the RFC-2119 preamble, Engineering, General/Specialized-tool policy, Exploration, Workflow 1-6 (Scope → Cleanup), Delivery contract, completeness, evidence-and-output, finishing rules, Critical blocks.

C1 is hand-written from those same rules: scope fidelity, research-before-edit, root cause over symptom, smallest-correct-change/clean cutover, verify-by-running, grounded reporting. ≤2 KB, no OMP-specific tool names.

**Tool-note control.** With a custom base prompt Pi's builder also drops the tools' own `promptGuidelines` (read: "use read, not cat/sed…"; edit: "read before editing; copy anchors verbatim; anchors refer to the last snapshot…"). To keep that guidance constant across arms, both C1 and C2 re-state exactly those three notes (C1 one bullet in Research, C2 a "Tool notes" section). C0 receives them natively. Everything else Pi drops (tool-snippet list, "Be concise", docs pointers) is not re-added: it is part of what "replace the base prompt" means.

Tool names in C2 are those registered by `src/tools/index.ts` (`WORKER_TOOL_NAMES`: read, grep, find, ls, edit, ast_search, ast_rewrite, diagnostics, bash, write; `READ_ONLY_TOOL_NAMES`: read, grep, find, ls, ast_search, diagnostics). Both roles receive the same base prompt, so the inventory is phrased as "a subset of".

## Tasks (8 of 20)

Selection uses `docs/comparison.md`, the saved Pi baseline, and fixture structure. Baseline Pi passed 19/20 (b7 failed; a3 failed its first attempt), so most tasks cannot discriminate arms on pass/fail alone; the subset therefore favours tasks where (a) the baseline was weakest, (b) the instruction has many separately gradeable requirements (more ways to partially fail), or (c) the run is long enough for process discipline to matter.

| Task | Category / repo | Why included |
|---|---|---|
| b7-api-docs | docs / b | Required. Only baseline failure (rubric: omitted partial final page); 6 rubric items give a graded signal. |
| a3-refactor-tax | refactor / a | Only task with a Pi failed first attempt (decomposition/ownership); custom grader + regression-test requirement. |
| a7-auth-rotation | bugfix / a | Subtle concurrency bug; 4 hidden tests (most of any task); 955-char instruction with explicit "do not" constraints; 35 Pi requests. |
| b5-ctx-migration | migration / b | Tied for most Pi requests (35, 344 s); "remove the old signature, no adapter" is exactly OMP's clean-cutover rule. |
| c4-malformed-lines | robustness / c | 3 hidden tests; many edge constraints (blank vs. malformed, exit codes, strict `parseLine`). |
| a2-discount-codes | feature / a | 969-char multi-requirement instruction; 3 hidden tests; tests scope completeness. |
| c5-aggregate-perf | performance / c | Second-slowest c-task Pi run (321 s); hidden perf test; "don't truncate/sample" constraint. |
| b4-router-review | review / b | The one English read-only answer-class task (rubric 3 items, mustNotModify); tests whether a coding prompt harms or helps analysis/reporting. English-only to avoid mixing language with prompt effects. |

Excluded with reason: a1/a6/b2/b6/c2/c6 (baseline passed, 12-20 requests, one clear change or fewer separately gradeable requirements than the chosen features), a4 (custom-only grading), a5/c3 (Korean-language analysis; b4 covers the answer class), b1/b3/c1 (single-hidden-test bugfixes, easy for baseline).

Coverage: repos a:3, b:3, c:2; eight distinct categories; all eight instructions are English (language-controlled; the English prompts are not confounded with Korean replies).

## Metrics

All derived by `results/prompt-study/analyze.ts` from saved `summary.json` / `grade.json` (no model calls):

- **Task pass**: runner status `done` ∧ every enabled grader check passed ∧ captured model/effort valid (identical to `docs/comparison.md`).
- **Hidden-test fraction**: passing *named test cases* / cases in the hidden `node --test` run. `node --test` reports cases, not assertions; assertion-level counts are not recoverable from passing runs, so the case is the finest unit. File-level wrappers (`✔ test/helpers.js`) are not counted. Denominator = the largest case count seen for that task across all analysed runs, so a hidden file that fails to load scores 0 instead of undefined.
- **Hidden unseen-by-solver**: the subset of hidden cases whose names do not appear in the visible run (the ones the solver could not see).
- **Rubric fraction**: satisfied items / items (rubric tasks b7, b4 only).
- **Wall** (`wallClockMs`, runner time excluding judge), **requests** (sent provider requests), **tokens** (known input, output, cacheRead; lower bounds when `unknownUsageRequests > 0`).
- **Variance across N=2**: per (task, arm) mean absolute difference between the two repeats of wall, requests, tokens, and pass disagreements.

Baseline reference: `results/prompt-study/baseline-pi/` and `baseline-omp/` hold the same metrics over the saved 2026-09-30 suite (N=1, different source revisions, old tool set, so context only, never an arm).

## Design controls

- Same model/route (`openai/gpt-6.1-sol`, thinking high), same tools, same advisor setting (disabled), same backend, fresh workspace per run (`prepareTaskWorkspace`), same hidden grader, same judge.
- Arms are **interleaved per task and rotated** (task *i*, repeat *r* starts with arm `(i + r - 1) mod 3`) so provider drift and arm order are not confounded; concurrency 4.
- Each pi run writes `prompt-variant.json` (name, file, SHA-256) and, for every provider request, the SHA-256/length/tool digest of the system text that actually went on the wire plus the system text itself (`system-prompts/<sha>.txt`). `results/prompt-study/verify-arms.ts` checks from those captures that (1) every coordinator/worker request of C1/C2 contains the arm's prompt verbatim and none contains Pi's default preamble, (2) C0 requests all contain Pi's default preamble, (3) the set of tool definitions is identical across arms, (4) model, effort, endpoint are identical.

## Running

```
npx tsx src/eval/compare.ts --study --tasks b7-api-docs,a3-refactor-tax,a7-auth-rotation,b5-ctx-migration,c4-malformed-lines,a2-discount-codes,c5-aggregate-perf,b4-router-review \
  --variants C0,C1,C2 --repeats 2 --concurrency 4 --out results/prompt-study/full
npx tsx results/prompt-study/verify-arms.ts --study results/prompt-study/full --out results/prompt-study/full/arm-verification.json
npx tsx results/prompt-study/analyze.ts --study results/prompt-study/full --out results/prompt-study/full/analysis
```

Layout: `<out>/<arm>/<task>/pi[/attempt-<repeat>]` — every arm directory is a normal comparison directory (`meta.json`, `grade.json`, `usage.json`, `provider-requests.jsonl`, `events.jsonl`, `workspace-final/`, `summary.json`). A single run: `npx tsx src/eval/compare.ts --tasks <id> --systems pi --prompt-variant C2 --out <dir>`.

## Limitations

N=2 per cell, 8 tasks, one model; no significance testing is attempted. Pass/fail has a ceiling effect (baseline 95%). Custom-grader tasks (a3) contribute pass/fail only. Rubric items are judged by a model. C2 is an *adaptation*: removing tool references changes its text, and it was never validated against OMP's own behaviour (OMP runs also use a different backend, advisor, and tools).

## Results (full run, 2026-10-01; descriptive only)

48 pi runs = 8 tasks x {C0,C1,C2} x N=2, concurrency 4, advisor off, source revision `a002a19423ff` for all 48, no infrastructure failures (all 48 `done`, model/effort valid, no HTTP 429/5xx). Artifacts: `results/prompt-study/full/` (per-run dirs, `study-manifest.json`, `completion-events.jsonl`, `arm-verification.json`, `arm-verification-summary.json`, `analysis/{tables.md,runs.json,tool-profiles.json}`); driver log `results/prompt-study/full-driver.log`. Pilot (b7 only, earlier revision `d5ff5e688a65`): `results/prompt-study/pilot/`. Wire re-check of NOTE-first worker sessions: `results/prompt-study/full-b5-wire-recheck/`.

Known data caveats: a7-auth-rotation has 2 unknown-token (aborted) requests in every run of every arm (same as the 2026-09-30 baseline), so a7 token totals are lower bounds. 74 of 1,155 captured requests (all in b5-ctx-migration, one worker session per run, all arms) belong to sessions whose first input items are peer NOTE messages; the 48-run capture only parsed the leading system item, so those requests are not individually verified. The wire re-check (3 fresh b5 runs with capture of all system/developer input items) shows these sessions do carry the arm prompt and the same tool set. The other 1,081 requests were verified individually: 0 wrong.

### Per variant

| Variant | Runs | Task pass | Hidden-test fraction (mean) | Hidden unseen-by-solver fraction | Rubric fraction (mean) | Wall s mean / median | Requests mean | Input mean | Output mean | CacheRead mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | 16 | 16/16 | 1 (n=14) | 34/34 | 1 (n=4) | 275.1 / 264.1 | 22.3 | 41941 | 6047 | 101880 |
| C1 | 16 | 15/16 | 1 (n=14) | 34/34 | 0.958 (n=4) | 364.7 / 319.6 | 25.8 | 47373 | 7625 | 138592 |
| C2 | 16 | 16/16 | 1 (n=14) | 34/34 | 1 (n=4) | 337.1 / 307.2 | 24.1 | 50845 | 7814 | 126040 |

### Variance across repeats

| Variant | Cells with ≥2 reps | Pass disagreements | Mean abs Δ wall s (relative to cell mean) | Mean abs Δ requests (relative) | Mean abs Δ input+output tokens (relative) |
|---|---:|---:|---|---|---|
| C0 | 8 | 0 | 45.6 (17%) | 3 (13%) | 10732.8 (27%) |
| C1 | 8 | 1 | 63.5 (13%) | 2.9 (8%) | 8084.8 (16%) |
| C2 | 8 | 0 | 49.3 (14%) | 3.8 (13%) | 10891.9 (19%) |

### Outcome disagreement between repeats (noise floor)

| Variant | Cells | Pass outcome differs | Failed-check set differs | Hidden count differs | Rubric count differs |
|---|---:|---:|---:|---:|---:|
| C0 | 8 | 0 | 0 | 0 | 0 |
| C1 | 8 | 1 | 1 | 0 | 1 |
| C2 | 8 | 0 | 0 | 0 | 0 |

### Tool usage profile (all runs per arm; counts of assistant tool calls)

| Variant | Runs | ast_rewrite | ast_search | bash | coordinator_decision | diagnostics | edit | find | grep | ls | plan_exploration | read | report_result | send_message | write | edit rejected | of which stale-anchor | other edit errors | other tool errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | 16 | 1 (0.1/run) | 3 (0.2/run) | 113 (7.1/run) | 48 (3/run) | 22 (1.4/run) | 51 (3.2/run) | 30 (1.9/run) | 7 (0.4/run) | 63 (3.9/run) | 2 (0.1/run) | 329 (20.6/run) | 40 (2.5/run) | 31 (1.9/run) | 4 (0.3/run) | 0 | 0 | 0 | 1 |
| C1 | 16 | 0 (0/run) | 8 (0.5/run) | 143 (8.9/run) | 48 (3/run) | 21 (1.3/run) | 49 (3.1/run) | 76 (4.8/run) | 10 (0.6/run) | 48 (3/run) | 2 (0.1/run) | 354 (22.1/run) | 38 (2.4/run) | 31 (1.9/run) | 3 (0.2/run) | 0 | 0 | 0 | 2 |
| C2 | 16 | 0 (0/run) | 17 (1.1/run) | 97 (6.1/run) | 52 (3.3/run) | 19 (1.2/run) | 56 (3.5/run) | 75 (4.7/run) | 7 (0.4/run) | 58 (3.6/run) | 2 (0.1/run) | 323 (20.2/run) | 41 (2.6/run) | 35 (2.2/run) | 3 (0.2/run) | 0 | 0 | 0 | 3 |



Per-task, per-repeat table: `results/prompt-study/full/analysis/tables.md`.

## Decision (Main)

Keep Pi's default base system prompt (C0); do not adopt the replacement prompts C1 or C2. No measured benefit appeared on this subset. C0 passed 16/16, C1 15/16 and C2 16/16, with identical hidden-test counts in every cell. C1's one failure is the b7 `pagination` rubric item. That same item also failed in the 2026-09-30 baseline and in the C2 pilot run, so it is borderline. With N=2, that one cell cannot be attributed to either the prompt or chance. Both variants were slower: +23–33% mean wall time, 1.4–2× the repeat-to-repeat spread. Both also used more tokens. Request counts rose 8–16%, which is within repeat noise. Tool behaviour shifted (more `find` and `ast_search`; C1 also used more `bash`), with no measured outcome change. This is a descriptive result, not a statistical one: N=2, a ceiling-heavy subset, one model, and replacement prompts only. Appending text to Pi's default prompt was not tested. Effects on harder tasks remain open.
