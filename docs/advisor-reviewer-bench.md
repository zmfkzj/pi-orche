# Worker + advisor / reviewer 벤치마크 (2026-10-08)

**결론**: Opus 5.5(high) worker에 GPT 6.1 Sol(high) **advisor**를 붙이면 10과제×2회에서 성공 9/20 → **12/20**, **reviewer**를 붙이면 9/20 → **10/20**이었다. advisor는 두 과제(sqlfluff-7615 0/2→2/2, d8-build-graph 1/2→2/2)를 살렸고 퇴행은 없었으며 비용은 +30%, 평균 wall time은 +9%였다. reviewer는 한 과제(sqlfluff-7615 0/2→1/2)만 살렸고 비용 +69%, wall time 약 2배였다. 다만 과제 단위 paired bootstrap 95% 구간이 advisor [0, +40]pp, reviewer [0, +15]pp로 0을 포함하고 개선 근거가 각각 2과제·1과제뿐이라 **통계적으로 유의한 향상이라고 말할 수 없다**. 숨은 기준을 모르는 실패 5과제 중 3과제(d1, hermes-2056, isort)는 어느 조건도 한 번도 풀지 못했다.

- 측정: 60회(10과제 × 3조건 × 2반복), 모두 실제 모델 실행, infra 실패·재시도 0회, 순차 재채점 결과가 실행 중 채점과 60/60 일치. 보정(예비) 실행 102회는 본 결과에 포함하지 않았다.
- artifact: `results/advisor-reviewer/main/`(실행별 `runs/<과제>/<조건>/r<n>/`, `summary.json`, `summary.md`), harness `experiments/advisor-reviewer/`, 과제 `fixtures/advisor-bench/`.


## 1. 측정 대상 모델과 effort (R1)

| 역할 | Pi 모델 ID (`provider/id`) | 표시 이름 | effort | 근거 |
|---|---|---|---|---|
| worker | `cliproxyapi/claude-opus-5-5` | Claude Opus 5.5 | `high` | `~/.pi/agent/cliproxyapi-models.json`의 `claude-opus-5-5` 항목(`thinkingLevelMap.high = "high"`), 이 세션 자신의 `PI_PROVIDER=cliproxyapi`·`PI_MODEL=claude-opus-5-5` |
| advisor, reviewer | `cliproxyapi/gpt-6.1-sol` | GPT 6.1 Sol | `high` | 같은 파일의 `gpt-6.1-sol` 항목(`name: "GPT 6.1 Sol"`, `thinkingLevelMap.high = "high"`) |

- **"sol"의 뜻**: 별칭이나 effort 설정이 아니라 upstream 모델 이름의 일부다. CLIProxyAPI(EasyCLIProxyAPI v0.3.20, core 8.0.16) 설정 `cpa-core/config.yaml`에는 활성 alias가 하나도 없고(모든 `alias:` 줄이 주석), 모델 목록(`GET /v1/models`)과 Pi 카탈로그 모두 `gpt-6.1-sol`을 그대로 노출한다. 같은 계열에 `gpt-6-sol`·`gpt-6-luna`·`gpt-6-astra`, `gpt-5.6-sol`·`gpt-5.6-terra`·`gpt-5.6-luna`가 따로 있어 sol은 GPT 6.1 계열의 한 등급(tier) 이름이다. 판별 불가한 다중 해석은 없었다.
- **같은 모델의 두 경로**: `cliproxyapi/gpt-6.1-sol`과 `cliproxyapi/bts/gpt-6.1-sol`이 있다. `bts/`는 CLIProxyAPI `force-model-prefix: true`에서 특정 OAuth 계정(접두사 `bts`)으로 가는 경로이고 모델은 같다. 사용자 설정(`~/.pi/agent/orche.config.json`)과 이전 연구(`docs/advisor-study.md`)가 쓰는 접두사 없는 경로를 썼다. Opus도 같은 이유로 `claude-opus-5-5`(접두사 없음).
- **실제로 그 모델·effort로 돌았다는 증거**: 각 실행의 `meta.json` `assignments[].model/thinking`(orche가 세션에서 읽은 값)과 `thinkingLevels`(세션 transcript의 `thinking_level_change`), `usage.byRole`의 키(응답 메시지의 `provider/model`). 본 측정 60회 전부에서 worker 요청은 `cliproxyapi/claude-opus-5-5`, advisor·reviewer 요청은 `cliproxyapi/gpt-6.1-sol`뿐이고 effort는 모두 `high`였다(6.4절).
- 사용자 전역 설정은 읽지도 쓰지도 않았다: 실행마다 임시 agent dir(인증·카탈로그 파일 복사, provider 패키지 symlink)에 벤치 전용 `orche.config.json`을 썼다(`experiments/advisor-reviewer/driver.ts` `overlay`, `run-one.ts`).

