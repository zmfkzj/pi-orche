# ultra vs single 구조 대조 실험 (A/B/C, 2026-10-10)

> 상태: **본평가 진행 중**. 이 문서의 결과 절은 실행이 끝난 뒤 `experiments/ultra-ab/analyze.ts`의 집계로 채운다.
> 사전등록: `experiments/ultra-ab/PREREGISTRATION.md`(Part 1은 pilot 전, Part 2는 본평가 전에 작성; 본평가 시작 시 SHA-256을 `results/ultra-ab/main/plan-main.json`에 기록).

## 1. 질문과 조건

질문: 같은 모델·같은 요청별 effort에서 `/orche ultra`(B)가 single 구조의 strong 모드(A)보다 최종 결과 품질이 좋은가? 좋다면 그 차이가 단순히 시도를 더 하는 것(C)보다 큰가?

| 조건 | 실행 | 비고 |
|---|---|---|
| A | `pi --mode json "/orche strong <prompt>"` | single workflow + strong 계층(docs/orchestrator.md 14.1). sub-worker spawn 허용(제품 기본값) |
| B | `pi --mode json "/orche ultra <prompt>"` | strong 계층 + ultra 단계(14.2). 단계·도구 차이 자체가 처리 |
| C | A를 같은 snapshot의 격리 사본에서 k=4회 독립 실행 → 새 selector 세션이 1개 선택 | selector는 base snapshot, 시도별 최종 파일·diff·종료 상태만 보고 visible 검사를 직접 돌릴 수 있다. transcript·보고·채점·hidden은 못 본다. 선택은 채점 전에 sha256으로 봉인 |

- 모델: 모든 역할 `cliproxyapi/gpt-6.1-sol`(canonical, `bts/` 미사용). main `high`, `strong-orchestrator` `xhigh`, `strong-worker` 미설정(상속 → `xhigh`), selector `xhigh`, `thinkingPolicy: fixed`, advisor 꺼짐(`single.advisor:false`, `models.advisor`도 같은 경로로 고정), `concurrentSessions` 꺼짐. 설정은 `experiments/ultra-ab/protocol.ts` `orcheConfig`.
- 같은 prompt(`protocol.ts` `userPrompt`), 같은 초기 snapshot, 같은 도구·권한, 같은 상한(orche 기본 60분 + 활동 중 15분 연장 최대 2회 = 90분 상한, 요청 soft budget 300, Pi 프로세스 그룹 150분 강제 종료; C는 시도마다 같은 상한, selector 30분).
- 같은 요청별 effort ≠ 같은 총연산량: pilot에서 B는 A보다 출력 토큰이 약 9.7배였다. C(k=4)는 그 차이의 일부만 맞춘 compute-enhanced baseline이다(사전등록 상한 4).

## 2. 실행 통제

- 격리: 실행마다 새 프로세스·세션·TMPDIR·workspace(보이는 파일만 첫 커밋으로 둔 git 저장소)·private agent dir. 사용자 전역 설정은 읽거나 쓰지 않았다.
- 제품 고정: 본평가 시작 시점 작업 트리(HEAD `2de1f04` + 미커밋 ultra 변경 11파일)를 `results/ultra-ab/main/rt`로 복사, 파일별 SHA-256과 digest `5da2755ef90d…`(pilot과 동일). harness도 `results/ultra-ab/main/harness`로 고정.
- 실제 경로 확인: 실행마다 자체 logging proxy(`experiments/ultra-ab/proxy.mjs`)가 요청 모델·effort·HTTP 상태·응답 모델·최종 이벤트 usage를 기록(헤더·자격증명·본문 미기록). main은 그 실행의 `--session-id`, 나머지 세션은 orche worker/sub-worker로 분류. orche `run.json`의 `assignment.mode/tier/model/thinking`과 대조.
- SWE 과제의 `python`/`pytest`: 과제 venv(읽기 전용, 저장소 밖 scratch 사본)를 쓰되 **셸이 있는 프로젝트**(snapshot 루트 anchor를 가진 가장 가까운 조상)를 `PYTHONPATH` 맨 앞에 둔다. 이전 벤치 harness의 wrapper는 첫 workspace를 고정해 ultra 후보 사본의 하위 디렉터리에서 원본 코드를 import했다(`validate.ts`의 `legacyWrapperImportedFromCopyB = copy-a`) — 실행 전에 고친 harness 결함.
- 순서·동시성: 반복 우선, 각 (과제, 반복) 안에서 조건 순서를 고정 seed로 무작위화(`protocol.ts schedule`), 동시 8 unit.
- 재시도: 모델 요청이 하나도 성공하지 못한 실행(인프라)만 1회, 실패 시도는 `<dir>.infra-<n>`로 보존. 중단된 실행은 `<dir>.interrupted-<n>`로 보존 후 재실행. timeout·blocked·failed·실행 중 provider 오류·채점 실패는 재시도하지 않는다.

