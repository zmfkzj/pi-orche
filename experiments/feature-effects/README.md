# Feature effects: decision memory and SkillCache auto mode

Controlled measurements, with each feature on and off, of two opt-in features:
- **Decision memory**: orche `workerCompaction.decisionMemory`; see `docs/compaction.md`.
- **SkillCache auto mode**: provided by the sibling `pi-skillcache` package; orche passes it to workers as the `skillcache` worker capability.

No model is called. The user's configuration and caches are never touched. Results go to `results/feature-effects/<timestamp>/`, which is not versioned. Results keep aggregates only: no prompt text and no tool output.

```bash
# full run: all recorded worker transcripts and main sessions, 30 timing repetitions
PI_SKILLCACHE_HOME=/var/tmp/<private-dir> npx tsx experiments/feature-effects/cli.ts --reps 30
# options: --out DIR, --limit N (files), --records DIR, --sessions DIR, --skip-records
# model-free assertions of the same harness (skips the SkillCache part without ../pi-skillcache):
npx vitest run test/experiments/feature-effects.test.ts
```

The CLI refuses to run unless `PI_SKILLCACHE_HOME` points outside `~/.pi/agent`. It fails if `~/.pi/agent/skillcache` changed during the run (it compares existence, paths, sizes and mtimes). It also writes `conditions.json` with the orche and provider revisions, the inputs, the sample counts and the result of that check.

## Decision memory (`decision-memory.ts`)

**Arms.** Both arms run with `essentials: "extended"`. The control renders the work log with `renderWorkLog`; the treatment uses `renderDecisionWorkLog`. Each pair is applied to the same ledger and the same Task DAG. The ledger is built with orche's own `recordToolCall`.

**Two sources of cuts:**
1. **Fixture scenarios** with a needed set that is fixed before anything is rendered. Some scenarios are expected to favour decision memory, some the basic log, and one is mixed:
   - cited old evidence
   - resolved-failure noise
   - old unresolved failure (negative)
   - no Task DAG (negative)
   - active-node flood (mixed)
2. **A replay of real orche worker transcripts.** Each transcript is cut at its real compactions, and also at the middle of every assignment with at least 24 calls (synthetic cuts). The independent "needed later" set is the new evidence items the worker wrote after the cut, in task_plan checkpoints or report_result. Those items are classified by orche's `classifyEvidence` against the pre-cut ledger.

**What it measures.** The metrics describe what the restored work log names after a compaction:
- the share of later evidence items that are addressable from it
- the share of unresolved failures it shows, both in total and for unfinished nodes
- stale (already fixed) failures it still shows
- edited files it lists
- its size in UTF-8 bytes
- a size-matched recency baseline (the newest k calls, with k = the number of calls decision memory showed)

**What it does not measure:**
- A real compaction, model behaviour, task success, tokens or cost.
- Output content: both arms name a call only by its id and target, never its output.
- Logs written under decision memory: in the records, the worker that cited evidence after a cut had the basic log, not decision memory's.
- The `T<n>` references: they are reconstructed with orche's documented rule (numbered per assignment, `src/pi/tool-evidence.ts`). The transcripts do not store the appended `[orche ref]` tag, so `refCheck` stays at 0/0.

## SkillCache (`skillcache.ts`)

**The provider's real engine, against a fixture project in the scratch home:**
- A cold run compiles. A new session with the identical prompt gets the replay.
- The replayed evidence is compared with independent direct reads.
- Times are measured with arms interleaved (auto off, miss, hit): the median and p95 of `before_agent_start`, and the compile time at `agent_settled`. The injected bytes are recorded.
- Negative cases:
  - the prompt differs
  - a file was edited, or a file was added to a listed directory
  - the record is older than 14 days
  - the project is untrusted
  - the trace contains bash or an edit
  - a read with offset/limit, a regex grep or an absolute path
  - a failed result
  - an aborted run
  - only ignorable tools
  - a prompt over 8 KB

**The calls-avoided figure** is the ceiling under a fixed consumer policy (a consumer that trusts the replay), not a measured model saving.

**Workload ceiling.** The tool counts exact repeats of a prompt in the same cwd, the traces the provider's compiler accepts, and the potential hits within the 14-day and 8 KB bounds. It does this over the recorded orche worker assignments (`~/.pi/agent/orche/records/*/workers/W<n>-*.jsonl`) and over main sessions (`~/.pi/agent/sessions`). It is an upper bound: it does not check file size or the guard limits.

**The end-to-end test** (`test/experiments/feature-effects.test.ts`) runs an orche worker with the real provider factory as its `skillcache` capability. The same request is sent three times: to the first worker, to a new worker, and as a follow-up to the first worker. The test reports where the prompts differ.

## Measured on 2026-11-14

orche `4d33c72` with the experiment files of this directory; pi-skillcache `aaa3aa0`; Node 24.21.

**Decision memory, real compaction cuts** (n = 799 cuts from 1,345 worker transcripts; 7,165 later evidence items):

| Metric | Basic | Decision |
|---|---|---|
| Later-item recall | 46.1% | 39.6% |
| Bytes, median / p95 | 4,543 / 7,136 | 2,666 / 3,814 |
| Unresolved failures shown (all / unfinished nodes) | 99.4% / 98.7% | 13.8% / 28.8% |
| Stale failures shown | 501 | 0 |

- Paired per cut: decision memory resolves more later items in 135 cuts, the basic log in 319, and 297 are ties.
- The size-matched recency baseline reaches 43.8%, more than decision memory's 39.6%.
- The 1,618 synthetic mid-assignment cuts point the same way: 58.2% for basic against 34.4% for decision memory.

**SkillCache, controlled** (30 interleaved repetitions):
- A warm hit replays 5 of 6 traced calls (the `find` call is ignored). All 5 match the direct reads.
- Injected bytes: 3,991, against 2,766 bytes of raw tool output.
- `before_agent_start` median (p95): 0.22 (0.24) ms with auto off, 1.0 (1.1) ms on a miss, 2.9 (3.1) ms on a hit.
- Compile at settle: 8.3 (8.6) ms.
- Every negative case missed, fell back or never compiled.

**SkillCache, workload:**

| Source | Prompts | Within 8 KB | Exact repeats | Compilable traces | Potential hits |
|---|---|---|---|---|---|
| Worker assignments | 2,133 | 9.2% | 1 | 0 | 0 |
| Main prompts | 2,667 | 69.9% | 237 | 0 | 0 |

**End to end:** two identical hand-offs to new workers differ in the worker's scratch path (`.../W1` against `.../W2`), so each compiles a new record and none replays.
