# single 재설계: main → orchestrator → (필요할 때만) sub-worker

> 상태 (2026-10-06): 브랜치 `orchestrator-redesign`에서 구현했고 master에 합쳤다. 분할 판단 평가는 세 번 사전 등록해 실행했다. v1은 5장, v2는 8장, 실세션 요청은 10장이다. 실제 과제 스모크는 6장과 9장에 있다.

## 1. 왜 다시 잡는가

모델이 좋아질수록 오케스트레이션의 효과는 줄고, 구조 하나를 검증하는 데 드는 시간과 비용은 그대로다. 지금까지의 측정도 같은 방향이었다.

- multi(coordinator + 여러 worker)는 품질 이득 없이 비쌌다: bench3 pi-solo 84/84 vs pi-orche 72/84에 비용 6배, hard6·parallel3·multi-vs-single에서도 같았다. auto/multi 모드는 `68f3624`에서 제거했다.
- 병렬 과제에 맞춘 DAG 병렬화도 Gate A에서 NO-GO였다(parallel3: multi 9/9, single보다 9.5% 빠르고 비용 1.92배, direct의 2.88배; `docs/dag-orchestration.md` §8.3).
- v2(Framer + 위험 점수 Verifier)는 G-X에서 불합격했다(22/24 vs 23/24, 성공당 비용 1.83배).
- 효과가 확인된 것은 작고 싼 장치였다: main이 보고서만 보고 검토하기(G-M2: 48/48 vs 46/48, main context 0.41배, 비용 0.97배).

그래서 새 구조는 예전 single을 조금만 넓힌다.

## 2. 구조

```text
User ⇄ main (single 모드: 대화·요구사항 정리·보고서 검토, 편집 불가)
          │ orche_task {role, request(Intent, R1..Rn, 제약, 가정, 원문)}
          ▼
       orchestrator (예전 single worker 자리, persistent, main 모델 상속 또는 models.orchestrator, 50% compaction)
          │ 분할 판단: Parallelism / Isolation / Independent verification. 기본은 분할하지 않고 직접 작업
          │ orche_spawn {reason, workers[]}  ← 필요할 때만
          ▼
       sub-worker (새 세션, 깊이 1: 다시 spawn할 수 없음)
          - parallel: 서로 겹치지 않는 소유 파일, 동시에 실행
          - isolation: game-asset/video specialist(원래 route와 이미지 도구)
          - verification: 구현 context 없이 새로 띄운 읽기 전용 verifier
          (표준 역할 sub-worker의 모델: models.worker, 없으면 orchestrator 모델 상속. §12)
```

- **main**: 사용자의 요구사항을 구체화하고 명확하게 정리해 orchestrator 하나에게 넘긴다(인계 형식은 지금 single 그대로). 단순 응답은 직접 답한다. 결과는 보고서로 검토한다(코드 재확인·check 재실행 없음).
- **orchestrator**: 세 기준으로 분할 여부를 판단한다. 나눌 필요가 없으면 직접 작업하고(기본값), 필요하면 `orche_spawn`으로 sub-worker를 띄운 뒤 결과를 통합하고 확인한다. 판단과 근거를 보고서의 `data.split`에 짧게 남긴다.
- **sub-worker**: 한 번 쓰고 버리는 세션. 자기 요청만 보고, 자기 소유 파일만 쓸 수 있고, spawn 도구가 없다. 시간 제한은 orchestrator assignment와 같은 활동 기반 기한이다(같은 `limits`: 기본 30분 + 10, 20, … 100분, 명시적 고정 `extensionMs` 호환, `observeMs` 관측). 기한은 자기 시작 시각부터 세고 자기 세션 활동으로만 연장된다. 자기 타임아웃은 그 sub-worker만 `failed`로 만들고(사유 idle/budget/stalled), orchestrator assignment가 끝나면 남은 연장과 관계없이 즉시 `cancelled`된다(README "`orche_spawn` sub-workers get the same deadline").

## 3. 구현 요점

| 항목 | 위치 | 동작 |
|---|---|---|
| main 규칙 | `src/extension/mode.ts` `delegationRules` | single 인계 형식 + 보고서 기반 검토(`mainReview` 분기 제거, G-M2의 `report`만 남김) + "분할은 orchestrator가 판단한다" |
| orchestrator 지시 | `src/orchestrator/instructions.ts` | 5장에서 고른 분할 판단 지시문, spawn 사용법, `data.split` 보고 |
| spawn 도구 | `src/orchestrator/spawn.ts`, `src/orchestrator/sub-worker.ts` | 병렬 실행(호출당 최대 4), 깊이 1, 소유 파일 검증·쓰기 guard·사후 audit, verifier는 새 세션·읽기 전용, specialist route, 모델 상속 |
| 연결 | `src/extension/workers.ts` | orchestrator 세션에만 `orche_spawn` 등록, sub-worker 기록을 run record와 결과에 남김 |
| 설정 | `src/extension/config.ts` | `single.ledger`(유지), `single.spawn`(새, 기본 true; false면 예전 single). 예전 키(`pipeline`, `frame`, `checker`, `nav`, `mainReview`, `investigation`, `creation`)는 무시하고 경고 |

파일 충돌을 막는 장치는 네 겹이다. (1) 한 spawn 호출 안의 쓰기 worker는 소유 파일을 반드시 적고, 서로 겹치면 호출 자체를 거부한다(`validateBacklog`의 `file_overlap` 재사용). (2) sub-worker의 edit/write/ast_rewrite는 `checkWriteRealPath`로 자기 소유 파일 안에서만 허용되고 형제 worker의 파일은 막힌다(symlink 포함). (3) spawn 도구는 `executionMode: "sequential"`이라 다른 도구 호출과 겹쳐 실행되지 않고, orchestrator는 sub-worker가 도는 동안 기다린다. (4) bash처럼 guard가 못 막는 쓰기는 spawn 전후 workspace snapshot(`WorkspaceAudit`/`WorkspaceActivity.checkpoint`)으로 비교해 소유 범위 밖 변경을 결과에 경고로 남긴다.

## 4. 기존 실험 반영 매핑

지금까지의 실험·장치를 새 구조에서 어떻게 다루는지 정리한다. **유지**는 그대로 쓰고, **변형**은 생각은 살리되 자리나 형태를 바꾸고, **제거**는 제품 코드에서 뺀다(실험 문서·하네스·측정 기록은 남긴다).

| 항목 | 결정 | 새 구조에서의 형태 | 근거 |
|---|---|---|---|
| G-M2: report 기반 main 검토 | **유지** (선택지 제거) | main은 보고서(checklist, worker가 든 check, 고른 해석)만 보고 검토하고 코드 재확인·check 재실행을 하지 않는다. `single.mainReview` 스위치와 `evidence` 분기는 지웠다(`src/extension/mode.ts` `SUPERVISION_BASE`). orchestrator 결과에는 `Split:` 줄과 sub-worker 상태가 붙으므로 main은 그것도 보고서로 읽는다(`ORCHESTRATOR_SUPERVISION`). | G-M+G-M2 합산 48/48 vs 46/48, main context 0.41배, 비용 0.97배(사전 등록 판정 통과, `docs/specialist-orchestration.md` 10.7). 측정으로 이긴 유일한 감독 변경이라 그대로 둔다. |
| 요구사항 R1..Rn + 원문 그대로 인계 | **유지** | main→orchestrator 인계 형식은 그대로다(Intent/Purpose, `R1: …`, 제약, 가정, Original request 원문). checklist의 `verifiedBy`, `data.ambiguities`, 2회 연속 미충족 시 새 worker도 그대로다. orchestrator→sub-worker는 이 형식을 강요하지 않고 "자기 완결적 요청(목표, 수락 기준, 제약, 파일 참조, 필요하면 사용자 원문)"만 요구한다(`SPAWN_USAGE`). | 기존 single의 기본 계약이고 G-L·G-M2 모두 이 위에서 측정됐다. sub-worker는 한 번 쓰고 버리는 세션이라 checklist·task_plan 부담을 지우지 않는다(검토는 orchestrator 몫). |
| 모델 상속, 50% compaction | **유지 + 확장** | orchestrator는 main의 현재 모델·thinking을 상속하고 50%에서 compaction한다(기존). 표준 역할 sub-worker는 orchestrator의 현재 모델·thinking(과 main의 context window)을 상속한다(`"thinkingPolicy": "phase"`에서는 orchestrator 할당의 기준 수준 B에서 지원 수준 한 단계 아래, verify는 B; docs/thinking-policy.md). sub-worker는 짧은 one-shot이라 50% compaction·task_plan이 없다. specialist는 원래 route를 쓴다. | 사용자가 고른 모델로 일한다는 원칙을 한 단계 더 적용한 것. 모델을 섞는 실험(v2의 별도 route, multi의 역할별 route)은 이득을 보이지 못했다. |
| 참조 기반 위임 | **유지 + 확장** | main 규칙의 `REFERENCE_RULE`은 그대로. orchestrator에게도 "요청은 자기 완결적으로, 자기 추론은 붙이지 말 것, 파일 참조"를 주고, sub-worker 결과는 요약·핵심 data·변경 파일만 orchestrator에 돌아간다(`formatSpawn`, 요약 4,000자 제한). | `0eb4faa`(delegate by reference). 별도 A/B 측정은 없다. 복사본을 붙이면 cold start인 sub-worker의 context만 커지므로 같은 원칙을 적용한다. |
| task ledger, task_plan DAG | **유지** (ledger는 opt-in 그대로) | ledger(`single.ledger`)와 orchestrator의 순차 task_plan DAG는 그대로다. orchestrator의 DAG는 자기 작업 순서일 뿐 sub-worker 스케줄러가 아니다. 병렬은 `orche_spawn` 한 호출(최대 4개 동시, 모두 끝나면 반환)뿐이다. sub-worker 기록은 run record의 agent·`spawn` 이벤트로 남는다. | G-L 기준 통과(회귀 0, 비용 −0.1%)했지만 품질 이득은 없어 opt-in 유지. 범용 DAG 엔진은 아래 Gate A 때문에 만들지 않는다. |
| dag-orchestration Gate A NO-GO (parallel3) | **변형** (결론을 판단 기준에 반영) | DAG 스케줄러는 만들지 않는다. 대신 Gate A의 수치를 분할 판단 지시문에 비용 근거로 넣었다("multi-worker split은 worker 하나의 약 2배 비용에 약 10% 짧은 시간"). Parallelism 조건(서로의 결과 불필요, 파일 분리, 부분마다 약 10분 이상, 공통 context가 작음)과 기본값 "분할 안 함"도 여기서 나왔다. | parallel3: multi 9/9, single보다 9.5% 빠르고 비용 1.92배, direct의 2.88배(`docs/dag-orchestration.md` 8.3). 병렬은 진짜로 겹쳤지만(Σbusy/wall 1.68) 이득이 비용을 정당화하지 못했다. |
| auto/multi 모드 제거 | **유지** (제거 그대로) | 모드는 `direct`/`single` 그대로(기본 `direct`, 바꿀 근거 없음). multi의 coordinator(별도 LLM 계획자)는 되살리지 않는다. 분할 판단은 이미 과제 context를 가진 orchestrator가 하고, spawn은 깊이 1·호출당 4개로 묶인다. | bench3 pi-solo 84/84 vs pi-orche 72/84에 비용 6배, hard6·parallel3·multi-vs-single도 같은 방향(`68f3624`). coordinator 비용과 결합된 과제 분할이 실패 원인이었으므로 "필요할 때만, 같은 worker가"로 좁혔다. |
| v2 risk-gated Verifier, G-X | **제거** (독립 검증은 변형해 남김) | Framer, 위험 점수 gate, Verifier, fix round, probe 재실행, `code_nav` 등록을 제품에서 지웠다(위험 점수는 `experiments/risk/`로). 독립 검증은 orchestrator가 사용자가 명시적으로 요청했거나 되돌릴 수 없고 테스트로 확인할 수 없는 위험일 때만 `reason: "verification"`으로 띄운다. verifier는 구현 context 없이 새로 뜨고 읽기 전용이다. | G-X 불합격: 22/24 vs 23/24, 성공당 비용 1.83배. threshold로 켜진 Verifier의 지적은 이국적 입력뿐이었고 실패를 하나도 잡지 못해 gate가 `review`(요청 시만)로 바뀌었다(`docs/specialist-orchestration.md` 10.5). 남은 쓸모가 "요청 시 독립 검토"뿐이라 그것만 spawn 사유로 남겼다. |
| Workflow Policy critic/divergence | **제거** | investigation critic, creation divergence, `orche_task`의 `type`/`candidates`/`then`, `details.workflow`를 지웠다. main의 work type 분류(respond/investigation/execution/creation)는 라우팅용으로 그대로 둔다. 사용자가 후보 여러 개를 명시적으로 원하면 orchestrator가 직접 하거나 parallelism으로 나눌 수 있다. `experiments/workflow/`와 fixtures(investigation/creation)는 남긴다. | 기본 꺼짐이었고 G-E1(회귀 스모크)만 통과, 효과를 재는 G-I2·G-C2는 실행하지 않았다(`docs/workflow-policy.md`). 검증되지 않은 계층을 유지하는 비용이 이번 재설계의 이유 그 자체다. |
| specialist(game-asset/video) 라우팅 | **유지 + 확장** | main이 creation을 game-asset/video 역할로 바로 보내는 경로는 그대로다. 더해서 orchestrator가 큰 과제의 일부(예: 기능 구현 중 필요한 sprite)를 `reason: "isolation"`으로 specialist sub-worker에 맡길 수 있다. 이때 specialist는 자기 route(`resolveSpecialistRoute`)와 `generate_image`를 쓰고 소유 파일 안에서만 쓴다. | 다른 도구·모델이 필요한 일은 context가 아니라 환경이 다르다는 점에서 Isolation의 대표 사례다. 라우팅 평가(10.1)에서 specialist 경로는 유지 판정. |
| 라우팅 평가 하네스 | **유지 + 재사용** | `experiments/routing/`은 그대로다(`WORK_TYPE_RULE`이 바뀌지 않았으므로 하네스가 평가하는 문구 = main이 읽는 문구). 같은 방식(라벨 세트, 1턴, 사전 등록 선택 규칙, 다른 모델은 서술용)으로 분할 판단 평가 `experiments/judgment/`를 만들었다. | 라우팅 평가: 123개 라벨에서 front LLM 정의가 Jev 분류기+규칙보다 나았다(G-R 불합격 → front가 유형 결정). 싼 1턴 평가로 지시문을 고르는 방법이 이미 검증된 도구라서 R5에 썼다. |
| R5 분할 판단 평가 결과 | **반영** | `checklist` 변형을 제품 지시문 `SPLIT_JUDGMENT`로 넣었다(같은 문자열, 테스트로 고정). 판단과 근거는 `data.split`으로 보고하고, spawn한 뒤에는 그 사유를 반드시 포함해야 보고가 통과한다. | 5.3: opus 98.9%, false split 0%, 일관성 97.8%. 세 질문만 주면 false split 24%(opus)·56%(sol). 지시문 차이가 모델 차이보다 컸다. 다만 e2e에서는 p1을 나누지 않아 1턴 평가와 달랐다. 원인은 지시문이 아니라 평가 조건과 라벨이었다(7장). 라벨을 실측 작업량으로 고치고 저장소를 읽은 뒤 판단하게 한 v2(8장)에서도 checklist가 선택됐다. e2e p4에서 나눴을 때 11% 빨라지고 비용은 1.6배였으므로 checklist를 유지했다(9장). |

## 5. 분할 판단 지시문 검증 (R5)

### 5.1 질문

orchestrator에게 어떤 지시문을 줘야 분할 여부(나누지 않음 / Parallelism과 분할 단위 / Isolation / Independent verification)를 잘 판단하는가. 특히 불필요한 분할(false split)은 비용이 크므로 낮아야 한다.

### 5.2 사전 등록 (2026-10-05 23:09 KST, 모델 호출 전에 작성)