## 3. 채점

- primary(실행 단위): 종료 상태 `done`(요청이 시작한 마지막 orche task의 `run.json`) **그리고** 독립 채점 통과 **그리고** 무결성 위반 없음.
- 독립 채점(`experiments/ultra-ab/env.ts gradeWorkspace`, 모델 무관): 최종 workspace 사본에서 원본 테스트·runner 설정을 모두 복원하고 새 conftest/pytest.ini/tox.ini를 지운 뒤, suite는 원본 visible 테스트와 hidden 테스트를 `node --test`(TAP: exit 0, pass>0, fail 0), SWE는 hidden `test.patch` 적용 후 FAIL_TO_PASS 전부 + PASS_TO_PASS 전부 통과, pytest 비정상 종료(exit>1·signal·timeout)는 실패.
- 무결성 위반: 원본 테스트 파일 삭제 또는 기존 줄 삭제·변경, 테스트 파일에 skip/only/xfail/수집 hook 추가, runner 설정의 테스트 구간 변경, 새 conftest/pytest.ini/tox.ini. 테스트 줄 추가는 허용("suspicious"로 기록).
- 채점기 검증(모델 없음, 15과제 전부): 시작 상태는 실패, 참조 해답은 통과, 원본 테스트에서 assertion 한 줄을 지우면 위반으로 잡힌다(`results/ultra-ab/validation*.json`, VALIDATION OK).

## 4. 과제

`experiments/ultra-ab/draw-tasks.ts`(seed `ultra-ab-2026-10-10`)가 이전 Opus 단독 보정 자료(`experiments/advisor-reviewer/selection.json`, strong/ultra 정보 없음)에서 층화 추첨했다. hard = 보정에서 한 번도 통과 못함, medium = 혼합 또는 평균 비용 ≥ $0.60, easy = 나머지. 층마다 첫 추첨은 pilot, 다음 4개는 본평가.

| 층 | 본평가 | pilot |
|---|---|---|
| hard | sqlfluff-7615, isort-2491, d1-transactional-outbox, docstub-123 | hermes-webui-2056 |
| medium | tox-3904, mtplx-21, param-1117, d8-build-graph | build-1027 |
| easy | a7-auth-rotation, stravalib-709, sqlglot-7187, marshmallow-2925 | scim2-models-126 |

## 5. 결과

(실행 완료 후 작성)

## 6. 재현

```sh
npx tsx experiments/ultra-ab/validate.ts results/ultra-ab/validation.json      # 채점기·환경 검증(모델 없음)
npx tsx experiments/ultra-ab/driver.ts experiments/ultra-ab/plans/pilot.json   # pilot
npx tsx experiments/ultra-ab/driver.ts experiments/ultra-ab/plans/main.json    # 본평가(중단 후 같은 명령으로 재개)
npx tsx experiments/ultra-ab/regrade.ts --study results/ultra-ab/main --phase main
npx tsx experiments/ultra-ab/analyze.ts --study results/ultra-ab/main --phase main
npx vitest run test/experiments/ultra-ab.test.ts
```
