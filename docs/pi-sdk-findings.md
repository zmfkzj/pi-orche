# Pi SDK 0.99.1 runtime findings

All four raw-SDK experiments were recorded before `src/agent/**` implementation. The harness uses real AgentSession instances and in-memory SessionManager/SettingsManager. The original experiment runs copied credentials into memory; that unsafe OAuth strategy has been removed because refresh tokens rotate and must be persisted by Pi. Current runtime initialization uses Pi's default file-backed credential store, sharing one ModelRuntime across sessions; settings/model defaults are never persisted. Commands: `npx tsx experiments/auth-probe.ts`, then `exp1.ts`, `exp2.ts`, `exp3.ts`, `exp4.ts`. The later sender-backed Exp2 repetition uses an OpenAI A1 and DeepSeek A2. Experimental delays are intentional live tool work; regression tests use deferred gates, not sleeps.

## Authentication

`results/experiments/auth-probe.json` contains one tiny SDK request per candidate and measured latency. Usable routes: openai/gpt-6-luna (4023 ms), openai/gpt-6-sol (3738 ms), google/gemini-3.5-flash (1423 ms), deepseek/deepseek-flash (798 ms). Both Anthropic routes returned HTTP 429 account-rate-limit errors, not credential-invalid errors; their usability was not established. The JSON `authenticated:false` means the probe did not successfully complete, not proof of invalid credentials. No automatic fallback was introduced.

## Experiment 1: persistent independent contexts

`results/experiments/exp1-persistence.json`: A1/OpenAI, A2/Google, A3/DeepSeek each completed three consecutive prompts. Each recalled its own PRIVATE code exactly; A2 and A3 denied having been given A1's private code. Sessions and full transcripts are independent. No shared context or custom persistence is used.

## Experiment 2: NOTE comparison

Raw request contexts, lifecycle timestamps, tool outputs and transcripts are in `exp2-note.json`; the real A1 sender's answer/transcript is in `exp2-sender.json`. Request arrays are numbered from one. The first assignment's request count is `initialRequests`; the last request is a separate deliberate recall assignment, not an automatically forced continuation.

| Primitive | During tool work | At final assistant message | Idle |
| --- | --- | --- | --- |
| steer | Does not cancel bash; enters next request | Forces another request | Queued for next prompt |
| followUp | Does not cancel bash; enters an additional request after ordinary completion | Forces another request | Queued for next prompt; can force a follow-up |
| custom, triggerTurn:false | Tool finishes; custom NOTE is in next request | Appended without continuation | Appended immediately, zero requests |
| custom, deliverAs:nextTurn | Absent from same assignment's next request; appears in next assignment | No continuation | Appears on next prompt |

The triggerTurn:false candidate completes `sleep 5 && echo TOOL_FINISHED` and needs exactly two initial requests (tool selection and final reasoning), versus three for followUp. At final timing it makes one initial request, with the NOTE in the next assignment context. It creates no idle turn. Raw model context is the authoritative timing proof: a model sometimes denies receiving a "peer" note even though the user-role custom content is present. Free-form acknowledgment is not a lifecycle signal.

One additional DeepSeek sender request returned malformed text with an end-of-sentence marker (`provider-observation.json`). The adapter does not normalize, hide, or retry that output. A subsequent cross-provider sender experiment delivers the actual A1 answer verbatim.

**Chosen NOTE mapping:** `sendCustomMessage({customType:'pi-orche.note',content,display:true,details:message},{triggerTurn:false})`. Pi flushes running notes at turn_end or the run's final flush; custom message_end is the observational delivery event. A send receipt means accepted into Pi's context queue, while the event marks actual transcript append. NOTE does not request continuation and does not steer.

## Experiment 3: REDIRECT

`exp3-redirect.json`: soft steer required 10,727 ms from delivery through the new goal's answer because the ten-second tool finished normally. Hard abort + prompt required 819 ms; the long tool was interrupted and the final answer was NEW_GOAL_ADOPTED. Full aborted transcript and tool-result events are preserved in the evidence. Time-to-switch includes obtaining the new answer, not just issuing abort.

**Chosen REDIRECT mapping:** coordinator-only hard supersede, increment assignment epoch, finalize old assignment once (completed if a result was already accepted; otherwise superseded), await Pi abort, then prompt the new assignment on the same session. This preserves late accepted results and avoids the ambiguity of steering near terminal completion.

