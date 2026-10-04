# Coordinator-planned DAG 실행 설계

> **상태 (2026-10-04): Gate A NO-GO — 구현 보류.** parallel3(병렬 과제 3개 × 3회)에서 multi는 9/9 통과, 9/9 실행에서 구현 워커가 실제로 병렬(동시성 중앙값 1.68)이었고 coordinator 요청 비중은 6%였다. 그러나 single보다 9.5%만 빨랐고(기준 ≥20%), direct보다 17% 느렸으며, 비용은 direct의 2.9배(기준 ≤2배)였다. coordinator 왕복이 이미 작아 DAG로 줄일 몫이 거의 없다. 이 문서는 참고용으로 보관하며, 한 컨텍스트에 들어가지 않는 대형 코드베이스에서만 재검토한다. 근거: `results/compare/parallel3-2026-10-03/report.md` (로컬 전용).

> 결론: coordinator가 실행·검증·수정 경로를 한 번 계획하고, 코드 runtime이 구조화된 edge handoff로 실행한다.
> worker는 다음 worker를 선택하지 않으며, 정상 검증 실패도 사전 계획된 fix/re-verify 경로로 처리한다.
> 구현 착수는 parallel3의 품질 동등성·20% 이상 시간 이득·비용·실제 병렬성 gate를 통과한 뒤 결정한다.

- 상태: 설계 제안. 이 문서는 소스 변경이나 기능 제공을 의미하지 않는다.
- 기준: 작성 시점의 작업 트리와 `188eb4e`; 기존 미커밋 변경도 현재 동작과 구분하여 확인했다.
- 범위: `orche_run`의 변경 실행부. `orche_task` end-to-end single을 DAG로 바꾸는 제안이 아니다.
- 원칙: coordinator는 계획 소유자, runtime은 실행 권한자, worker는 할당된 노드의 수행자다.
- 아래 `src/...:행`은 현재 구현의 근거이고, 신규 파일명·타입·설정·event는 제안이다.

## 1. 배경과 문제 정의

### 1.1 관측된 비용과 품질

밀결합 과제 hard6에서는 multi의 탐색·구현·검증 비용이 병렬화 이득보다 컸다.
아래 요청 수는 **실행당 평균**이며, 보고서 표의 총 요청 수를 완료 실행 수로 나눈 값이다.

| 경로 | 평균 wall time | 평균 요청 | 통과 | API-equivalent 총비용 / 성공당 비용 |
|---|---:|---:|---:|---:|
| orche-multi | 1,984.985초 ≈ 33분 | 642/6 = 107 | 5/6 | $6.597 / $1.319 |
| single end-to-end | 944.2319초 ≈ 16분 | 278/9 ≈ 31 | 7/9 | $3.4961 / $0.4994 |
| orche-direct | 435.196초 ≈ 7분 | 114/7 ≈ 16 | 7/7 | $1.236 / $0.177 |

- Multi/direct 근거: `results/compare/hard6-2026-10-03/report.md:7`–`:14`.
- 지정된 single 보고서: `results/compare/hard6-2026-10-03/single-e2e/report.md:7`–`:16`.
- **자료 불일치:** 이 single 보고서는 `orche-single-e2e=0/0`인 오래된 집계다.
- 완료된 single 수치 근거는 `results/compare/hard6-2026-10-03/single-e2e/runs/summary.md:3`–`:13`이다.
- 동일 summary의 `:97`–`:99`는 d1=1/3, d6=3/3, d8=3/3을 보여준다.
- 과거 `orche-single`의 0/7은 모드 전환을 요구한 버그 경로이지 end-to-end single 성능이 아니다.
  이 구분은 `results/compare/hard6-2026-10-03/single-e2e/report.md:18`–`:48`에 있다.

이 자료들은 **gitignored, 로컬에만 존재**한다(`.gitignore:16`–`:17`).
저장소 clone만으로 링크를 재현할 수 없으므로 리뷰 시 보고서 snapshot과 source revision을 별도로 전달한다.
과제·반복 수가 다르고 일부 실행은 중단되어, 이 표를 paired causal comparison으로 해석하지 않는다.
비용은 OAuth 청구액이 아닌 base-tier API-equivalent 추정이며 unknown usage와 judge 비용을 구분한다.
현재 hard6 집계는 중단·미완료 실행을 제외한다(`results/compare/hard6-2026-10-03/report.md:103`–`:113`).

### 1.2 Coordinator 제거의 효과를 과장하지 않는다

A/B 전체 요청은 old=3,504, new=3,687이다(`results/compare/ab-2026-10-03/report.md:11`–`:14`).
Coordinator 요청은 각각 358, 333으로 약 10.2%, 9.0%다(`results/compare/ab-2026-10-03/report.md:36`, `:48`).
이 비율은 **요청 비중**이지 wall time·토큰·비용 비중이 아니다.
Hard6 multi에서도 coordinator는 36/642 ≈ 5.6%다(`results/compare/hard6-2026-10-03/report.md:75`).
분류·초기 계획·원인 판단을 유지하므로 이 요청들 전부가 없어지는 것도 아니다.

직접 줄이는 비용은 다음뿐이다.

1. 검증 뒤 coordinator 승인/실패 판단 왕복.
2. 예상된 검증 실패마다 새 fix backlog를 합성하는 왕복.
3. 실행 중 예외 replan의 두 단계 결정을 하나의 plan patch로 합치는 왕복.
4. 실패한 전체 `orche_run`을 처음부터 다시 실행하는 낭비를 node resume으로 대체.

Blocked나 계획 무효화 **예외 자체의 coordinator 판단은 남는다**.
다음 주요 비용은 DAG만으로 해결되지 않는다.

- Exploration fan-out: 가설별 여러 explorer가 읽고 재현하는 작업.
- 새 worker가 코드·요구사항을 다시 읽는 비용: 기존 worker 유지와 별개로 새 노드 소유자는 읽어야 한다.
- 요구사항의 손실 있는 재서술: main → coordinator → task 과정의 의미 누락.
- 잘못된 구현·불충분한 테스트·누락된 경계 조건: 실행 순서가 결정적이어도 LLM 작업 내용은 그렇지 않다.

요청에서 언급한 d1 attempts-counter 사례는 현재 `single-e2e/report.md`에 없다.
따라서 이 문서는 그 원인 분석을 해당 보고서의 확정 사실로 인용하지 않는다.
원문 요구사항을 보존하고 회귀 사례로 재확인할 필요는 있지만, handoff schema만으로 의미 보존을 보장하지 않는다.

### 1.3 d6 실패와 전체 재실행

D6 multi r1의 solver 시간은 3,269,778ms ≈ 54.5분이다.
근거: `results/compare/hard6-2026-10-03/runs/d6-snapshot-pagination/orche-multi/r1/meta.json:128`–`:131`.
동일 실행의 canonical main session에는 `orche_run` 호출이 세 번 있다.
근거 파일은 `results/compare/hard6-2026-10-03/runs/d6-snapshot-pagination/orche-multi/r1/sessions/2026-10-03T11-21-37-844Z_01a1017f-8933-7075-ad31-5d20eea340a2.jsonl:24`, `:28`, `:32`다.
Saved grade는 visible 통과, hidden 실패이며 tuple boundary에서 `INVALID_CURSOR`가 발생한다.
근거: `results/compare/hard6-2026-10-03/runs/d6-snapshot-pagination/orche-multi/r1/grade.json:4`–`:12`.
즉 관측된 최종 실패는 **놓친 edge case**이며, coordination 문제로 귀속할 근거는 없다.
Resume은 반복 탐색 비용을 줄일 수 있지만 그 edge case를 자동으로 발견하는 장치가 아니다.

`188eb4e`는 이미 실패 worker 인계와 1-worker change fast path를 추가했다.
오늘 코드를 “실패하면 반드시 전체 재실행한다”고 설명하면 부정확하다.
현재 인계는 수동 후속 `orche_task`를 가능하게 할 뿐 DAG 실행 위치·budget·edge 결과를 보존하지 않는다.
이 설계의 추가 가치는 **같은 worker와 실패 frontier에서 runtime이 재개**하는 것이다.

