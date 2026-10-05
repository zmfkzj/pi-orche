# 새 single 설계: 작업 유형 · topology · 컨텍스트 보존

> **상태 (2026-10-05): Phase 1·2 완료. Phase 3(v2)은 opt-in으로 구현했고 G-X 1단계는 불합격(10.5). 그 분석에서 나온 `mainReview: "report"`(main이 결과를 다시 확인하지 않음)는 G-M·G-M2를 통과해 single 기본값이 되었다(10.6–10.7). 다음 할 일은 11.1에 있다.** 처음 기준은 HEAD `68f3624`였다(auto/multi 모드와 orche_run을 Pi 패키지에서 제거, multi 엔진은 라이브러리로만 유지). 진행 상황은 11장에 있다.
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
> 5. 구현 순서는 Phase 1(ledger) → Phase 2(라우터 평가) → Phase 3(Execution)다.
> 6. 지시 없는 버그 보고(로그·에러만 붙여 넣은 요청)의 기본 동작은 `fix`다: 진단한 뒤 바로 고친다.
> 7. 라우팅 정답셋 100건의 라벨을 확정했다(6번 정책을 적용해 버그 보고 2건을 execution으로 바꿈). Creation 보충 23건은 다른 PC 세션에서 추출했고, 사용자 검토 없이 임시 라벨 그대로 쓴다.
> 8. main의 감독 규칙에서 "verifiedBy 검사가 수용 기준을 확인하는지 확인" 부분을 뺐다(비교 실험 없이). 해석을 원문과 대조하는 규칙과 미확인 항목 보고는 유지한다.
> 9. ledger 결함 수정: `orche_task`의 `task`로만 task를 잇고(생략하면 worker를 재사용해도 새 task), 세션에는 변경 이벤트만 남긴다. ledger 이득 측정 실험은 하지 않는다.
> 10. G-R(10.1)에서 Jev+규칙은 기준 미달이고, 우리 정의를 준 LLM(front가 고르는 방식)이 가장 정확했다. **확정 (2026-10-05)**: 작업 유형은 front가 고른다. single 규칙에 작업 유형 정의(`src/single/work-types.ts`)를 넣었고, 지금은 유형을 기존 role로 위임한다(별도 `mode` 필드는 Creation 파이프라인이 생길 때 다시 본다). 사용자 요청에 따라 Jev가 아닌 다른 모델(분류기나 LLM)도 `experiments/routing/evaluate.ts`의 `--arm`으로 바로 평가할 수 있게 했다.
> 11. Phase 3 진행(사용자 승인, 2026-10-05). 구현은 opt-in `single.pipeline: "v2"`이고, 기본값은 G-X 결과로만 바꾼다.
>
> **핵심:** 코딩 전용 고정 파이프라인을 버리고, **대화 전체를 보는 front가 작업 유형을 고르고, 유형별 topology가 필요한 capability(frame, retrieve, verify …)를 붙이는** 구조로 바꾼다. 문제 해결의 소유자는 task마다 하나인 persistent Primary worker다. 그 밖의 specialist는 모두 한 번 쓰고 버리는 세션이며, 작업 상태의 원본은 task ledger에 둔다. (처음 설계는 Jev 분류기가 유형을 고르는 것이었으나 G-R에서 탈락했다. 3장은 그 기록이다.)

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
- 이번 설계와의 차이: (a) 선택을 다시 Jev와 규칙으로 외부화하되, 위 실패에 대한 대책을 넣는다(3.1의 "이전 실패에 대한 대책"). (b) Creation topology를 추가한다. 그러므로 10장 실험에서 **main 스스로 고르기(om-orche 방식)**를 반드시 대조군으로 둔다. (a)는 G-R(10.1) 뒤 철회했다: front가 고른다.

### 1.3 Pi에는 Jev가 이미 들어 있다

- Pi 1.0에는 classifier 모델이 내장되어 있다. Pi 카탈로그에 `typesafe/jev-latest`(type `classifier`)가 있고, TypeSafe 자격 증명이 있으면 쓸 수 있다.
- extension은 `ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest")`와 `ctx.modelRegistry.classify(model, { state, questions }, { signal })`로 호출한다. 질문은 `choice`(확률과 confidence), `score`(순서 척도), `bool`(확률) 세 종류이고, 한 번 호출로 여러 질문에 답한다.
- Pi 예제 `examples/extensions/jev-router.ts`는 같은 API로 virtual model을 만들어 계획 모델을 고른다.

## 2. 전체 구조

