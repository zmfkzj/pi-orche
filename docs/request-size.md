# `Request exceeds the maximum size`: worker 이미지 요청 예산

## 관측한 원인 (2026-10-09)

긴 GUI assignment에서 `Codex error: Request exceeds the maximum size`가 발생했다.
실패 직전까지 해당 assignment에서 도구 이미지 **77장**, base64 **33,211,888 bytes**가 쌓였다.
마지막 성공 응답의 사용량은 약 299k tokens였고, 그동안 compaction은 없었다.
CLIProxyAPI의 Codex Responses 경로를 쓰므로 Claude 모델에서도 오류 접두사가 `Codex error`일 수 있다.

토큰 context window와 직렬화된 요청의 바이트 제한은 별개다. 이미지 토큰 추정치가 작아도
base64 원문은 매 요청의 body에 들어간다. 기존 `taskContext` 정리는 **assignment 시작 전** 결과만
줄이므로, 한 assignment 안에서 계속 쌓이는 스크린샷은 줄이지 못했다.
서버의 정확한 최대 바이트 수는 확인하지 않았으며, 이 오류를 모두 토큰 초과로 분류하지 않는다.

## 방어

`src/pi/image-context.ts`를 `src/pi/session-factory.ts`의 `context` hook에 연결했다.
모든 orche factory worker에서 **매 요청**, 기존 assignment projection **다음**에 적용한다.
assignment 정리가 꺼져 있거나 compaction을 사용하지 않는 worker에도 적용된다.