## 2. 목표 / 비목표

### 목표

- 확정된 실행 계획 안에서는 coordinator 재호출 없이 implement → verify → fix → re-verify를 실행한다.
- 파일 ownership, worker identity, assignment correlation, timeout, audit를 한 runtime이 통제한다.
- 선행 결과를 edge별 구조화된 payload로 전달하고 fan-in에서 누락·중복을 검출한다.
- 정상적인 검증 실패와 실행 불능/계획 무효화 예외를 다른 상태로 표현한다.
- 성공한 노드의 재작업을 피하고 실패 위치 및 필요한 downstream만 재개한다.
- 계획·실행·재개·budget 소비를 records/events에서 추적하고 비용을 실측한다.
- 기존 경로와 opt-in DAG 경로를 같은 요청·모델·limits로 비교한다.

### 비목표

- Worker가 LLM 판단으로 다음 worker를 고르거나 새 assignment를 생성하는 방식.
- 탐색 단계의 원인 수용까지 사전 DAG로 고정하는 방식; 알려지지 않은 원인 판단은 유지한다.
- `answer` class의 synthesis/승인을 없애거나 `single` 모드의 end-to-end 정책을 교체하는 작업.
- 자동 requirements compression, shared reasoning memory, 모든 코드 재읽기 제거.
- Arbitrary retry graph, 무제한 loop, 실행 중 조건 코드를 LLM이 작성하는 workflow engine.
- 범용 파일 공동 소유, 자동 commit/push, 서로 다른 프로세스 간 exactly-once tool 실행.
- Hidden grading 자료를 solver prompt에 주입하는 기능; 측정과 실행 입력은 분리한다.

## 3. 현재 구조

### 3.1 실행부와 계약

| 역할 | 현재 근거 | DAG에서의 변화 |
|---|---|---|
| Entry / class 분기 | `src/orchestration/coordinator.ts:129`–`:144` | 초기 판단 뒤 선택적으로 DAG runner 호출 |
| 결정·repair·advisor 재고려 | `src/orchestration/run/decisions.ts:19`–`:74` | 초기 plan 및 예외 patch에만 사용 |
| Classify | `src/orchestration/run/decisions.ts:171`–`:183` | 유지; class·worker 수·언어 선택 |
| Diagnose 계획·원인 수용 | `src/orchestration/run/diagnose.ts:18`, `:65`–`:113` | 유지; 수용 후 실행 DAG 작성 |
| Ready backlog 실행 | `src/orchestration/run/change.ts:29`–`:88` | scheduler의 출발점; 이미 coordinator 없이 dispatch |
| Verification 승인 | `src/orchestration/run/change.ts:89`–`:114` | DAG에서는 runtime verdict 처리 |
| Merge / replan / fix | `src/orchestration/run/change.ts:115`–`:153` | 초기 DAG plan 및 예외 patch로 대체 |
| Phase 순수 transition | `src/orchestration/phases.ts:101`–`:156` | legacy 유지, DAG run 상태 분리 |
| Backlog 검증·readiness | `src/orchestration/backlog.ts:76`, `:120` | 노드·edge·bounded expansion 검증 추가 |
| Prompt | `src/orchestration/prompts.ts:20`–`:33` | canonical task에 edge handoff 추가 |
| Result schemas | `src/orchestration/result-schemas.ts:25`–`:65` | DAG assignment용 엄격한 data 계약 |
| Run plumbing | `src/orchestration/run/context.ts:39`, `:47`, `:107` | assignmentId별 dispatch/result 연결 |
| Context / report | `src/orchestration/run/types.ts:138`–`:210` | plan·node states·results·checkpoint 추가 |

`implementationPrompt`는 task JSON과 canonical backlog를 전달하고, dependent owner에게 NOTE를 권한다.
선행 RESULT의 결론·변경 범위·계약·근거·미해결 이슈를 runtime이 자동 주입하지 않는다.
현재 NOTE는 정보일 뿐 dependency 완료의 구조화된 handoff가 아니다(`src/orchestration/prompts.ts:24`–`:27`).
`workerAssignment`는 첫 assignment에 원문 요청·identity·언어를 넣는다(`src/orchestration/run/context.ts:39`–`:44`).
따라서 “현재 worker는 원문 요구사항을 전혀 받지 않는다”도 사실이 아니다.

현재 `implement/fix.data.status`는 optional이고 blocked 외 completed 결과는 done으로 취급한다.
근거: `src/orchestration/result-schemas.ts:25`–`:30`, `src/orchestration/run/change.ts:73`–`:84`.
`verify.data.passed`는 필수지만 evidence/issues는 unknown이다(`src/orchestration/result-schemas.ts:45`–`:50`).
DAG는 후속 실행 결정에 이 데이터를 쓰므로 더 엄격한 계약이 필요하다.

### 3.2 Class별 coordinator 호출 순서

여기서 `decide()` 한 번과 provider 요청 한 번은 다르다.
Repair와 advisor 재고려 때문에 한 결정이 여러 요청을 만들 수 있다(`src/orchestration/run/decisions.ts:19`–`:31`).
`apply()`는 순수 transition을 적용하는 코드이며 LLM 왕복이 아니다(`src/orchestration/run/context.ts:91`–`:100`).

| Class / 경로 | 현재 정상 순서 | 실패 때 추가 순서 | DAG가 제거하는 부분 |
|---|---|---|---|
| answer | classify → analysts → decide(answer/answer_from_worker) | fail 등 | 첫 버전에서 없음 |
| change, multi-worker | classify → decide(assign) → executeBacklog → V1 → decide(complete) | V1 실패 → decide(verification_failed) → decide(assign fix) → 실행·검증 반복 | 검증 승인과 예상 fix 합성 |
| change, 1-worker | classify → deterministic assign → 실행 → deterministic verify verdict | 같은 A1 fix → 같은 V1 재검증; blocked는 즉시 fail | 이미 제거되어 추가 호출 절감 거의 없음 |
| diagnose_fix | classify → plan_exploration → claims마다 decide(continue/root_cause_accepted) → proposals → decide(assign) → 실행·V1 → decide(complete) | change multi와 동일 | 원인 수용 이후의 verify/fix 왕복 |
| blocked multi backlog | 실행·audit → decide(replan/fail) → decide(assign revised backlog) | maxFixRounds와 공유하여 반복 제한 | 예외는 유지하되 patch 한 결정으로 통합 |

Answer 근거: `src/orchestration/run/answer.ts:24`–`:36`.
Diagnose의 `plan_exploration`은 `decide()`가 아니라 coordinator session의 직접 prompt다.
근거: `src/orchestration/run/diagnose.ts:23`–`:32`, `:100`–`:110`.
원인 수용 후 convergence와 proposal 수집 자체는 `apply()`/worker 실행이다(`src/orchestration/run/diagnose.ts:47`–`:64`, `:116`).
Multi의 fix/replan은 `src/orchestration/phases.ts:150`–`:153`에서 fixRounds를 공유한다.

### 3.3 이미 있는 fast path와 인계

- `src/orchestration/coordinator.ts:137`은 classified workerCount=1인 `change`를 `runSingleChange`로 보낸다.
- `src/orchestration/run/change.ts:157`–`:174`는 plan/approval 호출 없이 실행·audit·fix를 반복한다.
- `src/orchestration/phases.ts:160`–`:167`은 A1에 `files:["/"]`와 원문/verification을 deterministic assign한다.
- `/`는 run-only root ownership sentinel이며 절대 host path 허용이 아니다(`src/orchestration/run/root-ownership.ts:6`–`:33`).
- `diagnose_fix`는 workerCount=1이어도 이 fast path를 타지 않는다.
- 실제 run 기본 maxFixRounds는 1이다(`src/orchestration/limits.ts:28`–`:35`).
  `createPhaseState()` 함수 기본값 2와 구분한다(`src/orchestration/phases.ts:79`).
