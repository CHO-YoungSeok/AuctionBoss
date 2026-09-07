# Design: add-item-search-filters

## Context

동기는 proposal.md 참조. 현 구조: `listItems({page, pageSize, analyzed})`가 SQLite에 고정 정렬(`auction_date IS NULL, auction_date ASC, id ASC`)로 질의하고, `GET /api/items`가 zod로 파라미터를 검증하며, `src/app/page.tsx`(서버 컴포넌트)가 저장소를 직접 호출한다. analyzer 워커가 `?analyzed=false&pageSize=N`을 호출하므로 이 계약은 깨뜨릴 수 없다.

## Goals / Non-Goals

**Goals:**
- 필터·정렬을 저장소 한 곳에서 조립해 API와 페이지가 같은 동작을 공유
- 기존 호출자(analyzer)가 무변경으로 동작
- 동적 정렬을 SQL 인젝션 없이 구현

**Non-Goals:**
- 전문 검색(FTS5), 커서 페이지네이션, 저장된 검색 조건, 지도 검색

## Decisions

### D1. 필터를 `ItemQuery` 하나의 타입으로 모으고 저장소에서 SQL 조립

`listItems(query: ItemQuery)` — 기존 `{page, pageSize, analyzed}`에 `usageTypes?: string[]`, `minPrice?: number`, `maxPrice?: number`, `minFailedBidCount?: number`, `addressKeyword?: string`, `sort?: SortKey`, `direction?: 'asc'|'desc'`를 더한다. 모든 새 필드는 optional이며 생략 시 기존 동작과 동일하다.

- 왜 저장소에 두는가: API와 서버 컴포넌트가 같은 함수를 쓰므로 필터 로직이 한 곳에만 존재한다. UI에서 SQL을 만들지 않는다.
- `WHERE` 절은 조건이 있는 것만 배열로 모아 `AND`로 연결하고, 값은 전부 **바인딩 파라미터**로 넘긴다. 문자열 보간 금지.
- `addressKeyword`는 `address LIKE ?`에 `%keyword%`로 바인딩한다. 사용자 입력의 `%`/`_`는 LIKE 와일드카드라 의도치 않게 넓게 매칭되므로 **이스케이프**한다(`ESCAPE` 절 사용).
- 전체 건수(`total`)는 같은 `WHERE`를 적용한 `COUNT(*)`로 계산한다 — 필터 적용 후 건수여야 페이지네이션이 맞는다.

### D2. 동적 정렬은 화이트리스트 맵으로만

`SortKey`를 `'auctionDate' | 'minBidPrice' | 'bidRatio' | 'failedBidCount'` 리터럴 유니언으로 정의하고, 키 → SQL 표현식 맵을 상수로 둔다. 사용자 입력이 SQL에 직접 들어가는 경로를 만들지 않는다.

- `bidRatio`(감정가 대비 최저가 비율)는 컬럼이 아니라 계산식이다: `CAST(min_bid_price AS REAL) / appraisal_price`. 감정가가 0이거나 NULL이면 0 나눗셈이 되므로 `NULLIF(appraisal_price, 0)`으로 감싸 NULL로 만들고, NULL 처리 규칙(아래)에 맡긴다.
- 모든 정렬에 `<expr> IS NULL` 을 첫 정렬 키로 붙여 **NULL은 방향과 무관하게 항상 뒤로** 보낸다. 감정가·매각기일이 비어 있는 행이 실제로 존재하므로(수집 데이터 확인됨) 이게 없으면 내림차순에서 빈 행이 맨 위를 차지한다.
- 마지막에 항상 `id`를 붙여 안정 정렬을 보장한다 — 없으면 동률 행이 페이지 경계에서 중복·누락된다.

### D3. 용도 목록은 저장 데이터에서 도출 (`listUsageTypes()`)

`SELECT DISTINCT usage_type FROM items WHERE usage_type IS NOT NULL ORDER BY usage_type`. 하드코딩하지 않는 이유는 수집 범위가 늘면 새 용도가 자동으로 나타나야 하고, 소스의 용도 문자열을 우리가 통제하지 못하기 때문이다.

- API로도 노출한다: `GET /api/items/usage-types`. 목록 페이지는 서버 컴포넌트라 저장소를 직접 호출하면 되지만, API가 있어야 스펙의 "용도 목록 조회" 요구사항이 외부에서 검증 가능하다.
- 라우트 경로 주의: `src/app/api/items/[id]/route.ts`가 이미 있으므로 `usage-types`는 동적 세그먼트와 충돌한다. Next.js는 정적 세그먼트를 동적보다 우선하므로 `api/items/usage-types/route.ts`가 먼저 매칭되지만, 이 우선순위에 의존하는 것이 불편하다면 `api/usage-types`로 분리해도 된다. **정적 우선 규칙을 신뢰하고 `api/items/usage-types`를 쓰되, 구현 시 `/api/items/usage-types`와 `/api/items/123`이 모두 올바르게 라우팅되는지 실제로 확인한다.**

