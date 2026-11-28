# Main's prompt cache during long orche tasks (`mainCache`)

Source: `src/extension/main-cache.ts`, wiring in `src/extension/index.ts` (`attachOptions`, `turn_start`, `cache_warming_decision`),
the release itself in `src/extension/jobs.ts` (`TaskJobs.wait` / `keepalive`), its text in `src/extension/job-view.ts`.

## Why main's cache expires while a worker runs

While an attached `orche_task` (or `orche_task_attach`) waits for its job, main's agent run sits inside that tool call and sends
no model request. Progress updates are UI events only; they never reach the provider. Main's prompt cache entry therefore ages from
the request that made the call. Pi 1.6+ has a built-in **CacheWarmer** (pi-coding-agent `core/cache-warmer.ts`, numbers in pi-ai
`cache-warming.ts`) that replays main's last request with one output token at 90% of the model's `promptCache` lifetime, but:

- it never warms later than **60 minutes** after the real request that started it (30 minutes once main is idle, i.e. after a
  detached job left main without a run), and warm requests do not extend that window;
- it needs the model's `promptCache` lifetime (declared by the provider, e.g. the CLIProxyAPI bundle for Gemini 4 Neon, or
  `models.json` `modelOverrides[...].promptCache`); without one it does nothing;
- each refresh must pass Pi's economics (`expectedSavings >= $0.05`); a model registered with price 0 (subscription routes such as
  CLIProxyAPI's `bts/*`) is "cache economics unavailable", and a priced one with a small prompt is below the threshold: both stop;
- Anthropic budget thinking (no `compat.forceAdaptiveThinking`) cannot be replayed.

With a 1-hour lifetime the CacheWarmer warms once (at 54 minutes) and the entry lives until about 114 minutes after main's last
request; a longer task loses it.

## What orche does

```json
{ "mainCache": { "warming": true, "keepalive": "auto", "assumedTtlMinutes": {}, "fallbackTtlMinutes": 40 } }
```

| value | meaning |
|---|---|
| omitted, `true` | the defaults above |
| `false` | all off: Pi's own warming alone, attached waits are never released for the cache |
| `warming` | `true` (default): while an orche **background job** runs (attached or detached; queued jobs wait for it), every `cache_warming_decision` that Pi resolved to `stop` is returned as `warm`: a model **without prices** ("cache economics unavailable") and a priced model whose refresh Pi found below its $0.05 savings threshold alike. Prices are not faked: session cost totals stay what they were, and warms of priced models are billed. A blocking `orche_task` (`wait:true`, print/JSON mode) is not a background job: Pi's decision stands then, as it does in sessions without a running job. Pi only asks when its own warming is on (`cacheWarming` not `off`), the model declares a `promptCache` lifetime and the request can be replayed. |
| `keepalive` | `"auto"` (default), `false`, or a fixed interval in minutes (`0 < n <= 1440`) for every model |
| `assumedTtlMinutes` | `{ "<provider/id or id, * matches anything>": minutes }`: a cache lifetime to assume for models that declare no `promptCache`; the first matching key wins, so put `"*"` last to override the fallback for all of them. Used by `"auto"` only. Default: none. |
| `fallbackTtlMinutes` | the lifetime assumed for a model with neither a `promptCache` nor a matching `assumedTtlMinutes` key (`"auto"` only): minutes, default **40** (a release every 36 minutes, from the Gemini measurement below), or `false` for no keepalive for such models |

