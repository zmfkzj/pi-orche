# `/orche strong` vs `/orche mdsd` on the historical ultra snapshot (experiments/mdsd-ab)

## Question

Does the MDSD search policy ([mdsd.md](mdsd.md)) find more of an implementation's real defects than the genuine `/orche strong` path does, on an authentic past task? The comparison holds the model, the effort and the limits fixed.

## Case and inputs

- **Target:** commit `2de1f04` (2026-10-09, "add strong and ultra modes, one-shot /orche strong|ultra"). Each arm gets a fresh single-commit copy made with `git archive`. Its tree is checked against the commit's tree (`015aab9e…`) before and after the run.
- **Task:** read-only defect diagnosis against the original requirements.
  - The prompt is the four pre-snapshot assignments, verbatim (`run.ts` `promptBody`; sha256 in `manifest.json`), with an instruction to report mechanism, file:line, failure scenario, requirement and evidence.
  - Excluded from the input: the post-snapshot independent review, the E2E/verifier request, the later fixes, the current CHANGELOG and every research note.
- **Known answers:** four defects, fixed later in `e7a0891` and `dd98d5b`. They live only in the frozen rubric, which is outside the arms' mounts.

## Conditions, identical for both arms

- **Model and effort:** `cliproxyapi/gpt-6.1-sol` at effort `max` for main, the strong orchestrator and every sub-worker (sub-workers inherit), with `thinkingPolicy: "fixed"`. The proxy log confirms the effective model and effort of every request.
- **Configuration:** the same `orche.config.json` file for both arms. It contains `mdsd`, which strong ignores. The advisor is off and the ledger is off.
- **orche limits:** 60 min per assignment, at most 2 × 15 min extensions, a soft budget of 300 requests.
- **Guards:** a 150-min process guard, and a $40 envelope per arm at the proxy covering every request of the arm, main included.
- **The only difference** is the command word: `/orche strong <PROMPT>` or `/orche mdsd <PROMPT>`.
- **Execution:** both arms run as separate processes started together. Each is timed by its own process from launch to exit; there is no shared barrier.

**Model composition.** The user had earlier named five models (gpt-6-astra, gpt-6.1-sol, claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5 at max). This experiment uses one model for every role:

- A model mix would confound the policy with model diversity, and five fixed paths would contradict MDSD's adaptive selection.
- gpt-6.1-sol was chosen for its cost: about one fifth of gpt-6-astra.
- The user's own `strong-orchestrator` is gpt-6-astra. The result therefore says nothing about gpt-6-astra or about model mixes.

## Isolation

Each arm runs in a bubblewrap mount namespace (`run.ts` `sandboxArgs`):

- the home directory is an empty tmpfs;
- read-only mounts: node (`~/.nvm`), the pi CLI (`~/.bun`), a frozen copy of the CLIProxyAPI provider, the frozen orche runtime (the `src` of this workspace, digest in `runtime/REVISION.json`) and the workspace `node_modules`, with its `.cache`, `.vite` and `.vite-temp` masked;
- private, writable mounts: the arm's own agent dir at `~/.pi/agent`, the target copy at the original path, and its own `/tmp/pi-orche`.

Hidden from the arms by these mounts:

- the workspace with the fixes, the docs and the results;
- orche records and sessions;
- the installed packages (`~/.pi/agent/git`, which contains current orche);
- this experiment's notes and the rubric.

Credentials: only the TypeSafe key, for orche's Bash review, which is enabled as in the user's setup. The CLIProxyAPI key and the proxy URL come from the environment. The provider's stored login was left out because it would bypass the proxy.

Limits of the isolation:

- **Network:** not blocked. The model proxy and TypeSafe need it. It is audited instead: every tool call in every transcript is scanned for the runtime copy, evaluator paths, fetching the repository, and the fix commits.
- **The frozen runtime:** it contains the later fixes and is readable inside the sandbox. It is audited, not hidden.
- **Dependencies:** `node_modules` is the current workspace's (pi 1.3.0), not the snapshot's pins.
- **TypeSafe review calls:** they bypass the proxy envelope.
- **Ignored files:** `git status` without `--ignored` misses spill artifacts that the runtime writes into the target's ignored `.orche/`. Both arms wrote and disclosed them; tracked content was unchanged.

## Pre-registration

`results/mdsd-ab/r1/rubric.md` was frozen before any measured arm ran (sha256 `8684e0d5f1f92a9b0e406918a750f69094b0b09a325023a1987d7e19d0bac6e8`, 2026-10-17T11:03:02Z). It fixes:

- the scoring of the four known defects: mechanism, location and scenario, 0–3 points each;
- symmetric validation of additional findings: V, D, F or U;
- the metrics, the validity rules, and the repetition rule: one pair, and a re-run only for an infrastructure failure;
- the verdict rule.

`run.ts arm` refuses a measured arm without it. The preflight ran on an unrelated toy repository, so that no target output was seen before the freeze.