## 2. 세 조건과 개입 규칙 (R2)

현재 저장소에는 예전의 advisor 기능(`src/advisor`, plan-review·verification-audit preset)이 없다(2026-10-06 제거, `docs/advisor.md` 첫 줄). 그래서 두 helper를 **지금 제품에 있는 구조**로 붙였다. worker는 orche의 실제 `WorkerPool.execute`(single workflow `implement` 할당, Task DAG `task_plan`, `report_result`)를 그대로 쓴다. helper는 같은 경로의 읽기 전용 역할 할당이다. 결합 조건(advisor+reviewer)은 범위 밖이다.

| | baseline | advisor | reviewer |
|---|---|---|---|
| worker | Opus 5.5 high, orche_task `implement` 할당 1회 | 같음 | 같음 |
| helper 모델 | 없음 | GPT 6.1 Sol high | GPT 6.1 Sol high |
| helper가 쓰는 제품 구조 | — | orche_task `answer` 역할(읽기 전용 worker) | orche_task `verify` 역할(새 세션의 읽기 전용 verifier, `data.passed` 필수) |
| 개입 시점 | — | worker의 첫 `task_plan` 호출(그 전에 `edit`/`write`가 먼저 나오면 그때) | worker가 결과를 보고한 직후 |
| 개입 횟수 | — | 1회 | 1회 |
| helper가 보는 것 | — | 과제 원문(worker 요청과 동일), worker의 계획(`task_plan` 노드), 그 시점의 workspace(읽기 전용; bash로 실험 가능, 쓰기는 scratch만) | 과제 원문, worker 보고 요약, 완성된 workspace(`git diff HEAD`), 읽기 전용 bash로 테스트·탐침 실행 |
| helper가 못 보는 것 | — | 숨은 테스트, worker 대화 내용 | 숨은 테스트, worker 대화 내용 |
| 전달 방식 | — | 준비되는 즉시 실행 중인 worker에 주입(`WorkerPool.inject` = 제품의 `orche_task_message`, 다음 턴 경계에 전달). worker가 이미 보고했으면 같은 worker에 후속 할당 1회로 전달 | `passed:false`면 findings를 같은 worker(문맥 유지)에 후속 할당 1회로 전달. `passed:true`면 전달 없음 |
| worker 수정 기회 | — | 주입되면 같은 할당 안에서, 늦으면 후속 할당 1회 | 후속 할당 1회(재검토 없음) |
| helper 출력 제한 | — | 400단어 이하, 전체 풀이 금지(15줄 이하 조각만) | issues에 결함·재현 입력·위반 요구·수정 방향 |
| helper 시간 제한 | — | 12분(harness abort) | 12분(harness abort) |

- 공통: worker는 `single.spawn: false`(sub-worker 없음 — 조건 사이에 다른 개입이 섞이지 않게), `thinkingPolicy: "fixed"`(전 요청 high), 할당 제한 25분·연장 0회·요청 예산 150(제품 기본값), 같은 도구(orche worker 도구 세트), 같은 요청 문안(`protocol.ts` `workerRequest`). worker가 할당에 실패하면(시간 초과 등) helper의 후속 할당은 주지 않는다(시간 추가로 이기는 것을 막음).
- 프롬프트 원문: `experiments/advisor-reviewer/protocol.ts`의 `workerRequest`, `advisorRequest`, `reviewerRequest`, `revisionRequest`, `adviceMessage`. 주입된 조언은 orche가 `[Message from main while you work on this assignment · M1]`로 감싼다(`src/agent/agent-manager.ts:589`).
- 결과 판정은 helper의 판단과 무관하다: 모든 조건이 같은 숨은 테스트로 채점된다(4절).

