| Arm | Task | Hidden-test grade | Wall s | Main delegated | Orchestrator split [sub-workers] | Requests main / orche | Tokens in / out / cache read / cache write | Main context max | Provider cost | Catalog cost | Parity |
|---|---|---|---:|---|---|---|---|---:|---:|---:|---|
| orchestrator | p1-ticket-batch | pass | 416 | implement | none | 3 / 17 | 73k / 49k / 599k / 0k | 16k | $0.08 | $1.40 | ok |
| orchestrator | p1-ticket-batch-parallel-request | pass | 412 | implement | parallelism [csv:implement/done 12req 97s, ratelimit:implement/done 13req 122s, cache:implement/done 11req 242s, semver:implement/done 11req 180s] | 4 / 59 | 149k / 87k / 1100k / 0k | 16k | $1.96 | $2.56 | ok |