- 실패·비취소 run은 settled idle worker만 hook으로 인계한다(`src/orchestration/coordinator.ts:155`–`:175`).
- `WorkerPool.adoptFailedRun`은 A/V identity를 새 W id로 바꾸되 session을 유지한다(`src/extension/workers.ts:493`–`:510`).
- `AgentManager.detach/adopt`는 idle/일회성 transfer를 강제한다(`src/agent/agent-manager.ts:749`–`:770`).
- Auto prompt는 이미 실패 후 전체 rerun 대신 handed-over worker 재사용을 지시한다(`src/extension/mode.ts:61`).
- 반면 strict multi 모드는 `orche_task`를 막는다(`src/extension/mode.ts:38`, `:92`).
  인계 기반 resume API가 이 모드에서도 허용되는 것은 별도 설계/테스트 대상이다.

## 4. 제안 구조

### 4.1 계획 시점과 DAG의 의미

`change`는 classify 뒤, `diagnose_fix`는 원인 수용·proposal 수집 뒤 한 번 `plan_dag`를 요청한다.
그 결과는 implement/verify/fix와 실패 budget을 모두 포함한다; worker에게 next-worker 선택권은 없다.
정상 실행 중에는 plan을 수정하지 않는다. 예외 patch는 새로운 plan revision으로 명시한다.
초기 분류·탐색 판단까지 coordinator가 평생 한 번만 호출된다는 뜻은 아니다.

Fix loop를 그대로 graph cycle로 넣으면 DAG가 아니다.
따라서 coordinator는 **bounded repair template**를 계획하고, runtime이 실행 전에 이를 유한 DAG로 펼친다.
예: `I1,I2 → V0 → (실패 시 F1[1],F2[1]) → V1 → ... → VN`.
V0 성공 시 뒤 repair branch는 skipped; V0 실패 시 해당 owner의 fix만 활성화된다.
N=0이면 V0 실패가 곧 budget-exhausted 예외다. 모든 concrete edge는 앞으로만 향한다.
같은 worker는 여러 노드에 배정되지만 한 시점에 하나의 assignment만 가진다.

### 4.2 Schema: 계획, 소유권, 실패 정책, budget

아래는 TypeScript-like 설계 타입이다. Wire schema는 version별로 별도 검증한다.

```ts
type NodeId = string;
type OwnerId = string; // logical owner; pool W id와 분리
interface Ownership {
  owner: OwnerId; writeFiles: string[]; // verify는 빈 writeFiles
  readFiles?: string[]; // 정보용; 읽기를 ownership으로 차단하지 않음
}
interface NodeBudget {
  timeoutMs: number; requestLimit: number; retryLimit: number;
  // dispatch부터 timeout; request는 soft limit; infra retry와 fix round는 별개
}
interface NodeBase {
  id: NodeId; description: string; requirementRefs: string[];
  ownership: Ownership; budget: NodeBudget;
}
type DagNode =
  | (NodeBase & { kind: "implement" })
  | (NodeBase & { kind: "verify"; covers: NodeId[];
      commands: string[]; failurePolicy?: string })
  | (NodeBase & { kind: "fix"; repairs: NodeId[]; repairPolicy: string });
interface HandoffSelection {
  fields: ["conclusion", "changes", "contracts", "evidence", "issues"]; // 항상 다섯 필드
  issues: "all" | "target-owner"; maxInlineBytes: number;
}
interface DagEdge {
  id: string; from: NodeId; to: NodeId;
  when: "success" | "verify_failed" | "settled";
  handoff: HandoffSelection; // 실행 전 spec, 완료 후 payload ref
}
interface FailurePolicy {
  id: string; verifier: NodeId; fixNodes: NodeId[]; reverify: NodeId;
  maxRounds: number; routeIssuesBy: "write-ownership";
  unmatchedIssue: "escalate"; exhausted: "escalate";
}
interface DagPlan {
  schemaVersion: 1; planId: string; revision: number; requestHash: string;
  nodes: DagNode[]; edges: DagEdge[]; failurePolicies: FailurePolicy[];
  terminalVerifiers: NodeId[];
  budget: { maxNodes: number; maxEdges: number; maxAssignments: number;
    maxCoordinatorReentries: number; maxFixRoundsTotal: number };
  // maxNodes/Edges는 펼쳐진 graph, maxAssignments는 infra retry 포함
}
```

Wire plan에는 변경 가능한 `status`를 넣지 않는다; 실행 상태는 별도 ledger다.
`settled`는 임의 실패를 성공으로 바꾸지 않고, repair barrier의 succeeded/skipped만 수용한다.
`requestHash`는 main이 준 원문+context의 digest이며 coordinator가 임의로 바꿀 수 없다.
원문 acceptance id와 본문은 runtime이 보존한다; task description이 원문을 대체하지 않는다.

### 4.3 Validation: backlog.ts 확장

기존 `validateBacklog`의 duplicate id, unknown owner/dependency, cycle, 다른 owner 간 파일 중첩을 재사용한다.
근거: `src/orchestration/backlog.ts:24`–`:30`, `:76`–`:117`.
신규 `validateDagPlan`은 plan 제출 직후와 exception patch 적용 직전에 다음을 검증한다.

1. Schema version, trim된 비어 있지 않은 id, unique node/edge/policy id, 모든 참조의 존재.
2. Node kind와 worker role/tool 권한의 일치; verifier logical owner는 writer와 분리.
3. Implement/fix의 nonempty writeFiles; verify의 writeFiles는 반드시 비어 있음.
4. 경로 정규화, 구체적 상대 파일/재귀 prefix만 허용, `..` escape·host 절대 경로·일반 glob 거부.
5. Root sentinel은 단일 writer 계획에만 허용; symlink real-path 검사는 실행 시에도 유지.
6. 서로 다른 writer owner의 전체 write set은 중첩 불가. 순차 edge도 다른 owner 중첩을 허용하지 않음.
7. 같은 owner implement/fix의 중첩은 허용하되 fix 범위는 해당 owner의 사전 선언 write set 안이어야 함.
8. Success dependencies 및 펼쳐진 **모든** edge에 topological sort; self edge/cycle 거부.
9. 실패 edge는 verify에서 지정 repair branch로만, settled edge는 repair join으로만 허용.
10. Failure policy의 maxRounds는 유한 nonnegative integer이고 limits.maxFixRounds 이하.
11. Global fix-round/assignment/expanded node·edge budget을 계산하여 cap 초과 plan 거부.
12. 모든 writer 결과를 적어도 하나의 terminal verification이 cover하고, verification 없이 성공하는 경로 거부.
13. Conditional activation과 join이 교착되지 않음; dangling node·충족 불가능한 barrier 거부.
14. Fan-in별 다섯 payload 필드와 typed envelope 필수; skipped fix도 runtime이 사유와 빈 배열을 전달.
15. Coordinator가 제안한 commands는 configured verifyCommands를 누락/대체할 수 없음.
16. Requirement id 누락은 검출하지만 description의 의미 충족 여부는 verifier 책임으로 남김.

잘못된 계획에는 실행을 시작하지 않는다. `decisionRepairs` 범위에서 수정하고 실패하면 종료한다.
기존 bounded repair와 advisor의 한 번 재고려는 유지한다(`src/orchestration/run/decisions.ts:19`–`:74`).
Semantic backlog dedupe는 여전히 coordinator 역할이지 scheduler의 추론이 아니다(`src/orchestration/backlog.ts:46`).

### 4.4 Runtime scheduler

`executeBacklog`를 일반화하되 legacy를 한 번에 교체하지 않는다. 새 `run/dag.ts`는 순수 reducer와 I/O runner를 분리하고 clock/manager/audit seam을 주입한다.

```ts
type NodeState =
  | "pending" | "ready" | "running" | "auditing"
  | "succeeded" | "verification_failed" | "blocked"
  | "failed" | "skipped" | "cancelled";
interface NodeExecution {
  nodeId: NodeId; round: number; attempt: number;
  state: NodeState;
  assignmentId?: string; epoch?: number;
  inputHash?: string; outputRef?: string;
  startedAt?: number; finishedAt?: number;
  error?: { code: string; detail: string };
}
```

