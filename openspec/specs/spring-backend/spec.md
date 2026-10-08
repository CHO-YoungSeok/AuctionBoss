# spring-backend Specification

## Purpose

Spring Boot 백엔드와 MySQL을 도입해, 기존 Next.js/SQLite 백엔드가 제공하던 데이터와 API를 같은 계약으로 제공하는 토대를 만든다. 수집 범위를 넓히기 전에 실제 수집 데이터를 더미 시드로 써서 개발과 시연을 가능하게 한다.

## Requirements

### Requirement: 스키마 버전 관리
백엔드는 데이터베이스 스키마를 버전이 매겨진 마이그레이션으로만 만들고 바꿔야 한다(SHALL). 빈 데이터베이스에 대해 백엔드를 시작하면 모든 마이그레이션이 순서대로 적용되어 기존 SQLite와 같은 8개 테이블(`items`, `analyses`, `item_changes`, `worker_runs`, `bookmarks`, `feed_reads`, `collector_state`, `item_photos`)이 만들어져야 한다(SHALL). 각 테이블은 기존 SQLite 테이블과 같은 컬럼, 같은 고유 제약, 같은 외래 키 삭제 규칙(물건 삭제 시 하위 행 삭제)을 가져야 한다(SHALL).

이미 적용된 마이그레이션 파일이 바뀌었으면 백엔드는 시작을 거부해야 한다(MUST) — 운영 중인 스키마와 코드가 어긋난 채 동작하면 안 되기 때문이다.

#### Scenario: 빈 데이터베이스에서 시작
- **WHEN** 테이블이 하나도 없는 데이터베이스로 백엔드를 시작한다
- **THEN** 8개 테이블과 인덱스가 만들어지고, 적용된 마이그레이션 이력이 데이터베이스에 남는다

#### Scenario: 이미 최신인 데이터베이스에서 재시작
- **WHEN** 모든 마이그레이션이 적용된 데이터베이스로 백엔드를 다시 시작한다
- **THEN** 스키마는 바뀌지 않고 기존 데이터도 그대로 남는다

#### Scenario: 적용된 마이그레이션이 변조됨
- **WHEN** 이미 적용된 마이그레이션 파일의 내용이 바뀐 상태로 백엔드를 시작한다
- **THEN** 백엔드는 시작하지 않고 어떤 마이그레이션이 어긋났는지 로그에 남긴다

#### Scenario: 고유 제약 유지
- **WHEN** 같은 법원·사건번호·물건번호를 가진 물건을 두 번 저장하려 한다
- **THEN** 데이터베이스가 두 번째 저장을 거부한다

### Requirement: 금액과 시각의 정확한 저장
금액 컬럼(감정가, 최저매각가격, 차수별 최저가)은 1천억 원 이상의 값도 손실 없이 저장해야 한다(SHALL). 시각 컬럼은 밀리초 정밀도로 저장해야 하며(SHALL), 서버나 데이터베이스의 시간대 설정과 무관하게 같은 순간을 같은 값으로 돌려줘야 한다(MUST). 매각기일처럼 날짜만 의미가 있는 값은 날짜로 저장해야 한다(SHALL).

#### Scenario: 큰 금액 저장
- **WHEN** 감정가 51,005,255,120원인 물건을 저장하고 다시 읽는다
- **THEN** 읽은 값이 정확히 51,005,255,120이다

#### Scenario: 시간대가 다른 환경
- **WHEN** 시간대 설정이 서로 다른 두 환경에서 같은 행의 수집 시각을 조회한다
- **THEN** 두 응답의 시각 문자열이 같다

### Requirement: 더미 시드 데이터
개발·시연 환경에서는 기존 수집 데이터로 만든 시드가 적재되어야 한다(SHALL). 시드는 물건, 변경 이력, 분석, 워커 회차 기록을 포함해야 하며(SHALL), 물건 id를 원본과 같게 유지해야 한다(SHALL) — 물건 상세 주소(`/items/{id}`)와 변경 이력 연결이 원본과 같아야 하기 때문이다.

