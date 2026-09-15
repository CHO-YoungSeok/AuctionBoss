## Context

현재 물건 목록 페이지는 용도, 가격 범위, 시/도, 시군구 등 기초 조건 필터링만 제공한다.
경매 탐색의 효율성을 높이기 위해 법원별 필터링, 감정가 대비 저감률(할인율) 필터링, 사진 보유 물건만 보기, 사건번호 및 건물명 키워드 검색 확장이 요구된다.

## Goals / Non-Goals

**Goals:**
- `ItemQuery` 및 DB 저장소 `listItems`에 `court`, `minDiscountRate`, `hasPhotos` 필터 추가.
- `q`(키워드 검색)를 주소(`address`)뿐 아니라 사건번호(`case_no`), 건물명(`building_name`)까지 확장(OR 검색).
- `listCourtValues()` 저장소 함수를 추가하여 저장된 물건들의 법원 목록을 동적으로 제공.
- `item-filter-form.tsx` UI에 법원 선택 셀렉트, 저감률 버튼/셀렉트, 사진 보유 체크박스 추가.
- URL 쿼리 파서(`item-query-url.ts`) 및 API 엔드포인트(`GET /api/items`)에 신규 파라미터 매핑 및 양방향 동기화.

**Non-Goals:**
- 복잡한 풀텍스트 검색 엔진(Elasticsearch 등) 도입 (SQLite `LIKE` 쿼리로 충분히 빠르고 가벼움).

## Decisions

### D1. 저감률(할인율) 필터링 방식
할인율은 `(appraisal_price - min_bid_price) / appraisal_price * 100` 로 계산된다.
DB 레벨에서 `appraisal_price > 0 AND (CAST(appraisal_price - min_bid_price AS REAL) / appraisal_price * 100) >= @minDiscountRate` 조건을 부여하여 20%, 30%, 50% 이상 저감된 물건을 정확히 필터링한다.

### D2. 키워드 검색(`q`) 확장
기존 `address LIKE %q%` 조건에서 `(address LIKE %q% OR case_no LIKE %q% OR (building_name IS NOT NULL AND building_name LIKE %q%))` 로 확장한다.
단일 검색창에서 주소(예: "신림동"), 사건번호(예: "2024타경"), 건물명(예: "현대아파트") 중 어떤 값을 입력해도 자연스럽게 검색된다.

### D3. 하위 호환성 유지
기존 쿼리 파라미터가 없는 호출은 기존과 100% 동일하게 동작하도록 optional 필드로 구성하며, 분석 워커 및 기존 API 클라이언트에 영향을 주지 않는다.

## Risks / Trade-offs

- **[키워드 OR 검색 속도]**
  → 현재 수백~수천 건 수준의 데이터베이스이므로 SQLite에서 인덱스/테이블 스캔 비용이 수 밀리초 내외로 매우 빠르다.
