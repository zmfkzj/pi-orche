# Workflow Policy: Work Type → Policy → Capability → Primary

> **역사 기록** — 2026-10-06 기준 제거됨: investigation critic, creation divergence, orche_task type/candidates/then. 현재 구조: [docs/orchestrator.md](orchestrator.md). 아래 본문은 당시 기록 그대로다.

> **상태 (2026-10-05): 구현 완료, 모두 opt-in(기본 꺼짐). 오프라인 회귀 검사(G-E0)는 통과했고, 비용이 드는 비교 실험(G-E1·G-I2·G-C2)은 사전 등록만 했다(아직 실행하지 않음, 4장).**
>
> 목적은 "구상이 옳다"를 증명하는 게 아니다. 가설을 **틀리면 싸게 버릴 수 있는 형태로** 검증하는 것이다. 기본값은 측정 결과로만 바꾼다(지금까지 multi와 v2를 다룬 방식 그대로).

## 1. 무엇을 바꿨나

전에는 front(single 모드 main)가 고른 work type이 곧바로 worker role이 됐다(`src/single/work-types.ts`). 이제는 그 사이에 한 단계를 둔다.

```text
Work Type (front가 분류, 기존 그대로; Jev 없음)
   ↓
Workflow Policy (src/workflow/policy.ts: 유형별 sequence + gate)
   ↓
Capability (one-shot specialist: frame / verify / critique)
   ↓
Primary (persistent worker 하나: 기존 role 그대로)
```

```ts
type Capability = "frame" | "retrieve" | "synthesize" | "execute" | "generate" | "critique" | "verify" | "refine";
interface WorkflowPolicy { type: WorkType; pre: Capability[]; primary: Capability; post: Capability[]; gates; retrieve; candidates? }
```

- **DAG는 만들지 않는다.** `pre` → Primary → `post`가 전부다. 각 `post` 단계는 자기 gate가 허락할 때만 돈다.
- **새 Framer, Navigator, Reviewer, Scheduler는 만들지 않았다.** 새 specialist는 Critic 하나다. 답변 critique와 후보 선택에 쓰고, route는 `routes.critic`을 공유하며 없으면 worker의 모델을 쓴다.
- `refine`은 원래 목록에 없던 capability다. 선택된 후보를 Primary가 한 번 더 다듬는 단계여서 추가했다.

| 유형 | 정책 | 설정 (`single.*`) | 기본 |
|---|---|---|---|
| execution | v1: `execute` / v2: `frame → execute → verify(gate)` + recheck | `pipeline`, `frame`, `checker`, `nav` (기존) | v1 |
| investigation | `synthesize → critique(gate) → synthesize` | `investigation.critic`: `off`/`auto`/`always` | off |
| creation | `generate×N → critique(gate) → refine` (N=1이면 지금의 creation 그대로) | `creation.divergence`: `off`/`auto`/`always`, `creation.candidates`: 2/3 | off |

### 1.1 Execution: 기존 v2를 정책의 첫 구현체로

- 동작은 바꾸지 않았다. `workers.ts`의 `pipelineV2` 플래그를 `resolvePolicy("execution", …)`에서 유도하도록만 바꿨다.
- 옛 조건 `ledger && pipeline v2 && implement`와 같다는 것을 설정 조합 표로 확인한다(`test/workflow/policy.test.ts`).
- `type: "creation"`으로 온 implement 과제(이름, 슬로건, UI look)는 execution이 아니다. 그래서 Framer와 Verifier가 붙지 않는다.

### 1.2 Investigation: answer worker + 조건부 Critic