시드에는 개인을 식별할 수 있는 이름이 들어 있으면 안 된다(MUST NOT). 사건 비고와 분석 본문에 나오는 개인 이름은 가림 처리된 값으로 바뀌어야 한다(SHALL). 기관명(예: 주택도시보증공사)과 주소, 사건번호처럼 법원이 공개한 사건 식별 정보는 그대로 둔다.

운영 환경에서는 시드가 적재되면 안 된다(MUST NOT).

#### Scenario: 개발 환경 기동
- **WHEN** 개발·시연 설정으로 빈 데이터베이스와 함께 백엔드를 시작한다
- **THEN** 물건 809건, 변경 이력 4,008건, 분석 12건이 적재되고, 원본과 같은 id로 조회된다

#### Scenario: 개인 이름 가림
- **WHEN** 원본 사건 비고에 "홍길동의 임차보증금반환 채권"처럼 개인 이름이 들어 있는 물건을 시드에서 조회한다
- **THEN** 비고와 그 물건의 분석 본문에는 개인 이름 대신 가림 표시가 들어 있고, 기관명은 그대로 남아 있다

#### Scenario: 운영 환경 기동
- **WHEN** 운영 설정으로 빈 데이터베이스와 함께 백엔드를 시작한다
- **THEN** 스키마만 만들어지고 물건은 0건이다

### Requirement: 물건 목록 API 호환
백엔드는 `GET /api/items`를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL). 같은 데이터와 같은 요청 파라미터에 대해 응답 형태(`{ items, total, page, pageSize }`), 각 물건의 필드 이름과 값, 정렬 순서, 페이지 경계가 기존 API와 같아야 한다(SHALL).

지원해야 하는 파라미터는 기존 API와 같다(SHALL): `page`, `pageSize`(기본 20, 최대 200), `sort`(`auctionDate`, `minBidPrice`, `bidRatio`, `failedBidCount`, `pricePerArea`), `dir`, `q`, `usage`(여러 번), `minPrice`, `maxPrice`, `minEok`, `minMan`, `maxEok`, `maxMan`, `minFailed`, `minDiscountRate`, `sido`, `sigungu`, `court`, `dateFrom`, `dateTo`, `excludePast`, `bookmarked`, `hasPhotos`, `analyzed`, `needsAnalysis`, `promptVersion`.

잘못된 파라미터는 400과 `{ error, details: [{ field, message }] }` 형태로 거절해야 한다(SHALL). `details`의 `field`는 URL 파라미터 이름이어야 한다(SHALL).

`needsAnalysis=true`의 판정 규칙(분석 결과가 있는 물건 중, 최신 분석 이후 실제 변경이 있었거나 최신 분석의 프롬프트 버전이 요청과 다른 물건, 단 재분석 최소 간격 안의 물건은 제외)과 재분석 최소 간격의 출처(서버 설정, 요청 파라미터 아님)는 기존 규칙과 같아야 한다(SHALL).

#### Scenario: 기본 목록
- **WHEN** 파라미터 없이 목록을 요청한다
- **THEN** 매각기일 오름차순 20건과 전체 건수가 기존 API와 같은 형태로 돌아온다

#### Scenario: 기존 API와 같은 결과
- **WHEN** 같은 시드 데이터에 대해 정렬 5종과 방향 2종, 주요 필터 조합을 기존 API와 백엔드에 똑같이 요청한다
- **THEN** 두 응답의 JSON이 같다

#### Scenario: 잘못된 정렬 값
- **WHEN** `sort=nope`으로 요청한다
- **THEN** 400과 함께 `details`에 `field`가 `sort`인 항목이 들어 있다

#### Scenario: 키워드 검색의 특수 문자
- **WHEN** `q`에 `%`나 `_`가 들어간 키워드로 요청한다
- **THEN** 해당 문자가 와일드카드가 아니라 글자 그대로 검색된다

