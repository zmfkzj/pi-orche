# 새 single 설계: Jev 실행 정책 라우팅 · topology · 컨텍스트 보존

> **상태 (2026-10-04): 설계 제안. 소스 변경 없음.** 기준은 HEAD `68f3624`다(auto/multi 모드와 orche_run을 Pi 패키지에서 제거, multi 엔진은 라이브러리로만 유지).
>
> **범위**
> - `direct`: 바꾸지 않는다. 이 문서의 어떤 구성요소도 direct main에 들어가지 않는다.
> - `single`: 이 문서의 구조로 교체한다.
> - 지금 single의 장점인 컨텍스트 보존은 유지하고 강화한다(6장).
>
> **결정 (2026-10-04)**
> 1. 요구사항 정리는 Framer(이전 이름 Issue Analyzer)가 맡는다. front는 사용자가 정해야 할 질문(needs_decision)이 있을 때만 확인한다.
> 2. `explore` role은 없앤다. 아래 구조에서는 role 자체가 선택적 override가 된다(7장).
> 3. Execution의 검증은 위험 점수가 기준을 넘을 때 자동으로 실행하고, 사용자가 요청하면 수동으로 실행한다(5.3).
> 4. 라우팅 평가에는 사용자의 로컬 Pi/OMP 세션 요청을 쓴다. 파일은 로컬 전용 `results/routing-eval/`(권한 0600)에 두고, 라벨은 사용자가 확정한다.
> 5. 구현 순서는 Phase 1(ledger) → Phase 2(라우터 shadow)다.
> 6. 지시 없는 버그 보고(로그·에러만 붙여 넣은 요청)의 기본 동작은 `fix`다: 진단한 뒤 바로 고친다.
> 7. 라우팅 정답셋 100건의 라벨을 확정했다(6번 정책을 적용해 버그 보고 2건을 execution으로 바꿈). Creation 보충 23건은 다른 PC 세션에서 추출했고, 사용자 검토 없이 임시 라벨 그대로 쓴다.
> 8. main의 감독 규칙에서 "verifiedBy 검사가 수용 기준을 확인하는지 확인" 부분을 뺐다(비교 실험 없이). 해석을 원문과 대조하는 규칙과 미확인 항목 보고는 유지한다.
> 9. ledger 결함 수정: `orche_task`의 `task`로만 task를 잇고(생략하면 worker를 재사용해도 새 task), 세션에는 변경 이벤트만 남긴다. ledger 이득 측정 실험은 하지 않는다.
> 10. G-R(10.1)에서 Jev+규칙은 기준 미달이고, 우리 정의를 준 LLM(front가 고르는 방식)이 가장 정확했다. **확정**: 작업 유형은 front가 고른다. single 규칙에 작업 유형 정의(`src/single/work-types.ts`)를 넣었고, 지금은 유형을 기존 role로 위임한다(별도 `mode` 필드는 Creation 파이프라인이 생길 때 다시 본다). 다른 모델(분류기나 LLM)도 `experiments/routing/evaluate.ts`의 `--arm`으로 바로 평가할 수 있다.
>
> **핵심:** 코딩 전용 고정 파이프라인을 버리고, **Jev가 작업 성격을 분류하고 규칙이 실행 형태(topology)와 capability를 고르는** 구조로 바꾼다. Jev는 문제를 풀지 않는 control plane이다. 문제 해결의 소유자는 task마다 하나인 persistent Primary worker다. 그 밖의 specialist는 모두 한 번 쓰고 버리는 세션이며, 작업 상태의 원본은 task ledger에 둔다.

## 1. 근거

### 1.1 코딩에서 측정한 것

| 측정 | 결과 |
|---|---|
| agent 수 | bench3: pi-solo 84/84, pi-orche(주로 multi) 72/84이고 비용 6배. hard6·parallel3·multi-vs-single에서도 multi는 품질 이득 없이 비쌌다 |
| 지금 single | longsession(7c882ab): main context 최대 75,773 token(direct 153,721). pass 22/24(direct 23/24), 비용 2.3배. **가치는 컨텍스트 보존이고, 품질 이득은 아직 없다.** 단, 649990c 이후 같은 조건(G-L의 S0)에서는 main context 최대가 123,184 token으로 늘었다(11장 진행 상황 참고) |
| 남은 실패 | d1(요구사항 해석: "increments attempts once per claim")은 모든 구조에서 같은 방식으로 실패했다. d6(같은 timestamp의 cursor 경계)은 놓친 edge case였다. localization 실패는 없었다(작은 저장소라 main이 모든 파일을 읽음) |
| 보조 장치 | prompt 교체는 효과 없음. 고가 critic은 실제 버그 1건을 찾았지만 wall +48%. 저가 critic은 지적의 65%가 concern(근거가 약함)이었다 |

근거 파일은 로컬 `results/compare/*`와 `docs/{comparison,prompt-study,advisor-study,dag-orchestration}.md`다.

### 1.2 이미 해 본 라우팅 (oh-my-omp-plugins)

- **jev_router**(OMP 플러그인): TypeSafe Jev 분류기로 DEFAULT/ORCHESTRATE(front door)와 TASK_NORMAL/TASK_DEEP(worker 모델 등급)를 정했다. 입력은 요청 텍스트뿐이었고, confidence/margin 두 기준을 모두 넘을 때만 결정을 채택했다. `~/.omp/agent/jev-router/decisions.jsonl`의 53건 기준으로 지연은 중앙값 243ms, p90 292ms다.
- **om-orche** (`633eb4b`, 2026-09-29): Jev 라우팅을 **main 스스로 고르는 정책 안내**로 바꿨다. 안내에는 Judgment(판단형)와 Production(제작형) 두 정책과 단계별 전환 규칙("둘 다면 Judgment로 시작하고, 변경 승인 뒤 Production으로", "Production 중 전제가 깨지면 그 부분만 Judgment로")이 들어 있다. 게임 에셋은 별도 조직 없이 Production으로 처리한다.
- **Jev 라우팅이 실패한 이유 (사용자 확인)**: 요청 텍스트, 즉 컨텍스트의 일부만 보고 판단해서 정확도가 낮았고, 거의 모든 요청을 ORCHESTRATE로 분류했다.
- 이번 설계와의 차이: (a) 선택을 다시 Jev와 규칙으로 외부화하되, 위 실패에 대한 대책을 넣는다(3.1의 "이전 실패에 대한 대책"). (b) Creation topology를 추가한다. 그러므로 10장 실험에서 **main 스스로 고르기(om-orche 방식)**를 반드시 대조군으로 둔다.

### 1.3 Pi에는 Jev가 이미 들어 있다

- Pi 1.0에는 classifier 모델이 내장되어 있다. Pi 카탈로그에 `typesafe/jev-latest`(type `classifier`)가 있고, TypeSafe 자격 증명이 있으면 쓸 수 있다.
- extension은 `ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest")`와 `ctx.modelRegistry.classify(model, { state, questions }, { signal })`로 호출한다. 질문은 `choice`(확률과 confidence), `score`(순서 척도), `bool`(확률) 세 종류이고, 한 번 호출로 여러 질문에 답한다.
- Pi 예제 `examples/extensions/jev-router.ts`는 같은 API로 virtual model을 만들어 계획 모델을 고른다.

