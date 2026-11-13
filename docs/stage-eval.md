# Stage evaluation (2026-11-12): 순수 Pi / direct / single ± advisor, 이후 #2·#5·#6·#7 누적 적용

요청: "현시점 다음을 평가 1. 확장 없는 순수 Pi 2. orche direct 3. 현재 single + advisor off 4. 현재 single + advisor on. 이후 2,5,6,7 적용하며 평가 진행."
하네스 `experiments/stage-eval/`, 결과 `results/stage-eval/`. 비용은 사용자 카탈로그(`~/.pi/agent/cliproxyapi-models.json`) 단가로 계산한
추정치이며 구독 청구액이 아니다. 성공은 모두 **primary success** = terminal `done` ∧ 독립 grader 통과 ∧ 기존 테스트 무결성 위반 없음.

## 0. 현재 제품 상태 (2026-11-13)

평가 후 사용자가 **#2와 #6만 유지**하기로 했다. 현재 제품(`src/`)에 남은 것:

- #2 이미지 일괄 정리: `src/pi/image-context.ts`, `docs/request-size.md`, 테스트 `test/pi/image-context.test.ts`·`test/pi/image-context-session.test.ts`.
- #6 테스트 출력 축소(진단 보존): `src/tools/output-filter.ts`, `docs/tools.md` Tests 항목, 테스트 `test/tools/output-filter.test.ts`.

**제거됨**(실험 전용, 현재 제품 동작 아님):

- #5 `regression_check` 도구·`REGRESSION_RULE`·시작 상태 캡처(S7b 수정본 포함). `src/tools/regression-check.ts`와 그 테스트, `src/extension/workers.ts`의 등록·guard·record 필드를 지웠다.
- #7 `AMBIGUITY_RULE`(편집 전 수락 기준·material ambiguity 기록)과 main의 인계 전 material ambiguity 규칙(`src/extension/mode.ts`). 평가 이전부터 있던 모호성 처리(Original request와 지정 출처로 결정, `data.ambiguities`/`data.unresolved`), 요구별 확인과 worker의 acceptance 소유는 그대로다.