## 3. 과제 준비와 난이도 보정 (R3)

### 3.1 후보군

| 출처 | 후보 | 채점 | 격리 |
|---|---|---|---|
| `fixtures/suite` (저장소 기존 fixture, JS) | 6개(a7, d1, d2, d4, d6, d8; rubric 채점 과제는 제외) | 기존 `src/eval/suite.ts` `gradeTask`의 visible+hidden `node --test` | workspace에는 `repo/`만 복사, `hidden/`·`reference/`는 밖 |
| LiveCodeBench AtCoder (2025-01~04, `results/iso-token`의 로컬 사본 → `fixtures/advisor-bench/lcb`) | 12개(abc E~G, arc C~D, 모두 "hard") | `solution.py`를 전체 테스트(41~43개, arc195_d는 2개)에 실행, 토큰 비교, 테스트당 6초 | workspace에는 `problem.md`·`examples.json`만 |
| SWE-rebench 2026-01~05 (실제 GitHub 이슈와 maintainer 수정·테스트, 로컬 사본 → `fixtures/advisor-bench/swe`) | 셋업 시도 46개 중 환경 검증 통과 38개, 그중 37개 보정 실행(line-bot-sdk-981은 시간상 미실행) | 숨은 `test.patch` 적용 후 FAIL_TO_PASS 전부 + PASS_TO_PASS 전부 통과(SWE-bench 기준) | workspace는 base commit의 `git archive`(이력 없음 → 수정 커밋에 접근 불가), `test.patch`·`fix.patch`는 밖 |

SWE 과제 환경(`experiments/advisor-reviewer/setup-swe.ts`): Python 3.14.4 venv에 데이터셋의 설치 명령을 non-editable로 실행하고 pip를 지운 뒤 읽기 전용으로 만든다. workspace의 `python`·`pytest`는 PATH의 wrapper로, workspace 코드를 sys.path 맨 앞에 둔다. 검증: 숨은 테스트를 붙였을 때 FAIL_TO_PASS가 시작 코드에서 실패하고 참조 수정에서 모두 통과해야 하며, 참조 수정에서도 실패하는 PASS_TO_PASS(Python 버전 차이)는 채점에서 제외해 `task.json`에 남겼다(선정된 과제는 제외 0건).

### 3.2 보정 실행

보정은 본 측정과 같은 harness·제한·worker 요청으로 baseline(worker 단독)만 돌렸다. 보정 결과는 본 측정 성능으로 쓰지 않는다. 원본: `results/advisor-reviewer/calibration*/`, 정리본: `experiments/advisor-reviewer/selection.json`.

| 출처 | 보정 과제 | baseline 모두 통과 | 모두 실패 | 혼합/infra |
|---|---:|---:|---:|---:|
| suite (JS) | 6 | 5 | 1 (d1) | 0 |
| LiveCodeBench | 12 | 12 | 0 | 0 |
| SWE-rebench | 37 | 28 | 8 | 1 (pyfakefs: 채점기 복사 오류 1회, 이후 수정) |

LiveCodeBench hard 12개를 Opus 5.5가 모두(24/24) 풀어 실패 쪽 후보가 되지 못했다(2025년 문제라 학습 노출 가능성도 있다). 그래서 2026년 SWE-rebench 이슈로 후보를 넓혔다.

**선정 규칙**(본 측정 전 고정): (1) 결정적 채점이고 환경 검증을 통과한 과제, (2) 실패 절반 = 보정에서 baseline이 모두 실패했고 숨은 테스트가 과제 문안에 쓰였거나 문안에서 바로 따라 나오는 동작만 확인하는 과제, (3) 통과 절반 = 보정에서 모두 통과한 과제 중 출처별로 평균 baseline 비용이 가장 큰 것(복잡도 대리 지표; suite 1, LCB 1, SWE 3).