## 2. 전체 구조

```text
User ⇄ Front (single 모드 main: 대화·승인·보고, 편집 불가)
          │ orche_task {request, task?, decisions?, mode?}
          ▼
   Policy Router ─ Jev classify 1회 (~0.25초) → descriptor → 규칙 → ExecutionPolicy
          │          (topology · capability · Primary 모델/effort · escalation)
          ▼
   Topology runner (작은 상태 기계: investigation ⇄ execution, creation → execution)
          │
          ├─ 일회용 specialist: frame · explore · generate×N · critique · verify
          ├─ 결정적 도구: retrieve(code_nav/LSP/grep, 런타임 상태, 문서, 참조 자료)
          └─ Primary (task당 하나, persistent): execute · synthesize · refine
          │
          ▼
   Task ledger (작업 상태의 원본) ── 압축 결과 ──► Front
```

| 연구 역할 | 일반화한 역할 | 이 구조의 구현 |
|---|---|---|
| Issue Analyzer | Problem Framer | `frame` primitive. 일회용 Framer 세션 |
| Code Navigator | Evidence / Context Acquisition | `retrieve` primitive. 결정적 도메인 adapter, 실패하면 `explore`(LLM) |
| Main Agent | Primary Agent | persistent worker. task 동안 유지하고 phase가 바뀌어도 재사용 |
| Verifier | Conditional Critic / Evaluator | `critique`·`verify` primitive. 일회용 세션, gate 조건부 |

## 3. Jev: Execution Policy Router

> **G-R 결과(10.1) 이후:** 이 절은 평가한 설계의 기록이다. Jev+규칙은 사전 기준을 넘지 못했고(승인 없는 변경 3.3%, 정확도가 front LLM보다 낮음), 코드는 `experiments/routing/`으로 옮겼다. 작업 유형은 대화 전체를 보는 front가 single 규칙의 정의(`src/single/work-types.ts`)로 고르고, 후속 메시지는 `task`로 잇는다(`turn` 질문 불필요).

### 3.1 Descriptor (Jev 호출 1회)

```ts
// state: Jev에 보내는 JSON. 저장소 내용과 대화 전체는 보내지 않는다.
{
  request: string,                               // front가 쓴 self-contained 요청(원문, intent, 제약), 16천 자 이하
  previous?: string,                             // 후속 메시지일 때: 직전 assistant 응답의 끝부분, 800자 이하
  task?: { phase: "investigation" | "execution" | "creation"; lastOutcome?: string; openQuestions?: string[] },  // 진행 중인 task가 있을 때
  workspace: { languages: Record<string, number>, signals: string[] }   // repo card 요약 (예: "package.json", "Dockerfile", "k8s", "assets/")
}
```

| 질문 (`questions`) | 종류 | 값 |
|---|---|---|
| `intent` | choice | `understand`(설명·분석·리뷰), `decide`(비교·선택·설계), `modify`(코드·설정·파일 변경), `create`(정답이 하나가 아닌 산출물), `operate`(배포·인프라·운영 조작) |
| `domain` | choice | `code`, `infra`, `research`, `asset`, `document`, `general` |
| `sideEffect` | bool | 요청을 완료하면 파일, 시스템, 외부 상태가 바뀌는가 |
| `conditionalChange` | bool | 분석이나 결정을 먼저 하고 그 결과에 따라 바꾸라는 요청인가 |
| `needsRetrieval` | bool | 요청 밖의 정보(저장소, 런타임 상태, 문서, 웹)가 필요한가 |
| `needsDivergence` | bool | 서로 다른 후보 여러 개가 결과를 실질적으로 낫게 하는가 |
| `risk` | score | low / medium / high: 틀렸을 때의 비용(데이터 손실, 보안, 운영, 금액, 되돌리기 어려움) |
| `uncertainty` | score | low / medium / high: 요구사항, 원인, 접근법이 얼마나 불분명한가 |
| `turn` | choice | `new`(새 작업), `approval`(직전 제안 승인·진행), `correction`(의도 정정), `constraint`(조건 추가), `question`(직전 결과에 대한 질문), `report`(직전 결과의 결함 보고), `reformat`(다시 쓰기·번역처럼 front가 바로 답할 것) |
| `bugReport` | bool | 지시 없이 오류, 로그, "안 됨"만 전한 버그 보고인가 |

**채택 기준과 fallback** (jev_router의 confidence/margin 방식을 그대로 쓴다)

- choice는 confidence 0.6 이상이고 1·2위 차이 0.2 이상일 때, bool은 확률 0.7 이상 또는 0.3 이하일 때, score는 confidence 0.6 이상일 때만 채택한다.
- 채택하지 못한 항목은 보수적인 기본값을 쓴다: `sideEffect`가 불확실하면 Investigation으로 시작해 변경을 제안만 하고, `needsDivergence`는 false, `risk`/`uncertainty`는 medium, `domain`은 workspace 신호로 정한다.
- Jev가 없거나(자격 증명 없음, 2초 timeout) 오류가 나면 규칙만으로 descriptor를 만든다(키워드와 workspace 신호). 어떤 경우에도 실행을 막지 않는다.
- 결정마다 `{descriptor, probabilities, source: "jev" | "rules" | "override", latencyMs}`를 ledger와 decision log에 남긴다.

**이전 실패에 대한 대책** (jev_router는 요청 텍스트만 보고 거의 전부 ORCHESTRATE로 분류했다)

1. **맥락을 보강한다.** front가 쓴 self-contained 요청을 받고, 후속 메시지라면 직전 응답 발췌와 진행 중인 task 상태도 받는다. 저장소 내용과 대화 전체는 여전히 보내지 않는다.
2. **판단 대신 관측 가능한 사실을 묻는다.** "orchestration이 결과를 낫게 하는가" 같은 반사실적 가치 판단은 전체 맥락이 있어야 답할 수 있다. 대신 "변경을 요구하는가", "버그 보고인가", "직전 제안의 승인인가"처럼 요청 텍스트에서 확인할 수 있는 것만 묻고, topology는 규칙이 정한다.
3. **후속 메시지를 따로 다룬다.** `turn`으로 새 작업과 후속 메시지를 나눈다. 후속 메시지는 대부분 topology를 다시 고르지 않고 진행 중인 task를 이어 간다.
4. **쏠림을 감시한다.** 평가에서는 예측 분포와 정답 분포, 클래스별 recall, 최빈값 기준선을 함께 본다. threshold는 정답셋으로 질문마다 보정한다. 운영 중에는 decision log에서 한 라벨이 80%를 넘으면 경고한다.
5. **front 힌트가 우선한다.** 대화 전체를 보는 front가 `mode`를 명시하면 Jev 결과보다 우선한다.