## Run

```sh
R=/tmp/pi-orche/<session>/W4/mdsd-ab/r1          # private scratch (the arms' private dirs and credentials live here)
node --import tsx experiments/mdsd-ab/run.ts prepare $R
# write and hash the rubric (results/mdsd-ab/r1/rubric.md → $R/rubric.sha256), then:
node --import tsx experiments/mdsd-ab/run.ts arm $R strong --toy & node --import tsx experiments/mdsd-ab/run.ts arm $R mdsd --toy   # preflight
node --import tsx experiments/mdsd-ab/run.ts arm $R strong & node --import tsx experiments/mdsd-ab/run.ts arm $R mdsd                 # measured pair
node --import tsx experiments/mdsd-ab/run.ts summarize $R
```

The evidence of each arm is copied to `results/mdsd-ab/r1/<arm>/` (gitignored), with credentials redacted:

- `meta.json` (commands, timing, audit, target state);
- `events.jsonl`, `wire.jsonl` and `wire.jsonl.totals.json`;
- `records/` and `sessions/`;
- `final-report.json` and `final-text.md`.

The scoring with its evidence is in `results/mdsd-ab/r1/evaluation.md`. A second evaluator rechecked it against the frozen rubric, also not blind (`results/mdsd-ab/r1/audit-w5.md`). The audit reproduced the additional findings of both arms with the arms' recovered probes, using faux providers, no network and no models, and compared them with the pre-assignment commit `b2e27d2`.

## Result of r1 (2026-10-17)

| | strong | mdsd |
|---|---|---|
| Known defects, K score of 12 | 3 (K2) | 6 (K1, K2) |
| Additional findings | 3 V | 2 V, 3 F (out of scope, but reproduced; W5 audit) |
| F (false positives: scope) | 0 | 3: M1, M4, M5, unchanged since `b2e27d2` |
| Wall time | 23.8 min | 40.6 min |
| Requests | 61 | 141 |
| Cost (list price, metered at the proxy; the TypeSafe Bash-review calls are not metered) | $2.58 | $4.77 |

Further facts from the run:

- MDSD ran one search round with three distinct paths and a file-overlap redundancy of 0.21, then two fresh verifiers. It ran no adaptive round.
- The only additional known defect, K1 (dependency directories bypass the fingerprint gates), came from the INVERT+VALIDATE path.
- Neither arm found K3 or K4.

Under the frozen rule the verdict for this case is **supported** (K +3). It is one paired run: MDSD also used 1.85× the cost and 1.7× the time, the gain cannot be separated from the extra compute, and the adaptive part was not exercised. It does not justify making MDSD the default. More cases are needed first; the other tasks extracted from the session history are candidates.

## r2: the r1 strategies × two models (2026-10-18)

Question: within each of r1's three admitted strategies, what changes when the explorer is Claude Sonnet 5.5 instead of GPT 6.1 Sol, both at max? Do the two models complement each other? r2 is not a strong-vs-MDSD comparison; no strong arm ran.

### Protocol

The runner is `experiments/mdsd-ab/matrix.ts`; the records are in `results/mdsd-ab/r2/`.

- **Inputs:**
  - r1's prompt; the sha256 of the one-shot equals r1's.
  - A commit-free snapshot: a fresh repository fetches `2de1f04` at depth 1 and checks it out. No commit is made.
  - The frozen provider, and the frozen runtime with digest `8d735efa…`: r1's `c2af6e14…` plus the replication support.
- **Round:** r1's admitted search call (W1 transcript line 10, equal to events.jsonl:4), verbatim.
  - The only edits replace its four scratch paths with "your scratch directory" (`pinned/substitutions.json`).
  - `matrix.json` keeps the original line, the call, the admission event and the normalized round, with hashes.
- **Cells:** 3 strategies × {`cliproxyapi/gpt-6.1-sol`, `cliproxyapi/claude-sonnet-5-5`} at max.
  - Each cell has r1's allocation: 60 requests, 35 min, $5, and 12k/12k/14k output tokens. Each has a private scratch.
  - Main, the orchestrator and the verifiers run on gpt-6.1-sol/max, as in r1.
- **Bounds:**
  - `mdsd.maxRounds` 1: the matrix is the only search round.
  - `mdsd.total` $60 / 1200 requests, r1's totals doubled; envelope $80; r1's orche limits and guard.
  - The runtime's own admission of the pinned call ran before launch: worst case $37.5 / 462 requests, within the search share of $42 / 840.
- **Route preflight:**
  - One direct `pi` request per model at max. Both passed: request model and effort, Pi's route and thinking, HTTP 200.
  - Then the toy matrix: 2 × 2 cells on a toy repository. All routes were right, with 0 unmatched requests.
- **Records:**
  - The proxy keeps the request-level effort, the `configuration_update` efforts, the original usage numbers and sanitized provider errors.
  - Requests are attributed by `prompt_cache_key`, which equals the transcript's session id.
  - The target is checked on file content hashes.
  - The audit masks each cell's own scratch and own spill, and reports any access to another agent's.