| 과제 | 출처 | 보정 baseline | 선정 이유 |
|---|---|---|---|
| d1-transactional-outbox | suite | F F | 실패하는 숨은 검사(claim당 attempts, lease 소유권)가 지시문의 계약에 적혀 있음 |
| pycqa__isort-2491 | SWE | F F | 이슈에 적힌 주석 위치 동작을 검사 |
| nesquena__hermes-webui-2056 | SWE | F F | 이슈가 직접 제안한 safe slug(`local-127.0.0.1-15721`, "ideally both")를 검사 |
| scientific-python__docstub-123 | SWE | F F | 새 문법은 되지만 기존 테스트(`test_callable_error`)가 깨짐 — 프로젝트 테스트로 잡을 수 있는 퇴행 |
| sqlfluff__sqlfluff-7615 | SWE | F F | 이슈의 기대 동작(`::` cast가 붙은 placeholder를 그대로 둠)을 검사 |
| d8-build-graph | suite | P P | suite 통과 과제 중 비용 최대 |
| lcb-atcoder-arc196_c | LCB | P P | LCB 통과 과제 중 비용 최대 |
| tobymao__sqlglot-7479 | SWE | P P | SWE 통과 과제 비용 1위 |
| copier-org__copier-2646 | SWE | P P | 2위 |
| python-scim__scim2-models-139_interface | SWE | P P | 3위 |

**제외한 실패 과제**(숨은 테스트가 문안에 없는 정확한 문자열을 요구 — 누구도 추론할 수 없어 advisor/reviewer 효과를 볼 수 없음): pypa__twine-1309("Unknown Status" 문구), nolar__kopf-1225(정확한 로그 문구), pallets-eco__wtforms-892_interface(렌더 시 label override·default→value 의미), python-scim__scim2-models-120(오류 문구 "Multiple values marked as primary"). pytest-dev__pyfakefs-1286은 보정 결과가 불안정(채점 오류 1, 통과 2)해서 제외. 환경 검증 실패·설치 불가 8개 목록과 모든 후보의 보정 원자료는 `selection.json`에 있다. 이 제외는 "공정한 실패"만 남기는 선택이므로, 실제 업무의 실패 중 사양 공백형 비중이 크면 helper의 효과는 이 결과보다 작게 나타날 것이다.

**누출 방지**: workspace에는 보이는 파일만 있고(LCB `public/`, suite `repo/`, SWE base commit의 이력 없는 snapshot), 숨은 테스트·참조 수정은 저장소 `fixtures/` 아래 workspace 밖에 있다. SWE venv에는 pip이 없고 `pip` 명령은 거부되며 지시문이 네트워크 사용을 금한다. 모든 도구 호출 인자를 `LEAK_PATTERNS`(fixtures·hidden·reference·iso-token·results 경로, git clone/fetch, pip install, curl/wget, github/pypi URL)로 검사했다: 본 측정의 37건은 모두 코드·문서 안의 URL 문자열, 단어 `gold`, 문서 `reference/` 경로 같은 오탐이었고 fixture·숨은 테스트 경로나 네트워크 명령은 0건이었다(analysis는 `meta.json` `leakAudit`).


## 4. 실행 통제 (R4)

- **격리**: 실행마다 새 프로세스, 새 임시 디렉터리(workspace·agent dir·scratch), 새 worker 세션. orche는 측정 시작 시점 커밋 `96cd2a7`의 `git archive`로 고정했고(`results/advisor-reviewer/main/rt/REVISION`; 작업 트리의 다른 세션 미커밋 변경은 들어가지 않음), harness 파일도 실행 디렉터리에 복사해 고정했다(`main/harness/`).
- **같은 조건**: 같은 초기 상태, 같은 worker 요청, 같은 도구, 같은 제한(worker 할당 25분·연장 0·요청 150, helper 12분), 같은 채점기.
- **순서**: 반복 1의 모든 셀 → 반복 2. 과제마다 세 조건을 연달아 두되 첫 조건을 과제·반복마다 회전(`protocol.ts` `schedule`). 동시 실행 6.
- **규모**: 10과제 × 3조건 × 2반복 = 60회(요구된 초기 규모의 범위 안). 반복 2회는 최소 요건이며, 변동성 근거는 실제로 나왔다(아래 반복 불일치).
- **재시도 정책**: harness 오류나 worker 성공 요청 0회(=infra)만 1회 재시도, 실패 시도는 `<셀>-infra-1`로 보존. 시간 초과·채점 실패는 재시도하지 않음. 본 측정에서 infra 0, 재시도 0, provider 오류 응답 0.
- **채점**: 실행 직후 채점 + 전체 종료 후 `analyze.ts --regrade`로 저장된 `workspace-final`을 한 번에 하나씩 다시 채점(최종값). 두 결과는 60/60 같았다.

