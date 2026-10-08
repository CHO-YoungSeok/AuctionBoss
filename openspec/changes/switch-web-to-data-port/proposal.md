## Why

화면 5개(`/`, `/items/{id}`, `/bookmarks`, `/feed`, `/status`)와 화면용 라우트 3개(관심 토글 폼, 읽음 처리 폼, 사진 파일)는 지금 `@/lib/db`를 직접 불러 SQLite 파일을 연다. 이대로는 5단계에서 SQLite를 은퇴시킬 때 화면을 한꺼번에 다시 써야 하고, 화면이 Spring을 불러도 같은 결과가 나오는지 미리 확인할 방법이 없다.
1·2단계로 Spring에 JSON API 16개가 생겼으니, 이제 화면의 데이터 접근을 한 곳으로 모으고 Spring으로도 같은 화면이 나오는 것을 증명해 둘 차례다. 운영 데이터는 아직 SQLite에 있으므로 전환 자체는 5단계에서 스위치 하나로 한다.

## What Changes

- **데이터 포트**: 화면이 쓰는 데이터 접근(읽기 13종, 쓰기 3종, 사진 파일 1종)을 인터페이스 하나(`src/lib/data-port`)로 모은다. 구현체는 두 개다. (a) SQLite 구현체는 지금 저장소 함수를 감싸고, (b) Spring 구현체는 서버에서만 `fetch`로 Spring API를 부르고 응답을 zod로 검증한다. 환경 변수 `AUCTIONBOSS_DATA_SOURCE`(`sqlite`|`spring`, 기본 `sqlite`)와 `AUCTIONBOSS_SPRING_BASE`로 고른다.
- **화면 이전(동작 무변경)**: 페이지 5개와 화면용 라우트 3개가 데이터 포트만 쓰게 바꾼다. 페이지는 데이터를 맨 위에서 한꺼번에(병렬로) 읽고 하위 컴포넌트에 값으로 넘긴다. 렌더 결과는 바꾸지 않는다.
- **Spring 화면용 읽기 API 5개 추가**: `GET /api/items/filter-options`(용도·시도·시군구·법원 선택지), `GET /api/items/{id}/analyses`(분석 이력과 전체 건수), `GET /api/items/{id}/photos`(사진 목록, 서버 파일 경로 제외), `GET /api/worker-runs/status`(워커 상태 판정), `GET /api/collector-state/rotation`(다음 로테이션 법원). 계약의 원본으로 같은 경로의 Next API 라우트를 함께 만들고, 2단계 방식의 시나리오 골든으로 Spring과 비교한다. 지금 시각에 따라 결과가 달라지는 판정은 고정 Clock으로 비교한다.
- **폼 엔드포인트**: `POST /api/bookmarks/toggle`, `POST /api/feed/mark-read`는 Next에 남기고 데이터 포트로 쓰기를 한다. 303 리다이렉트와 `returnTo` 검증 규칙은 그대로다. `GET /api/photos/{itemId}/{seq}`도 화면이 직접 부르는 경로라 데이터 포트로 바꾼다.
- **동등성 검증**: 시드를 적재한 SQLite에서 두 구현체가 같은 값을 돌려주는지 포트 계약 테스트로 확인하고, 화면 렌더 테스트를 두 구현체로 모두 돌린다. 개발 환경에서는 `AUCTIONBOSS_DATA_SOURCE=spring`으로 Next를 띄워 화면 5개를 SQLite 모드와 비교한다.
- **요청 수 상한**: Spring 구현체가 화면 하나를 그릴 때 보내는 HTTP 요청 수의 상한을 화면별로 정하고 테스트로 고정한다.
- **lint 강제**: `src/app/**`에서 `@/lib/db`와 `better-sqlite3`를 가져오지 못하게 막는다. 예외는 기존 JSON API 라우트와 테스트뿐이다.

이 change에서 하지 않는 것:
- **운영 전환.** 운영 수집 워커는 SQLite에 쓰고 MySQL에는 시드만 있다. 지금 화면을 Spring으로 돌리면 낡은 데이터를 보여 준다. compose·K8s의 기본값은 `sqlite`로 두고, 5단계 데이터 이전 때 이 스위치로 전환한다.
- **기존 Next JSON API 라우트 은퇴.** `src/app/api/**`의 JSON API는 운영 분석 워커와 수집 경로가 쓰므로 5단계까지 SQLite 경로로 유지한다.
- 인증(7단계), 수집기 이식(4단계), 화면 디자인·문구 변경.

## Capabilities

### New Capabilities
- `web-data-port`: 화면과 화면용 라우트가 데이터 포트만 거쳐 데이터에 접근한다는 경계, 데이터 원천 선택(기본 SQLite), Spring 구현체의 응답 검증·오류 처리·요청 수 상한, 두 구현체의 동등성 요구사항.

### Modified Capabilities
- `spring-backend`: 화면용 읽기 API 5개의 계약 호환 요구사항을 더한다(ADDED). 기존 요구사항은 바뀌지 않는다.

`auction-viewing`, `bookmarks`, `run-observability`, `item-photos`의 화면 요구사항은 바뀌지 않는다. 화면은 같은 값을 다른 경로로 읽을 뿐이다.
`spring-backend`의 기존 요구사항 일부는 진행 중인 `add-spring-write-api`가 더한다. 이 change는 그 change가 아카이브된 뒤에 아카이브한다.

## Impact

- **신규 코드**: `src/lib/data-port/`(인터페이스, SQLite 구현체, Spring 구현체, 응답 zod 스키마, 원천 선택), Next API 라우트 5개(화면용 읽기 계약 원본), `backend/`의 `item`·`worker` 패키지에 읽기 엔드포인트 5개
- **바뀌는 코드**: 페이지 5개(데이터를 맨 위에서 비동기로 읽음), 화면용 라우트 3개, 렌더 테스트 3개(`await` 호출 방식만), `eslint.config.mjs`, `scripts/seed/scenarios.ts`(시나리오 추가, 단계별 시각 이동)
- **테스트**: 포트 계약 테스트, 두 구현체 렌더 테스트, 요청 수 테스트, Spring 시나리오 골든 확장, Spring 통합 테스트
- **바뀌지 않는 것**: 화면 HTML, `workers/`, 기존 JSON API의 동작, 운영 compose·K8s의 데이터 원천(SQLite)
- **보안 상태**: Next 서버만 Spring을 부른다. Spring 포트는 루프백(`127.0.0.1:8080`)에만 열리고 인증은 없다(7단계)
- **문서**: `docs/ROADMAP.md` 3단계 완료 기준 해석과 5단계 할 일, `docs/DEVELOPMENT_NOTES.md` 수치, `docs/REFERENCE.md` 환경 변수·API 목록