- **평가 세트**: `experiments/judgment/tasks.json` 45개(sha256 `6f5e912c…a6d4cf`). 기존 fixture 21개(suite p1–p3, d1–d8, a3, a6, b5, c5; investigation i01, i13, i20; creation c01, c05, c09)와 새 과제 24개(n01–n24). 주 라벨: 나누지 않음 27, Parallelism 10(그중 p2·n15는 "나누지 않음"도 정답으로 인정), Isolation 4, Independent verification 5(n17은 Parallelism과 중복). 함정 과제(여러 파일·모듈에 걸쳐 보이지만 결합된 과제, 작은 독립 편집, 같은 파일을 고치는 "티켓", 순서 의존, 진단이 먼저인 과제): d3, d5, d6, b5, i13, n02, n03, n14, n21, n22, n23. 각 항목의 라벨 근거는 `rationale`에 있다.
- **라벨 기준**: Parallelism = 서로의 결과가 필요 없고, 쓰는 파일이 겹치지 않고, 각 부분이 혼자서도 상당한 작업(대략 10분 이상)이며, worker가 새로 읽어야 할 공통 context가 작다. Isolation = 다른 환경이나 도구가 필요하다(game-asset/video specialist, 섞이면 안 되는 별도 checkout). Independent verification = 사용자가 독립 검토를 명시하거나, 되돌릴 수 없고 비싼 결과인데 프로젝트 테스트로 정확성을 확인할 수 없다. 이 세트의 verification 항목은 모두 명시 요청이다. 판단이 갈릴 수 있는 항목은 `alsoAccept`로 미리 적었다(p2, n15: 나누지 않음도 정답; n10, n19: Parallelism+Isolation도 정답).
- **지시문 변형 4개** (`experiments/judgment/variants.ts`, sha256 `1e160f3b…1c51667`): `minimal`(세 질문 + 기본값은 분할 안 함), `checklist`(세 기준별 조건, 비용 근거, 하지 말아야 할 경우), `fewshot`(세 질문 + 비용 한 문장 + 예시 7개), `checklist-fewshot`(checklist + 같은 예시). 역할 설명과 답 형식은 모든 변형이 같다. 예시는 평가 항목을 그대로 베끼지 않았지만 같은 범주(명시적 독립 검토 요청 등)를 다루므로 단서가 겹친다(한계).
- **실행 조건**: 판단 단계만 1턴. 도구 없이 hand-off(Intent, Requirements, 원문)와 저장소 파일 목록(줄 수)만 보고 JSON으로 답한다(`experiments/judgment/run.ts`). 주 모델은 현재 main 모델 `cliproxyapi/claude-opus-5-5`(thinking high), 변형마다 2회 반복. 다른 모델 `cliproxyapi/gpt-6.1-sol`(thinking high) 1회는 서술용이다. 전송 오류만 1회 재시도하고, 파싱 실패는 오답으로 센다.
- **지표** (`experiments/judgment/eval.ts`): 판단 정확도(예측한 기준 집합이 주 라벨이나 `alsoAccept` 중 하나와 같음), false split(주 라벨이 "나누지 않음"인 항목에서 무엇이든 분할한 비율), 불필요한 병렬, 놓친 병렬(모든 정답이 Parallelism을 포함하는 8개 항목에서 Parallelism을 고르지 않은 비율), 분할 단위 일치도(compatible: 기대 단위가 한 예측 단위 안에만 있고 예측 단위마다 기대 단위가 있음 / exact: 일대일), Isolation·verification의 놓침과 과잉, 반복 간 일관성(두 반복의 예측 집합이 같은 항목 비율), 비용.
- **기준선**: 언제나 "나누지 않음"이라고 답하면 정확도 64.4%(29/45), false split 0%, 놓친 병렬 100%다.
- **선택 규칙** (`select()`): 주 모델 두 반복을 합친 지표로 정한다. (1) 자격: false split ≤ 10% 그리고 놓친 병렬 ≤ 1/3. (2) 자격이 있는 변형 중 정확도가 가장 높은 것. (3) 정확도 차이가 한 항목(1/45) 이내면 동률이고, false split이 낮은 쪽 → 놓친 병렬이 낮은 쪽 → 단위 compatible이 높은 쪽 → 일관성이 높은 쪽 → 짧은 쪽 순으로 정한다. (4) 자격이 있는 변형이 없으면 false split + 놓친 병렬이 가장 작은 변형. 고른 변형을 그대로 제품 지시문에 넣는다(`src/orchestrator/instructions.ts`, 동일성은 테스트로 확인). 다른 모델 결과로 선택을 바꾸지 않는다.
- **한계(미리 적음)**: 라벨은 이 작업자가 붙였고 사용자 검토가 없다. 1턴 판단은 실제 orchestrator와 달리 파일을 읽지 않는다(실제로는 더 많은 정보로 판단한다). 과제 수가 작아 변형 간 1–2항목 차이는 잡음일 수 있다. 판단의 정확도가 실제 비용·품질 이득으로 이어지는지는 이 평가가 재지 않는다(6장 스모크가 일부만 본다).

### 5.3 실행 결과 (2026-10-05 23:10–23:14 KST, gpt-6.1-sol 2회차 2026-10-06 19:13–19:16 KST)

**사전 등록 확인 (2026-10-06)**: 구현 worker의 transcript(`~/.pi/agent/orche/records/01a10c1a-…/workers/W3-2026-10-05T13-50-03-059Z.jsonl`)에서 도구 호출 순서를 확인했다. `tasks.json`(14:06:43Z), `variants.ts`(14:07:06Z), `eval.ts`·`run.ts`(14:08:16Z, `select()` 포함), `score.ts`(14:08:35Z), 이 문서의 5.2(14:09:42Z 작성)가 첫 모델 호출(pilot 14:09:50Z, 본 실행 14:10:05Z)보다 앞선다. 14:09:42Z에 쓴 5.2는 지금의 5.2와 글자까지 같고(사본 `experiments/judgment/preregistration-2026-10-05T14-09-42Z.md`), 세 파일의 현재 sha256은 모든 run의 `meta.json` 값과 같다(`experiments/judgment/preregistration-evidence.md`). 즉 라벨·지표·선택 규칙은 실행 전에 고정됐고 이후 바뀌지 않았다. 파일 mtime도 같은 순서다(단, mtime은 조작 가능하므로 근거는 transcript와 해시다).

원시 결과는 `experiments/judgment/runs/2026-10-05T14-10-07-384Z-opus-main/raw.jsonl`(360회), `…-387Z-sol-second/raw.jsonl`(180회), `2026-10-06T10-13-52-443Z-sol-rep2/raw.jsonl`(180회, `--reps 1 --rep-start 2`), 표와 오답 목록은 `experiments/judgment/report.md`(`report.json`, 세 run 합산)다. 1차 보고(sol 1회)는 `report-round1.md`로 남겼다. 실행 전 pilot 2회(`…14-09-51-918Z-pilot-opus`, p1·d3, checklist)는 비용과 형식 확인용이고 집계에 넣지 않았다. 모든 run의 `meta.json`에 실행 당시 `tasks.json`·`variants.ts`·`eval.ts`의 sha256이 있고 5.2의 값과 같다. gpt-6.1-sol도 2회로 맞춘 2회차(비용 $0.70)는 선택 규칙에 영향을 주지 않는다(서술용 모델). `run.ts`에는 이때 `--rep-start`만 추가했다(해시 대상 세 파일은 그대로).

| 모델 | 변형 | 호출 | 정확도 | false split | 불필요한 병렬 | 놓친 병렬 | 단위 compatible / exact (n) | verification 놓침 / 과잉 | isolation 놓침 / 과잉 | 일관성 | 파싱 실패 | 비용 |
|---|---|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|
| claude-opus-5-5 | minimal | 90 | 80.0% | 24.1% | 4.3% | 0.0% | 100% / 100% (20) | 0% / 17.5% | 0% / 0% | 88.9% | 1 | $0.97 |
| claude-opus-5-5 | **checklist (채택)** | 90 | **98.9%** | **0.0%** | 0.0% | 6.3% | 100% / 100% (19) | 0% / 0% | 0% / 0% | 97.8% | 0 | $0.81 |
| claude-opus-5-5 | fewshot | 90 | 98.9% | 1.9% | 0.0% | 0.0% | 100% / 100% (20) | 0% / 1.3% | 0% / 0% | 97.8% | 0 | $0.79 |
| claude-opus-5-5 | checklist-fewshot | 90 | 96.7% | 0.0% | 0.0% | 12.5% | 100% / 100% (17) | 10.0% / 0% | 0% / 0% | 93.3% | 2 | $0.90 |
| gpt-6.1-sol | minimal | 90 | 44.4% | 55.6% | 45.7% | 0.0% | 100% / 100% (20) | 0% / 46.3% | 0% / 1.3% | 86.7% | 0 | $0.35 |
| gpt-6.1-sol | checklist | 90 | 97.8% | 0.0% | 0.0% | 12.5% | 100% / 94.4% (18) | 0% / 0% | 0% / 0% | 100% | 0 | $0.34 |
| gpt-6.1-sol | fewshot | 90 | 93.3% | 7.4% | 7.1% | 0.0% | 100% / 100% (20) | 0% / 1.3% | 0% / 0% | 95.6% | 0 | $0.34 |
| gpt-6.1-sol | checklist-fewshot | 90 | 97.8% | 0.0% | 0.0% | 12.5% | 100% / 100% (18) | 0% / 0% | 0% / 0% | 100% | 0 | $0.37 |

(gpt-6.1-sol은 2회 합산. 1회만 본 1차 값은 minimal 46.7%/false split 51.9%, checklist 97.8%/0%, fewshot 93.3%/7.4%, checklist-fewshot 97.8%/0%로 2회차가 결론을 바꾸지 않았다. sol의 비용은 cliproxyapi가 보고한 값이다.)

- **선택 (사전 규칙 그대로)**: 자격(false split ≤ 10%, 놓친 병렬 ≤ 1/3)은 checklist·fewshot·checklist-fewshot. 정확도 최고 98.9%에서 한 항목 이내인 세 변형이 동률이고, false split이 가장 낮은 변형 중 놓친 병렬이 낮은 **checklist**가 이겼다(fewshot은 false split 1.9%, checklist-fewshot은 놓친 병렬 12.5%). checklist 문구를 그대로 `src/orchestrator/instructions.ts`의 `SPLIT_JUDGMENT`로 넣었다.
- **minimal(세 질문만)의 실패 양상**: opus 오답 18개 중 12개가 결합된 d 과제(d1, d3–d8)에 Independent verification을 붙인 것이고, 2개는 병렬 과제(p1, p2)에 verification을 덧붙인 것이다. 세 질문만 주면 모델은 "위험해 보이는 과제"를 검증 대상으로 읽는다. gpt-6.1-sol에서는 더 심해 false split 55.6%(2회 합산; d 과제 대부분을 Parallelism+verification으로 분할)였다. 비용 근거와 "하지 말아야 할 경우"를 주면 두 모델 모두 false split이 0%가 됐다. **지시문에 기준과 비용을 적는 것이 판단을 좌우하고, 모델 차이보다 지시문 차이가 크다.**
- **checklist의 유일한 오답**: n19(검증기 세 개 벤치마크)에서 "나누지 않음"을 골랐다(opus 2회 중 1회, sol 2회 모두). 근거는 "같은 기계에서 벤치마크를 동시에 돌리면 수치가 왜곡된다"였다. 라벨을 붙일 때 고려하지 못한 타당한 이유라서, 이 오답은 라벨 쪽 약점에 가깝다(사후 해석; 판정은 바꾸지 않음). opus의 다른 반복은 병렬로 나누되 "측정은 내가 순서대로 다시 돌린다"고 답했다.
- **분할 단위**: Parallelism을 고른 경우의 단위는 opus 모든 변형에서 기대 단위와 일치했다(compatible 100%). sol checklist는 1회차에 n10에서 단위를 한 번 더 잘게 나눠 exact가 94.4%(2회 합산 18건 중 17건)였다.
- **비용**: 1차 본 실행 $4.16(opus $3.46, sol $0.70) + pilot $0.04 + sol 2회차 $0.70 = **$4.90**. 호출 중앙값 opus 3.2초, sol 6.5초.
- **해석의 한계**: checklist의 기준은 라벨 기준(5.2)과 같은 사람이 같은 원칙으로 썼다. 그래서 checklist의 높은 정확도는 "이 원칙을 모델이 잘 따른다"는 뜻이지 원칙 자체가 옳다는 증거는 아니다. 원칙의 근거는 과거 측정(Gate A NO-GO, auto/multi 제거, G-X의 Verifier 비용)이고, 원칙이 실제 비용·품질로 이어지는지는 6장 스모크가 일부만 본다. 1턴 판단은 파일을 읽지 않은 조건이다. 실제로 6장에서 p1은 1턴 평가와 판단이 달랐다(원인은 7장).

### 5.4 제품에 넣은 판단 지시문

`src/orchestrator/instructions.ts`의 `SPLIT_JUDGMENT`는 `experiments/judgment/variants.ts`의 `checklist`와 글자까지 같다(`test/orchestrator/spawn.test.ts`의 "the adopted split instruction (R5)": `expect(SPLIT_JUDGMENT).toBe(VARIANTS.checklist)`). orchestrator는 이 판단을 작업 시작 전에 내리고, 보고서의 `data.split`(`decision`, `criteria`, `reason`)에 남긴다.

## 6. end-to-end 스모크 (R6, 2026-10-06)

**설정**: `experiments/workflow/driver.ts`(실제 pi RPC 세션: main → `orche_task` → orchestrator/sub-worker, 과제 저장소는 임시 git 작업 공간, 채점은 숨겨진 테스트)로 claude-opus-5-5, thinking high, 과제당 새 세션 1회씩 돌렸다. 런타임은 실행 시점의 worktree 스냅샷(`results/orchestrator-smoke-2026-10-06/runtimes/orchestrator`, src sha256 `runtimes/orchestrator.src.sha256`)과 기준선 master `ac1bbf1`의 `git archive`(`runtimes/baseline-ac1bbf1`)다. 두 런타임 모두 기본 설정(`mainMode: single`, `single: {}`)이다. 과제는 `results/orchestrator-smoke-2026-10-06/suite/`에 복사했다:

- 분할 안 함: `d3-money-migration-ko`(결합된 Money 계약 이전, R5 라벨 none)
- 병렬 분할: `p1-ticket-batch`(독립 티켓 4개, R5 라벨 parallelism)
- 독립 검증: `v1-static-traversal-verify` = `b1-static-traversal`(정적 파일 서버 경로 탈출 보안 수정) + "구현에 참여하지 않은 독립 검토자에게 확인받고 그 판정을 보고에 넣어 달라"는 한 문단
- 추가(7장 원인 규명용): p1 2회차, `p1-ticket-batch-parallel-request` = p1 + "모듈당 worker 하나로 병렬로 해 달라"는 한 문단

원시 기록은 `runs/`·`runs-extra/`(세션별 `meta.json`, main 세션, orche 기록과 sub-worker transcript, 최종 작업 공간), 표는 `summary.md`·`summary-extra.md`(`experiments/orchestrator-smoke/summarize.ts`가 생성; `summary*.json`에 orchestrator의 `data.split` 원문)다.

| Arm | 과제 | 숨겨진 테스트 | 시간 s | main 위임 | orchestrator 판단 [sub-worker] | 요청 main / orche | 토큰 in / out / cache read (k) | 카탈로그 비용 |
|---|---|---|---:|---|---|---|---|---:|
| 기준선 ac1bbf1 | d3 | pass | 256 | implement | – | 3 / 15 | 48 / 32 / 378 | $0.90 |
| orchestrator | d3 | pass | 222 | implement | none | 3 / 11 | 42 / 26 / 255 | $0.74 |
| 기준선 ac1bbf1 | p1 | pass | 558 | implement | – | 4 / 28 | 85 / 62 / 1191 | $1.81 |
| orchestrator | p1 | pass | 496 | implement | none | 3 / 27 | 78 / 55 / 978 | $1.60 |
| orchestrator | p1 (2회차) | pass | 416 | implement | none | 3 / 17 | 73 / 49 / 599 | $1.40 |
| orchestrator | p1 + 병렬 요청 | pass | 412 | implement | parallelism [csv 97s, ratelimit 122s, cache 242s, semver 180s, 모두 done] | 4 / 59 | 149 / 87 / 1100 | $2.56 |
| 기준선 ac1bbf1 | v1 | pass | 389 | implement, verify | – | 4 / 32 | 76 / 39 / 682 | $1.23 |
| orchestrator | v1 | pass | 279 | implement | verification [verify 7요청 104s, passed] | 3 / 26 | 68 / 25 / 447 | $0.86 |

