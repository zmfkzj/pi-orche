# single 재설계: main → orchestrator → (필요할 때만) sub-worker

> 상태 (2026-10-05): 설계와 구현은 브랜치 `orchestrator-redesign`(worktree, 미커밋)에 있다. 5장의 분할 판단 평가는 실행 전에 사전 등록했고, 결과는 5.6에 붙인다.

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
       orchestrator (예전 single worker 자리, persistent, main 모델 상속, 50% compaction)
          │ 분할 판단: Parallelism / Isolation / Independent verification. 기본은 분할하지 않고 직접 작업
          │ orche_spawn {reason, workers[]}  ← 필요할 때만
          ▼
       sub-worker (새 세션, 깊이 1: 다시 spawn할 수 없음)
          - parallel: 서로 겹치지 않는 소유 파일, 동시에 실행
          - isolation: game-asset/video specialist(원래 route와 이미지 도구)
          - verification: 구현 context 없이 새로 띄운 읽기 전용 verifier
```

- **main**: 사용자의 요구사항을 구체화하고 명확하게 정리해 orchestrator 하나에게 넘긴다(인계 형식은 지금 single 그대로). 단순 응답은 직접 답한다. 결과는 보고서로 검토한다(코드 재확인·check 재실행 없음).
- **orchestrator**: 세 기준으로 분할 여부를 판단한다. 나눌 필요가 없으면 직접 작업하고(기본값), 필요하면 `orche_spawn`으로 sub-worker를 띄운 뒤 결과를 통합하고 확인한다. 판단과 근거를 보고서의 `data.split`에 짧게 남긴다.
- **sub-worker**: 한 번 쓰고 버리는 세션. 자기 요청만 보고, 자기 소유 파일만 쓸 수 있고, spawn 도구가 없다.

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

(구현 후 채움: 4.1 표)

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

### 5.3 실행 결과

(실행 후 채움)
