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
- 최신 이미지부터 연속된 구간을 보존한다. 예산에 못 들어간 중간 이미지를 건너뛰고 더 오래된 이미지를 되살리지 않는다.
- 가장 최신 이미지 1장은 크기와 무관하게 보존한다. 현재 관측까지 버려 화면을 보지 못한 채 조작하게 하지 않는다.
- 오래된 이미지 블록만 안내문으로 대체한다. 도구 텍스트·저장 경로·오류 플래그·호출 인자·순서·assistant 텍스트는 유지한다.
- 사용자 첨부 이미지는 건드리지 않는다.
- 변경된 prefix 뒤의 reasoning은 서명 안전성을 위해 요청에서 제외한다. 함께 묶인 Responses item ID는 제거하되 call ID와 대응 tool result는 유지한다.
- 안내문은 저장 이미지를 다시 읽거나 새로 관측하라고 한다. 스크린샷을 되찾으려고 클릭·게시 같은 **상태 변경 작업을 반복하지 말라**고 명시한다.
- 원본 agent state와 session JSONL은 변경하지 않는다. raw 이미지·reasoning은 기록에 남는다.
- 별도 누적 index state가 없어 compaction·재개 후에도 현재 transcript로 다시 계산한다.

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
- 오래된 이미지가 모델 입력에서 빠지며 prefix cache hit도 줄어들 수 있다. 원본 기록을 보존하고 최신 관측·텍스트 근거를 유지하는 대가로 요청 크기를 제한한다.
- 자동 provider 재시도, 도구 재실행, GUI 세션 재생성은 추가하지 않았다.

## 검증

- `test/pi/image-context.test.ts`: 개수/바이트 경계, 77장 재현, 최신 이미지 보존, 이미지-only/multi-image 결과, 사용자 첨부 보존, 서명/반복 ID, frozen 원본, 재개/rebase, assignment 정리와의 합성.
- `test/pi/image-context-session.test.ts`: 실제 Pi worker/faux provider의 한 assignment 여러 요청에 매번 적용, raw state/JSONL 보존, 전체 기록 재개.
- `test/pi/image-context-provider.test.ts`: 실제 Responses/Codex/Anthropic body serializer의 이미지 개수와 call/result pairing. transport 직전에 중단하므로 유료 호출은 없다. 서버 측 acceptance 검증은 아니다.