- **판단**: d3는 "모든 모듈이 새 Money 계약에 의존하는 작고 결합된 패키지"라며 나누지 않았다. v1은 구현을 직접 하고 "사용자가 명시적으로 독립 검토를 요청했다"며 새 읽기 전용 verifier 하나를 띄웠다(기준선에서는 main이 구현 뒤 별도 `verify` worker를 불렀다). 명시적 요청이 없는 p1은 두 번 모두 나누지 않았고, 병렬을 요청한 p1은 모듈별 4개로 나눴다. 각 `data.split` 원문은 `summary.json`·`summary-extra.json`에 있다.
- **통과**: 8회 모두 숨겨진 테스트 통과, 모델 parity 8/8.
- **기준선 비교(과제당 1회라 경향만)**: orchestrator 쪽이 세 과제 모두 시간·카탈로그 비용이 같거나 작았다(d3 222s/$0.74 vs 256s/$0.90, p1 496s/$1.60 vs 558s/$1.81, v1 279s/$0.86 vs 389s/$1.23). v1에서는 main이 별도 verify를 부르는 대신 orchestrator 안에서 검증이 끝나 main 요청이 하나 줄었다. 반복이 없어서 차이가 유의한지는 알 수 없다.
- **비용 표기**: "카탈로그 비용"은 `~/.pi/agent/cliproxyapi-models.json`의 단가 × 세션 기록의 토큰이다. cliproxyapi가 보고한 비용(`summary.md`의 Provider cost, 합계 $3.49)은 같은 모델에서도 세션마다 $0.05–$1.96로 일관되지 않아 쓰지 않았다. 스모크 8회 카탈로그 합계는 **$11.10**이다.

## 7. p1을 나누지 않은 이유 (R8)

5장의 1턴 평가에서 checklist 지시문은 p1을 parallelism으로 맞혔다(opus 2/2, sol 2/2). 그런데 6장 e2e에서 병렬을 요청하지 않은 p1 실행 2회는 모두 나누지 않았다.

**(a) 제품 지시문이나 판단 단계가 달랐나: 아니다.** 두 실행 모두 orchestrator 첫 메시지에 `Orchestration:` 절과 `SPLIT_JUDGMENT` 전문이 그대로 들어 있다(transcript 문자열 일치: `runs/sessions/O-p1-ticket-batch/orche-records/*/workers/W1-*.jsonl`, `runs-extra/sessions/O2-p1-ticket-batch/orche-records/*/workers/W1-*.jsonl`). 같은 런타임에서 병렬 요청 변형은 `orche_spawn`으로 4개를 띄웠으므로 도구도 있었다. 판단 단계도 실제로 실행됐다. 1회차 첫 턴 thinking 요약에 "네 티켓은 parallelism에 해당할 수 있지만 지시문은 비용이 두 배라 분할하지 않는 쪽이 기본이니, 실제 작업을 보고 정하겠다"는 내용이 있다. 두 실행 모두 저장소를 두 번 읽은 뒤(`find`/`wc -l`, 각 `index.mjs`·smoke test·README) 나누지 않겠다고 정했으며, 보고서에 `data.split`을 남겼다.

**(b) 분할 비용이 이득보다 크다고 판단했다: 그렇다.** 보고된 근거는 다음과 같다.
- 1회차: "Each ticket is a single small file plus tests, so loading context and integrating would cost more than doing them in sequence."
- 2회차: "The four tickets are independent and touch separate files, but each is small and simple to plan; doing them alone avoided twice the cost and a separate integration step."

지시문의 Parallelism 조건 중 "부분마다 실질적(대략 10분 이상)"을 충족하지 않는다고 본 것이다.

**판단이 타당했나: 측정으로는 그렇다.**
- 혼자 할 때 티켓 하나에 걸린 시간은 약 1–3분이었다. 2회차 task_plan 기록상 csv와 ratelimit이 153초에 끝났고 cache와 semver가 337초에 끝났다.
- 병렬로 나눈 실행에서도 sub-worker는 97–242초였다. 모두 지시문의 10분 기준에 한참 못 미친다.
- 나눈 실행은 전체 412초로 나누지 않은 실행(416초, 496초)과 시간이 같았다. 가장 긴 cache sub-worker와 탐색·통합·검사가 그만큼 걸렸기 때문이다. 카탈로그 비용은 $2.56으로 나누지 않은 실행의 1.6–1.8배였다.
- 과거 parallel3(2026-10-03)의 p1에서도 multi는 평균 676초, $2.49(3회)로 single 834초, $1.27보다 19% 빨랐지만 비용이 1.96배였다. 오케스트레이션 없는 pi-solo는 587초, $0.77로 가장 빨랐다.
- 즉 p1을 나누지 않는 것은 지시문 기준(Gate A 비용 근거)에도 맞고 실제 결과에도 맞다. (각 조건 1–2회라 크기는 경향으로만 읽는다.)

**(c) 불일치를 만든 평가 조건**: 1턴 평가는 "파일을 읽기 전에, 인계문과 파일 목록만 보고 지금 정하라"(`experiments/judgment/variants.ts` `FORMAT`)는 조건이다. 그래서 모델은 긴 티켓 명세를 보고 "부분마다 substantial"이라고 답했다. 1턴 답변 근거는 모두 "each (especially cache and semver) is substantial" 같은 문장이다. 반면 e2e orchestrator는 "시작 전에 정하라"는 지시를 "구현 전에"로 읽고 저장소를 먼저 본 뒤 크기를 다시 판단했다. 라벨도 같은 약점을 가졌다. p1 라벨 근거는 "each a substantial spec"(명세 길이)이고, 단위별 실제 작업 시간을 재서 붙인 것이 아니다. 지금 모델에게 p1의 티켓 하나는 1–3분짜리다.

**제안: 지시문이 아니라 라벨과 평가 조건을 고친다.**
- 지시문을 p1이 나뉘도록 바꾸면 같은 결과와 같은 시간에 비용만 1.6–1.8배가 된다. 지시문의 10분 기준은 Gate A 비용 근거에서 나왔고, 이번 e2e에서도 맞았다.
- 다음 평가 라운드(새 사전 등록)에서는 다음을 바꾼다.
  1. parallelism 라벨을 명세 길이가 아니라 대상 모델의 단위별 단독 작업 시간(예: 10분 이상)으로 붙인다. 이 기준이면 p1은 none(또는 none과 parallelism 모두 정답)이 된다. p2는 라벨 근거에 이미 "modest, 나누든 말든 방어 가능"이라고 적혀 있고, p3와 합성 항목(n01, n12, n13 등)은 e2e로 재지 않았으므로 같은 방식으로 다시 확인해야 한다.
  2. 판단 시점을 제품과 맞춘다. 평가에 파일 내용이나 크기를 주거나, 몇 턴 동안 읽기 도구를 허용한 뒤 판단하게 한다.
- 이번 5장의 수치는 사전 등록대로 두되, **parallelism 쪽 정확도(놓친 병렬 0%)는 e2e 기준으로 검증되지 않았다**고 읽어야 한다. p1을 none으로 다시 채점하면(`experiments/judgment/rescore-p1-none.ts`, 사후 계산이며 사전 등록 아님) opus는 checklist 87/90(96.7%), fewshot 87/90, checklist-fewshot 85/90, minimal 71/90이고 sol은 checklist·checklist-fewshot 86/90, fewshot 82/90, minimal 39/90이다. 모든 비-minimal 변형이 p1을 나눴으므로 감점은 고르고, 동률 규칙(false split)도 여전히 checklist가 앞선다. 즉 선택은 바뀌지 않는다.
- 실제 제품에서 사용자가 병렬을 명시적으로 요청하면 orchestrator는 그대로 나눴다(p1 + 병렬 요청: 4개 sub-worker, 소유 파일 분리, 모두 done, 숨겨진 테스트 통과).

## 8. 분할 판단 평가 v2 (사전 등록, 2026-10-06)

> 이 절의 8.1–8.6은 v2의 첫 모델 호출(pilot 포함) 전에 썼다. 결과는 8.7 이후에 덧붙이고, 8.1–8.6은 고치지 않는다. 근거는 `experiments/judgment/preregistration-v2-evidence.md`(작성 시각과 sha256)에 남긴다.

### 8.1 목적

v1(5장)은 파일을 읽기 전, 명세 길이로 붙인 라벨로 판단을 쟀다. 그래서 e2e와 어긋났다(7장). v2는 두 가지를 바로잡는다. 첫째, 정답을 실제 작업량과 결합도로 다시 정한다. 둘째, 저장소가 있는 과제는 제품과 같은 조건(제품 지시문, 저장소를 읽은 뒤 판단)에서 잰다. 그 위에서 채택한 checklist가 여전히 가장 나은지 확인한다.

### 8.2 라벨 기준 (`experiments/judgment/tasks-v2.json`)

- **parallelism**: 세 조건을 모두 만족해야 한다.
  1. 대상 모델(claude-opus-5-5) 하나가 부분마다 혼자 약 10분 이상 걸린다(읽기, 구현, 테스트 포함).
  2. 부분끼리 파일과 인터페이스를 공유하지 않는다.
  3. 나눠서 얻는 시간이 늘어나는 비용(대략 2배)보다 크다.
- **보정 근거(실측)**:
  - p1(R6): 티켓당 1–3분. 나눠도 412s로 나누지 않은 416s/496s와 시간이 같았고, 비용은 1.6–1.8배였다.
  - parallel3: pi-solo가 p1 587s(티켓 4개), p2 567s(핸들러 6개), p3 432s(라이브러리 3개). 부분마다 약 1.5–2.5분이다. multi는 single보다 비용이 1.9배였다.
- **라벨이 바뀐 항목**:
  - p1, p2, p3: parallelism → none. p2는 v1의 "none도 허용"도 없앴다.
  - n15: 300줄짜리 번역 5개. 부분마다 몇 분이라 none.
  - n19: 동시에 돌린 벤치마크는 서로의 수치를 왜곡하므로 none. 실행 순서를 지킨 설정 분할은 parallelism도 허용한다.
- **새 항목**:
  - **p4**(`fixtures/parallel/p4-stdlib-ports`): CPython 모듈 포팅 3개(textwrap+shlex, difflib, urllib.parse). 각자 디렉터리가 있고 공유 파일이 없다. 숨겨진 CPython 생성 케이스 1,328개와 정확히 같아야 한다. 부분마다 10분 이상으로 추정해 parallelism으로 붙였고, R11에서 실측한다.
  - **n25**: p1과 같은 모양(독립 소형 티켓 4개, 각 5–20줄)인 1턴 항목, none.
- 나머지 라벨은 v1과 같다(`v1Labels`에 v1 값을 보존).
- 1턴 합성 항목에는 main이 쓴 규모 메모(`scope`: 줄 수, 테스트 수, 공유 여부)를 붙였다.
- v1의 `tasks.json`, `variants.ts`, `runs/`, `report*.md`는 그대로 둔다.

### 8.3 평가 조건 (`experiments/judgment/run-v2.ts`)

**공통**
- 제품 경로로 지시문을 만든다. `assignmentPrompt(...)`(`src/extension/workers.ts`)에 `orchestratorSection(<변형>)`(`src/orchestrator/instructions.ts`)을 넣어 orchestrator 첫 인계문을 그대로 렌더링한다. worker 시스템 지시도 `taskWorkerInstructions`와 orche_task의 덧붙임을 그대로 쓴다.
- 끝에 평가용 한 단락을 붙인다. 내용은 "이번 실행은 판단 단계만, 나중에 적용할 기준도 포함"이다.
- 모델은 claude-opus-5-5(주 모델)와 gpt-6.1-sol, thinking high, 반복 2회다.

**agentic (저장소를 읽은 뒤 판단)**
- 대상: p1, p2, p3, p4, b5, d3, d5. 병렬로 보이는 항목과 함정 항목이다.
- 실제 pi 세션(`createSession`)을 fixture 저장소의 새 git 사본에서 띄운다. 도구는 읽기 전용 도구 세트와 제품 `orche_spawn`의 설명·스키마, `split_decision`이다.
- 판단은 `split_decision` 또는 `orche_spawn` 호출로 기록하고, 호출하면 실행이 끝난다.
- 30턴이나 10분 안에 판단이 없으면 파싱 실패(오답)로 센다.

**one-turn**
- 대상: 나머지 40개 항목(fixture 14개, 합성 26개).
- 도구 없이 한 번 호출한다. 인계문에 파일 목록과 규모 메모를 넣고, v1과 같은 JSON 형식으로 답하게 한다.

**규모 조건**
- fixture 전체를 agentic으로 돌리는 것이 요구에 가장 가깝다. 하지만 v1 비용과 예상 세션 길이로 보면 opus agentic 세션 하나가 약 $0.1–0.2이고, 22개 × 변형 3개 × 2회만으로 $13–26이 된다. R9–R11의 예산 $25 안에 R11 e2e(약 $12)를 남기려면 판단 평가를 약 $13 안에 끝내야 한다.
- 그래서 판단이 저장소를 보느냐에 달린 항목만 agentic으로 둔다.
- pilot에서 opus agentic 세션 비용 중앙값이 $0.08 이하면, agentic을 fixture 22개 전체로 넓힌다.

**pilot**
- p4와 d3, checklist, 모델 둘, 1회. 집계에서 뺀다.

**예산 규칙**
- pilot으로 추정한 전체 비용이 $14를 넘으면, agentic 대상을 p1, p3, p4, b5, d3으로 줄인다.

### 8.4 변형 (`experiments/judgment/variants-v2.ts`)

- `checklist`: 제품의 현재 지시문(현직, incumbent).
- `fewshot`: v1과 같다.
- `checklist-sized`: v1과 R6에서 드러난 세 가지를 고친 checklist다.
  1. 비용 문장을 측정한 그대로 쓴다. "부분이 1–3분인 과제는 나누면 비용이 약 2배이고 빨라지지 않았다. 부분이 길 때만 이득이다."
  2. (c)에 "당신 혼자 약 10분 이상"과 "요청 길이가 아니라 읽은 코드와 명세로 크기를 판단하라"를 넣었다(p1).
  3. (e)를 새로 넣었다. "동시에 돌리면 서로 방해하지 않을 것(벤치마크, 공유 포트·DB·빌드 출력)"(n19).

### 8.5 지표와 선택 규칙

- **지표**: v1과 같다. 정확도, false split, 불필요한/놓친 parallelism·isolation·verification, unit 일치, 일관성, 비용을 본다. 조건별(agentic / one-turn)로도 따로 낸다.
- **선택**: opus의 전체 47개 항목 × 2회 결과로 정한다.
  - 자격: false split ≤ 10%, 놓친 parallelism ≤ 1/3.
  - 자격 있는 변형 중 정확도가 가장 높은 것을 고른다.
  - 정확도가 한 항목(1/47) 이내로 비기면 false split → 놓친 parallelism → 현직(checklist) 순으로 고른다.
  - 자격 있는 변형이 없으면 false split + 놓친 parallelism이 가장 낮은 것을 고르고, 그다음 정확도, 그다음 현직 순이다.
- **반영**: 다른 변형이 이기면 제품 `SPLIT_JUDGMENT`를 그 문자열로 바꾸고, 같은 문자열임을 테스트로 고정한다.
- **놓친 병렬 분석**: 놓친 parallelism이 0이 아니면 그 세션의 판단 근거와 읽은 파일로 원인을 적는다.
- gpt-6.1-sol은 서술용이다. 선택에는 쓰지 않는다.

### 8.6 R11 계획 (스스로 분할하는지 e2e)

- **과제 선택**:
  - p2와 p3은 부분마다 약 1.5–2.5분(parallel3 실측)이라 "부분마다 약 10분 이상" 조건을 만족하지 못한다.
  - 그래서 p4를 쓴다.
- **실행 설정**:
  - `experiments/workflow/driver.ts`로 실제 RPC 세션을 돌린다. 모델은 claude-opus-5-5, thinking high, 지시문에 병렬 요청 문구는 없다.
  - **O**: 제품 기본값(orchestrator).
  - **N**: `single.spawn: false`. 예전 single worker로, 나누지 않는다.
  - 각 1회 돌리고 동시에 실행한다.
- **기록할 것**:
  - 판단(`data.split`)
  - 숨겨진 테스트 통과 여부
  - 시간
  - 토큰
  - 카탈로그 비용
  - 부분별 시간(sub-worker 시간, 또는 N의 task_plan 시각)
- **O가 나누지 않으면**:
  - 판단 근거와 읽은 범위로 원인을 분석한다.
  - 지시문 수정 근거가 있으면 고친 뒤 O를 1회 다시 돌린다. 근거가 될 수 있는 것은 v2에서 다른 변형이 이긴 경우, 또는 transcript에서 문구 때문임이 드러난 경우다.

### 8.7 실행 기록 (8.1–8.6 작성 뒤에 추가)