**Chosen STOP mapping:** finalize old assignment once (completed if already reported; otherwise stopped), abort and retain the session. Disposal is separate. A NOTE arriving during abort is flushed into the persistent context. REDIRECT during STOP awaits the same abort promise, then assigns the new goal.

## Experiment 4: real-fixture preemption

`exp4-preemption.json`: three real DeepSeek explorers per variant, each on a fresh temporary copy of problem A, reading source/logs and running Node tools. First root_cause tool report aborts the other two only in the preempting variant. Full reports identify stale-token invalidation clearing a newly refreshed credential. Temporary copies are removed after recording transcripts.

| Variant | Requests | Wall time ms | First root cause ms | Input | Output | Cache read | Cache write | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fork-join completion | 33 | 34521 | 28638 | 13544 | 13317 | 127616 | 0 | 154477 |
| Early abort | 26 | 22937 | 22905 | 11966 | 7587 | 65664 | 0 | 85217 |

Observed reduction: seven requests, about 33.6% wall time and 44.8% recorded total tokens (cache reads included). This is one paired experiment with intentional staggered exploration starts, not a repeated statistical benchmark or a claim that every task improves. The later benchmark should repeat independently.

## RESULT and lifecycle regression evidence

RESULT is the custom report_result tool with `{kind,summary,data?}`. First accepted report wins; later calls return an error and cannot replace it. Tool results use `terminate:true`. Pi terminates a tool batch only when every result requests termination, so the system instructions require reporting alone. Ordinary settlement finalizes completed/no_result/failed on agent_settled, not agent_end. Interruption intentionally finalizes the old outcome before abort, per the supersede contract. No_result includes last assistant text. Outcome delivery is a separate once-consuming queue from NOTE inbox delivery.

`test/agent/agent-manager.test.ts` uses real AgentSession and Pi's faux provider. Response factories and public Agent tool execute gates pin races. Covered: mid-tool/idle/near-terminal NOTE; NOTE during report execution, after last assistant message_end, and immediately after settle; running/before-result/after-result REDIRECT; NOTE+REDIRECT during STOP; duplicate ids; bounded wait; inbox/sender policy; independent three-worker contexts; sequential reuse; missing/error result; duplicate result tool calls. The public session diagnostic accessor is used to observe transcripts and gate actual tool execution, never to mock AgentSession.

Live adapter smoke: `npx tsx experiments/foundation-smoke.ts`, evidence `foundation-smoke.json`. A sends B a worker-tool NOTE, B reports SMOKE_SECRET_918, and B's second assignment reports that same retained code. All three assignments finish completed; B completedAssignments is two. Events show direct peer delivery, separate assignment outcomes and per-assistant usage.

## Public API sufficiency and limitations

No fork or Pi patch is needed for the required semantics. The SDK provides persistent sessions, context-only custom messages, abort, terminate tool results, lifecycle subscription, in-memory state and injectable ModelRuntime/faux provider. Role instructions append through the ResourceLoader mechanism; built-in tools use the explicit allowlist and coordinator tools are added to it. Retries are bounded to one agent retry, 250 ms initial delay/1000 ms maximum agent delay, zero provider retries.

AgentManager accepts an optional ModelRuntime in its constructor and lazily creates one shared `ModelRuntime.create()` otherwise. Per-spawn injection overrides it for faux tests or explicitly configured providers. The standalone factory also has a lazy shared default runtime. Both use Pi's default file-backed credential storage: OAuth refresh uses Pi's credential locking/persistence, never a manual credential copy. experiments/raw-sdk.ts likewise memoizes one default runtime. Global/project resource discovery is ignored intentionally; SettingsManager stays in memory. File-backed sessions are optional through sessionDir; Pi owns all context storage.

Abort waits for Pi/tool cooperation: a custom tool that ignores its AbortSignal can delay STOP until it returns. All orchestrator waits exposed to callers have finite timeout bounds, but the adapter cannot forcibly kill arbitrary JavaScript custom tools through Pi's public API. This is a tool implementation responsibility, not grounds for a core fork. report_result does not force termination of unrelated non-terminating tools in the same batch; use it alone. Delivery does not guarantee a model will obey or acknowledge a NOTE. Deduplication is process-local, intentionally not persisted. Tests and live experiments do not claim cross-process delivery.