- 최신 도구 이미지 **최대 8장 / base64 합계 8 MiB**를 보낸다. 둘 중 먼저 닿는 제한을 적용한다.
- **배치 정리(2026-11-12, change #2)**: 한도를 넘으면 매 요청 한 장씩 밀어내지 않고(rolling) **최신 4장 / 4 MiB**(`keepImages`/`keepBase64Bytes`)만 남기고 한 번에 정리한다. 그 뒤 새 이미지가 다시 8장/8 MiB에 닿을 때까지 정리 지점이 고정되어 prompt prefix가 유지된다. 정리 지점은 현재 transcript만으로 계산하는 순수 함수(`keptImageStart`)라 재개·rebase 뒤에도 같다. keep=max이면 기존 rolling과 같다. 실제 GUI transcript 재생과 live 이미지 과제 결과는 [stage-eval.md](stage-eval.md).
- 최신 이미지부터 연속된 구간을 보존한다. 예산에 못 들어간 중간 이미지를 건너뛰고 더 오래된 이미지를 되살리지 않는다.
- 가장 최신 이미지 1장은 크기와 무관하게 보존한다. 현재 관측까지 버려 화면을 보지 못한 채 조작하게 하지 않는다.
- 오래된 이미지 블록만 안내문으로 대체한다. 도구 텍스트·저장 경로·오류 플래그·호출 인자·순서·assistant 텍스트는 유지한다.
- 사용자 첨부 이미지는 건드리지 않는다.
- 변경된 prefix 뒤의 reasoning은 서명 안전성을 위해 요청에서 제외한다. 함께 묶인 Responses item ID는 제거하되 call ID와 대응 tool result는 유지한다.
- 안내문은 저장 이미지를 다시 읽거나 새로 관측하라고 한다. 스크린샷을 되찾으려고 클릭·게시 같은 **상태 변경 작업을 반복하지 말라**고 명시한다.
- 원본 agent state와 session JSONL은 변경하지 않는다. raw 이미지·reasoning은 기록에 남는다.
- 별도 누적 index state가 없어 compaction·재개 후에도 현재 transcript로 다시 계산한다.
- **정리 지점 cache anchor(2026-11-25)**: Pi의 Anthropic adapter는 system·마지막 tool·마지막 message 블록에만 `cache_control`을 둔다. 정리 요청은 가장 오래 남은 이미지의 결과부터 바뀌는데 그 위치에는 cache entry가 없어서, 정리할 때마다 system·tool 뒤의 대화 전체를 다시 썼다(2026-11-18~25 세션: 정리 요청 1,239회 중 96.4%가 miss, cacheWrite 196.5M = 전체의 61%). 이제 매 요청 `planImageContext`가 **가장 오래 남은 이미지 결과 바로 앞의 tool result**를 anchor로 정하고, worker hygiene의 `before_provider_request`(`src/pi/cache-anchor.ts`)가 Anthropic Messages body의 그 `tool_result` 블록에 Pi 마커의 복사본(같은 TTL)을 하나 더 붙인다. 정리 사이의 요청들이 그 entry를 읽어 갱신하고, 다음 정리는 anchor까지를 cache에서 읽는다. 마커가 이미 4개(OAuth 배치)이거나 캐시가 꺼진 요청(마커 0개)에는 붙이지 않는다. provider가 `A maximum of 4 blocks with cache_control` 오류를 내면 그 session에서 anchor를 끈다. Responses·Completions body는 바꾸지 않는다.
- **기회적 정리(rebase, 2026-11-25)**: compaction이나 assignment 정리가 어차피 요청을 다시 쓰는 시점에는, 다시 쓰이는 구간 뒤에 있는 남은 이미지를 low-water(4장/4 MiB)까지 함께 줄여 다음 유료 정리를 늦춘다. compaction은 transcript의 compaction summary와 남은 메시지의 timestamp로(`compactionRebase`), assignment 정리는 새로 정리한 경계마다 projector가 기록한 `{before, from}`으로 계산한다(`createAssignmentProjector().imageRebases`, compaction 때 reset). 다시 쓰이지 않는 앞부분의 이미지는 줄이지 않는다. 8장/8 MiB 상한과 최신 이미지 1장 예외는 그대로다.

실패 기록을 로컬에서 재생해 assignment 정리 뒤 이 projection을 적용하면 이미지가
**77장 / 33,211,888 bytes → 8장 / 2,739,488 bytes**로 줄었다.
이 수치는 이미지 데이터 크기이며 네트워크 요청 전체를 캡처하거나 실제 provider에 재전송한 결과가 아니다.

## 적용과 임시 대응

1. 실행 중인 GUI worker가 로그인 상태를 가지고 있다면 **중간에 `/reload`·종료·새 worker 교체를 하지 않는다**.
   소스 변경만으로 이미 로드된 worker에 hot patch가 적용되지는 않는다.
2. 구버전 worker가 이 오류로 멈췄다면 같은 worker에 **짧은 새 assignment**로 남은 작업을 이어가게 한다.
   기존 assignment-boundary 정리가 이전 스크린샷을 줄이는 임시 대응이다. 작업 재수행 전 실제 상태를 확인해 게시·결제 등의 중복을 막는다.
3. GUI 작업과 필요한 인증 후속이 끝나면 패키지를 업데이트하고 `/reload`하거나 Pi를 재시작한다.
   그 뒤 생성되는 worker부터 새 방어를 사용한다.
4. 메인 Pi 세션 자체가 커진 경우 `/compact`를 사용할 수 있지만, 메인 compaction이 별도 worker transcript를 줄이지는 않는다.

## 범위와 한계

- 이 방어는 **누적 도구 이미지** 문제를 해결한다. 최신 이미지 하나가 지나치게 크거나 사용자 첨부·도구 스키마·텍스트만으로 요청이 커진 경우에는 별도 축소가 필요하다.
- main/direct Pi 세션에는 이 worker factory hook이 적용되지 않는다.
- 오래된 이미지가 모델 입력에서 빠지며 prefix cache hit도 줄어들 수 있다. 원본 기록을 보존하고 최신 관측·텍스트 근거를 유지하는 대가로 요청 크기를 제한한다. 배치 정리는 이 손실을 정리 시점에만 생기게 하지만, 정리 직후에는 최소 4장만 남아 시각 문맥이 rolling보다 적다.
- 자동 provider 재시도, 도구 재실행, GUI 세션 재생성은 추가하지 않았다.

## 검증

- `test/pi/image-cache-anchor.test.ts`: low-water trim(개수·바이트), anchor 위치와 "다음 정리는 이전 anchor 뒤에서만 바뀐다" 속성(개수·바이트 정리, multi-image, reasoning), 반복 call ID, compaction/assignment rebase, raw history 불변, 실제 Pi Anthropic serializer body에 마커 추가(TTL 복사, 4개 한도, 캐시 off, OAuth, Responses body 무시).
- `test/pi/image-cache-anchor-session.test.ts`: loopback Anthropic 서버로 실제 worker session의 wire body를 검사한다. 정리 2회 모두 이전 anchor까지의 블록이 같고, 마커는 4개 이하이며, 한도 오류 뒤에는 anchor를 붙이지 않는다.

### Live gate (2026-11-25, 로컬 CLIProxyAPI `/v1/messages`, `claude-opus-5-5`)

Pi와 같은 마커 배치(tool·system·마지막 `tool_result`)에, 시험 쪽에만 앞쪽 `tool_result` anchor를 하나 더 둔 요청을 보냈다. anchor와 끝 사이에는 블록 54개가 있어 끝 마커의 20-block lookback이 anchor 위치에 닿지 않는다. 각 쪽은 새 무작위 prefix를 쓰고 cold → 동일 반복 → anchor 바로 뒤 블록 변경 순서로 보냈다(scratch `live_anchor_gate.py`).

| arm | cold write | 동일 반복 read | anchor 뒤 변경: read / write |
|---|---|---|---|
| anchor 없음 | 70,082 | 70,082 | 28,183 / 33,155 |
| anchor 있음 | 70,365 | 70,365 | **42,161 / 19,462** |

proxy는 다섯 번째 마커를 거부하지 않고 통과시켰으며, anchor 위치까지(≈+14k) cache read가 유지됐다. 기록된 write는 모두 `ephemeral_1h`였다. anchor 없이 읽힌 28k는 proxy 쪽이 첫 user 메시지까지 캐시한 결과로 보인다. 같은 조건에서 `tool_result` 안쪽 content 블록에 마커를 두면 proxy가 마커를 더해 `Found 5` 오류가 났다. 그래서 anchor는 top-level `tool_result` 블록에만 붙인다.

이번 주 GUI transcript 3개를 `experiments/stage-eval/image-replay.ts`로 재생하면(1,613 요청), batch-8-4의 uncached 추정치가 lookback 모델 56.5M에서 anchor 모델 5.0M으로 줄었다(낙관 모델 하한 4.99M).

- `test/pi/image-context.test.ts`: 개수/바이트 경계, 77장 재현, 최신 이미지 보존, 이미지-only/multi-image 결과, 사용자 첨부 보존, 서명/반복 ID, frozen 원본, 재개/rebase, assignment 정리와의 합성.
- `test/pi/image-context-session.test.ts`: 실제 Pi worker/faux provider의 한 assignment 여러 요청에 매번 적용, raw state/JSONL 보존, 전체 기록 재개.
- `test/pi/image-context-provider.test.ts`: 실제 Responses/Codex/Anthropic body serializer의 이미지 개수와 call/result pairing. transport 직전에 중단하므로 유료 호출은 없다. 서버 측 acceptance 검증은 아니다.