#### Scenario: 재분석 대상 조회
- **WHEN** 최신 분석 이후 최저매각가격이 바뀐 물건과 바뀌지 않은 물건이 있는 상태에서 `needsAnalysis=true&promptVersion=<현재 버전>`으로 요청한다
- **THEN** 바뀐 물건만 돌아오고, 한 번도 분석되지 않은 물건은 포함되지 않는다

### Requirement: 물건 상세·변경 이력·용도 목록 API 호환
백엔드는 다음 API를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL).

- `GET /api/items/{id}`: `{ item, analysis }`. `analysis`는 최신 분석이며 없으면 `null`
- `GET /api/items/{id}/changes`: `{ changes }`. 시간순 변경 이력
- `GET /api/items/usage-types`: `{ usageTypes }`. 물건이 없으면 빈 배열

`{id}`가 숫자가 아니거나 해당 물건이 없으면 404와 `{ error: "물건을 찾을 수 없습니다: id=<id>" }`를 돌려줘야 한다(SHALL).

#### Scenario: 분석이 있는 물건 상세
- **WHEN** 분석이 있는 물건의 상세를 요청한다
- **THEN** 물건 필드와 최신 분석(본문, 모델, 프롬프트 버전, 분석 시각)이 기존 API와 같은 형태로 돌아온다

#### Scenario: 없는 물건
- **WHEN** `/api/items/999999` 또는 `/api/items/abc`를 요청한다
- **THEN** 404와 기존 API와 같은 오류 메시지가 돌아온다

#### Scenario: 변경 이력 순서
- **WHEN** 변경 이력이 여러 건인 물건의 이력을 요청한다
- **THEN** 기준점 항목과 변경 항목이 기존 API와 같은 순서와 필드로 돌아온다

### Requirement: 헬스체크 호환
백엔드는 `GET /api/health`를 기존 계약과 같은 형태로 제공해야 한다(SHALL). 데이터베이스에 연결되면 200과 `{ status: "ok", database: "connected", timestamp, uptime }`을, 연결되지 않으면 503과 `{ status: "error", database: "disconnected", ... }`를 돌려줘야 한다(SHALL).

#### Scenario: 정상
- **WHEN** 데이터베이스가 떠 있는 상태에서 헬스체크를 요청한다
- **THEN** 200과 `status: "ok"`가 돌아온다

#### Scenario: 데이터베이스 중단
- **WHEN** 데이터베이스를 멈춘 뒤 헬스체크를 요청한다
- **THEN** 503과 `status: "error"`가 돌아온다

### Requirement: 컨테이너 기반 실행
`docker compose`로 MySQL과 백엔드를 함께 띄울 수 있어야 한다(SHALL). 백엔드는 MySQL이 요청을 받을 수 있게 된 뒤에 시작해야 하며(SHALL), 데이터베이스 데이터는 컨테이너를 지웠다 다시 만들어도 볼륨에 남아야 한다(SHALL). 접속 정보 같은 비밀 값은 이미지나 저장소에 고정되지 않고 환경 변수로 주입되어야 한다(MUST).

기존 Next.js 앱, 수집기, 분석기의 실행 방식과 SQLite 데이터는 이 구성 추가로 영향을 받으면 안 된다(MUST NOT).

#### Scenario: 처음 기동
- **WHEN** 빈 상태에서 `docker compose up`으로 MySQL과 백엔드를 띄운다
- **THEN** MySQL이 준비된 뒤 백엔드가 시작되고, 헬스체크가 200을 돌려주며, 목록 API가 시드 데이터를 돌려준다

#### Scenario: 재기동 후 데이터 유지
- **WHEN** 컨테이너를 내렸다가 볼륨을 지우지 않고 다시 띄운다
- **THEN** 이전 데이터가 그대로 조회되고 시드가 중복 적재되지 않는다

#### Scenario: 기존 경로 무영향
- **WHEN** 백엔드와 MySQL을 띄운 상태에서 기존 Next.js 앱을 실행한다
- **THEN** 기존 앱은 지금처럼 SQLite를 읽고 쓰며 기존 테스트 전부가 통과한다
