# G-I2 investigation 과제 검토표

24과제: 원인 분석 6, repo 질문 5, 기술 비교 4, 아키텍처 평가 4, 반례 판단 5. 함정 8개. 생성: `node experiments/workflow/review-sheet.mjs` (JSON에서 다시 만들어짐; 이 파일을 직접 고치지 말고 체크·메모만).

| id | 범주 | 언어 | 함정 | 결론 기준 |
|---|---|---|---|---|
| i01-rootcause-report-ko | 원인 분석 | ko |  | States the correct report when lowercase error denotes ERROR: total 8, errors 4, error rate 50.00%. |
| i02-refund-explain-ko | repo 질문 | ko |  | Return contains amount and a new invoice object, updating refundedQuantity/refundedAmount; status remains paid |
| i03-router-review | 아키텍처 평가 | en |  | Identify src/middleware.js:13 (readJson) as replacing previously collected body chunks: a valid JSON body spli |
| i04-retry-delays | 원인 분석 | en | 함정 | States the observed delays 0, 2000, 2000 ms and the intended delays 100, 200, 400 ms for three retries. |
| i05-dedupe-window-ko | 원인 분석 | ko |  | States that duplicates are only blocked for about 60 milliseconds (not 60 seconds), so a resend a few seconds  |
| i06-daily-bucket-ko | 원인 분석 | ko | 함정 | Gives the current totals 2026-03-01: 47000, 2026-03-02: 12000 and the correct KST totals 2026-03-01: 30000, 20 |
| i07-stale-profile | 원인 분석 | en | 함정 | States the stale value is served for up to the cache TTL of 5 minutes (300 s), supported by the simulation sho |
| i08-listener-leak | 원인 분석 | en |  | States that the 'config' listener count is 100 after 100 requests (one per request). |
| i09-rbac-export-ko | repo 질문 | ko | 함정 | Concludes mina does NOT have report:export (can returns false). |
| i10-flag-rollout | repo 질문 | en |  | Gives both final answers correctly: u-42 on, u-3 off. |
| i11-config-precedence | repo 질문 | en | 함정 | Concludes the server listens on 8080 (the PORT environment variable wins over --port 9090). |
| i12-job-retry-ko | repo 질문 | ko |  | Answers yes: failed jobs go back to queued only for retryable errors and at most 2 times (3 runs total); other |
| i13-lru-compare | 기술 비교 | en |  | Recommends src/lru-map.js. |
| i14-search-rate-ko | 기술 비교 | ko | 함정 | Concludes that neither function meets the requirement as written; what is needed is a throttle with a trailing |
| i15-clone-switch | 기술 비교 | en |  | Concludes the PR is NOT safe to merge as is (it would throw on every snapshot) unless the function is removed  |
| i16-leaderboard-sort-ko | 기술 비교 | ko |  | Concludes the built-in sort (src/leaderboard.js) satisfies the requirement and quickSortBy does not. |
| i17-order-events-ko | 아키텍처 평가 | ko | 함정 | Concludes the implementation does not meet the requirement and the design doc's exactly-once claim is false; r |
| i18-rate-limit-replicas | 아키텍처 평가 | en |  | Concludes the requirement is not met and recommends a shared limiter (e.g. Redis/central store with atomic cou |
| i19-cache-ttl-ko | 아키텍처 평가 | ko |  | Concludes the premise is wrong and TTL should not simply be raised; suggests mitigations (versioned values / c |
| i20-median-claim | 반례 판단 | en |  | Concludes the claim is false. |
| i21-booking-overlap-ko | 반례 판단 | ko |  | Concludes the reviewer's approval is wrong. |
| i22-split-bill | 반례 판단 | en |  | Concludes the claim is false. |
| i23-unique-by-ko | 반례 판단 | ko | 함정 | Concludes the doc comment does not match the behaviour. |
| i24-semver-compare | 반례 판단 | en |  | Concludes the README claim is false (multi-digit components like 1.10.0 vs 1.9.0 are handled correctly; pre-re |

### i01-rootcause-report-ko — Rootcause Report Ko
- 범주: 원인 분석 · 언어: ko · 함정: 없음
- 검증: 기존 suite 과제(검증된 원본 복사)

**질문 (모델이 받는 그대로)**

> 동봉된 logs/incident.jsonl을 logtool로 집계하면 에러율이 운영팀이 확인한 값보다 낮게 나옵니다. 실행 결과와 로그를 대조해 정확한 원인을 조사하고, 원인이 있는 파일과 함수, 잘못 집계되는 과정, 현재 출력되는 수치와 올바른 수치(전체 건수, 에러 건수, 에러율)를 보고해 주세요. 코드는 수정하지 말고 조사 결과만 답변해 주세요.

**정답 (judge가 보는 reference)**

> 원인은 src/parser.js의 parseLine입니다. LEVELS.has(record.level)이 대소문자를 구분하고, 목록에 없는 문자열 레벨은 INFO로 바꿉니다. logs/incident.jsonl의 소문자 error 두 건(재고 연결 실패와 결제 승인 실패)이 INFO가 됩니다. src/aggregate.js의 aggregate는 level === ERROR인 이벤트만 에러로 세므로 이 두 건은 전체 건수에는 남고 에러 분자에서는 빠집니다. 현재 실행 결과는 전체 8건, 에러 2건, 에러율 25.00%입니다. 소문자 error도 에러로 해석하면 전체 8건, 에러 4건, 에러율 50.00%가 맞습니다. 파일은 수정하지 않았습니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `location`: Identifies src/parser.js parseLine as the cause, specifically the case-sensitive LEVELS.has(record.level) check and fallback to INFO.
- `mechanism`: Explains that the two lowercase error records in logs/incident.jsonl are converted to INFO; src/aggregate.js aggregate only counts level === ERROR, so these events stay in the denominator but not the error numerator.
- `reported`: States the actual current report: total 8, errors 2, error rate 25.00%.
- `correct`: States the correct report when lowercase error denotes ERROR: total 8, errors 4, error rate 50.00%.

- [ ] 승인   - [ ] 수정 필요: 

### i02-refund-explain-ko — 환불 처리 흐름 설명
- 범주: repo 질문 · 언어: ko · 함정: 없음
- 검증: 기존 suite 과제(검증된 원본 복사)

**질문 (모델이 받는 그대로)**

> 환불 처리가 어떻게 동작하는지 한국어로 설명해줘. 진입 함수와 검증 위치, 부분 환불 금액 계산 방식, 환불 가능 기간의 경계, 반올림과 상태 변경, 원본 데이터 변경 여부를 코드에 근거해서 정리해줘. 코드는 수정하지 마.

**정답 (judge가 보는 reference)**

> 환불 진입점은 src/refunds.js의 refundInvoice(invoice, quantity, now)이며, 계산 전에 같은 모듈의 validateRefund를 호출합니다. status가 paid인 청구서만 허용하고, 요청 수량은 양의 정수이며 전체 수량에서 이미 환불한 수량을 뺀 잔여 수량 이하여야 합니다.
기간 검증은 validateRefund에서 now - paidAt > 30 * 86_400_000이면 거부하는 방식입니다. 정확히 30일인 시점은 허용됩니다. now는 호출자가 전달하므로 내부에서 현재 시각을 읽지 않습니다.
부분 환불은 개별 단가를 각각 반올림하지 않습니다. 누적 수량 = refundedQuantity + 요청 수량, 누적 환불액 = roundMoney(paidTotal * 누적 수량 / 전체 quantity)로 구하고 이번 지급액은 roundMoney(누적 환불액 - 기존 refundedAmount)입니다. 예를 들어 10달러를 3개에 나눠 환불하면 3.33, 3.34, 3.33달러가 됩니다.
paidTotal은 requireAmount로 유한한 음이 아닌 값인지 검증합니다. src/money.js의 roundMoney는 Math.round(value * 100) / 100을 사용하며, 누적 환불액과 이번 지급액 모두 센트로 반올림합니다.
결과는 { amount, invoice }입니다. 원본 invoice를 변경하지 않고 새 객체를 만들어 refundedQuantity와 refundedAmount를 누적 값으로 갱신합니다. 누적 수량이 전체 수량에 도달할 때 status는 refunded가 되고, 그 전에는 paid를 유지합니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `entry`: Identify src/refunds.js refundInvoice as the entry point and validateRefund as the validator called before calculation.
- `validation`: Only paid invoices are accepted; quantity must be a positive integer no greater than quantity minus refundedQuantity.
- `window`: src/refunds.js validateRefund rejects when now - paidAt is greater than 30 * 86,400,000 milliseconds; exactly 30 days is accepted, using caller-supplied now.
- `proration`: Partial refunds use cumulative paidTotal * (refundedQuantity + requested quantity) / total quantity, rounded to cents, minus previous refundedAmount; not independent per-unit rounding.
- `rounding`: roundMoney in src/money.js uses Math.round(value * 100) / 100; cumulative amount and the difference are rounded, and paidTotal is validated nonnegative and finite.
- `state`: Return contains amount and a new invoice object, updating refundedQuantity/refundedAmount; status remains paid until all quantity is refunded, then becomes refunded, without mutating original invoice.

- [ ] 승인   - [ ] 수정 필요: 

### i03-router-review — router review
- 범주: 아키텍처 평가 · 언어: en · 함정: 없음
- 검증: 기존 suite 과제(검증된 원본 복사)

**질문 (모델이 받는 그대로)**

> Review src/router.js and src/middleware.js for bugs; list each with file:line and impact; do not change code.

**정답 (judge가 보는 reference)**

> Three bugs: src/router.js:14 compile builds a regex without a $ end anchor; /health/extra matches /health instead of returning 404. src/router.js:26 dispatch iterates routes without a method check; POST /items selects the GET /items handler and never creates an item. src/middleware.js:13 readJson uses chunks.splice(0, chunks.length, chunk), throwing away previous body chunks, so valid multipart/chunked JSON may produce 400 or parse only the final chunk.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `prefix-match`: Identify src/router.js:14 (compile) as missing an end anchor: a route matches extra trailing segments (for example /health/extra), dispatching the wrong handler instead of 404.
- `method-match`: Identify src/router.js:26 or the dispatch loop as not checking route.method against req.method: requests with a different method invoke the first path match, e.g. POST /items invokes GET /items instead of creating an item.
- `chunk-loss`: Identify src/middleware.js:13 (readJson) as replacing previously collected body chunks: a valid JSON body split over chunks is parsed from only its final chunk and can return 400 or lose earlier data.

- [ ] 승인   - [ ] 수정 필요: 

### i04-retry-delays — Retry delays do not grow
- 범주: 원인 분석 · 언어: en · 함정: src/config.js comment suggests the cap is reached early because the base is too high in production (plausible wrong cause: configuration).
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> Our job runner is supposed to retry failed jobs with exponential backoff (100 ms, 200 ms, 400 ms, ... capped at 2 s). Operations reports that the first retry happens immediately and every later retry waits exactly 2 seconds. Find the cause: the file and function, why exactly these delays come out, and what the delays for three retries should be instead. You can run `npm run simulate`. Do not modify any files; report your findings only.

**정답 (judge가 보는 reference)**

> Cause: src/runner.js runJob calls delayFor(config.baseMs, attempt) but delayFor in src/backoff.js is delayFor(attempt, baseMs, capMs). The attempt number becomes the base and baseMs (100) becomes the exponent: attempt 0 gives 0 * 2^100 = 0 ms, attempts 1 and 2 give 1 * 2^100 and 2 * 2^100, clamped to the 2000 ms cap. So the delays are 0, 2000, 2000 ms instead of 100, 200, 400 ms. The cap configuration (RETRY_CAP_MS=2000) is correct; the comment in src/config.js that blames a too-high base is misleading.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `location`: Identifies the call site in src/runner.js runJob, where delayFor is called with its arguments in the wrong order (delayFor(attempt-related value and base swapped), i.e. delayFor(config.baseMs, attempt) instead of delayFor(attempt, config.baseMs, ...)).
- `mechanism`: Explains why that yields 0 for the first retry and the 2000 ms cap afterwards: attempt 0 is passed as the base (0 * 2^100 = 0) and for later retries the base becomes the exponent/attempt is multiplied so the value exceeds the cap and is clamped to capMs.
- `not-config`: Does not blame the configuration (RETRY_CAP_MS / the cap value or the comment in src/config.js) as the cause; the cap is correct and only clamps the wrong value.
- `conclusion`: States the observed delays 0, 2000, 2000 ms and the intended delays 100, 200, 400 ms for three retries.

- [ ] 승인   - [ ] 수정 필요: 

### i05-dedupe-window-ko — 중복 이벤트 차단 실패
- 범주: 원인 분석 · 언어: ko · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 웹훅 이벤트 중복 제거기는 같은 이벤트를 60초 동안 한 번만 처리해야 합니다. 그런데 몇 초 간격으로 재전송된 같은 이벤트가 두 번씩 처리됩니다. 원인을 조사해서 원인 파일과 함수, 왜 차단되지 않는지, 지금 실제로 중복이 차단되는 시간 범위가 얼마인지 보고해 주세요. 코드는 수정하지 말고 조사 결과만 답변해 주세요.

**정답 (judge가 보는 reference)**

> 원인은 src/dedupe.js의 isDuplicate입니다. 경과 시간(Date.now() 차이, 밀리초)을 config의 ttlSeconds(60)와 단위 변환 없이 비교합니다. 그래서 중복 차단 창이 60초가 아니라 60밀리초뿐이고, 몇 초 뒤 재전송된 같은 이벤트는 다시 처리됩니다. 파일은 수정하지 않았습니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `location`: Identifies src/dedupe.js isDuplicate (the comparison of the elapsed time with ttlSeconds).
- `mechanism`: Explains the unit mismatch: Date.now() differences are in milliseconds but are compared against ttlSeconds (60) without converting to milliseconds.
- `conclusion`: States that duplicates are only blocked for about 60 milliseconds (not 60 seconds), so a resend a few seconds later is processed again.

- [ ] 승인   - [ ] 수정 필요: 

### i06-daily-bucket-ko — 월요일 아침 주문이 일요일 보고서에 잡힘
- 범주: 원인 분석 · 언어: ko · 함정: src/report.js comment says createdAt is stored in KST (wrong: data are UTC instants).
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 일별 매출 보고서에서 한국 시간 월요일 오전에 들어온 주문 일부가 일요일 매출로 집계됩니다. data/orders.json으로 `npm run simulate`를 실행하면 재현됩니다. 원인 파일과 함수, 잘못 집계되는 과정, 어떤 시간대의 주문이 영향을 받는지, 그리고 샘플 데이터 기준 현재 출력과 올바른 일별 합계를 보고해 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 원인은 src/report.js의 dayKey입니다. toISOString()은 UTC로 포맷하므로 UTC 날짜로 묶이고, 영업일 기준인 Asia/Seoul(UTC+9) 날짜가 아닙니다. createdAt이 KST로 저장된다는 주석은 사실과 다릅니다. data/orders.json의 값은 Z로 끝나는 UTC 시각입니다. 한국 시간 00:00~09:00의 주문이 전날로 집계됩니다. 샘플 기준 현재 출력은 2026-03-01: 47000, 2026-03-02: 12000이고, 올바른 KST 합계는 2026-03-01: 30000, 2026-03-02: 29000입니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `location`: Identifies src/report.js dayKey (toISOString().slice(0, 10)) as the cause.
- `mechanism`: Explains that toISOString formats in UTC, so the stored UTC instants are bucketed by UTC date instead of the Asia/Seoul (UTC+9) business date.
- `not-storage`: Does not accept the comment in src/report.js claiming createdAt is stored in KST; the data in data/orders.json are UTC instants (ending in Z).
- `window`: States that orders between 00:00 and 09:00 KST are affected (they fall on the previous UTC date).
- `conclusion`: Gives the current totals 2026-03-01: 47000, 2026-03-02: 12000 and the correct KST totals 2026-03-01: 30000, 2026-03-02: 29000.

- [ ] 승인   - [ ] 수정 필요: 

### i07-stale-profile — Profile edits not visible
- 범주: 원인 분석 · 언어: en · 함정: README documents short stale reads; the TTL explanation is plausible but the real cause is a no-op invalidation.
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> After a user updates their display name, the profile page keeps showing the old name for several minutes. The README says reads may be stale for a short time, but product says edits must be visible immediately after saving. Investigate whether this is the expected eventual consistency or a defect: name the cause (file and function), explain exactly why the old value is served and for how long, and run `npm run simulate` to support your conclusion. Do not modify files; report only.

**정답 (judge가 보는 reference)**

> It is a defect, not expected eventual consistency. src/profiles.js getProfile caches under cacheKey(id, fields), e.g. user:42:name,avatar, but updateProfile deletes user:42, a key that is never written. The invalidation is a no-op, so the cached profile with the old name is served until its TTL of 5 minutes (300 s) expires. npm run simulate shows the old name right after the update.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `location`: Identifies the key mismatch between src/profiles.js getProfile (cache key built with cacheKey(id, fields)) and updateProfile, which deletes `user:${id}` - a key that is never written.
- `mechanism`: Explains that the invalidation is therefore a no-op, so the stale entry is served until its TTL expires.
- `not-expected`: Concludes it is a defect, not the documented eventual consistency (the delete was meant to make edits visible immediately).
- `conclusion`: States the stale value is served for up to the cache TTL of 5 minutes (300 s), supported by the simulation showing the old name after the update.

- [ ] 승인   - [ ] 수정 필요: 

### i08-listener-leak — Memory grows per request
- 범주: 원인 분석 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> The API process's memory grows steadily under load and after a few minutes Node prints `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 config listeners added`. `npm run simulate` reproduces it with fake requests. Find the cause (file and function), explain why memory grows with every request and what else goes wrong besides memory, and say what the listener count is after 100 requests. Do not modify files; report only.

**정답 (judge가 보는 reference)**

> src/handler.js handleRequest calls bus.on('config', ...) on every request and never removes the listener. The shared config bus keeps every closure (and the request and response it captured) alive, so memory and listener count grow by one per request; after 100 requests there are 100 'config' listeners. Besides memory, every config change runs all accumulated listeners, so the work per change grows with the number of past requests and handlers of finished requests run.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `location`: Identifies src/handler.js handleRequest registering bus.on('config', ...) on every request without removing it.
- `mechanism`: Explains that each listener closure stays referenced by the long-lived config bus (and keeps its request/response objects alive), so listeners and memory grow linearly with requests.
- `side-effect`: Notes the behavioural effect: on every config change all accumulated listeners run (work grows with past requests, old requests' handlers fire).
- `conclusion`: States that the 'config' listener count is 100 after 100 requests (one per request).

- [ ] 승인   - [ ] 수정 필요: 

### i09-rbac-export-ko — viewer의 리포트 내보내기 권한
- 범주: repo 질문 · 언어: ko · 함정: README says allow wins over deny (stale).
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 사용자 mina(역할 analyst)가 report:export 권한을 가지는지 알려 주세요. 권한이 어떤 순서로 결정되는지(역할 상속, allow와 deny의 우선순위)를 코드 위치와 함께 설명하고, mina에 대한 최종 판정과 그 근거가 되는 정책 항목을 짚어 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> mina는 report:export 권한이 없습니다. src/rbac.js의 can은 사용자의 역할과 상속된 역할(analyst → viewer)을 모두 모은 뒤, 그중 하나라도 해당 권한을 deny하면 false를 반환하고 그다음에 allow를 봅니다. 즉 deny가 우선입니다. config/policy.json에서 analyst는 report:export를 allow하지만 상속된 viewer가 report:export를 deny하므로 최종 판정은 false입니다. README의 'allow가 deny보다 우선한다'는 설명은 현재 코드와 맞지 않는 낡은 내용입니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `order`: Explains resolution in src/rbac.js can: collects the role and its inherited roles (analyst inherits viewer), and an explicit deny on any of them wins over any allow.
- `not-readme`: Notices that the README's statement 'allow wins over deny' is outdated/contradicted by the code.
- `evidence`: Names the decisive policy entries in config/policy.json: analyst allows report:export, viewer (inherited) denies report:export.
- `conclusion`: Concludes mina does NOT have report:export (can returns false).

- [ ] 승인   - [ ] 수정 필요: 

### i10-flag-rollout — Is new-checkout on for u-42?
- 범주: repo 질문 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> Support asks whether the `new-checkout` flag is on for user `u-42` and for user `u-3` in production, and why. Explain how a flag is evaluated (the order of the rules and how the percentage rollout picks users, with code locations) and give the answer for both users with the reason for each. Do not modify files.

**정답 (judge가 보는 reference)**

> src/flags.js isEnabled evaluates in this order: an environment override FLAG_<NAME>=on|off, then the flag's users.deny and users.allow lists in config/flags.json, then the percentage rollout: src/hash.js bucket hashes `${flag}:${userId}` with FNV-1a modulo 100 and the flag is on when the bucket is below rolloutPercent (30 for new-checkout). For u-42 the bucket is 14, so the flag is on. u-3 is on new-checkout's deny list, which is checked before the rollout, so it is off even though its bucket (29) is below 30. No production override is set in config/env.production.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `order`: Explains the evaluation order in src/flags.js isEnabled: environment kill switch/override first, then the explicit user allow/deny lists, then the percentage rollout.
- `hashing`: Explains that the rollout buckets a user by an FNV-1a hash of `${flag}:${userId}` modulo 100 (src/hash.js bucket) compared with rolloutPercent (30).
- `u42`: Says new-checkout is ON for u-42 (bucket 14 < 30) - or equivalently states that u-42 falls inside the 30% rollout with its bucket value.
- `u3`: Says new-checkout is OFF for u-3 because u-3 is on the flag's deny list in config/flags.json, which is checked before the rollout (even though its rollout bucket, 29, is below 30).
- `conclusion`: Gives both final answers correctly: u-42 on, u-3 off.

- [ ] 승인   - [ ] 수정 필요: 

### i11-config-precedence — Which port does the server bind?
- 범주: repo 질문 · 언어: en · 함정: Header comment documents CLI > env precedence, the code does the opposite.
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> We start the server with `PORT=8080 node src/server.js --port 9090` while config/app.json sets port 7070. Which port does it listen on? Explain the precedence of the configuration sources as the code implements it (with locations) and whether the documentation in the repository matches. Do not modify files.

**정답 (judge가 보는 reference)**

> It listens on 8080. src/config.js loadConfig merges {...defaults, ...fileConfig, ...cliConfig, ...envConfig}, so later sources win: environment variables > CLI arguments > config file > defaults. PORT=8080 therefore beats --port 9090 and app.json's 7070. The header comment in src/config.js (CLI > env > file > defaults) is wrong; it contradicts the merge order.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `precedence`: States the actual precedence from src/config.js loadConfig: defaults < config file < CLI arguments < environment variables (later spreads win).
- `comment`: Points out that the header comment of src/config.js (CLI > env > file > defaults) contradicts the code.
- `conclusion`: Concludes the server listens on 8080 (the PORT environment variable wins over --port 9090).

- [ ] 승인   - [ ] 수정 필요: 

### i12-job-retry-ko — 실패한 작업의 재시도 조건
- 범주: repo 질문 · 언어: ko · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 작업 큐에서 failed 상태의 작업이 다시 queued로 돌아갈 수 있는지, 있다면 어떤 조건에서 최대 몇 번까지인지 알려 주세요. 상태 전이 전체와 각 전이가 일어나는 코드 위치를 정리하고, 특히 재시도 판단 조건(어떤 오류가 재시도되는지 포함)을 정확히 설명해 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 네, 조건부로 가능합니다. src/jobs.js의 전이는 queued → running(start), running → succeeded(complete), running → failed(fail)입니다. fail 안에서 error.retryable === true이고 job.attempts < MAX_ATTEMPTS(3)이면 queued로 되돌리고(재시도), 아니면 dead가 됩니다. attempts는 start에서 실행할 때마다 1 증가하므로 작업은 최대 3번 실행되고, queued로 돌아가는 재시도는 최대 2번입니다. retryable이 아닌 오류는 바로 dead가 됩니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `transitions`: Lists the transitions in src/jobs.js: queued → running (start), running → succeeded (complete), running → failed (fail), failed → queued (retry), and failed → dead when retries are exhausted or the error is not retryable.
- `condition`: States the retry condition in fail(): error.retryable === true AND job.attempts < MAX_ATTEMPTS (3).
- `count`: Explains attempts counts runs (incremented in start), so a job runs at most 3 times in total, i.e. at most 2 retries back to queued.
- `conclusion`: Answers yes: failed jobs go back to queued only for retryable errors and at most 2 times (3 runs total); otherwise they become dead.

- [ ] 승인   - [ ] 수정 필요: 

### i13-lru-compare — Which LRU for the hot path?
- 범주: 기술 비교 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> We have two LRU cache implementations, src/lru-map.js and src/lru-array.js, and want to keep one for the session hot path (about 10,000 entries, mostly reads). Compare them: are they behaviourally equivalent, and how do their costs differ? Recommend one and justify it with concrete evidence (code locations; a short scenario if they differ). Do not modify files.

**정답 (judge가 보는 reference)**

> Use src/lru-map.js. They are not equivalent: src/lru-array.js get returns the value without moving the key to the most-recent end, so eviction follows insertion order (FIFO). With capacity 2: set a, set b, get a, set c — the Map version evicts b (a was just used), the array version evicts a. Costs: the Map version is O(1) per get/set (delete + re-insert keeps Map order); the array version does indexOf/splice/shift per operation, O(n), which is slow at 10,000 entries.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `difference`: Shows that they are not equivalent: src/lru-array.js get does not move the accessed key to the most-recent position, so it evicts in insertion order (FIFO), not least-recently-used.
- `scenario`: Gives a concrete scenario, e.g. capacity 2: set a, set b, get a, set c → the Map version evicts b, the array version evicts a.
- `cost`: States the cost difference: Map version get/set are O(1); the array version uses indexOf/splice (O(n)) per operation, poor at 10,000 entries.
- `conclusion`: Recommends src/lru-map.js.

- [ ] 승인   - [ ] 수정 필요: 

### i14-search-rate-ko — 검색창 호출 제한 방식 선택
- 범주: 기술 비교 · 언어: ko · 함정: Both functions look like the obvious answer (debounce for 'after typing stops', throttle for 'at most once per 300ms'); neither satisfies both conditions.
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 검색창 요구사항은 '입력 중에는 300ms에 최대 한 번만 API를 호출하고, 입력이 멈추면 마지막 입력값으로 반드시 한 번 더 호출한다'입니다. src/rate.js의 debounce와 throttle 중 어느 것을 써야 하는지 판단해 주세요. 각 함수가 요구사항의 두 조건을 만족하는지 코드 근거와 구체적인 입력 시나리오로 보여 주고 결론을 내려 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 둘 다 요구사항을 만족하지 않습니다. src/rate.js의 debounce는 매 호출마다 타이머를 다시 걸기 때문에 300ms보다 빠르게 계속 입력하면 입력 중에는 한 번도 호출하지 않고, 입력이 멈춘 뒤 마지막 값으로 한 번만 호출합니다(두 번째 조건만 만족). throttle은 창의 첫 호출만 실행하고 창 안의 나머지 호출은 버리며 trailing 호출이 없습니다. 예를 들어 0, 100, 200ms에 입력하면 0ms 값만 전송되고 마지막 값은 전송되지 않습니다(첫 번째 조건만 만족). 필요한 것은 leading과 trailing을 모두 하는 throttle입니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `debounce`: Shows debounce (src/rate.js) fails the first condition: during continuous typing faster than 300 ms it never calls, it only calls once after input stops (it does satisfy the final-value condition).
- `throttle`: Shows throttle fails the second condition: it is leading-edge only and drops calls inside the window without a trailing call, so the final input can be lost (e.g. inputs at 0, 100, 200 ms → only the 0 ms value is sent).
- `conclusion`: Concludes that neither function meets the requirement as written; what is needed is a throttle with a trailing call (leading + trailing), not either existing function.

- [ ] 승인   - [ ] 수정 필요: 

### i15-clone-switch — Replace cloneJSON with structuredClone?
- 범주: 기술 비교 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> A pull request proposes replacing `cloneJSON` with the built-in `structuredClone` in src/session.js because it is 'faster and handles Dates'. Evaluate the change for the session objects this code actually handles: list every behavioural difference that matters here, say whether the change is safe to merge as is, and support the decisive point with code locations (and a quick run if useful). Do not modify files.

**정답 (judge가 보는 reference)**

> Not safe as is. src/session.js createSession stores an onExpire callback on every session; structuredClone cannot clone functions and throws DataCloneError, so snapshot() would throw for every session, while cloneJSON silently drops the function. Other differences: cloneJSON turns expiresAt (Date) into an ISO string (isExpired wraps it in new Date, so that works either way) while structuredClone keeps a Date; the flags Map becomes {} with cloneJSON (its entries are lost today) and is preserved by structuredClone; undefined fields are dropped by JSON and kept by structuredClone. The callback has to be removed or excluded from the clone before switching.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `throws`: Identifies that sessions carry a function (onExpire, set in src/session.js createSession), so structuredClone throws a DataCloneError where cloneJSON silently drops the function: the switch breaks snapshot().
- `dates`: Notes the Date difference: cloneJSON turns expiresAt into an ISO string (which isExpired copes with via new Date), structuredClone keeps a Date.
- `other`: Mentions at least one other difference relevant here: the Map of flags (JSON turns it into {} / loses entries, structuredClone keeps it) or undefined fields being dropped vs kept.
- `conclusion`: Concludes the PR is NOT safe to merge as is (it would throw on every snapshot) unless the function is removed or excluded first.

- [ ] 승인   - [ ] 수정 필요: 

### i16-leaderboard-sort-ko — 리더보드 정렬 구현 비교
- 범주: 기술 비교 · 언어: ko · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 리더보드는 점수 내림차순으로 정렬하고, 같은 점수면 먼저 가입한 사용자가 위에 와야 합니다. 입력 배열은 항상 가입 순서로 들어옵니다. src/legacy-sort.js의 quickSortBy와 src/leaderboard.js가 쓰는 내장 Array.prototype.sort 중 어느 쪽이 이 요구사항을 보장하는지 비교해 주세요. 근거(코드 위치, 반례가 있으면 구체적인 입력)와 결론을 제시해 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 내장 sort만 요구사항을 보장합니다. Array.prototype.sort는 ES2019부터 안정 정렬이 보장되므로, src/leaderboard.js처럼 점수만 비교해도 동점자는 입력 순서(가입 순서)를 유지합니다. src/legacy-sort.js의 quickSortBy는 분할 과정의 swap 때문에 안정적이지 않습니다. 예를 들어 가입 순서 [u1:5, u2:9, u3:5]를 내림차순 정렬하면 u2, u3, u1이 되어 동점(5)인 u3이 먼저 가입한 u1보다 앞에 옵니다. 반면 내장 sort는 u2, u1, u3입니다. 따라서 legacy quickSortBy로 바꾸면 안 됩니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `builtin`: States that the built-in Array.prototype.sort is guaranteed stable (ES2019+), so with a score-only comparator ties keep the input (signup) order.
- `legacy`: States that quickSortBy is not stable (partition swaps can reorder equal elements) and gives or describes a concrete counterexample input where equal scores come out out of signup order.
- `conclusion`: Concludes the built-in sort (src/leaderboard.js) satisfies the requirement and quickSortBy does not.

- [ ] 승인   - [ ] 수정 필요: 

### i17-order-events-ko — 주문 이벤트 발행 설계 평가
- 범주: 아키텍처 평가 · 언어: ko · 함정: docs/design.md claims exactly-once because of an idempotency key.
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> docs/design.md는 주문 이벤트가 '정확히 한 번(exactly-once)' 발행된다고 설명합니다. 요구사항은 '확정된 주문의 이벤트는 절대 유실되지 않고, 확정되지 않은 주문의 이벤트는 절대 발행되지 않는다'입니다. src/orders.js의 현재 구현이 이 요구사항과 설계 문서의 주장을 만족하는지 평가해 주세요. 실패하는 구체적인 시나리오(어느 줄 사이에서 무엇이 일어나면 어떻게 되는지)를 들고, 문서의 주장에 대한 판정을 내려 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 요구사항도, 문서의 exactly-once 주장도 만족하지 않습니다. src/orders.js placeOrder는 db.transaction으로 주문을 커밋한 뒤 별도 단계로 broker.publish를 호출합니다(dual write). 커밋 후 publish 전에 프로세스가 죽거나 publish가 실패하면 확정된 주문의 이벤트가 유실됩니다. publish가 타임아웃 후 재시도되면 브로커가 실제로 받은 경우 중복 발행이 생기므로 기껏해야 at-least-once입니다. 설계 문서의 idempotency key는 소비자가 중복을 버리게 해 줄 뿐 유실을 막지 못합니다. 같은 트랜잭션에 outbox 행을 쓰고 별도 relay가 발행하는 transactional outbox가 필요합니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `loss`: Identifies that src/orders.js placeOrder commits the DB transaction and then publishes to the broker as a separate step (dual write): a crash or publish failure after commit loses the event for a confirmed order.
- `phantom-or-dup`: Identifies at least one more failure: the retry of publish after a timeout (or a retried request) can publish duplicates, or publishing is not tied to the transaction outcome; i.e. delivery is at most at-least-once, not exactly-once.
- `idempotency`: Explains that the idempotency key in the design only lets consumers drop duplicates; it does not prevent loss, so it does not make the design exactly-once.
- `conclusion`: Concludes the implementation does not meet the requirement and the design doc's exactly-once claim is false; recommends a transactional outbox (or equivalent) as the fix direction.

- [ ] 승인   - [ ] 수정 필요: 

### i18-rate-limit-replicas — Rate limiter in a 4-replica deployment
- 범주: 아키텍처 평가 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> The API must allow at most 100 requests per minute per API key, across the whole service. The limiter is src/limiter.js and the service is deployed with deploy/service.yaml. Evaluate whether the design meets the requirement in production: what limit do clients actually get, what other situations break it, and what would you change? Cite code and configuration locations. Do not modify files.

**정답 (judge가 보는 reference)**

> The requirement is not met. src/limiter.js keeps a token bucket per key in an in-process Map, so every replica enforces 100/min on its own. deploy/service.yaml runs 4 replicas behind the load balancer, so a key can get up to 400 requests per minute; the HPA in the same file allows up to 8 replicas, i.e. up to 800/min. Restarts and redeploys also reset the buckets. A shared limiter (e.g. Redis with atomic increments or a central rate-limit service), or routing each key to one instance, is needed.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `per-instance`: Identifies that src/limiter.js keeps token buckets in process memory (a Map), so each replica limits independently.
- `effective`: States that deploy/service.yaml runs 4 replicas behind a load balancer, so a key can get up to 400 requests per minute (4 × 100), not 100.
- `other`: Names at least one other way the limit breaks: restarts/redeploys reset the buckets, autoscaling (maxReplicas 8 in the HPA) raises the effective limit further to 800, or uneven load balancing.
- `conclusion`: Concludes the requirement is not met and recommends a shared limiter (e.g. Redis/central store with atomic counters) or sticky per-key routing.

- [ ] 승인   - [ ] 수정 필요: 

### i19-cache-ttl-ko — 캐시 TTL을 24시간으로 늘려도 되는가
- 범주: 아키텍처 평가 · 언어: ko · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 상품 가격 조회 부하를 줄이려고 src/prices.js의 캐시 TTL을 5분에서 24시간으로 늘리자는 제안이 있습니다. 쓰기 시 캐시를 삭제하니 오래된 값이 남을 일은 없다는 것이 제안의 근거입니다. 이 근거가 맞는지, TTL을 늘려도 되는지 평가해 주세요. 문제가 있다면 일어나는 순서(타임라인)를 구체적으로 제시하고 영향 범위를 설명해 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 근거가 틀렸고 TTL을 그대로 늘리면 안 됩니다. src/prices.js의 getPrice는 캐시 미스일 때 DB를 읽고 캐시에 set하며, updatePrice는 DB를 갱신한 뒤 키를 delete합니다. 타임라인: (1) 읽기 A가 캐시 미스 후 DB에서 옛 가격을 읽음 → (2) 쓰기 B가 DB를 새 가격으로 갱신 → (3) B가 캐시 키 삭제 → (4) A가 옛 가격을 캐시에 set. 이후 옛 가격이 TTL 동안 남습니다. TTL이 24시간이면 최악의 경우 하루 동안 틀린 가격이 노출됩니다. 버전/compare-and-set, 지연 이중 삭제, 짧은 TTL과 갱신 같은 완화책이 필요합니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `race`: Describes the cache-aside race in src/prices.js: a reader misses, reads the old price from the DB, a writer updates the DB and deletes the key, then the reader sets the old price into the cache.
- `timeline`: Gives the ordering concretely (read miss → DB read old → write DB → delete cache → set stale), showing that delete-on-write does not prevent stale entries.
- `impact`: Explains the stale value then lives for the full TTL, so raising TTL from 5 minutes to 24 hours extends the worst-case staleness of a price to 24 hours.
- `conclusion`: Concludes the premise is wrong and TTL should not simply be raised; suggests mitigations (versioned values / compare-and-set, delayed double delete, or short TTL with refresh).

- [ ] 승인   - [ ] 수정 필요: 

### i20-median-claim — Is median correct for all inputs?
- 범주: 반례 판단 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> A pull request comment claims: 'src/stats.js median is correct for every non-empty array of numbers; the tests prove it.' Decide whether the claim is true. If it is false, give the smallest concrete counterexample you can, the value median returns for it and the correct value, and explain the cause. Do not modify files.

**정답 (judge가 보는 reference)**

> The claim is false. src/stats.js median sorts with values.slice().sort() and no comparator, so numbers are compared as strings. Counterexample: [10, 2, 3] sorts to [10, 2, 3] and median returns 2; the correct median is 3. The tests in test/stats.test.js use only single-digit numbers, where string order equals numeric order, so they pass without proving the claim.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `cause`: Identifies that median sorts with the default Array.prototype.sort (no comparator), which compares numbers as strings.
- `counterexample`: Gives a concrete counterexample where the result is wrong, e.g. [10, 2, 3] → median returns 2 but the correct median is 3 (any valid counterexample with the returned and the correct value).
- `tests`: Notes the existing tests only use single-digit numbers (or otherwise do not exercise multi-digit ordering), so passing tests do not prove the claim.
- `conclusion`: Concludes the claim is false.

- [ ] 승인   - [ ] 수정 필요: 

### i21-booking-overlap-ko — 인접 예약이 겹침으로 판정됨?
- 범주: 반례 판단 · 언어: ko · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> 회의실 예약 시간은 [시작, 끝) 반열린 구간이고, 앞 예약이 끝나는 시각에 다음 예약이 시작하는 것은 허용되어야 합니다(docs/booking.md). 리뷰어는 src/booking.js의 overlaps가 '모든 경우에 맞다'고 승인했습니다. 이 판단이 맞는지 검증해 주세요. 틀렸다면 반례(구체적인 두 구간과 반환값, 올바른 값)와 그 반례가 사용자에게 어떤 증상으로 나타나는지 설명해 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 리뷰어의 판단은 틀렸습니다. src/booking.js의 overlaps는 a.start <= b.end && b.start <= a.end로 닫힌 구간처럼 비교합니다. 반례: [9:00, 10:00)과 [10:00, 11:00)(분 단위 540–600, 600–660)에 대해 true를 반환하지만 반열린 구간이므로 정답은 false입니다. 그 결과 canBook이 앞뒤로 붙은 예약을 충돌로 거절합니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `cause`: Identifies that overlaps uses inclusive comparisons (<= / >=), treating the intervals as closed.
- `counterexample`: Gives adjacent intervals as a counterexample, e.g. [9:00, 10:00) and [10:00, 11:00) (or 540–600 and 600–660): overlaps returns true but the correct answer is false.
- `symptom`: Explains the user-facing symptom: back-to-back bookings are rejected as conflicts by canBook/book.
- `conclusion`: Concludes the reviewer's approval is wrong.

- [ ] 승인   - [ ] 수정 필요: 

### i22-split-bill — Do split parts always add up?
- 범주: 반례 판단 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> The billing team says src/split.js splitCents 'always returns parts that add up exactly to the total, for any total and any number of people'. Check the claim. If it is wrong, give a concrete counterexample (inputs, returned parts, their sum), describe which inputs are affected, and explain why. Do not modify files.

**정답 (judge가 보는 reference)**

> The claim is false. src/split.js splitCents gives every person Math.round(totalCents / people), so the parts add up to people × that rounded share. Whenever totalCents is not divisible by people the sum is off: splitCents(100, 3) returns [33, 33, 33] (sum 99, one cent short) and splitCents(200, 3) returns [67, 67, 67] (sum 201, one cent over). The remainder has to be distributed explicitly.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `cause`: Identifies that every part is Math.round(totalCents / people), so the parts sum to people × rounded share, which differs from the total whenever totalCents is not divisible by people.
- `counterexample`: Gives a concrete counterexample with returned parts and sum, e.g. splitCents(100, 3) → [33, 33, 33] summing to 99 (or splitCents(200, 3) → [67, 67, 67] summing to 201).
- `scope`: States that it can be off in both directions (short or over) and affects all totals not divisible by the number of people.
- `conclusion`: Concludes the claim is false.

- [ ] 승인   - [ ] 수정 필요: 

### i23-unique-by-ko — uniqueBy가 첫 항목을 유지하는가
- 범주: 반례 판단 · 언어: ko · 함정: All tests pass, which seems to confirm the doc comment.
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> src/collections.js의 uniqueBy 문서 주석은 '키가 같은 항목 중 첫 번째 항목을 유지하고 순서를 보존한다'고 합니다. 테스트도 모두 통과합니다. 주석의 설명이 실제 동작과 일치하는지 판단해 주세요. 일치하지 않는다면 반례(입력과 실제 결과, 기대 결과)를 들고, 테스트가 왜 이를 잡지 못하는지와 이 함수를 쓰는 코드(src/import.js)에 어떤 영향이 있는지 설명해 주세요. 코드는 수정하지 마세요.

**정답 (judge가 보는 reference)**

> 일치하지 않습니다. src/collections.js의 uniqueBy는 new Map(items.map(item => [key(item), item]))을 만들기 때문에 같은 키의 뒤 항목이 값을 덮어씁니다. 키 순서는 처음 등장한 위치를 따르지만 값은 마지막 항목입니다. 반례: [{id:1,v:'a'},{id:1,v:'b'}] → 실제 [{id:1,v:'b'}], 기대 [{id:1,v:'a'}]. 테스트는 결과 개수와 키 순서만 확인하고 어느 중복의 값이 남는지는 보지 않아서 통과합니다. src/import.js에서는 같은 이메일이 두 번 있으면 뒤 행이 가져와져서, 첫 행을 기준으로 삼는다는 의도와 다르게 나중 행의 이름과 등급이 저장됩니다.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `cause`: Identifies that uniqueBy builds new Map(items.map(item => [key(item), item])), so a later item with the same key overwrites the value: it keeps the LAST item (at the position where the key first appeared).
- `counterexample`: Gives a counterexample, e.g. [{id:1,v:'a'},{id:1,v:'b'}] → returns [{id:1,v:'b'}] instead of [{id:1,v:'a'}].
- `tests`: Explains the tests pass because they only check the number of items or the keys/order, not which duplicate's values are kept.
- `impact`: Explains the effect on src/import.js: when a CSV contains the same email twice, the later row wins, so the newer duplicate row (not the first, canonical one) is imported.
- `conclusion`: Concludes the doc comment does not match the behaviour.

- [ ] 승인   - [ ] 수정 필요: 

### i24-semver-compare — Does compareVersions handle pre-releases?
- 범주: 반례 판단 · 언어: en · 함정: 없음
- 검증: verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)

**질문 (모델이 받는 그대로)**

> The release tooling's README says src/version.js compareVersions 'orders any two semantic versions correctly, including pre-releases'. The auto-updater relies on it to decide whether to install an update. Verify the claim. If it is wrong, give concrete counterexamples with the actual and the correct result, explain the cause in the code, and describe what the auto-updater (src/updater.js) would do wrong as a consequence. Do not modify files.

**정답 (judge가 보는 reference)**

> The claim is false for pre-releases. src/version.js compareVersions splits on '.' and parseInt()s every part: '1.0.0-beta.1' becomes [1, 0, 0, 1] (parseInt('0-beta') is 0 and the '.1' becomes a fourth component). So compareVersions('1.0.0-beta.1', '1.0.0') returns 1, i.e. the beta is treated as newer than the release, although a pre-release is lower than its release; compareVersions('1.0.0-rc', '1.0.0') returns 0 instead of a negative number. Multi-digit parts are fine (1.10.0 > 1.9.0). Consequence in src/updater.js shouldUpdate: users on 1.0.0 are offered 1.0.0-beta.1 as an update (a downgrade to a beta), and users on 1.0.0-beta.1 are not offered 1.0.0.

**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**

- `cause`: Identifies that compareVersions splits on '.' and parseInt()s each part: the pre-release suffix of the patch part is dropped (parseInt('0-beta') === 0) and the pre-release's dot-separated number becomes an extra numeric component.
- `counterexample`: Gives a concrete counterexample with actual and correct result, e.g. compareVersions('1.0.0-beta.1', '1.0.0') returns a positive number (1) although a pre-release is lower than its release (should be negative); or compareVersions('1.0.0-rc', '1.0.0') returns 0 instead of negative.
- `updater`: Explains the consequence in src/updater.js shouldUpdate: a user on 1.0.0 is offered 1.0.0-beta.1 as an update (shouldUpdate('1.0.0', '1.0.0-beta.1') is true, i.e. a downgrade to a pre-release), and/or a user on 1.0.0-beta.1 is not offered the 1.0.0 release.
- `conclusion`: Concludes the README claim is false (multi-digit components like 1.10.0 vs 1.9.0 are handled correctly; pre-releases are not).

- [ ] 승인   - [ ] 수정 필요: 

