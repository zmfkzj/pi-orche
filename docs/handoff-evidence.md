# 인계 증거 측정과 verifier 원문 전달

2026-11-15. ToolTurns(arXiv:2611.14925)의 Checker–Fixer를 pi-orche 인계에 적용하자는 제안을 검토한 뒤 정한 순서를 따랐다. 순서는 (1) 실제 기록으로 인계 손실을 먼저 측정하고, (2) 근거가 있는 결정적·비차단 개선만 넣고, (3) 의미 탐지는 측정이 필요를 보일 때만 하는 것이다. 자동 Fixer(요구사항을 다시 쓰거나, 의역하거나, 지우는 것)는 범위 밖이다.

## 1. 결론

- **측정 결과 (§3).** 대화형 세션에서 main이 Original request 섹션을 넣은 인계는 새 사용자 메시지를 거의 모두 원문 그대로 전달했다(1,336건 중 1,328건). 나머지 8건은 사람이 직접 확인했고 모두 무해했다. 의미 손실을 사람이 확정한 사례는 0건이다. 다만 아래 (2)~(4)는 측정하지 못했으므로 손실이 없다는 뜻은 아니다.
  - 결과까지 따라간 영향은 판정하지 않았다.
  - 교체·ledger 인수 사례는 기록에 없다.
  - worker compaction이 무엇을 복원했는지는 기록에 남지 않는다.
- **구현 (§4, 실험 옵션, 기본 꺼짐).** 측정에서 지시와 실제가 어긋난 곳은 하나뿐이다. orchestrator 지시문은 새 verifier에게 "original request"를 주라고 하는데, 대화형 verify sub-worker 요청 116건 중 사용자 원문을 그대로 담은 것은 32건이었다. 그래서 `"single": { "verifierOriginal": true }`를 켜면, verification 라운드의 verify sub-worker 요청에 orchestrator assignment의 Original request가 원문 그대로 없을 때 orche가 그 섹션을 근거로 덧붙인다(`verifierOriginalBlock`). 실제 모델 A/B에서 정확도 개선이 확인되지 않아(§4) 기본값은 꺼짐(`false`)이다.
  - 요청 본문은 바꾸지 않는다.
  - 수락 기준은 orchestrator의 것으로 그대로 남는다.
  - 덧붙인 원문은 권한을 주지 않는다.
- **보류 (§5).** 다음 세 가지는 근거가 부족해 넣지 않았다.
  - main 쪽 결정적 알림
  - 의미 탐지(LLM)
  - 탐지 후 수정

## 2. 측정 도구

```bash
npx tsx experiments/handoff-audit/cli.ts \
  [--sessions ~/.pi/agent/sessions] [--records ~/.pi/agent/orche/records] \
  [--out summary.json] [--suspects locations.json] [--active-minutes 30]
```

- **입력.** 두 종류의 기록을 읽는다.
  - main 기록: Pi 세션 JSONL.
  - worker 기록: `records/<세션>/workers/*.jsonl`. plan advisor 기록(`.advisor-`)은 뺀다.
- **출력은 집계만이다.** 메시지 원문은 출력하지 않는다.
  - `--suspects`에는 사람이 확인할 위치(파일 이름, entry id, 신호)만 적는다.
  - 오류가 나면 오류 종류만 출력한다.
  - 테스트(`test/experiments/handoff-audit.test.ts`)가 stdout·suspects 파일·오류 출력에 원문이 섞이지 않는지 확인한다.
- **분석 단위는 도구 호출 하나다.**
  - main 기록에서는 `orche_task` 호출 하나, worker 기록에서는 `orche_spawn` 요청 하나가 단위다. tool call id로 중복을 없애므로, 같은 transcript를 여러 run.json이 가리키거나 세션이 fork돼도 두 번 세지 않는다.
  - "이전 인계 이후의 사용자 메시지"는 그 호출이 속한 branch의 조상을 `parentId`로 거슬러 올라가며 모은다. 파일상 바로 앞 줄로 정하지 않는다.
  - 분석에서 빼는 호출을 따로 센다.
    - 오류로 거부돼 worker가 돌지 않은 호출(`rejected`)
    - 결과가 없는 호출(`noResult`: 중단됐거나 아직 실행 중)
    - 파싱하지 못한 줄과 잘린 마지막 줄
    - 최근 30분 안에 바뀐 파일(`possiblyActive`, 실행 중일 수 있음)