**Keepalive release.** When an attached wait reaches its keepalive time while the job still runs, the call returns with detach reason
`keepalive` (not an error, nothing cancelled) and a one-line result: `Keepalive for J1 (worker W1 implement, running 1h 48m): … Call
orche_task_attach {"job":"J1"} now, as your only action and without any text.` Main's next request reads (and refreshes) the cache,
re-attaches, and Pi's CacheWarmer starts a fresh 60-minute window from that request. The time counts from the start of main's turn
that made the call (`turn_start`, at or before Pi's own warming clock); every attach has its own timer, so a re-attach starts a new
one. If input for main is waiting at that moment (a steer or a woken session-bus note), the call detaches as `input` instead. A job
that ends first returns its result to the call as before; a job that ends between the release and the re-attach delivers its result
once as an `orche-task-result` message (exactly-once delivery is unchanged). Blocking calls (`wait:true`, print/JSON mode),
`wait:false`, `/orche detach`, Esc, steers, peer notes, cancel and queued tasks behave as before.

**`"auto"`** (`keepalivePlan`), from the current main model:

| situation | keepalive after main's last request |
|---|---|
| `promptCache` lifetime declared and Pi will keep warming it (warming not `off`, replayable request, and either the `warming` override during a background job, or Pi's own economics saying `warm`) | the CacheWarmer's last warm inside its 60 minutes (2 minutes of drift allowance) + one lifetime − margin: **1 h → 109 min**, 40 min → 72 min, 5 min → 58 min |
| lifetime declared, Pi will not warm (warming `off`, budget thinking, or `warming: false` for an unpriced model) | one lifetime − margin (1 h → 55 min) |
| lifetime declared, `warming: false`, priced model that Pi stops for its economics (small prompt) | none: a full main request costs more than the one-token refresh Pi declined |
| no `promptCache`, `assumedTtlMinutes` matches | assumed lifetime − margin (40 min → 36 min) |
| no `promptCache`, no match | `fallbackTtlMinutes` − margin (default 40 min → 36 min); none when it is `false` |

The margin is 10% of the lifetime, between 1 and 5 minutes. `"auto"` never releases more often than every 10 minutes: each release
costs main one full request (cache read of the whole prompt plus a few output tokens), which only pays for long prompts. The fallback
also applies to models that cache nothing at all (a release then only costs that request); set `fallbackTtlMinutes: false` for them.

## Gemini (CLIProxyAPI `gemini-4-neon-high` / `-xhigh`): measured, declared as 2400 s

Gemini on CLIProxyAPI uses implicit, provider-managed caching without a documented lifetime. Measured from all local session files on
2026-11-28 (pairs of consecutive requests of the same provider/API/model on the session tree, no compaction or model change between,
errors excluded; hit = second request read at least half of the first one's prompt from cache, zero = read nothing):

| `gemini-4-neon-xhigh` gap | pairs | hit | zero |
|---|---|---|---|
| < 10 min | 1,218 | 91.2–100% per minute bucket | 22 |
| 10–30 min | 561 | 90.9–97.9% per bucket | 28 |
| 30–45 min | 88 | 85 (96.6%) | 2 |
| 45–50 min | 4 | 0 | 4 |
| 50–60 min | 4 | 3 | 0 |
| 60–150 min | 13 | 6 (4 partial) | 3 |
| ≥ 180 min | 6 | 0 | 6 |

Longest hit 108.2 min; zero-read misses as early as 0.2 min. `gemini-4-neon-high` (92 pairs): hits up to 57.5 min, misses at 40.3,
60.2 and 226.7 min. The entry usually survives about 45 minutes. The CLIProxyAPI bundle (`cliproxyapi/` overlay of the provider's
`src/registration.ts`, see its overlay/README.md) therefore declares `promptCache: { short: 2400, long: 2400 }` for exactly these two
models (also routing-prefixed IDs). With it, Pi's CacheWarmer schedules a one-token refresh at 36 minutes; the models are priced 0,
so Pi's economics stop it, and orche's `warming` override sends it while a background job runs; keepalive releases at 72 minutes.
40 minutes is an empirical scheduling estimate, not a provider guarantee: it is not established that the one-token replay renews
Gemini's implicit cache, and Pi's idle horizon (30 minutes once main has no run) still applies. Other Gemini models get the 40-minute
keepalive fallback only. `models.json` `modelOverrides[...].promptCache` overrides the declared value per model.

The tables come from `python3 scripts/cache-gaps.py gemini` (read-only over `~/.pi/agent/sessions`; `GAPS_LIST=1` lists every gap of
30 minutes or more); re-run it before changing the value.

## Miss cost: keep main small (`mainCompaction.maxTokens`)

A miss re-writes main's whole prompt, so its cost grows with main's context. `mainCompaction.usageRatio` alone scales with the
window: on a 1M-token window, `0.5` lets main reach 524k tokens. `mainCompaction.maxTokens` (whole tokens, 30,000 to 10,000,000;
unset by default) compacts above the lower of the two, e.g. `{ "mainCompaction": { "usageRatio": 0.5, "maxTokens": 300000 } }`.
Each compaction itself replaces the prefix once (one full write), so a ceiling far below the working size only trades misses for
compactions. See docs/compaction.md.