### 3.2 규칙: descriptor → ExecutionPolicy

```ts
interface ExecutionPolicy {
  topology: "investigation" | "execution" | "creation";
  phasePlan: Array<"investigation" | "execution" | "creation">;   // 예: ["investigation", "execution"]
  frame: "skip" | "spec" | "grounded";
  retrieve: Array<"code" | "runtime" | "docs" | "web" | "reference">;
  generate?: { n: number };                                       // creation만
  critique: "off" | "gated" | "always";
  verify: "off" | "gated" | "always";
  primary: { effort: "medium" | "high" | "xhigh"; route?: string };   // 기본은 main 상속
  escalation: EscalationPolicy;
}
```

| 조건 | topology / phasePlan |
|---|---|
| `turn ∈ {approval, correction, constraint, report}`이고 진행 중인 task가 있음 | 그 task를 이어 간다. `approval`은 승인 guard를 통과시켜 다음 phase로 넘어간다 |
| `turn = reformat`, 또는 `turn = question`이고 직전 결과로 답할 수 있음 | `respond`: task를 만들지 않고 front가 답한다 |
| `bugReport` | 설정 `bugReports`를 따른다: `"fix"`(기본: grounded frame → execution) 또는 `"diagnose"`(investigation 뒤 수정 제안) |
| `conditionalChange` | `investigation` → (승인 뒤) `execution` 또는 `creation` |
| `needsDivergence` 이고 (`intent=create` 또는 `domain=asset`) | `creation` (구현까지 요청했으면 → `execution`) |
| `sideEffect` 이고 `intent ∈ {modify, operate, create}` | `execution` (후보가 여러 개 필요 없는 산출물, 예: 기획 문서 작성도 여기로 간다) |
| 그 밖 | `investigation` |

위에서부터 처음 맞는 줄을 쓴다.

| 항목 | 규칙 |
|---|---|
| frame | `uncertainty`가 low이고 요청이 짧고 단일하면 `skip`. `needsRetrieval`이고 (`uncertainty` high 또는 큰 저장소)이면 `grounded`. 나머지는 `spec` |
| retrieve | domain별: code → `code`, infra → `runtime`+`code`, research → `docs`+`web`, asset → `reference` |
| generate | creation이면 n=3 (`risk` low이면 2) |
| critique | investigation: `intent=decide` 또는 `risk`/`uncertainty` high이면 `gated`, 아니면 `off`. creation: `always`(후보 선택) |
| verify | execution: `gated`(위험 점수, 5.3). creation: 산출물 형식 검사(결정적)는 `always` |
| primary effort | `risk` 또는 `uncertainty`가 high → xhigh. 둘 다 low → medium. 그 밖 → high. 설정으로 main 상속을 강제할 수 있다 |

규칙 표는 설정 파일로 덮어쓸 수 있다(9장). 정책을 바꿀 때 코드를 고치지 않게 하기 위해서다.

### 3.3 Jev가 하지 않는 것

- 문제를 쪼개거나, 하위 작업을 배분하거나, 중간 결과를 분석해 다시 배분하지 않는다.
- 저장소, 대화, 산출물 내용을 보지 않는다. 받는 것은 요청 원문, workspace 신호, phase, 결과 라벨뿐이다.
- 호출 예산: task 시작에 1회, phase 전환마다 1회. task당 전환은 최대 4회다.
- 문제 해결의 소유권은 언제나 Primary에게 있다. Jev의 결과는 "어떤 형태와 도구로, 어느 정도 effort로" 실행할지에 그친다.

## 4. Capability primitive와 topology

### 4.1 Primitive

| primitive | 하는 일 | 구현 | 수명 |
|---|---|---|---|
| `frame` | 목표, 요구사항, 해석 모호성, 성공 기준, 유지할 것, edge case 정리 | Framer 세션 (`spec`: 요청만 / `grounded`: 읽기 전용 도구 사용) | 일회용 |
| `retrieve` | 필요한 정보를 결정적으로 획득 | 도메인 adapter: code(`code_nav`, LSP, grep), runtime(bash 정책 안의 읽기 전용 상태 명령), docs(read/grep), web(browser 도구가 있을 때만), reference(기존 에셋, 스타일 가이드) | 도구 |
| `explore` | 도구로 안 잡히는 것을 LLM이 탐색(동적 dispatch, DI, 설정 기반 라우팅) | Framer `grounded`가 겸한다 | 일회용 |
| `execute` | 상태 변경, 구현, 테스트 | Primary | persistent |
| `generate` | 서로 다른 후보 생성 | Generator 세션 N개 (병렬, 서로의 결과를 보지 않음) | 일회용 |
| `critique` | 반론, 빠진 근거, 후보 비교·선택 | Critic 세션 | 일회용 |
| `verify` | 실행 evidence(반례 probe, check 실행) | Verifier 세션 + 결정적 recheck | 일회용 |
| `synthesize` | 최종 답, 보고, 통합 | Primary | persistent |

### 4.2 Topology 템플릿

```text
Investigation:  frame → retrieve(/explore) → Primary synthesize → [critique: gated]
Execution:      frame → retrieve(state·code) → Primary execute(+test) → [verify: 위험 점수] → fix → recheck
Creation:       frame(brief) → retrieve(reference) → generate×N → critique·선택(또는 사용자) → Primary refine → 형식 검사
```

- **Investigation**: 원인 분석, 기술 비교, 문서·논문 조사, 아키텍처 판단, 잠재 버그 탐색. Primary는 근거 ID(S1, S2 …)를 인용해 답한다. critique는 반론과 빠진 근거만 낸다.
- **Execution**: 코드 구현, 버그 수정, 인프라·설정 변경, 배포. 지난 버전의 코딩 설계가 여기의 `domain=code` 경우다. 인프라는 retrieve가 런타임 상태 조회가 되고, verify는 관측 명령(상태·헬스 체크)이 된다.
- **Creation**: 게임 에셋, UI, 디자인, 아이디어, 문구. **여기서만 병렬 worker를 허용한다.** 후보마다 서로 다른 방향을 지정하고(brief의 `directions`), generator끼리는 서로의 결과를 보지 않는다. 선택은 critic이 rubric으로 하거나 사용자가 고른다(needs_decision). 다듬기는 Primary 하나가 한다. 기존 `game-asset`/`video` loadout(`generate_image` 포함)이 generator와 Primary의 도구가 된다.

### 4.3 상태 기계 (phase 전환)

```text
investigation ──(변경 승인)──► execution
investigation ──(후보 탐색 승인)──► creation
creation ──(후보 선택 + 구현 요청)──► execution
execution ──(전제가 깨짐 / 막힘 / 검증 반복 실패, 해당 부분만)──► investigation ──► execution
모든 phase ──(완료)──► done
```