- **상황 분류.** 배타적인 분류 다섯 개에 교차 태그 두 개를 더한다.
  - `first`: worker를 지정하지 않은 새 worker.
  - `follow-up`: 살아 있는 worker를 지정한 경우.
  - `handover`: 사라진 worker를 지정한 경우. 판정 근거는 이 branch의 `orche-worker` 기록 또는 결과의 "was gone" 문구다.
  - `ledger-takeover`: worker 없이 `task`를 지정한 경우.
  - `replacement-after-unmet`: 직전 결과에 "unmet in N consecutive assignments" 알림이 있었고 worker 없이 새로 맡긴 경우.
  - 교차 태그 `afterMainCompaction`: 그 branch에서 main compaction이 한 번이라도 있었다.
  - 교차 태그 `compactedBetween`: 최신 사용자 메시지와 인계 사이에 main compaction이 있었다.
- **세션 출처.** agent_workflow가 띄운 세션(세션 id `aw-…`)은 생성된 프롬프트가 사용자 메시지 자리에 들어간다. 이런 세션은 `automated`로 따로 집계한다.
- **결정적 신호.** 신호이지 판정이 아니다.
  - **신호 종류.** 세 가지를 센다.
    - Original request 섹션이 있는지
    - 새 사용자 메시지가 인계(request + context)에 어느 정도 그대로 들어 있는지(`userTextCarry`): verbatim / partial / absent / no-text
    - 중복 선언된 R-id(`duplicateRequirementIds`)
  - **비교 전에 빼는 것.** 펼쳐진 skill 본문, Pi가 붙이는 이미지 크기 안내, 인용 표시(`>`)는 사용자 말이 아니므로 비교하지 않는다.
  - **partial 기준.** 문장·줄 단위로 비교하고, 원문에서 그대로 찾은 글자 비율이 절반 이상이면 partial이다.
- **이전 인계 이후 더 앞선 사용자 메시지의 분류.**
  - carried: 인계에 들어 있음
  - relayed: `orche_task_message`로 실행 중인 worker에게 전달됨
  - answeredWithoutTools: main이 도구 없이 답함(질문·상태 확인)
  - unexplained: 위 어디에도 해당하지 않음. 사람이 확인할 후보일 뿐 손실이라는 뜻은 아니다.

## 3. 측정 결과 (2026-11-15 13:21 UTC)

**입력**
- main 기록 750개, worker 기록 1,710개
- 파싱 실패 9줄(파일 5개), 잘린 마지막 줄 0개, 최근 30분 안에 바뀐 파일 16개

### 3.1 main → worker 인계 (대화형 세션)

- **호출 수.** `orche_task` 호출은 2,049건이다. 거부 143건, 결과 없음 43건을 빼면 전달된 인계는 1,863건이다.

| 상황 | 인계 | R-id 있음 | Original 섹션 | 새 사용자 메시지 없음 | 새 메시지 verbatim / partial / absent / no-text (Original 있는 인계만) |
|---|---:|---:|---:|---:|---|
| first | 451 | 350 | 377 | 118 | 279 / 3 / 0 / 1 |
| follow-up | 1,060 | 940 | 1,018 | 340 | 709 / 2 / 0 / 1 |
| handover | 352 | 352 | 352 | 9 | 340 / 2 / 1 / 0 |
| ledger-takeover | 0 | | | | |
| replacement-after-unmet | 0 | | | | |

- **Original 섹션이 있는 인계의 전달률.** 텍스트가 있는 새 메시지 1,336건 중 1,328건(99.4%)이 원문 그대로 들어 있었다.
- **나머지 8건은 사람이 확인했다.** 메시지 앞부분과 인계만 보고 개인 기록 안에서 확인했고, 결과는 분류만 남긴다. 8건 모두 손실이 아니다.
  - 7건: 거의 원문 그대로였다. 원문에서 그대로 찾은 비율이 84~100%이며, 다른 부분은 markdown escape, 빠진 `@파일` 접두, 긴 붙여넣기의 공백·줄바꿈 차이다.
  - 1건: 사용자 오타를 고쳐 인용했다.
- **Original 섹션이 없는 인계는 116건이다.** first 74건, follow-up 42건이다. 이 섹션을 요구하는 지침이 생기기 전 기록이거나 direct 모드 기록이다. 이 인계에서 새 메시지가 absent로 나온 것은 대부분 "진행", "네"처럼 앞선 대화를 가리키는 짧은 승인이다.
- **중복 R-id 선언**은 1,863건 중 1건이었다.
- **이전 인계 이후 더 앞선 사용자 메시지**는 163개였다.
  - 인계에 들어 있음 22, `orche_task_message`로 전달 18, main이 도구 없이 답함 46, 설명되지 않음 77
  - 설명되지 않은 77개는 인계 49건에 걸쳐 있다. 이 49건을 메시지 앞부분으로 사람이 분류했다.

