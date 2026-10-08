## MODIFIED Requirements

### Requirement: 더미 시드 데이터
개발·시연 환경에서는 기존 수집 데이터로 만든 시드가 적재되어야 한다(SHALL). 시드는 물건, 변경 이력, 분석, 워커 회차 기록을 포함해야 하며(SHALL), 물건 id를 원본과 같게 유지해야 한다(SHALL) — 물건 상세 주소(`/items/{id}`)와 변경 이력 연결이 원본과 같아야 하기 때문이다.

시드에는 개인을 식별할 수 있는 이름이 들어 있으면 안 된다(MUST NOT). 사건 비고와 분석 본문에 나오는 개인 이름은 가림 처리된 값으로 바뀌어야 한다(SHALL). 기관명(예: 주택도시보증공사)과 주소, 사건번호처럼 법원이 공개한 사건 식별 정보는 그대로 둔다.

시드는 시드 적재 설정을 명시적으로 켠 실행에서만 적재되어야 하며(SHALL), 그 설정이 켜지지 않은 실행에서는 적재되면 안 된다(MUST NOT).

#### Scenario: 개발 환경 기동
- **WHEN** 개발·시연 설정으로 빈 데이터베이스와 함께 백엔드를 시작한다
- **THEN** 물건 809건, 변경 이력 4,008건, 분석 12건이 적재되고, 원본과 같은 id로 조회된다

#### Scenario: 개인 이름 가림
- **WHEN** 원본 사건 비고에 "홍길동의 임차보증금반환 채권"처럼 개인 이름이 들어 있는 물건을 시드에서 조회한다
- **THEN** 비고와 그 물건의 분석 본문에는 개인 이름 대신 가림 표시가 들어 있고, 기관명은 그대로 남아 있다

#### Scenario: 운영 환경 기동
- **WHEN** 시드 적재 설정을 켜지 않고 빈 데이터베이스와 함께 백엔드를 시작한다
- **THEN** 스키마만 만들어지고 물건은 0건이다

### Requirement: 물건 목록 API 호환
백엔드는 `GET /api/items`를 기존 Next.js API와 같은 계약으로 제공해야 한다(SHALL). 같은 데이터와 같은 요청 파라미터에 대해 응답 형태(`{ items, total, page, pageSize }`), 각 물건의 필드 이름과 값, 정렬 순서, 페이지 경계가 기존 API와 같아야 한다(SHALL).

지원해야 하는 파라미터는 기존 API와 같다(SHALL).

- 페이지·정렬: `page`, `pageSize`(기본 20, 최대 200), `sort`(`auctionDate`, `minBidPrice`, `bidRatio`, `failedBidCount`, `pricePerArea`), `dir`
- 검색·필터: `q`, `usage`(여러 번), `minPrice`, `maxPrice`, `minEok`, `minMan`, `maxEok`, `maxMan`, `minFailed`, `minDiscountRate`, `sido`(여러 번), `sigungu`(여러 번), `court`, `dateFrom`, `dateTo`, `excludePast`, `bookmarked`, `hasPhotos`
- 분석: `analyzed`, `needsAnalysis`, `promptVersion`

잘못된 파라미터는 400과 `{ error, details: [{ field, message }] }` 형태로 거절해야 한다(SHALL). `details`의 `field`는 URL 파라미터 이름이어야 한다(SHALL).

`needsAnalysis=true`의 판정 규칙(분석 결과가 있는 물건 중, 최신 분석 이후 실제 변경이 있었거나 최신 분석의 프롬프트 버전이 요청과 다른 물건, 단 재분석 최소 간격 안의 물건은 제외)과 재분석 최소 간격의 출처(서버 설정, 요청 파라미터 아님)는 기존 규칙과 같아야 한다(SHALL). `needsAnalysis=true` 결과는 요청의 `sort`·`dir`와 무관하게 최신 분석 시각이 가장 오래된 물건부터, 같으면 id 오름차순으로 정렬해야 한다(SHALL) — 기존 API와 같은 순서여야 워커가 같은 물건을 집는다.

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

#### Scenario: 재분석 대상 정렬
- **WHEN** 재분석 대상이 여러 건인 상태에서 `sort`·`dir`를 함께 지정해 `needsAnalysis=true&promptVersion=<현재 버전>`으로 요청한다
- **THEN** 지정한 정렬과 무관하게 최신 분석 시각이 가장 오래된 물건부터 돌아오고, 분석 시각이 같으면 id 오름차순이며, 순서가 기존 API와 같다

#### Scenario: 지역 복수값
- **WHEN** `sido`나 `sigungu`를 여러 번 지정해 요청한다
- **THEN** 지정한 값 중 하나라도 일치하는 물건이 돌아오고, 결과가 기존 API와 같다
