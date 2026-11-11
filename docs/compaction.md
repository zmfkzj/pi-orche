# Worker compaction and state preservation (`workerCompaction`), main-session ratio (`mainCompaction`)

Long assignments outgrow their context. orche keeps the task state outside every LLM context and puts it back when a worker
compacts; this page describes when worker sessions compact, what they get back, how the original evidence stays reachable, and
what is recorded. The main session is never changed by these worker settings; its own ratio policy is
[`mainCompaction`](#main-session-maincompaction-orcheconfigjson-default-on) below.

## Main session: `mainCompaction` (orche.config.json, default on)

Pi's `compaction.reserveTokens` and `compaction.modelOverrides` (settings.json) accept integer token counts only, so a reserve
that should follow the model would need one entry per model. orche therefore gives the **main** session a ratio of its own:
once main's context is above `usageRatio` (default **0.8**, i.e. 80% used, 20% left) of the **current** model's context window,
main compacts through Pi's ordinary compaction (`ctx.compact()`: the same summary request, `keepRecentTokens` from settings.json,
every extension's `session_before_compact` / `session_compact` hooks). Source: `src/extension/main-compaction.ts`.

```json
{ "mainCompaction": { "usageRatio": 0.8, "midRun": true } }
```

| value | meaning |
|---|---|
| omitted, `true` | on with the defaults (`usageRatio` 0.8, `midRun` true) |
| `false` or `{ "enabled": false }` | off: Pi's own settings alone decide, exactly as before |
| a number, e.g. `0.75` | on with that ratio (0.1 to 0.95) |
| `{ "usageRatio", "midRun", "enabled" }` | `midRun: false` compacts only between runs (see below) |

- **Measure and capacity.** The usage is Pi's own estimate (`ctx.getContextUsage().tokens`, the estimator of Pi's threshold
  check) against `contextWindow` of the model Pi resolves for limits. Nothing is listed per model: a model registered today, a
  model switch (`/model`, Ctrl+P) or an extended window uses its own registry metadata (`contextWindow`); a wrong `contextWindow`
  (e.g. a provider that reports none and gets a default) gives a wrong threshold. Compaction needs strictly more than
  `floor(contextWindow × usageRatio)` tokens. Without a usable window (none or 0) or while Pi knows no usage (right after a
  compaction, until the next response) nothing is decided.
- **When.** (1) After a main run settled (not aborted) and Pi is idle, after Pi's own queued prompts; (2) after a model switch
  while idle; (3) with `midRun`, between the tool turns of a running response. Pi offers extensions no compaction inside a run and
  `ctx.compact()` aborts the run first, so the response is stopped after its tool results are stored (the TUI shows the abort of
  the next, never-sent request), compacted, and continued with a hidden `orche-main-compaction` note. The mid-run trigger is
  skipped (the run goes on, the next boundary checks again) while the user has queued messages, while a one-shot
  `/orche <mode> <prompt>` request or held-back input is pending, outside interactive/RPC mode, and when Pi's own threshold
  compacts before the next request anyway. A restored session that is already above the ratio compacts at its first such point.
- **Precedence.** The ratio is a ceiling ("compact no later than 80%"); Pi's integer threshold stays as it is and the earlier
  of the two acts. A `reserveTokens`/`modelOverrides` entry that leaves less than `1 − usageRatio` of a window free compacts
  that model earlier (natively, mid-run); one that leaves more is overtaken by the ratio. orche does not cancel Pi's earlier
  threshold compactions (Pi would show "Auto-compaction cancelled" at every check). Integer `keepRecentTokens`/`reserveTokens`
  remain valid and still shape the summary. Manual `/compact` and overflow recovery are unchanged; `compaction.enabled: false`
  in settings.json switches the ratio off as well.
- **Other triggers.** The cliproxyapi provider's proactive compaction (`@router-for-me/pi-cliproxyapi-provider`
  `extensions/auto-compact.ts`) fires at `contextWindow − compaction.reserveTokens` (the ordinary value, default 16384) through a
  synthetic overflow; any compaction clears its pending trigger, so it never doubles one of ours. It has no switch of its own
  (only `compaction.enabled: false` stops it). An extension that calls `ctx.compact()` itself looks like a manual compaction to
  orche; run only one such ratio extension.
- **Bounded.** One attempt at a time, none while any compaction runs (and a pending one gives way when Pi compacted first); a
  failed or cancelled attempt is not retried before the next user input, a model switch or a session start (Pi's threshold and
  overflow recovery still apply). Esc during the summary stops the interrupted response for good. If the first usage measured
  after orche's compaction is still above the ratio (Pi keeps the latest message verbatim when it alone exceeds
  `keepRecentTokens`), the ratio waits until usage is below it again: no compaction loop.
- **Messages during a compaction.** Pi starts the turn of a `triggerTurn` message even while it compacts outside a run (it
  only queues such messages behind a running response), so a background `orche_task` result arriving during the summary would
  start a main run beside it. orche's own turn-starting messages (task results, the notice that an approved queued task was
  dropped) are therefore held from the moment orche requests its compaction, and during any other manual compaction from its
  `session_before_compact` (the user's `/compact`, another extension's `ctx.compact()`), and sent once afterwards in arrival
  order: behind the continuation note of an interrupted response, as one run (or queued behind a run that started meanwhile).
  After Esc during the summary they are shown without starting a turn (main sees them with the next prompt), as orche does
  with held-back results after an abort; a session shutdown or `/reload` keeps them in that session the same way and never
  carries them into the next one. Pi's threshold and overflow compactions run inside a run, where Pi queues such messages
  itself, so nothing is held for them. **Not covered:** messages other extensions send with `triggerTurn` (e.g. a woken
  pi-session-bus note) do not pass through orche, and a manual compaction someone else starts is only seen from its
  `session_before_compact` on; Pi's public API offers no way to hold either, so such a message can still start a run during a
  summary, exactly as it can during `/compact` without orche.
