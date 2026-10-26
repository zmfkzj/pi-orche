# headroom-pool (experimental harness, not product behaviour)

Acquire NEW public failure cases with measured `cliproxyapi/gpt-6.1-sol` (effort `high`) headroom for a later witness-continuity
comparison, without running that comparison. Protocol: `results/headroom-pool/PROTOCOL.md`; state: `results/headroom-pool/STATUS.md`.

| file | role |
|---|---|
| `protocol.ts` | pure frozen rules: route, pools, exposure rule, prescreen, order, E1–E7, install table, prompt, attempt classification, schedule, promotion, families, stop rule, Clopper–Pearson (per-case confirmation sessions only) |
| `exposure.ts`, `pool.ts` | model-free exposure scan of the ignored `results/` tree and the frozen pools |
| `envbuild.ts`, `cases.ts` | E1 native environments (uv CPython, base-commit snapshot, bounded install, sealed venv, import check), packets, grader data, sandboxed test runs |
| `qualify.ts`, `eligibility.ts`, `witnesses/` | witness authoring aid, E4/E5/E7 qualification history, rejections, screening table; `witnesses/TEMPLATE.txt` |
| `freeze.ts` | the calibration freeze (runtime, cases, witness copies, hidden-overlap guard, harness and protocol hashes) |
| `unit.ts`, `score.ts`, `driver.ts` | one Sol/high baseline attempt (sandbox + fail-closed proxy from `../witness-replay`), model-free scoring, the bounded driver |
| `smoke.ts` | synthetic harness validation (never a pool case) and a sandbox visibility probe |
| `analyze.ts` | model-free calibration summary: public-witness pass/fail labels with definitions, hidden F2P / regression / integrity / validity kept separate, promotion and families on raw outcomes, ledger; descriptive counts, no pooled interval |
| `cli.ts` | commands (see `results/headroom-pool/STATUS.md`) |

Tests: `npx vitest run test/experiments/headroom-pool.test.ts`.
