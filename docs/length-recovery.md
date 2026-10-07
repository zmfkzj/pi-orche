# Output-limit ("length") recovery in worker sessions

## The problem (observed 2026-10-06/07)

Worker sessions on Claude Opus at thinking xhigh/max, served through an OpenAI-Responses-compatible proxy, ended ten responses with
`stopReason: "length"`, `usage.output = 32000` and **only thinking** in the content (no text, no tool call). The catalog says
`maxTokens = 128000`, so Pi (`isRecoverableLength`: output below the model's maxTokens) took each one for a context overflow:
omit the attempt, compact, retry once per prompt. The contexts were 30–60k tokens of a 1M window, so every compaction was useless,
the retry overran again, and orche's single "You ended without calling report_result" nudge produced another overrun; four
assignments ended without a report (e.g. `~/.pi/agent/orche/records/01a113eb-…/workers/W2-2026-10-07T02-22-41-603Z.jsonl`
lines 68–123: seven length stops, five compactions, about an hour).

## What other agents do (survey, read 2026-10-07)

### Summary and decisions

Read in source at the pinned commit unless noted; full notes below, every claim with its URL in
[length-recovery-sources.json](length-recovery-sources.json).

| Agent / extension (ref) | Thinking-only length stop | Cut-off text / tool calls | Real overflow | Taken / rejected for orche |
|---|---|---|---|---|
| pi (local 1.0.0, upstream [`27c7b6f`](https://github.com/earendil-works/pi/blob/27c7b6ff48ccca57694a960e4af10529f77deae6/packages/ai/src/utils/overflow.ts#L179)) | output below catalog `maxTokens` ⇒ treated as overflow: compact + retry once | same | compact + retry once | **kept for (c) only**; the (a)/(b) misfire is the bug ([pi#9793](https://github.com/earendil-works/pi/issues/9793), open) |
| Codex CLI ([openai/codex `95ec468`](https://github.com/openai/codex/blob/95ec468619386ebb93506ac2091a48e5a558d25c/codex-rs/codex-api/src/sse/responses.rs#L418-L434)) | `response.incomplete` ⇒ stream error ⇒ **the same request re-sent** with backoff, up to 5 (`stream_max_retries`) | not distinguished, partial discarded | ends the turn, compacts before the next | **rejected**: re-sending the same context into the same cap repeats the overrun (benchmark P4) |
| Gemini CLI ([`ef59c53`](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/core/geminiChat.ts#L1594-L1621), core 0.65.0-nightly) | empty MAX_TOKENS ⇒ **same request re-sent**, up to 4 attempts with 1/2/4 s backoff, then "try /compress" | text or tool call accepted with a warning | proactive compression | **rejected**, as Codex (benchmark P4) |
| Claude Code (npm `@anthropic-ai/claude-code-linux-x64` 2.1.292, closed source, bundle strings; [changelog `765f236`](https://github.com/anthropics/claude-code/blob/765f236fe1bfcc678e0ec59af9170fb7d6771a3a/CHANGELOG.md#L7290)) | gated thinking resumption, else a "resume directly" nudge, 3 attempts | keeps partial + nudge | reactive compaction with a thrash breaker | **taken**: separate case, short directive nudge, cap |
| oh-my-pi ([can1357/oh-my-pi `355b5d9`](https://github.com/can1357/oh-my-pi/blob/355b5d9685529d337875d7d387ef53b1f32e7a72/packages/coding-agent/src/session/session-maintenance.ts#L3047-L3178), 18.8.0) | drop attempt + "next step only" nudge, no compaction below the threshold; 3, reset on delivered content; terminal error | keep text + warn; tool calls fail | compact | **taken**: the closest design (nudge, reset rule, explicit failure); cap 2 + step-down chosen by the benchmark |
| Cline ([`5b67631`](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/sdk/packages/agents/src/agent-runtime.ts#L1453-L1507)) | compaction once, then a concise nudge (3) | tool calls run | compaction once | compaction part rejected (context is not the problem); nudge taken |
| Roo Code ([`b867ec9`](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts#L3518-L3560), 3.53.0) | generic empty-response retry | finish reason ignored | truncate to 75% | generic retry measured as P3 (plain continuation), rejected |
| OpenHands SDK ([`91ac058`](https://github.com/OpenHands/software-agent-sdk/blob/91ac058a08fd6365286fc8c5628f35a5f41ff300/openhands-sdk/openhands/sdk/agent/response_dispatch.py), 1.53.0) | REASONING_ONLY generic nudge | ignored | condenser | as Roo |
| OpenCode ([`ecc4916`](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/session/prompt.ts#L1111-L1129), 1.18.35), Goose ([`8c0c409`](https://github.com/block/goose/blob/8c0c409a8292c41472d6567a1acb0c841403b4e2/crates/goose-provider-types/src/formats/openai_responses.rs#L1280-L1295), 1.54.0) | turn ends (surfaced) | completed tool calls run, partial dropped | compaction | the "never silent" part taken (explicit failure) |
| Aider ([`5dc9490`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1492-L1505), 0.86.3.dev) | n/a (reasoning stripped) | unbounded prefill continuation | stop | rejected: unbounded, and no prefill with thinking (Anthropic) |
| Provider guidance ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), [OpenAI](https://developers.openai.com/api/docs/guides/reasoning), read 2026-10-07) | raise max_tokens or lower effort per workload; effort changes break the prompt cache | continuation capped at 3 | — | step-down only on the last attempt, never as a default ([pi#9718](https://github.com/earendil-works/pi/issues/9718): non-monotonic) |

The benchmark baselines are named after what they do, not after an agent: **P4_identical_resend** re-sends the request unchanged
right away (the Codex/Gemini pattern without their backoff, error classification and retry counts — 3 here, 5 and 4 there; it
models the token cost of the pattern, not those products); **P3_plain_continue** adds a plain `Continue.` message (the generic
continuation nudge of Roo/OpenHands-style agents, not their exact wording or caps).

### Detailed notes

0) LOCAL PI (pi-coding-agent / pi-ai / pi-agent-core 1.0.0; global copy 1.0.4) — the baseline
- [V] `pi-ai/dist/utils/overflow.js:170-172` — `isRecoverableLength` = stopReason "length" and output < desiredMaxOutput. It looks only at usage: not the content, and not how full the context is.
- [V] `overflow.js:153-161` — a length stop counts as overflow only when output is 0 and input ≥ 99% of the window.
- [V] `pi-coding-agent/dist/core/agent-session.js:2339-2374`:
  - a recoverable length stop goes down the same path as an overflow;
  - the attempt is removed from context (`_omitRecoveryAttempt`), then `_runAutoCompaction("overflow", willRetry)` runs;
  - this happens once per turn (`_overflowRecoveryAttempted`), then the message "Truncated response recovery failed".
- [V] The once-per-turn flag resets on a user message or on an assistant stop that is not error/length (`agent-session.js:715,759`). So each new prompt gets one more doomed compaction.
- [V] What pi actually asks the provider for:
  - `maxTokens` = model.maxTokens, clamped only by the context window (`pi-ai/dist/api/simple-options.js:4-15`);
  - Responses API: `max_output_tokens` = that value (`openai-responses.js:248-250`), so 128000 was requested and the proxy cut at 32000.
  - incomplete with reason max_output_tokens ⇒ "length" (`openai-responses-shared.js:675-684`).
- [V] Length stop with tool calls: every call fails with a synthetic "re-issue with complete arguments" result and the loop continues (`pi-agent-core/dist/agent-loop.js:160-166,342-362`).
- [D] Recovery ordering and cancellation: `compaction.md:39,85-98`. If `session_before_compact` cancels a recovery compaction, the omission edits stay and no retry is scheduled.
- [D] `turn_end` and `agent_before_settle` can add entries and request one continuation (`extensions.md:66,117`). These are the hooks pi-orche can use.
- [V] Upstream pi (earendil-works/pi @27c7b6f) is unchanged: `packages/ai/src/utils/overflow.ts:179`, `packages/coding-agent/src/core/agent-session.ts:3008`.
- [D] Related upstream issues:
  - #9793 (open): a length stop with a context far below the window triggers a history-dropping compaction. Proposed fix: compact only on context pressure.
  - #9409 (open): sessions wedge at the context ceiling with output = 16.
  - #8322 (closed): the maintainer says `<` is intentional, because when the intended limit is exhausted compaction cannot help and "would need separate continuation behavior". That reasoning breaks when a provider-side cap sits below model.maxTokens, which is our case.
  - #8130 / #8176: wording fixes. #7540: overflow detection for incomplete responses within 1% of the window.
  - #9718: thinking level vs. result is non-monotonic (high 5.8 s stop; medium 62.9 s length; low 39.4 s stop; default high about 60 s length, three times).

1) OPENAI CODEX CLI (openai/codex @95ec468)
- Detection [V]:
  - `response.incomplete` with any reason other than content_filter/interrupted becomes `ApiError::Stream("Incomplete response returned, reason: …")` (`codex-rs/codex-api/src/sse/responses.rs:418-434`).
  - That maps to `CodexErr::Stream` (`api_bridge.rs:55-59`), which is retryable (`protocol/src/error.rs:397-437`).
  - There is no thinking-only vs. partial distinction.
  - `context_length_exceeded` becomes ContextWindowExceeded (`sse/responses_error.rs:48`).
- Recovery [V]:
  - The whole sampling request is re-sent unchanged, discarding partial output, with backoff (`core/src/responses_retry.rs:87-90,141-166`).
  - Up to `stream_max_retries`: default 5, hard cap 100 (`model-provider-info/src/lib.rs:67-73,506-509`).
  - Codex sends no max_output_tokens at all: `ResponsesApiRequest` has no such field (`codex-api/src/common.rs:279-304`). Truncation can only come from server-side limits.
  - A real overflow is not retried. It marks tokens as full and ends the turn with an error (`core/src/session/turn.rs:1688-1691`). Compaction runs before the next sampling (`turn.rs:1306-1325`). If compaction itself overflows, it drops the oldest items (`compact.rs:338-346`).
- Rationale: none stated.
- [I] Repeating an identical request against a deterministic cap costs up to 6× output tokens for nothing.

2) CLAUDE CODE (npm @anthropic-ai/claude-code-linux-x64 2.1.292, bundled JS read via `strings`; changelog @765f236)
- Detection [V]:
  - stop_reason max_tokens yields an api-error message ("Claude's response exceeded the N output token maximum … CLAUDE_CODE_MAX_OUTPUT_TOKENS", apiError "max_output_tokens").
  - `model_context_window_exceeded` is mapped to the same apiError.
  - Real overflow ("prompt too long") goes to a separate reactive-compaction path: one attempt plus a deeper pass, and an "autocompact_thrashing" breaker for repeated refills.
  - [D] When input + max_tokens is over the limit, it first retries with a smaller max_tokens and compacts only when that cannot fit (docs/errors "retries").
- Recovery for max_tokens [V], in the query loop:
  - `maxOutputTokensRecoveryCount`, limit `kr=3`.
  - It keeps the truncated assistant message and appends a meta user message: "Output token limit hit. Resume directly — no apology, no recap … Pick up mid-thought … Break remaining work into smaller pieces."
- Thinking-only case [V]:
  - `Lp()` checks that the response is a single signed thinking block, stop_reason max_tokens, the server flag `resumable === true`, and ≥2048 tokens of context headroom.
  - If all hold, it resends with `resumeIncompleteThinking` and no nudge (thinking-block resumption). This is behind the feature flag `tengu_thinking_block_resumption`.
  - A separate one-shot nudge covers end_turn responses with no visible text: "[Your previous response had no visible output…]" (`thinkingOnlyNudged`). The changelog entry is 2.1.183.
- Other [V]:
  - A per-call `maxOutputTokensOverride` is dropped on recovery transitions.
  - Truncated-stream recovery (network cut) uses different texts for main vs. subagent.
- [D] Changelog:
  - 2.1.0: "automatically continue when response is cut off due to output token limit".
  - 2.1.77: Opus 4.6 default output raised to 64k, upper 128k.
  - 2.1.288: thinking-only responses are retried after mid-response timeouts.
- [D] Env vars: CLAUDE_CODE_MAX_OUTPUT_TOKENS is capped per model, and an unknown model gets a default of 32000. [I] That may explain a 32000 proxy cap; I could not verify the proxy.
- Preserved state: the partial assistant output stays in history (the api-error message is filtered out).
- Source is closed. Evidence is minified identifiers and string literals, cited by name.

3) OPENCODE (sst/opencode → anomalyco/opencode @ecc4916, opencode 1.18.35)
- Detection [V]: "max_output_tokens" ⇒ "length" (`packages/llm/src/protocols/openai-responses.ts:526`).
- Recovery [V]: none for length.
  - The loop exits when finish ∉ {tool-calls, unknown} and there are no tool calls (`packages/opencode/src/session/prompt.ts:1111-1129`). A thinking-only length stop just ends the turn.
  - If tool calls are present, the loop continues.
- Output cap [V]: OUTPUT_TOKEN_MAX = 32000 by default (`provider/transform.ts:18,1481-1483`), overridable with OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX (`effect/runtime-flags.ts:52`).
- Overflow [V]:
  - ContextOverflowError is never retried (`session/retry.ts:87`).
  - It sets `needsCompaction` (`processor.ts:621-631`); threshold check at `processor.ts:490-495`.
  - Compaction replays the last user message and adds a "Continue if you have next steps" message (`compaction.ts:340-356,527-531`).
  - If even compaction overflows, the session stops with an error (`compaction.ts:450-458`).

4) AIDER (Aider-AI/aider @5dc9490, 0.86.3.dev)
- Detection [V]: finish_reason == "length" raises FinishReasonLength (`aider/coders/base_coder.py:69,1893-1911`).
- Recovery [V]:
  - If the model supports assistant prefill, the accumulated text is appended as an assistant message with `prefix=True` and the request is re-issued (`base_coder.py:1492-1505`).
  - This is a `while True` loop with no retry cap; only context exhaustion stops it.
  - Reasoning is stripped (`base_coder.py:1986-1992`).
  - Without prefill support: "exhausted", plus an output-limit diagnostic (`base_coder.py:1532-1544`, show_exhausted_error).
  - ContextWindowExceeded is treated as exhausted, with no auto-compaction (`base_coder.py:1464-1466`).
- [D] Rationale in docs ("infinite output", `aider/website/docs/more/infinite-output.md:12-36`): joining across boundaries "requires some heuristics, but is typically fairly reliable".
- [D] Anthropic: you can't prefill while thinking is on (thinking.md, "Limits and feature compatibility"). So this technique does not apply to the observed Opus xhigh case.

5) CLINE (cline/cline @5b67631, sdk/agents 0.0.91)
- [V] `sdk/packages/agents/src/agent-runtime.ts`:
  - A max-tokens turn with no tool calls first gets one forced compaction plus retry per run (`1361-1369,1425-1445,1479-1507`).
  - Stated rationale: local llama.cpp/ollama/LM Studio servers "cap generation at whatever context remains".
  - If there is nothing to compact, the truncated turn is kept.
  - After that comes a nudge-and-retry: MAX_TOKENS_RECOVERY_LIMIT = 3 consecutive, counter reset by any turn with a tool call (`61-75,923-937,1161-1179`). Nudge: "keep responses concise: take one small step… write large files … in smaller chunks".
  - Then it throws "Model reached the maximum output token limit…".
  - Turns with tool calls go through the normal loop.
  - Context overflow: one compaction plus retry, then a terminal error (`1370-1406`).
  - The partial answer is "never lost" (`1462-1467`).
  - No thinking-only distinction.
- [I] Cline's compaction step has the same flaw as pi when the cap comes from a proxy. It is softened by "nothing to compact ⇒ skip".

6) ROO CODE (RooCodeInc/Roo-Code @b867ec9, 3.53.0; last commit 2026-05-15)
- [V] Does not inspect finish_reason length at all.
- Response with no text or tool use (including reasoning-only) [V]:
  - it pops the user message and auto-retries with backoff, showing MODEL_NO_ASSISTANT_MESSAGES after the 2nd failure (`src/core/task/Task.ts:3315-3321,3518-3560`);
  - text without a tool call gets a noToolsUsed nudge (`3481-3500`).
- Context window error [V]: forced truncation to 75%, up to 3 times (`Task.ts:134-135,4202-4214`).

7) GEMINI CLI (google-gemini/gemini-cli @ef59c53, core 0.65.0-nightly)
- [V] `packages/core/src/core/geminiChat.ts`:
  - No tool call, empty text, MAX_TOKENS ⇒ InvalidStreamError MAX_TOKENS_EXCEEDED (`1594-1599`). Thinking-only without MAX_TOKENS ⇒ THINKING_ONLY_RESPONSE (`1617-1621`).
  - Content errors retry the same request, discarding it, up to 4 attempts with 1/2/4 s backoff (`104-108,725-770`).
  - Then the user sees "…truncated… try /compress" (`utils/constants.ts:20-27`).
  - MAX_TOKENS with text or a tool call is accepted; the UI shows "Response truncated due to token limits." (`cli/src/ui/hooks/useGeminiStream.ts:1333`).
- Overflow [V]: proactive. It tries compression first, then emits a ContextWindowWillOverflow event when the estimated request exceeds what remains (`core/client.ts:703-725`).

8) GOOSE (block/goose @8c0c409, 1.54.0)
- [V] Partial tool calls:
  - On the Responses API, completed function_calls survive and `in_progress` ones are dropped; the turn is flagged `output_token_limit_reached` (`crates/goose-provider-types/src/formats/openai_responses.rs:126,1280-1295`; test at `1537-1566`).
  - On Bedrock, truncated tool JSON becomes an error tool request telling the model to raise max_tokens or use smaller steps (`crates/goose/src/providers/bedrock.rs:850-905`).
- [V] The output-limit flag excludes a turn from the empty-turn retry (MAX_EMPTY_TURN_RETRIES = 3) (`agents/agent.rs:90-92,3418-3432`). It is surfaced as ACP StopReason::MaxTokens (`acp/server.rs:742-750`).
- [I] So a thinking-only length stop ends the turn; there is no continuation.
- Overflow [V]: compaction, with a second failure being terminal (`agent.rs:3266-3290`).

9) OPENHANDS (main repo is now frontend-only; the agent lives in OpenHands/software-agent-sdk @91ac058, sdk 1.53.0)
- [V] Ignores finish_reason.
  - Classification by content: TOOL_CALLS, CONTENT, REASONING_ONLY, EMPTY (`openhands-sdk/openhands/sdk/agent/response_dispatch.py:54-78`).
  - REASONING_ONLY or EMPTY: the message is kept and a corrective user nudge "use a tool to proceed" is added (`response_dispatch.py:272-301,364-389`). It is bounded only by the generic max-iterations and stuck detector.
  - Context exceeded triggers a CondensationRequest, otherwise it raises (`agent/agent.py:858-871`).
  - Default output cap is 16384 when metadata is ambiguous (`llm/llm.py:202`).

10) OH-MY-PI (can1357/oh-my-pi @355b5d9, coding-agent 18.8.0) — the most refined and the closest analogue
- [V] `packages/coding-agent/src/session/session-maintenance.ts:3047-3178`, case 3, "Output-side incomplete":
  - `windowExhausted` = context tokens > compaction threshold.
  - If the window is not exhausted and the turn delivered something: keep the truncated turn and warn (`3060-3075`).
  - Otherwise try model promotion, then:
    - not exhausted: drop the turn, inject `prompts/system/length-stop-retry.md` (it tells the model the response hit the N-token limit "while still reasoning", to "Reason only about the next step, then call the tool", and to write a minimal deliverable first), then retry (`3130-3160`);
    - exhausted: compact (`3162-3170`).
  - Capped by INCOMPLETE_RECOVERY_MAX_RETRIES = 3 (`152`). On exhaustion it drops the turn durably and sets a terminal error so the task executor does not re-prompt into the same loop (`3109-3128`).
  - The counter resets only on delivered content (text, tool call or image). Signed reasoning alone does not count (`2784-2788`; `messages.ts:545-547,595-597`).
- [D] Stated rationale in code comments: "shrinking the input cannot raise an output cap"; "Re-sending the same context re-runs the same plan into the same cap".
- [V] Length stop with tool calls: synthetic "length" results, and the loop continues (`packages/agent/src/agent-loop.ts:1665-1688`). Empty stops: 3 retries with a developer reminder (`turn-recovery.ts:93,951-1028`).

11) PROVIDER GUIDANCE
- Anthropic [D]:
  - Thinking counts toward max_tokens, which is a strict limit (thinking.md "Thinking and the context window").
  - Troubleshooting for "stop_reason: max_tokens": raise max_tokens or lower effort, and pick based on "whether the truncated responses needed the reasoning" (thinking-troubleshooting.md; thinking-steering-and-cost.md).
  - For Opus at xhigh/max: "start at 64k tokens" (effort.md).
  - Changing effort or budget_tokens invalidates cache breakpoints.
  - No prefill while thinking.
  - An incomplete tool_use at max_tokens should be retried with a higher max_tokens (handling-stop-reasons.md "Incomplete tool use blocks").
  - The "ensuring complete responses" example caps continuation at 3 attempts with "Please continue".
  - model_context_window_exceeded should be treated as a truncation.
- OpenAI [D] (reasoning.md):
  - incomplete with reason max_output_tokens can happen "before any visible output tokens", so you still pay for the reasoning.
  - Reserve at least 25,000 tokens for reasoning and output.
  - Pass reasoning items back.
  - `configuration_update` changes effort without breaking the prompt cache (GPT-6 family only).

COMPARISON
| Tool | (a) thinking-only | (b) partial text / tool calls | (c) real overflow | Retry cap | Preserved state |
|---|---|---|---|---|---|
| pi 1.0 | not distinguished; compact + retry | tool calls fail; same compaction path | regex / usage; compact + retry | 1 per user turn | attempt omitted |
| Codex | not distinguished; identical retry | discarded; identical retry | error, then pre-turn compaction | 5 (max 100) | nothing |
| Claude Code | thinking resumption (gated), else "Resume directly" nudge | keep partial + nudge | reactive compaction, thrash breaker | 3 | partial kept |
| OpenCode | turn ends | tool calls: continue | compaction + replay | – | kept |
| Aider | n/a (reasoning stripped) | prefill continuation | stop | unbounded | accumulated text |
| Cline | compaction once, then concise nudge | tool calls: normal loop | compaction once | 1 + 3 | partial kept |
| Roo | generic empty-response retry | finish ignored | truncate to 75% | 3 for overflow | – |
| Gemini CLI | identical retry | text accepted with warning | proactive compression | 4 attempts | discarded |
| Goose | surfaced as MaxTokens, turn ends | completed calls run, partial dropped | compaction | 2 for overflow | flagged message |
| OpenHands | REASONING_ONLY nudge | finish ignored | condenser | max iterations | kept |
| oh-my-pi | drop + "next step only" nudge; no compaction below threshold | keep deliverable + warn; tool calls fail | promote / compact | 3, reset on delivery | durable drop + terminal error |


Sources (URL, version or commit, claim) are listed in [length-recovery-sources.json](length-recovery-sources.json). [V] = verified in
source, [D] = docs/changelog/issues, [I] = inference. Claude Code is closed source (minified 2.1.292 bundle).

## What orche does now (src/pi/length-recovery.ts)

Every orche worker session (orche_task workers and orche_spawn sub-workers) classifies each assistant message:

| case | detection | action |
|---|---|---|
| thinking-only length stop | `stopReason: "length"`, no text, no tool call | without context pressure: cancel Pi's recovery compaction (`session_before_compact` → `cancel`; Pi still drops the attempt from the context) and continue once with a next-step nudge (`agent_before_settle` → entry + `continue: true`) |
| cut-off text | length stop with text, no tool call | same, the nudge quotes the last 1500 characters and asks to continue without repeating |
| cut-off tool calls | length stop with tool calls | Pi already fails the calls with synthetic results and continues; compaction cancelled without context pressure |
| real context overflow | provider overflow error, or a length stop with the context at ≥85% of the window / within 16k of it | Pi's own compact-and-retry, unchanged |

Bounds: two consecutive recoveries (reset by any delivered text or tool call); the second one runs one thinking level lower and the
level is restored at the next delivered output or assignment. After that the state is *exhausted*: the worker is asked once to
report with what it has, and if that also overruns the assignment fails with `Output limit: N consecutive responses hit the
model's output token limit …` — never a silent `no_result`. Every stop and decision is a `length_stop` event in the record, and the
result says `Output limit: …`. `lengthRecovery: { mode: "off" }` in `SessionOptions` restores Pi's behaviour.

The default thinking level is never lowered up front: the survey found no evidence that it helps in general (pi#9718: non-monotonic),
and lowering effort is a quality trade-off (Anthropic) that invalidates the prompt cache.

## Benchmark (experiments/length-recovery)

Run: `npx tsx experiments/length-recovery/run.ts 3` (about 2 minutes, no network, no paid call). Results:
[results/length-recovery/bench-2026-10-07.md](../results/length-recovery/bench-2026-10-07.md) and `.json` (with the strategies,
assumptions, orche commit and pi-coding-agent version). Regression test: test/pi/length-recovery.test.ts.

**What runs.** Each scenario spawns an orche worker through `AgentManager` and the session factory, which wires the production
recovery (src/pi/length-recovery.ts) with the strategy's options (bench.ts `STRATEGIES`); Pi's own `AgentSession` (pi-coding-agent
1.0.0, the repository's devDependency; the user's global pi is 1.0.4) does compaction and overflow/length recovery. Nothing per
strategy is hard-coded in the benchmark: P0 is the production code with `mode: "off"` (only counting), and the test asserts that
the shipped defaults produce the same run as `P2_nudge_stepdown_cap2`.

**Fixture (assumptions).** A faux model with `contextWindow` 1M and `maxTokens` 128k (as the catalog says), a 40k-token context, and
overruns of 32,000 thinking tokens with no text (as observed through the proxy). Seven model behaviours, scripted in bench.ts
`MODELS`: `transient` (one overrun), `needs_nudge` / `needs_two_nudges` (acts after one / two next-step instructions),
`effort_bound` (overruns at thinking high or above), `stubborn` (always), `partial_text` (cut-off text once), `real_overflow`
(a provider context-overflow error once). They are deterministic; 3 repeats gave identical results.

**Counts (measured in the run).** `requests` = faux provider calls including Pi's compaction summarizer; `summarizer` = those
summarizer calls; `compactions` = compactions that completed (a cancelled one calls no summarizer); `length stops` = assistant
messages with `stopReason: "length"`; `identical resends` = worker requests whose messages equal the previous request's; tokens as
the faux provider counts them (about 4 characters per token, not a real tokenizer), summarizer input/output included.

**Estimates (not measured).** `est. $` uses assumed Claude Opus 4/4.1 list prices (USD 15 / 75 per million input / output tokens,
cache write 1.25×, cache read 0.1×; not checked against today's price list, and the proxy's billing is unknown); `est. s` assumes
60 output tokens/s, 20k input tokens/s and 1 s per request. Both are in bench.ts `ASSUMPTIONS`; the counts do not depend on them.

**Not measured.** Real-model answer quality, real latency, and how often a real model behaves like any fixture. The ranking says which
mechanism handles which assumed behaviour at what token cost; it does not show that a real model performs better.

| strategy | model behaviour | reported | outcome | requests | summarizer | compactions | length stops | identical resends | output tok | input tok | est. $ | est. s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P0_pi_default | transient | yes | completed | 4 | 1 | 1 | 1 | 0 | 32055 | 122005 | 4.40 | 544 |
| P0_pi_default | needs_nudge | no | no_result | 6 | 2 | 2 | 4 | 0 | 128042 | 250532 | 13.77 | 2153 |
| P0_pi_default | needs_two_nudges | no | no_result | 6 | 2 | 2 | 4 | 0 | 128042 | 250532 | 13.77 | 2153 |
| P0_pi_default | effort_bound | no | no_result | 6 | 2 | 2 | 4 | 0 | 128042 | 250532 | 13.77 | 2153 |
| P0_pi_default | stubborn | no | no_result | 6 | 2 | 2 | 4 | 0 | 128042 | 250532 | 13.77 | 2153 |
| P0_pi_default | partial_text | yes | completed | 4 | 1 | 1 | 1 | 0 | 67 | 122005 | 2.00 | 11 |
| P0_pi_default | real_overflow | yes | completed | 4 | 1 | 1 | 0 | 0 | 55 | 122005 | 2.00 | 11 |
| P1_nudge | transient | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83229 | 3.93 | 541 |
| P1_nudge | needs_nudge | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83229 | 3.93 | 541 |
| P1_nudge | needs_two_nudges | yes | completed | 4 | 0 | 0 | 2 | 0 | 64034 | 147432 | 7.53 | 1079 |
| P1_nudge | effort_bound | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275769 | 17.05 | 2685 |
| P1_nudge | stubborn | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275769 | 17.05 | 2685 |
| P1_nudge | partial_text | yes | completed | 3 | 0 | 0 | 1 | 0 | 46 | 83217 | 1.53 | 8 |
| P1_nudge | real_overflow | yes | completed | 4 | 1 | 1 | 0 | 0 | 55 | 122005 | 2.00 | 11 |
| P2_nudge_stepdown | transient | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83229 | 3.93 | 541 |
| P2_nudge_stepdown | needs_nudge | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83229 | 3.93 | 541 |
| P2_nudge_stepdown | needs_two_nudges | yes | completed | 4 | 0 | 0 | 2 | 0 | 64034 | 147432 | 7.53 | 1079 |
| P2_nudge_stepdown | effort_bound | yes | completed | 5 | 0 | 0 | 3 | 0 | 96034 | 211635 | 11.17 | 1616 |
| P2_nudge_stepdown | stubborn | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275769 | 17.05 | 2685 |
| P2_nudge_stepdown | partial_text | yes | completed | 3 | 0 | 0 | 1 | 0 | 46 | 83217 | 1.53 | 8 |
| P2_nudge_stepdown | real_overflow | yes | completed | 4 | 1 | 1 | 0 | 0 | 55 | 122005 | 2.00 | 11 |
| P2_nudge_stepdown_cap2 | transient | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83229 | 3.93 | 541 |
| P2_nudge_stepdown_cap2 | needs_nudge | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83229 | 3.93 | 541 |
| P2_nudge_stepdown_cap2 | needs_two_nudges | yes | completed | 4 | 0 | 0 | 2 | 0 | 64034 | 147432 | 7.53 | 1079 |
| P2_nudge_stepdown_cap2 | effort_bound | yes | completed | 4 | 0 | 0 | 2 | 0 | 64034 | 147432 | 7.53 | 1079 |
| P2_nudge_stepdown_cap2 | stubborn | no | failed (Output limit: 4 consecutive responses hit the model's output) | 4 | 0 | 0 | 4 | 0 | 128000 | 211565 | 13.41 | 2148 |
| P2_nudge_stepdown_cap2 | partial_text | yes | completed | 3 | 0 | 0 | 1 | 0 | 46 | 83217 | 1.53 | 8 |
| P2_nudge_stepdown_cap2 | real_overflow | yes | completed | 4 | 1 | 1 | 0 | 0 | 55 | 122005 | 2.00 | 11 |
| P3_plain_continue | transient | yes | completed | 3 | 0 | 0 | 1 | 0 | 32034 | 83040 | 3.93 | 541 |
| P3_plain_continue | needs_nudge | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275201 | 17.04 | 2685 |
| P3_plain_continue | needs_two_nudges | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275201 | 17.04 | 2685 |
| P3_plain_continue | effort_bound | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275201 | 17.04 | 2685 |
| P3_plain_continue | stubborn | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 0 | 160000 | 275201 | 17.04 | 2685 |
| P3_plain_continue | partial_text | yes | completed | 3 | 0 | 0 | 1 | 0 | 46 | 83040 | 1.53 | 8 |
| P3_plain_continue | real_overflow | yes | completed | 4 | 1 | 1 | 0 | 0 | 55 | 122005 | 2.00 | 11 |
| P4_identical_resend | transient | yes | completed | 3 | 0 | 0 | 1 | 1 | 32034 | 83032 | 3.93 | 541 |
| P4_identical_resend | needs_nudge | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 2 | 160000 | 211229 | 15.91 | 2682 |
| P4_identical_resend | needs_two_nudges | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 2 | 160000 | 211229 | 15.91 | 2682 |
| P4_identical_resend | effort_bound | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 2 | 160000 | 211229 | 15.91 | 2682 |
| P4_identical_resend | stubborn | no | failed (Output limit: 5 consecutive responses hit the model's output) | 5 | 0 | 0 | 5 | 2 | 160000 | 211229 | 15.91 | 2682 |
| P4_identical_resend | partial_text | yes | completed | 3 | 0 | 0 | 1 | 1 | 46 | 83032 | 1.53 | 8 |
| P4_identical_resend | real_overflow | yes | completed | 4 | 1 | 1 | 0 | 0 | 55 | 122005 | 2.00 | 11 |

| strategy | reported | silent ends (no report, no error) | requests | compactions | output tok | est. $ | est. s |
|---|---|---|---|---|---|---|---|
| P0_pi_default | 3/7 | 4 | 36 | 11 | 544345 | 63.48 | 9178 |
| P1_nudge | 5/7 | 0 | 27 | 1 | 448203 | 53.02 | 7550 |
| P2_nudge_stepdown | 6/7 | 0 | 27 | 1 | 384237 | 47.14 | 6481 |
| P2_nudge_stepdown_cap2 | 6/7 | 0 | 25 | 1 | 320237 | 39.86 | 5407 |
| P3_plain_continue | 3/7 | 0 | 30 | 1 | 672135 | 75.62 | 11300 |
| P4_identical_resend | 3/7 | 0 | 30 | 1 | 672135 | 71.10 | 11288 |

Decision: `P2_nudge_stepdown_cap2` is the shipped default. On these fixtures it reports in 6/7 cases (Pi's behaviour: 3/7, with 4
silent ends and 11 compactions), with the fewest requests (25 vs 36) and output tokens (320k vs 544k) of all strategies; it is the
only candidate besides P2 with cap 3 that recovers an overrun bound to the effort level. Re-sending the identical request (P4) and a
plain `Continue.` (P3) cannot help an over-planning model and cost the most output. Limits: a model that needs three or more nudges
fails under cap 2 (explicitly); the step-down costs one prompt-cache rewrite on providers where effort is part of the cache key (not
modelled by the faux provider).