- **Main only.** The extension that runs this is loaded in the main Pi session; worker, sub-worker and specialist sessions are
  created with `noExtensions` and keep their own settings (below: 50% for single-workflow workers, off for specialists and by
  default for `orche_spawn` sub-workers). `print`/`json` runs keep Pi's own behaviour only.
- **Activation.** A config change applies at the next session start or `/reload`. New orche code applies once the installed
  package has it (a git install: the change pushed, then `pi update --extensions` or `pi update <source>`) and the session is
  reloaded (`/reload`) or restarted.

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

## Summary budget (`src/pi/summary-budget.ts`, every orche session)

Pi's repeated compactions are iterative: each summary request carries the previous summary with Pi's update rules ("PRESERVE all
existing information from the previous summary", then add the new messages) and only asks for concise sections. A long worker
therefore wrote a larger summary at every compaction until one no longer fitted in one response. Research it-0139
(cliproxyapi/claude-fable-5-2, thinking max, 1M window, stable 500k trigger, `max_output_tokens` 128000 from the catalog) grew
from 34k to 272k characters over nine compactions (reported output 25k → 144k tokens; every one was a split-turn compaction, so
that usage adds a history and a turn-prefix request); then each threshold check sent the same request again and Pi refused the
cut-off answer (`Summarization failed: generation hit the token cap and the summary is incomplete`): six failures about 16
minutes apart, each with the context unchanged and one more tool turn in between. it-0138's four runs show the same growth
(output 15k → 109k tokens) without reaching the cap. The later `You have hit your ChatGPT usage limit.` was a separate provider
error (it failed the worker's own next request first, then the compaction after it).

So orche's session view of the model runtime (`withSummaryOutputCap`, `src/pi/output-cap.ts`), which already recognises Pi's
summary requests by their shape, appends one instruction block to every summary request (compaction history and turn prefix,
branch summaries):

- the whole summary stays under a token budget: a quarter of the request model's catalog `maxTokens`, at most 32000 (16000 when
  the model has none, never below 4096); when the previous summary or the new messages are larger, older detail is condensed
  (finished work in short lines, superseded or repeated detail dropped, exact paths, identifiers, numbers and errors kept), and
  the current state, open problems and next steps stay complete; this takes precedence over Pi's "preserve everything" rule;
- in task sessions (`taskCompaction`), the `orche:task-essentials` message ("Assignment in progress at compaction time …") is
  restored verbatim after the summary from orche's own state, so the summary only points to it instead of copying it. The
  verbatim assignment, Task DAG with checkpoints, ledger and (extended) work log and transcript reference are restored exactly as
  before, independent of the summary.

When a summary answer still stops at the output limit (`stopReason: "length"`), the session's budget level rises (the budget
halves per level, down to 4096) and the request is sent once more right away with the smaller budget and a note that the
previous attempt was discarded. A second cut-off answer is returned to Pi, which fails the compaction exactly as before (no
partial summary becomes a checkpoint, the context is kept); the next compaction of that session (the next threshold check, an
overflow recovery, a manual `/compact`) starts from the raised level, so the request that was cut off is never sent unchanged
again. The level belongs to the session and is kept across assignments (a reused worker still carries its large summary).
Provider errors (e.g. a usage limit), aborts and complete answers are passed through untouched and are never re-sent here; Pi's
own retry of transient errors is unchanged. The output cap (`outputCap`) is unchanged and independent: `outputCap: "off"` still
leaves the payload alone, while the instruction is part of the summary prompt.

Limits: the budget is an instruction; a model can still exceed it (then the re-send above applies). It bounds each summary
request, not the merged checkpoint: a split-turn compaction joins a history and a turn-prefix summary, and when there are no new
messages before the turn Pi reuses the previous summary verbatim as the history part, so a summary that was already oversized
before this change shrinks only at the next compaction that rewrites it. Whether the provider honours `max_output_tokens`
exactly is not observable from the records (the compaction record holds the combined usage of both requests).


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
- `output_cap` with `request: "summary"`: the `max_output_tokens` decision for Pi's summary requests (Claude through CLIProxyAPI;
  `src/pi/output-cap.ts` `withSummaryOutputCap`), recorded when it differs from the previous summary decision. Pi sends summaries
  without its `before_provider_request` hook, so without this view they carried no budget and the proxy default applied. Only
  requests in Pi's own summary shape (Pi's summarization system prompt, `cacheRetention: "none"`, no hook, no `maxTokens`) get it;
  extensions' and other direct requests through the session runtime keep their payload.
- `summary_length_stop`: a summary answer that stopped at the output limit: `model`, `budgetTokens` (asked for),
  `nextBudgetTokens`, `outputTokens` (provider-reported), `cap` (the `max_output_tokens` orche sent; absent: none), `retry` (true:
  re-sent at once; false: the second cut-off answer, returned to Pi, followed by `compaction_failed`).
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
