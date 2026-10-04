# Service toolkit
Four independently maintained packages live in src/csv, src/ratelimit, src/cache and src/semver.
The index.mjs in each directory is its ticket entry point; the remaining files are existing
formatters, diagnostics and integration helpers, not replacement implementations.
Shared runtime files support the local CLI and do not need modification.
Run `npm test` (no install required). Add unit regression tests under test/.
All clocks and loaders are injected. No external services are used.
