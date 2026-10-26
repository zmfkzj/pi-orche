# MDSD — Multi-Dimensional Search Diversification (opt-in search policy)

MDSD is an orche orchestration mode for intellectual exploration of any kind: cause analysis, solution search, technology choice,
design, research and idea generation.

- **What it diversifies:** the search paths, not the outputs.
- **What stays fixed:** one common objective and the mandatory constraints.
- **How explorers differ:** in ① problem interpretation, ② hypothesis space, ③ information sources, ④ reasoning method, ⑤ search direction and ⑥ validation criteria.
- **Operators:** six combinable operators, EXPAND, DECOMPOSE, INVERT, TRANSFER, CHALLENGE and VALIDATE.
- **Default modes:** `single`, `strong` and `ultra` are unchanged. MDSD runs only when it is selected.

## Use

- **One request:** `/orche mdsd <PROMPT>`. The prompt is taken verbatim, as with `/orche strong`, and the session's mode stays as it is.
- **Session mode:** `/orche mode mdsd`, or `"mainMode": "mdsd"` in `orche.config.json`.
- **Models:** the strong tiers (`models.strong-orchestrator`, `models.strong-worker`), exactly as for strong and ultra. Sub-workers inherit the orchestrator's model.
- **Bounds:** optional `"mdsd": { maxRounds, explorer, explorerMax, total, reserve, final, wrapUpAt, hardStopAt }` in `orche.config.json`, defined in `src/orchestrator/mdsd-config.ts`.

Defaults of the bounds:

| Setting | Default |
|---|---|
| `maxRounds` | 3 search rounds |
| `explorer` (each sub-worker) | 40 requests, 25 min, $6, 120k output tokens |
| `explorerMax` (most a strategy may set) | 120 requests, 60 min, $25, 400k output tokens |
| `total` (the whole assignment) | $80, 600 requests |
| `reserve` | search rounds may admit up to 70% of `total` |
| `final` | other stages may admit up to 90%; the last 10% is the final-report allowance |
| `wrapUpAt` | wrap-up notice at 80% of an allocation |
| `hardStopAt` | stop at 125% of an allocation |

These are practical limits, not tuned or validated values. The `max_tokens: 20000` in the methodology's example is an example only. A strategy can set its own `budget` within `explorerMax`.

## Flow (one orche_task assignment)

0. **Decide whether diversification pays.** The orchestrator decides this first. A clear, easily checked task stays a **single path**: no search round, and `data.mdsd.decision: "single-path"`.
1. **Plan and independent exploration.** The orchestrator calls `orche_spawn` with reason `"search"`.
   - The call carries a `plan {objective, constraints, success, rationale}` and two or more read-only explorers (role `answer`).
   - Each explorer has a `strategy {framing, operators, hypothesis_space, evidence_scope, method, reasoning, direction, validation, budget?}`.
   - The runtime puts a brief in front of each explorer's request: the objective and constraints verbatim, the strategy, the budget and the output contract.
   - The output contract is: findings, evidence, counter_evidence, uncertainty, explored_scope, unexplored_scope, sources_used and procedures.
2. **Integration.** The spawn result lists:
   - every finding (`F…`, with the explorer ref `W….:f…`);
   - heuristic candidates for duplicates (`D…`), conflicts (`C…`) and gaps (`G…`);
   - the measured redundancy and the new files of each explorer.

   Tool results above 12,000 characters are clipped. The complete round data is therefore written to `<scratch>/mdsd-<worker>-round-<n>.md` and `.json`. It holds every finding with its evidence, counter-evidence and uncertainty, the scopes, sources, procedures and footprints, and the partial text of explorers that did not report.
3. **Adaptive selection, only when it pays.** Reason `"search"` again, with `adapt {basis: [F/D/C/G ids], reason}`.
   - Each strategy is either `purpose: "exploit"` (with `targets`) or `purpose: "explore"` (new hypotheses or sources).
   - A round of two or more strategies keeps at least one explore strategy, so that an early explanation is not just amplified.
   - The search stops when it is sufficient, has stalled, reaches the round cap or runs out of budget.
4. **Verification and judgment, separate from the search.** The orchestrator uses its own checks (`[orche ref Tn]`) or fresh verifiers (reason `"verification"`, under the normal cap). The report carries `data.mdsd`; its format is `REPORT_FORMAT` in `src/orchestrator/mdsd.ts`.

## Budget control across all stages

