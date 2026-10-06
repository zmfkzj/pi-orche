# Split-judgment evaluation v2: results

Runs: 2026-10-06T11-13-37-322Z-main-claude-opus-5-5, 2026-10-06T11-13-37-352Z-main-gpt-6.1-sol, 2026-10-06T11-22-03-764Z-retry-transport-claude-opus-5-5. Main model: cliproxyapi/claude-opus-5-5. Items: 47 (22 agentic, 25 one-turn).

## all

| Model | Variant | Calls | Parse fail | Accuracy | False split | Unnecessary parallel | Missed parallel | False / missed isolation | False / missed verification | Units compatible / exact (n) | Consistency | Provider $ | Catalog $ | Turns (median) |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|
| claude-opus-5-5 | checklist | 94 | 0 | 91.5% | 12.1% | 10.0% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (12) | 100.0% | $2.31 | $2.31 | 1 |
| claude-opus-5-5 | fewshot | 94 | 0 | 87.2% | 18.2% | 10.0% | 0.0% | 0.0% / 0.0% | 10.7% / 0.0% | 100.0% / 100.0% (12) | 93.6% | $2.45 | $2.45 | 1 |
| claude-opus-5-5 | checklist-sized | 94 | 0 | 91.5% | 12.1% | 10.0% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (12) | 100.0% | $2.29 | $2.29 | 1 |
| gpt-6.1-sol | checklist | 94 | 0 | 90.4% | 12.1% | 10.0% | 8.3% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (11) | 97.9% | $1.17 | $1.17 | 1 |
| gpt-6.1-sol | fewshot | 94 | 0 | 89.4% | 12.1% | 7.5% | 8.3% | 0.0% / 37.5% | 0.0% / 0.0% | 100.0% / 100.0% (11) | 95.7% | $1.10 | $1.10 | 1 |
| gpt-6.1-sol | checklist-sized | 94 | 0 | 91.5% | 7.6% | 6.3% | 16.7% | 0.0% / 12.5% | 0.0% / 0.0% | 100.0% / 100.0% (10) | 95.7% | $1.10 | $1.10 | 1 |

**Selection (cliproxyapi/claude-opus-5-5, all items):** checklist — no variant met the eligibility bounds; lowest false split + missed parallelism. Eligible: none.

## agentic

| Model | Variant | Calls | Parse fail | Accuracy | False split | Unnecessary parallel | Missed parallel | False / missed isolation | False / missed verification | Units compatible / exact (n) | Consistency | Provider $ | Catalog $ | Turns (median) |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|
| claude-opus-5-5 | checklist | 44 | 0 | 86.4% | 15.8% | 14.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (2) | 100.0% | $1.59 | $1.59 | 4 |
| claude-opus-5-5 | fewshot | 44 | 0 | 77.3% | 26.3% | 14.3% | 0.0% | 0.0% / 0.0% | 20.5% / 0.0% | 100.0% / 100.0% (2) | 86.4% | $1.78 | $1.78 | 4 |
| claude-opus-5-5 | checklist-sized | 44 | 0 | 86.4% | 15.8% | 14.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (2) | 100.0% | $1.56 | $1.56 | 4 |
| gpt-6.1-sol | checklist | 44 | 0 | 86.4% | 15.8% | 14.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (2) | 100.0% | $0.90 | $0.90 | 4 |
| gpt-6.1-sol | fewshot | 44 | 0 | 86.4% | 15.8% | 14.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (2) | 100.0% | $0.83 | $0.83 | 4 |
| gpt-6.1-sol | checklist-sized | 44 | 0 | 90.9% | 10.5% | 9.5% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (2) | 100.0% | $0.82 | $0.82 | 4 |

## one-turn