| 분류 | 인계 |
|---|---:|
| 상태 확인, 질문, "재개", "continue"처럼 과제 내용이 아닌 것 | 18 |
| 다른 경로로 처리됨(다른 세션에 보내라는 지시, main이 직접 한 커밋 등) | 8 |
| 앞선 논의를 승인하거나 재진술한 맥락: 인계가 의역으로 담았는지 결정적으로는 알 수 없음 | 22 |
| 앞서 사용자가 준 권한보다 인계가 좁음(권한 축소, 의도로 보이나 판정 못 함) | 1 |

- **22건 중 2건은 인계 본문까지 읽었다.**
  - 1건: 의역으로 정확히 담겨 있었다.
  - 1건: 이미 다른 assignment에서 끝난 일이었다.
  - 나머지 20건과 권한 축소 1건은 **판정하지 않았다**(대화형 인계 1,863건의 1.1%).
- **결과 영향.** 결과에 영향을 준 손실로 확인한 사례는 없다. 다만 결과까지 따라가지 않았으므로 "손실 없음"을 증명한 것은 아니다.
- **main compaction 뒤의 인계는 37건뿐이다**(compaction이 있었던 세션 2개).
  - 31건은 원문 그대로였고, 6건은 새 사용자 메시지가 없었다.
  - 최신 사용자 메시지와 인계 사이에 compaction이 끼어든 사례(`compactedBetween`)는 0건이다.
  - 표본이 작아 결론을 낼 수 없다.

### 3.2 main → worker 인계 (agent_workflow 자동 세션)

- **호출 수.** `orche_task` 호출은 1,136건이다. 거부 74건, 결과 없음 6건이다.
- **사용자 메시지의 성격.** 대부분 2,000자를 넘는 생성 프롬프트다. 그 안에는 skill 블록과 main에게 하는 지시가 섞여 있다.
- **main이 발췌하는 것은 예상된 동작이다.** 새 메시지가 있는 first 401건 중 원문 그대로 44건, partial 67건, absent 290건이었다. 결정적 신호로는 손실을 판단할 수 없어 판정하지 않았다.

### 3.3 orchestrator → sub-worker (`orche_spawn`)

- **호출 수.** 162회, 요청 328건이다(거부된 호출 14회 제외). 모든 요청에서 부모 assignment를 찾았다. handover나 resume 브리핑이 assignment 앞에 붙어 있어도 찾는다.
- **부모 Original request가 요청에 원문 그대로 들어 있었는지:**

| 출처 | 역할 | 요청 | verbatim | partial | absent |
|---|---|---:|---:|---:|---:|
| 대화형 | verify | 116 | 32 | 5 | 79 |
| 대화형 | implement | 109 | 6 | 16 | 87 |
| 대화형 | answer / game-asset | 9 | 5 | 0 | 4 |
| 자동 | verify | 91 | 0 | 0 | 91 |
| 자동 | implement / answer | 3 | 0 | 0 | 3 |

- **verify 이외의 역할.** 지시문은 사용자 원문을 "where it matters"에만 넣으라고 하므로, absent가 곧 결함은 아니다.
- **verification.** 지시문은 "give the fresh verifier the original request"이다. 그런데 대화형 verify 요청 116건 중 84건(72%)은 원문을 그대로 담지 않았고, 그중 79건(68%)은 절반도 담지 않았다.
  - 많은 경우 orchestrator가 영어로 바꿔 쓴 요약이었다.
  - 그것이 결과를 바꿨는지는 측정하지 않았다.

### 3.4 측정할 수 없었던 것

- **결과 영향.** 신호와 이후 실패·재작업을 잇는 판정이 없다.
- **교체와 ledger 인수.** 기록에 0건이다. ledger는 기본 꺼짐이다.
- **worker compaction이 복원한 내용.** worker transcript에 compaction이 827번 있었다. 하지만 그 essentials(현재·이전 인계, `workers.ts` `taskCompactionFor`)는 context를 다시 만들 때 생성되고 transcript에 저장되지 않는다. 그래서 잘렸는지, 빠졌는지 셀 수 없다.

## 4. 구현: verifier 원문 전달 (opt-in, 기본 꺼짐)