- `succeeded`는 유효 RESULT + 해당 노드의 audit gate를 모두 통과한 상태다.
- `verification_failed`는 정상 verifier verdict=false이며 infra failure/blocked와 구분한다.
- `blocked`는 명시적 수행 불능, `failed`는 no_result/provider 오류/계약 위반 등이다.
- `skipped`는 runtime이 사전 조건을 평가해 만든 결과이며 worker의 임의 선언이 아니다.
- `ready`는 입력 고정·branch 활성화·dependency 만족 상태, dispatch는 owner idle과 resource slot도 필요하다.

Scheduling 절차:

1. Validate/expand plan, stable topological rank와 node id 순서로 queue를 만든다.
2. 활성화된 노드의 모든 required edge가 충족되면 입력 payload ref와 hash를 고정한다.
3. Idle logical owner를 physical worker id에 resolve하고 runtime이 assignment를 생성한다.
4. `AgentManager.assign`의 반환 id/epoch를 저장한 뒤 결과를 기다린다.
5. Outcome을 `(runId, planRevision, nodeId, round, attempt, assignmentId, epoch)`에 귀속한다.
6. 현재 assignment와 다른 늦은/중복/superseded outcome은 기록하되 상태나 edge를 바꾸지 않는다.
7. Report 검증·audit·output 저장을 완료한 뒤 한 번만 outgoing edge를 materialize한다.
8. Audit cut 완료 후 새 ready 노드를 dispatch한다; 무관한 전체 실행의 완료까지 기다리지 않는다.
9. Ready/running이 없으면 auditing cut을 먼저 flush한다; 그래도 활성 미완료 노드가 남으면 deadlock 예외다.
10. 필수 terminal branch가 검증 통과하면 runtime이 worker 결론·검증 근거를 합성하고 완료한다.

현재 `executeBacklog`는 agentId+kind로 activeTasks를 찾는다(`src/orchestration/run/change.ts:69`–`:85`).
DAG에서는 같은 kind 반복과 resume이 있으므로 assignmentId/epoch까지 반드시 비교한다.
Manager의 실제 Assignment/Outcome 계약은 `src/agent/agent-handle.ts:16`–`:30`에 있다.
Deterministic은 동일 plan·입력·관측 event에서 같은 상태 전이를 뜻한다. LLM 결과·provider latency·독립 worker의 실제 완료 순서까지 같다는 보장은 아니다.

### 4.5 Failure edge, issue routing, barrier

Verifier는 `{passed:false, issues:[...]}`만 반환하고 fix owner나 다음 노드를 선택하지 않는다.
Runtime은 issue file을 plan write ownership과 비교하여 명확한 이슈만 사전 계획된 owner fix로 전달한다.
여러 파일의 issue는 모든 관련 owner에게 같은 issue id로 복제하되 담당 파일을 함께 전달한다.
Owner 힌트/sourceNodeIds가 있어도 plan ownership과 충돌하면 routing 근거로 쓰지 않는다.
파일 없는 infra 이슈, unowned file, 허용되지 않은 새 계약/범위는 예외로 coordinator에 보낸다.

`V[r]` 실패 시 한 round budget을 **batch당 한 번** 소비하고 사전 fix branch 전체를 활성화한다.
Issues가 있는 fix는 ready, 없는 fix는 runtime이 `skipped(no_owned_issues)`로 확정한다.
`V[r+1]`은 `V[r].verify_failed`와 모든 fix의 succeeded/skipped를 AND로 기다리며 원래 issues와 각 fix handoff를 받는다.
어느 fix든 blocked/failed이면 barrier는 풀리지 않으며 예외로 정지한다.
`V[r]` 통과 시 해당 repair descendant만 skipped 처리하며 별개의 필수 verification은 생략하지 않는다.
최대 N번 fix 뒤 VN도 실패하면 추가 branch를 만들지 않고 budget-exhausted로 re-entry한다.

첫 버전은 domain writer가 멈춘 뒤 검증한다. Shared working tree의 전체 체크가 writer와 경쟁하지 않도록 global verification barrier를 기본으로 한다.
이후 파일·체크가 완전히 분리된 local verification만 동시 실행을 검토한다.
Scheduler의 writer 간 overlap은 유지하지만 검증 중 파일 변경을 성공 근거로 쓰지 않는다.

### 4.6 Deadline, extension, cancellation

전체/phase는 extension budget 하나를 공유하고 backlog도 phase deadline 하나를 쓴다(`src/orchestration/run/types.ts:146`–`:152`, `src/orchestration/run/change.ts:34`–`:35`).
Wait가 timeout을 계속 새로 만들지 않고 dispatch별 node deadline을 저장하여 현재 overall과 hard cumulative ceiling으로 제한한다.
Repair/infra retry는 새 assignment를 만들지만 이미 쓴 요청·wall·extension은 ledger에 남긴다.

- `overallMs`, `assignmentMs`, `decisionMs`, `assignmentRequests`, `maxExtensions` 의미를 유지한다.
- 현재 기본 overall=30분, extension=30분×10, hard ceiling=5시간 30분이다(`src/orchestration/limits.ts:4`–`:8`).
- Node timeout은 해당 node/owner의 liveness만으로 연장한다; 다른 worker 활동이 죽은 node를 살리지 않는다.
- Overall 만료는 run-wide liveness로 평가하되 모든 연장은 기존 shared counter에서 차감한다.
- 중복 timer가 동시에 만료되어도 연장을 한 번만 소비한다(`src/orchestration/run/extension.ts:183`–`:208`).
- 기다리는 dependency 시간은 node 실행 cap에 포함하지 않지만 run overall에는 포함한다.
- Request limit은 현재처럼 soft budget이며 실제 강제 ceiling처럼 문서화하지 않는다.
- Auto infra retry 기본값은 0; side-effect 안정성·settle 확인이 가능한 명시적 정책만 허용한다.
- 사용자 cancel은 모든 dispatch/edge 전달보다 우선하며 coordinator re-entry나 worker handover를 하지 않는다.
- 이미 실행 중인 tool은 강제 rollback하지 않는다; settle 실패는 cleanup incomplete로 기록한다.

### 4.7 Handoff payload와 report_result 확장

Runtime이 검증된 predecessor report와 관측 변경에서 handoff를 만든다. 다섯 필드는 필수이며 해당 사항 없음은 빈 배열로 표현한다.
자연어 summary에서 계약·이슈를 추출하는 추가 LLM 호출은 없다.

```ts
interface SourceLocation {
  path: string; startLine?: number; endLine?: number;
  revision?: string; // snapshot/tree/content digest; line의 기준
}
interface HandoffPayload {
  schemaVersion: 1;
  source: { runId: string; planRevision: number; nodeId: string;
    round: number; attempt: number; assignmentId: string };
  conclusion: string;
  changes: { path: string; action: "add" | "modify" | "delete" | "rename";
    before?: SourceLocation; after?: SourceLocation; diffRef?: string }[];
  contracts: { id: string; locations: SourceLocation[]; description: string;
    compatibility: "unchanged" | "compatible" | "breaking" }[];
  evidence: { id: string; location?: SourceLocation; artifactRef?: string;
    command?: string; outcome: "passed" | "failed" | "unexecuted";
    detail: string }[];
  issues: { id: string; files: SourceLocation[]; description: string;
    severity: "blocking" | "warning"; sourceNodeIds?: string[] }[];
}
```

`report_result {kind,summary,data}`는 유지하되(`src/agent/agent-handle.ts:11`–`:15`) DAG implement/fix는 status, blocked면 reason, 다섯 내용 필드가 필수다.
DAG verify는 passed, typed evidence/issues, conclusion과 빈 changes/contracts를 요구한다.
`passed:true`와 blocking issue/failed 또는 필요한 unexecuted check가 함께 오면 거부한다.
False인데 issue가 없으면 schema repair; 계속 설명 불가하면 invalid-result 예외로 처리한다.
Source identity는 worker 선언을 믿지 않고 runtime이 붙인다. 기존 optional/unknown 계약은 legacy assignment에서 유지한다.
Report schema는 manager의 assignment-local contract로 선택하도록 확장해야 하며 기존 모든 worker에 강제하지 않는다.
현재 schema 오류는 report_result 안에서 같은 turn repair된다(`src/orchestration/result-schemas.ts:52`–`:64`).