- **승인 guard**: 상태를 바꾸는 phase(execution)로 넘어가려면 원래 요청이 그 변경을 명시했거나(`sideEffect=true`이고 `conditionalChange=false`), 사용자가 승인해야 한다. 승인이 없으면 runtime은 제안을 front에 반환한다(needs_decision). print/json처럼 UI가 없으면 원래 요청이 승인한 범위까지만 진행한다.
- **전환 신호**: Primary는 `report_result.data.next`(`analysis_done`, `needs_change_authorization`, `premise_broken`, `blocked`)를 낸다. runtime은 이를 `lastOutcome`으로 Jev에 넘겨 다음 phase의 정책을 받는다. Primary가 다음 단계를 직접 고르지는 않는다.
- **Primary 재사용**: 같은 workspace와 같은 도메인이면 phase가 바뀌어도 같은 Primary가 계속한다. 그래서 조사 단계의 context가 구현으로 이어진다(지금 single의 worker 재사용과 같은 이점). effort만 바꿀 때는 기존 worker의 model/thinking 전환 경로를 쓴다.

### 4.4 Escalation

| 상황 | 조치 (각 1회까지) |
|---|---|
| execution: fix 뒤에도 blocking finding이 남음 | 해당 부분만 investigation으로 전환하거나, needs_decision으로 사용자에게 묻는다 |
| execution: Primary가 막힘 | effort를 한 단계 올려 재시도하거나 investigation으로 전환 |
| investigation: critic이 강한 반론을 냄 | Primary가 한 번 수정하고, 남는 불확실성은 보고에 명시 |
| creation: 어떤 후보도 critic 기준을 못 넘음 | critic 피드백으로 한 번 더 생성, 그래도 안 되면 사용자에게 후보 제시 |
| 2회 연속 미충족 | 새 Primary에 미충족 항목만 넘긴다 (지금 규칙 유지) |

## 5. 구성요소 상세

### 5.1 Framer (`report_frame`)

```ts
interface Frame {
  restatement: string;
  goal: string;
  requirements: { id: `R${number}`; text: string; source: "explicit" | "implied"; quote?: string; acceptance?: string }[];
  ambiguities: { id: `A${number}`; quote: string; readings: string[]; observableDifference: string; recommended?: number; askUser: boolean }[];
  successCriteria: string[];                                  // investigation: 답이 갖출 것 / creation: 평가 rubric
  invariants: { id: `I${number}`; statement: string }[];
  edgeCases: { id: `E${number}`; ref: string; input: string; expected: string }[];   // execution
  directions?: { id: `D${number}`; idea: string }[];          // creation: 후보마다 다른 방향
  questions?: string[];                                       // investigation: 답해야 할 하위 질문
  // grounded일 때
  behavior?: { current: string; expected: string; evidence?: string }[];
  hypotheses?: { id: `H${number}`; statement: string; confidence: "high" | "medium" | "low"; evidence: string[]; confirmBy: string }[];
  locations?: { area: string; paths: string[]; why: string }[];
  seeds?: { symbols: string[]; files: string[]; strings: string[] };
}
```

사실(path:line, 원문 인용)과 추론(hypothesis와 확인 방법)을 분리하고, 해결책은 쓰지 않는다. d1이었다면 A1에 두 해석, 관측 차이("실패 후 성공 시 2 vs 1"), 권장 해석이 기록된다.

### 5.2 Retrieve adapter

- **code**: `code_nav`(TS LanguageService, 이후 LSP), grep, ast_search. op는 `def`, `refs`, `impl`, `callers`, `callees`, `imports`, `importers`, `tests`, `symbols`, `overview`, `locate`. 출력은 파일별 `줄 종류 문맥`이고 `semantic`/`heuristic` 신뢰도를 붙인다. single의 세션에만 등록하므로 direct main과 front에는 없다.
- **runtime**: 기존 bash 정책 안의 읽기 전용 상태 조회(git, 프로세스, 서비스 상태, 설정 파일, 로그 tail). 변경 명령은 Execution의 Primary만 쓴다.
- **docs / web**: 로컬 문서는 read/grep. web은 Pi 세션에 browser 도구가 있을 때만 쓰고, 없으면 "외부 근거 없음"을 frame에 기록한다.
- **reference**: 기존 에셋 경로, 스타일 가이드, 참조 이미지(`generate_image`의 references).
- adapter 결과는 근거 ID(`S#`)와 참조(경로:줄, 명령, URL)로 ledger에 들어간다. 내용 복사본은 넣지 않는다.

### 5.3 Verifier와 위험 점수 (Execution)

**실행 조건**

| 조건 | 판단 주체 | 동작 |
|---|---|---|
| 위험 점수 ≥ threshold (기본 5) | runtime | 자동 실행 |
| 요청문에 검토나 검증 요청이 있음 | runtime | 점수와 상관없이 실행 |
| docs만 변경, 또는 1개 파일 10줄 이하이고 모든 met 항목에 `verifiedBy`가 있음 | runtime | 건너뜀 |
| 사용자가 나중에 따로 검증을 요청 | front | `orche_task {mode: "verify", task}` |
| 설정 `checker.gate` | 사용자 | `"auto"` / `"always"` / `"off"`(수동만) |

**위험 점수** (순수 함수, LLM 호출 0)

| 신호 | 가중치 |
|---|---:|
| 변경 파일 3개 이상 | +2 |
| 최상위 디렉터리 2개 이상 | +2 |
| 위험 도메인 패턴(동시성, 트랜잭션/영속성, 인증/보안, 경로, 금액/반올림, 캐시 무효화, 파싱/인코딩), 최대 2개 | 도메인당 +2 |
| Jev `risk=high` | +2 |
| 소스는 바뀌었는데 테스트는 그대로 | +2 |
| met 항목 중 `verifiedBy`가 없는 것 | +2 |
| 대응 테스트가 없는 edge case | 1개당 +1 (최대 3) |
| 사용자 결정 없이 권장 해석으로 진행한 모호성 | 1개당 +1 (최대 2) |
| 150줄 이상 변경 | +2 |

- 점수와 기여한 신호는 실행 여부와 함께 결과와 ledger에 남긴다. 예: `risk 8 ≥ 5 → verify (동시성 +2, 파일 3개 +2, edge case 테스트 없음 +2, verifiedBy 없음 +2)`.
- 후속 implement는 마지막 검증 이후의 diff로 점수를 낸다.

**Verifier 세션**: 입력은 원문 요청, frame, task baseline 이후 diff, worker checklist(검증할 주장으로 표시)다. worker transcript는 주지 않는다. 도구는 read-only, `code_nav`, trusted check bash이고, 쓰기는 `.orche/scratch/<task>/`(gitignore, 테스트 glob에 걸리지 않는 `*.probe.*` 이름)에만 허용한다. 결과는 `verdict`, `trace`(R-id별 covered/partial/missing), `findings`(executed/static 구분, 6개 이하)다. `blocking`이려면 executed 증거나 원문 인용이 필요하다. fix 뒤에는 runtime이 probe와 check를 다시 실행한다(LLM 없음).

### 5.4 Critic (Investigation, Creation)

