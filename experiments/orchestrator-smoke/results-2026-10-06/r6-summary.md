| Arm | Task | Hidden-test grade | Wall s | Main delegated | Orchestrator split [sub-workers] | Requests main / orche | Tokens in / out / cache read / cache write | Main context max | Provider cost | Catalog cost | Parity |
|---|---|---|---:|---|---|---|---|---:|---:|---:|---|
| baseline-ac1bbf1 | d3-money-migration-ko | pass | 256 | implement | n/a | 3 / 15 | 48k / 32k / 378k / 0k | 14k | $0.09 | $0.90 | ok |
| baseline-ac1bbf1 | p1-ticket-batch | pass | 558 | implement | n/a | 4 / 28 | 85k / 62k / 1191k / 0k | 20k | $0.10 | $1.81 | ok |
| baseline-ac1bbf1 | v1-static-traversal-verify | pass | 389 | implement, verify | n/a | 4 / 32 | 76k / 39k / 682k / 0k | 16k | $0.82 | $1.23 | ok |
| orchestrator | d3-money-migration-ko | pass | 222 | implement | none | 3 / 11 | 42k / 26k / 255k / 0k | 13k | $0.05 | $0.74 | ok |
| orchestrator | p1-ticket-batch | pass | 496 | implement | none | 3 / 27 | 78k / 55k / 978k / 0k | 16k | $0.05 | $1.60 | ok |
| orchestrator | v1-static-traversal-verify | pass | 279 | implement | verification [verify:verify/passed 7req 104s] | 3 / 26 | 68k / 25k / 447k / 0k | 10k | $0.34 | $0.86 | ok |
