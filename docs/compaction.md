# Worker compaction and state preservation (`workerCompaction`)

Long assignments outgrow their context. orche keeps the task state outside every LLM context and puts it back when a worker
compacts; this page describes when worker sessions compact, what they get back, how the original evidence stays reachable, and
what is recorded. The main session is never changed by these settings.

## What already existed (unchanged defaults)

- Single-workflow `orche_task` workers compact with Pi's native compaction once their context passes **50% of the model window**
  (`taskCompactionSettings`, `src/pi/session-factory.ts`), and the compaction hook restores the verbatim assignment (requirements
  checklist + original request), the live Task DAG with its checkpoints and, with `single.ledger`, the task ledger
  (`renderLedgerForWorker`, `src/single/ledger.ts`) as an `orche:task-essentials` message labelled "superseded by any later
  Assignment message". The assignment projector is reset after every compaction.
- `thinkingPolicy.checkpoints` / `evidence: "strict"` make every finished DAG node carry a checkpoint whose evidence cites real tool
  calls (`src/pi/tool-evidence.ts`); `single.ledger` persists every accepted plan as the resume checkpoint and briefs a new worker
  with the previous worker's transcript path.
- Output-limit stops are not compactions (`src/pi/length-recovery.ts`); real context overflows keep Pi's single compact-and-retry.
- `orche_spawn` sub-workers ran with compaction **disabled**: a long sub-worker that reached the window failed (Pi skips overflow
  recovery when compaction is off).

## `workerCompaction` (orche.config.json, opt-in experiment)

```json
{
  "workerCompaction": {
    "policy": "absolute",
    "triggerTokens": 32000,
    "keepRecentTokens": 8000,
    "roles": { "sub-worker": { "triggerTokens": 48000 } },
    "models": [{ "model": "cliproxyapi/gpt-6-*", "triggerTokens": 32000 }],
    "essentials": "extended",
    "subWorkers": true
  }
}
```

| key | default | meaning |
|---|---|---|
| `policy` | `"window-ratio"` | `window-ratio`: the stable 50% trigger. `absolute`: compact once the context passes `triggerTokens` (per model, then per role, then the base value), **never later** than the stable trigger. |
| `triggerTokens` | — | absolute trigger, ≥ 16384. |
| `keepRecentTokens` | min(20000, trigger/4) | recent tokens kept verbatim; at most half the trigger. |
| `essentials` | `"basic"` | `basic`: what existed (assignment, DAG, ledger). `extended`: also main's messages, the work log and the checked transcript reference (below). |
| `subWorkers` | `false` | standard `orche_spawn` sub-workers (not game-asset/video) compact by the same policy (role `sub-worker`) with their own essentials. |

Only Pi's own compaction settings change (`reserveTokens = window - trigger`, `keepRecentTokens`): Pi's native compaction stays the
single engine, so there is no second compactor and no re-entrancy. The settings are applied at every assignment boundary
(`applyTaskCompaction`). No trigger value is claimed optimal; the evaluation is in `pi-eval-loop/docs/results-ctx-state-1.md`.

**Headroom.** After a compaction the context holds the system prompt and tool schemas (an orche worker: about 7-10k tokens), Pi's
summary, the restored essentials and `keepRecentTokens`; the next response must fit after them. Hence the minimum trigger, the cap
on `keepRecentTokens`, and the loop guard below.

## Preflight and recovery (`createCompactionExtension`)

Before Pi discards anything (`session_before_compact`) orche builds the essentials once and, with extended essentials, checks the
transcript reference: the session must be persisted (records on; an in-memory fallback of `sessionManagerFor` counts as
unavailable), the file must exist and must already hold the last entry about to be summarized. An **early** compaction (absolute
policy below the stable trigger, reason `threshold`) is refused when

- the reference is not valid (`reference_invalid`), or the essentials cannot be built or miss a required section (`essentials_invalid`);
- the previous compaction freed too little or left the context within 15% of the trigger (`loop_guard`);
- the assignment already ran 40 early compactions (`early_limit`).

