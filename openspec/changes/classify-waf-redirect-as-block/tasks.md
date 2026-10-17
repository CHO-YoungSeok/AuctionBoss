## 0. 착수 전 확인

- [x] 0.1 게이트(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)를 돌려 시작 시점 통과 여부와 테스트 개수(TS·백엔드)를 기록한다 — 시작 시점: TS tsc 통과, vitest 754건(61파일), build·lint 통과(경고 1). 백엔드는 구현 후 810건이며 이번 추가 9건(어댑터 5·HTTP 1·계약 3)을 빼면 시작 시점 801건

## 1. HTTP 응답에 Location (D1)

- [x] 1.1 `CourtAuctionHttp.Response`에 `location`(첫 `Location` 헤더 값, 없으면 null)을 추가하고 생성 지점을 모두 고친다
- [x] 1.2 `CourtAuctionHttpTest`에 확인한다: 302 + `Location: /error.html`이면 `location()`이 `/error.html`, 200이면 null. 기존 `redirectsAreNotFollowed`는 유지 — `locationHeaderIsExposedOnRedirectsAndNullOtherwise` 추가

## 2. 판정 (D2)

- [x] 2.1 어댑터 패키지에 `requireOk`를 두고 `bootstrapSession`·`detailRequest`·`search`의 `!ok()` 분기를 이것으로 바꾼다. 비차단 실패의 기존 메시지 형식은 유지한다
- [x] 2.2 `CourtAuctionAdapterTest`에 확인한다: (a) 부트스트랩 302→`/error.html`은 `WafBlockedException`, (b) 검색 302→`/error.html`은 `WafBlockedException`, (c) 사진 상세 302→`/error.html`은 `WafBlockedException`, (d) 절대 URL `https://www.courtauction.go.kr/error.html?x=1`도 차단, (e) 302→`/pgj/index.on`은 `SourceRequestException`, (f) Location 없는 302는 `SourceRequestException`, (g) 500은 지금처럼 `SourceRequestException`, (h) 차단이어도 `requestsMade`가 요청 수만큼 집계됨. 변이 확인: `requireOk`의 3xx 분기를 지우면 (a)~(d)가 실패해야 한다 — `CourtAuctionAdapterTest` 5건(부트스트랩·검색·상세 차단, 절대 URL 차단, 비차단 실패 묶음 (e)(f)(g)+대소문자·다른 경로 error.html). (h)는 요청 수 단언으로 포함. 변이 확인: 3xx 분기를 끄면 어댑터 테스트 4건·계약 3건이 실패, 복구 후 통과

## 3. 골든 계약 (스펙 시나리오)

- [x] 3.1 `backend/src/test/resources/contracts/source/`에 `block-waf-redirect-bootstrap.json`, `block-waf-redirect-search.json`(2페이지에서 리다이렉트 → 이후 요청 없음), `photos-blocked-waf-redirect.json`을 추가한다. 리플레이 하네스(`ReplayServer`)가 응답 헤더를 지원하지 않으면 지원을 추가한다 — 계약 34→37건. `ReplayServer.Reply`에 `location` 추가(4인자 생성자 유지), 계약 하네스는 응답의 `location` 키를 읽음
- [x] 3.2 수집기 경로에서 확인한다(기존 `CollectorRunTest` 형식): 어댑터가 `WafBlockedException`을 던지면 `blocked`, `error_kind=WafBlockedError`, 백오프 기록, 로테이션 위치 유지, 연속 실패 횟수 불변 — 이미 있는 테스트가 덮으면 그 이름을 tasks 메모에 적고 추가하지 않는다 — 기존 `CollectorRunTest`(차단_오류는_failed가_아니라_blocked로_기록되고…, 차단되면_공유_백오프를…, 차단되면_위치를_전진시키지_않고…, 차단은_실패_횟수에_세지도…)와 `PhotoRunTest`(WAF_차단도_같은_방식으로_blocked_처리한다)가 이미 덮어 추가하지 않음

## 4. 마무리

- [ ] 4.1 게이트 전부 통과, 테스트 수 증가 확인. `regression-verifier`로 회귀 검증 — 게이트 5종 통과(백엔드 810건, vitest 754건). 회귀 검증(regression-verifier)은 오케스트레이터 몫이라 체크 보류
- [x] 4.2 `docs/REFERENCE.md`의 차단 감지 설명(본문·ipcheck)에 리다이렉트 감지를 한 줄 더한다
- [ ] 4.3 우분투 장비에 배포(design Migration Plan). 스케줄러 재개는 차단 해제 확인 뒤
