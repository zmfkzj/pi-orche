# Advisor

A configurable, multi-advisor review layer. It merges what OMP does with its `orche-advisor` (plan review) and `verification-auditor` (claims vs evidence) into one mechanism: any number of advisors, each with its own trigger, period, advice domains and recipients. The two OMP roles are shipped as presets.

Advisors are advisory only. They never redirect, stop, gate or cancel a tool; the coordinator decides what to do with a NOTE. Everything is off unless an enabled advisor is configured, in which case behaviour (and request counts) are exactly the same as before.

## Configuration

`advisors` is an optional top-level array in the route config (`orche.config.json`, parsed by `parseRouteConfig`). Unknown fields are rejected with the path of the offender (`config.advisors[1].triggers[0].every: expected integer >= 1`).

```jsonc
{
  "routes": { "advisor": { "model": "openai/gpt-6.1-sol", "thinking": "high" } },  // optional; falls back to "default"
  "default": { "model": "openai/gpt-6.1-sol", "thinking": "high" },
  "advisors": [
    { "preset": "plan-review", "enabled": false },
    { "preset": "verification-audit", "enabled": false },
    {
      "name": "security-watch",
      "domains": ["security", { "id": "naming", "instructions": "Identifiers match the project glossary." }],
      "targets": ["coordinator", "role:implementer"],
      "triggers": [{ "on": "turn_end", "every": 5 }, { "on": "tool_error" }],
      "cooldownMs": 60000, "maxCallsPerRun": 6, "maxCallsPerTarget": 2
    }
  ]
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `preset` | Start from a shipped definition (`plan-review`, `verification-audit`); other fields override it. | none |
| `name` | Unique, `[A-Za-z0-9][A-Za-z0-9_.-]{0,47}`; the NOTE sender is `advisor:<name>`. Required without a preset. | preset name |
| `enabled` | `false` disables the entry entirely (no sessions, no events). | `true` |
| `route` | Route role resolved through `routes` / `default`. An unresolvable route fails the run at start instead of silently skipping the advisor. | `"advisor"` |
| `domains` | Non-empty. Builtin name or `{id, instructions}` (id not a builtin name). The advisor's notes must name one of them. | required |
| `targets` | Who receives advice, see below. | required |
| `triggers` | Non-empty; see below. | required |
| `cooldownMs` | Minimum gap between two call starts for the same advisor and recipient. | `30000` |
| `maxCallsPerRun` | Total calls of this advisor. | `6` |
| `maxCallsPerTarget` | Calls of this advisor per recipient. | `3` |
| `timeoutMs` | Wall-clock bound of one call (also clamped by the remaining decision budget when the coordinator waits). | `90000` |

At most 8 advisors.

### Domains

Builtin domains carry fixed review instructions (`domainInstructions` in `src/advisor/config.ts`): `plan` (decomposition, ownership, scope of the plan; ex orche-advisor), `verification` (claims vs evidence; ex verification-auditor), `correctness`, `security`, `performance`, `tests`, `scope`, `docs`. Custom domains bring their own instructions (max 4000 chars).

### Targets (recipients)

- `coordinator` — NOTE to `main`; it reaches the coordinator in its next decision context (`mainNotes`).
- `workers` — the worker whose activity fired the trigger.
- `role:<role>` / `agent:<id>` — that worker, if it is the one that fired the trigger and role/id match.

`coordinator_decision` and `before_complete` observe the coordinator, so they can only target `coordinator` (validated).

### Triggers

| Trigger | Fires | Filters |
| --- | --- | --- |
| `coordinator_decision` | When the coordinator has produced a valid decision, before it is applied. | `decisions` (decision types such as `classify`, `assign`, `root_cause_accepted`, `complete`), `phases` (`EXPLORE`, `CONVERGE`, `BACKLOG`, `EXECUTE`, `VERIFY`), `await` |
| `assignment_started` | A worker assignment starts. | `kinds`: `explore`, `backlog_proposal`, `implement`, `fix`, `verify`, `answer` |
| `assignment_result` | A worker assignment ended with a result, no result or a failure (not when the coordinator itself superseded/stopped it). | `kinds` |
| `turn_end` | Every `every`-th model turn of a worker (counted per advisor, trigger and worker, across assignments). | `every` |
| `tool_error` | A worker tool call failed (`report_result` / `send_message` protocol errors are ignored). | — |
| `interval` | Every `ms` (>= 100) for each currently running worker. | `ms` |
| `before_complete` | The coordinator is about to complete (`complete`, `answer`, `answer_from_worker`). Always awaited. | — |

`await: true` on `coordinator_decision` makes the coordinator wait for the review before applying the decision.

## What an advisor sees and returns

Each call is a fresh read-only Pi session (`READ_ONLY_TOOL_NAMES` + `advisor_verdict`), capped at 8 turns and `timeoutMs`, always disposed. Its prompt is bounded and contains: user request (3000 chars), trigger context (4000), the observed agent's transcript since this advisor's previous call about that agent (newest 12000 chars), and the workspace `git status` + `git diff HEAD` excluding `.orche` (10000). The advisor may use its read-only tools for more evidence.

It must finish with one `advisor_verdict` call: `{ verdict: "ok" | "concern" | "blocker", notes: [{domain, text, evidence?}] }` (at most 5 notes). `ok` discards notes and injects nothing. `concern`/`blocker` produce exactly one NOTE from `advisor:<name>` to each recipient (`signal.kind` = `advisor_concern` / `advisor_blocker`). If the advisor errors, times out, or answers in plain text, a `advisor_failed` event is emitted and nothing is injected.

## Timing and the coordinator

- Calls run beside the workers; a worker's tool execution is never awaited or cancelled. NOTE delivery is the existing context-only mechanism.
- One call per advisor and recipient at a time. A non-await review that arrives while that recipient's advisor is busy is remembered (one per observed agent) and started when the call finishes, subject to budgets and cooldown.
- Before every coordinator decision the engine lets in-flight coordinator-bound calls finish (bounded by the decision budget), so e.g. an audit of the verifier's result lands before the coordinator completes.
- **Reconsideration.** For `await` decision triggers and `before_complete` the coordinator waits for the review. If it produced at least one NOTE, the coordinator is asked once to resubmit or revise (the NOTE is in `mainNotes`). That second decision is not reviewed again, so there is at most one extra coordinator decision per reviewed decision.

## Events

Added to the run sink (`CoordinatorEvent`):

- `advisor_triggered {name, target, trigger, subject, await}`
- `advisor_result {name, target, trigger, verdict, notes, delivered}`
- `advisor_failed {name, target, trigger, reason}`
- `advisor_usage {name, model, input, output, cacheRead, cacheWrite}` — one per advisor model response; benchmark totals must add these to worker/coordinator usage.

## Presets

```ts
"plan-review": {   // ex orche-advisor
  name: "plan-review", route: "advisor", domains: ["plan"], targets: ["coordinator"],
  triggers: [{ on: "coordinator_decision", decisions: ["classify", "assign"], await: true }],
  cooldownMs: 0, maxCallsPerRun: 4, maxCallsPerTarget: 4,
}
"verification-audit": {   // ex verification-auditor
  name: "verification-audit", route: "advisor", domains: ["verification"], targets: ["coordinator"],
  triggers: [{ on: "assignment_result", kinds: ["implement", "fix", "verify"] }],
  cooldownMs: 0, maxCallsPerRun: 6, maxCallsPerTarget: 6,
}
```

`classify` is the classification decision; `assign` is the backlog (canonical task list) decision. Both presets ship `"enabled": false` in `orche.config.json`.

## Code map

`src/advisor/config.ts` (schema, validation, presets, defaults) · `engine.ts` (trigger filtering, budgets, queueing, delivery) · `session.ts` (advisor session + verdict tool) · `context.ts` (bounded transcript/diff) · `prompt.ts`. Integration: `decide()` in `src/orchestration/coordinator.ts`, `advisor:<name>` NOTE sender in `src/messaging/message-router.ts`.
