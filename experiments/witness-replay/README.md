# witness-replay (experimental harness, not product behaviour)

The pilot asks one question: does an executable, unadapted public reproducer that is enforced at candidate acceptance (arm T) repair bugs that ordinary bounded revision (arm C) does not?

**Status: stopped at R1.** Only one failure family qualified. No counted session was run, and `freeze` refuses the default pilot through `r1Gate`. See `results/witness-replay/{AUDIT,REPORT}.md`.

## Files

| File | What it does |
|---|---|
| `protocol.ts` | Pure rules: model route (`cliproxyapi/gpt-6.1-sol`, effort `high`), budget, seeds, the arm-free prompt, the T-only gate message, the schedule, attempt classification, the acceptance rule (`afterTurnEnd`, `acceptanceHolds`) and the preregistered decision (`decide`). |
| `proxy.mjs` | Per-unit proxy on a unix socket. Fails closed: refuses unverifiable or off-route requests and configuration updates. Journals each request start before forwarding, enforces the request budget across continuations and swaps in the real key. |
| `bridge.mjs` | Forwards TCP to that socket inside the sandbox. |
| `sandbox.ts` | bubblewrap wrapper. Unshares net, pid, ipc and uts. Mounts `/` read-only and hides `/home`, `/tmp`, `/run`, `/opt` and similar roots behind tmpfs. Clears the environment and kills the whole group on timeout. |
| `witness-run.ts` | Mechanical reproducer run (statuses: pass, fail, untrusted, tampered, error). Checks the frozen sha256 of the reproducer and the candidate's digest copy, mounted read-only. Checks for import-root hooks, the per-run nonce and exit-code agreement, and records protocol-aware files. |
| `env.ts` | Workspace staging (original commit plus the seed working tree), wrappers and private venv copies. |
| `unit.ts` | One unit: verifies the frozen inputs (reproducer, prompt, seed tree, Pi CLI, global node_modules and node digests), then runs Pi in the sandbox under one session id. In T, it gates every turn end. |
| `freeze.ts` | Writes the never-overwritten `frozen/plan.json`. The seed is rebuilt from the archived `final.diff`, and freezing guards against overlap with hidden lines. |
| `evaluate.ts`, `grade-child.ts` | Evaluation: witness, held-out check, F2P/P2P, integrity (original→final and seed→final), visible new failures, leak/network scan. |
| `audit.ts` | R1 audit and the tox line-71 experiment. |
| `audit-native.ts` | R9: the Narwhals issue's reproduction (`audit-only/nw-3478-pyspark.py`) on real PySpark with a JVM, in two hash-pinned closures (see "Native PySpark audit"). It freezes the witness and environment manifest before running and never overwrites its output. |
| `witnesses/`, `heldout/`, `audit-only/` | Public reproducers, evaluation-only checks and audit-only replays. Each file's docstring lists its provenance. |

## Commands

Run from the repo root. `<out>` is a results directory, `<scratch>` is private scratch.

```
node --import tsx experiments/witness-replay/cli.ts audit|audit-tox-line71 <out> <scratch>   # R1, model-free
node --import tsx experiments/witness-replay/cli.ts audit-nw-native <out> <scratch> <native env dir>   # R9, model-free
node --import tsx experiments/witness-replay/cli.ts freeze <out> <scratch>                   # before any outcome; refuses to overwrite
node --import tsx experiments/witness-replay/cli.ts smoke|smoke-gate <out> <scratch>         # harness validation, not counted
node --import tsx experiments/witness-replay/cli.ts run|evaluate <out> <scratch>; ... decide <out>; ... status <out>
node --import tsx experiments/witness-replay/cli.ts probe <out> <scratch> <unit> [cmd]       # model-free look into a unit's sandbox
npx vitest run test/experiments/witness-replay.test.ts
```

The upstream is `http://127.0.0.1:8317` (cliproxyapi). The key is read from `~/.pi/agent/cliproxyapi.json` by the proxy only; the sandbox sees a placeholder. No global config is changed.

## Native PySpark audit

The native environment is built only in private scratch `<N>`. The steps run under bubblewrap with `/home` hidden. Network is allowed for the downloads only, and nothing outside `<N>` is written. The variables are `UV_CACHE_DIR=<N>/uv-cache`, `UV_PYTHON_INSTALL_DIR=<N>/python` and `HOME=<N>/home`.

- **Task closure.** Install PySpark 4.1.1 and py4j 0.10.9.9 next to the task's read-only venv:
  `uv pip install --python <task venv>/bin/python --target <N>/site-pyspark-4.1.1 --no-deps --require-hashes -r <N>/requirements.txt`
- **Issue closure.** Use the versions the issue recorded:
  `uv python install 3.12.12`, then `uv pip compile --python-version 3.12 --generate-hashes -o <N>/issue-env.txt <N>/issue-env.in`, then `uv venv <N>/venv-issue`, then `uv pip install --python <N>/venv-issue/bin/python --require-hashes --link-mode copy -r <N>/issue-env.txt`.
  The input file `issue-env.in` pins `pyspark==4.1.1`, `py4j==0.10.9.9`, `pyarrow==23.0.0`, `pandas==2.3.3` and `numpy==2.4.2`.
- **JVM.** The user-local Temurin JDK 17 (`~/.local/opt/jdk-17`) is bound read-only; override it with `WITNESS_REPLAY_JDK`.

The runs themselves have no network. Spark runs in local mode on loopback with `TZ=UTC`, and the requirement files are copied next to the results.
