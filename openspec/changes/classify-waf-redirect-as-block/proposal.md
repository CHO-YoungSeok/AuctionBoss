## Why

2026-10-18 우분투 운영 장비에 백엔드를 처음 띄웠을 때 법원경매정보 WAF가 이 공인 IP를 이미 차단하고 있었다. 차단된 IP의 요청에 소스는 HTTP 200 HTML 본문이 아니라 **`302 Found` + `Location: /error.html`**(본문: "contrary to the Web firewall security policies have been blocked")로 응답한다. 지금의 차단 감지는 "HTTP 200 + HTML 본문"과 `ipcheck`만 보므로(`ResponseEnvelope`), 세션 초기화(`GET /pgj/index.on`)에서 받은 이 302는 일반 요청 실패(`SourceRequestError`)로 기록된다.

결과적으로 차단인데도 공유 백오프가 걸리지 않아 수집기가 10분마다 다시 요청하고, 사진 워커도 같은 IP로 요청을 이어간다 — 차단을 연장할 수 있다. 또 차단이 아닌 실패로 세므로 연속 3회 뒤 로테이션을 다음 법원으로 넘겨, "차단 시 로테이션 위치 유지" 요구사항도 어긴다.

## What Changes

- **HTTP 응답에 리다이렉트 대상 노출**: `CourtAuctionHttp.Response`가 `Location` 헤더 값을 함께 돌려준다(리다이렉트는 지금처럼 따라가지 않는다).
- **WAF 리다이렉트를 차단으로 분류**: 어댑터의 세 응답 상태 검사(세션 초기화 GET, 목록 검색 POST, 사진 상세 POST)에서 3xx 응답의 `Location` 경로가 WAF 차단 페이지(`/error.html`)이면 일반 요청 실패가 아니라 `WafBlockedException`을 던진다. 그 밖의 3xx·4xx·5xx는 지금처럼 `SourceRequestException`이다.
- 분류만 바뀌므로 수집기·사진 워커의 기존 차단 처리(`blocked` 기록, 공유 백오프, 로테이션 위치 유지, 다음 법원 미요청)가 그대로 적용된다. 워커 코드는 바꾸지 않는다.
- **골든 계약 픽스처 추가**: 세션 초기화·검색·사진 상세에서 302→`/error.html`을 받는 시나리오.

이 change에서 하지 않는 것:
- 차단 우회(User-Agent·IP 변경 등). 차단은 존중하고 백오프로만 대응한다.
- 백오프 길이(`block-backoff-ms`, 기본 1시간) 변경.
- TS 쪽(은퇴한 수집기) 수정.

## Capabilities

### New Capabilities
<!-- 없음 -->

### Modified Capabilities
- `auction-collection`: 차단 감지 규칙에 "WAF 차단 페이지로의 리다이렉트"를 추가한다(ADDED 요구사항, 기존 요구사항 문구는 바꾸지 않는다).

## Impact

- **코드**: `backend/.../collect/source/courtauction/CourtAuctionHttp.java`(Response에 location), `CourtAuctionAdapter.java`(세 상태 검사), 필요하면 판정 함수 하나를 어댑터 패키지에 둔다. 어댑터 밖으로 소스 고유 형식(`/error.html`)이 새지 않는다.
- **테스트**: `CourtAuctionHttpTest`(Location 노출), `CourtAuctionAdapterTest`(세 지점의 302→error.html은 `WafBlockedException`, 다른 Location의 302는 `SourceRequestException`), `SourceContractTest` 픽스처 3건(`block-waf-redirect-bootstrap.json`, `block-waf-redirect-search.json`, `photos-blocked-waf-redirect.json`). 테스트 수는 늘기만 한다.
- **운영**: 우분투 장비에서 잠시 꺼 둔 수집·사진 스케줄러(`docker-compose.override.yml`)는 이 change 배포 후, 차단 해제를 확인하고 다시 켠다.