- **켜는 법.** `orche.config.json`(신뢰된 프로젝트 파일, 없으면 사용자 파일)에 `"single": { "verifierOriginal": true }`를 둔다.
  - 기본값은 `false`다. 키가 없거나, `single`이 없거나, 설정 파일이 없어도 꺼져 있다.
  - 불리언이 아닌 값을 넣으면 설정 로드가 실패한다(`config.single.verifierOriginal: expected boolean`).
  - 값은 assignment가 시작될 때 읽는다.
- **꺼져 있을 때.** sub-worker는 orchestrator가 쓴 요청을 그대로 받는다. orchestrator 지시문에도 자동 보충 문장이 들어가지 않는다. 요청에 사용자 원문을 넣는 것은 지시문대로 orchestrator가 한다. 꺼짐은 자동 보충만 끄고, 요청에 이미 들어 있는 사용자 글은 지우지 않는다.
- **위치.**
  - `src/extension/config.ts`: `SingleSettings.verifierOriginal`, `parseSingleConfig`
  - `src/orchestration/handoff-evidence.ts`: `verifierOriginalBlock`
  - `src/extension/workers.ts`: `verifierEvidenceOriginal`, `subWorkerPrompt`와 그 호출부
  - `src/orchestrator/instructions.ts`: `spawnUsage`·`orchestratorSection` 문구(켜졌을 때만)
- **적용 조건 (켜졌을 때).** 다음이 모두 맞을 때만 덧붙인다.
  - `orche_spawn` reason이 `verification`이고 역할이 `verify`다.
  - ultra가 아니다. ultra는 단계별로 verifier에게 따로 브리핑한다.
  - orchestrator assignment에 Original request 섹션이 있다.
  - verifier 요청이 그 섹션을 원문 그대로 담고 있지 않다. partial도 덧붙이는 대상이다.
- **덧붙이는 내용.** 요청 뒤에 `## The user's original request (verbatim, appended by orche)` 섹션을 붙인다.
  - 이 섹션에는 원문이 판단 기준이 아니라 근거라는 문장이 함께 붙는다. 수락 기준은 요청에 있는 것이고, 원문은 의미를 정할 때만 쓰며 범위를 넓히지도 권한을 주지도 않는다.
  - 원문이 8,000자를 넘으면 자르고, 몇 자를 보이지 않았는지 표시한다.
- **바꾸지 않는 것.**
  - 요청 본문, R-id, 수락 기준, 권한.
  - 다른 sub-worker(parallelism, isolation).
  - main → worker 인계.
  - 간결한 후속 인계와 worker 재사용.
- **후속 assignment에서 덧붙는 것.** 후속 assignment의 Original request는 그 회차의 새 사용자 메시지다. 그래서 verifier에게 덧붙는 것도 그 메시지뿐이다. 이전 회차 원문은 orchestrator가 요청에 직접 담아야 한다.
- **효과 측정 (2026-11-15, 실제 모델 A/B, `experiments/verifier-original-ab/README.md`).** 합성 통제 사례 72개(시나리오 44개)를 사용자의 verifier 모델(`cliproxyapi/claude-opus-5-5`, high)과 실제 sub-worker runner로 돌렸다. 두 arm은 이 보충의 유무만 다르다.
  - **판정 정확도가 의미 있게 개선되지 않았다.** balanced accuracy는 +1.4%p(98% CI −6.2~+9.6)이고, 모두 맞게 판정한 횟수는 OFF 152/176, ON 151/176이다.
  - **verifier가 더 엄격해진다.** 놓친 위반은 8/74에서 2/74로 줄고, 정상 작업을 잘못 불합격시킨 경우는 16/102에서 23/102로 늘었다. 둘 다 98%에서 유의하지 않다.
  - **사전등록 규칙의 최종 판정은 INCONCLUSIVE다.** 오불합격 증가를 최대 16.7%p까지 배제하지 못했기 때문이다.
  - **효과가 나타난 곳.** 도움이 된 것은 사용자 말에만 있던 조건을 새 코드가 어긴 경우다. 해가 된 것은 사용자가 도중에 철회한 조건을 다시 요구한 경우와, 사용자 표현을 지나치게 엄격하게 읽은 경우다.
  - **일반화 범위.** 이 결과는 통제 벤치마크다. 실제 배포에서의 작업 성공률을 측정한 것이 아니다.
  - **결정 (2026-11-15).** 이 결과에 따라 보충을 opt-in 실험 옵션(`single.verifierOriginal`)으로 바꾸고 기본값을 껐다. 켜는 경우의 동작은 A/B에서 측정한 것과 같다. 블록 제목의 "verbatim" 표기 문제(main의 섹션이 발췌일 수 있음)는 고치지 않았다.