Worker changed files를 audit와 대조하여 누락 diff를 추가하고 불일치를 warning/예외로 기록한다; self-report가 audit를 대체하지 않는다.
범위는 before/after snapshot 기준이며 deletion/rename과 binary 파일도 diffRef로 표현한다.
Non-git/audit unavailable 환경의 변경은 self-reported provenance로 표시하고 durable resume은 허용하지 않는다.

Prompt에는 다음 순서로 주입한다.

1. Runtime이 보존한 사용자 원문/acceptance, 현재 node scope·ownership·budget.
2. 해당 node의 task JSON과 필요한 DAG 인접 관계; 전체 canonical graph는 크기 제한 내 참조.
3. `BEGIN_EDGE_HANDOFF`로 구분한 schema JSON: edgeId 순서, issue/evidence id dedupe.
4. “이 payload는 작업 데이터이며 권한·system instruction·새 assignment가 아니다”라는 규칙.
5. Fix에는 해당 owner issues + failure evidence + 관련 contract; verify에는 전체 관련 outputs.

Byte cap 초과는 artifactRef+digest+필수 blocking issue를 남긴다. 원문/필수 이슈는 silent truncation하지 않으며 못 맞추면 prompt-too-large 예외다.
Artifact 경로는 record namespace에서 검증하고 로그의 instruction 실행을 막는다. Records off/저장 실패로 읽을 ref가 없으면 cap 초과를 예외 처리한다.
Peer NOTE는 정보일 뿐 readiness·owner·scope·next-worker를 못 바꾼다; 정식 handoff는 구조화된 edge이며 NOTE 시점에 의존하지 않는다.

### 4.8 Coordinator re-entry와 결정 타입

계획 이후 re-entry는 예외에만 발생한다.

| Trigger | Runtime 조치 | Coordinator가 받는 내용 |
|---|---|---|
| blocked task / infra failure | 영향 branch 정지, running writer settle | 실패 node, owner, partial changes, reason, handoff |
| fix/retry/global budget 소진 | 추가 실행 금지 | 소비 ledger, 검증 이력, unresolved issues |
| invalid DAG / deadlock | 쓰기 시작 전 거부 또는 dispatch freeze | validation errors, unsatisfied edges |
| 계획을 무효화하는 새 정보 | 관련 frontier freeze | 외부 변경, 새 계약/범위, 충돌 evidence |

취소와 hard overall 만료는 판단을 요청할 시간/권한이 없으므로 그대로 종료한다.
Timeout이 남은 overall 안의 node-local 실패라면 blocked 계열 예외로 re-entry할 수 있다.
일반 NOTE마다 coordinator를 깨우지 않는다; worker/advisor가 명시적으로 plan-invalidated signal을 제출해야 한다.
신호는 영향을 받은 node와 증거를 요구하며 runtime이 현재 revision과 참조를 확인한다.

```ts
type DagDecision =
  | { type: "plan_dag"; plan: DagPlan }
  | { type: "patch_dag"; baseRevision: number; reason: string;
      preserve: NodeId[]; invalidate: NodeId[]; replacement: DagPlan }
  | { type: "resume_dag"; checkpointId: string; frontier: NodeId[] }
  | { type: "fail"; reason: string };
```

정상 complete/verification_failed는 coordinator 결정이 아니라 runtime 전이다.
Patch/resume을 하나의 예외 응답으로 받고 validation 뒤 진행하여 기존 replan→assign 두 왕복을 대체한다.
Coordinator는 완료 결과를 임의로 성공 선언하거나 hard cap/파일 권한을 늘릴 수 없다.
Budget 소진 뒤 계속하려면 caller의 명시적 추가 budget 승인이 필요하며 resume_dag만으로 reset되지 않는다.
Patch는 영향 받은 completed descendants를 정확히 invalidate하고, 무관한 성공 노드는 preserve한다.
Preserve는 input/output digest와 외부 변경 검사까지 만족해야 하며 LLM의 preserve 목록만 믿지 않는다.
Re-entry 자체도 bounded repair/reconsideration, shared overall, maxCoordinatorReentries cap을 적용한다.

### 4.9 Resume semantics

Checkpoint는 plan revision/hash, node/edge ledger, input/output refs, logical→physical worker mapping을 가진다.
추가로 workspace baseline·현재 content digest, budgets consumed, extension log, invalidation frontier를 저장한다.
V[r]의 정상 false 결과는 재실행하지 않는다; 사전 계획된 F[*][r+1]가 다음 frontier다.
중단된 implement/fix는 같은 node의 새 attempt로, verifier infra failure는 같은 verify의 새 attempt로 재개한다.
성공 노드는 입력/계약이 유효하면 재할당하지 않는다. 검증 필요 여부는 수정된 dependency의 영향 closure로 정한다.

최초 지원은 **같은 pi 프로세스/세션 안의 warm resume**다.
실패 hook으로 받은 W worker를 checkpoint owner map에 연결하고 pool에서 exclusive lease한다.
Node id와 logical owner는 유지하며 prompt의 physical id만 변경한다.
`onFailedHandover`의 현재 lastTask/문자열 issues로는 부족하므로 checkpoint ref와 owner provenance가 필요하다.
현재 인계 타입 근거: `src/orchestration/run/types.ts:75`–`:91`.

Resume 요청은 제안 API `orche_resume {checkpointId}` 또는 동등한 controller entry로 분리한다.
이는 새 `orche_run`이 아니며 classify/exploration/성공 implement를 반복하지 않는다.
엄격 multi 모드에서도 runtime resume을 허용하되 main의 임의 `orche_task` routing은 열지 않는다.
Pool worker가 다른 assignment를 수행했거나 TTL로 사라졌다면 stale/missing worker로 거부한다.
새 session을 명시적으로 복원하는 cold resume은 후속 단계이며 warm reuse했다고 표시하지 않는다.
프로세스 재시작 후 worker conversation과 진행 중 tool을 exactly-once로 복구하는 것은 첫 버전 비목표다.

Resume 전 확인:

- Checkpoint format/version, 동일 cwd real-path·requestHash·plan revision, 단일 소비/lease 여부.
- Worker idle/settled, role·tool guard 재바인딩, 다른 pool 작업과 비중첩.
- Workspace 변화가 성공 output을 무효화하지 않았는지; 외부 변경은 restore하지 않음.
- Partial edits는 rollback하지 않고 같은 worker에 변경 사실·실패 근거를 전달해 재검사하도록 함.
- 새 attempt의 id/epoch와 남은 cumulative budgets; 전체 wall은 최초 run부터 누적 측정.
- 사용자 취소된 checkpoint는 자동 resume/handover 대상이 아님.

### 4.10 Ownership / audit, advisors, records / events

Write guard의 기준은 전체 과거 backlog가 아니라 **현재 running node의 ownership**이어야 한다.
같은 owner의 다른 노드 파일에 대한 권한이 자동 합쳐지지 않도록 node-local TaskItem projection을 만든다.
Guard/real-path 검사는 유지한다(`src/orchestration/run/context.ts:176`–`:200`).
Bash/script 변경은 workspace audit로 보완한다(`src/orchestration/run/audit.ts:149`–`:164`).
Verifier는 read-only이며 실제 workspace 변경은 legacy와 동일하게 violation이다.

현재 audit checkpoint는 phase tracker를 초기화한다(`src/orchestration/run/audit.ts:172`–`:182`).
동시에 돌아가는 writer마다 그대로 호출하면 다른 worker의 attribution window를 잘라 오판할 수 있다.
첫 버전은 workspace snapshot/audit를 직렬화하고 **writer quiescent cut**에서 attribution을 확정한다.
Running node는 report 후 auditing 상태로 잠시 머물며 cut 완료 전 downstream edge를 publish하지 않는다.
Cut에 포함된 모든 writer와 각 ownership의 union으로 audit하되 개별 tool provenance를 보존한다.
Ready wave 내부 병렬성은 유지하지만 긴 sibling이 handoff를 지연시킬 수 있으므로 그 시간을 측정한다.
후속 incremental audit는 global activity window를 유지한 node-tagged attribution이 입증된 뒤 도입한다.
External/ambiguous changes는 기존 정책처럼 별도 기록하며 자동 restore하거나 worker violation으로 바꾸지 않는다.

