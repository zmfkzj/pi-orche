# Split-judgment evaluation results

Generated 2026-10-06T10:16:48.125Z by experiments/judgment/score.ts from experiments/judgment/runs/2026-10-05T14-10-07-384Z-opus-main, experiments/judgment/runs/2026-10-05T14-10-07-387Z-sol-second, experiments/judgment/runs/2026-10-06T10-13-52-443Z-sol-rep2.
45 items (primary labels: {"none":27,"parallelism":10,"isolation":4,"verification":5}). Rates pool all repetitions. Cost is the provider catalog price of the calls.

| Model | Variant | Calls | Accuracy | False split | Unneeded parallel | Missed parallel | Units compatible / exact (n) | Missed / false verification | Missed / false isolation | Consistency | Parse failures | Cost |
|---|---|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|
| cliproxyapi/claude-opus-5-5 | minimal | 90 | 80.0% | 24.1% | 4.3% | 0.0% | 100.0% / 100.0% (20) | 0.0% / 17.5% | 0.0% / 0.0% | 88.9% | 1 | $0.97 |
| cliproxyapi/claude-opus-5-5 | checklist **(selected)** | 90 | 98.9% | 0.0% | 0.0% | 6.3% | 100.0% / 100.0% (19) | 0.0% / 0.0% | 0.0% / 0.0% | 97.8% | 0 | $0.81 |
| cliproxyapi/claude-opus-5-5 | fewshot | 90 | 98.9% | 1.9% | 0.0% | 0.0% | 100.0% / 100.0% (20) | 0.0% / 1.3% | 0.0% / 0.0% | 97.8% | 0 | $0.79 |
| cliproxyapi/claude-opus-5-5 | checklist-fewshot | 90 | 96.7% | 0.0% | 0.0% | 12.5% | 100.0% / 100.0% (17) | 10.0% / 0.0% | 0.0% / 0.0% | 93.3% | 2 | $0.90 |
| cliproxyapi/gpt-6.1-sol | minimal | 90 | 44.4% | 55.6% | 45.7% | 0.0% | 100.0% / 100.0% (20) | 0.0% / 46.3% | 0.0% / 1.3% | 86.7% | 0 | $0.35 |
| cliproxyapi/gpt-6.1-sol | checklist | 90 | 97.8% | 0.0% | 0.0% | 12.5% | 100.0% / 94.4% (18) | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% | 0 | $0.34 |
| cliproxyapi/gpt-6.1-sol | fewshot | 90 | 93.3% | 7.4% | 7.1% | 0.0% | 100.0% / 100.0% (20) | 0.0% / 1.3% | 0.0% / 0.0% | 95.6% | 0 | $0.34 |
| cliproxyapi/gpt-6.1-sol | checklist-fewshot | 90 | 97.8% | 0.0% | 0.0% | 12.5% | 100.0% / 100.0% (18) | 0.0% / 0.0% | 0.0% / 0.0% | 100.0% | 0 | $0.37 |

Selection (pre-registered rule, main model cliproxyapi/claude-opus-5-5): **checklist**. Eligible: checklist, fewshot, checklist-fewshot. best accuracy 0.989; tie among checklist, checklist-fewshot, fewshot broken by false split / missed parallel / units / consistency / length.

Errors (item#rep: expected -> predicted):

- cliproxyapi/claude-opus-5-5 minimal: d1#1:none->verification, d3#1:none->verification, d4#1:none->verification, d6#1:none->verification, d8#1:none->verification, d7#1:none->verification, n08#1:isolation->isolation+parallelism, n04#1:none->parallelism, p1#2:parallelism->parallelism+verification, p2#2:parallelism->parallelism+verification, d4#2:none->verification, d1#2:none->verification, d7#2:none->verification, d5#2:none->verification, d3#2:none->verification, d8#2:none->verification, n08#2:isolation->isolation+parallelism, n04#2:none->parse-failure
- cliproxyapi/claude-opus-5-5 checklist: n19#1:parallelism->none
- cliproxyapi/claude-opus-5-5 fewshot: d1#2:none->verification
- cliproxyapi/claude-opus-5-5 checklist-fewshot: n15#1:parallelism->parse-failure, n19#1:parallelism->none, n17#2:parallelism+verification->parse-failure
- cliproxyapi/gpt-6.1-sol minimal: d1#1:none->parallelism+verification, p3#1:parallelism->parallelism+verification, p2#1:parallelism->parallelism+verification, d2#1:none->parallelism+verification, d3#1:none->parallelism+verification, d4#1:none->parallelism+verification, d8#1:none->parallelism+verification, d5#1:none->parallelism+verification, d7#1:none->parallelism+verification, d6#1:none->parallelism+verification, n01#1:parallelism->parallelism+verification, c01#1:isolation->isolation+parallelism, n07#1:none->verification, n04#1:none->parallelism+verification, n08#1:isolation->isolation+parallelism, n09#1:isolation->isolation+parallelism+verification, n11#1:none->parallelism, n13#1:parallelism->parallelism+verification, n14#1:none->parallelism, n15#1:parallelism->parallelism+verification, n16#1:none->verification, n19#1:parallelism->parallelism+verification, n20#1:verification->isolation+verification, n21#1:none->parallelism, p3#2:parallelism->parallelism+verification, d5#2:none->parallelism+verification, p2#2:parallelism->parallelism+verification, d1#2:none->parallelism+verification, d2#2:none->parallelism+verification, p1#2:parallelism->parallelism+verification, d3#2:none->parallelism+verification, d4#2:none->parallelism+verification, d7#2:none->parallelism, d6#2:none->parallelism+verification, d8#2:none->parallelism+verification, n01#2:parallelism->parallelism+verification, c01#2:isolation->isolation+parallelism, n02#2:none->parallelism, n07#2:none->verification, n09#2:isolation->isolation+parallelism+verification, n08#2:isolation->isolation+parallelism, n04#2:none->parallelism+verification, n11#2:none->parallelism, n13#2:parallelism->parallelism+verification, n16#2:none->verification, n15#2:parallelism->parallelism+verification, n14#2:none->parallelism+verification, n19#2:parallelism->parallelism+verification, n23#2:none->parallelism, n21#2:none->parallelism
- cliproxyapi/gpt-6.1-sol checklist: n19#1:parallelism->none, n19#2:parallelism->none
- cliproxyapi/gpt-6.1-sol fewshot: d8#1:none->verification, n08#1:isolation->isolation+parallelism, n14#1:none->parallelism, n08#2:isolation->isolation+parallelism, n11#2:none->parallelism, n14#2:none->parallelism
- cliproxyapi/gpt-6.1-sol checklist-fewshot: n19#1:parallelism->none, n19#2:parallelism->none

System prompt lengths (chars): minimal 1529, checklist 3058, fewshot 2660, checklist-fewshot 4054.