- **사전 등록 확인**: `experiments/judgment/preregistration-v2-evidence.md`는 11:11:18Z에 썼다. 첫 v2 모델 호출은 pilot 11:11:26Z다. 이 순서는 transcript(`~/.pi/agent/orche/records/01a10c1a-…/workers/W1-2026-10-06T10-09-12-886Z.jsonl`)의 도구 호출 순서로 확인할 수 있다. 각 run의 `meta.json`에는 `tasks-v2.json`·`variants-v2.ts`의 sha256이 있고, evidence 파일의 값과 같다.
- **pilot**(`runs-v2/*-pilot-*`, 집계 제외): opus agentic 세션 비용 $0.049 / $0.071(중앙값 $0.06)이었다. 8.3 규칙에 따라 agentic을 fixture 22개 전체로 넓혔다(`--agentic-fixtures`). 추정 총비용은 약 $13.6으로 $14 이하라 축소 규칙은 적용되지 않았다.
- **사전 등록 뒤에 바뀐 것**
  - `run-v2.ts`: `--agentic-fixtures` 플래그를 추가했다. 위 확장 규칙을 실행하기 위한 것이다.
  - `score-v2.ts`: 다음 두 가지를 바꿨다.
    - 항목의 조건을 call에서 읽게 했다.
    - opus fewshot 7회는 응답 없이 끝난 전송 실패였다(`auth_unavailable`, 0턴). 같은 항목·반복을 다시 실행해 이 7건을 대체했다(`*-retry-transport-*`). v1의 run.ts도 전송 오류는 한 번 재시도했다.
  - 지표, 라벨, 선택 규칙은 바꾸지 않았다.
- **원시 결과와 표**
  - 원시 결과: `experiments/judgment/runs-v2/`
  - 표: `experiments/judgment/report-v2.md`(`report-v2.json`). 집계 대상은 `*-main-*` 두 개와 `*-retry-*`다.
- **v2 비용**(provider 보고값 = 카탈로그 값):
  - pilot $0.17
  - opus 본 실행 $6.77
  - sol 본 실행 $3.37
  - 재시도 $0.28
  - 9.2의 사후 점검 $1.22
  - 합계 **$11.80**

**opus 결과**(47개 항목 × 2회)

| 변형 | 정확도 | false split | 놓친 parallelism | 불필요 verification | 일관성 | agentic 22개: 정확도 / false split | one-turn 25개: 정확도 / false split |
|---|---:|---:|---:|---:|---:|---|---|
| checklist (현직) | 91.5% | 12.1% | 0% | 0% | 100% | 86.4% / 15.8% | 96.0% / 7.1% |
| fewshot | 87.2% | 18.2% | 0% | 10.7% | 93.6% | 77.3% / 26.3% | 96.0% / 7.1% |
| checklist-sized | 91.5% | 12.1% | 0% | 0% | 100% | 86.4% / 15.8% | 96.0% / 7.1% |

**gpt-6.1-sol 결과**(서술용, 47개 × 2회)

| 변형 | 정확도 | false split | 놓친 parallelism | 놓친 isolation |
|---|---:|---:|---:|---:|
| checklist | 90.4% | 12.1% | 8.3% | 0% |
| fewshot | 89.4% | 12.1% | 8.3% | 37.5% |
| checklist-sized | 91.5% | 7.6% | 16.7% | 12.5% |

**선택 규칙 적용**
- 세 변형 모두 false split이 10%를 넘어 자격이 없다.
- 그래서 대체 규칙을 적용했다. false split + 놓친 parallelism은 checklist와 checklist-sized가 12.1%로 같고, 정확도도 91.5%로 같다. 따라서 현직 **checklist**가 선택됐다.
- 즉 평가 v2만으로는 지시문을 바꿀 근거가 없었다. 이후 제품 지시문을 바꾼 이유는 R11 e2e이며, 9장에 적는다.

**v1 대비 변화**
- opus checklist 정확도가 v1 98.9%에서 v2 91.5%로 내려갔다. 판단이 바뀐 것이 아니라 정답이 바뀌었기 때문이다. 오답 8건(94건 중)은 모두 v2에서 none으로 바뀐 p1, p2, p3(agentic)와 n15를 parallelism으로 나눈 것이다.
- 판단 시점을 제품처럼 저장소를 읽은 뒤로 옮겨도 판단은 바뀌지 않았다. opus는 각 p 과제를 4턴 안팎으로 읽고 나서도 "명세가 커서 단위마다 10분 이상"이라고 판단했다. 예: p1 "Each spec is big enough for ten or more minutes of implementing and testing".
- 같은 과제를 e2e에서 실제로 할 때는 판단이 달랐다. p1을 3번 실행했는데 3번 모두 나누지 않았다(R6 2번, 9.3의 P1 1번). 근거는 "each ticket should only take a few minutes"였고, 실제 시간도 그랬다.
- 결론: "판단 단계만 떼어 내 묻는" 평가는 실제 작업 흐름 속 판단보다 분할 쪽으로 치우친다. 이 치우침은 모든 변형에서 같았다.
- 따라서 이 평가는 변형 사이의 차이(fewshot의 불필요 verification, 세 질문만 줬을 때의 과분할)를 가르는 데에는 쓸 만하다. 그러나 실제 분할률을 추정하는 데에는 쓸 수 없다. 실제 분할 판단은 e2e로만 확인된다.
- **놓친 parallelism**: opus는 0이다. sol은 n12에서 놓쳤는데, 근거가 "The assignment explicitly requires working alone with no peer workers"였다. 원인은 제품 지시문이다(9.2).

## 9. v2 이후 결정과 R11 e2e (2026-10-06)

### 9.1 지시문: checklist를 유지한다

- 평가 v2의 선택 규칙은 현직 checklist를 골랐다(8.7).
- R11에서 checklist-sized로 잠시 바꿔 다시 돌려 봤다(9.3). 결과를 보고 checklist로 되돌렸다.
- 제품의 `SPLIT_JUDGMENT`는 v1과 같은 문자열이다. `test/orchestrator/spawn.test.ts`가 `VARIANTS.checklist`, `VARIANTS_V2.checklist`와 같은 문자열임을 확인한다.

### 9.2 "You work alone" 문구를 고쳤다 (놓친 parallelism의 원인)

**원인**
- sol이 n12(테스트 4묶음)를 놓친 근거는 모두 같았다. "The assignment explicitly requires working alone with no peer workers"였다. n12는 변형 셋 × 2회 = 6건 중 4건이 나누지 않았고, 그 4건 모두 이 근거였다. 정답이 none인 n15에서도 3건이 같은 근거를 댔다.
- 이 문구는 제품 지시문에서 왔다.
  - 모든 orche_task 인계문의 첫 줄: "You work alone; there are no peers or backlog."
  - worker 시스템 지시: "You work alone: there are no peer workers."
- orchestrator에게는 이 문구가 `orche_spawn`과 모순된다. opus는 이 문구를 이유로 든 적이 없다.

**수정**
- orchestrator 인계문의 첫 줄을 `ORCHESTRATOR_TEAM_LINE`으로 바꿨다. 내용은 "There are no peers or backlog; the only other workers are the sub-workers you start with orche_spawn."이다.
- `orche_spawn`이 있는 세션의 시스템 지시는 `workerSystemInstructions(true)`가 만든다. 내용은 "There are no peer workers; you start sub-workers only with orche_spawn, when an assignment's Orchestration rules call for it."이다.
- `single.spawn: false`와 sub-worker에게는 예전 문구를 그대로 둔다. 테스트: `test/extension/orchestrator.test.ts`의 "no split" 두 건과 "parallel split".

**사후 확인**(사전 등록 아님)
- 실행: `runs-v2/*-teamline-*`, 비교: `experiments/judgment/compare-teamline.ts`
- 대상: one-turn 합성 항목 25개, checklist-sized, 2회

| 모델 | 문구 | 정확도 | false split | 놓친 parallelism | 놓친 isolation | "alone" 인용 |
|---|---|---:|---:|---:|---:|---|
| gpt-6.1-sol | 예전 | 92.0% | 3.6% | 20.0% | 25.0% | n12 ×2, n15 |
| gpt-6.1-sol | 수정 | 96.0% | 7.1% | 0% | 0% | 없음 |
| opus | 예전 | 96.0% | 7.1% | 0% | 0% | 없음 |
| opus | 수정 | 96.0% | 7.1% | 0% | 0% | 없음 |

**결과**
- sol의 놓친 parallelism/isolation이 사라졌다.
- false split은 n15 1건 늘었다.
- opus는 같았다.

### 9.3 R11: 스스로 나누는가, 나누면 이득인가 (p4, claude-opus-5-5, thinking high, 병렬 요청 문구 없음)

**과제 선택**
- p2와 p3는 부분마다 약 1.5–2.5분이라 쓰지 않았다(parallel3 실측). 
- p4를 만들어 썼다(8.2).
- 원시 기록은 보관 위치(R15)에 있다.
- 요약은 `experiments/orchestrator-smoke/results-2026-10-06/r11-*.md`, `*.json`이다.

| 실행 | 지시문 | 판단 | 숨겨진 테스트 | 시간 | 요청 main / orche | 출력 토큰 | 카탈로그 비용 |
|---|---|---|---|---:|---|---:|---:|
| N: `single.spawn: false` | 없음(예전 single) | (나누지 않음) | pass | 1885s | 3 / 70 | 160k | $5.89 |
| O: 제품 | checklist | none: "despite the parallelism criteria technically supporting it" | 판단 직후 중단 | – | – | – | $0.59 |
| O2: 제품 | checklist-sized | split, parallelism, sub-worker 3개 | pass | 1675s | 5 / 142 | 264k | $9.44 |
| P1: 제품, 과제 p1 | checklist-sized | none: "Each ticket … took a few minutes" | pass | 618s | 4 / 31 | 59k | $1.75 |

**O: checklist는 나누지 않았다**
- 저장소를 읽은 뒤 기준은 충족한다고 보면서도 혼자 하기로 했다(`r11-o.md`).
- 이 경로(혼자 함)는 N이 이미 측정하므로, 비용을 아끼려고 판단을 확인한 뒤 중단했다.

**O2: checklist-sized는 스스로 나눴다**
- 첫 판단(4번째 요청)에서 "text / difflib / urlparse" 3개로 나눴다.
- `data.split` 근거: "each a long (15-25 min) implement-and-fuzz job"

**sub-worker 시간과 비용**

| sub-worker | 시간 | 요청 수 | 비용 |
|---|---:|---:|---:|
| text | 1410s | 41 | $2.39 |
| difflib | 983s | 47 | $3.29 |
| urlparse | 1314s | 39 | $2.98 |

- orchestrator 자체는 15요청, $0.63이었다.
- 같은 부분을 N은 혼자 했다. task_plan 기준으로 text(textwrap+shlex)가 약 830s, 나머지(difflib, urlparse, 마무리 검사)가 합쳐서 약 955s였다.
- 나눴을 때 text는 1410s로 혼자 할 때의 1.7배였다. difflib과 urlparse는 N에서 따로 잰 시각이 없다. 다만 둘과 마무리 검사를 합쳐도 약 955s였는데, sub-worker로는 각각 983s와 1314s가 걸렸다.
- 출력 토큰도 1.65배였다. sub-worker마다 자체 차등 테스트를 만들어 테스트가 282개가 됐다. N은 83개였다.

**결과: 이득이 작았다**

| 항목 | N(나누지 않음) | O2(나눔) | 비율 |
|---|---:|---:|---:|
| 시간 | 1885s | 1675s | 0.89배(11% 단축) |
| 비용 | $5.89 | $9.44 | 1.60배 |

- 숨겨진 테스트는 둘 다 통과했다.
- checklist의 비용 문장("about twice the cost … for about 10% less wall time")이 예측한 거래와 거의 같다. 이 문장은 부분이 짧은 과제에서 나온 것인데, 부분이 15–25분인 과제에서도 그대로 맞았다.
- 그래서 O의 "나누지 않음"을 틀린 판단으로 볼 근거가 없어졌다. checklist-sized로 바꾼 것을 되돌렸다(9.1).
- 각 조건은 1회씩이다. P1의 p1 시간(618s)이 R6의 같은 과제(416s, 496s)와 크게 다른 것처럼 반복 사이의 편차가 크다. 11%와 1.6배는 경향으로만 읽어야 한다.

**p4 라벨 사후 판정**(사전 등록 아님)
- 사전 등록 라벨은 parallelism이었다. 실측으로는 "나눠서 얻는 이득이 비용보다 크다"는 조건을 만족하지 못했다.
- 평가 v2에서는 모든 변형이 p4를 나눴다. 그래서 이 라벨은 선택 결과에 영향을 주지 않았다.

### 9.4 정리

- **이번 모델과 인프라에서 측정한 결과**: 독립 병렬 분할은 부분이 짧으면(1–3분) 이득이 없었다. 부분이 길어도(15–25분) 약 10% 빨라지는 대신 비용이 1.6–2배였다.
- **checklist의 판단**: 명시적 요청이 없으면 나누지 않는다. 이 판단은 지금까지의 e2e(p1 2회, p4 1회)에서 측정 결과와 맞았다.
- **명시적 요청이 있을 때**:
  - 사용자가 병렬을 요청하면 그대로 나눈다(R6 p1 + 병렬 요청).
  - 독립 검토를 요청하면 새 verifier를 띄운다(R6 v1).
- **평가 방법**: "판단 단계만 떼어 내 묻는" 평가는 실제보다 분할 쪽으로 치우친다(8.7). 이 평가는 변형 사이의 차이를 가르는 데만 쓴다. 실제 분할 여부는 e2e로 확인한다.
- **분할이 이득이 될 수 있는 경우**:
  - 사람이 아니라 도구가 오래 걸리는 경우(n10처럼 브랜치마다 10분 걸리는 테스트)
  - 더 느린 모델, 또는 API 처리량이 동시 세션을 늦추지 않는 환경
- **미검증 항목**:
  - 위 경우는 이번에 e2e로 재지 않았다.
  - sub-worker가 나눴을 때 더 오래 걸린 원인을 가르지 못했다. 동시 세션에서 프록시 처리량이 늦어졌는지, sub-worker가 더 철저하게 작업했는지 알 수 없다.

## 10. 실세션 요청으로 한 분할 판단 평가 (사전 등록, 2026-10-06)

> 10.1–10.5는 이 평가의 첫 모델 호출 전에 썼다. 결과는 10.6 이후에 덧붙이고, 10.1–10.5는 고치지 않는다. 근거(작성 시각, sha256)는 `experiments/judgment/real/preregistration-evidence.md`에 있다. 요청 원문과 데이터셋, 원시 결과는 gitignored 경로 `results/judgment-real/`과 `~/.local/share/orche-archive/`에만 둔다. 이 문서와 커밋된 보고서에는 익명 id(`rNNNN`, `PNN`)와 집계만 남긴다.

### 10.1 데이터와 추출 (`experiments/judgment/real/extract.py`, 결정적)

**원천**
- `results/sessions/{omp,pi}/<프로젝트>/`의 기록이다. 다른 기기에서 쓴 실제 main 세션이며, 46개 프로젝트, 최상위 세션 파일 312개(omp 292, pi 20)다.
- 하위 에이전트와 advisor 기록(1,871개)은 요청을 만드는 데 쓰지 않는다. 요청 한 건 = main 세션의 사용자 메시지 한 개다. 다음 사용자 메시지까지를 그 요청의 실행 구간으로 본다.

**걸러 내는 기준**(순서대로 적용, 1,378건)

| 기준 | 내용 | 탈락 |
|---|---|---:|
| generated | 합성 메시지, 도구가 만든 프롬프트(커밋 메시지 제안 등) | 62 |
| trivial | 15자 미만, 실행 구간의 도구 호출 3개 미만, 또는 활동 시간 60초 미만 | 596 |
| context-dependent | 60자 미만이면서 지시어("이거", "다시", "계속" 등)가 있는 것, 오류 로그만 있는 것, 경로·URL만 있는 것 | 68 |
| duplicate | 정규화한 앞 120자가 앞선 요청과 같은 것 | 29 |
| **남음** | | **623** |

**표본**(seed 20261006, 목표 90)
- none이 아닌 확정 라벨은 라벨마다 최대 20개, uncertain은 최대 15개를 넣는다.
- 나머지는 none을 세 종류로 나눠 같은 수씩 뽑는다. small(활동 10분 미만), one-module, several-modules(두 모듈 이상을 고쳤지만 기준 미달)다.
- 각 종류 안에서는 프로젝트 사이에서 돌아가며 뽑는다. 프로젝트 안에서는 시점을 무작위로 고른다.
- 결과는 87개다. 33개 프로젝트에서 나왔고, 기간은 2026-07 20개, 08 31개, 09 33개, 10 3개다.

### 10.2 라벨 기준 (v2 기준을 실행 기록으로)

라벨은 그 요청 **뒤에** 세션에 실제로 남은 실행 기록에서만 정한다. 판단 입력에는 이 기록을 넣지 않는다.