## 5. 결과 (R5, R6)

### 5.1 조건별

| 조건 | 성공 | pass/fail/timeout/infra | 평균 wall | 중앙 wall | wall SD | worker 평균 | helper 평균 | revision 평균 | 비용 합계 | 실행당 | 성공당 | revision 발생 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 9/20 (45%) | 9/11/0/0 | 471s | 370s | 330s | 469s | 0s | 0s | $20.20 | $1.01 | $2.24 | 0 |
| advisor | 12/20 (60%) | 12/8/0/0 | 514s | 421s | 330s | 474s | 138s* | 32s | $26.25 | $1.31 | $2.19 | 6 |
| reviewer | 10/20 (50%) | 10/10/0/0 | 972s | 832s | 549s | 503s | 270s | 196s | $34.15 | $1.71 | $3.41 | 15 |

\* advisor는 worker와 **동시에** 돈다(wall time에 그대로 더해지지 않음). reviewer와 revision은 worker 뒤에 순차로 붙는다.

비용은 Pi가 카탈로그 단가(`cliproxyapi-models.json`: Opus 5.5 $4/$20/캐시읽기 $0.2, GPT 6.1 Sol $2/$10/$0.1 per 1M)로 계산한 **추정치**다. 실제 호출은 CLIProxyAPI의 구독 OAuth 계정을 거쳐 토큰당 청구가 없으므로 실측 청구액은 측정할 수 없다.

### 5.2 모델별 토큰 (조건 합계)

| 조건 | 모델 | 요청 | input | output | cache read | cache write | reasoning(보고분) | 추정 비용 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | claude-opus-5-5 | 659 | 1.06M | 0.53M | 27.4M | 0 | 70k | $20.20 |
| advisor | claude-opus-5-5 | 681 | 1.26M | 0.64M | 30.3M | 0 | 87k | $23.91 |
| advisor | gpt-6.1-sol | 219 | 0.68M | 0.07M | 3.2M | 0 | 24k | $2.34 |
| reviewer | claude-opus-5-5 | 878 | 1.71M | 0.79M | 39.5M | 0 | 101k | $30.54 |
| reviewer | gpt-6.1-sol | 276 | 0.90M | 0.12M | 6.2M | 0 | 35k | $3.61 |

reasoning은 provider가 보고한 값만 합쳤다(output에 포함된 부분집합). Opus 쪽 값은 output에 비해 매우 작아 proxy가 thinking 토큰을 다 보고하지 않는 것으로 보인다 — 참고값이다. cache write는 proxy가 0으로 보고했다.

### 5.3 과제별 (반복 1, 2)

| 과제 | 보정 | baseline | advisor | reviewer |
|---|---|---|---|---|
| d1-transactional-outbox | F F | F F | F F | F F |
| pycqa__isort-2491 | F F | F F | F F | F F |
| nesquena__hermes-webui-2056 | F F | F F | F F | F F |
| scientific-python__docstub-123 | F F | F F | F F | F F |
| sqlfluff__sqlfluff-7615 | F F | F F | **P P** | F **P** |
| d8-build-graph | P P | F P | **P P** | F P |
| lcb-atcoder-arc196_c | P P | P P | P P | P P |
| tobymao__sqlglot-7479 | P P | P P | P P | P P |
| copier-org__copier-2646 | P P | P P | P P | P P |
| python-scim__scim2-models-139_interface | P P | P P | P P | P P |

### 5.4 baseline 대비 (과제 단위 paired)

| 조건 | 평균 성공률 차 | 95% bootstrap(과제 재표집 10,000회) | 나아진/나빠진/같은 과제 | fail→pass (기대 과제 수) | pass→fail |
|---|---:|---|---|---:|---:|
| advisor | +15.0pp | [0, +40]pp | 2/0/8 | 1.50 | 0 |
| reviewer | +5.0pp | [0, +15]pp | 1/0/9 | 0.75 | 0.25 |

