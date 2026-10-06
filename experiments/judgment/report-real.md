# Split-judgment evaluation on real-session requests: results

Runs (results/judgment-real/runs, gitignored): 2026-10-06T12-26-13-025Z-real-gpt-6.1-sol, 2026-10-06T12-26-13-033Z-real-claude-opus-5-5. Main model: cliproxyapi/claude-opus-5-5. Items: 87 (77 scored, 10 uncertain, excluded from the main metrics). Labels: {"none":75,"verification":2,"uncertain":10}.

## All scored items

| Model | Variant | Calls | Parse fail | Accuracy | False split | Unnecessary parallel | False isolation | False / missed verification | Consistency | Provider $ |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| claude-opus-5-5 | checklist | 154 | 0 | 95.5% | 2.0% | 0.0% | 1.3% | 0.7% / 100.0% | 98.7% | $2.35 |
| claude-opus-5-5 | fewshot | 154 | 1 | 93.5% | 4.7% | 3.2% | 0.6% | 1.3% / 50.0% | 98.7% | $2.38 |
| claude-opus-5-5 | checklist-sized | 154 | 0 | 94.8% | 2.7% | 0.0% | 1.3% | 1.3% / 100.0% | 100.0% | $2.19 |
| gpt-6.1-sol | checklist | 154 | 0 | 94.8% | 2.7% | 0.0% | 1.3% | 1.3% / 100.0% | 100.0% | $0.78 |
| gpt-6.1-sol | fewshot | 154 | 1 | 94.8% | 4.7% | 1.9% | 0.6% | 2.0% / 0.0% | 96.1% | $0.79 |
| gpt-6.1-sol | checklist-sized | 154 | 0 | 96.1% | 1.3% | 0.0% | 1.3% | 0.0% / 100.0% | 100.0% | $0.80 |

**Selection (cliproxyapi/claude-opus-5-5):** checklist — best accuracy 0.955; within one item: checklist, checklist-sized. Eligible: checklist, fewshot, checklist-sized.

## By kind (split rate on none = false split; on verification = hit rate)

| Model | Variant | none/one-module (n=26) | none/several-modules (n=23) | none/small (n=26) | verification (n=2) |
|---|---|---:|---:|---:|---:|
| claude-opus-5-5 | checklist | 0.0% | 4.3% | 1.9% | 0.0% |
| claude-opus-5-5 | fewshot | 3.8% | 6.7% | 3.8% | 50.0% |
| claude-opus-5-5 | checklist-sized | 0.0% | 4.3% | 3.8% | 0.0% |
| gpt-6.1-sol | checklist | 0.0% | 4.3% | 3.8% | 0.0% |
| gpt-6.1-sol | fewshot | 2.0% | 8.7% | 3.8% | 100.0% |
| gpt-6.1-sol | checklist-sized | 0.0% | 4.3% | 0.0% | 0.0% |

## By project (anonymous ids; false split on none items)

| Model | Variant | P02 (n=1) | P03 (n=1) | P04 (n=1) | P05 (n=2) | P08 (n=2) | P09 (n=2) | P10 (n=1) | P11 (n=2) | P12 (n=7) | P13 (n=2) | P14 (n=2) | P15 (n=2) | P17 (n=2) | P18 (n=3) | P19 (n=3) | P20 (n=1) | P21 (n=1) | P22 (n=2) | P23 (n=3) | P25 (n=1) | P27 (n=4) | P28 (n=2) | P29 (n=8) | P30 (n=1) | P31 (n=5) | P32 (n=1) | P33 (n=7) | P35 (n=2) | P37 (n=1) | P38 (n=1) | P40 (n=1) | P45 (n=2) | P46 (n=1) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| claude-opus-5-5 | checklist | 0.0% | 0.0% | 0.0% | 25.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 14.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| claude-opus-5-5 | fewshot | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 50.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 50.0% | 0.0% | 0.0% | 0.0% | 0.0% | 25.0% | 0.0% | 0.0% | 0.0% | 7.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| claude-opus-5-5 | checklist-sized | 0.0% | 0.0% | 0.0% | 50.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 14.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| gpt-6.1-sol | checklist | 0.0% | 0.0% | 0.0% | 50.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 14.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| gpt-6.1-sol | fewshot | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 50.0% | 33.3% | 0.0% | 0.0% | 0.0% | 25.0% | 0.0% | 0.0% | 0.0% | 14.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 50.0% |
| gpt-6.1-sol | checklist-sized | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 14.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Uncertain items (not scored): split rate

| Model | Variant | Split rate | Criteria named |
|---|---|---:|---|
| claude-opus-5-5 | checklist | 0.0% | – |
| claude-opus-5-5 | fewshot | 10.0% | verification 2 |
| claude-opus-5-5 | checklist-sized | 0.0% | – |
| gpt-6.1-sol | checklist | 0.0% | – |
| gpt-6.1-sol | fewshot | 10.0% | verification 2 |
| gpt-6.1-sol | checklist-sized | 0.0% | – |

## Wrong answers by cause (calls)

| Model | Variant | Causes |
|---|---|---|
| claude-opus-5-5 | checklist | missed verification: 4; false isolation (several-modules): 2; false verification (small): 1 |
| claude-opus-5-5 | fewshot | false verification (several-modules): 2; false parallelism (one-module): 2; false parallelism (small): 2; missed verification: 2; false parallelism (several-modules) + false isolation (several-modules): 1; parse failure: 1 |
| claude-opus-5-5 | checklist-sized | missed verification: 4; false verification (small): 2; false isolation (several-modules): 2 |
| gpt-6.1-sol | checklist | missed verification: 4; false verification (small): 2; false isolation (several-modules): 2 |
| gpt-6.1-sol | fewshot | false verification (several-modules): 2; false parallelism (small): 2; false isolation (several-modules): 1; false verification (one-module): 1; parse failure: 1; false parallelism (several-modules): 1 |
| gpt-6.1-sol | checklist-sized | missed verification: 4; false isolation (several-modules): 2 |

Total: provider $10.53, 1044 calls, 0 without an answer.