제거된 코드는 동결된 runtime(`results/stage-eval/main/runtimes/<label>/src/`와 `product.diff`: #5는 S5·S6·S7·S7b, #7은 S7·S7b)과 커밋 `a1b21cc`에만 남는다.
아래 §1–§8은 2026-11-12 평가 기록이며 당시 상태를 그대로 보존한다(실패·음성 run 포함). §3의 "최종 누적"(S7b)과 §5의 현재형 설명은
당시 평가 runtime의 동작이다. S5–S7b plan을 다시 돌리면 이 동결 runtime을
쓰므로(`experiments/stage-eval/env.ts` `frozenRuntime`, 다른 tree에서 같은 label 재동결은 거부) 제거된 동작을 재현할 뿐 현재 제품을 측정하지 않는다.
`driver.ts freeze <out> <label>`은 **현재 작업 트리**를 동결하므로 지금 새 label로 동결하면 #5·#7이 없는 제품이 된다. 과거 단계의 재현에는
반드시 기존 동결본(`results/stage-eval/main/runtimes/*`)을 쓴다. 현재 제품(#2+#6)을 하나의 단계로 평가한 run은 없다.
S6(= #2+#5+#6)이 가장 가깝지만 #5를 포함한다.

## 1. 결론

- **기준선(4 arm × 8 과제 × 3회 = 96 run, $69.61)**: 성공률은 A 순수 Pi 11/24, B direct 13/24, C single(advisor off) 10/24,
  D single(advisor on) 12/24로 구별되지 않는다(과제 쌍 bootstrap CI가 모두 0을 포함, sign test p ≥ 0.5). 성공당 비용은 A $0.86,
  B $0.76, C $2.13, D $2.42이고 run당 비용 비율은 A→B 1.05, A→C 2.26 [CI 0.32–0.69 $/run 증가], A→D 3.09, C→D 1.37이다.
  현재 single은 순수 Pi보다 성공률 이득 없이 2–3배 비싸다(이 8과제에서). advisor는 run당 $0.32 더 들고 +8.3pp(2/0 과제)였다.
- **#2 이미지 일괄 정리(8→4)**: 실제 GUI transcript 31개 오프라인 재생에서 prefix 파괴 1,796→437, lookback 모델 비캐시 비율
  0.24→0.059. 16프레임 live 이미지 과제(C vs S2, 각 8회)에서 성공 8/8 = 8/8, cache hit 0.682→0.792(차 +0.110, 95% CI
  [0.032, 0.181]), 캐시 miss 요청 6.1→1.25/run(CI [−7.5, −2.25]), run당 비용 −$0.126(CI [−0.324, 0.069], 유의하지 않음).
- **#5 시작 상태 대비 회귀 비교**: 성공률·비용 개선은 측정되지 않았다(C→S5 +4.2pp, CI [−8.3, 16.7]; 비용 1.14배). live 판정
  35건 중 13건이 REGRESSIONS였고 재생해 보니 대부분 거짓 양성(시간값 파라미터 id, docs 줄번호 id, `-x` 미도달)이어서 도구를
  두 번 고쳤다(§5). 최종 수정본(S7b) live 판정: regressions 4, inconclusive 1, clean 29(이전 단계 12–16 / 2–4 / 18–21).
- **#6 테스트 출력 축소**: 기존 필터는 진단 줄은 거의 지켰지만(226/226) 진단 아닌 맥락 줄을 대부분 버렸다(재읽기 사례 388/15,161 유지).
  수정본은 13,136/15,161 유지, 재읽기가 여전히 필요한 사례 116→11(오프라인 corpus). live에서 축소 후 artifact 재읽기 2–4건(C, D, S5)
  → 0건(S6, S7, S7b). 성공률은 S5→S6 −4.2pp(CI [−29.2, 20.8])로 구별되지 않는다.
- **#7 조기 모호성·수락 기준**: S7 이후 worker의 task_plan node note에 수락 기준 48/62건, 모호성 16/33건이 기록됐다(S5·S6 0건).
  성공률 변화는 S6→S7 0pp. 최종 누적(S7b) vs 기준 C: +4.2pp(CI [0.0, 12.5], 1/0 과제), 비용 1.18배(CI [0.041, 0.338] $/run 증가).
- **종합**: 네 변경 모두 성공률 개선은 **검증되지 않았다**(표본 8과제×3회의 검정력 한계 포함). #2의 캐시 효과와 #6의 재읽기 감소,
  #5 수정본의 거짓 REGRESSIONS 감소, #7의 수락 기준 기록은 측정된 행동 변화다. 비용은 누적으로 C 대비 18% 늘었다.

## 2. 설계

| 항목 | 값 |
|---|---|
| 기준 revision | HEAD `51e7e936ddb4d78db8b769187a4ca1e29d252ca9`, 제품 diff 없음 (`results/stage-eval/main/runtimes/baseline/REVISION.json`, digest `1c386fc4…`) |
| Pi | `/home/arthur/.bun/bin/pi` 1.5.2 (본실험 전 arm). pilot만 npx 경유 1.5.0 |
| 모델 | `cliproxyapi/claude-opus-5-5`, thinking high (main·worker 모두). advisor `cliproxyapi/gpt-6-astra` high (사용자 config와 같음) |
| A 순수 Pi | `--no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files` + provider bundle만. 요청별 도구 목록 = read,bash,edit,write, orche marker 없음, agent dir에 orche config·auth 없음 (wire log로 확인) |
| B direct | 같은 플래그 + frozen orche runtime, `orche.config.json` mode direct |
| C/D single | 실제 `pi` CLI에 사용자 메시지로 과제를 넣어 main → `orche_task` → worker(→ advisor) 경로를 그대로 탄다. `advisor-reviewer/run-one.ts`(main 없이 WorkerPool 직접 호출)는 쓰지 않았다 |
| 의도한 차이 | orche arm만 Bash safety review(제품 기본값, `typesafe/jev-latest`) 자격 증명을 받는다 |
| 과제 | suite 2(d8-build-graph, d1-transactional-outbox) + SWE 6(sqlfluff-7615, docstub-123, tox-3904, pypa/build-1027, mtplx-21, stravalib-709). 비천장 과제와 기존 테스트 회귀에 민감한 과제를 포함. 이미지 과제 1(16프레임 콘솔 녹화, 정답 report.json) |
| 프롬프트 | 모든 arm 동일(과제별 prompt.txt md5 1종). 고정 무인 clarification policy: "Nobody can answer questions during this run: … choose the reading best supported…, state it…" (`experiments/stage-eval/protocol.ts:69`). 제품의 질문 동작(#7)과 분리됨 |
| 채점 | 숨은 테스트 + 기존 테스트 + 무결성 검사(`experiments/ultra-ab/env.ts` grader), 에이전트에 보이지 않음. leak audit: 모든 hit는 과제 문서의 URL 문자열이거나 차단된 `pip download`(wrapper가 "pip is disabled" 반환) |
| 회계 | 모든 역할(main, worker, advisor, compaction 포함)의 요청을 run별 로깅 proxy가 기록(`wire.jsonl`). uncached = input − cached, reasoning ⊂ output(더하지 않음). infra 재시도와 중단 시도도 비용에 합산 |
| 제한 | run당 guard, infra 재시도 1회, phase별 maxRuns·budgetUsd(완료 비용 기준 **신규 시작 차단**이므로 진행 중인 run이 상한을 넘을 수 있음: admission budget이지 지출 상한이 아님) |

환경: SWE venv는 `experiments/stage-eval/envbuild.ts`로 저장소 밖에 다시 만들고(Python 3.14.4, task.json의 기대 버전과 일치 검사,
설치 패키지·source digest를 BUILD.json에 기록, 실패 시 exit 1) `experiments/ultra-ab/validate.ts`로 검증했다(시작 상태 실패, 정답 통과,
변조 탐지, wrapper가 수정된 workspace를 import: VALIDATION OK; 재개 후 재검증 `results/stage-eval/main/env-revalidation-W3.json`).

## 3. 단계와 revision

| 단계 | runtime | 내용 | revision digest |
|---|---|---|---|
| baseline | `runtimes/baseline` | HEAD 그대로 | `1c386fc4813c` |
| S2 | `runtimes/s2` | #2 이미지 일괄 정리 | `78607f45090a` |
| S5 | `runtimes/s5` | + #5 `regression_check` | `2d1248ecb8b7` |
| S6 | `runtimes/s6` | + #6 출력 축소 | `acd79ac6a1af` |
| S7 | `runtimes/s7` | + #7 모호성·수락 기준 + #5 1차 수정(pytest `-rfEsxXp`, 시간값 파라미터 짝짓기, `-x`·pipe·한쪽 파싱 inconclusive, 출력 head+tail) | `f7929105920e` |
| S7b | `runtimes/s7b` | + #5 2차 수정(§5) — 최종 누적 | `e8e5999ed2a5` |

각 runtime 디렉터리에 `REVISION.json`(HEAD, dirty 목록, 파일별 sha256)과 `product.diff`가 있다. 커밋은 하지 않았다.
S7과 S7b의 차이는 `src/tools/regression-check.ts` 한 파일이다.

## 4. 결과 (8 SWE/suite 과제, `results/stage-eval/main/summary-final.md`)

| arm | runs | 성공 | grade 통과 | 비용 $ | $/성공 | uncached/성공 | cached/성공 | output/성공 | wall/성공 s | req/run | cache hit | 무결성 위반 run |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A 순수 Pi | 24 | 11 | 11 | 9.41 | 0.855 | 56k | 855k | 23k | 518 | 16.0 | 0.938 | 0 |
| B direct | 24 | 13 | 13 | 9.91 | 0.762 | 51k | 971k | 18k | 494 | 18.1 | 0.950 | 0 |
| C single | 24 | 10 | 13 | 21.25 | 2.125 | 145k | 2633k | 51k | 989 | 28.7 | 0.948 | 3 |
| D single+advisor | 24 | 12 | 15 | 29.04 | 2.420 | 158k | 2271k | 48k | 885 | 35.1 | 0.935 | 4 |
| S5 | 24 | 11 | 15 | 24.21 | 2.201 | 137k | 3146k | 51k | 1407 | 33.9 | 0.958 | 4 |
| S6 | 24 | 10 | 13 | 21.54 | 2.154 | 136k | 2857k | 52k | 1324 | 30.2 | 0.954 | 3 |
| S7 | 24 (+8 infra 시도, $0) | 10 | 14 | 22.68 | 2.268 | 145k | 3090k | 54k | 1231 | 31.3 | 0.955 | 4 |
| S7b | 24 | 11 | 15 | 25.16 | 2.287 | 155k | 3097k | 52k | 779 | 32.6 | 0.952 | 4 |

역할별 비용: D의 advisor $7.08(136 요청) = D 비용의 24%. single arm의 main은 $2.3–2.5, 나머지는 worker. compaction 0회(모든 arm).
grade는 통과했지만 primary가 아닌 run(`g`)은 모두 기존 테스트 파일 수정(pypa/build `tests/test_projectbuilder.py`의 helper 서명,
tox `tests/config/loader/ini/test_factor.py` import)이며 A·B에는 없다.

과제 쌍 비교(Y−X, 과제 단위 bootstrap 10,000회):

| X → Y | Δ 성공 [95% CI] | 나음/나쁨 과제 | 비용 비율 | Δ wall s/run [CI] |
|---|---|---|---:|---|
| A → B | +8.3pp [0.0, 20.8] | 2/0 | 1.05 | +30 [2, 61] |
| A → C | −4.2pp [−33.3, 25.0] | 2/2 | 2.26 | +175 [107, 266] |
| A → D | +4.2pp [−16.7, 25.0] | 2/2 | 3.09 | +205 [120, 314] |
| C → D | +8.3pp [0.0, 20.8] | 2/0 | 1.37 | +31 [−40, 110] |
| C → S5 | +4.2pp [−8.3, 16.7] | 2/1 | 1.14 | +233 [10, 533] |
| S5 → S6 | −4.2pp [−29.2, 20.8] | 1/2 | 0.89 | −93 [−280, 52] |
| S6 → S7 | 0.0pp [−20.8, 16.7] | 2/1 | 1.05 | −40 [−70, −12] |
| S7 → S7b | +4.2pp [−8.3, 16.7] | 2/1 | 1.11 | −155 [−319, −21] |
| C → S7b | +4.2pp [0.0, 12.5] | 1/0 | 1.18 | −55 [−112, −3] |

wall time은 단계 간 비교가 오염돼 있다: baseline은 동시성 8로, S5·S6·S7은 baseline·이미지 phase와 겹쳐 돌았고 S7b는 단독(동시성 3)으로
돌았다. 비용·토큰·성공률은 부하의 영향을 받지 않는다.

과제별(`P` 성공, `f` 실패, `g` grade 통과지만 무결성 위반):

| task | A | B | C | D | S5 | S6 | S7 | S7b |
|---|---|---|---|---|---|---|---|---|
| d1-transactional-outbox | fff | fff | fff | fff | fff | fff | fff | fff |
| d8-build-graph | PPf | PPP | fPP | PfP | PfP | fPP | PfP | PPf |
| pypa__build-1027 | PPP | PPP | gPg | gPP | ggg | PgP | ggg | gPg |
| scientific-python__docstub-123 | fff | fff | fff | fff | fff | fff | fff | fff |
| sqlfluff__sqlfluff-7615 | fff | fff | PPf | fPP | PPP | Pff | PPf | PPP |
| stravalib__stravalib-709_interface | PPP | PPP | PPP | PPP | PPP | PPP | PPP | PPP |
| tox-dev__tox-3904 | PPP | PPP | fgP | PPg | gPP | gPg | PPg | gPg |
| youssofal__mtplx-21 | fff | fPf | ffP | Pgf | Pff | ffP | Pff | fPf |

single 계열은 sqlfluff에서 A·B(0/3)보다 낫고(C 2/3, S5·S7b 3/3), pypa/build·tox에서 기존 테스트 파일 수정으로 primary를 잃는다.
d1·docstub은 모든 arm에서 실패한다(천장 아래의 바닥 과제).

## 5. 단계별 세부

### #2 이미지 일괄 정리 (`src/pi/image-context.ts`, `docs/request-size.md`)
한도(8장/8 MiB)를 넘으면 매 요청 한 장씩 밀지 않고 최신 4장/4 MiB만 남기고 정리 지점을 고정한다(`keptImageStart`, transcript의 순수 함수).
최신 이미지 예외, byte 상한, 불변 history, reasoning 제거와 call/result ID 대응은 기존 projection 그대로이며 테스트가 이를 확인한다
(`test/pi/image-context.test.ts` "keeps all images up to the ceiling, then prunes to the low-water mark…", "equals the rolling window when
keep* equal the ceilings…", "keeps the projected prefix of consecutive requests identical between pruning points", "is a pure function of the
history: … reload, … rebase", "drops reasoning after the earliest omitted image exactly as the rolling window does").

오프라인 재생(`experiments/stage-eval/image-replay.ts`, 실제 GUI worker transcript 31개, 6,452 요청, 이미지 2,394장,
`results/stage-eval/image-replay/replay-sample30.json`):

| 정책 | prefix 파괴 | 비캐시 비율(lookback 20 블록) | 평균 유지 이미지 |
|---|---:|---:|---:|
| rolling-8 (기존) | 1,796 | 0.240 | 7.93 |
| batch-8-6 | 680 | 0.092 | 6.92 |
| batch-8-4 (채택) | 437 | 0.059 | 5.87 |
| batch-8-2 | 318 | 0.044 | 4.76 |

8-2는 시각 맥락을 너무 줄여 8-4를 골랐다. live 이미지 과제 결과는 §1. 이 과제는 16프레임을 모두 읽어야 정답이라 정리가 실제로 일어나지만
(요청 104개 중 76개), 성공률 천장(8/8)이라 시각 맥락 손실의 영향은 이 과제로 판별되지 않는다. 실제 GUI(데스크톱 조작) 과제의
성공률 효과는 측정하지 않았다.

### #5 시작 상태 대비 회귀 비교 (제거됨 2026-11-13; 당시 `src/tools/regression-check.ts`, `docs/tools.md`)
single implement worker에 `regression_check` 도구와 `REGRESSION_RULE`이 붙는다. 할당 시작 시 workspace를 private index로 git tree에
캡처하고, 같은 명령·환경·상대 디렉터리로 시작 상태 사본과 현재 workspace에서 테스트를 돌려 테스트 identity 단위로 새 실패, 시작에
없던 실패 테스트, 기존 실패, 고쳐진 테스트, 사라진 테스트, 새로 skip된 테스트를 나눈다. 삭제·skip·미수집은 통과로 세지 않는다.
판정은 worker의 증거일 뿐 acceptance는 worker가 갖는다.

live 결과와 수정:
- S5(1차본): 35회 호출 중 REGRESSIONS 13. 모델 없는 재생(`experiments/stage-eval/regression-replay.ts`: 시작 상태에 run의 final.diff를
  적용하고 같은 명령을 옛/새 도구로 실행)으로 원인을 확인했다: stravalib은 `test_token_expired[<time.time()>-True]` 같은 시간값 id가
  매번 달라져 "사라짐"으로 잡혔고, pytest `-rA`의 PASSES 섹션이 출력 상한을 넘어 요약이 잘렸으며, `-x`로 멈춘 시작 run에서 미도달
  테스트가 사라짐으로 잡혔다.
- S7(1차 수정): `-rfEsxXp`, 같은 테스트 함수의 비실패 id끼리 짝짓기, `-x`/`--maxfail`/pipe면 사라짐은 inconclusive, 한쪽만 파싱되면
  inconclusive, 출력은 앞 4 MB + 끝 8 MB 유지. 재생 결과 stravalib 10건 regressions→clean (`results/stage-eval/main/regression-replay-fast.json`).
- S7b(2차 수정, 이 재개 작업): tox는 worker가 docs를 고쳐 이미 실패하던 docs 예제 테스트의 줄번호 id가 바뀌어 "시작에 없던 실패"로,
  pypa/build는 `-x` run에서 시작 시 미도달 테스트가 "시작에 없던 실패"로 잡혔다. 이제 실패 id는 실패 id끼리만 짝짓고(통과하던 테스트는
  결코 실패 id를 흡수하지 않음) 그런 짝은 같은 실패라는 증명이 아니므로 다른 소견이 없으면 **inconclusive**로 보고한다. 부분 실행에서
  시작에 없던 실패도 inconclusive이며, 같은 id의 pass→fail은 부분 실행에서도 regressions다. 재생(`regression-replay-fast-v3.json`, 20건):
  stravalib 11건 clean, tox 7건·pypa 1건 regressions→inconclusive, 나머지 clean 유지. 그 run들은 grader의 기존 테스트(p2p)가 모두 통과였다.
- S7b live: 34회 호출 중 regressions 4, inconclusive 1, clean 29.

테스트(제품과 함께 제거, 커밋 `a1b21cc`에 있음): `test/tools/regression-check.test.ts`(파서, 분류, 부분 실행, 한쪽 파싱, 시간값·줄번호 재파라미터화, 다대다·skip, 대형 출력,
실제 git work tree에서 사용자 git 상태를 건드리지 않는 end-to-end), `test/extension/regression-rule.test.ts`.

### #6 테스트 출력 축소 (`src/tools/output-filter.ts`, `docs/tools.md`)
기존 필터가 실패 진단을 이미 대부분 보존한다는 지적(advisor M2)을 먼저 확인했다: 실제 transcript corpus에서 진단 줄 보존은
226/226(재읽기 사례), 2,401/2,557(전체)로 높았다. 손실은 진단이 아닌 맥락 줄(다른 명령 출력, runner header, 줄 단위 문맥)과
대소문자 무시 summary 오인식("tests:" 디렉터리 header, "# Fails…" 주석)이었다. 수정: runner footer는 숫자·시간이 있는 대소문자 구분
패턴만, 통과·진행·TAP bookkeeping 줄만 제거, 축소 효과 20% 미만이면 원문 유지.

오프라인(`experiments/stage-eval/reduction-corpus.ts`, `results/stage-eval/reduction-audit/`): 재읽기 사례 121건에서 비진행 줄 유지
388/15,161 → 13,136/15,161, 재읽기가 여전히 필요한 사례 116 → 11, 출력+재읽기 문자 612,802 → 602,497(추정). 상한: 최대 inline 출력
3,420 → 10,935자로 기존 출력 상한 안이다. live: 축소 후 artifact 재읽기 C 2, D 3, S5 4 → S6 0, S7 0, S7b 0(작은 수).

### #7 조기 모호성·수락 기준 (제거됨 2026-11-13; 당시 `src/extension/workers.ts` `AMBIGUITY_RULE`, `src/extension/mode.ts`, `docs/orchestrator.md`)
implement 지시: 편집 전에 요구별 테스트 가능한 수락 기준과 material ambiguity를 task_plan node note에 적고, 작업 대부분이나 되돌리기
어려운 변경을 좌우하는 모호성만 사용자에게 묻는다(요청에 clarification policy가 있으면 그것을 따른다). main 규칙: 인계 전 material
ambiguity를 이름 붙이고 필요할 때만 한 번에 묻는다. 벤치는 질문이 불가능하므로 모든 arm에 같은 고정 policy를 프롬프트에 넣었고,
그 문장은 baseline 첫 run부터 바뀌지 않았다(hidden answer 없음). 측정: S7·S7b worker plan note에 수락 기준 48·62건, 모호성 16·33건
(S5·S6 0건), blocked 보고 0건. 성공률 효과는 측정되지 않았다(S6→S7 0pp). 테스트(제품과 함께 제거, 커밋 `a1b21cc`에 있음): `test/extension/ambiguity-rule.test.ts`.
제거 후 부재와 기존 모호성 계약 유지는 `test/extension/stage-eval-removed.test.ts`가 확인한다.

## 6. 실행 기록과 회계

| phase | 단위 | 비용 $ | 비고 |
|---|---:|---:|---|
| pilot 시도 1 | – | 미상 | "Config.routes: expected object"로 시작 즉시 실패, 디렉터리 삭제됨(하네스 결함) |
| pilot 시도 2 | 8 (5 완료) | 2.16 | Bash review 자격 증명 누락("Provider is not configured: typesafe"), `results/stage-eval/pilot-attempt2-no-bash-review` 보존 |
| pilot | 8 | 4.19 | 2과제×4arm, 격리·회계·leak·grader 확인. Pi 1.5.0(npx 경유) |
| baseline | 96 | 69.61 | 동시성 8, admission $140 |
| image / image2 | 8 + 8 | 6.07 + 4.67 | C vs S2 각 4회씩 두 번(r1–r4, r5–r8) |
| s5 / s6 | 24 / 24 | 24.21 / 21.54 | |
| s7 | 24 | 20.98 | 2단위가 provider 교체로 infra 실패(아래) |
| s7-resume | 2 | 1.70 | 고정 provider로 재실행 |
| s7b | 24 | 25.16 | admission $28, maxRuns 28, 동시성 3 |
| 합계 | | ≈180.3 | Jev classifier(Bash review) 호출은 proxy를 거치지 않아 **미측정** |

S7 중단과 재개: 2026-11-12T07:06Z에 형제 저장소 `../cliproxyapi`(하네스 기본 provider bundle)가 다른 provider 패키지로 바뀌었다
(working tree, 07:22Z 커밋 8b8a9bf). 새 provider는 run의 private `cliproxyapi.json`이 아니라 `~/.pi/agent/pi-cliproxyapi-provider/config.json`을
읽으므로 격리 agent dir에서는 모델이 없다: `Model "cliproxyapi/claude-opus-5-5" not found`(S7 mtplx r3, stravalib r3 각 2회, $0) →
이전 작업의 "Provider is not configured: cliproxyapi"도 같은 교체가 원인. 전역 설정은 바꾸지 않고, 교체 직전 커밋 ff87b28을 scratch에
풀어 lockfile 그대로 `npm ci --offline`(`@router-for-me/pi-cliproxyapi-provider` 1.4.25, integrity는 `results/stage-eval/main/provider-pin.json`)
하고 `STAGE_EVAL_PROVIDER`로 지정했다(frozen harness `env.ts:23`이 읽는 변수). 같은 모델 id·effort·endpoint(`/backend-api/codex/responses`)로
요청됐음을 wire log로 확인했다. 재개 첫 시도는 이전 scratch의 SWE source 사본이 지워져 있어(`ENOENT …/swe-cache/<id>/src`) 2단위×2회가
$0 infra로 끝났고, source를 복원·재검증한 뒤 `s7-resume` phase로 두 단위만 다시 돌렸다. 실패 시도 8개(각 단위 `r3.infra-1..4`)는 모두
보존되고 analyze가 비용에 합산한다(전부 $0, 모델 요청 0).

## 7. 한계

- 표본: 8과제 × 3회. 과제 단위 bootstrap CI가 넓고 sign test는 어떤 비교에서도 유의하지 않다. 2과제(d1, docstub)는 모든 arm 실패,
  1과제(stravalib)는 모든 arm 성공이라 판별력 있는 과제는 5개다.
- 단계는 직전 단계와 다른 시간에 돌았다(baseline 05:29–06:47Z, S5–S7 05:46–07:12Z 겹침, S7b 08:08–09:00Z). 과제·프롬프트·모델·grader는
  같지만 provider 부하와 provider bundle 경로(S7 r3 두 단위와 S7b는 고정 사본, 나머지는 같은 커밋의 저장소 파일)가 다르다.
- S7b는 #5 수정만 다르지만 S7과 다른 시간대에 돌았으므로 S7→S7b 차이를 #5 수정 효과로 단정할 수 없다.
- #2의 GUI 성공률 효과는 합성 이미지 과제(천장) 하나로만 봤다. 실제 데스크톱 GUI 과제는 돌리지 않았다.
- Bash review(Jev) 비용·지연은 미측정. 추정 비용은 카탈로그 단가 기준.
- 진행 보고(send_message)는 이 작업 환경에 도구가 없어 보내지 못했다.

## 8. 재현

```
npx tsx experiments/stage-eval/envbuild.ts <cache> <task ids…>                          # SWE venv (BUILD.json)
ADVISOR_BENCH_SWE_CACHE=<cache> npx tsx experiments/ultra-ab/validate.ts <out.json> <ids…>  # VALIDATION OK
npx tsx experiments/stage-eval/driver.ts freeze results/stage-eval/main <label>          # runtime 동결
STAGE_EVAL_PROVIDER=<ff87b28 사본>/src/index.ts npx tsx experiments/stage-eval/driver.ts run experiments/stage-eval/plans/<phase>.json
npx tsx experiments/stage-eval/analyze.ts results/stage-eval/main --exclude-tasks img-console-recording \
  --arms A,B,C,D,S5,S6,S7,S7b --pairs A:B,A:C,A:D,C:D,C:S5,S5:S6,S6:S7,S7:S7b,C:S7b,A:S7b --md summary-final.md
python3 experiments/stage-eval/extra-metrics.py results/stage-eval/main --exclude-tasks img-console-recording
ADVISOR_BENCH_SWE_CACHE=<cache> npx tsx experiments/stage-eval/regression-replay.ts results/stage-eval/main \
  results/stage-eval/main/runtimes/s5/src/tools/regression-check.ts results/stage-eval/main/runtimes/s7b/src/tools/regression-check.ts <out.json> --tasks <ids>
# (제거된 #5 도구는 현재 src/에 없다: 재생은 동결 runtime 사본끼리 비교한다. 당시는 두 번째 인자가 작업 트리의 src/tools/regression-check.ts였다)
npx tsx experiments/stage-eval/image-replay.ts <out.json> --sample 60 stage-eval-replay-2026-11-12 ~/.pi/agent/orche/records
```

plan 파일의 `scratch`/`sweCache`는 이 실험의 scratch 경로다. 다른 곳에서 재현하려면 바꿔야 하고, 그러면 plan hash가 달라지므로 새 phase나
새 out 디렉터리를 쓴다.