Advisors는 보조 정보원이며 plan/edge를 직접 편집하거나 worker를 할당할 수 없다.
초기 plan과 exception decision은 기존 `onDecision` 검토를 사용한다(`src/advisor/engine.ts:92`–`:114`).
정상 complete가 coordinator 호출을 하지 않아도 before_complete advisor hook 자체를 생략하면 안 된다.
Runtime terminal gate에 동일 hook을 연결하되 concern NOTE만으로 coordinator를 매번 호출하지 않는다.
구체적 plan-invalidated/blocker signal이면 위 예외 경로로 한 번 합친다; advisory 최종 판단 권한은 coordinator에 남긴다.
Pending advisor settle 시간도 overall cap에 포함하고 advisor failure 정책은 기존과 같게 기록한다.

Records는 기존 opt-in을 유지한다(`src/orchestration/run/types.ts:63`–`:69`).
Warm checkpoint는 memory에, durable checkpoint/handoff artifact는 records enabled일 때 workspace 밖에 저장한다.
Records off이면 process 재시작 복구 불가를 명시한다; persistence 실패 시 durable resume 가능하다고 표시하지 않는다.
기존 CoordinatorEvent와 manager usage를 유지한다(`src/orchestration/events.ts:9`–`:66`).
신규 event는 모두 runId/planId/revision/nodeId/assignmentId 등 필요한 correlation과 단조 sequence를 가진다.

| 신규 event | 핵심 내용 |
|---|---|
| dag_planned / dag_validated | 계획 hash, expanded 크기, validation 결과 |
| dag_node_state_changed | from/to, round/attempt, reason, worker identity |
| dag_edge_materialized / dag_handoff_delivered | edge id, payload ref/hash/bytes, target assignment |
| dag_failure_routed | issue ids, target logical owners, skipped fix nodes |
| dag_budget_consumed / dag_budget_exhausted | budget 종류, delta, 누적/상한 |
| dag_exception / dag_plan_patched | trigger, frozen frontier, old/new revision |
| dag_checkpointed / dag_resumed | checkpoint id, preserved/invalidation frontier, warm/cold |
| dag_stale_outcome_ignored | late assignment correlation, 무시 이유 |

큰 payload/코드/로그는 event에 복제하지 않고 refs만 넣어 prompt와 audit 재구성을 가능하게 한다.
Event delivery와 payload persistence 실패를 구분하고 terminal checkpoint는 atomic rename으로 쓴다.
Worker session별 누적 요청은 resume segment 간 중복 집계하지 않고 request identity/segment delta를 사용한다.
RunReport에는 optional `dag` metadata와 resume lineage를 추가하되 legacy tasks/summary도 호환 projection으로 제공한다.

### 4.11 Limits / config / compatibility

제안 opt-in은 `orchestration: { dag: true }`이고 기본값은 false다.
현재 `RouteConfig`에는 이 키가 없고 unknown field를 거부한다(`src/orchestration/routing.ts:15`–`:35`, `:59`).
따라서 설정 예시를 오늘 바로 넣으면 오류이며 구현 단계에서 parser와 config discovery를 함께 확장한다.
`src/extension/config.ts:142`–`:157`의 extension-only config 분리와 route parser 전달도 테스트한다.
CLI/API와 extension은 같은 옵션을 resolve하고 API override > config > default 순서를 명시한다.

새 caps 제안: maxNodes=128, maxEdges=512, maxAssignments=256, maxCoordinatorReentries=2, maxHandoffBytes=32KiB.
이는 hard safety bound의 초기 후보이며 benchmark에서 payload·확장 규모를 측정해 조정한다.
Repair maxRounds는 기존 limits.maxFixRounds를 넘지 못하며 global maxFixRoundsTotal도 별도로 제한한다.
Plan에 더 큰 숫자를 적었다고 config/RunOptions 권한이 늘어나지 않는다.
각 cap의 0·음수·fraction·overflow 의미는 schema에서 고정한다; 0은 무제한 표기가 아니다.

Default false에서는 기존 answer/change/diagnose_fix, records, single fast path와 결과 계약이 그대로 동작해야 한다.
DAG true인 1-worker change도 첫 rollout은 기존 fast path를 유지하고, 공통 runner 통합은 별도 측정 후 한다.
DAG true인 answer는 legacy 경로임을 기록한다. DAG-only resume과 기존 worker handover는 구분해서 표시한다.
계획 검증 실패 후 **쓰기가 시작된 실행을 legacy로 자동 fallback하지 않는다**; 중복 작업·audit 단절을 방지한다.
DAG 코드 기본 활성화는 parallel3 및 후속 DAG A/B를 통과하기 전 승인하지 않는다.

## 5. 실패 시나리오와 처리

| 시나리오 | 분류 / 처리 | 보존·재개 범위 | Coordinator |
|---|---|---|---|
| Unknown dependency / cycle / 과도한 unroll | invalid plan; dispatch 전에 bounded repair | 아직 변경 없음 | 초기 repair만 |
| Verify false, 소유권 명확 | planned failure edge → owner fix → reverify | 성공 implement 유지 | 호출 없음 |
| Multi-owner issue | 같은 issue id를 관련 fix에 복제, barrier | 파일별 scope 유지 | 호출 없음 |
| Unowned/fileless issue 또는 새 요구사항 | plan invalidated; branch freeze | 무관한 성공 branch 보존 | patch/fail |
| Fix blocked | 더 이상 verify하지 않음 | partial diff와 동일 owner context 보존 | patch/resume/fail |
| N번 fix 후에도 verify false | budget exhausted; 자동 추가 round 금지 | 마지막 검증·issue ledger 보존 | caller 승인 범위 내 판단 |
| RESULT malformed / passed 모순 | 같은 turn repair; 계속 실패면 invalid result | 노드 succeeded 금지 | terminal exception |
| Provider 오류/no_result | infra failed; 명시적 retry cap·settle 확인 | 같은 node 새 attempt | retry 불가 시 예외 |
| Node timeout, 다른 worker만 활동 | 해당 node 연장 거부 | 실패 branch 정지 | overall 남을 때만 예외 |
| User cancel / hard overall 만료 | 즉시 freeze, abort, bounded cleanup | diff 자동 rollback 안 함 | 호출 없음 |
| 늦거나 중복된 outcome | assignmentId/epoch/revision mismatch 무시 | 현재 attempt만 유효 | 호출 없음 |
| Verifier bash가 소스 변경 | audit violation, 성공 publish 금지 | 변경·증거는 실패 report | 자동 승인 금지 |
| 외부 session 변경 | external로 기록, 영향을 검사 | 외부 파일 restore 금지 | plan 무효화일 때만 |
| Resume worker TTL/재사용/lease 충돌 | stale checkpoint 거부 | 남은 결과·worker 위치 표시 | 자동 신규 worker 생성 안 함 |
| Records 실패 / non-git workspace | warm only 또는 검증 가능한 상태만 진행 | durable resume 불가 표시 | plan 유효성 실패 때만 |
| Payload 과대 / artifact 누락 | ref fallback; 필수 이슈 누락이면 정지 | 원본 RESULT 유지 | prompt-too-large 예외 |

## 6. 구현 단계

이 표는 **향후 구현 계획**이며 이번 작업에서 수정할 파일 목록이 아니다.
규모는 production + tests의 신규/변경 LOC 추정, 난이도·확정 effort 약속이 아니다.
Parallel3 gate 이전에는 추가 runtime 구현에 착수하지 않는다.