A refusal records `compaction_cancelled` with its cause and switches the session to the stable 50% policy for the rest of the
assignment (bounded: no retry loop; the next assignment starts afresh). Stable threshold, overflow and manual compactions are never
refused (the context must shrink); their essentials say when the transcript cannot be re-read. After a successful compaction
(`session_compact`) the projector is reset and the essentials are rebuilt; if that fails, the text checked in the preflight is
restored and `essentialsError` is recorded. A failed summary (`session_compact_failed`) is recorded as `compaction_failed`; Pi
keeps the original context. Intentional early compaction (`reason: threshold`, `early: true`), real overflow recovery (`reason:
overflow`) and output-limit recovery (`length_stop`, no compaction) stay distinguishable in the record.

## Extended essentials (`src/pi/compaction-state.ts`)

Built from orche's state, never from a model summary, each part labelled by its authority:

1. **Assignment, verbatim** (required) — the authority.
2. **Messages from main during this assignment** — main's delivered `orche_task_message`s, verbatim, oldest first, with "the later
   one wins where two conflict". Advisor notes, peer notes and undelivered messages are not restored as instructions.
3. **Task DAG** and **task ledger** — as before.
4. **Work log** — from the tool-call ledger: files changed by edit/write/ast_rewrite, commands with ok/FAILED, other calls, and the
   failed calls ("do not repeat an approach unchanged"). Calls are named by their provider tool-call id (unique and stable in the
   transcript; the `T<n>` refs restart every assignment and are never used). Observations, not instructions.
5. **Original evidence** (required) — the worker's own transcript path, the entry after which this assignment's entries start,
   the records retention, and how to re-read selectively (`grep -n CALL_ID FILE`, then read those lines). Past observations are
   looked up, never re-created by re-running side-effecting commands; the current state is re-verified with read-only checks.
   Only the session's own file is named (a sub-worker gets its own; earlier workers of a task come from the ledger briefing), so
   no other task's or verifier's private state is offered.

Retention: worker transcripts live under orche's records (`records.retentionDays`, default 30; never pruned while written within the
last hour). A `records.maxBytes` limit can delete older idle records earlier; the reference is checked at compaction time only.

## Telemetry (run record `events.jsonl`)

- `compaction`: `reason`, `policy`, `triggerTokens`, `early`, `tokensBefore`/`tokensAfter` (Pi estimates), `summaryUsage` (provider
  usage of the summary request), `essentialsChars`, `essentialsSections`, `essentialsMissing`, `reference` (`valid`/`unavailable`/`invalid`).
- `compaction_cancelled` (`cause`, `fallback`) and `compaction_failed` (`errorMessage`).
- `spawn` events carry each sub-worker's `compactions` (and `compactionEvents` when some were refused or failed).

## Disable / roll back

Remove `workerCompaction` (or set `"workerCompaction": "window-ratio"`): every worker returns to the stable 50% policy with basic
essentials and sub-workers without compaction, exactly the behaviour before the option existed.

## Relation to "You don't need long context" (arXiv:2611.05306)

The paper (Belcak et al., NVIDIA, v1 2026-11-03) reports that end-of-conversation compaction at short thresholds (e.g. 48K/36K
down to 16K/12K) broadly keeps long-horizon accuracy for frontier models, that selective reading of stored inputs/history removes
the need to keep them in context, and that single-action compaction (SAC) is feasible; its Appendix A finds the best compactions
to be briefs for future work (verbatim task, current occupation and next steps, plan, completion requirements, pointers to
artifacts). orche already restored the verbatim task, plan and requirements; this option adds the work log with failed attempts,
main's later instructions, validated pointers to the original transcript, and short absolute thresholds as an experiment. SAC is
not implemented. The paper's results are its own measurements on other harnesses and do not establish an effect for orche.
