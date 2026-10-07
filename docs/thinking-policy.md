# Task DAG thinking policy (`thinkingPolicy`)

Status: implemented 2026-10-08, **off by default** (`"fixed"`). Opt in with `"thinkingPolicy": "phase"`. Real-model quality is
**not measured yet** (see Evaluation).

## Purpose

Quality first, not cost. Long reasoning that runs into the per-response output limit loses the whole answer: in the observed
sessions (docs/length-recovery.md) Claude Opus at xhigh/max spent all 32000 output tokens of a response on reasoning, with no text
and no tool call, while the context was 30–60k tokens of a 1M window. The policy tries to keep every judgement that decides
correctness at the effort the user chose, while it:

- keeps each response's reasoning small: a decomposed Task DAG, one running node, short checkpoints instead of re-deriving earlier
  steps;
- runs ordinary steps one effort level lower;
- on an overrun, shrinks the scope (split the node) instead of lowering the effort further.

Token savings are not a goal and not a success criterion.

Two different limits, handled separately:

| limit | what fills it | handled by |
|---|---|---|
| per-response output (observed: 32000, applied behind the request: the cliproxyapi path sends no `max_output_tokens`; where exactly it is applied is **unverified**) | one response's reasoning and text | this policy (smaller nodes, checkpoints, step effort) and the output-limit recovery (src/pi/length-recovery.ts) |
| context window (cumulative) | the conversation | Pi's compaction: a provider overflow error, or a length stop with the context at ≥85% of the window (or within 16k of it), still goes to Pi's compact-and-retry (`underContextPressure`), unchanged |

How the proxy maps `reasoning.effort` to Claude's effort is **unverified** too. The worker sends only the level name
(pi-ai `openai-codex-responses`: `reasoning: { effort, summary: "auto" }`).

## Levels

- **B** (baseline): the assignment's level after route, `models` tier and main inheritance are resolved, as Pi runs it on the
  model (clamped). It is fixed at the assignment start.
- **S** (step): the highest level the model supports below B, never `off`. It is computed once from B. With no such level
  S = B and the policy never changes the level.
- S is never derived from the current level, so it cannot drift lower node after node.

Supported levels come from the model's `thinkingLevelMap` (`getAvailableThinkingLevels`). Examples from the user's catalog:

| model | B → S |
|---|---|
| claude-opus-5-5, claude-sonnet-5-5, gpt-6-astra (low…max) | max → xhigh, xhigh → high, high → medium, medium → low, low → low (none below) |
| claude-opus-4-6 (no xhigh) | max → high |
| gemini-3.1-flash-image (minimal, high) | high → minimal |

A level change applies from the **next** request. Pi reads the session's level per request
(`agent-session.js` `prepareNextTurn`). Nothing can change the effort inside one response.

## Phase rules (`mode: "phase"`)

| situation | level |
|---|---|
| assignment start, analysis, the first plan (no plan yet) | B |
| an ordinary node running | S |
| between two ordinary nodes (none running, the next ready one is ordinary, and the session was at S) | S (no switch back and forth) |
| a node with `phase: "integrate"` running (requirement comparison, final verification) | B |
| a node with `hard: true` running (design decision, root cause of an unclear failure, concurrency/security, ambiguous requirement, hard-to-reverse change) | B |
| rework: a node reopened after done/blocked/skipped, or whose checkpoint says `verification: "failed"` (escalated for the rest of the assignment) | B |
| the parts of a node that ran at B and was split | B |
| no node running and the next one needs B, or nothing left (integration, report) | B |
| a rejected `task_plan` call, or a message from main (`orche_task_message`) | B until the next accepted plan |
| the report phase: from the first `report_result` call (one written below B is sent back), or a report prompt of the runtime (request budget, exhausted output-limit recovery, missing-result nudge) | B for every further request of the assignment, whatever the plan says |
| the assignment ends (success, failure, cancel, timeout) | back to B; the next assignment starts again from its own B |