- **Evaluation:** r1's frozen rubric applied to each cell's frozen report, to the unions and to the integrated report (`results/mdsd-ab/r2/evaluation.md`).

### Result (one run)

Details are in `evaluation.md` and `summary-matrix.json`.

| | GPT 6.1 Sol cells | Claude Sonnet 5.5 cells | Integrated |
|---|---|---|---|
| K | 6/12 (K1, K2; both from ultra-contracts) | 0 | 6/12 |
| Registered findings: V / F / U | 5 / 3 / 0 | 0 / 4 / 1 (W1.5 failed: output hard stop at 19,247/12,000) | 6 / 3 / 0 of 11 |
| Requests, list cost | 79, $2.10 | 61, $1.67 | 312, $7.81 (main $0.17, orchestrator $2.05, verifiers $1.82) |
| Work time per cell | 347–423 s | 156–170 s | wall 2746 s |

- **No complementary valid finding came from the Claude cells.** Under r1's token-accounted allocations they were budget-bound; one cell reported a single static read. Model capability and token accounting cannot be separated in this run.
- **Verification:** the orchestrator and its verifiers confirmed all 10 GPT findings, refuted 4 Claude findings, and added one finding of their own (symlink cleanup).


## Quality validation of the strong-preserving workflow (2026-10-18)

Question: with cost removed as a criterion, does the following workflow give a better final answer than the same task's `/orche strong` answer?

1. Keep a fresh `/orche strong` answer frozen as the baseline.
2. Add an independent `/orche mdsd` exploration that never sees the baseline.
3. Account for every claim of both answers with evidence (`mdsd.seed`).
4. Follow up the observed gaps.
5. Verify.

- **Records:**
  - preregistered protocol: `results/quality-validation/protocol.md`, hashed in `manifest.json` before the measured stages;
  - held-out rubric: `results/quality-validation/rubric-isort.md`;
  - runner: `experiments/mdsd-ab/quality.ts`;
  - records and evaluation: `results/quality-validation/`.
- **Cases:**
  - the exposed development case `2de1f04`, 1 pipeline;
  - the held-out isort-2491 diagnosis, 2 independent pipelines.
- **Model:** every role on `cliproxyapi/gpt-6-astra` at max, the user's configured strong tier.
- **Bounds:** no money, request or output ceiling. The bounds are time and rounds only.
- **Evaluation:** origin-blinded claim lists, each scored by two fresh evaluator sessions against the ground truth.

```sh
node --import tsx experiments/mdsd-ab/quality.ts prepare <study>
node --import tsx experiments/mdsd-ab/quality.ts preflight <study>
node --import tsx experiments/mdsd-ab/quality.ts pipeline <study> dev 1      # and: isort 1, isort 2
node --import tsx experiments/mdsd-ab/quality.ts summarize <study>
node --import tsx experiments/mdsd-ab/quality.ts packets <study> <keysDir>
node --import tsx experiments/mdsd-ab/quality.ts refreeze <study> [--apply]   # re-select a frozen report with finalReport
node --import tsx experiments/mdsd-ab/quality.ts extract <study> <unit> <stage>
```

### Result (2026-10-18)

Details: `results/quality-validation/evaluation.md` (English) and `report.md` (Korean).

**Study verdict under the preregistered rule: not supported.** All three pairs are **mixed**, and the two evaluators agree on every pair verdict:

- every pair gained validated findings;
- every pair also lost some baseline-valid content;
- every pair has more out-of-scope (S) claims than the baseline.

No pair is a regression.

| Pair | Known-reference score, S → A | New valid in A | Baseline-valid lost in A | F, S → A |
|---|---|---|---|---|
| isort-r1 (held out) | K-I1 3 → 3; C 5 → 4 (C4 lost) | 2–15 | C4; 2 items partly | 0 → 0 |
| isort-r2 (held out) | K-I1 3 → 3; C 5 → 5 | 16–21 | 1 boundary finding | 1 → 0 (corrected) |
| dev-r1 (exposed) | K 3/12 → 6/12 (K1 added) | 6 defects | 2 correct rejections | 1 → 1 (S's corrected; A has its own) |

- **Preservation.** `mdsd.seed` accounted for every registered claim. In two units every S claim was "kept" in the ledger. Even so, the final prose lost S-valid statements in every pair. Ledger provenance does not guarantee textual preservation; a gate or a separate check on the final text would be needed.
- **Re-freeze.** The first freeze of dev-r1/A took W1's report from a failed task. Main had retried after two provider `cyber_policy` stops. `finalReport` now takes the last completed task's worker, here W2. The corrected pair was frozen and extracted again before it was scored. The first versions are kept.
- **Cost.** Recorded, not a criterion. The workflow cost 5–7× the strong baseline: $59–150 against $9–21 per pipeline. The whole study cost about $350, evaluation included.