- **활동 시간**: 구간 안 이벤트 사이 간격의 합이다. 간격 하나는 최대 5분으로 잘라 대기 시간을 뺀다.
- **모듈**: 고친 파일의 첫 디렉터리다. `src/`, `lib/` 같은 공통 소스 루트 아래이면 두 단계까지 본다. 테스트와 문서는 모듈 수에서 뺀다.
- **모듈별 시간**: 파일을 읽거나 고친 호출 직전의 간격을 그 파일의 모듈에 나눠 준다.
- **parallelism**: 다음을 모두 만족해야 한다.
  - 두 개 이상의 모듈에 각각 10분 이상의 작업과 2회 이상의 수정이 있다.
  - 공유 파일(manifest, index, types, config, README 등)의 수정이 2건 이하다.
  - 모듈 사이 전환이 모듈 수 × 3회 이하다.
  - 이 조건 중 시간 조건만 만족하고 결합 신호가 있으면 uncertain이다. 5–10분 모듈이 섞인 경우도 uncertain이다.
- **isolation**: 별도 checkout(`git worktree add`)이나 이미지·영상 생성 도구를 코드 수정과 함께 쓴 경우다.
  - GUI(computer-use)만 쓴 작업은 uncertain이다. main이 정하는 `gui` worker 옵션의 영역이고, v2 기준에는 없기 때문이다.
- **verification**: 둘 중 하나면 붙인다.
  - 요청이 독립 검토를 명시한다.
  - 위험 영역(보안, 데이터 삭제·이전, 배포, 결제)의 변경이고, 다음 1–2개 사용자 메시지에서 문제가 보고됐다.
  - 위험 영역이 아닌 변경에서 뒤에 문제가 보고된 것은 none으로 둔다. v2 기준에서는 orchestrator 자신의 검사로 충분한 경우다.
- **none**: 위에 해당하지 않는 나머지다. 각 항목에 근거(`labelEvidence`)를 남긴다.

**표본 라벨 분포**
- none 75개(small 26, one-module 26, several-modules 23)
- verification 2개
- uncertain 10개(11.5%)
- parallelism과 isolation은 0개다. 남은 623건 전체에서도 parallelism은 0건이다. 참고로 기준을 5분으로 낮추면 두 모듈 이상인 경우가 7건이다.
- 그래서 이 세트는 주로 **실제 요청에서 쓸데없이 나누는지(false split)**를 잰다. 놓친 병렬은 잴 수 없다.

### 10.3 평가 조건 (`experiments/judgment/real/run-real.ts`)

**입력**
- 제품 경로로 렌더링한 1턴 판단이다. `assignmentPrompt`(role implement)에 `orchestratorSection(<변형>)`을 넣고, orchestrator 시스템 지시(`workerSystemInstructions(true)`)를 쓴다.
- 인계문은 다음 세 가지로만 만든다.
  - 요청 원문
  - 그 요청 **앞의** 세션 맥락: 앞선 요청 최대 2개(각 400자)와, 앞서 고친 파일 최대 12개
- 뒤에 일어난 일(작업, 시간, 결과)은 넣지 않는다. JSON 답 형식은 v2 one-turn과 같다.
- 저장소를 읽고 판단하는 조건은 쓰지 않는다. 세션은 다른 기기의 경로에서 기록됐고, 당시 커밋을 로컬 저장소에 맞출 근거가 기록에 없다.

**변형과 모델**
- 변형: `checklist`(현직), `checklist-sized`, `fewshot`(`variants-v2.ts` 그대로).
  - 새 변형은 넣지 않는다. 지난 결과가 지시문 문구 쪽의 개선점을 가리키지 않았다. 9.2의 "You work alone"은 이미 제품에서 고쳤다.
- 모델: claude-opus-5-5(선택용), gpt-6.1-sol(서술용). thinking high, 반복 2회. uncertain 항목도 실행하되 집계에서는 뺀다.

### 10.4 지표와 선택 규칙

- **지표**: v2와 같다. 정확도, false split, 불필요한 parallelism/isolation, 놓친/불필요한 verification, 일관성, 비용을 본다.
- **분할해서 보는 것**: 종류별(none 세 종류와 verification), 익명 프로젝트별 분할률, uncertain 항목의 분할률.
- **틀린 사례 분류**: (더한 기준 또는 놓친 기준) × (기록상 종류)로 나눈다(`score-real.ts`).
- **선택 규칙**: v2(8.5)와 같은 규칙을 opus의 확정 항목 × 2회에 적용한다. 자격 조건은 false split ≤ 10%, 놓친 parallelism ≤ 1/3이다. 정확도가 한 항목 이내로 비기면 false split → 놓친 parallelism → 현직 순으로 고른다.
- **반영**: 다른 변형이 이기면 제품 `SPLIT_JUDGMENT`와 테스트를 바꾸고, 실사용 판단이 얼마나 바뀌는지 분할률 변화로 남긴다.

### 10.5 R21 (e2e)

- parallelism 라벨 항목이 없으므로 "병렬 라벨 실세션 과제의 e2e"는 하지 않는다.
- verification 2건과 uncertain 항목은 당시 저장소 상태를 재현할 근거가 없어 e2e로 돌리지 않는다.

### 10.6 결과 (10.1–10.5 작성 뒤에 추가)

**실행 기록**
- 사전 등록 evidence는 12:26:05Z에 썼다. 첫 모델 호출은 12:26:13Z다(`results/judgment-real/runs/*/meta.json`의 `startedAt`과 sha256이 evidence와 같다).
- 집계는 `experiments/judgment/report-real.md`(`report-real.json`, 익명 id와 집계만)에 있다.
- 실행 후 바꾼 것은 없다. 1,044회 호출 모두 답을 받았다. 비용은 provider 보고값으로 $10.53(opus $7.85, sol $2.68)이다.

**확정 77개 × 2회 결과**

| 모델 | 변형 | 정확도 | false split | 불필요 parallelism | 불필요 isolation | 불필요 / 놓친 verification | 일관성 |
|---|---|---:|---:|---:|---:|---|---:|
| opus | **checklist (선택)** | 95.5% | 2.0% | 0.0% | 1.3% | 0.7% / 100% | 98.7% |
| opus | fewshot | 93.5% | 4.7% | 3.2% | 0.6% | 1.3% / 50% | 98.7% |
| opus | checklist-sized | 94.8% | 2.7% | 0.0% | 1.3% | 1.3% / 100% | 100% |
| sol | checklist | 94.8% | 2.7% | 0.0% | 1.3% | 1.3% / 100% | 100% |
| sol | fewshot | 94.8% | 4.7% | 1.9% | 0.6% | 2.0% / 0% | 96.1% |
| sol | checklist-sized | 96.1% | 1.3% | 0.0% | 1.3% | 0.0% / 100% | 100% |

**선택**
- 세 변형 모두 자격 조건을 만족했다.
- opus 정확도는 checklist가 95.5%로 가장 높았다. checklist-sized는 94.8%로 한 항목(1/77) 이내라 비겼고, false split이 checklist 2.0% < 2.7%여서 **checklist**가 선택됐다.
- 제품 지시문은 바꾸지 않는다.

**종류별 분할률**(none은 낮을수록 좋다, opus checklist)
- none/one-module 0%
- none/several-modules 4.3%
- none/small 1.9%
- uncertain 10개는 checklist와 checklist-sized에서 두 모델 모두 0%였다. fewshot에서는 10%로, verification을 붙였다.

**틀린 사례의 원인**(opus checklist, 7회)

1. **놓친 verification 4회**(2항목 × 2회): 라벨 규칙이 "위험 영역 + 뒤에 문제 보고"로 붙인 2건이다.
   - 하나는 데이터 소실 방지 안정성 테스트, 다른 하나는 정책 계약을 바꾸는 큰 결합 변경이다.
   - 모델은 둘 다 "독립 검증 요청이 없고, 직접 쓰는 테스트와 프로젝트 검사로 확인할 수 있다"고 답했다. 이는 지시문 기준(명시적 요청, 또는 테스트로 확인할 수 없는 비가역 위험)과 맞는다.
   - 뒤에 문제가 보고됐다고 해서 독립 검증이 필요했다는 뜻은 아니다. **라벨 규칙의 약점**으로 본다.
2. **불필요 isolation 2회**: 게임 현지화와 영어 홍보 영상을 함께 만드는 요청이다.
   - 모델은 영상 제작을 video specialist로 떼어 냈다. 원래 세션은 스크립트로 영상을 만들어 이미지·영상 도구 호출이 기록에 없었고, 그래서 라벨이 none이 됐다.
   - 모델의 판단이 기준에 더 가깝다. **라벨 규칙의 약점**이다.
3. **불필요 verification 1회**: 이동식 디스크를 초기화하는 작은 작업이다.
   - 모델은 장치를 잘못 고르면 되돌릴 수 없고 테스트도 없다며 verifier를 붙였다. 기준의 "비가역 + 테스트로 확인 불가"에 해당한다.
   - 라벨은 뒤에 문제가 없었다는 이유로 none이었다. 이것도 **라벨 규칙의 약점**에 가깝다.
4. fewshot에만 있는 오답: 작은 작업이나 한 모듈 작업을 parallelism으로 나눈 경우가 opus 5회, sol 3회 있었다. 예시를 보여 주면 나누는 쪽으로 기우는 경향은 v1, v2와 같다.

**v1/v2와의 비교**
- 같은 checklist의 false split은 v1(합성, 1턴) 0%, v2(작업량 라벨, fixture는 저장소를 읽은 뒤 판단) 12.1%, 실세션 2.0%다.
- v2의 false split은 대부분 저장소를 읽은 뒤 p1–p3를 나눈 것이었다. 실세션에서 불필요한 parallelism은 checklist에서 두 모델 모두 0%다. 실제 요청에는 "독립적인 큰 부분 여러 개"처럼 보이는 경우가 드물어서, 나눌 유혹 자체가 적었다.
- **한계**
  - 이 세트에는 parallelism 라벨이 없다. 남은 623건에서도 0건이었다. 그래서 놓친 병렬은 재지 못했다.
  - verification 라벨 2건은 위 원인 분석대로 근거가 약하다.
  - 결과는 "실제 요청에서 checklist가 쓸데없이 나누지 않는다(2.0%, parallelism 0%)"는 쪽으로만 읽어야 한다.
- 라벨 규칙은 다음처럼 고칠 것을 제안한다(다음 사전 등록에서).
  - 비가역 위험은 "뒤에 문제가 있었는가"보다 "작업이 되돌릴 수 없는 조작을 했는가"(장치 초기화, 데이터 삭제, 배포)로 정한다.
  - 영상·이미지 산출물은 도구 호출이 아니라 산출물 파일 확장자로 isolation을 판정한다.

**R21**: 10.5대로 실행하지 않았다(parallelism 라벨 0건, 당시 저장소 재현 근거 없음).

## 11. 실사용 분할 판단 관찰 (split log)

- **기록**: orche_task assignment가 끝날 때마다(성공·실패·취소) records 루트(기본 `~/.pi/agent/orche/records`)의 `split-log.jsonl`에 한 줄을 남긴다(`src/orchestrator/split-log.ts`, 호출 위치는 `src/extension/workers.ts`의 `finishRecord`).
  - 남기는 항목: 시각, 역할, orchestrator 여부, 판단(`split`/`none`, 사유 유형, 보고 여부), sub-worker 수, 요청 수(자기 것과 sub-worker 것), 시간, provider가 보고한 비용, 상태, 모델과 그 출처(`modelSource`), sub-worker 모델과 출처(`workerModels`, §12), record 경로.
  - 요청 원문과 요약은 넣지 않는다.
  - records가 켜져 있으면(기본) 자동으로 쌓인다.
  - records 정리(30일)는 run 디렉터리만 지우므로 이 파일은 남는다.
- **상한**: 파일이 2MB를 넘으면 `split-log.1.jsonl`로 한 번 돌리고(이전 것은 덮어씀) 새 파일을 시작한다. 읽을 때는 두 파일을 합친다. 대략 assignment 2만 건 분량이다.
- **보기**: `/orche splits [일수]`는 전체 세션을 대상으로 다음을 보여 준다.
  - 분할률(orchestrator assignment 중 split 비율)
  - 판단을 보고하지 않은 수
  - 사유 분포
  - split과 none 각각의 건수, 성공 수, 시간·비용 중앙값, 비용 합계, 평균 sub-worker 수
- **재평가에 쓸 때**: 한 줄의 `record` 경로로 run.json(인계문, `outcome.split`, `spawned`)과 transcript를 찾을 수 있다. 다만 그것들은 30일 뒤 사라진다. 오래 볼 사례는 그 전에 보관한다.

## 12. 모델 계층 (`models`: main / orchestrator / worker / advisor)

세 계층의 모델을 따로 정할 수 있다. 설정하지 않은 계층은 예전처럼 위 계층을 상속한다. 그래서 `models`가 없는 설정은 예전과 똑같이 동작한다.

```json
"models": {
  "main": { "model": "provider/model-a", "thinking": "high" },
  "orchestrator": { "model": "provider/model-b", "thinking": "high", "extendedContext": true },
  "worker": { "model": "provider/model-c", "thinking": "medium" }
}
```

- **키 위치와 근거**: 최상위 `models`.
  - 계층은 역할(role)이 아니다. 그래서 `routes`(역할 이름 → route) 안에 넣지 않았다. `routes`에 넣으면 `main` 같은 이름이 역할 route와 섞이고, fallback route(`analyst`, `implementer` 등)와도 헷갈린다.
  - 각 값은 route와 같은 모양(`model`, `thinking?`, `extendedContext?`)이고 같은 검증(`parseSettings`)을 거친다. 모르는 계층, 모르는 필드, `provider/` 없는 모델, 모르는 thinking은 설정 오류다(`src/orchestration/routing.ts`의 `parseModelTiers`).
- **main 상속을 명시하는 값 `{ "model": "main" }`**(`INHERIT_MAIN`, `parseTier`):
  - `orchestrator`, `worker`, `advisor`(13절)에 쓸 수 있다. 그 계층은 hand-off 때 main의 **현재** 모델과 thinking을 쓴다. 예전의 상속과 같다.
  - `{ "model": "main", "thinking": "medium" }`처럼 쓰면 모델은 main을 따르고 thinking만 따로 정한다.
  - `worker`에 쓰면 orchestrator가 아니라 main을 상속한다. 예를 들어 orchestrator가 `provider/model-b`이고 worker가 `"main"`이면 sub-worker는 main 모델로 돈다. worker를 생략하면 지금처럼 orchestrator를 상속한다.

    ```json
    "models": {
      "orchestrator": { "model": "provider/model-b", "thinking": "high" },
      "worker": { "model": "main" }
    }
    ```

  - 문법 근거: route의 `model` 자리에 예약 별칭을 두었다. 값 모양이 route와 같아서 검증 경로가 하나로 유지되고, thinking만 지정하는 조합이 자연스럽게 된다. 실제 모델 id는 언제나 `provider/id` 형태이므로 `main`(슬래시 없음)과 헷갈리지 않는다. 이 값은 예전에는 설정 오류(`expected provider/modelId`)였으므로, 예전에 유효하던 설정의 뜻이 바뀌지 않는다. 문자열 단축형(`"orchestrator": "main"`)은 두 번째 값 모양을 만들고 thinking을 담을 수 없어서 받지 않는다. 대신 오류 메시지가 `{ "model": "main" }`을 알려 준다.
  - 설정 오류(기존 검증과 같은 `RouteConfigError`. 세션 시작 때 경고로 보이고 orche_task는 그 오류로 실패한다):
    - `models.main`의 `"main"`: main은 Pi 세션 자신의 모델이라 상속할 대상이 없다. 경고만 내고 무시하는 대신 오류로 한 이유는 두 가지다. `models` 안의 잘못된 값은 모두 오류로 다루고, 이 값은 예전에도 오류였다.
    - `"main"`과 `extendedContext`를 함께 쓴 경우: main 모델은 상속될 때처럼 main의 context window를 그대로 쓴다.
    - `routes`나 `default`의 `"main"`.
