## Context

- 차단 판정은 지금 `ResponseEnvelope.openData()`(본문 첫 글자 `{` 검사 → `ipcheck`)에만 있다. 상태 코드는 "차단이어도 200이라 쓸 수 없다"는 전제였다.
- `CourtAuctionHttp`는 리다이렉트를 따라가지 않는다(`Redirect.NEVER`). 302는 보통 응답으로 돌아오지만 `Response(status, body, setCookies)`에는 `Location`이 없다.
- 어댑터의 세 상태 검사(`bootstrapSession`, `detailRequest`, `search`)는 `!ok()`이면 모두 `SourceRequestException`을 던진다.
- 수집기(`CollectorRun`)와 사진 워커(`PhotoRun`)는 `SourceBlockedException` 하위면 차단으로 처리한다. 워커는 바꿀 필요가 없다.

## Goals / Non-Goals

**Goals:** 302→`/error.html`을 세 지점 모두에서 `WafBlockedException`으로 분류한다. 판정 규칙을 어댑터 패키지 안 한 곳에 둔다.

**Non-Goals:** 차단 우회, 백오프 길이 변경, 리다이렉트 추적, TS 코드 수정.

## Decisions

### D1. `Response`에 `location` 필드 추가
`record Response(int status, String body, List<String> setCookies, String location)` — `location`은 `Location` 헤더의 첫 값, 없으면 `null`. 헤더 맵 전체가 아니라 필요한 값만 둔다(어댑터가 다른 헤더에 의존하지 않게). 기존 생성 지점(테스트 포함)은 컴파일 오류로 모두 드러난다.

### D2. 판정은 어댑터 패키지의 한 메서드
`CourtAuctionAdapter`(또는 같은 패키지의 작은 헬퍼)에 `requireOk(Response, String url, String what)`을 두고 세 지점이 이것만 호출한다:
1. `ok()`면 통과.
2. 3xx이고 `location`의 **경로**가 `/error.html`이면 `WafBlockedException(message, bodyPreview)`.
   - 경로 비교: 절대 URL(`https://www.courtauction.go.kr/error.html`)과 상대 경로(`/error.html`) 모두 허용. 쿼리·프래그먼트는 무시. 대소문자는 구분한다(관측값 그대로).
   - 메시지에 상태와 Location을 넣어 회차 기록의 `error_message`로 원인을 알 수 있게 한다.
3. 그 밖은 지금과 같은 `SourceRequestException`(메시지 형식 유지 — 기존 테스트가 그 문구에 의존할 수 있음).

대안: 리다이렉트를 따라가 `error.html` 본문을 받아 기존 본문 검사(HTML → WAF)에 태우기 — 요청이 하나 더 나가고(차단 상태에서 요청을 늘림), 따라가지 않는다는 기존 결정과 충돌해서 택하지 않는다.

### D3. 요청 수 집계
302도 요청 1회로 센다(지금과 같음). 차단으로 바뀌어도 `requestsMade`는 그대로 더해진다(`CollectorRun`이 이미 `se.requestsMade()`를 합산).

### D4. 사진 경로의 쿠키 캐시
`fetchItemPhotos`의 부트스트랩이 차단으로 실패하면 `photoCookie`는 비어 있는 채로 남는다(지금도 실패 시 그렇다). `PhotoRun`은 차단을 받으면 회차를 멈추므로 추가 요청이 없다 — 별도 처리 불필요.

## Risks / Trade-offs

- 소스가 다른 차단 페이지 경로를 쓰기 시작하면 다시 일반 실패로 보인다 → 판정을 한 메서드에 모아 두고, 일반 실패 메시지에 상태·Location을 남겨 관측 가능하게 한다.
- 정상 동작 중 `/error.html`로 리다이렉트되는 비차단 오류가 있다면 차단으로 과대 분류된다 → 그 경우 대가는 1시간 백오프뿐이고, 차단을 놓쳐 IP 차단을 연장하는 쪽보다 안전하다.

## Migration Plan

배포 후 우분투 장비에서: `docker compose build backend && docker compose up -d backend`. 차단 해제가 확인되면(브라우저로 법원경매 접속) `docker-compose.override.yml`의 스케줄러 끄기 두 줄을 지우고 `up -d`.