## 5. 보류한 것과 다시 볼 조건

- **main 쪽 결정적 알림.** 예: "최신 메시지가 원문 그대로 없다", "Original 섹션이 없다", "중복 R-id".
  - 보류 이유: 실제 기록에서 이 알림이 걸렸을 사례가 Original 있는 인계 8건, 중복 R-id 1건이었고, 8건 모두 무해했다. 정밀도가 0인 알림은 main context만 늘린다.
  - 다시 볼 조건: 결과를 바꾼 인계 손실이 실제로 확인될 때.
- **의미 탐지(LLM)와 탐지 후 수정.**
  - 보류 이유:
    - 확정된 손실 사례가 없다.
    - 판정하지 못한 후보가 1.1%(21건)이고, 라벨을 붙인 평가 집합이 없다.
    - 과거 v2 Framer 실패(docs/specialist-orchestration.md 502–503: 해석 권한, 탐지 ≠ 결정)가 수정 위험을 직접 보여 준다.
  - 다시 볼 조건 (다음 중 하나라도):
    - 판정 못 한 21건이나 새 기록을 사람이 라벨링했을 때, 결과를 바꾼 손실이 유의미한 비율로 나온다.
    - 교체·ledger 인수·`compactedBetween` 사례가 쌓여 그 경로의 손실을 측정할 수 있다.
  - 다시 하더라도 탐지만 한다. 근거 인용을 필수로 하고, 결과는 "손실 의심 / 판정 불가"로 내며, 해결은 기존 소유자(main 또는 worker)가 한다.

## 6. 평가 사례와 비교 기준

`experiments/handoff-audit/cases.ts`에는 **합성** 사례 14개가 있다. 사람이 쓰고 정답 라벨을 붙인 것이며, 관측된 실패가 아니다.

- **사례 구성.**
  - 정상 의역(번역), 간결한 후속, 사용자가 승인한 철회
  - 실제 누락, 앞선 메시지의 제약 유실, R-line 왜곡
  - 이미지만 있는 메시지, 잘린 붙여넣기
  - handover, unmet 뒤 교체, main compaction 뒤, 원문 없는 verifier
- **정책별 결과.** `evaluatePolicies()` 출력이며, 테스트가 이 값을 고정한다.

| 정책 | TP | FP | FN | TN | 판정 불가 3건 중 신호 |
|---|---:|---:|---:|---:|---:|
| current (검사 없음) | 0 | 0 | 5 | 6 | 0 |
| deterministic | 4 | 2 | 1 | 4 | 1 |
| semantic detection | 실행 안 함 | | | | |
| detection + fix | 구현 안 함(범위 밖) | | | | |

- **이 표가 보여 주는 결정적 신호의 한계.**
  - 정상 번역과 승인된 철회를 손실로 잡는다(FP).
  - 원문은 그대로 인용하고 R-line만 약하게 바꾼 왜곡은 놓친다(FN).
  - "앞선 메시지 누락"이라는 신호 하나로는 승인된 철회와 실제 유실을 구분하지 못한다.
- **실기록 비교를 다시 한다면.**
  - 같은 표본에 정책 네 가지를 적용한다: 현행 / 결정적 / 의미 탐지 / 탐지+수정.
  - 사람 라벨을 정답으로 쓰고, 아래 지표를 분모와 함께 보고한다.
    - 정밀도
    - 재현율
    - 정상 인계 오탐률
    - 해로운 수정률(철회된 제약을 되살린 경우 포함)
    - 판정 불가 비율
    - 인계당 비용
  - 이 작업(2026-11-15 첫 번째)에서는 모델을 쓰는 실험을 돌리지 않았다. 이후 verifier 보충 자체의 효과는 `experiments/verifier-original-ab/`에서 실제 모델로 측정했다(§4). 탐지 정책에 대한 위 비교는 여전히 실행하지 않았다.

## 7. 재현

- **측정.** `npx tsx experiments/handoff-audit/cli.ts --out <scratch>/summary.json`
  - 기록이 계속 쌓이므로 다시 돌리면 숫자가 달라진다.
- **테스트.** `npx vitest run test/orchestration/handoff-evidence.test.ts test/experiments/handoff-audit.test.ts`
- **사람 확인.** `--suspects` 파일의 위치를 보고 개인 기록 안에서만 했다. 기록 원문은 저장소에 남기지 않는다.