fail→pass/pass→fail은 같은 과제의 baseline 실행과 조건 실행을 모든 조합(2×2)으로 짝지은 기대값이다(반복끼리는 독립이라 반복 번호로 짝짓지 않음). reviewer의 pass→fail 0.25는 d8에서 baseline·reviewer가 둘 다 1/2라 생긴 조합 효과이고, 과제 단위로 나빠진 과제는 어느 조건에도 없다.

### 5.5 변동성

- 보정 라벨과 본 측정 baseline이 다른 과제: d8(보정 P P → 본 측정 F P). 같은 조건 두 반복이 갈린 과제는 baseline 1개(d8), advisor 0개, reviewer 2개(d8, sqlfluff).
- wall time SD는 평균의 60~70%로 크다(과제 차이가 대부분). 성공 차이 한두 건이 결론을 바꾸는 표본 크기다.

### 5.6 helper 동작

- **advisor**: 20회 모두 첫 `task_plan`(19회) 또는 첫 편집(1회)에서 호출됐다. 14회는 실행 중인 worker에 주입·전달됐고, 6회는 worker가 이미 보고해 후속 할당으로 전달됐다. 살린 두 과제 중 sqlfluff-7615는 두 번 모두 주입 경로, d8은 두 번 모두 늦은 전달(후속 할당) 경로였다 — 즉 d8의 회복은 "보고 뒤 한 번 더 보는 기회" 효과와 분리되지 않는다.
- **reviewer**: 20회 모두 실행, 오류 0. `passed:false` 15회 → revision 15회. 판정과 최종 결과: passed:true 5회 중 실제 통과 2회, **실제로는 실패 3회**(docstub 2회, hermes 1회 — 기존 테스트 퇴행과 이슈의 제안 수정을 놓침). passed:false 15회 중 revision 뒤 통과 8회(대부분 이미 통과하던 과제에 대한 지적), 실패 7회(d1·isort·hermes·d8·sqlfluff에서 지적했지만 숨은 기준에 닿지 못함).
- 모든 실행에서 worker 요청은 `cliproxyapi/claude-opus-5-5`, helper 요청은 `cliproxyapi/gpt-6.1-sol`, thinking은 모두 `high`.

## 6. 해석

- **무엇이 나아졌나**: advisor는 "기본 worker가 이슈의 기대 동작 일부를 놓치는" 유형(sqlfluff-7615: `::` cast 처리)과 큰 계약 과제의 한 반복(d8)을 살렸다. reviewer는 sqlfluff를 한 번 살렸다. 
- **무엇이 안 됐나**: 계약이 문안에 있어도 세부 의미가 깊은 과제(d1), 이슈가 수정 방향을 제시한 과제(hermes), 주석 위치 규칙(isort), 기존 테스트 퇴행(docstub)은 세 조건 모두 0/2였다. reviewer는 docstub에서 기존 테스트가 깨진 것을 두 번 다 통과시켰다.
- **advisor vs reviewer**: 이 표본에서 advisor가 성공(+3 vs +1)과 비용(+30% vs +69%), 지연(+9% vs +106%) 모두에서 나았다. advisor는 worker와 병렬로 돌고, reviewer는 직렬 검토 + revision이 거의 항상(15/20) 붙어 시간·토큰을 키웠다. reviewer의 지적 대부분은 이미 통과하던 과제에 대한 것이라 비용만 늘었다.
- **추가 비용 대비 이득**: 성공당 추정 비용은 baseline $2.24, advisor $2.19(동등 이하), reviewer $3.41. 자원 추가 효과와 조언 품질 효과를 완전히 나눌 수는 없다: advisor의 늦은 전달 6회와 reviewer의 revision 15회는 worker에게 추가 작업 기회를 준다. advisor의 회복 중 sqlfluff 2회는 같은 할당 안의 주입이라 추가 할당 없이 생겼다.
- **권장(잠정)**: Opus 5.5 high 단독이 이미 대부분을 푸는 작업에서는 helper를 기본으로 켤 근거가 약하다. 붙인다면 계획 시점 advisor(병렬, 1회, 짧은 조언)가 비용 대비 낫다. reviewer는 이 설정(완성 후 1회 검토 + 1회 수정)에서는 비용이 크고 퇴행을 잡지 못했으므로, 쓰려면 프로젝트 테스트 전체 실행을 강제하는 등 검토 방식을 바꿔 다시 측정해야 한다. 어느 쪽도 이 표본으로 "유의한 향상"이 확인되지 않았다.