### D4. URL 파라미터 이름과 파싱

`?usage=아파트&usage=상가,오피스텔,근린시설&minPrice=&maxPrice=500000000&minFailed=3&q=강남&sort=bidRatio&dir=asc&page=2`

- **`usage`는 반복 파라미터**(`usage=a&usage=b`)다. 쉼표 구분을 쓸 수 없다: 실제 수집 데이터에 `"상가,오피스텔,근린시설"`처럼 **쉼표를 포함한 용도 문자열이 존재한다**(`NOTES.md` §8의 실제 응답 10행 중 6행, 어댑터 fixture에도 고정됨). 쉼표로 split하면 하나의 실제 용도가 존재하지 않는 세 개로 쪼개져 아무것도 매칭되지 않는다.
  - 서버 컴포넌트의 `searchParams`가 `string | string[]`를 주는 문제는 파라미터 읽기 헬퍼 한 곳에서 정규화해 흡수한다. HTML 체크박스 그룹이 반복 파라미터를 그대로 보내므로 UI 쪽은 오히려 단순해진다.
  - (초기 설계는 쉼표 구분이었고 "용도에 쉼표가 없다"를 전제로 했다. 구현 중 실데이터로 반증되어 정정했다.)
- API와 페이지가 **같은 파서**를 공유한다(`src/lib/domain`에 zod 스키마 하나). 두 곳에서 따로 파싱하면 동작이 갈라진다.
- **API는 잘못된 값을 400으로 거부**하고, **페이지는 무시하고 기본값으로 복구**한다. 이 비대칭은 의도적이다 — API 클라이언트(워커)는 오타를 알아야 하지만, 사람이 URL을 잘못 만졌을 때 화면이 에러로 죽는 것은 나쁘다. 기존 코드가 이미 이 방침(`page` 처리)을 쓰고 있어 일관된다.

### D5. 인덱스

현재 데이터는 수백 건이라 필터 없는 전체 스캔도 충분히 빠르다. 그래도 정렬·필터 조합이 늘어나므로 `usage_type`과 `min_bid_price`에 단일 컬럼 인덱스를 추가한다(스키마의 `CREATE INDEX IF NOT EXISTS` 패턴 유지). `bidRatio`는 계산식이라 인덱스로 못 만든다 — 데이터가 수만 건으로 늘면 생성 열(generated column) + 인덱스를 검토한다.

**실측 정정**: 이 인덱스는 **필터에는 쓰이지만 정렬에는 쓰이지 않는다.** `EXPLAIN QUERY PLAN` 확인 결과 용도 필터와 가격 범위 필터는 인덱스를 타지만(`SEARCH ... USING INDEX`), D2가 요구하는 `(<expr>) IS NULL` 선행 정렬 키가 인덱스 순서 스캔을 무력화해 정렬은 `SCAN + TEMP B-TREE`가 된다. `IS NULL` 선행 키는 NULL 배치를 위해 의도한 것이라 그대로 유지한다. 정렬 성능이 문제가 되면 `NULLS LAST`(번들 SQLite 3.53.4에서 사용 가능)로 바꾸면 관측 동작을 유지하면서 인덱스를 쓸 수 있다 — 현 규모에서는 무관하다.

## Risks / Trade-offs

- [필터 조합이 늘면서 `listItems`가 복잡해짐] → 조건 조립을 작은 헬퍼로 분리하고, 조합별 단위 테스트로 고정한다. 조건이 더 늘면 쿼리 빌더 도입을 재검토.
- [기존 `analyzed=false` 계약을 실수로 깨뜨림] → 스펙에 "기존 계약 유지" 시나리오를 명시했고, 새 파라미터 없이 호출하는 회귀 테스트를 필수로 둔다.
- [LIKE 검색의 성능] → 앞쪽 와일드카드(`%keyword%`)는 인덱스를 못 쓴다. 현 규모에서는 무해하며, 필요해지면 FTS5로 옮긴다(그때 스펙의 관측 가능한 동작은 바뀌지 않는다).
- [사용자 입력 `%`가 와일드카드로 새는 것] → `ESCAPE` 절로 막고 테스트로 고정.

## Open Questions

- 정렬 기본값을 매각기일 오름차순 그대로 둘지, "감정가 대비 최저가가 낮은 순"을 기본으로 할지 — 실제로 써보고 결정해도 스펙·구조에 영향 없다.