- **thinking만 main에서 상속하는 값 `"thinking": "main"`**(`tierThinking`, `inheritsMainThinking`):
  - `orchestrator`, `worker`, `advisor`에 쓸 수 있다. 예: `{ "model": "cliproxyapi/gpt-6.1-sol", "thinking": "main" }`. 모델은 지정한 값을 쓰고, thinking은 그 hand-off(orchestrator)나 spawn(worker) 시점의 main **현재** thinking(`pi.getThinkingLevel()`)을 쓴다. 사용자가 main에서 `/thinking`이나 순환 키로 바꾸면 다음 hand-off부터 반영된다.
  - `worker`에 쓰면 orchestrator의 thinking이 아니라 main의 thinking이다. orchestrator가 자기 thinking을 지정했거나 orchestrator 모델이 main의 단계를 낮춰(clamp) 쓰는 경우에 둘이 달라진다.
  - 모델이 그 단계를 지원하지 않으면 Pi의 clamp를 따른다(`clampThinkingLevel`: 가장 가까운 지원 단계, 추론 미지원 모델은 `off`). 기록되는 `thinking`은 실제로 쓴 단계다. orchestrator는 세션의 `thinkingLevel`, sub-worker는 이번에 세션 생성 뒤 `thinkingLevel`을 읽도록 고쳤다(`src/specialists/session.ts`). 전에는 sub-worker가 요청한 단계를 기록했다.
  - `{ "model": "main", "thinking": "main" }`은 `{ "model": "main" }`과 같다. 파싱할 때 `{ "model": "main" }`으로 읽는다.
  - 문법 근거: `model: "main"`과 같은 방식으로, 상속할 값의 자리에 같은 예약값 `"main"`을 둔다. 필드마다 같은 규칙("그 필드에 main이라고 쓰면 main의 현재 값")이라 새 키(`inheritThinking` 같은 것)나 두 번째 값 모양이 필요 없다. thinking 단계 이름에 `main`이 없고 예전에는 설정 오류였으므로, 예전에 유효하던 설정의 뜻이 바뀌지 않는다. 다른 필드(`extendedContext`)에는 상속 예약값을 두지 않는다.
  - thinking을 생략한 기존 의미는 그대로다. orchestrator는 자기 모델이어도 생략하면 main의 현재 thinking을 쓴다(b42684a부터). 그래서 orchestrator에서 `"thinking": "main"`은 동작이 생략과 같고, 출처만 `config:main`(명시)과 `main`(생략)으로 다르게 기록된다. worker는 생략하면 orchestrator의 thinking을 따른다.
  - 설정 오류: `routes`, `default`, `models.main`의 `"thinking": "main"`(상속할 main이 없거나 main 자신이다).

- **해석 규칙**:

  | 계층 | 모델을 지정했을 때 | `{ "model": "main" }` | `"thinking": "main"` | 지정하지 않았을 때 | 해석할 수 없을 때 |
  |---|---|---|---|---|---|
  | main (Pi 세션) | 새 세션 시작 때 적용(아래) | 설정 오류 | 설정 오류 | Pi 모델(settings.json 기본값, `/model`) | 경고(`ctx.ui.notify`) 후 세션 모델 유지 |
  | orchestrator (표준 역할 explore/answer/implement/verify) | 그 모델. thinking이 없으면 main의 현재 thinking, extendedContext가 없으면 최상위 값 | main의 현재 모델. thinking은 지정값, 없으면 main의 현재 thinking. context window는 main 것 | main의 현재 thinking(모델에 맞게 clamp) | main의 현재 모델·thinking 상속(예전과 같음) | 결과 첫 줄 바로 아래와 run.json에 경고 후 main 상속(`"main"`이면 지정하지 않았을 때와 같은 경고와 route) |
  | worker (orche_spawn sub-worker, 독립 verifier 포함) | 그 모델. thinking이 없으면 orchestrator의 thinking | orchestrator가 아니라 main의 현재 모델. thinking은 지정값, 없으면 main의 현재 thinking. context window는 main 것 | orchestrator가 아니라 main의 현재 thinking(모델에 맞게 clamp) | orchestrator의 실제 모델·thinking 상속(예전과 같음) | 경고 후 orchestrator의 모델·thinking 상속(`"main"`이면 main 모델을 해석할 수 없을 때) |
  | advisor (`single.advisor`가 켜졌을 때만, 13절) | worker 행과 같다 | worker 행과 같다 | worker 행과 같다 | orchestrator(조언받는 worker)의 실제 모델·thinking(그 assignment의 baseline) | 결과와 run.json에 `models.advisor … inherits the orchestrator's model instead` 경고 후 orchestrator 상속 |
  | game-asset, video | 영향 없음 | 영향 없음 | 영향 없음 | 자기 route | (예전과 같음) |

- **main 적용**(`src/extension/main-model.ts`):
  - Pi 확장 API `pi.setModel(model)`과 `pi.setThinkingLevel(level)`을 쓴다. Pi 문서 `docs/extensions.md`의 "Change active tools, model, or thinking level: Session control methods on `pi`"와 `core/extensions/types.d.ts`의 선언을 따랐다. `setModel`은 현재 세션에만 적용되고 settings.json 기본값은 바꾸지 않으며, 자격 증명이 없으면 false를 돌려준다. 모델은 `ctx.modelRegistry.find`로 찾는다. Pi의 `examples/extensions/preset.ts`도 같은 방식이다.
  - 적용 시점: `session_start`의 reason이 `startup`(Pi 시작)이나 `new`(`/new`)이고, 세션에 메시지가 없고, Pi가 처음 남기는 모델·thinking 항목 말고 다른 변경이 없을 때만 적용한다. `/new`일 때는 Pi도 기본 모델로 다시 시작하므로 같은 규칙을 따른다.
  - 적용하지 않는 경우: resume·fork·reload한 세션은 자기 모델을 유지한다. 명령줄에 `--model`, `--models`, `--provider`, `--thinking`이 있으면 그 선택이 이긴다. 세션 중에 사용자가 `/model`이나 순환 키로 바꾼 모델은 다시 덮어쓰지 않는다. 적용은 시작 때 한 번뿐이다.
  - `extendedContext`를 켜면 worker와 같은 표(`src/pi/extended-context.ts`)로 창을 넓힌 모델을 넘긴다.
  - direct 모드에서는 main 설정만 의미가 있다.
- **가시성**:
  - `/orche models`가 세 계층의 모델과 출처를 보여 준다. 출처는 config, inherited, Pi 가운데 하나다. `"main"`은 `main's model and thinking (지금 main 모델) — config models.orchestrator "main"`처럼 보인다. `"thinking": "main"`은 `provider/model-b with main's thinking (high) — config models.orchestrator (thinking "main")`처럼 지금 main의 단계와 함께 보인다. 그 아래 `main's thinking (high) reaches at each hand-off: orchestrator, worker` 줄이 main의 지금 thinking이 닿는 계층을 보여 준다(worker가 orchestrator를 거쳐 받으면 `worker (through the orchestrator)`, 아무 계층에도 닿지 않으면 `no tier`).
  - main의 인계 규칙 문장은 orchestrator가 실제로 상속하는 것에만 "main's CURRENT"를 쓴다(`src/extension/mode.ts`의 `modelSentence`). 지정하지 않았거나 `"main"`(단계 없음)이면 예전 문장 그대로 "inherit main's CURRENT model and thinking"이다. `"main"`에 단계를 주면 "main's CURRENT model ... with the thinking level configured"이다. 0407075에서는 이 경우에도 "model and thinking" 문장이 나와 부정확했는데 이번에 바로잡았다. 자기 모델이면 단계가 없거나 `"main"`일 때 "... not on main's model, with main's CURRENT thinking at hand-off", 단계를 주면 "orchestrator model and thinking level configured ..., not on main's"이다.
  - orchestrator와 sub-worker에게 주는 지시문에는 모델 상속을 말하는 문장이 없다. specialist가 자기 모델을 쓴다는 문장만 있어서 고칠 것이 없었다. 분할 판단 지시문의 비용 문장("약 두 배 비용")은 같은 모델 sub-worker로 잰 값이다. 평가로 고른 문장이라 그대로 두었다. `models.worker`로 더 싼 모델을 쓰면 실제 비용 비율은 달라진다(측정하지 않음).
- **기록**:
  - assignment의 모델과 `modelSource`는 `details`, run.json의 `assignment`·`outcome`, split log에 남는다. 값은 `config`(지정한 모델), `config:main`(`{ "model": "main" }`으로 명시한 main 모델), `main`(지정하지 않아 상속), `route` 가운데 하나다.
  - sub-worker의 모델과 `modelSource`는 `details.spawned`, run.json의 agent 항목, split log의 `workerModels`에 남는다. 값은 `config`, `config:main`, `orchestrator`(지정하지 않아 상속), `route`(specialist) 가운데 하나다.
  - thinking도 같은 자리에 `thinking`(Pi가 clamp한 뒤 실제로 쓴 단계)과 `thinkingSource`로 남는다. split log는 assignment의 `thinking`·`thinkingSource`와 `workerModels` 항목마다 `thinking`·`thinkingSource`를 더 적는다. 값은 `modelSource`와 같은 이름이다: `config`(계층에 지정한 단계), `config:main`(`"thinking": "main"`이나 단계 없는 `{ "model": "main" }`으로 명시한 main의 현재 thinking), `main`(assignment: 단계를 지정하지 않아 main에서 상속), `orchestrator`(sub-worker: 단계를 지정하지 않아 orchestrator에서 상속), `route`.
- **테스트**: `test/extension/model-tiers.test.ts`(faux provider만 사용). 다룬 경우는 다음과 같다.
  - 설정 없음(회귀), orchestrator만, worker만, 셋 다(확장을 거친 end-to-end), 해석 불가, specialist, main 적용과 사용자 선택 존중, 기록.
  - `"main"`: orchestrator `"main"`(지정하지 않았을 때와 같은 모델·thinking, 다음 hand-off에서 main의 현재 모델을 따름), 다른 orchestrator 모델 옆의 worker `"main"`(확장을 거친 end-to-end 포함), thinking만 지정, main 모델을 해석할 수 없을 때, `models.main`·문자열·extendedContext·routes의 설정 오류, `/orche models`와 main 지시문.
  - `"thinking": "main"`: 다른 모델 orchestrator에서 main thinking을 바꾼 뒤 다음 hand-off 반영(run.json·split log 포함), worker는 orchestrator가 아니라 main의 thinking, `{ "model": "main", "thinking": "main" }` = `{ "model": "main" }`(파싱과 실행 결과), clamp(추론 미지원 모델 `off`, `xhigh` → `high`, orchestrator가 clamp돼도 worker는 main 단계), routes·default·models.main 설정 오류, 생략 시 기존 의미(회귀), `/orche models`, main 지시문, 확장을 거친 end-to-end(세션 중 `setThinkingLevel` 뒤 다음 hand-off와 sub-worker).
- **확인하지 못한 것**: 실제 Pi TUI에서 `/new`·`--model`·순환 키와 함께 쓰는 경우는 faux 세션과 단위 테스트로만 확인했다. 실제 provider 확장(cliproxyapi)이 `session_start` 전에 모델을 등록하는지는 Pi 문서("asynchronous factory ... register providers needed during startup")에 기댄 것이다.

## 13. 계획 advisor (`single.advisor`, 기본 off)

직전 실측(`docs/advisor-reviewer-bench.md`: 10과제×2회, baseline 9/20, advisor 12/20, reviewer 10/20, advisor 비용 +30%·wall time +9%, 통계적으로 유의하지 않음)에서 쓴 "계획 단계에서 한 번, 읽기 전용 advisor가 조언하고 실행 중인 worker에 주입" 방식을 제품의 일반 worker 실행 경로에 넣었다. 벤치 harness를 연결한 것이 아니라 `WorkerPool.executeAssignment` 안에서 기존 부품(one-shot 세션 `runSpecialistSession`, `orche_task_message`와 같은 주입 경로 `AgentManager.steer`, 모델 계층 해석, run record)으로 다시 구현했다(`src/single/advisor.ts`).

- **켜기/끄기**: `orche.config.json`의 `"single": { "advisor": true }`. 기본값은 `false`이고, 키가 없는 예전 설정 파일도 off로 읽는다. `ledger`·`spawn`과 같은 boolean 스위치이고 같은 방식으로 검증한다(`config.single.advisor: expected boolean`). 설정 파일은 orche_task 호출마다 다시 읽으므로 다음 호출부터 바로 적용된다. `/orche models`가 `- advisor (single.advisor on|off …)` 줄로 지금 상태와 모델을 보여 준다.
- **모델·effort**: `models.advisor` 계층. 다른 계층과 같은 모양(`model`, `thinking?`, `extendedContext?`)과 같은 예약값(`{ "model": "main" }`, `"thinking": "main"`)을 쓰고, 해석 규칙은 `models.worker`와 같다(12절 표). 지정하지 않으면 조언받는 worker의 실제 모델과 thinking(assignment baseline)을 쓴다. 해석할 수 없는 모델은 경고 후 worker 모델로 대체한다. effort는 Pi의 clamp를 따르고, 실제로 쓴 단계가 기록된다. 특정 모델을 코드에 넣지 않았다.

  ```json
  {
    "single": { "advisor": true },
    "models": {
      "orchestrator": { "model": "cliproxyapi/claude-opus-5-5", "thinking": "high" },
      "advisor": { "model": "cliproxyapi/gpt-6.1-sol", "thinking": "high" }
    }
  }
  ```

- **적용 범위**: single workflow에서 `orche_task`로 실행하는 표준 worker 역할 전부, 곧 `explore`, `answer`, `implement`, `verify`. specialist(game-asset/video), direct 모드, 라이브러리 호출(`mainMode` 없음), orche_spawn sub-worker에는 붙지 않는다. 읽기 전용 역할(explore/answer/verify)이면 advisor 프롬프트에 "이 worker는 읽기 전용이다. 조사·근거·검사만 조언하고 수정은 제안하지 마라"는 문장이 들어간다. 그 worker의 권한은 그대로다. 조언이 수정을 권해도 쓰기 도구는 역할 guard가 막는다(`Blocked: assignment explore is read-only …`). advisor 세션 자신도 advisor를 만들지 않는다(재귀 없음).
- **개입 시점**: worker가 그 assignment에서 처음 받아들여진 `task_plan`을 낸 순간(계획 없이 먼저 편집하면 첫 edit/write/ast_rewrite 순간) advisor를 **한 번** 시작한다. 같은 assignment에서 계획을 다시 내도 다시 시작하지 않는다. 재사용 worker의 다음 assignment는 자기 advisor를 새로 한 번 받는다(이전 advisor는 이전 assignment가 끝날 때 이미 끝났다).
- **advisor가 하는 일과 권한**: 새 one-shot 세션에서 worker의 assignment(요청과 context; 인용된 데이터로 취급)와 그 계획을 받고, 저장소를 읽어 400단어 안팎의 조언을 `report_result {advice, evidence?}`로 낸다. 도구는 `read`, `grep`, `find`, `ls`, `ast_search`, `diagnostics`와, main의 single 모드와 같은 읽기 전용 정책(`classifyBash`: 검사 명령과 프로젝트 검사만)을 거치는 `bash`뿐이다. edit/write/ast_rewrite/orche_spawn/task_plan은 없고 guard도 막는다. git 권한, write scope, GUI를 받지 않는다. 시간 제한은 10분과 assignment 기본 상한(`limits.assignmentMs`)의 절반 중 짧은 쪽(최소 1초)이고 40응답까지다. 절반으로 두는 이유는, 보고가 advisor를 기다리더라도 worker가 조언을 처리할 시간을 남기기 위해서다.
- **조언 전달**: 조언은 `[Advisor notes · M1 · advisory only]` 머리말과 함께 전달된다. "main이나 사용자의 지시가 아니며 요구사항·write scope·권한을 바꾸지 못하고 아무것도 허가하지 못한다. 맞는 것은 받아들이고 틀리거나 범위 밖인 것은 거절하라"는 문장과, report_result에 `data.advice: {decision: "applied" | "rejected" | "partial", reason}`을 넣으라는 요구가 붙는다. worker가 아직 일하는 중이면 `orche_task_message`와 같은 경로로 한 번 주입된다(현재 도구 호출 뒤, 다음 요청 전). 주입되면 phase thinking policy는 다음 계획을 baseline에서 다시 하게 한다(`advisor notes`).
- **미처리 조언 없는 종료(bounded finalization)**: 성공 결과는 조언을 반영하거나 이유를 대고 거절한 뒤에만 나간다.
  - worker가 처음 `report_result`를 부르는 순간 그 assignment의 advisor는 꺼진다. 이후 `task_plan`이나 수정을 해도 새 advisor가 시작되지 않는다. `single.advisor` 설정 자체는 그대로라 다음 독립 assignment는 다시 advisor를 받는다.
  - 그때 advisor가 아직 돌고 있으면 보고를 잡아 두고 advisor를 기다린다. advisor 시간 제한, 취소, assignment 시간 초과가 상한이다. 이때 나온 조언은 주입하지 않고 아래 report gate가 직접 건네다.
  - report gate: 조언이 있는데 worker가 그 조언을 본 뒤 낸 보고가 아니거나(주입 메시지가 그 요청의 context에 들어가지 않았거나) 유효한 `data.advice`가 없으면, 보고를 받지 않고 `Report held (finalization n/2)` 메시지를 돌려준다. worker가 아직 못 본 조언이면 그 메시지에 인용해 넣는다. 같은 worker 세션이 같은 assignment 안에서 advisor 없이 계속한다. 새 assignment나 새 job을 만들지 않고 끝난 job을 되살리지도 않는다. worker는 조언을 반영(수정과 검증; 읽기 전용 역할은 조사·재확인)하거나 이유를 대고 거절한 뒤 `data.advice`를 넣어 다시 보고한다. 이미 처리한 조언이면 다시 수정하지 말고 처리 내용만 적어 보고하라고 안내한다.
  - 작업 중에 조언을 받아 첫 보고에 이미 `data.advice`를 넣었으면 바로 받아들인다(추가 라운드 없음).
  - 상한: 보고를 잡아 두는 횟수는 최대 2번이다(`ADVICE_FINALIZE_PROMPTS`). 그 뒤에도 `data.advice`가 없으면 조언은 `unprocessed`가 되고 assignment는 `advice_unprocessed`로 실패한다. 실패 메시지에는 worker의 보고 요약과 조언이 담기고, 성공으로 돌려주지 않는다. assignment 시간 제한과 요청 예산, 기존 report 재시도 상한도 그대로 적용된다. advisor는 assignment당 한 번만 돌고 자동 재귀나 무한 루프는 없다.
  - 최종 결과는 gate를 통과한 마지막 보고 하나뿐이다. 잡혀 있던 보고는 main에 보내지 않으며, attach/detach와 무관하게 기존 job 경로로 정확히 한 번 전달된다.
  - 계획이나 편집 전에 보고했다: advisor를 시작하지 않는다(`skipped`). 요청도 비용도 없다. Task DAG 없이 끝나는 아주 짧은 assignment(읽기 전용 역할의 즉답 포함)가 여기에 해당하고, 의도한 정책이다.