## 7. 한계

- 10과제 × 2반복. 효과 추정은 2과제(advisor)·1과제(reviewer)의 차이에 기대며 구간이 0을 포함한다.
- 과제 선택 편향: 실패 쪽은 "공정한 실패"만 골랐다(사양 공백형 4개 제외, 3.2절). 통과 쪽은 비용 상위를 골라 쉬운 과제의 퇴행 가능성은 보지 않았다.
- LCB 문제는 2025년 공개 문제라 학습 노출 가능성이 있다. SWE 과제는 2026년 이슈지만 Python 3.14 환경(데이터셋은 3.11~3.13)으로 돌렸다(선정 과제는 제외 테스트 0건).
- 비용은 카탈로그 단가 추정. Opus reasoning 토큰은 proxy 보고가 불완전하다.
- advisor는 비동기라 전달 시점이 worker 속도에 좌우된다(6/20이 늦은 전달). 결합 조건(advisor+reviewer)은 측정하지 않았다.
- 실행 시간대 효과를 순서 회전·교차 배치로 줄였지만, 동시 6실행이 provider 지연에 영향을 줬을 수 있다(provider 오류는 0).

## 8. 재실행

```sh
# 과제 준비 (LCB는 results/iso-token 로컬 사본, SWE는 그 raw jsonl + GitHub/PyPI 접근 필요)
npx tsx experiments/advisor-reviewer/import-lcb.ts lcb-atcoder-arc196_c
npx tsx experiments/advisor-reviewer/setup-swe.ts tobymao__sqlglot-7479 pycqa__isort-2491 nesquena__hermes-webui-2056 scientific-python__docstub-123 sqlfluff__sqlfluff-7615 copier-org__copier-2646 python-scim__scim2-models-139_interface
# 본 측정 (plan: out, revision 96cd2a7, 10 tasks, arms, repeats 2, concurrency 6) — experiments/advisor-reviewer/plans/plan-main.json (results/에도 사본)
npx tsx experiments/advisor-reviewer/driver.ts experiments/advisor-reviewer/plans/plan-main.json
npx tsx experiments/advisor-reviewer/analyze.ts --study results/advisor-reviewer/main --regrade
# 보정: experiments/advisor-reviewer/plans/plan-calibration*.json 각각 같은 driver로, analyze는 --regrade 없이
```

plan 파일 내용(본 측정): `{"out":"results/advisor-reviewer/main","revision":"96cd2a7","phase":"main","arms":["baseline","advisor","reviewer"],"repeats":2,"concurrency":6,"tasks":[위 10개]}`. 완료된 셀은 건너뛰므로 새 `out`으로 돌려야 새 측정이 된다.

**환경**: Ubuntu 26.04.1, Linux 7.0.0-38, Node v24.21.0, tsx 4.23.15, Pi SDK(`@earendil-works/pi-coding-agent`·`pi-ai`·`pi-agent-core`) 1.0.0, `@router-for-me/pi-cliproxyapi-provider` 1.4.21, CLIProxyAPI 8.0.16(EasyCLIProxyAPI 0.3.20), Python 3.14.4, orche `96cd2a7`.

**artifact**: 실행별 `results/advisor-reviewer/main/runs/<과제>/<조건>/r<n>/`에 `meta.json`(할당별 시간·모델·effort·상태, advisor/reviewer 기록, 역할×모델 사용량, 누출 검사, outcome), `grade.json`·`grade-final.json`, `final.diff`, `workspace-final/`, `records/`(worker·advisor·reviewer 전체 transcript), `stdout/stderr`. 집계 `main/summary.json`·`summary.md`, 실행 로그 `main/driver-main.log`. 보정 `results/advisor-reviewer/calibration{,-swe,-swe2,-swe3,-swe4,-swe4b}/`. 스모크(a6, 3조건) `results/advisor-reviewer/smoke/`. `results/`는 git에 추적되지 않는다(저장소 관례).