- **Admission.** An `orche_spawn` call of any reason (search, verification, parallelism, isolation) is admitted only if the following sum fits the stage's share of `mdsd.total`: what every stage has spent so far, plus the worst case of the sub-workers still running, plus the worst case of the new ones.
  - Search rounds get up to `1 - reserve` of the total. Every other stage gets up to `1 - final`.
  - A sub-worker's worst case is its allocation × `hardStopAt`. For requests it is rounded up and adds `REPORT_EXEMPTIONS` (2) report responses.
  - A worker's allocation is reserved when it is prepared and released when it finishes.
  - A refusal states the figures and the way out: smaller strategies, or a report with `stop.reason "budget"`.
- **Per session** (explorers, verifiers and implementers in mdsd mode):
  - The figures are checked after every response: requests, list-price cost, output tokens and time.
  - At `wrapUpAt` the session gets one wrap-up notice, worded for its role.
  - At `hardStopAt` the session is cancelled explicitly. A response that calls the report tool is let through at most twice: a report, and one retry after an invalid one.
  - A timer also checks the time dimension and cancels a response in flight.
- **The orchestrator itself:**
  - At `1 - final` of the total it gets a notice: no further stage is admitted, and it should report now.
  - At the total its turn is stopped and it gets one forced report prompt (`AgentManager.budgetAction`, the request budget's ladder).
  - That report may leave explorer findings unaccounted. The gate allows this and records the number, so that the result stays usable.
  - If no report comes within 5 more requests, the assignment fails with its MDSD lines and round files.
- **Measured but not bounded in advance:**
  - the response that crosses a line (its cost and tokens are known only after it);
  - the report responses let through after a stop;
  - the forced report.

  The run's summary records them as `overTotal`.
- **Unknown usage is never counted as zero.** A response cancelled in flight (by a budget stop, the caller, a deadline or the turn cap) is marked `inFlightUnknown`. An orchestrator response without a reported cost counts in `unpricedResponses`.
- **What `mdsd.total` does not cover:**
  - main's own requests;
  - other orche_task assignments;
  - helpers outside the assignment, such as the Bash review classifier.

  These are measured outside: the benchmark harness prices every request at its proxy.

## What the runtime enforces and what the model judges

**Enforced by the runtime** (`src/orchestrator/mdsd.ts`, `spawn.ts`, `sub-worker.ts`, `specialists/session.ts`, `agent/agent-manager.ts`):

- strategy and plan schemas;
- the plan's objective and constraints stay fixed for the run (a change is refused as task drift);
- the first round needs two or more strategies;
- **label-only diversity is refused**: the same operators, direction, reasoning and validation *and* a token overlap ≥ 0.5 of both the hypothesis spaces and the evidence scopes;
- adaptive rounds need a basis of known ids, exploit targets and an exploration share;
- explorers are read-only;
- the explorers' output contract;
- the budgets above;
- the report gate:
  - every explorer finding is kept in a final finding's provenance or dropped with a reason;
  - confirmed or refuted findings cite real `[orche ref Tn]` calls or a verifier id (agreement between explorers is not proof);
  - disputed findings name their dissent;
  - the objective is unchanged;
  - `single-path` or `diversified` must match what ran.

**Measured from the tool calls, independently of the explorers' own reports:**

- each explorer's files read (with ranges), searches and commands;
- pairwise file overlap per round (redundancy);
- files new to the run and files no sibling read (new information);
- declared vs. touched evidence scope;
- allocated vs. actual requests, cost, time and output tokens, with overshoot;
- the orchestrator's usage per phase (planning, search-n, integration-n, verification-n);
- first-round vs. adaptive provenance of the final findings.

**Judged by the model** (prompt guidance, not enforcement):

- whether diversification pays and which operators fit;
- the semantic quality of the strategies;
- merging duplicates and resolving conflicts.

**Disclosed heuristics:**

- Duplicates: the same file and nearby lines (±15), or a claim token overlap ≥ 0.45.
- Conflicts: duplicate groups with mixed low and high uncertainty, or with counter-evidence.
- Gaps: unexplored-scope items. A gap is "possibly covered" when another explorer's explored scope overlaps it by ≥ 0.5, or when that explorer read a file the gap names.
- Novelty of an explore strategy: a token overlap < 0.5 with every earlier item.
- Lexical checks cannot detect semantic duplicates written in entirely different words.
- `Utility − λ·Redundancy − μ·Cost` is the stated design objective only. The runtime computes no utility and no weighted score.

## Examples beyond bugs

The unit tests (`test/orchestrator/mdsd.test.ts`) use:

- **a technology choice:** INVERT from the requirements vs. CHALLENGE + VALIDATE against the favourite;
- **product ideation:** EXPAND unmet needs vs. TRANSFER + EXPAND from other domains;
- **a research survey:** DECOMPOSE + VALIDATE by re-running evaluation code vs. INVERT + CHALLENGE on the ablations;
- **a single-path configuration change.**

The WorkerPool end-to-end test (`test/extension/mdsd-e2e.test.ts`) runs a style-guide judgment through a one-shot `mdsd` request. It covers:

- two diversified paths and one path stopped by its budget;
- an adaptive round on the aggregation ids;
- a verifier;
- a rejected report, then an accepted one;
- the next plain request without the MDSD tool set;
- aggregate exhaustion: every stage refused, the orchestrator stopped, a forced report accepted;
- cancellation.

## Experiment settings: cross-model replication and explorer scratch

Two `mdsd` settings exist for experiments only. Neither is set by default, and without them nothing changes.

- **`mdsd.replication`:** `{ models: [{ model, thinking? }, …], round?: { plan, workers } }`, with 2–4 distinct `provider/modelId` routes. Every search strategy runs once per listed model.
  - The strategies first pass the same plan and schema checks, and the same label-only duplicate check, as any round. One strategy listed twice is still refused.
  - Only then is each strategy fanned out to one cell per model. All cells of a strategy get the same brief, request and allocation, each on its own route. Thinking comes from the route, else from the orchestrator.
  - Admission and the per-call cap count every cell. Three strategies on two models are 6 workers, each at its allocation × `hardStopAt` + 2 report responses.
  - The cells of one strategy share its id as `group`. The summary counts strategies and cells apart (`replication: { models, cells, pinned }`), and a replicate is never counted as a new path.
  - A model the runtime does not have fails the assignment before any model call. No other model is substituted.
  - Verifiers still inherit the orchestrator's model.
- **`round`:** pins the first search call. The orchestrator calls `orche_spawn` with the pinned worker names in order, each with request `"pinned"`, and the runtime runs the recorded plan, requests and strategies verbatim.
  - The pin is checked when the run starts: schemas, two or more strategies, label-only duplicates, cells within the cap.
  - It is never edited to pass admission.
- **`mdsd.explorerScratch: true`:** gives every search explorer a private 0700 scratch directory next to the orchestrator's (`<base>/<session>/<id>`).
  - The directory is added to the explorer's write roots as `kind: "scratch"` and named in its prompt.
  - Writes there pass the same real-path check as any write. The workspace, a sibling's scratch and symlink escapes stay blocked.
  - Mode 0700 does not separate processes of the same user, so an experiment audits cross-cell access.
- **Round record:** `mdsd-<orchestrator>-round-<n>.json` and `.md` are written in the orchestrator's scratch.
  - The `search-end` event names both files (`file`, `json`) and carries the JSON's sha256.
  - orche removes the orchestrator's scratch when its assignment ends, and its record writer may keep only a stub of a large `search-end` event. An experiment therefore copies the files while the run is live (`experiments/mdsd-ab/matrix.ts`).

- **`mdsd.seed`:** `{ claims: [{ ref: "P1:c3", claim, quote?, locations?, requirements?, stance? }] }`, with 1–400 claims under unique namespaced refs. It registers the claims of earlier, frozen analyses as round-0 findings in the run's aggregation.
  - **Accounting is enforced.** The report gate requires every registered claim to be kept in a final finding's provenance or dropped with a reason. A confirmed or refuted status still needs the orchestrator's own tool-call evidence or a verifier's.
  - **The first search round is a follow-up.** It runs under the adaptive rules: `adapt.basis` cites registered claim ids or aggregation ids, and exploit strategies target them. The gate refuses a seeded run without a search round.
  - **Not enforced:** whether a dropped or corrected claim was right. That is for an evaluation to judge.
  - The quality validation of the strong-preserving workflow uses this setting (`experiments/mdsd-ab/quality.ts`).

Run r2 of the MDSD benchmark uses `replication` and `explorerScratch` ([mdsd-ab-bench.md](mdsd-ab-bench.md)). The quality validation uses `seed`.

## Evidence status

- Deterministic tests with faux models show that the mechanics work as specified. They do not show that MDSD finds more or better results.
- The real-model comparison with `/orche strong` on one historical case is documented in [mdsd-ab-bench.md](mdsd-ab-bench.md). It is a single paired run and does not generalize.