`escalation: false` drops the hard/rework rows (the plain S/B split, arm b below).

## Checkpoints (`checkpoints: true`)

On in `"phase"` (default `checkpoints: true`) and when set explicitly (`{ "mode": "fixed", "checkpoints": true }`, arm d). Off in
`"fixed"` (the default) and in `{ "mode": "phase", "checkpoints": false }` (arm b): there `task_plan` accepts plans in the format
from before this policy (no `phase`, `hard` or `checkpoint` fields; a node marked done without a checkpoint), as before
(test/extension/thinking-policy.test.ts "pre-policy format", the harness's `legacy_plan` scenario).

With checkpoints on, a node newly marked done needs
`checkpoint: {result, evidence, verification: "passed" | "failed" | "not_applicable", open?}`.

- `result` is one or two sentences (≤300 characters).
- `evidence` is 1–4 items of ≤160 characters (file:line, a command and its outcome).
- `open` holds doubts (≤200 characters).

**Not** the model's reasoning. A checkpoint is due when a node ends, not after every tool call.

Rules enforced by `task_plan` (src/tools/task-plan.ts):

- With checkpoints on: a node newly marked done needs a checkpoint with evidence, and an integration node is done only with
  `verification: "passed"`.
- In every mode: a node whose (optional) checkpoint says `verification: "failed"` cannot be marked done. A plan without checkpoints
  never meets this rule, so it changes nothing for the pre-policy format; it only refuses a done node the model itself recorded as
  failed.

A replacement plan keeps what it omits for unchanged nodes: the phase, the hard flag, and the checkpoint while the status is the
same. A reopened node loses its checkpoint. Checkpoints are rendered in the Task DAG that a compaction carries over.

## Runtime guarantees vs. instructions

What the runtime **guarantees** (tests in test/pi/thinking-policy.test.ts, test/extension/thinking-policy.test.ts):

- B and S are computed as above, and S never drifts.
- The phase table above holds for whatever plan the model sends.
- Every assignment starts at its own B. That covers a reused worker, a new main level, a failed, cancelled or timed-out previous
  assignment, and a model switch (S is recomputed for the new model).
- The idle worker returns to B.
- **Report at B** (phase mode). The level of every model request is noted when its response starts (Pi reads the level when it
  prepares the request; nothing changes it while a response streams). A `report_result` whose response ran below B (an
  ordinary step, between steps, a recovery step-down) is never accepted, also when the same response switched the plan to an
  integration node first: the report is discarded (`Result not accepted yet: …`), the report phase starts (B for every further
  request, so a later plan cannot bring the worker back to S), and the model writes the report again in its next request, at B.
  The rewrite is not one of the assignment's result retries (`result_rewrite` event, `details.thinkingPolicy.reportRewrites`).
  It is bounded: a further rewrite after `MAX_REPORT_REWRITES` (2) would mean B could not be applied, and the assignment then
  fails (`Report not accepted: …`) instead of accepting the report (fail-closed).
- **Runtime report prompts run at B** (every mode): the request-budget stop, the exhausted output-limit recovery and the
  missing-result nudge start the report phase before their model request (src/agent/agent-manager.ts; with the fixed policy this
  clears a recovery step-down). Their reports are checked like any other. A request that cannot happen any more (the budget's grace
  requests are used up, a model or process error, a cancel or timeout) ends the assignment as failed or cancelled, never as a
  report accepted at S: a discarded S report is never the result.
- The checkpoint rules above.
- The output-limit recovery limits below.

What depends on the model (**instructions only**):

- marking integration and hard nodes;
- comparing the real changes, diffs and check runs in integration rather than trusting the checkpoints;
- truthful checkpoints and verification values;
- reopening a wrong node;
- making a split a real reduction of scope (the runtime checks only the structure, see below);
- honest reports.

The instructions are in the implement assignment prompt (`thinkingPolicyInstructions`, src/extension/workers.ts), the `task_plan`
tool description and the recovery nudges.

## Output-limit recovery under the policy (`lengthRecovery: "redecompose"`)

1. The first overrun gets a next-step nudge at the same effort, asking for the node's checkpoint when it is finished.
2. The second consecutive overrun asks to split the running node into two or more smaller nodes at the same effort.
   - For an integration node: one verification node per requirement, still at B.
   - Without a plan: one small concrete step, or report what is done and what is not.
3. A split counts (`Re-decomposition accepted`) only when the running node is no longer running and two or more new nodes appear.
   A plan that does not split gets a warning in the `task_plan` result and does not count as progress.
4. The recovery is exhausted, which leads to one forced report and then the explicit `Output limit` failure, when any of these
   happens:
   - 3 consecutive stops;
   - more than 4 stops without Task DAG progress (a newly finished node or an accepted split; a tool call is not progress);
   - more than 8 stops in the assignment;
   - more than 3 accepted splits.

The effort is never lowered by this ladder. The earlier `step-down` ladder (`"thinkingPolicy": "fixed"`, the default) still
lowers the last attempt by one level, now among the levels the model supports (two defects fixed, see docs/length-recovery.md).

## Sub-workers (`subWorkers: true`)

`orche_spawn` sub-workers that inherit the orchestrator's level get levels derived from the orchestrator's B, never from its
current level, so levels never chain:

- standard `implement`/`answer` sub-workers run at S, computed on the sub-worker's own model (`thinkingSource: "orchestrator:step"`);
- `verify` sub-workers (independent verification) run at B.

Sub-workers cannot spawn, so there is no nesting. Exceptions:

- An explicit `models.worker` level, or `"thinking": "main"`, is kept for every sub-worker.
- `game-asset`/`video` keep their own routes.

Integrating the sub-workers' reports happens in the orchestrator's own session under the table above. A standard sub-worker's own
report is written at its level S by design (it is one step's result, integrated and checked by the orchestrator at B); the
report-at-B rule applies to the assignment's final report, i.e. the orchestrator's.

## Configuration

In `~/.pi/agent/orche.config.json` or a trusted project's `.pi/orche.config.json`, read at every `orche_task` call (no reload
needed for a config change):

```json
{ "thinkingPolicy": "phase" }
```

`"fixed"` (default) or `"phase"`, or an object `{ mode, checkpoints?, escalation?, lengthRecovery?, subWorkers? }` whose unset
fields take the mode's defaults:

| arm | value | meaning |
|---|---|---|
| arm | value | levels | checkpoints required | output-limit recovery | report below B |
|---|---|---|---|---|---|
| a | `"fixed"` (default) | B throughout | no (pre-policy plans accepted) | `step-down` | does not occur except a recovery step-down (not checked, as before) |
| b | `{ "mode": "phase", "checkpoints": false, "escalation": false, "lengthRecovery": "step-down", "subWorkers": false }` | S for steps, B for plan/integration/report (the plain S/B split) | no | `step-down` | rewritten at B |
| c | `"phase"` | S/B with hard steps, rework and splits of B work at B; sub-worker levels | yes | `redecompose` | rewritten at B |
| d | `{ "mode": "fixed", "checkpoints": true, "lengthRecovery": "redecompose" }` | B throughout | yes | `redecompose` | does not occur |

How `"fixed"` differs from orche before this policy (all in the direction of not losing work): every assignment starts at its own
level (the old restore could overwrite it), the recovery step-down takes a level the model supports, more than 8 length stops in
one assignment exhaust the recovery (a trivial tool call between overruns no longer resets it forever), runtime report prompts run
at the assignment's level, and a done node whose checkpoint says `failed` is refused. Plans and reports are otherwise accepted as
before.

The result shows the policy in two places:

- the result text: `Thinking policy: phase (baseline high, steps medium): N level switches; at baseline: …`;
- `details.thinkingPolicy` and `run.json` `outcome.thinkingPolicy`.

Every level change is a `thinking_change` event in the record.

## Evaluation

**Comparison harness** (experiments/thinking-policy):

- Command: `npx tsx experiments/thinking-policy/run.ts 2`. It takes a few seconds and makes no network or paid call.
- Output: `results/thinking-policy/bench-<date>.md`/`.json`, gitignored.
- It runs arms a–d on the same task and the same DAG through the real `orche_task` stack (WorkerPool → AgentManager → Pi
  AgentSession) with a scripted faux model.
- The scenario behaviours are **assumptions written into the script**: plain, overrun at B, a hidden error made at S, a premature
  report at S, an integration overrun, a hopeless model, and plans in the pre-policy format (`legacy_plan`).
- It shows that the mechanics do what they claim (results/thinking-policy/bench-2026-10-07.*, regenerated after the report-at-B change; 2 repeats, stable):
  - No arm reported false success.
  - With a hidden error made at S, only c fixed it: the rework ran at B. The plain S/B split (b) ended honestly blocked.
  - A premature report at S (b, c) was discarded and rewritten; every request after it ran at B, and the integration ran.
  - The forced report after an exhausted recovery ran at B in every arm (a and b after a step-down to medium or low).
  - Pre-policy plans: accepted unchanged in a and b; refused once for a missing checkpoint and then completed in c and d. In b and
    c such a plan's unmarked integration node ran at S (marking integration is an instruction, not a guarantee); the report
    itself ran at B.
  - Integration overruns:
    - the step-down arms (a, b) finished the integration at the lower level;
    - the split arms (c, d) finished it at B with one split.
  - Overruns at B:
    - c and d each recovered with one split;
    - a recovered with the step-down (one request at the lower level);
    - b never overran (the step ran at S).
  - On the hopeless model, the split ladder used about 2.25× the output before its explicit failure.
- It is **not** evidence of real-model quality, of how often a real model behaves like any scenario, or of tokens and latency.
  test/pi/thinking-policy-bench.test.ts keeps it running and pins these mechanics.

**Real-model A/B (not run; needs an explicit budget).**

- Tasks: 5–10 real tasks. Include tasks whose transcripts show 32k thinking-only stops at xhigh/max (docs/length-recovery.md), plus
  ordinary tasks to detect regressions.
- Design: fix each task's Task DAG from one baseline run and give it to every arm. Run arms a, b, c and d with 3 or more repeats.
- Primary metrics:
  - correctness: hidden tests or blind review;
  - requirement satisfaction per R-id;
  - false success reports;
  - length-stop rate per request and per task;
  - completion rate;
  - recovery success.
- Secondary metrics: reasoning/output/cache tokens (Pi session JSONL `usage.reasoning` if the proxy reports it, unverified),
  latency, level switches.
- Size: 4 arms × 8 tasks × 3 repeats = 96 assignments, roughly 30–80 requests each (about 3–8k requests).
- How to run it:
  1. Set `thinkingPolicy` per arm in a project `.pi/orche.config.json`.
  2. Drive the tasks with the existing RPC driver (`experiments/workflow/driver.ts`).
  3. Read `run.json` `outcome.thinkingPolicy`, and the `length_stop` and `thinking_change` events, from the records.
- Adopt c (or b) only if correctness and requirement satisfaction are at least those of a and length stops fall. Fewer tokens
  alone is no reason.

## Limits

- The policy acts at `task_plan` boundaries only. A worker that does not keep its DAG current runs at whatever level the last plan
  implied.
- An answer worker without a DAG runs at B throughout.
- Whether the step level really shortens reasoning is not monotonic: pi#9718 reports medium overrunning where high and low did not.
  Neither is it guaranteed: effort is a soft signal to the model.
- Changing the top-level effort between requests may invalidate the provider's prompt cache (Anthropic documents this for
  top-level effort changes). Per-message effort, which keeps the cache, is not available on the cliproxyapi path. This is a cost,
  not a quality, concern.