- **Investigation**: Primary의 결론과 인용 근거를 받아 반론, 빠진 근거, 논리 비약만 낸다. 새 답을 쓰지 않는다. 근거 ID로 지적한다.
- **Creation**: 후보들을 frame의 rubric(`successCriteria`)으로 비교하고 순위와 이유를 낸다. 결정적인 형식 검사(크기, 포맷, 투명도, 파일 유효성)는 critic 전에 runtime이 한다.
- 동급 모델을 쓴다(저가 low critic은 잡음이 많았다).

## 6. 컨텍스트 보존

원칙: **상태는 ledger에, 작업 context는 task당 Primary 하나에, 나머지는 일회용.**

### 6.1 세션별로 무엇을 갖는가

| 세션 | 수명 | context에 들어가는 것 |
|---|---|---|
| Front | 사용자 세션 | orche_task 호출과 압축 결과, 결정 질의응답. compaction 뒤 ledger 요약을 다시 넣는다 |
| Jev | 무상태 | 요청 원문, workspace 신호, phase, 결과 라벨 |
| Framer, Critic, Verifier | 1회 | 자기 몫의 ledger projection, 자기 탐색. 결과만 ledger로 |
| Generator ×N | 1회 | brief와 자기 방향(D#)만. 다른 후보는 보지 않는다(다양성 유지) |
| Primary | task 동안 지속, phase 사이 재사용 | ledger에서 렌더한 hand-off, 자기 작업 |

### 6.2 지금 single의 장치는 그대로 간다

| 지금 single | 새 single |
|---|---|
| front는 hand-off와 결과만 가진다 | 그대로이고 더 얇아진다. 요구사항 작성, 역할 선택, 검토용 탐색이 front에서 빠진다 |
| persistent worker 재사용 (idle 30분, pool 3) | Primary로 그대로. phase가 바뀌어도 재사용한다 |
| 50% compaction과 essentials 복원 | 메커니즘은 그대로. essentials만 compaction 시점의 ledger 렌더로 바꾼다 |
| assignment 경계 projection, stale-context 알림 | 그대로 |
| main 모델 상속 | 기본값 그대로. 정책이 effort를 올리거나 route를 지정할 때만 바뀐다 |
| 2회 미충족 → 새 worker에 미충족 항목만 | 그대로. 브리핑을 ledger에서 만든다 |

### 6.3 Task ledger

```ts
interface TaskLedger {
  v: 2; taskId: `T${number}`;
  originalRequests: { at: number; text: string }[];                     // 원문, 추가만
  routing: { at: number; descriptor: Descriptor; source: "jev" | "rules" | "override"; policy: ExecutionPolicy }[];
  phase: { current: "investigation" | "execution" | "creation" | "done"; transitions: { from: string; to: string; reason: string; at: number }[] };
  frame?: Frame;
  decisions: { id: `A${number}`; chosen: number | string; by: "user" | "recommended" }[];
  evidence: { id: `S${number}`; kind: "code" | "runtime" | "docs" | "web" | "reference"; ref: string; claim: string }[];  // 참조와 한 줄 주장만
  candidates?: { id: `C${number}`; direction: string; artifacts: string[]; summary: string; rank?: number; selected?: boolean; rationale?: string }[];
  primary?: { workerId: string; model?: string; effort?: string; assignments: number };
  findings: { id: `F${number}`; source: "critic" | "verifier"; severity: string; claim: string; status: "open" | "fixed" | "dismissed"; probe?: string }[];
  baseline: { snapshot?: string };
  history: { at: number; stage: string; summary: string; record?: string }[];   // 50개 이하
}
```

- 저장: 메모리에 두고, 단계마다 `pi.appendEntry("orche-ledger", …)`로 context 밖에 남긴다. reload 뒤에는 `session_start`에서 복원하고, records에는 `ledger.json`으로 남긴다.
- **Primary essentials**(compaction 때 복원): 원문 요청, 현재 phase와 범위, 요구사항 상태, 결정, invariant와 edge case, 이번 phase에 관련된 근거 ID와 참조, 선택된 후보, 열린 finding, 현재 Task DAG. investigation에서는 근거 목록이, creation에서는 선택 이유가, execution에서는 요구사항과 finding이 compaction 뒤에도 남는다.
- **Front essentials**: main 세션 compaction(`session_compact`) 뒤 진행 중인 task의 ledger 요약을 한 번 다시 넣는다.
- **재브리핑**: worker가 사라진 경우(reload, TTL, LRU, 2회 미충족) ledger만으로 새 Primary를 브리핑한다. 이전 transcript 경로도 함께 넘긴다.
- **예산**: Primary essentials 8천 자, front 요약 task당 2천 자, frame 6천 자, finding 6개, 근거 50개(참조와 한 줄 주장만), 후보 5개.

### 6.4 새 구조가 컨텍스트를 아끼는 지점

- specialist의 탐색, 생성, 검증 잡음은 front에도 Primary에도 들어가지 않는다.
- Creation의 후보 N개는 서로의 context를 공유하지 않으며, Primary에는 선택된 후보와 이유만 들어간다.
- code_nav 같은 결정적 retrieve는 파일 전체 대신 범위만 읽게 한다.
- fix 뒤 recheck를 LLM 없이 해서 검증 context가 두 번 생기지 않는다.
- Jev 라우팅은 front context를 쓰지 않는다. front LLM이 역할을 고르느라 추론하는 일이 없어진다.

## 7. Front와 `orche_task`

```ts
{
  request: string,                                         // intent, 제약, Original request 원문
  context?: string,
  task?: string,                                           // 같은 작업의 후속, 승인, 전환
  decisions?: { id: string; choice: number | string }[],  // needs_decision 답, 승인 포함
  mode?: "investigate" | "execute" | "create" | "verify",  // 선택적 override. 없으면 Jev+규칙이 정한다
  files?: string[],
  git?: { commit?: boolean; push?: boolean; remote?: string; branch?: string }
}
```

- 기존 `role`(implement/answer/explore/verify/game-asset/video)은 없앤다. `mode`는 사용자가 형태를 명시했을 때만 쓴다. game-asset과 video는 domain과 loadout으로 흡수되어, 정책이 Creation 또는 Execution을 고르고 `generate_image` 등 해당 도구를 붙인다.
- front가 하는 일: 대화, 요청 전달(원문 포함), needs_decision과 승인 질문을 사용자에게 전달, 결과 보고.
- front가 하지 않는 일: 코드 탐색과 구현, 요구사항 작성, topology와 역할 선택, 검증 여부 판단.
- 결과는 3천 자 이하로 렌더한다: 요약, phase와 정책(왜 이 형태인지), 요구사항 상태, 결정과 가정, finding 상태, 후보와 선택, 변경 파일, record 경로.

## 8. 비용 통제

- Jev는 약 0.25초이고, Pi 카탈로그 가격이 없어 비용이 0으로 기록된다(토큰은 기록).
- 기본 경로는 가볍다: frame `skip`/`spec`, critique·verify는 gate, generate는 creation에서만.
- 지금 single은 direct의 2.3배다. 새 single의 목표는 "같은 품질이면 지금 single의 1.1배 이하, 품질이 오르면 1.3배 이하"다(10.4).

## 9. 설정

```jsonc
{
  "mainMode": "single",
  "routes": {
    "framer": {}, "critic": {}, "checker": {}, "generator": {},   // 선택. 없으면 main 상속 ("checker"는 라이브러리 엔진의 "verifier"와 구분)
    "primary-deep": {}                                           // 선택. effort xhigh 대신 다른 모델을 쓸 때
  },
  "single": {
    "pipeline": "v2",                                            // 출시 중 기본 "v1"(지금 single)
    "router": { "classifier": "typesafe/jev-latest", "timeoutMs": 2000, "minConfidence": 0.6, "minMargin": 0.2, "shadow": false },
    "policy": { "rules": "default", "bugReports": "fix" },        // 3.2 표의 override 경로. bugReports: "fix"(기본) | "diagnose"
    "checker": { "gate": "auto", "threshold": 5, "maxFixRounds": 1 },
    "creation": { "candidates": 3 },
    "nav": { "enabled": true, "lsp": { "python": "pyright-langserver --stdio", "rust": "rust-analyzer" } },
    "maxTransitions": 4
  },
  "taskContext": { "clearBetweenAssignments": true, "minClearTokens": 10000 }   // 기존
}
```

`single`은 `contextWarning`처럼 extension 전용 키로 두고 `loadOrcheConfigFile`에서 검증한다. `router.shadow: true`이면 정책을 계산해 기록만 하고 동작은 바꾸지 않는다(Phase 2).

## 10. 실험과 gate

### 10.1 라우팅 평가 (오프라인, 비용 거의 0)

- **데이터 (2026-10-04 추출)**: Pi와 OMP main 세션의 사용자 요청 861건(21개 프로젝트)이 후보다. 중복, slash 명령, 도구가 만든 프롬프트(omp commit), `/tmp` 벤치마크 세션은 뺐다. 여기서 프로젝트별로 고르게 100건을 뽑았다(첫 요청 75, 후속 메시지 25). 파일은 `results/routing-eval/{extract.py, sample.jsonl, labels.md, labels.provisional.jsonl}`이고 로컬 전용이다.
- **라벨 (확정, `labels.confirmed.jsonl`)**: execution 57, investigation 41, respond 2. 지시 없는 버그 보고 16건은 모두 execution이다(`bugReports: fix`). 후속 25건 중 새 작업은 8건뿐이고, 나머지는 승인·정정·제약·질문·결함 보고·재출력이다. 그래서 `turn` 질문을 넣었다.
- **Creation 보충 (`creation.provisional.jsonl`, 임시 라벨)**: 이 PC 기록에는 창작 요청이 없어서, 다른 PC에서 가져온 세션(`results/sessions/`, 요청 1,045건, `candidates.imported.jsonl`)의 게임 프로젝트 3개에서 23건을 골랐다. creation 16(광고 이미지, 썸네일, 아이콘, 테마 에셋, UI 테마, 이펙트, 맵 비주얼), 그리고 비슷하지만 creation이 아닌 것 7(기획 문서 execution 3, 에셋 질문·계획 investigation 4)이다. 두 번째 묶음은 에셋 관련이면 무조건 Creation으로 보내는 라우터를 잡기 위한 것이다.
- **대조군**: (a) Jev + 규칙, (b) 규칙만, (c) main 스스로 고르기(om-orche Judgment/Production 안내 방식), (d) front 모델 분류, (e) 최빈값 기준선(모두 execution이면 100건 중 57%).
- **지표**: topology 정확도, 클래스별 recall, 예측 분포와 정답 분포의 차이, `turn` 정확도, 혼합 요청(분석 후 구현) 처리, 승인 없는 변경으로 이어지는 오판, 지연, 비용.
- **Gate G-R**: Jev+규칙이 다음을 모두 만족해야 한다.
  - topology 정확도 85% 이상, 다른 대조군보다 낮지 않음.
  - **클래스별 recall 0.75 이상**, 그리고 가장 큰 클래스의 예측 비율이 정답 비율과 15%p 이상 차이 나지 않음. 한 라벨로 쏠리는 분류기(예전 jev_router처럼)는 여기서 탈락한다.
  - `turn` 정확도 80% 이상, 승인 없는 변경으로 이어지는 오판 2% 이하.
  - 못 넘으면 이긴 방식(규칙이나 main 스스로 고르기)을 쓰고, Jev는 effort 선택에만 남긴다.
- **결과 (2026-10-04, 사전 등록한 1회 실행, 결과를 보고 규칙·프롬프트를 고치지 않음)**: `experiments/routing/evaluate.ts`(당시 프롬프트는 `v1`), 보고서는 로컬 `results/routing-eval/runs/`. 123건(정답 respond 2, investigation 45, execution 60, creation 16). LLM arm은 cliproxyapi/gpt-6.1-sol high.

  | arm | 정확도 | 변경 여부 정확도 | 승인 없는 변경 | 놓친 변경 | creation recall | turn(후속 34) | 호출당 지연 |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | 최빈값(전부 execution) | 48.8% | 61.8% | 38.2% | 0% | 0% | – | – |
  | 규칙만 | 75.6% | 78.9% | 13.0% | 8.1% | 81% | 26/34 | 0 |
  | **Jev+규칙 (설계안)** | 88.6% | 92.7% | 3.3% (4) | 4.1% | 75% | 25/34 | 0.2초 |
  | Jev 원시값(gate 없음) | 89.4% | 91.9% | 4.9% | 3.3% | 88% | 21/34 | 0.2초 |
  | **LLM + 우리 정의 (front가 고름)** | **90.2%** | **97.6%** | **1.6% (2)** | 0.8% | 50% | 23/34 | 5.1초 |
  | LLM + om-orche 정책 (main 스스로) | 70.7% | 85.4% | 0% | 14.6% | 0% | – | 4.7초 |

  - G-R: Jev+규칙은 정확도(≥85%)·분포 차이는 넘었지만 승인 없는 변경(≤2%), 다른 arm 이상, turn(≥80%), respond recall(1/2)을 못 넘었다 → **불합격**. Jev의 risk·uncertainty 답은 gate를 123건 중 42·19건만 통과해 effort 선택에도 쓰기 어렵다.
  - 가장 나은 방식은 우리 정의를 준 LLM이다(정확도·승인 없는 변경 기준 충족). 단 creation recall 50%: "만들고 적용"하는 요청 8건을 execution으로 골랐다. 프롬프트가 혼합 요청(creation 먼저, 그다음 execution)을 정의하지 않은 탓으로 보인다(사후 해석). 비용은 호출당 입력 약 800·출력 약 70 token.
  - om-orche 정책은 변경을 한 번도 잘못 고르지 않았지만, 지시 없는 버그 보고를 모두 Judgment로 보내 변경의 14.6%를 놓쳤다.
  - 한계: 라벨은 assistant가 붙였고 creation은 사용자 검토가 없다. 질문·규칙·프롬프트는 라벨을 본 뒤 썼고 held-out 세트가 없다. LLM 프롬프트가 라벨 기준과 거의 같아 LLM arm에 유리하다. 입력은 원문과 직전 응답 끝 400자뿐이라, 대화 전체를 보는 실제 front보다 불리한 조건이다. respond 2건·creation 16건은 표본이 작다.
  - 함의: 작업 유형은 front가 고른다. 별도 분류기 호출이 없으므로 지연·비용도 없다. 후속 메시지는 `task`가 담당한다.
- **후속 실행 (2026-10-05, 사후)**: v1의 creation 오류를 본 뒤 혼합 요청 규칙("적용까지 요청해도 creation 먼저")을 넣은 제품 문구(`front`)를 여러 모델로 돌렸다. 같은 세트에 맞춘 수정이라 creation 개선은 냉정하게 봐야 한다.

  | arm (프롬프트 `front`) | 정확도 | 변경 여부 정확도 | 승인 없는 변경 | 놓친 변경 | creation recall | 지연 중앙값 | 123건 카탈로그 비용 |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | gpt-6.1-sol high | 96.7% | 98.4% | 0.8% (1) | 0.8% | 94% | 4.6초 | $0.27 |
  | claude-opus-5-5 high (사용자 main 모델) | 94.3% | 96.7% | 1.6% (2) | 1.6% | 88% | 3.2초 | $0.64 |
  | gpt-6-luna low | 89.4% | 94.3% | 2.4% (3) | 3.3% | 63% | 2.4초 | $0.01 |
  | Jev+규칙 (비교용 재실행) | 87.8% | 91.9% | 3.3% (4) | 4.9% | 75% | 0.2초 | – |

  - 두 고급 모델은 승인 없는 변경 기준(≤2%)을 넘고, 저가 모델(luna low)은 넘지 못한다. front는 사용자의 main 모델이므로 추가 비용은 없다. turn 정확도는 모든 arm이 21–26/34로 낮지만, 제품에서는 front가 `task`로 후속을 명시하므로 쓰지 않는다.
  - 다른 모델 평가: `npx --no-install tsx experiments/routing/evaluate.ts --arm llm:<provider>/<model>[:<thinking>][:front|v1|omorche] --arm classifier:<provider>/<model>`. 실행마다 `results/routing-eval/runs/<시각>-<label>/`에 보고서가 쌓이고 `runs/index.md`가 전체를 비교한다. 분류기는 Pi 카탈로그의 classifier 모델이면 무엇이든(TypeSafe, OpenRouter, Cloudflare, llama.cpp), LLM은 자격 증명이 있는 모든 모델을 쓸 수 있다.

### 10.2 topology별 end-to-end

| 세트 | 과제 | arm | 1차 지표 |
|---|---|---|---|
| X (Execution) | d1, d6, 새 해석·edge 과제, 저장소 규모 SWE 과제(orche와 사용자 저장소의 커밋 이력), 쉬운 과제(a1, a6, b2, c1) | S0(지금 single), S1, S1−frame, S1−verify, S1−nav | pass, 모호성 탐지율, 성공당 비용 |
| I (Investigation) | a5, b4, c3 + 새 분석·기술 비교·아키텍처 질문 (blind rubric) | S0(answer worker), S1, S1−critique | rubric 충족률, 근거 인용률, 비용 |
| C (Creation) | 새 과제: 아이콘 세트, UI 문구, 레벨 아이디어 등 (rubric + 쌍대 선호) | N=1, N=3+critic, N=3+사용자 선택 | 선호 승률, 형식 검사 통과, 비용 |
| T (전환) | "분석하고 괜찮으면 구현" 같은 혼합 요청 | S1 | phase 순서 정확도, 승인 guard 위반 0, 재사용률(재조사 read 수) |
| L (장기 세션) | longsession 8과제 연속 | S0, S1 | front context 최대값, compaction 뒤 ledger ID 보존율, 회귀 수 |

### 10.3 Ablation (BOAD-lite)

primitive를 하나씩 끈 arm(S1−X)과 비교한다. 품질이 같고 더 싸면 그 primitive는 그 topology의 기본 정책에서 뺀다. 결과는 3.2 규칙 표에 반영한다.

### 10.4 Gate

| Gate | 조건 | 미달 시 |
|---|---|---|
| G-L (ledger) | L에서 front context 최대값 ≤ S0, compaction 뒤 ledger ID 보존 100%, 회귀 증가 0, 비용 +5% 이하 | 렌더와 예산 조정 |
| G-R (라우팅) | 10.1 참조 | 더 나은 선택 방식을 쓴다 |
| G-X / G-I | 품질 ≥ S0이고 과제별 감소 없음. 성공당 비용은 품질이 오르면 1.3배, 같으면 1.1배 이하. X는 모호성 탐지율 80% 이상 | 해당 topology는 v1 동작 유지 |
| G-C | N=3이 N=1 대비 선호 승률 60% 이상이고 비용 2배 이하 | N=1 기본 |
| G-T | 승인 guard 위반 0, phase 순서 정확도 90% 이상 | 전환 자동화를 끄고 front 승인으로만 |
| 공통 | ownership/parity 위반 0. unknown usage가 있으면 HOLD | — |

표본이 작으므로 결과는 서술적으로 다루고, task 단위 paired bootstrap을 보조로 쓴다.

## 11. 로드맵

```text
Phase 0  E0: 실패 분류 고정, 위험 점수 보정, 라우팅 정답셋, Jev spike(ctx.modelRegistry.classify), 하네스 arm
Phase 1  ledger v2 + Primary/front essentials + reload 복원           ──► G-L   (topology와 무관, 지금 single에 먼저 적용)
Phase 2  Policy Router 오프라인 평가                               ──► G-R 불합격 (Jev+규칙) → front `mode`로 대체, shadow 연결 안 함
Phase 3  Execution(code): framer, code_nav, Primary, 위험 점수, verifier, recheck ──► G-X
Phase 4  Investigation + 상태 기계 전환(승인 guard)                    ──► G-I, G-T
Phase 5  Creation: generator×N, critic/선택, refine (game-asset/video loadout)      ──► G-C
Phase 6  runtime·LSP adapter, 도그푸딩(사용자의 Python·Rust 저장소), gate 결과로 v2 기본값 결정
```

**진행 상황 (2026-10-04)**

- Phase 0: 라우팅 정답셋 100건 라벨을 확정했고(`labels.confirmed.jsonl`), Creation 보충 23건(임시 라벨)을 다른 PC 세션에서 추출했다(10.1).
- Phase 1: 구현했다. `"single": { "ledger": true }`로 켜는 opt-in이며 기본은 꺼짐이다. 구현은 `src/single/ledger.ts`(ledger, 렌더, 복원)와 `src/extension/workers.ts`, `src/extension/index.ts` 연결이고, 테스트는 `test/single/ledger.test.ts`, `test/extension/task-ledger.test.ts`, `test/extension/config.test.ts`다.
- G-L (`results/compare/ledger-2026-10-04/README.md`): longsession과 같은 8과제 연속 세션을 S0와 S0+L 각 3반복 실행했다(12:09–14:09 UTC, parity·identity 전부 유효). **정의한 기준은 통과했다**: 통과 21/24 → 22/24(알려진 d1·d6 실패의 위치만 바뀜, 노이즈), 회귀 0, 비용 −0.1%, wall +0.9%, main context 최대 123,184 → 122,327, worker compaction 3회 모두 ledger 포함·현재 R-id 전부 유지.
  - 검증되지 않은 경로: main compaction 0회(최대 123K/272K)라 main ledger 요약은 쓰이지 않았고, worker가 사라진 적이 없어 ledger 이어받기도 없었다. 과제가 독립적이라 후속 요청도 없었다.
  - 발견 1 (ledger 범위): main이 한 worker를 8개 과제에 모두 재사용해서, ledger 하나에 무관한 과제가 쌓였다(세션당 요구사항 46–53개, 해석 13–21개). c4 작업 중 compaction에서 p1·d1·p2의 해석이 "사용자가 바꾸지 않는 한 유지"로 들어갔다. task 경계를 명시하는 `task` 파라미터(7장)가 필요하다.
  - 발견 2 (저장 크기): 변경마다 ledger 전체를 entry로 남겨 main 세션 파일이 2.3–2.5배(8과제당 +0.7MB)가 됐고, 작업 수에 따라 제곱으로 늘어난다. 변경분만 남기고 복원 때 재생해야 한다.
  - 발견 3 (ledger와 무관): 649990c에서 main에게 "각 요구사항의 verifiedBy 검사가 수용 기준을 실제로 확인하는지 확인하라"는 감독 규칙을 넣은 뒤, main이 테스트 파일을 읽게 되었다. longsession(7c882ab)과 비교하면 세션당 main read 37 → 59회, read 결과 94K → 235K자, main context 최대 75,773 → 123,184(p90 57,564 → 100,536)이고 통과율은 나아지지 않았다(22/24 → 21/24). 다른 시점 실험 간 비교라 인과는 아니지만, single의 컨텍스트 보존 장점을 깎는다. 새 구조에서는 front가 검증을 하지 않고 Verifier가 위험 점수로 맡는다(5.3).
- Phase 1 구현에서 문서와 달라진 점: 이번 단계에서는 진행 중인 지시(R-id)를 ledger의 원본으로 쓰지 않는다. worker essentials에는 지금처럼 현재 hand-off 원문을 그대로 두고, 그 옆에 ledger 렌더를 덧붙인다. 요구사항 ID는 assignment마다 다시 시작하므로 ledger는 (assignment, id)로 구분한다.
- G-L 뒤 수정(2026-10-04): (1) `orche_task`에 `task`를 넣었다. 결과마다 `Task ledger T…, assignment n`을 알려 주고, `task`를 넘길 때만 같은 task를 잇는다(다른 worker·새 worker로도). 생략하면 worker를 재사용해도 새 task다. task가 다른 worker에게 넘어가면 새 worker는 이전 상태의 ledger briefing을 받는다. 사라진 worker id는 그 worker가 맡았던 `task`와 함께일 때만 받고, 아니면 오류 메시지가 마지막 task를 알려 준다. 2회 미충족 안내도 `task`를 유지하라고 말한다. (2) 세션에는 변경 이벤트(create·handoff·result·failure)만 남기고 복원 때 재생한다. 이벤트 하나는 해당 변경분 크기뿐이다(테스트: 70 assignment에서 최대 2KB 미만, snapshot 방식의 10% 미만). (3) main 감독 규칙 완화(결정 8).

## 12. 파일 계획 (요약)

| 구분 | 위치 | 내용 |
|---|---|---|
| 신규 | `src/single/ledger.ts` | ledger v2, 역할별 렌더, 저장과 복원 |
| 신규 | `src/single/router.ts` | Jev descriptor(질문 정의, gate, fallback), 규칙 엔진, decision log, shadow 모드 |
| 신규 | `src/single/runner.ts` | topology 템플릿, 상태 기계, 승인 guard, escalation, needs_decision |
| 신규 | `src/single/{framer,critic,verifier,generator,risk}.ts` | primitive 계약과 prompt |
| 신규 | `src/specialists/session.ts` | 일회용 세션 공통부(`runAdvisorSession` 패턴 일반화) |
| 신규 | `src/tools/nav/*`, `src/single/retrieve/*` | code_nav, runtime/docs/reference adapter |
| 수정 | `src/extension/workers.ts` | Primary 실행기로 축소(spawn, 재사용, compaction, projection, audit, git 유지), essentials를 ledger 렌더로 |
| 수정 | `src/extension/{index,mode,config,records}.ts` | `orche_task` 인터페이스(`mode`, `task`, `decisions`), front 규칙, `single` 설정, ledger record |
| 수정 | `src/eval/*` | arm, 라우팅 평가 스크립트, longsession 연결, specialist actor 귀속 |
| 변경 없음 | direct 경로 전부, `session-factory.ts`의 compaction 메커니즘, `context-projection.ts` | |

## 13. 하지 않을 것

- direct 변경.
- Jev가 문제를 쪼개고, 배분하고, 중간 결과로 재배분하는 중앙 orchestrator가 되는 것.
- 모든 작업에 하나의 고정 DAG를 쓰는 것.
- Execution과 Investigation에서 같은 문제를 푸는 병렬 worker. 병렬은 Creation의 generator(N 상한)만 허용한다.
- BOAD의 UCB 기반 specialist 자동 생성. 대신 ablation과 usefulness 기록으로 정책 표를 고친다.
- 승인 없는 상태 변경.

## 14. 리스크와 열린 질문

1. **Jev 오분류**: shadow 모드로 먼저 정확도를 확인한다. 승인 guard가 위험한 오분류(승인 없는 변경)를 막고, 전환 규칙이 나머지를 교정한다.
2. **이전 결정과의 충돌**: om-orche는 9/29에 Jev 라우팅을 main 스스로 고르기로 바꿨다. 10.1에서 정면 비교하고 이긴 방식을 쓴다.
3. **비용**: specialist가 늘어난다. 모든 추가 단계를 gate로 두고, 정책 표는 ablation 결과로만 넓힌다.
4. **Creation 평가의 주관성**: rubric과 쌍대 선호를 함께 쓴다. 표본이 작다는 점은 결과에 명시한다.
5. **retrieve 범위**: web과 운영 환경 조회는 도구와 권한에 달려 있다. 처음에는 code, 로컬 문서, 읽기 전용 상태 명령까지만 하고, 나머지는 있을 때만 쓴다.
6. **재진술 손실**: 원문 요청은 모든 단계에 그대로 전달하고, hand-off는 ledger에서 결정적으로 렌더한다.
7. **깨지는 변경**: `orche_task`의 `role` 제거(`mode` override로 대체), front 규칙 재작성. single 테스트와 CHANGELOG를 함께 갱신한다.