Current orchestration uses a linked overall AbortController from runtime startup through final audit/teardown. Public `abort()` waits for idle; `dispose()` is synchronous, so abort waits are bounded independently and late session creation is disposed without starting a prompt. Owned Git children receive AbortSignal and per-call safety timeouts (30s workspace, 5s advisor); only the owned child is killed. Cleanup uses remaining overall time, without extra grace; optional timeout diagnostics and cleanup pending metadata do not imply hard isolation or a complete workspace snapshot. Event-loop-blocking JS, synchronous callbacks and uncooperative SDK promises remain an in-process limitation. Losing rejections are observed, manager control tools/assignments and ownership-guarded calls are fenced after cancellation. Worker request/activity diagnostics contain no prompt text. RESULT kind mismatches are rejected before/independently of data contracts, sharing the existing bounded repair budget and preserving assignment identity and first-valid-result semantics. Deterministic deadline and advisor lifecycle regressions cover stalled startup, late creation, active decisions, final audit, teardown, cancellation and timer release; historical live measurements above are unchanged.

Only `wait("any")` can consume a main inbox NOTE. Waiting on a specific agent or agent list consumes only matching outcomes, leaving coordinator messages intact. The coordinator must handle outcome/message/timeout separately; receiving a main NOTE is not a worker result. Observers are informational and their exceptions cannot perturb lifecycle. Usage retains the assignment identity through abort so the final aborted assistant event is attributed to the old assignment.

A retry regression also exercises a real SDK 429 auto-retry followed by a successful report. It reproduced an initial foundation bug (recovered result incorrectly marked failed; raw failing output `artifact://45`) and now verifies completed after recovery. Failure status follows the latest assistant response, not a transient error from an earlier attempt. Final scoped verification output is `results/experiments/foundation-verification.txt`.

## Runtime review follow-ups

NOTE content now includes a compact header identifying sender, message id and informational semantics, plus signal kind/cause/confidence when supplied. Original details remain unchanged. Next-request faux-provider assertions cover framing and structured signal visibility.

`SpawnOptions.peerMessaging?: boolean` defaults true. False omits send_message registration and tool activation, and omits its instructions; this supports the fork-join baseline without enabling peer messaging. A real AgentSession regression verifies tool absence and successful result reporting.

Follow-up verification: `npm run typecheck && npm test` passed (31 tests, including 15 foundation races), raw output `results/experiments/foundation-followup-verification.txt`. One live smoke rerun used two OpenAI gpt-6-luna sessions with a single constructor-injected file-backed runtime and completed all three assignments. `foundation-smoke.json` and `foundation-followup-smoke.txt` record only safe auth metadata: auth.json mtime changed from 1790779463948.596 to 1790782827404.5527; OpenAI expiry changed from 1790782883949 to 1790786247405. Pi persisted the OAuth refresh successfully. No credentials are logged or manually written.

The router rejects every self-addressed message (`from === to`) with status `rejected` and reason `self-addressed`, before deduplication or delivery. Such messages neither append transcript content nor emit message_delivered. The self-address regression covers NOTE, REDIRECT and STOP; scoped foundation tests pass 16/16 and `npx tsc --noEmit -p .` passes.

## Bounded RESULT nudge

`new AgentManager(modelRuntime?, { resultNudges?: number })` defaults to one result nudge; zero disables it. When a running assignment settles without an accepted report or model error, the manager waits for Pi's idle boundary and prompts the same session to call report_result alone. Assignment id/epoch are retained, usage remains attributed to that assignment, and no intermediate no_result outcome is emitted. The observable `assignment_nudged` event includes timestamp, agentId, assignmentId and 1-based attempt. Errors are not nudged; exhausted nudges yield one final no_result with the last assistant text.

This applies symmetrically to baseline and orchestrated workers. Real AgentSession/faux races cover recovery to a single completed result, exhausted nudge, REDIRECT/STOP during nudge, context-only NOTE during nudge, disabled nudges and model-error exclusion. `npx vitest run test/agent` passes 22/22; `npx tsc --noEmit -p .` passes. No additional live model runs were performed; evaluation round three supplies live verification.