- **실패·취소·정리**: advisor 오류, 시간 초과, 보고 없음은 `failed`다. 처리할 조언이 없으므로 잡혀 있던 보고는 그대로 통과하고 worker는 실패하지 않는다(`Advisor: failed (…); no advice to process, W1 worked without it.`). worker가 실패·시간 초과·취소로 결과 없이 끝나면 advisor를 즉시 멈춘다. 이때 조언이 아직 없었으면 `cancelled`, 조언이 있었는데 처리되지 않았으면 `unprocessed`로 표시하고 실패 결과에 조언을 담는다. 처리했다고 꾸미지 않는다. assignment 시간 초과는 잡혀 있던 보고의 advisor 대기도 푼다. pool 종료(reload, exit, 세션 전환)도 진행 중인 advisor를 멈춘다. advisor 세션은 항상 dispose되고 assignment보다 오래 살지 않는다.
- **기록·표시**: 진행 줄에 `advisor reviewing the plan`, `advisor notes sent`, `report held: waiting for the advisor`, `finalizing: processing advisor notes (n/2)`, `advisor notes applied|rejected|partial`가 붙는다. 결과에는 `Advisor:` 줄이 남는다. 작업 중 처리했으면 `notes M1 reached W1 while it worked; W1 applied them: …`, 보고 때 처리했으면 `notes were handed to W1 at its report, which was held until it processed them (n finalization prompts; …)`다. `details.advisor`에는 `status`(skipped/processed/unprocessed/failed/cancelled), `handling {decision, reason, phase: during_work|finalization}`, `finalizationPrompts`, `unprocessed`, trigger, model, thinking, `modelSource`·`thinkingSource`(`config`, `config:main`, `orchestrator`), requests, 시간, 비용, message id, advice, error가 담긴다. `details.injected`의 해당 메시지는 `source: "advisor"`로 표시되고 main의 메시지 줄에는 섞이지 않는다. run.json에는 `assignment.advisor`(해석된 모델), `advisor`(결과), `agents`의 `W1.advisor`(kind `advisor`, transcript 경로)가 남는다. `events.jsonl`에는 `advisor` 이벤트(started, report_held, finalization_prompt, handled, 최종 상태)가 남는다.
- **비용**: off면 추가 요청·지연이 없다. on이면 계획을 세운 표준 assignment마다 advisor 세션 하나(실측 평균 약 11요청)가 더 들고, 실측에서는 비용 +30%, 평균 wall time +9%였다. worker가 advisor보다 먼저 끝나면 advisor를 기다리는 시간과 조언 처리 라운드(최대 2번)만큼 결과가 늦어지고 요청이 늘어난다.
- **테스트**: `test/extension/advisor.test.ts`(faux provider)가 다루는 범위는 다음과 같다.
  - 설정과 표시, 읽기 전용 guard, off일 때 무호출, specialist·direct 비적용.
  - explore/answer/verify: 수정 없이 여러 경로에서 처리되고 권한이 확대되지 않는지, 계획 없는 즉답이 skipped인지.
  - 작업 중 주입과 첫 보고에서의 처리(기록 포함).
  - worker 선보고: 보고를 잡아 둔 뒤 반영하는 경우, 명시적으로 거절하는 경우. advisor 재시작이 없고 진행 표시가 나오는지.
  - 이미 처리했지만 `data.advice`를 빠뜨린 보고: 조언 재첨부 없이 한 번만 잡아 둔다.
  - 보고 요청 중에 주입되는 경합.
  - 상한 초과로 `advice_unprocessed` 실패.
  - `models.advisor` 지정·상속·`thinking: "main"`·해석 불가, 계획 전 보고, 첫 편집 시작.
  - advisor 실패와 advisor 시간 초과가 잡힌 보고를 풀어 주는지.
  - 잡힌 보고 중 취소와 다음 독립 assignment에서 advisor 재허용, worker 시간 초과 시 unprocessed, pool 종료.
  - orche_spawn sub-worker 비적용, advisor의 쓰기 시도 차단, 확장을 거친 detach 최종 결과 정확히 한 번(잡힌 초안 보고는 전달되지 않음).
- **확인하지 못한 것**: 제품 경로로 실제 모델(cliproxyapi)에서 다시 측정하지 않았다. 벤치는 늦은 조언을 같은 worker의 후속 assignment로 줬다. 제품은 같은 assignment 안에서 보고를 잡아 두고 처리하게 하므로 동작은 비슷하지만 측정된 방식과 같지는 않다.

## 14. strong · ultra 모드

### 14.1 모드와 모델 계층

| 모드 | orchestrator 모델 | sub-worker 모델 | 흐름 |
|---|---|---|---|
| `single` (기본) | `models.orchestrator` → 미설정·해석 불가 시 main | `models.worker` → 미설정 시 orchestrator 상속 | single workflow (§1~13) |
| `strong` | `models.strong-orchestrator` → 미설정·해석 불가 시 `models.orchestrator` → main | `models.strong-worker` → 미설정·해석 불가 시 실제 strong orchestrator 상속 (`models.worker`는 쓰지 않음) | single과 동일 (hand-off, prompt, 도구, 계획, 검증, 권한) |
| `ultra` | strong과 같음 | strong과 같음 | 아래 ultra 단계 계약 |
| `direct` | 해당 없음 | 해당 없음 | main이 직접 편집 |

상속되는 필드: 상속 시 `model`과 `thinking`(계층에 thinking이 없으면 상위의 현재 수준, `"main"`이면 main의 현재 수준), main 모델을 상속할 때의 context window. `extendedContext`는 계층마다 자기 값(없으면 `config.extendedContext`)을 쓴다. phase thinking policy에서 상속한 sub-worker의 한 단계 낮춤, specialist(game-asset/video)의 route, `models.advisor`(미설정 시 그 모드의 orchestrator 상속) 규칙은 single과 같다. `strongOrchestrator`/`strongWorker` camelCase도 받지만 두 표기를 함께 쓰면 config 오류다.

```json
{
  "mainMode": "strong",
  "models": {
    "orchestrator": { "model": "provider/general-model", "thinking": "high" },
    "worker": { "model": "provider/general-worker" },
    "strong-orchestrator": { "model": "provider/strongest-model", "thinking": "max" },
    "strong-worker": { "model": "provider/strong-worker-model", "thinking": "high" }
  }
}
```

`strong-worker`를 빼면 strong/ultra의 sub-worker는 `strongest-model`을 상속한다. 결과에는 `Mode: strong (orchestrator: models.strong-orchestrator; sub-workers: ...)` 줄, `details.mode`/`details.modelTier`, run.json `assignment.mode`/`assignment.tier`가 남는다. 같은 worker를 single↔strong 사이에 재사용하면 모델이 바뀌고 결과에 `Note: W1 switched from single to strong mode ...`가 붙는다. ultra 경계를 넘으면(도구 집합이 세션 생성 때 고정되므로) 기존 worker를 은퇴시키고 새 worker가 그 transcript로 handover를 받는다.

### 14.2 ultra 단계 계약

1. 요구사항·합격 기준: Task DAG와 `data.ultra.criteria`.
2. exploration (`orche_spawn reason "exploration"`, 2~4명, 최대 2라운드, 첫 후보 이전): 검증 기준 작성자(role implement, 소유 파일에 테스트/검사만)와 가설 분석가(role answer). 검증 기준 작성자가 바꾼 파일은 **보호된 검증 기준**이 된다.
3. candidates (`reason "candidates"`, 2~4명, 최대 2라운드, 요청은 서로 달라야 함): implement 후보는 각자 git 스냅샷으로 만든 **격리된 작업 사본**에서만 쓴다(같은 파일 소유 허용, 서로의 작업을 볼 수 없음). 2라운드는 `from`으로 이전 후보에서 시작하는 수정 후보(이전 후보는 incumbent로 보존). 사본 구성은 14.3.
4. 평가: orchestrator가 각 사본에서 같은 검사를 직접, 한 응답에 한 호출씩 실행(`cd '<workspace>' && <checks>`). 검사의 유효성은 14.4의 fingerprint로 판정한다. **끝난(done) 후보는 모두 평가한다**: 선택되지 않은 후보도 `data.ultra.candidates` 항목에 그 사본에서 실행한 검사 ref를 인용해야 하며, 그 검사는 보고 시점의 사본(파일과 의존성 디렉터리)을 전후로 본 것이어야 한다. 통과든 실패든 근거가 된다(모든 후보가 통과할 필요는 없다). `failed` 판정에는 실패한 검사가 필요하고 `rejected`는 비교에서 진 것이다. 평가 후 사본이 바뀌면 stale로 거부된다. 검사 없이 빠질 수 있는 것은 런타임이 기록한 사실이 있는 후보뿐이다: done이 아님(blocked/failed/cancelled 등), 격리 위반 라운드, 보호 기준 변경, 바꾼 파일 없음. 이유 문자열만으로 done 후보를 빼지 못한다.
5. 선택·채택: `orche_adopt {candidate}`. 성공한 검사 중 그 사본의 **현재 내용과 같은 내용**을 검사 전후 모두 본 것이 없거나(검사 뒤 셸·다른 프로세스로 바뀐 경우 포함), 보호 기준을 바꾼 후보이거나, 그 라운드에 격리 위반이 감지됐거나, 후보의 base 이후 작업공간의 같은 경로가 바뀌었으면 거부한다(blind merge 없음). 변경 목록과 보호 기준 침범은 채택 시점에 다시 계산하고, 복사 후 작업공간 내용이 후보와 같은지와 복사 중 후보가 바뀌지 않았는지 확인해 아니면 롤백한다. 채택 전에는 orchestrator가 작업공간을 직접 편집할 수 없다.
6. 반례 검토: `reason "verification"`(기존 2라운드 상한 유지)을 채택 이후에 실행. 발견 사항은 `reproduced-fixed`/`reproduced-open`/`unverified`/`refuted`로 분류.
7. 통합 재검증: 작업공간의 마지막 변경 이후 단독으로 실행해 성공한 검사이며, 그 검사 전후의 작업공간 fingerprint가 보고 시점의 fingerprint와 같아야 한다.

보고서 게이트(`data.ultra`)는 런타임 기록과 대조한다: 단계 실행 여부, 후보 2개 이상, 모든 후보의 판정(후보당 한 항목), 선택되지 않은 끝난 후보마다 현재 사본에 묶인 평가 근거 또는 런타임 제외 사유(4번), 선택 후보의 채택, 선택 근거 = 그 사본에서 orchestrator가 실행해 성공하고 **채택된 내용을 본** bash 호출의 `[orche ref Tn]`, 채택 이후 검증 라운드, 통합 근거 = 보고 시점 작업공간과 같은 내용을 검사 전후에 본 검사 ref(마지막 채택·편집 이후), report_result 단독 실행, `reproduced-open`이면 done 불가, 보호 기준 무결성. 다수결·후보 자기 보고는 근거가 아니다. fingerprint를 얻지 못하면 통과시키지 않고 거부한다. 통과한 완료 보고는 평가 근거(후보별 검사 ref)와 제외 사유를 record의 `gate` 이벤트(`evaluated`/`excluded`)에 남긴다. 후보 사본 경로가 들어간 명령은 그 사본의 검사로 보므로 통합 근거가 될 수 없다(거부 메시지에 명시). 완료하지 못한 단계는 `status:"blocked"` + `data.ultra.stage` + `reason`(answer는 `data.unresolved`)으로 끝낸다. 게이트 거절 횟수는 기존 result 재시도 상한을 따른다.

read-only answer 변형: 모든 sub-worker가 answer/verify, `orche_adopt` 거부, 후보 답변의 주장을 orchestrator가 출처로 직접 확인하고 `data.ultra.claims[{claim,sources,status}]`로 보고(코드 테스트 불필요). `single.spawn: false`는 ultra에 적용되지 않으며 결과에 그 사실이 표시된다.

런타임 강제: 단계 순서·상한·역할, 끝난 후보마다의 평가 근거, 후보 격리(작업 사본, 의존성 디렉터리 사본, 링크 fail-closed 검사, guard, 사본 밖 literal shell 쓰기 차단, 라운드 전후 탈출 감지), 보호 기준(쓰기 거부, 셸 변경 감지), 내용 fingerprint에 묶인 채택 조건과 보고서 게이트. 프롬프트 의존: 검증 기준이 합격 기준을 실제로 담는지, 가설·후보의 의미적 다양성, 성공한 검사가 주장을 실제로 뒷받침하는지(exit 0만 증명하며, 어느 사본을 검사했는지는 명령 문자열의 사본 경로로 판단), 동점 시 선택 기준, 발견 사항 분류의 타당성.

### 14.3 후보 사본과 의존성 디렉터리

- 사본은 작업공간 subtree의 git tree(추적 + 무시되지 않은 미추적, `.orche` 제외)를 사본 전용 index로 checkout한 것이다. 사용자 index의 assume-unchanged/skip-worktree는 private index에서 해제하고, fsmonitor·untracked cache는 끈다.
- git이 무시하는 `node_modules`/`.venv`/`venv`는 후보마다 **별도 사본**으로 만든다(`cp -a --reflink=auto`: CoW 지원 파일시스템은 복제, 아니면 전체 복사). 원본으로의 symlink는 만들지 않는다. 사본 안에서 작업공간(또는 `from`의 이전 사본)을 가리키던 링크는 사본 안으로 다시 연결한다. Python 환경은 작업공간 경로를 담은 파일(shebang, activate, `pyvenv.cfg`, `.pth`, editable finder, `direct_url.json`)을 사본 경로로 고친다. 후보가 의존성을 바꿔도 채택되지 않으므로 통합 때 작업공간에서 설치한다. 채택 결과는 후보(수정 후보면 그 이전 후보까지)가 자기 사본의 의존성에서 바꾼 경로를 알려 준다(`… also changed its private dependency directories …; those changes are NOT adopted`).
- 링크 검사(fail-closed, 후보 실행 전): 사본의 모든 링크를 `realpath`로 끝까지 따라간다(링크 체인 포함). 사본 안이면 허용한다. 사본 밖이면 다음과 같이 처리한다.
  - 이 사용자가 쓸 수 없는 파일, 또는 전체 트리를 걸어 쓰기 가능한 항목과 링크가 하나도 없음을 확인한 디렉터리(최대 20,000개 항목): 읽기 전용 공유로 허용하고 보고한다.
  - 의존성 디렉터리 안에서 쓰기 가능한 파일을 가리키는 링크: 그 파일의 사본으로 바꾼다(`venv --copies`와 같은 방식).
  - 그 외(쓰기 가능하거나 확인할 수 없는 디렉터리, 추적 영역의 링크, 사본 밖 쓰기 가능한 곳에 파일을 만들 dangling 링크): 사본을 거부한다. candidates 호출은 아무 후보도 실행하지 않고 거부되며, 경로와 사유가 결과에 남는다.