| 단계 | 파일 / 변경 | 추정 규모 | 단계별 테스트 / 완료 기준 |
|---|---|---:|---|
| 0. 계측 검토·gate | 로컬 parallel3 report/metrics, benchmark 분석 | 분석 1–2일; source 0 LOC | arm identity·parity·complete timing·paired 결과 검토 |
| 1. Schema·순수 compiler | 신규 `src/orchestration/dag.ts`, 기존 `backlog.ts`, `phases.ts`, `result-schemas.ts` | 500–800 LOC + 400–600 test | cycle/ownership/limits/expansion/property tests; legacy transition 무변경 |
| 2. Handoff·result binding | `prompts.ts`, `run/context.ts`, `run/types.ts`, `agent/agent-handle.ts`, `agent/agent-manager.ts` | 350–600 + 300–450 test | assignment-local schema, 5필드, fan-in, JSON injection, old result 호환 |
| 3. Opt-in scheduler·repair | 신규 `run/dag.ts`, `coordinator.ts`, `run/decisions.ts`, `run/change.ts`, `run/audit.ts`, `run/activity.ts`, `run/deadline.ts`, `run/extension.ts` | 700–1,100 + 600–900 test | normal 0 재판단, failure routing, audit cut, cancellation, stale outcome |
| 4. Config·events·advisor | `routing.ts`, `limits.ts`, `events.ts`, `extension/config.ts`, `extension/controller.ts`, `extension/progress.ts`, `extension/records.ts`, `advisor/engine.ts` | 300–500 + 300–500 test | false default, caps/parser, terminal advisor gate, records round-trip |
| 5. Warm resume·pool lease | `run/types.ts`, `coordinator.ts`, `extension/workers.ts`, `extension/index.ts`, `extension/mode.ts`, `agent/agent-manager.ts`; 신규 checkpoint module | 500–800 + 500–750 test | W remap, lease/TTL, budget continuity, preserved nodes, multi-mode permission |
| 6. 측정·rollout | benchmark harness의 별도 snapshot, 사용자 docs | 분석 2–3일 + 문서 100–200 LOC | legacy↔DAG paired A/B, hard6 회귀, default 변경 여부 별도 승인 |

각 단계는 legacy suite를 계속 통과하고 opt-in behavior를 분리한 상태로 리뷰한다.
예외 patch/resume validation을 먼저 순수 함수로 완성하고, worker I/O보다 앞서 테스트한다.
Cold resume과 incremental audit는 위 추정에서 제외하며 별도 설계/측정 없이는 범위를 늘리지 않는다.

## 7. 테스트 계획: faux-provider scenarios

기존 faux runtime을 사용한다(`test/helpers/faux.ts:11`–`:28`).
현재 single-fast-path 테스트는 coordinator callCount=1과 동일 A1/V1 재사용을 검증한다.
근거: `test/orchestration/single-worker-change.test.ts:34`–`:65`.
Handover 테스트는 session identity 보존과 cancellation 시 hook 미호출을 검증한다.
근거: `test/orchestration/run-handover.test.ts:21`–`:79`.
이 보장은 DAG에서도 유지해야 하며 real provider/네트워크 없이 event trace로 확인한다.

1. **Chain:** I1 결과 후 I2 prompt에 다섯 handoff 필드와 원문 acceptance가 정확히 존재.
2. **Fork/join:** 독립 I1/I2 overlap; V는 둘 다 audit 완료 후 실행, 누락/중복 결과 없이 fan-in.
3. **Same owner:** dependency 없는 두 노드도 같은 owner에는 동시에 할당되지 않음.
4. **Verify success:** classify+plan 뒤 coordinator callCount 증가 없음; 최종 summary에 실제 evidence 포함.
5. **Planned repair:** V0 false → A1 fix, A2 skip → V1 true; 다른 owner의 issues가 섞이지 않음.
6. **Multi-owner issue:** 두 fix 모두 참여, 둘 다 완료 전 reverify 금지; 동일 issue id는 보존.
7. **Budget:** N=0/N=1, global fix cap, infra retry cap, assignment cap 경계에서 추가 dispatch 없음.
8. **Invalid plan:** duplicate/self-cycle/unknown owner/unowned fix/root overlap/무검증 terminal 거부.
9. **Blocked patch:** initial success node 유지, 한 exception decision으로 변경 frontier만 재실행.
10. **Result repair:** missing status/evidence 모순을 report_result turn에서 수정하고 invalid edge 미생성.
11. **Stale outcome:** 이전 attempt/plan revision/worker rename 결과로 후속 edge가 열리지 않음.
12. **Deadline race:** fake clock에서 overall/node 동시 만료·extension 1회·cancel 우선·무활동 node 종료.
13. **Audit:** temp git repo에서 bash unowned 변경, symlink escape, ignored output, verifier mutation 검출.
14. **Concurrent audit:** 긴 sibling writer와 짧은 writer completion이 겹쳐 attribution reset/오탐이 없음.
15. **External change:** user/다른 session 변경은 보존, 영향을 받은 digest만 invalidation.
16. **Warm resume:** A1→W1 같은 session, 성공 노드 assign 0회, 실패 node 새 assignmentId/epoch.
17. **Resume safety:** missing worker/TTL/다른 과제 수행/중복 lease/취소 checkpoint를 명시적으로 거부.
18. **Budget continuity:** resume마다 overall·extension·request 누적 budget이 재설정되지 않음.
19. **Records:** checkpoint/event/payload hash 재구성; records off·실패·truncated stream은 unknown 표시.
20. **Advisor:** before_complete 유지, concern만으로 호출 증가 없음, evidenced invalidation은 한 번 escalation.
21. **Prompt security:** handoff의 가짜 system/assignment/host path가 ownership/dispatch를 바꾸지 못함.
22. **Compatibility:** flag absent/false의 legacy 경로, one-worker fast path, answer/diagnose calls 그대로.

Faux 응답의 완료 순서를 permutation하여 readiness와 terminal state의 불변성을 검증한다.
실패 branch round마다 plan/edge 수가 bounded이며 한 edge가 최대 한 번 publish되는 property도 검사한다.
실제 shell/audit 테스트는 별도 temp workspace를 사용하고 benchmark의 진행 중 workspace를 건드리지 않는다.

## 8. 측정 계획과 go/no-go 기준

### 8.1 Pending parallel3와 데이터 유효성

Parallel3는 실행 중으로 최종 승패가 없다. 확인한 report는 5/45 observed, finished=0이다(`results/compare/parallel3-2026-10-03/report.md:3`).
단일 in-flight 요청/비용이나 smoke 성능으로 gate를 통과했다고 판단하지 않는다.
과제/arm/반복 matrix 근거는 `results/compare/parallel3-2026-10-03/README.md:5`–`:11`이다.

- `fixtures/suite/p1-ticket-batch`: csv/ratelimit/cache/semver 독립 기능.
- `fixtures/suite/p2-handler-migration`: 여러 handler의 병렬 migration.
- `fixtures/suite/p3-library-features-ko`: interval/cron/merge, 한국어 요구사항 보존.
- 3과제 × 5arm × 3반복 = 45실행; 주요 비교는 multi vs end-to-end single vs direct.
- `orche-single`이 end-to-end인지 prompt/assignment identity로 확인한다(`results/compare/parallel3-2026-10-03/README.md:40`).

최종 report를 같은 frozen snapshot/hash로 갱신한 후 multi/single/direct 각각 9개 terminal 결과를 요구한다.
Timeout/solver error는 terminal 실패로 포함하고 중단·미완료는 missing으로 표시하여 gate를 보류한다.
Solver done, grade pass, provider/tool parity를 함께 요구하며 visible/hidden unit coverage도 따로 표시한다.
Unknown usage를 0으로 취급하지 않고 비용 결정이 임계값에 걸리면 복구 분석까지 HOLD한다.
레코드 timing이 완전한 multi 실행이 8/9 미만이면 overlap/coordinator 효과 판단을 보류한다.

### 8.2 지표 정의

Report가 제공하는 worker busy/overlap, coordinator share, replans/fixes를 그대로 활용한다.
근거: `results/compare/parallel3-2026-10-03/README.md:68`–`:72`, `results/compare/parallel3-2026-10-03/report.md:54`–`:56`.
`Σ busy / solver wall`은 worker 평균 동시성의 지표이며 그 자체가 CPU 병렬성/속도 이득은 아니다.
Explorer/verifier도 포함하므로 source events에서 implement/fix overlap도 분리 집계한다.