1. Primary(answer worker)가 답한다. critic이 켜져 있으면 답변 지시에 다음 한 문장이 붙는다: 남은 경쟁 가설은 `data.hypotheses`, 결론을 바꿀 수 있는 미해결 질문은 `data.uncertainties`, 그리고 `data.confidence`를 보고하라. gate가 이 값들을 읽는다.
2. **Gate**는 결정적이다(LLM 호출 없음).
   - `always`: 매번 돈다.
   - `auto`: 다음 중 하나면 돈다.
     - 사용자 말에 검토·검증·반론 요청이 있다(`asksForCritique`: Verifier의 review 정규식에 반론·반례·비판·devil's advocate 등을 더한 것).
     - 열린 가설이 2개 이상이다.
     - uncertainty가 1개 이상이다.
     - confidence가 `low`다.
3. **Critic**은 일회용 read-only 세션이다(`src/workflow/critique.ts`).
   - 새 답을 쓰지 않는다. 결론이나 권고를 바꿀 것만 찾는다: counterevidence, unsupported, logical_gap, alternative, overclaim, missed_question.
   - finding은 최대 6개다. `material`이려면 위치가 있는 증거(path:line 또는 인용)가 필요하다. 없으면 report가 거부되고 고쳐서 다시 내야 한다.
4. **Synthesis**: material finding이 있으면 같은 worker에게 한 라운드를 더 준다.
   - finding마다 `accepted`/`rebutted`/`partly`와 근거를 낸다(`data.critique`). 빠지면 거부된다.
   - `data.conclusionChanged`를 보고하고, 최종 답을 통째로 다시 쓴다.
   - synthesis가 실패하면 첫 답을 유지하고 경고를 남긴다.
5. 반박당한 material finding이나 답하지 않은 finding은 main이 사용자에게 열린 쟁점으로 보고한다. 이 규칙은 critic이 켜져 있을 때만 붙는다.

### 1.3 Creation: 발산 후보 → 맹검 선택 → 다듬기

1. **후보 라운드**: 같은 creation worker가 방향을 달리한 후보 N개를 `.orche/scratch/<worker>-c<n>/<A|B|C>/`에 만든다(단순 재샘플링이 아니다).
   - 방향: A minimal/safe, B distinctive/experimental, C target-audience optimized.
   - scratch는 git, rg/fd, workspace audit 모두에서 제외된다. 이 라운드에서만 write scope에 scratch가 더해진다.
   - `data.candidates`(id, 해석한 방향, outputs 또는 content)를 형식대로 내지 않으면 거부된다.
2. **Critic(선택)**: 후보 이름을 1..N 중립 라벨로 바꾸고 순서를 섞어 보여 준다(Fisher-Yates). 방향 이름도 보이지 않는다.
   - 하드 제약(compliance), 완성도(quality), 맥락 적합(fit)을 1–5점으로 매긴다.
   - 하나를 고르고, 다듬을 점(refinements)과 다른 후보에서 빌릴 점(borrow)을 쓴다. `acceptable: false`면 아무 후보도 하드 제약을 만족하지 못한다는 뜻이다.
3. **Refine**: 같은 worker가 선택된 후보를 요청한 위치에 최종 결과물로 만든다.
   - 이 라운드가 실패하면 task도 실패한다(결과물이 없으므로). 후보는 scratch에 남는다.
4. **Escalation**: `divergence: "auto"`이면 front가 `candidates`를 정한다.
   - 3: 보스 캐릭터 컨셉, 비주얼 아이덴티티, 키아트, 이름처럼 대안을 비교할 가치가 있는 요청.
   - 1: 기존 스타일의 아이콘 하나처럼 명세가 분명한 요청. 이때는 지금의 단일 creation과 같다.
   - `always`는 설정값 N을 강제한다. 처음부터 병렬 worker 3개를 띄우지 않는다.

### 1.4 Hybrid: 작은 전이, scheduler 없음

- "디자인하고 게임에 넣어"처럼 결과를 적용·통합까지 원하면 front가 creation 호출에 `then: "execution"`을 넘긴다. 결과의 `Next: execution …` 줄을 보고 front가 implement orche_task를 한 번 더 부른다.
- 승인과 판단은 front에 남는다. 런타임은 전이를 자동 실행하지 않는다.
- "분석해 보고 괜찮으면 구현해"는 기존 work type 정의상 이미 execution이다. 그래서 따로 만들지 않았다.

## 2. 무엇이 그대로인가

- 정책이 꺼져 있으면 아래가 바뀌지 않는다(`test/extension/workflow-policy.test.ts`).
  - main 규칙: byte 단위로 같다.
  - answer, creation 프롬프트, 결과 텍스트, `details`: 그대로다(`details.workflow` 없음).
  - execution 결과: `pipeline` 그대로다.
- `orche_task`에는 선택 인자 `type`, `candidates`, `then`이 더해졌다. 도구 스키마 설명이 조금 길어졌는데, 이것이 main 프롬프트에서 유일하게 달라진 점이다(G-E1 참고).
- `type`이 role과 맞지 않으면(예: answer + creation) worker를 띄우기 전에 인자 오류로 처리한다.

## 3. 기록과 측정

- 정책 단계가 켜진 assignment의 record 디렉터리에는 다음 파일이 생긴다.
  - `workflow.json`: 정책 줄, trigger, critique, 응답, 후보, 맹검 순서, 선택, specialist 사용량, 상태.
  - `critique.json`, `selection.json`
  - `answers.json`: critique 전 답과 최종 답. judge가 오답→정답과 정답→오답 전환을 둘 다 셀 수 있게 남긴다.
- `events.jsonl`에는 `critique`, `synthesis`, `candidates`, `selection`, `refine` 이벤트가 남는다.
- `experiments/workflow/yield.ts <records-dir>…`는 LLM 없이 capability별 **marginal yield**를 계산한다.
  - `critic_yield` = Primary가 material finding을 하나 이상 받아들인(accepted/partly) critic 호출 / critic 호출
  - critic 호출률, trigger 분포, material 비율, 결론 변경률(self-report), specialist 비용
  - `divergence_yield` = 결과물이 A(관습적 방향)가 아닌 후보에서 나온 선택 / critic 선택. 위치 편향 점검용으로 고른 라벨의 분포도 낸다.
  - `framer_proxy` = frame당 implied+edge 요구사항 수. 상한일 뿐이다. Primary가 실제로 그것을 놓쳤을지는 맹검 판정 없이는 모른다.
- yield가 낮은 capability는 제거하거나 trigger를 좁힌다(BOAD식 ablation을 구조 전체에 적용).

## 4. 실험 (사전 등록, 2026-10-05, 실행 전에 작성)

공통 규칙:
- arm 사이에는 설정 한 가지만 다르다.
- `src`와 설정은 실행 중 고정한다.
- 모델은 openai-codex/gpt-6.1-sol high, SSE. worker와 specialist는 main을 상속한다.
- hidden 채점이나 judge 결과는 Pi에 되돌리지 않는다.
- parity·identity가 100%가 아니거나 unknown usage가 있으면 HOLD.
- 표본이 작으므로 결과는 서술적으로 다루고, task 단위 paired bootstrap을 보조로 쓴다.
- 비용은 카탈로그 가격으로 추정한다.
- **실행 편차 (2026-10-05, 실행 시 기록)**: 이 머신에는 openai-codex 자격 증명이 없어서 같은 모델을 `cliproxyapi/gpt-6.1-sol` high로 부른다(main은 `--extension`으로, worker는 `providerExtensions`로 provider를 로드). 사용량은 provider trace가 아니라 세션 파일(main과 orche record의 모든 transcript)에서 센다. 세션이 기록한 cost는 카탈로그 가격보다 훨씬 낮아서 쓰지 않고, 토큰에 `src/eval/pricing.json`(Pi 1.0.0 카탈로그)을 곱해 다시 계산한다. 하네스는 `experiments/workflow/driver.ts`다. 기록은 로컬 `results/compare/workflow-2026-10-05/README.md`에 있다.

### G-E0 Execution 회귀 (오프라인, 비용 0): **통과**

- 기존 v1/v2 테스트(`pipeline-v2`, `single-workflow`, `task-ledger`, `single-mode` 등)를 수정 없이 실행해 모두 통과했다.
- 정책에서 유도한 플래그가 옛 플래그와 같다(설정 8조합 × standard 여부, `test/workflow/policy.test.ts`).
- 정책이 꺼져 있으면 main 규칙이 byte 단위로 같다.
- 전체: typecheck 통과, 2,285 테스트 통과.

### G-E1 Execution 회귀 smoke: **통과** (2026-10-05)

- **질문**: `orche_task` 스키마에 선택 인자가 늘어난 것만으로 front 행동이 바뀌는가.
- **Arm**: E0 = 현재 코드에서 새 인자 세 개만 뺀 v2(`e0-schema.diff`), E1 = 현재 코드의 v2. "정책 도입 전 HEAD"로 하지 않은 이유: HEAD와 작업 트리 사이에 무관한 미커밋 변경(GUI capability)이 섞여 있어서, 스키마 차이만 남기는 쪽이 사전 등록한 질문을 더 정확히 분리한다.
- **방법**: G-X smoke(a6→a1)를 arm당 1세션 돌린다. front가 `type`·`candidates`를 잘못 넘기는 호출이 0건이고 통과 수가 같으면 끝낸다. 다르면 G-X 프로토콜 전체를 다시 돌린다.
- **결과**:

  | | E0 | E1 |
  |---|---:|---:|
  | 통과 | 2/2 | 2/2 |
  | wall | 711초 | 696초 |
  | 요청 수 | 41 | 35 |
  | 비용(카탈로그) | $0.385 | $0.316 |
  | parity / unknown usage | 100% / 0 | 100% / 0 |

  - E1의 front는 아무 규칙도 요구하지 않았는데 두 호출 모두 `type: "execution"`을 넘겼다. role implement에 맞는 값이라 잘못 넘긴 호출은 0건이고, 사전 규칙대로 끝낸다.
  - 다만 인자 설명만으로 front 행동이 바뀐다는 것은 확인됐다. 정책을 켠 arm과 끈 arm을 비교할 때는 두 arm 모두 같은 스키마(현재 코드)를 쓴다.

### G-I2 Investigation critic

- **질문**: answer worker에 조건부 critic을 붙이면 답의 품질이 오르는가, 그 비용은 얼마인가, critic 호출 중 실제 결함을 찾은 비율은 얼마인가.
- **과제 세트(작성 완료, 검토 대기)**: `fixtures/investigation/` 24개(검토표 `REVIEW.md`). 새로 만든 21개는 정답의 사실관계를 `verify.mjs`가 코드 실행으로 확인한다. 나머지 3개는 기존 suite의 rubric 과제(c3, a5, b4) 복사본이다. 5범주: 원인 분석 6, repo 질문 5, 기술 비교 4, 아키텍처 평가 4, 반례가 있는 판단 5.
  - fixture monorepo와 실제 저장소 스냅샷을 쓴다.
  - 과제마다 정답 루브릭을 둔다: 핵심 사실, 올바른 결론, 알려진 함정.
  - 그중 8개에는 첫 답이 틀리기 쉬운 함정(낡은 문서, 오해를 부르는 주석, 같은 증상의 다른 원인)을 심는다. 천장 효과를 피하기 위해서다.
  - 루브릭은 실행 전에 확정하고 사용자가 검토한다.
- **Arm**:
  - I0 = `critic: "off"`
  - I1 = `critic: "auto"`
  - 보조 Iu = critic off + uncertainty 지시만. I1은 Primary 지시도 한 문장 바뀌므로 그 효과를 분리하려는 arm이다. 예산이 모자라면 생략하고 한계로 적는다.
- **프로토콜**: 과제마다 새 single 모드 Pi RPC 세션을 연다. arm당 과제당 3반복이고, 반복 안에서 arm 순서를 돌린다.
- **채점**:
  - 다른 계열 모델 judge 2개가 맹검으로 채점한다(arm 라벨 없음, 순서 무작위). 루브릭 점수(항목 충족 비율), 결론 정오(`conclusion` 항목), pairwise 선호를 낸다. 제안: 실행 중 1차 judge `cliproxyapi/claude-opus-5-5` high, 사후 2차 judge `cliproxyapi/grok-4.7`. 두 judge가 다르게 판정한 과제는 사용자가 판정한다.
  - 무작위 20%는 사용자가 확인한다.
  - I1의 `answers.json`(critique 전과 후)도 같은 judge로 채점해 오답→정답(W→R)과 정답→오답(R→W)을 센다.
- **지표**: 루브릭 평균, 결론 정답률, 범주별 결과, critic 호출률, `critic_yield`, W→R/R→W, 결론 변경률, 요청·비용·wall(기록만).
- **Gate (채택 조건)**:
  1. I1 결론 정답률 ≥ I0 + 2과제(72회 중 6회), 또는 루브릭 평균 +0.5 이상. 그리고 3회 중 2회 이상 지는 과제가 없어야 한다.
  2. R→W ≤ W→R의 1/3.
  3. 과제당 비용 ≤ I0의 1.3배.
  4. `critic_yield` ≥ 0.25. 미달이면 품질이 통과해도 trigger를 좁힌 설정을 따로 사전 등록한다.
- **결정 규칙**:
  - 모두 통과하면 `critic: "auto"`를 기본값으로 바꾸자고 제안한다(사용자 결정).
  - 1이나 2가 미달이면 off를 유지한다.
  - 3만 미달이면 `review`에 해당하는 좁은 gate(명시적 요청만)를 시험한다.
- **한계(미리 적음)**:
  - judge도 모델이다.
  - 함정 과제의 비율이 결과를 좌우한다(천장과 바닥 모두).
  - conclusionChanged는 self-report다(그래서 judge의 W→R/R→W를 1차로 본다).

### G-C2 Creation divergence

- **질문**: 같은 worker가 방향이 다른 후보 3개를 만들고 맹검 critic이 고른 뒤 다듬으면, 단일 creation보다 최종 결과가 나은가, 다양한가, 비용은 납득 가능한가.
- **과제 세트(작성 완료, 검토 대기)**: `fixtures/creation/` 12개(검토표 `REVIEW.md`). 하드 제약은 `grade.mjs`가 검사한다(시작 상태에서는 실패, 조건을 만족하는 합성 결과물에서는 통과함을 확인). 이미지 과제는 `images: cliproxyapi-images/gpt-image-2.5`를 쓴다.
  - 고가치 8개: 보스 캐릭터 컨셉, 게임 로고, 썸네일, 비주얼 테마, 이름과 슬로건 2, 키아트, UI 스킨.
  - 단순 4개: 기존 스타일 아이콘, 크기 변형 등. auto escalation 점검용이고 1차 비교에서는 빠진다.
  - 과제마다 결정적으로 검사할 수 있는 하드 제약(크기, 포맷, 투명도, 개수, 필수 단어)과 루브릭을 둔다.
- **Arm**: C0 = `divergence: "off"`, C1 = `divergence: "always"`(3). 고가치 과제당 2반복.
- **escalation 평가(별도, 오프라인)**: front가 `candidates`를 고르는 정확도를 라우팅 평가 하네스(`experiments/routing/evaluate.ts`)에 30건 라벨을 붙여 잰다. 기준은 정확도 85% 이상이다.
- **채점**:
  - 다른 계열 judge 2개가 C0와 C1의 최종 결과물을 맹검 pairwise로 비교한다(위치 무작위). 선호와 루브릭(compliance/quality/fit)을 낸다.
  - 하드 제약은 스크립트로 검사한다.
  - C1 후보 3개 사이의 다양성은 judge가 1–5점으로 매긴다(이미지는 임베딩 거리도 보조로 쓴다).
  - 사용자가 부분 표본을 맹검으로 본다.
- **지표**: C1 승률, 하드 제약 통과율, 다양성, `divergence_yield`, critic이 고른 라벨 분포(위치 편향), 요청·비용·wall, 이미지 생성 수.
- **Gate (10.4의 G-C)**:
  1. C1 승률(동률 제외) ≥ 60%.
  2. 하드 제약 통과율 ≥ C0.
  3. 비용 ≤ C0의 2배.
  4. `divergence_yield` ≥ 0.3. 미달이면 A만으로 충분하다는 뜻이므로 후보를 줄인다.
- **결정 규칙**:
  - 모두 통과하고 escalation 정확도도 넘으면 `divergence: "auto"`를 제안한다.
  - 승률은 넘었는데 비용만 미달이면 `candidates: 2`를 사전 등록해 다시 시험한다.
  - 승률이 미달이면 off를 유지한다.
- **한계**: 창작 평가는 주관적이다. 과제당 n=2다. 같은 worker가 후보를 모두 만드므로 후보 간 다양성에 한계가 있다(그것이 이 설계의 가설이다).

## 5. 파일

| 파일 | 내용 |
|---|---|
| `src/workflow/policy.ts` | WorkType, Capability, WorkflowPolicy, `resolvePolicy`, `workTypeOf`, `formatPolicy` |
| `src/workflow/critique.ts` | Critic 스키마·지시·프롬프트, gate(`criticTrigger`), synthesis 프롬프트·검증, 결과 줄 |
| `src/workflow/divergence.ts` | 방향, 후보 라운드 지시·검증, 맹검 순서, 선택 스키마·지시·프롬프트, refine 프롬프트 |
| `src/single/pipeline.ts` | `runCritic`, `runSelector` (기존 `runSpecialistSession` 재사용) |
| `src/extension/workers.ts` | 정책 해석, 후보·synthesis·refine 라운드, `details.workflow`, record 파일 |
| `src/extension/config.ts`, `mode.ts`, `index.ts` | `single.investigation`·`single.creation` 설정, 켜졌을 때만 붙는 main 규칙 |
| `experiments/workflow/yield.ts` | record에서 capability별 yield 계산 |
| `test/workflow/policy.test.ts`, `test/extension/workflow-policy.test.ts` | 단위·faux 통합 테스트 |