- 탈출 감지: candidates 라운드 전후로 작업공간 내용 manifest와 작업공간 자체 의존성 디렉터리의 내용 manifest(14.4)를 비교한다. 바뀌었거나 의존성 디렉터리를 읽지 못해 fingerprint를 얻지 못하면 그 라운드의 후보는 모두 채택할 수 없다(`Isolation breach`, fail-closed).

### 14.4 내용 fingerprint와 검사 유효성

- manifest는 범위 안의 모든 파일(git이 범위를 정함: 추적 또는 무시되지 않은 미추적, `.orche`·의존성 디렉터리 제외)의 **원시 바이트 SHA-256과 권한 비트**, 또는 링크 대상이다. 따라서 index 플래그, clean filter, 줄바꿈 정규화가 바이트 변경을 숨기지 못한다. 해시는 (크기, mtime, ctime, inode, mode)로 캐시하고, 최근 2초 안에 바뀐 파일은 매번 다시 해시한다. 이 manifest가 채택 범위(`changes`, 충돌 검사, 보호 기준)다.
- **의존성 manifest**(검증 상태, 채택 범위 아님): 작업공간과 각 사본의 의존성 디렉터리 내용. 범위: 최상위 `node_modules`/`.venv`/`venv`(추적·무시·링크 모두; 링크된 store는 그 대상을 걷는다)와 git이 추적하지 않는 하위 디렉터리 중 같은 이름의 것(예: `packages/a/node_modules`). 항목: 디렉터리 `d<mode>`, 파일의 원시 바이트 SHA-256과 mode, 링크 대상. 링크는 의존성 디렉터리 안을 가리키지 않는 한 따라가 그 파일·트리 내용까지 넣는다(루트 밖의 `npm link`, 작업공간 안의 무시된 빌드 디렉터리 등). 같은 크기로 바꾸고 mtime을 되돌려도 내용 해시로 잡힌다. **이름에 따른 예외는 없다**: `.cache`/`.vite`/`.vitest`/`__pycache__`/`.pytest_cache` 같은 캐시 디렉터리도 모든 파일이 들어간다. 이름은 무해하다는 증거가 아니고(그 안의 모듈을 require하는 검사도 있다), 런타임은 입력과 산출물을 구별할 수 없으므로 fail-closed로 모두 입력으로 본다. fail-closed: 읽을 수 없는 항목이나 2,000,000개 초과면 fingerprint가 없고, 없는 fingerprint는 "변경 없음"으로 인정되지 않는다.
- **검증 fingerprint** = 범위 manifest digest + 의존성 manifest digest. 작업공간·후보 모두 이것을 쓴다. 따라서 검사 뒤 후보 사본이나 작업공간의 의존성이 바뀌면(설치, 패치, 삭제, 새 파일) 그 검사는 채택·선택·통합·후보 평가 근거가 되지 못하고 다시 검사해야 한다(`its files or its dependency directories (node_modules, .venv, venv) changed during or after them`).
- orchestrator의 모든 허용된 도구 호출은 probe로 추적한다. guard에서 열고(`tool_call`), 호출이 끝나면(`tool_execution_end`, worker가 다음으로 넘어가기 전에 await) 닫는다. bash 호출은 실행 전후에 작업공간과 끝난 모든 후보 사본의 fingerprint를 기록한다.
- 다음 검사는 증거로 인정하지 않는다: 같은 시간에 파일을 바꿀 수 있는 다른 호출과 겹친 검사(Pi는 한 응답의 호출을 병렬 실행), probe가 없거나 실패한 검사, 실행 전후 fingerprint가 다른 검사(예: `tests && printf … > file`).
- report_result의 guard에서 그 호출에 묶인 현재 작업공간과 끝난 모든 후보 사본의 fingerprint를 구한다(후보 평가의 현재 상태). 통합 검사의 fingerprint가 이것과 다르면 거부한다(셸·편집·다른 세션의 변경 모두 포함). 기존 dirty 파일이나 다른 세션의 변경을 되돌려 맞추지 않는다. 다시 검사해야 한다.
- 비용(정확성 우선): 후보가 생긴 뒤에는 bash 호출마다 작업공간과 끝난 모든 사본의 manifest·의존성 manifest 계산(git ls-files 3회 + 모든 항목 stat, 바뀐 파일만 해시)이 전후로 붙는다. 사본의 의존성은 처음 한 번 전부 해시하므로 큰 `node_modules`/`.venv`에서는 첫 검사가 수 초 늦어질 수 있다.

재개: `single.ledger`가 켜져 있고 같은 worker가 같은 task를 이어 받으면(타임아웃·blocked 이후) 후보·사본·채택(채택한 fingerprint 포함)·보호 기준과 라운드 수, **sub-worker 번호의 최고값**이 이어진다. 이어받은 assignment의 sub-worker는 그 다음 번호부터 받으므로(exploration·verification·거부된 spawn 번호 포함) 새 후보가 기존 후보의 id나 사본을 차지하지 않는다. 그래도 이미 있는 id(사본, index, base manifest 중 하나라도 있으면)나 `from`과 같은 id로 사본을 만들려 하면 아무것도 지우지 않고 candidates 호출을 거부한다. evidence ref와 probe는 assignment마다 새로 시작하므로 검사는 다시 실행한다(보존된 incumbent도 새 검사 뒤에 채택·평가된다). 그 외에는 새로 시작한다. 완료(done)된 run은 사본을 삭제해 공간을 돌려준다. blocked·timeout은 이어받기와 확인을 위해 사본을 남긴다. 다음 ultra run이 새로 시작할 때 지운다.

한계(OS sandbox가 아님):
- 후보의 셸은 이 사용자가 쓸 수 있는 어디든 절대 경로로 쓸 수 있다. 그중 작업공간 범위 파일과 작업공간 의존성 디렉터리 쓰기는 라운드 뒤에 감지해 채택을 막는다. 홈·전역 캐시 등 그 밖의 쓰기는 감지하지 못한다.
- 읽기 전용 공유는 OS 권한에 기댄다(root는 모두 쓰기 가능으로 판정되어 fail-closed가 된다).
- **검사가 의존성 디렉터리에 쓰는 경우**(캐시·설치): 그 검사 자체가 전후 fingerprint를 바꾸므로 근거가 되지 못한다. 거부 메시지는 그 검사가 바꾼 의존성 경로(최대 8개)를 이름으로 알려 준다(`The check itself wrote into the dependency directories (T12 changed node_modules/.vite/vitest/…/results.json)`). 회복 방법(운영 방법이지 입력 변경이 안전하다는 증명이 아니다):
  - 캐시 쓰기를 끄거나 의존성 디렉터리 밖으로 옮긴다: Vitest 3는 `vitest run --no-cache`(결과 캐시 `node_modules/.vite/vitest/<hash>/results.json`을 쓰지 않는다; 확인한 버전 3.2.7) 또는 Vite `cacheDir`를 밖으로; Python은 `PYTHONDONTWRITEBYTECODE=1` 또는 `PYTHONPYCACHEPREFIX=<밖의 경로>`; pytest는 `-p no:cacheprovider`; Babel은 `BABEL_DISABLE_CACHE=1`; ESLint는 `--cache-location <밖의 경로>`.
  - 쓰기가 매번 같은 내용이면 한 번 더 실행한다(두 번째 실행은 사본을 그대로 두므로 유효하다). Vitest 결과 캐시처럼 실행 시간을 담아 **매번 내용이 달라지는 쓰기는 재실행으로 해결되지 않는다**.
  - 검사 전에 의존성을 미리 만들어 두는 단계(설치, 빌드)는 검사와 별도 호출로 먼저 실행한다.
- 링크가 의존성 디렉터리 안을 가리키면 대상은 따로 따라가지 않는다(그 디렉터리를 이미 걷는다).
- 어느 사본을 검사했는지는 명령 문자열의 사본 경로로 판단한다.
- git work tree가 아니면 implement 후보를 만들 수 없어 blocked로 끝난다.
- submodule 내용은 사본에 없다. 후보의 파일 도구는 그 경로에서 막히고, 결과에 명시된다.
- 의존성 디렉터리 외에 git이 무시하는 파일(빌드 산출물, `.env` 같은 로컬 설정)은 사본·채택·fingerprint 대상이 아니며, 결과에 명시된다. 검사가 이런 파일을 입력으로 읽는다면 그 변경은 검사 무효화로 이어지지 않는다(검사가 매번 다시 만드는 산출물을 넣으면 모든 검사가 스스로 무효가 되기 때문).
- 하위 의존성 디렉터리(예: `packages/a/node_modules`)는 fingerprint에는 들어가지만 사본에는 복사되지 않는다(기존과 같음).
- 자동 테스트는 faux 모델과 실제 git·bash로 검증한다. 실제 모델(cliproxyapi/gpt-6.1-sol) E2E와 독립 검토 결과는 `CHANGELOG.md` [Unreleased]에 요약한다.

### 14.5 one-shot 명령 `/orche strong <PROMPT>` · `/orche ultra <PROMPT>`

```text
/orche strong src/parser.ts의 줄바꿈 처리 버그를 고쳐줘
/orche ultra 결제 모듈의 환불 계산을 다시 구현해줘.
요구사항:
- "부분 환불" 지원 / 기존 API 유지
```

- **프롬프트**: 모드 단어 뒤의 **구분자 한 글자**(공백·탭·줄바꿈 중 하나) 다음 전부다. 앞뒤 공백, 내부 공백, 여러 줄, 탭, 따옴표, 슬래시를 그대로 보존해 main에게 보낸다(다듬지 않는다). `single`/`direct`도 같은 규칙이다. 다만 Pi 대화형 편집기는 제출한 입력 전체를 명령 처리 전에 trim하므로, TUI에서 입력한 프롬프트의 맨 앞(모드 단어 앞)과 맨 뒤 공백은 Pi 단계에서 이미 사라진다(print/JSON/RPC 모드와 확장의 `sendUserMessage`는 그대로 전달). `/`로 시작해도 명령이 아닌 본문으로 보낸다. 프롬프트가 없거나 공백뿐이면 이 모드의 사용법만 보여 주고, 턴과 설정 변경은 일어나지 않는다.
- **요청 = 하나의 실행(run)**: 요청은 자기만의 run으로 실행되고, run이 끝날(settle) 때까지 main의 위임 규칙(system prompt section)·도구 집합·guard가 그 모드의 것이 된다.
  - run에 들어가는 것은 그 요청에 속한 것뿐이다. 프롬프트와 Pi가 함께 보내는 문맥, run 중에 사용자가 넣은 steer(요청을 고치는 입력), 그 요청이 시작한 job의 결과가 여기에 해당한다.
  - run 중에 큐에 들어온 follow-up(사용자 입력이든 다른 확장의 `sendUserMessage`든)은 다른 요청이다. orche가 붙잡아 두고(`orche: queued until the one-shot /orche strong request has ended; …`), run이 끝나면 각각 자기 run으로 세션 모드에서 실행한다. 그 run은 `before_agent_start`부터 다시 시작하므로 프롬프트·도구·dispatch가 모두 세션 모드다.
  - 그 요청과 무관한 이전 job의 결과(`orche-task-result`)도 붙잡았다가 run이 끝난 뒤 전달한다. 크래시로 중단된 job 안내(`orche-job-interrupted`)는 one-shot 요청이 아닌 다음 일반 프롬프트와 함께 보낸다.
  - Esc로 run을 중단하면 붙잡아 둔 프롬프트는 Pi의 큐처럼 편집기로 돌아가고, 붙잡아 둔 결과는 턴 없이 표시만 된다.
  - main이 답하기 시작한 뒤 출처를 가릴 수 없는 메시지(pi-session-bus의 다른 세션 메모, 다른 확장의 custom 메시지)가 run에 들어오면 보수적으로 그 시점에 요청 모드를 끝낸다. 남은 run은 세션 모드의 프롬프트·도구·guard·dispatch로 진행된다(`orche: a message from outside the one-shot … request arrived (<type>); the rest of this run follows the session's mode (<mode>).`).
  - **프롬프트 일치**: Pi는 prompt section을 run 시작 때 기록하고, Pi가 스스로 시작한 run(예: one-shot 뒤 도착한 job 결과의 run)에서는 이전 section을 그대로 쓴다. 그래서 orche는 모델 요청마다 `context_with_system`으로 지금 적용 중인 모드의 section을 확인하고, 다르면 그 요청에만 패치를 붙인다. transcript 기록은 바꾸지 않는다.
- **그 요청이 시작한 `orche_task`**: 모든 assignment가 그 모드로 실행된다. strong은 strong 계층 + single 흐름, ultra는 strong 계층 + ultra 흐름이다. strong-worker 미설정 시 strong orchestrator를 상속하는 등 라우팅 규칙은 14.1 그대로다. run보다 오래 도는 background job도 끝날 때까지 시작할 때의 모드로 돈다(같은 job에 attach해도 새 assignment가 아니므로 그대로다).
- **나중 턴에서의 모드**: 같은 요청임을 증명할 수 있는 경우에만 모드를 유지한다.
  - `single.ledger`가 켜져 있으면 task id가 증명이다. 그 task를 이어가면(`task`) 다른 worker나 새 worker가 맡아도 모드를 유지하고, 이 고정은 ledger hand-off 이벤트에 저장되어 재시작 뒤에도 남는다. 새 task나 고정이 없는 task는 그 요청이 쓰던 worker에서 실행돼도 세션 모드다.
  - ledger가 꺼져 있으면 run 밖에서 요청을 식별할 수단이 없다. worker는 요청이 아니다. 그 worker를 나중에 재사용하거나(`worker`), 사라진 뒤 후임자가 이어받거나(handover), 재시작 뒤 복원된 gone 항목으로 이어가도 세션 모드로 실행된다. 그 모드로 계속하려면 사용자가 one-shot 명령을 다시 쓴다.
  - 우선순위: 지금 run 중인 one-shot 요청 > (ledger 켬) task의 고정 > 세션 모드.
  - 결과 기록:
    - `Request mode: ultra (one-shot /orche ultra; the session stays in single). After this request, assignments to W1 (worker "W1") run in the session's mode; to continue in ultra, the user repeats /orche ultra <PROMPT>.` 줄. ledger가 켜져 있으면 `Task T1 keeps ultra for its continuations (task "T1"); other tasks run in the session's mode.`이다. 요청 모드가 세션 모드와 다를 때만 붙는다.
    - `details.requestMode`
    - run.json `assignment.requestMode`
    - job 시작 항목. 기록일 뿐 고정이 아니다.
- **세션 모드는 바뀌지 않는다**: 저장된 `/orche mode` 항목과 config 모두 그대로다. 지속적으로 바꾸려면 `/orche mode strong|ultra`를 쓴다.
- **busy이면 거부한다**: one-shot 명령(`single`·`direct` 포함)은 세션이 idle일 때만 시작한다.
  - 세션 모드가 같아도 거부한다. 큐에 넣으면 일반 프롬프트가 되어 명시한 모드를 잃기 때문이다.
  - 거부 메시지는 run이 끝난 뒤 다시 보내라고 안내한다. 세션 모드가 같으면 `/orche <mode>` 없이 보내 일반 follow-up으로 큐에 넣을 수 있다고, 다르면 `/orche mode <mode>`로 전환할 수 있다고 덧붙인다.
  - 일반 follow-up과 steer의 큐 동작은 그대로다. 단, one-shot run 중의 follow-up은 위처럼 그 run 뒤로 미룬다.
  - 한 번에 한 작업만 실행, 취소(`/orche cancel`), 권한, `git` grant(그 assignment에만 적용)는 일반 `orche_task`와 같다.
- **한계**:
  - `direct` 세션에서는 run이 끝난 뒤 위임 도구가 꺼진다. 같은 worker로 이어가려면 `/orche strong|ultra <PROMPT>`를 다시 쓴다.
  - main이 답하기 전에 run의 첫 steering 확인에 들어온 메시지는 그 요청의 문맥으로 취급한다(프롬프트와 같은 시점).
  - 출처를 가릴 수 없는 메시지로 요청 모드가 끝난 그 run의 첫 다음 모델 요청에서는, Pi가 이미 선언한 도구 목록이 한 번 늦게 바뀔 수 있다. guard는 호출 시점의 모드로 막고, 프롬프트는 그 요청부터 세션 모드다.
  - 자동 테스트는 faux 모델로 실제 Pi 세션·확장·job 경로를 검증한다. 실제 모델(cliproxyapi/gpt-6.1-sol) E2E 결과는 `CHANGELOG.md` [Unreleased]에 요약했다.

