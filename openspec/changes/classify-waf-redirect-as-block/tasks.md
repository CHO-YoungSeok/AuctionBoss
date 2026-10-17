## 0. 착수 전 확인

- [ ] 0.1 게이트(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)를 돌려 시작 시점 통과 여부와 테스트 개수(TS·백엔드)를 기록한다

## 1. HTTP 응답에 Location (D1)

- [ ] 1.1 `CourtAuctionHttp.Response`에 `location`(첫 `Location` 헤더 값, 없으면 null)을 추가하고 생성 지점을 모두 고친다
- [ ] 1.2 `CourtAuctionHttpTest`에 확인한다: 302 + `Location: /error.html`이면 `location()`이 `/error.html`, 200이면 null. 기존 `redirectsAreNotFollowed`는 유지

## 2. 판정 (D2)

- [ ] 2.1 어댑터 패키지에 `requireOk`를 두고 `bootstrapSession`·`detailRequest`·`search`의 `!ok()` 분기를 이것으로 바꾼다. 비차단 실패의 기존 메시지 형식은 유지한다
- [ ] 2.2 `CourtAuctionAdapterTest`에 확인한다: (a) 부트스트랩 302→`/error.html`은 `WafBlockedException`, (b) 검색 302→`/error.html`은 `WafBlockedException`, (c) 사진 상세 302→`/error.html`은 `WafBlockedException`, (d) 절대 URL `https://www.courtauction.go.kr/error.html?x=1`도 차단, (e) 302→`/pgj/index.on`은 `SourceRequestException`, (f) Location 없는 302는 `SourceRequestException`, (g) 500은 지금처럼 `SourceRequestException`, (h) 차단이어도 `requestsMade`가 요청 수만큼 집계됨. 변이 확인: `requireOk`의 3xx 분기를 지우면 (a)~(d)가 실패해야 한다

## 3. 골든 계약 (스펙 시나리오)

- [ ] 3.1 `backend/src/test/resources/contracts/source/`에 `block-waf-redirect-bootstrap.json`, `block-waf-redirect-search.json`(2페이지에서 리다이렉트 → 이후 요청 없음), `photos-blocked-waf-redirect.json`을 추가한다. 리플레이 하네스(`ReplayServer`)가 응답 헤더를 지원하지 않으면 지원을 추가한다
- [ ] 3.2 수집기 경로에서 확인한다(기존 `CollectorRunTest` 형식): 어댑터가 `WafBlockedException`을 던지면 `blocked`, `error_kind=WafBlockedError`, 백오프 기록, 로테이션 위치 유지, 연속 실패 횟수 불변 — 이미 있는 테스트가 덮으면 그 이름을 tasks 메모에 적고 추가하지 않는다

## 4. 마무리

- [ ] 4.1 게이트 전부 통과, 테스트 수 증가 확인. `regression-verifier`로 회귀 검증
- [ ] 4.2 `docs/REFERENCE.md`의 차단 감지 설명(본문·ipcheck)에 리다이렉트 감지를 한 줄 더한다
- [ ] 4.3 우분투 장비에 배포(design Migration Plan). 스케줄러 재개는 차단 해제 확인 뒤