| Model | Variant | Calls | Parse fail | Accuracy | False split | Unnecessary parallel | Missed parallel | False / missed isolation | False / missed verification | Units compatible / exact (n) | Consistency | Provider $ | Catalog $ | Turns (median) |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|
| claude-opus-5-5 | checklist | 50 | 0 | 96.0% | 7.1% | 5.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (10) | 100.0% | $0.72 | $0.72 | 1 |
| claude-opus-5-5 | fewshot | 50 | 0 | 96.0% | 7.1% | 5.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (10) | 100.0% | $0.67 | $0.67 | 1 |
| claude-opus-5-5 | checklist-sized | 50 | 0 | 96.0% | 7.1% | 5.3% | 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (10) | 100.0% | $0.72 | $0.72 | 1 |
| gpt-6.1-sol | checklist | 50 | 0 | 94.0% | 7.1% | 5.3% | 10.0% | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% / 100.0% (9) | 96.0% | $0.27 | $0.27 | 1 |
| gpt-6.1-sol | fewshot | 50 | 0 | 92.0% | 7.1% | 0.0% | 10.0% | 0.0% / 75.0% | 0.0% / 0.0% | 100.0% / 100.0% (9) | 92.0% | $0.27 | $0.27 | 1 |
| gpt-6.1-sol | checklist-sized | 50 | 0 | 92.0% | 3.6% | 2.6% | 20.0% | 0.0% / 25.0% | 0.0% / 0.0% | 100.0% / 100.0% (8) | 92.0% | $0.28 | $0.28 | 1 |

## Wrong answers (item#rep: label -> answer)

- claude-opus-5-5 checklist: p3#1:none->parallelism, p1#1:none->parallelism, p2#1:none->parallelism, p1#2:none->parallelism, p3#2:none->parallelism, p2#2:none->parallelism, n15#1:none->parallelism, n15#2:none->parallelism
- claude-opus-5-5 fewshot: p3#1:none->parallelism+verification, p1#1:none->parallelism+verification, d3#1:none->verification, d1#1:none->verification, p3#2:none->parallelism+verification, d1#2:none->verification, p1#2:none->parallelism, p2#2:none->parallelism+verification, p2#1:none->parallelism+verification, n15#1:none->parallelism, n15#2:none->parallelism, d7#1:none->verification
- claude-opus-5-5 checklist-sized: p1#1:none->parallelism, p2#1:none->parallelism, p3#1:none->parallelism, p1#2:none->parallelism, p2#2:none->parallelism, p3#2:none->parallelism, n15#1:none->parallelism, n15#2:none->parallelism
- gpt-6.1-sol checklist: p1#1:none->parallelism, p3#1:none->parallelism, p2#1:none->parallelism, p1#2:none->parallelism, p3#2:none->parallelism, p2#2:none->parallelism, n12#1:parallelism->none, n15#1:none->parallelism, n15#2:none->parallelism
- gpt-6.1-sol fewshot: p1#1:none->parallelism, p2#1:none->parallelism, p3#1:none->parallelism, p1#2:none->parallelism, p3#2:none->parallelism, p2#2:none->parallelism, n09#1:isolation->none, n08#1:isolation->none, n09#2:isolation->none, n12#2:parallelism->none
- gpt-6.1-sol checklist-sized: p3#1:none->parallelism, p1#1:none->parallelism, p1#2:none->parallelism, p3#2:none->parallelism, n08#1:isolation->none, n12#1:parallelism->none, n12#2:parallelism->none, n15#2:none->parallelism

Transport failures replaced by a later answer: claude-opus-5-5 fewshot d4#1, claude-opus-5-5 fewshot d5#1, claude-opus-5-5 fewshot d6#1, claude-opus-5-5 fewshot d7#1, claude-opus-5-5 fewshot d8#1, claude-opus-5-5 fewshot a6#1, claude-opus-5-5 fewshot b5#1.

Spent (all calls, replaced failures included): provider $10.41, catalog $10.41, 571 calls.

Total (scored calls): provider $10.41, catalog $10.41, 564 calls.