- **Pass rate:** terminal run 중 done+grade+parity의 비율; task별 repeat count도 함께 비교.
- **Wall:** 실패 포함 solver wall의 task별 평균을 equal-task 평균; median/max도 같이 보고.
- **비용:** solver input/output/cache별 가격 고정, judge 제외; 평균/성공당 총비용 모두 비교.
- **Overlap:** max busy workers, Σ worker busy/wall, 최소 두 writer가 겹친 실행 수.
- **Coordinator share:** coordinator requests/provider-boundary 전체 requests; main/advisor를 별도 표시.
  Report의 “excludes main” 설명과 계산식은 불일치한다. 실제 분모는 main 포함 total이며 numerator만 coordinator다.
  근거: `results/compare/parallel3-2026-10-03/analyze.ts:81`–`:85`, `:127`; 설명 오류는 문서에서만 지적한다.
- **회복:** orche_run call 수, phase 결정, fix/replan 횟수, 새 worker/session 수, resume lineage.

Task cluster가 3개여서 bootstrap 일반화는 약하다. Matched task/repeat의 equal-task paired delta와 95% CI를 보조 자료로 제시하고 한 과제의 우연한 이득을 검사한다.
근거 방식: `results/compare/parallel3-2026-10-03/report.md:72`–`:74`.

### 8.3 Gate A: DAG 구현 착수

아래는 결과를 보기 **전** 고정한 기준이며, 모두 만족해야 GO다.

| 항목 | GO 기준 | 이유 |
|---|---|---|
| 품질 | multi ≥ 8/9, single/direct보다 통과 수 적지 않음; 각 task에서도 성공 수 감소 없음 | 1회 실패가 11.1%p인 작은 표본에서 품질 희생을 허용하지 않음 |
| 시간 vs single | equal-task mean wall ≤ single의 80%; 최소 2/3 task에서 더 빠름 | 최소 20% 이득이 복잡성·운영 비용을 정당화해야 함 |
| 시간 vs direct | mean wall ≤ direct의 110%; 어느 task도 direct의 150% 초과하지 않음 | 이미 더 빠른 direct 대비 심한 regression이면 multi 투자 근거가 약함 |
| 비용 | 평균 및 성공당 비용 모두 single의 1.5배 이하, direct의 2배 이하 | latency 개선에 제한적 premium만 허용; hard6의 큰 비용 격차 방지 |
| 실제 병렬성 | timing-complete multi의 Σ busy/wall median ≥ 1.5, max busy ≥ 2가 6/9 이상 | multi라는 이름만 있고 실질 직렬 실행인 상태 제외 |
| Writer overlap | implement/fix 둘 이상 실제 overlap이 전체 6/9 이상, task별 최소 2/3 | 탐색 fan-out만으로 overlap 수치가 높아지는 착시 제외 |
| Coordinator 몫 | 요청 비중 ≤ 15%; single/direct의 coordinator=0을 확인; removable 호출/critical-path 시간을 분리 | worker 재읽기 중심 비용을 coordinator 개선으로 오인하지 않음 |
| 신뢰성 | ownership violation 0, unknown/timing/parity가 위 유효성 기준 만족 | 빠른 오작동/누락 계측을 성능 승리로 인정하지 않음 |

같거나 더 높은 pass rate에서만 시간/비용 기준을 적용한다. 20%는 잡음보다 큰 실용적 이득을 요구한다.
1.5×/2× 비용은 parallel latency를 사는 한계이며 보편적 가격 정책이 아니다.
Coordinator share 15%는 타깃을 제한하는 진단 cap이지 DAG 절감률 목표가 아니다.
제거 가능한 coordinator critical-path가 5% 미만이어도 resume 필요성이 반복 실패 trace로 증명되면 GO 가능하다.
그 경우 착수 목적은 속도가 아니라 회복/감사이고, 더 큰 속도 개선을 약속하지 않는다.

유효한 완료 결과가 어느 기준이든 실패하면 **NO-GO**, missing/unknown/identity 오류면 **HOLD**다.
분석 복구 후 같은 기준으로 재판정한다. NO-GO에서는 decomposition/요구사항/재읽기를 별도 가설로 연구하되 DAG 성과로 섞지 않는다.
어느 경우에도 legacy default를 유지한다.

### 8.4 Gate B: DAG opt-in 유지 / default 전환

Gate A 후 frozen fixtures에서 legacy-multi vs DAG-multi paired A/B를 한다. 모델/thinking/tools/limits/원문/provider 부하를 맞추고 최초 terminal attempt를 primary로 쓴다.
Task당 최소 5반복을 확보하며 fault-injected verify 실패·warm resume는 일반 성능과 별도 보고한다.

- Pass rate와 task별 success는 legacy 이상, ownership/cancellation/resume safety regression은 0이어야 한다.
- 정상 실행의 coordinator **plan 이후 호출=0**, budget 내 fix에도 0, 예외에만 bounded re-entry임을 검증한다.
- Plan 초기 prompt 증가를 포함한 total requests/cost가 legacy보다 5% 이상 나빠지면 default 전환하지 않는다.
- 자연 실패 표본에서 wall 10% 이상 개선 또는 resume의 재탐색/성공노드 재할당 제거를 입증한다.
- Fault-injected resume는 성공 implement 재할당=0, 동일 session 재사용, failing frontier만 진행해야 한다.
- 1-worker fast path와 answer 품질/시간은 별도 regression arm으로 확인한다.
- Hard6를 재측정하되 “DAG만으로 33분→7분” 같은 목표를 설정하지 않는다.
- 소수 task의 통과만으로 default를 켜지 않고 다양한 병렬 task와 운영 trace를 추가해 별도 승인한다.

## 9. 리스크와 미해결 질문

1. **정적 계획의 정확성:** 구현 중 계약이 바뀌면 사전 정책이 부족할 수 있다. Unowned/new-scope issue를 억지 routing하지 않고 예외로 분리한다.
2. **DAG 명칭:** 실제 graph는 bounded expansion으로 acyclic이다. Template id와 expanded node id/round를 UI·records에서 구분한다.
3. **Ownership 보수성:** 다른 owner의 같은 파일 순차 편집은 첫 버전에서 지원하지 않는다. 한 owner에 묶는 병렬성 손실을 측정한다.
4. **Audit cut 지연:** 긴 sibling이 handoff를 지연시킬 수 있다. Tracker를 node마다 초기화하지 않는 안전성이 속도보다 우선이다.
5. **Payload 신뢰:** ranges/contracts는 self-report이며 code truth가 아니다. Snapshot drift·rename/binary 표기와 독립 verification이 필요하다.
6. **원문 요구사항:** 첫 briefing은 이미 존재한다. 의미 손실·edge case는 남으며 d1 attempts-counter 원인도 stale report 갱신 후 별도 확정해야 한다.
7. **Worker 수명:** pool TTL·reload·다른 follow-up이 warm resume을 깨뜨릴 수 있다. Lease TTL과 사용자에게 보여줄 보존 기한을 정해야 한다.
8. **Strict multi 복구:** 현재 orche_task 금지와 인계 정책이 만난다. Resume 전용 권한 또는 mode 전환 요구 정책을 정해야 한다.
9. **Advisor terminal gate:** 기존 검토를 유지하면서 정상 왕복을 없애야 한다. Plan-invalidated signal 계약과 중복 escalation dedupe가 필요하다.
10. **한도 연속성:** assignment counter와 누적 ledger를 분리하지 않으면 resume로 cap을 우회한다. 유료 token cap 추가는 별도 정책이다.
11. **Cold resume:** records로 진행 중 tool의 side effect를 exactly-once 복구할 수 없다. 첫 버전은 warm only, crash는 수동 복구다.
12. **측정 불확실성:** local report 일부가 stale이고 parallel3는 미완료다. Gate 전에는 성능 개선이나 구현 우선순위의 확정 근거가 아니다.

최종 결정: parallel3 gate를 먼저 판정하고, 통과하면 opt-in으로 schema → handoff → scheduler → resume 순서로 구현한다.
Worker self-routing은 채택하지 않는다. Coordinator가 계획을 소유하고 runtime이 실행·실패·감사를 소유한다.
