# headroom-pool (experiment, not product behaviour)

Purpose: find new public bug reports where `cliproxyapi/gpt-6.1-sol` at effort `high` still fails the issue's own stated
expectation. These cases would feed a later witness-continuity comparison.

How it works:
1. Pools are frozen by a seeded order with an exposure check.
2. Each case gets a native pre-fix environment.
3. A blind author writes a public witness from the issue text; it is qualified natively (fails pre-fix, passes with the
   reference fix offline).
4. The plain bounded Pi baseline is calibrated under a fail-closed model/effort proxy in a no-network sandbox.

Read in this order:
- Protocol and amendments: `results/headroom-pool/PROTOCOL.md`.
- Outcome: `results/headroom-pool/REPORT.md`. It is negative under the frozen promotion rule (a public-witness failure that persists
  into confirmation): 45 witnesses qualified and 40 tasks were calibrated (5 qualified were not), with 2 plain bounded Pi sessions
  each. The public witness passed in all 80 sessions. That is not full-task correctness: hidden F2P, visible regressions and
  infrastructure are reported separately, and no interval or accuracy estimate is claimed.
- Every case: `results/headroom-pool/CASES.md`.
- Harness: `experiments/headroom-pool/` (`cli.ts` lists the commands).
- Tests: `test/experiments/headroom-pool.test.ts`.
