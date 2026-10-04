# Validation — p2-handler-migration

Conclusion: PASS. Every starter unit fails its own hidden group; each isolated reference passes with all other source bytes still at starter state. No specification deviations.

## Size and independent units

- repo/src: 57 files, 3732 physical lines (including comments/blanks).
- repo/: 60 files; hidden acceptance: 32 top-level tests.
- Correct unit implementations are 80–250 lines each; reference also adds one regression-test file per unit.
- Source counts are checked mechanically; surrounding metadata/runtime code is reachable through src/cli.mjs.

| Unit | Hidden tests | Starter failed | Isolated reference passed | Other sources |
| --- | ---: | ---: | ---: | --- |
| users | 5 | 4 | 5 | SHA-256 identical |
| orders | 6 | 5 | 6 | SHA-256 identical |
| inventory | 5 | 4 | 5 | SHA-256 identical |
| search | 5 | 4 | 5 | SHA-256 identical |
| uploads-metadata | 5 | 4 | 5 | SHA-256 identical |
| reports | 6 | 5 | 6 | SHA-256 identical |

## Commands and outcomes

`npm run validate:suite -- --tasks p1-ticket-batch,p2-handler-migration,p3-library-features-ko` → exit 0, 3/3 validated, 0 violations; schema/loadSuite PASS (31 tasks), byte-identical repo-only workspace isolation PASS; starter hidden FAIL (required), reference visible+hidden PASS.

Production output: `../p1-ticket-batch/SUITE-VALIDATION.log` (contains all three tasks). Extra fixture-level validation files are not copied into solver workspaces.

`node fixtures/suite/p1-ticket-batch/validate-independence.mjs` → PASS for all 13 units; only the selected unit source and its regression test are overlaid. Baseline and reference run `node --test --test-reporter=tap --test-name-pattern=^<unit>: test/acceptance.test.mjs` in fresh temporary directories. Every unrelated source is hash-checked after overlay.

- node --check: PASS on 71 fixture .mjs files (including reference and test files).
- Starter node --test: PASS (minimal visible smoke).
- Starter node src/cli.mjs --help: PASS (imports all administration scaffolds).
- Per-unit smoke + added reference regression: PASS.
- Full reference node --test: PASS, 39/39 tests.
- All local checks run with TZ=America/New_York; no sleeps, network, or wall-clock reads.
- No repository commits or pushes were made. Production validator initializes only disposable solver workspaces.