```text
User ⇄ Front (single 모드 main: 대화·승인·보고, 편집 불가. 작업 유형을 고름: respond/investigation/execution/creation)
          │ orche_task {role, request, task?}
          ▼
   Topology runner (작은 상태 기계: investigation ⇄ execution, creation → execution)
          │   Phase 3 구현: execution = frame → Primary → 위험 점수 → [verify → fix → recheck]
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
| Code Navigator | Evidence / Context Acquisition | `retrieve` primitive. 결정적 도메인 adapter(`code_nav`), 부족하면 grounded Framer가 읽음 |
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
- **전환 신호**: Primary는 `report_result.data.next`(`analysis_done`, `needs_change_authorization`, `premise_broken`, `blocked`)를 낸다. runtime은 이를 결과에 담아 front에 넘기고, front가 대화를 보고 다음 작업 유형을 고른다(G-R 뒤 변경; 처음 설계는 `lastOutcome`을 Jev에 넘기는 것이었다). Primary가 다음 단계를 직접 고르지는 않는다.
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

**Phase 3 구현 (`src/single/frame.ts`, Execution용)**: 위 인터페이스를 줄였다. `goal`, `requirements`(`kind`: explicit/implied/edge, `acceptance` 필수, explicit은 `quote`), `ambiguities`(`readings` 2–4, `observableDifference`, `recommended`, `why`, `askUser`, `affects`), `invariants`(문장), `locations`(grounded일 때)다. edge case는 별도 E-id 대신 `kind: "edge"`인 R-id다. 그래서 지금의 checklist·ledger·compaction 장치가 그대로 edge case까지 다루고, worker는 edge마다 `verifiedBy`를 대야 한다. 렌더한 contract는 hand-off의 맨 앞(front 요청 원문보다 앞)에 놓인다. `R…:` 줄과 들여 쓴 `Acceptance:` 줄이 요구사항 정의가 되고, compaction 때 hand-off와 함께 복원된다. front가 R-줄을 썼다면 Framer는 같은 id를 유지해야 한다(어기면 보고가 거부되고 Framer가 고친다). 후속 assignment에서는 이전 contract와 결과를 받아 id를 이어 간다. `askUser` 모호성은 아직 실행을 멈추지 않는다(needs_decision 보류): 권장 해석으로 진행하고 결과에 “needs the user's decision”으로 남겨 front가 사용자에게 묻는다. Framer가 실패하면 contract 없이 진행하고 결과에 경고를 남긴다.

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
| 위험 점수 ≥ threshold (기본 7, 아래 보정) | runtime | gate `auto`일 때 자동 실행. G-X 뒤 기본 gate는 `review`(점수는 기록만) |
| 요청문에 검토나 검증 요청이 있음 | runtime | 점수와 상관없이 실행 |
| docs만 변경, 또는 1개 파일 10줄 이하이고 모든 met 항목에 `verifiedBy`가 있음 | runtime | 건너뜀 |
| 사용자가 나중에 따로 검증을 요청 | front | 지금은 verify role assignment(별도 `mode: "verify"`는 미구현) |
| 설정 `checker.gate` | 사용자 | `"review"`(기본, 리뷰 요청 때만) / `"auto"` / `"always"` / `"off"` |

**위험 점수** (순수 함수, LLM 호출 0)

| 신호 | 가중치 |
|---|---:|
| 변경 파일 3개 이상 | +2 |
| 최상위 디렉터리 2개 이상 | +2 |
| 위험 도메인 패턴(동시성, 트랜잭션/영속성, 인증/보안, 경로, 금액/반올림, 캐시 무효화, 파싱/인코딩), 최대 2개 | 도메인당 +2 |
| 소스는 바뀌었는데 테스트는 그대로 | +2 |
| met 항목 중 `verifiedBy`가 없는 것 | +2 |
| 대응 테스트가 없는 edge case | 1개당 +1 (최대 3) |
| 사용자 결정 없이 권장 해석으로 진행한 모호성 | 1개당 +1 (최대 2) |
| 150줄 이상 변경 | +2 |

- 점수와 기여한 신호는 실행 여부와 함께 결과와 ledger에 남긴다. 예: `Risk 8 ≥ 7 → verify (concurrency +2, files (3 files) +2, …)`.
- 위험 도메인은 테스트·문서가 아닌 파일의 바뀐 줄에서만 찾는다. 최상위 디렉터리 신호도 소스 파일만 센다(`src/`+`test/`는 거의 모든 변경이라 변별력이 없다). Jev `risk` 신호는 G-R 뒤 뺐다.
- **threshold 보정 (2026-10-05, `experiments/risk/calibrate.ts`, 결과는 로컬 `results/risk-calibration/`)**: 저장된 v1 single 결과 90개(longsession, G-L 두 arm, multi-vs-single; 실패 7개)에 점수를 매겼다. 실패 7개(d1·d6)는 모두 8점 이상이었다. threshold 5면 74%, 7·8이면 66%를 검증하고 둘 다 실패 7/7을 검증한다. 9면 41%와 2/7이다. 점수는 대부분 짝수라 7과 8은 같고, 7은 실패 최소 점수보다 1점 여유가 있어 기본값을 7로 했다. 한계: 점수는 같은 과제 안에서 통과와 실패를 가르지 못하고 사실상 “큰 과제를 검증”한다. v1에는 contract가 없어 edge·권장 해석 신호(최대 5점)가 0이었으므로 v2 점수는 더 높다.
- 후속 assignment는 그 assignment의 diff로 점수를 낸다(이전 assignment는 그때 점수가 매겨졌다).

**Verifier 세션**: 입력은 원문 요청, frame, task baseline 이후 diff, worker checklist(검증할 주장으로 표시)다. worker transcript는 주지 않는다. 도구는 read-only, `code_nav`, trusted check bash이고, 쓰기는 `.orche/scratch/<task>/`(gitignore, 테스트 glob에 걸리지 않는 `*.probe.*` 이름)에만 허용한다. 결과는 `verdict`, `trace`(R-id별 covered/partial/missing), `findings`(executed/static 구분, 6개 이하)다. `blocking`이려면 executed 증거나 원문 인용이 필요하다. fix 뒤에는 runtime이 probe와 check를 다시 실행한다(LLM 없음).

**Phase 3 구현 (`src/single/check.ts`, `src/single/pipeline.ts`)**: diff는 `.orche/scratch/<task>/change-<n>.diff`로 넘긴다. bash는 main의 trusted-check 정책(`classifyBash`)에 probe 실행(`node|python3|bun|deno|tsx|sh <scratch>/<name>.probe.<ext>`)만 더했다. 쓰기는 scratch 안의 `.probe.` 파일과 `fixtures/`만 된다. `report_check`는 executed blocking에 다시 돌릴 수 있는 `probe` 명령을, static blocking에 요청 원문 `quote`를 요구하고 verdict와 blocking 여부가 맞아야 받는다(아니면 같은 세션에서 고치게 돌려보낸다). blocking finding은 같은 worker에게 fix assignment로 가고(`maxFixRounds`, 기본 1, context 유지), worker는 틀린 finding을 `data.disputed`로 반박할 수 있다. 그 뒤 orche가 probe와 이전에 통과한 check를 다시 돌려 finding을 fixed/open/disputed/unchecked로 표시한다. Verifier가 실패하면 결과를 unverified로 두고 진행한다. Framer와 Verifier는 `routes.framer`/`routes.checker`가 없으면 worker와 같은 모델·thinking(보통 main)을 쓴다.

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
  routing: { at: number; workType: "respond" | "investigation" | "execution" | "creation"; source: "front" | "override" }[];   // (처음 설계는 Jev descriptor; G-R 뒤 변경. 미구현)
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

**구현된 형태 (Phase 1 + Phase 3, `src/single/ledger.ts`)**: 이벤트 로그(`create`·`handoff`·`result`·`failure`, Phase 3의 `check`·`recheck`)를 재생한 상태다. 요구사항은 (assignment, R-id)로 구분하고, Framer가 정한 해석은 hand-off 이벤트에 `by: "framer"`(quote, askUser 포함)로, worker가 보고한 해석은 `by: "worker"`로 남는다. `checks`는 assignment별 위험 점수와 verdict, `findings`는 Verifier finding과 마지막 상태(open/fixed/disputed/unchecked/minor)다. worker essentials에는 아직 고쳐지지 않은 현재 assignment의 finding이, main 요약에는 마지막 위험 점수·verdict와 열린 finding이 들어간다. `routing`, `phase`, `evidence`, `candidates`는 Phase 4–5 몴이다.

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
- 작업 유형은 front가 이미 가진 대화로 고른다. 별도 분류기 호출이나 context가 없다(G-R).
- v2에서는 front가 R-줄 checklist를 쓰지 않고(스모크: S0 2–4줄, S1 0줄), 검증도 다시 하지 않는다.

## 7. Front와 `orche_task`

```ts
{
  request: string,                                         // intent, 제약, Original request 원문
  context?: string,
  task?: string,                                           // 같은 작업의 후속, 승인, 전환
  decisions?: { id: string; choice: number | string }[],  // needs_decision 답, 승인 포함
  mode?: "investigate" | "execute" | "create" | "verify",  // 설계안. 미구현: 지금은 front가 작업 유형을 고르고 기존 role로 위임한다
  files?: string[],
  git?: { commit?: boolean; push?: boolean; remote?: string; branch?: string }
}
```

- (설계안) 기존 `role`(implement/answer/explore/verify/game-asset/video)은 없앤다. `mode`는 사용자가 형태를 명시했을 때만 쓴다. game-asset과 video는 domain과 loadout으로 흡수되어, 정책이 Creation 또는 Execution을 고르고 `generate_image` 등 해당 도구를 붙인다.
- (현재) G-R 뒤 `role`을 유지했다: front가 작업 유형을 고르고 유형을 role로 위임한다(investigation→answer, execution→implement, creation→game-asset/video/implement). v2에서 implement는 Framer와 위험 점수 기반 Verifier를 거친다. `decisions`·`mode`는 needs_decision과 Creation을 넣을 때 다시 본다.
- front가 하는 일: 대화, 요청 전달(원문 포함), needs_decision과 승인 질문을 사용자에게 전달, 결과 보고.
- front가 하지 않는 일: 코드 탐색과 구현, 요구사항 작성, topology와 역할 선택, 검증 여부 판단.
- 결과는 3천 자 이하로 렌더한다: 요약, phase와 정책(왜 이 형태인지), 요구사항 상태, 결정과 가정, finding 상태, 후보와 선택, 변경 파일, record 경로.

## 8. 비용 통제

- 작업 유형 선택은 front가 하므로 추가 호출이 없다. Framer는 implement마다 1회, Verifier는 위험 점수가 threshold를 넘을 때만 돈다.
- 기본 경로는 가볍다: frame `spec`/`off`로 더 줄일 수 있고, critique·verify는 gate, generate는 creation에서만.
- 지금 single은 direct의 2.3배다. 새 single의 목표는 "같은 품질이면 지금 single의 1.1배 이하, 품질이 오르면 1.3배 이하"다(10.4).

## 9. 설정

```jsonc
{
  "mainMode": "single",
  "routes": {
    "framer": {}, "checker": {},                                   // 선택(구현됨). 없으면 worker와 같은 모델·thinking. (설계안: "critic", "generator")
    "primary-deep": {}                                           // 설계안. effort xhigh 대신 다른 모델을 쓸 때
  },
  "single": {
    "ledger": true,                                               // Phase 1(구현): 기본 false, v2면 항상 켜짐
    "pipeline": "v2",                                            // Phase 3(구현): 기본 "v1"(지금 single). v2 = Framer + 위험 점수 Verifier + code_nav + v2 front 규칙
    "frame": "grounded",                                         // 구현: "grounded"(기본) | "spec" | "off"
    "checker": { "gate": "review", "threshold": 7, "maxFixRounds": 1 },   // 구현: gate review(기본)|auto|always|off, threshold 0–30, maxFixRounds 0–2
    "nav": true,                                                  // 구현: v2 세션의 code_nav (설계안: LSP adapter 설정은 Phase 6)
    "mainReview": "report"                                        // 구현(v1): "report"(기본, G-M2 뒤; main이 결과를 다시 확인하지 않음) | "evidence"(이전 동작)
    // 설계안(미구현): "policy": { "bugReports": "fix" }, "creation": { "candidates": 3 }, "maxTransitions": 4. Jev "router" 설정은 G-R 뒤 뺐다.
  },
  "taskContext": { "clearBetweenAssignments": true, "minClearTokens": 10000 }   // 기존
}
```

`single`은 `contextWarning`처럼 extension 전용 키로 두고 `loadOrcheConfigFile`에서 검증한다. 알 수 없는 키와 범위 밖 값은 오류다.

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

### 10.5 G-X 1단계 사전 등록 (2026-10-05, 실행 전에 작성)

- **질문**: Phase 3 구현(파이프라인 v2: grounded Framer, 위험 점수로 켜지는 Verifier, fix 1회와 결정적 recheck, code_nav, v2 front 규칙)이 지금 single(v1)보다 품질을 올리는가, 그 비용은 얼마인가.
- **Arm**: S0 = `single: { ledger: true }`(v1), S1 = `single: { pipeline: "v2" }`(기본값: frame grounded, checker gate auto·threshold 7·maxFixRounds 1, nav 켜짐, ledger 포함). 다른 설정은 같다.
- **프로토콜**: G-L과 같다. 반복마다 Pi RPC main 세션 하나와 monorepo 하나, 8과제 고정 순서(p1, d1, c1, b3, p2, d6, c4, d8), hidden test 채점은 Pi에 되돌리지 않음, arm당 3반복, 6세션 동시 실행. openai-codex/gpt-6.1-sol high, SSE. worker와 specialist는 main 모델을 상속한다. 실험 파일은 로컬 `results/compare/pipeline-2026-10-05/`.
- **1차 지표**: 최종 통과(arm당 24), 과제별 통과, 추정 비용, wall, main context 최대값.
- **파이프라인 지표** (`pipeline-check.ts`): d1 모호성 탐지(`attempts`에 대해 “모든 claim을 셈”과 “실패한 claim만 셈”을 가르는 ambiguity, 또는 실패 뒤 성공의 attempts를 정하는 edge 요구사항), d6 edge 탐지(같은 timestamp가 page/cursor 경계를 넘는 edge 요구사항), Verifier 실행 비율, verdict, fix 횟수, recheck에서 고쳐진 비율, specialist 요청 수.
- **Gate (10.4의 G-X를 이 설계에 맞춘 것)**:
  1. S1 최종 통과 ≥ S0 최종 통과.
  2. S1이 S0보다 3회 중 2회 이상 덜 통과한 과제가 없음.
  3. 성공당 비용: S1이 더 많이 통과하면 S0의 1.3배 이하, 같으면 1.1배 이하.
  4. 탐지율: S1의 d1·d6 6회 중 5회 이상 탐지(≥80%).
  5. parity·identity 100%, unknown usage 0(아니면 HOLD).
- **결정 규칙**: 모두 통과하면 2단계(ablation S1−frame, S1−verify, 쉬운 단일 과제 세트)를 거친 뒤에만 v2 기본값을 제안한다. 비용만 못 넘으면 더 싼 설정(frame spec, 더 높은 threshold)을 2단계에서 사전 등록해 시험한다. 품질(1·2)을 못 넘으면 v1을 기본으로 두고 원인을 분석한다.
- **한계(미리 적음)**: 과제당 n=3. 저장소가 작아 code_nav의 가치는 여기서 잴 수 없다. d1의 모호성은 Framer가 hidden test의 해석을 고를지가 운에 가깝다(탐지와 통과를 따로 본다). 과제가 독립적이라 후속 요청·재개는 다루지 않는다. threshold 7은 같은 과제의 저장된 v1 결과로 보정했다(5.3).
- **Smoke** (a6→a1, arm당 1세션, S1은 Verifier 강제): 둘 다 2/2 통과, parity·identity 유효, unknown usage 0. S1 비용 $0.57(S0 $0.36), wall 899초(S0 600초), main context 최대 12,221(S0 11,719). v2 front는 R-줄을 쓰지 않았고(S0 2–4줄), Framer는 7·11개 요구사항을 썼다. Verifier가 `checks`에 git 조회와 도구 호출을 넣어 설명을 고친 뒤 runtime을 다시 만들었다.
- **결과 (2026-10-05 02:02–05:05 UTC, 6세션 모두 완료, parity·identity 유효, unknown usage 0; 로컬 `results/compare/pipeline-2026-10-05/README.md`)**: **G-X 1단계는 불합격이다(기준 1·3).** 사전에 정한 규칙대로 v1이 기본값으로 남고 v2는 opt-in이다.

  | | S0 (v1) | S1 (v2) |
  |---|---:|---:|
  | 최종 통과 | 23/24 | 22/24 |
  | 과제별 (p1, d1, c1, b3, p2, d6, c4, d8) | 3,3,3,3,3,2,3,3 | 2,2,3,3,3,3,3,3 |
  | 세션당 평균 wall | 5,938초 | 10,642초 (+79%) |
  | 추정 비용(3세션) | $13.80 | $24.10 (+75%) |
  | 성공당 비용 | $0.600 | $1.095 (1.83배) |
  | 요청 수 | 813 | 1,340 (specialist 369: Framer 28회 146, Verifier 16회 223) |
  | main context 최대 / p90 | 77,401 / 63,609 | 34,369 / 28,676 (−56%) |

  - Gate: (1) 22 < 23 불합격(과제 하나 차이, 노이즈 범위지만 기준은 기준이다), (2) 2회 이상 진 과제 없음 통과(p1 −1, d1 −1, d6 +1), (3) 성공당 비용 1.83배 불합격, (4) 탐지 6/6(d1 모호성 3/3, d6 edge 3/3) 통과, (5) 통과.
  - 파이프라인: 28개 assignment 모두 frame(요구사항 10–24개, 중앙값 21; 모호성 0–5, askUser 0). 위험 점수는 어려운 과제 9–13, 나머지 0–4이고 16/28을 검증했다. verdict pass 7, fail 9, fix 8회, recheck한 finding은 모두 fixed.
  - **원인 1 (Framer 해석의 권위)**: p1 r1에서 Framer는 cache fencing 모호성을 “설치만 막고 뒤 호출자는 기존 load에 합류”로 정했다. worker는 코드를 보고 “뒤 호출자는 낡은 flight에서 분리”로 바꾸어 보고했고, 이것이 hidden test의 해석이었다. main은 v2 감독 규칙(정한 해석과 worker 해석을 원문과 대조해 다르면 수정 요청)을 따라 Framer 해석을 강제하는 후속을 보냈고, 고친 코드는 hidden test에서 멈춰 timeout으로 실패했다.
  - **원인 2 (탐지 ≠ 결정)**: d1의 “increments attempts once per claim”은 3/3 탐지했지만 권장 해석이 hidden test와 맞은 것은 2/3이고, 틀린 r2는 알려진 방식 그대로 실패했다. 사용자에게 물을 수 없으면 드러난 모호성도 여전히 동전 던지기다(S0는 이번에 d1 3/3, G-L에서는 2/3 실패).
  - **원인 3 (Verifier의 극단 입력)**: blocking finding 10개 중 9개가 테스트도 사용자도 보내지 않을 입력이었다(SharedArrayBuffer 5, WebAssembly.Memory 2, prototype 상속 필드 1, clone 뒤 getter 재실행 1). 나머지 1개는 그럴듯한 견고성 문제(d8, 12,000 노드 cycle에서 stack overflow)다. 실패를 만든 것도, 실패를 잡은 것도 없었고 fix 8회 비용만 들었다. 요구사항 ~20개마다 `verifiedBy`를 요구하는 contract도 worker 일을 늘렸다.
  - **효과가 있었던 것**: main context가 절반 아래로 줄었다(R-줄과 재검증이 main에서 빠짐). d6은 같은 timestamp edge 요구사항이 명시된 S1에서 3/3이었다(S0 2/3, G-L 6세션 중 3세션 실패; n=3이라 시사만). frame → worker → 위험 점수 → Verifier → fix → 결정적 recheck는 28개 assignment 모두에서 오류 없이 돌았다.
  - 참고: S0 main context 최대 77,401은 G-L S0의 123,184보다 낮다. 감독 규칙 완화(`a20f255`) 뒤 longsession(75,773) 수준으로 돌아온 것이다(다른 날 실험 간 비교).
  - **사후 분석 (비용 0)**: v1 main의 도구 사용은 전부 결과를 받은 뒤였다(3세션 합계 read 121회 310K자, bash 57회 51K자, grep 6회; hand-off 전에는 0회). v2 main은 read 4회 25K자, bash 0회였다. R-줄은 hand-off에서 약 32K자를 더 썼다. 즉 main context 절감은 대부분 **main이 결과를 스스로 다시 확인하지 않은 것**에서 왔고, Framer·Verifier와는 따로 떼어 낼 수 있다. v1 main의 후속 요청 3건(d6, p1, d1)은 모두 해석을 원문 쪽으로 고친 것이었고 해는 없었다.
- **G-X 뒤 수정 (사용자 승인, 2026-10-05, v2 안에서만)**: (1) Verifier 기본 gate를 `review`로 바꿨다. 사용자의 말이 리뷰나 검증을 요청할 때만 돈다(`auto`는 그대로 있다). 위험 점수는 계속 계산해 결과에 남긴다. (2) Framer 해석은 참고용이다: contract는 “권장 해석은 조언이고 결정은 worker가 코드로 한다”고 쓰고, 그 해석을 따르는 요구사항에는 그 사실을 붙인다. v2 main 규칙은 Framer 권장과 다르다는 이유만으로 수정을 보내지 않고, 사용자의 말이 반대할 때만 고친다. 두 수정 모두 아직 측정하지 않았다.

### 10.6 G-M 사전 등록: main 재검증 제거 (2026-10-05, 실행 전에 작성)

- **질문**: v1에서 main이 결과를 스스로 다시 확인하는 것(바뀐 코드 읽기, check 재실행)만 빼면 품질과 비용을 유지하면서 main context를 크게 줄일 수 있는가. single의 존재 이유(context 보존)에 직접 닿는 가장 싼 변경이다.
- **Arm**: S0 = `single: { ledger: true }`(G-X의 S0와 같음), S0R = `single: { ledger: true, mainReview: "report" }`. 차이는 main 규칙 세 곳뿐이다: 첫 줄(acceptance는 worker가 보고한 check에 기대어 있다), reuse(“trusted project checks 실행” 삭제), supervision(보고서만 읽고 코드 재읽기·check 재실행을 하지 않음). R-줄 hand-off와 해석을 원문과 대조하는 규칙은 그대로다.
- **프로토콜**: G-L·G-X와 같다(8과제 고정 순서, arm당 3반복, 6세션 동시, openai-codex/gpt-6.1-sol high SSE, hidden test는 Pi에 되돌리지 않음). 실험 파일은 로컬 `results/compare/review-2026-10-05/`.
- **지표**: 최종 통과, 과제별 통과, main context 최대·p90, 추정 비용, wall, 결과 뒤 main의 read·bash 횟수와 크기, 후속 요청 수.
- **Gate G-M**:
  1. S0R 최종 통과 ≥ S0 − 1, 그리고 3회 중 2회 이상 진 과제 없음.
  2. main context 최대값(세션 평균) ≤ S0의 0.7배.
  3. 추정 비용 ≤ S0의 1.05배, 성공당 비용 ≤ 1.1배.
  4. parity·identity 100%, unknown usage 0(아니면 HOLD).
- **결정 규칙**: 모두 통과하면 `mainReview: "report"`를 single 기본값으로 바꾸자고 제안한다(사용자 결정). 1을 못 넘으면 `evidence`를 유지한다. 2나 3만 못 넘으면 `evidence`를 유지하고 원인을 기록한다.
- **한계(미리 적음)**: 과제당 n=3이라 큰 품질 손실(24개 중 2개 이상)만 걸러낼 수 있다. 기준 1은 비열등성 기준이다(1과제 여유). 이 과제들에서 worker가 check를 거짓 보고한 적이 없어, main 재검증이 막아 주는 실패(예: 빌드가 깨진 채 ‘통과’ 보고)는 여기서 거의 나타나지 않는다. 고정 순서라 위치와 난이도가 섞인다.
- **Smoke** (a6→a1, arm당 1세션): 둘 다 2/2 통과. S0R main은 결과 뒤 도구를 한 번도 쓰지 않았다(S0: bash 3, read 3). main context 최대 5,383(S0 8,428), 비용 $0.19(S0 $0.24). 2026-10-05 07:13 UTC 본 실행 시작.
- **결과 (2026-10-05 07:13–09:13 UTC, 6세션 완료, parity·identity 유효; 로컬 `results/compare/review-2026-10-05/README.md`)**: 품질·context 기준은 통과, 비용 기준은 근소하게 미달(+6.8%, 기준 ≤+5%)이고 두 arm 모두 unknown usage가 있어 비용은 HOLD다. **사전 규칙대로 기본값은 `evidence`로 두고, `report`는 opt-in으로 남긴다.**

  | | S0 (evidence) | S0R (report) |
  |---|---:|---:|
  | 최종 통과 | 23/24 (d1 2/3) | 24/24 |
  | main context 최대(세션 평균) | 72,183 | 29,402 (0.41배) |
  | 결과 뒤 main 도구 사용(3세션) | read 121회 355K자, bash 60회, grep 3회 | read 8회 41K자, ls 1회 |
  | 후속 요청 | 4 | 3 |
  | 추정 비용(3세션) | $12.67 | $13.53 (+6.8%) |
  | 성공당 비용 | $0.551 | $0.564 (1.02배) |
  | 요청 수 | 769 | 773 |
  | unknown usage 요청 | 9 | 4 |

  - Gate: (1) 통과(24 vs 23, 진 과제 없음), (2) 통과(0.41배, paired CI −76K~−24K), (3) **미달**(총비용 1.068배; 성공당 1.02배는 통과), (4) parity·identity 통과, unknown usage 때문에 비용 **HOLD**.
  - 비용 차이의 해석: 요청 수가 같고(773 vs 769) 과제별 비용 차이가 양쪽으로 갈린다(S0R이 p1·d1·c1·p2에서 싸고 b3·d6·c4·d8에서 비쌈). main 검토 방식보다 worker 쪽 과제 편차로 보인다. S0의 unknown usage가 더 많아 S0 비용이 더 과소 추정됐다. 사후 해석이라 기본값 결정에는 쓰지 않는다.
  - main 재검증의 이득: S0 main은 d6에서 코드를 다시 읽어 실제 결함 하나(HTTP limit 정규식 `$`가 끝 줄바꿈을 허용)를 찾아 후속 요청을 보냈다. S0R은 그런 후속 없이 d6 3/3을 통과했다.

### 10.7 G-M2 사전 등록: 확인 실행과 합산 판정 (2026-10-05, 실행 전에 작성)

- **목적**: G-M의 비용 판정(근소 미달 + unknown usage HOLD)을 정리해 `mainReview` 패키지 기본값을 정한다(사용자 승인). 결과를 본 뒤 기준을 바꾸지 않고, 같은 조건으로 표본을 늘린다.
- **설계**: G-M과 같은 arm(S0 `evidence`, S0R `report`), 같은 프로토콜·과제·모델, arm당 3세션을 동시에 더 돌린다. runtime은 커밋된 HEAD다(G-M runtime과 코드가 같고 문서만 다르다). 실험 파일은 로컬 `results/compare/review2-2026-10-05/`.
- **판정은 G-M과 G-M2를 합친 arm당 6세션**으로 한다(`pooled-check.py`, 실행 전에 작성):
  1. 품질: S0R 최종 통과 ≥ S0 − 2(48개 중), 그리고 어떤 과제도 S0R이 S0보다 6회 중 3회 이상 덜 통과하지 않음.
  2. context: main context 최대값(6세션 평균) ≤ S0의 0.7배.
  3. 비용: 총비용 ≤ S0의 1.05배, 성공당 비용 ≤ 1.1배. unknown usage 요청은 (a) 제외한 추정과 (b) 그 세션의 요청당 평균 비용으로 채운 추정, 두 가지로 판정한다. 둘의 결론이 같으면 그것이 결과이고, 다르면 HOLD다.
  4. parity·identity 100%.
- **결정 규칙**: 모두 통과하면 `report`를 패키지 기본값으로 바꾸자고 제안한다(사용자 결정). 하나라도 못 넘거나 HOLD면 `evidence`를 유지하고 `report`는 opt-in으로 둔다. G-M2 단독 결과는 서술적으로만 보고한다.
- **한계(미리 적음)**: 합산해도 과제당 n=6이다. G-M을 본 뒤에 확인 실행을 정했으므로(선택적 재시험), 합산 판정은 기준을 그대로 두고 양쪽 방향으로 나올 수 있다는 점을 명시한다. `report` 쪽이 왜 6.8% 더 들었는지는 설명하지 못한다.
- **결과 (2026-10-05 09:29–11:31 UTC, 6세션 완료, parity·identity 유효, 이번 실행의 unknown usage 0; 로컬 `results/compare/review2-2026-10-05/README.md`)**: **합산 판정 통과.** 결정 규칙대로 기본값 변경을 제안했고, 사용자가 승인한 계획(확인 실행이 G-M을 확인하면 기본값을 바꾼다)에 따라 `mainReview` 기본값을 `report`로 바꿨다.

  | | S0 (evidence) | S0R (report) | 판정 |
  |---|---:|---:|---|
  | 최종 통과(48) | 46 | 48 (d1 6/6 vs 4/6) | 통과 |
  | main context 최대(6세션 평균) | 77,060 | 31,504 (0.409배) | 통과 |
  | 총비용, 알려진 사용량 | $27.01 | $26.13 (0.967배, 성공당 0.927배) | 통과 |
  | 총비용, unknown usage 대입 | $27.15 | $26.20 (0.965배, 성공당 0.925배) | 통과 |
  | parity·identity | 12/12 | | 통과 |

  - G-M2 단독(서술): S0 23/24, S0R 24/24. main context 최대 81,937 vs 33,605, 비용 $14.34 vs $12.60, 요청 847 vs 736. G-M의 +6.8% 비용 차이는 이번에 반대 방향(−12%)으로 나와, 과제 편차였다는 해석과 맞는다.
  - d1은 S0에서 6회 중 2회 실패했고 S0R에서는 6/6이었다. 원인은 같은 해석 동전 던지기다. main 재검증이 d1을 막지 못한다는 점은 G-L·G-X와도 같다.

## 11. 로드맵

```text
Phase 0  E0: 실패 분류 고정, 위험 점수 보정(완료, threshold 7), 라우팅 정답셋, 하네스 arm
Phase 1  ledger v2 + Primary/front essentials + reload 복원           ──► G-L   (topology와 무관, 지금 single에 먼저 적용)
Phase 2  라우팅 오프라인 평가                                     ──► G-R 불합격 (Jev+규칙) → front가 작업 유형을 고름(확정)
Phase 3  Execution(code): framer, code_nav, Primary, 위험 점수, verifier, recheck ──► G-X
Phase 4  Investigation + 상태 기계 전환(승인 guard)                    ──► G-I, G-T
Phase 5  Creation: generator×N, critic/선택, refine (game-asset/video loadout)      ──► G-C
Phase 6  runtime·LSP adapter, 도그푸딩(사용자의 Python·Rust 저장소), gate 결과로 v2 기본값 결정
```

**진행 상황 (2026-10-05)**

- Phase 0: 라우팅 정답셋 100건 라벨을 확정했고(`labels.confirmed.jsonl`), Creation 보충 23건(임시 라벨)을 다른 PC 세션에서 추출했다(10.1).
- Phase 1: 구현했다. `"single": { "ledger": true }`로 켜는 opt-in이며 기본은 꺼짐이다. 구현은 `src/single/ledger.ts`(ledger, 렌더, 복원)와 `src/extension/workers.ts`, `src/extension/index.ts` 연결이고, 테스트는 `test/single/ledger.test.ts`, `test/extension/task-ledger.test.ts`, `test/extension/config.test.ts`다.
- G-L (`results/compare/ledger-2026-10-04/README.md`): longsession과 같은 8과제 연속 세션을 S0와 S0+L 각 3반복 실행했다(12:09–14:09 UTC, parity·identity 전부 유효). **정의한 기준은 통과했다**: 통과 21/24 → 22/24(알려진 d1·d6 실패의 위치만 바뀜, 노이즈), 회귀 0, 비용 −0.1%, wall +0.9%, main context 최대 123,184 → 122,327, worker compaction 3회 모두 ledger 포함·현재 R-id 전부 유지.
  - 검증되지 않은 경로: main compaction 0회(최대 123K/272K)라 main ledger 요약은 쓰이지 않았고, worker가 사라진 적이 없어 ledger 이어받기도 없었다. 과제가 독립적이라 후속 요청도 없었다.
  - 발견 1 (ledger 범위): main이 한 worker를 8개 과제에 모두 재사용해서, ledger 하나에 무관한 과제가 쌓였다(세션당 요구사항 46–53개, 해석 13–21개). c4 작업 중 compaction에서 p1·d1·p2의 해석이 "사용자가 바꾸지 않는 한 유지"로 들어갔다. task 경계를 명시하는 `task` 파라미터(7장)가 필요하다.
  - 발견 2 (저장 크기): 변경마다 ledger 전체를 entry로 남겨 main 세션 파일이 2.3–2.5배(8과제당 +0.7MB)가 됐고, 작업 수에 따라 제곱으로 늘어난다. 변경분만 남기고 복원 때 재생해야 한다.
  - 발견 3 (ledger와 무관): 649990c에서 main에게 "각 요구사항의 verifiedBy 검사가 수용 기준을 실제로 확인하는지 확인하라"는 감독 규칙을 넣은 뒤, main이 테스트 파일을 읽게 되었다. longsession(7c882ab)과 비교하면 세션당 main read 37 → 59회, read 결과 94K → 235K자, main context 최대 75,773 → 123,184(p90 57,564 → 100,536)이고 통과율은 나아지지 않았다(22/24 → 21/24). 다른 시점 실험 간 비교라 인과는 아니지만, single의 컨텍스트 보존 장점을 깎는다. 새 구조에서는 front가 검증을 하지 않고 Verifier가 위험 점수로 맡는다(5.3).
- Phase 1 구현에서 문서와 달라진 점: 이번 단계에서는 진행 중인 지시(R-id)를 ledger의 원본으로 쓰지 않는다. worker essentials에는 지금처럼 현재 hand-off 원문을 그대로 두고, 그 옆에 ledger 렌더를 덧붙인다. 요구사항 ID는 assignment마다 다시 시작하므로 ledger는 (assignment, id)로 구분한다.
- G-L 뒤 수정(2026-10-04): (1) `orche_task`에 `task`를 넣었다. 결과마다 `Task ledger T…, assignment n`을 알려 주고, `task`를 넘길 때만 같은 task를 잇는다(다른 worker·새 worker로도). 생략하면 worker를 재사용해도 새 task다. task가 다른 worker에게 넘어가면 새 worker는 이전 상태의 ledger briefing을 받는다. 사라진 worker id는 그 worker가 맡았던 `task`와 함께일 때만 받고, 아니면 오류 메시지가 마지막 task를 알려 준다. 2회 미충족 안내도 `task`를 유지하라고 말한다. (2) 세션에는 변경 이벤트(create·handoff·result·failure)만 남기고 복원 때 재생한다. 이벤트 하나는 해당 변경분 크기뿐이다(테스트: 70 assignment에서 최대 2KB 미만, snapshot 방식의 10% 미만). (3) main 감독 규칙 완화(결정 8).
- 커밋 (2026-10-05, 사용자 승인): `a20f255` 감독 규칙 완화, `0b1f7c2` task ledger, `5ef9baf` 이 문서와 라우팅 평가 코드, `dc6fc9e` 작업 유형 규칙과 모델 무관 라우팅 평가(10.1 후속 실행).
- Phase 3 (구현, 커밋 전): opt-in `"single": { "pipeline": "v2" }`. implement assignment마다 grounded Framer(`src/single/frame.ts`)가 contract를 쓰고, 결과의 위험 점수(`src/single/risk.ts`)가 threshold를 넘으면 Verifier(`src/single/check.ts`)가 probe로 확인한다. blocking finding은 같은 worker에게 fix assignment로 가고, orche가 probe와 check를 다시 돌린다. 일회용 세션은 `src/specialists/session.ts`(`runAdvisorSession` 일반화), 연결은 `src/single/pipeline.ts`와 `src/extension/workers.ts`다. `code_nav`(`src/tools/code-nav.ts`, TS LanguageService worker thread + 다른 언어는 regex, diagnostics와 프로젝트 계획 공유 `src/tools/ts-project.mjs`)는 v2의 worker·Framer·Verifier에만 등록된다. v2 front 규칙은 R-줄을 쓰지 않고 검증도 다시 하지 않는다(`delegationRules(mode, { pipeline })`). 구현 중 내린 판단: edge case를 R-id(`kind: "edge"`)로 합침, needs_decision과 `mode`·`decisions` 파라미터는 보류, Jev `risk` 신호 제거, threshold 7(보정). 테스트는 `test/single/{frame,risk,check}.test.ts`, `test/specialists/session.test.ts`, `test/tools/code-nav.test.ts`, `test/extension/pipeline-v2.test.ts`(faux 모델로 frame→worker→Verifier→fix→recheck 전 경로).
- G-X 1단계 (10.5): 2026-10-05 02:02–05:05 UTC 실행, **불합격**(통과 22/24 vs 23/24, 성공당 비용 1.83배). main context −56%, d1·d6 탐지 6/6. 원인은 Framer 해석을 main이 worker보다 우선한 것, 탐지한 모호성의 해석이 여전히 동전 던지기인 것, Verifier의 극단 입력 finding이다(10.5). 비용(카탈로그 가격): 본 실행 $37.90 + smoke $0.93.
- G-X 뒤 (사용자 승인): Verifier 기본 gate `review`, Framer 해석 참고용(v2 안, 미측정). G-M (10.6): v1에서 main 재검증을 뺀 `mainReview: "report"`는 품질(24/24 vs 23/24)과 context(0.41배)는 통과, 총비용 +6.8%로 비용 기준(+5%)을 근소하게 놓쳤고 unknown usage로 HOLD → 기본값 유지, opt-in. 비용(카탈로그 가격): 본 실행 $26.20 + smoke $0.43.
- G-M2 (10.7, 2026-10-05 09:29–11:31 UTC): 합산 판정 통과(48/48 vs 46/48, context 0.41배, 비용 0.97배) → `single.mainReview` 기본값을 `report`로 변경. 비용(카탈로그 가격): $26.94.
- Workflow Policy (2026-10-05, `docs/workflow-policy.md`): Work Type → Policy → Capability → Primary를 범용 topology 엔진 없이 구현했다. execution은 v1/v2 그대로(정책에서 유도, 오프라인 회귀 G-E0 통과), investigation critic과 creation divergence는 opt-in(기본 꺼짐). G-E1(스키마 회귀 smoke)은 통과했고, G-I2·G-C2는 과제 세트를 만들어 검토 대기 중이다(`docs/workflow-policy.md` 4장).

### 11.1 다음에 할 것 (2026-10-05 기준, 우선순위 순)

**지금 상태**: single 기본 동작은 v1 + 보고서만 보는 main 검토(`mainReview: "report"`, G-M2 통과) + front가 고르는 작업 유형 규칙이다. task ledger(`single.ledger`)와 파이프라인 v2(`single.pipeline: "v2"`: 참고용 Framer, 리뷰 요청 때만 도는 Verifier, code_nav)는 opt-in이다. direct는 바뀌지 않았다. 현재 8과제 벤치마크는 새 기본값에서 48/48이라 더 이상 차이를 가르지 못한다(천장).

1. **새 기본값 운영 확인 (도그푸딩, 비용 거의 0)**
   - 왜: `report`는 hidden test가 있는 작은 과제에서만 검증했다. 실제 작업에서는 worker가 “통과”라고 보고했지만 빌드가 깨져 있거나, 환경에 따라 check 결과가 다른 경우를 main이 더는 잡지 못한다.
   - 무엇을: 1–2주 실제 세션에서 쓴다. 사용자가 놓친 결함을 발견하면 records(`run.json`의 checklist와 `verifiedBy`)와 함께 기록해 둔다.
   - 판정: 놓친 결함이 반복되면 가장 싼 보완을 사전 등록해 시험한다. 예: worker가 이름을 대 check 명령만 main이 한 번 실행(코드는 읽지 않음).
2. **벤치마크 과제 보강 (다음 측정의 선행 조건)**
   - 왜: 남은 질문(v2 Framer·code_nav가 새 기본값 위에 무엇을 더하는가)은 지금 과제로는 답할 수 없다. d1·d6도 새 기본값에서 6/6이었다.
   - 무엇을: (a) 해석·edge case가 갈리는 새 과제 6–10개(hidden test와 참조 구현 포함). v2를 본 사람이 맞추지 않도록 별도 세션이나 미리 정한 명세에서 만든다. (b) 실제 커밋 이력에서 만든 저장소 규모 과제 4–6개(orche, 사용자의 Python·Rust 저장소). code_nav를 재려면 이것이 필요하다.
   - 판정: `scripts/validate-suite.ts`로 starter는 실패, reference는 통과하는지 확인한 뒤에만 쓴다.
3. **v2 재측정 (G-X2, 2번 뒤)**
   - 왜: G-X 뒤 수정(참고용 Framer, 리뷰 요청 때만 도는 Verifier)은 아직 측정하지 않았다. 이제 비교 대상은 새 기본값(v1 + report)이다.
   - 무엇을: 보강한 과제로 S0' = 새 기본값, S1' = v2를 비교한다. 실행 전에 사전 등록한다(10.4의 G-X 기준). 비용 약 $40.
   - 판정: 못 넘으면 v2에서 가치가 드러나지 않은 부분을 덜어낸다. 우선 후보는 Verifier의 `auto` 임계값 모드다. 남길 후보는 모호성·edge case 탐지용 Framer(탐지 6/6)다.
4. **needs_decision (대화형 세션)**
   - 왜: 모호성은 잘 찾지만(탐지 6/6) 해석을 대신 고르면 동전 던지기다(d1). 이를 해결하는 것은 사용자에게 물어보는 것뿐인데, 사람 없는 벤치마크로는 잴 수 없다.
   - 무엇을: UI가 있고 Framer가 `askUser` 모호성을 내면, worker를 돌리기 전에 질문을 돌려준다. `orche_task`에 `decisions`를 추가하고 ledger에는 `by: "user"`로 남긴다. UI가 없으면 지금처럼 권장 해석으로 진행한다.
   - 판정: 제품 판단과 도그푸딩으로 정한다. v2를 쓸 때만 의미가 있어 3번 결과에 따라 진행한다.
5. **평가 인프라 정리**
   - unknown usage(HTTP 200인데 usage 이벤트가 없는 요청)가 G-M에서만 13건 나왔다(G-X·G-M2는 0건). provider trace 수집에서 원인을 찾는다.
   - 실험마다 복사해 쓴 long-session 하네스(`driver.ts`, `analyze.ts`, `pooled-check.py`, watcher)를 하나의 도구로 묶는다. arm·설정·판정 기준을 인자로 받게 해서, 다음 실험의 준비 비용과 실수를 줄인다.
6. **Phase 4 Investigation (G-I, G-T)**
   - 무엇을: answer 작업에 근거 ID 인용과 gated critique를 넣는다. 승인 guard가 있는 investigation → execution 전환도 넣는다.
   - 선행: rubric이 있는 조사 과제 세트(a5, b4, c3와 새 과제), 혼합 요청(“분석하고 괜찮으면 구현”) 세트.
7. **Phase 5 Creation (G-C)**: generator×N, critic 또는 사용자 선택, refine. 선행은 창작 과제와 쌍대 선호 평가 방법이다. 우선순위는 낮다.
8. **Phase 6**: code_nav의 LSP adapter(pyright-langserver, rust-analyzer)를 만들고 실제 저장소에서 도그푸딩한다. 2(b)의 저장소 규모 과제가 있어야 가치를 재다.

바꾸지 않는 것: direct 모드, 사전 등록한 gate로만 기본값을 바꾸는 원칙, 13장의 “하지 않을 것”.

## 12. 파일 계획 (요약)

| 구분 | 위치 | 내용 |
|---|---|---|
| 신규 | `src/single/ledger.ts` | ledger v2, 역할별 렌더, 저장과 복원 |
| 실험 | `experiments/routing/{router,evaluate}.ts` | (G-R 뒤 제품에서 분리) Jev descriptor와 규칙, 모델 무관 라우팅 평가 |
| 실험 | `experiments/risk/calibrate.ts` | 저장된 v1 결과로 위험 점수 threshold 보정 |
| 신규 | `src/single/work-types.ts` | front의 작업 유형 정의(규칙과 평가 프롬프트가 같은 문구) |
| 신규 | `src/single/runner.ts` | topology 템플릿, 상태 기계, 승인 guard, escalation, needs_decision |
| 신규 | `src/single/{frame,check,risk,pipeline}.ts` (구현), `{critic,generator}` (Phase 4–5) | primitive 계약과 prompt |
| 신규 | `src/specialists/session.ts` | 일회용 세션 공통부(`runAdvisorSession` 패턴 일반화) |
| 신규 | `src/tools/code-nav{.ts,-worker.mjs}`, `src/tools/ts-project.mjs` (구현), `src/single/retrieve/*` (Phase 4–6) | code_nav, runtime/docs/reference adapter |
| 수정 | `src/extension/workers.ts` | Primary 실행기로 축소(spawn, 재사용, compaction, projection, audit, git 유지), essentials를 ledger 렌더로 |
| 수정 | `src/extension/{index,mode,config,records}.ts` | `orche_task`의 `task`(구현), front 규칙(작업 유형, v2 hand-off), `single` 설정, ledger entry |
| 수정 | `src/eval/*` | arm, 라우팅 평가 스크립트, longsession 연결, specialist actor 귀속 |
| 변경 없음 | direct 경로 전부, `session-factory.ts`의 compaction 메커니즘, `context-projection.ts` | |

## 13. 하지 않을 것

- direct 변경.
- 라우터나 runtime이 문제를 쪼개고, 배분하고, 중간 결과로 재배분하는 중앙 orchestrator가 되는 것.
- 모든 작업에 하나의 고정 DAG를 쓰는 것.
- Execution과 Investigation에서 같은 문제를 푸는 병렬 worker. 병렬은 Creation의 generator(N 상한)만 허용한다.
- BOAD의 UCB 기반 specialist 자동 생성. 대신 ablation과 usefulness 기록으로 정책 표를 고친다.
- 승인 없는 상태 변경.

## 14. 리스크와 열린 질문

1. **작업 유형 오분류**: front가 고른다(G-R: 고급 모델 94–97%, 승인 없는 변경 ≤1.6%). 저가 main 모델은 기준을 못 넘었다(luna low 2.4%). 승인 guard(Phase 4)가 남은 위험을 막는다.
2. **이전 결정과의 충돌**: om-orche는 9/29에 Jev 라우팅을 main 스스로 고르기로 바꿨다. 10.1에서 정면 비교했고, 같은 결론(main이 고름)에 우리 정의를 더했다.
3. **비용**: specialist가 늘어난다. 모든 추가 단계를 gate로 두고, 정책 표는 ablation 결과로만 넓힌다.
4. **Creation 평가의 주관성**: rubric과 쌍대 선호를 함께 쓴다. 표본이 작다는 점은 결과에 명시한다.
5. **retrieve 범위**: web과 운영 환경 조회는 도구와 권한에 달려 있다. 처음에는 code, 로컬 문서, 읽기 전용 상태 명령까지만 하고, 나머지는 있을 때만 쓴다.
6. **재진술 손실**: 원문 요청은 모든 단계에 그대로 전달하고, hand-off는 ledger에서 결정적으로 렌더한다.
7. **깨지는 변경**: 지금은 없다(v2는 opt-in, `role` 유지). v2를 기본값으로 바꿀 때 front 규칙이 바뀌므로 single 테스트와 CHANGELOG를 함께 갱신한다.
8. **Verifier의 실행 범위**: probe는 프로젝트 코드를 실행한다. bash 정책은 습관적 편집을 막는 장치이지 sandbox가 아니므로, Verifier가 남긴 workspace 변경은 결과의 “other changes”로 드러나게만 한다.
