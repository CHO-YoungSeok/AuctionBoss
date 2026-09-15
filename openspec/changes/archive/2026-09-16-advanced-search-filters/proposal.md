## Why

현재 AuctionBoss의 검색 및 필터 기능은 `q`(소재지만 부분일치 검색), `usageTypes`(용도), `minPrice`/`maxPrice`, `failedBids` 등 기본 항목에 한정되어 있다.
실제 경매 투자자와 서비스 사용자는 법원 단위 필터링, 감정가 대비 저감률(할인율) 20%/30%/50% 이상 급매/유찰 물건 발굴, 사진이 수집된 물건만 보기, 사건번호 및 건물명 키워드 검색 등 고도화된 탐색 기능을 필요로 한다.

## What Changes

- **법원 필터 (`court`)**: 저장된 물건들의 담당 법원 목록을 기반으로 특정 법원 물건만 조회할 수 있는 필터 추가.
- **최소 저감률 필터 (`minDiscountRate`)**: 감정가 대비 최저매각가격 할인 비율(예: 20%, 30%, 50% 이상 할인)로 물건을 필터링하는 조건 추가.
- **사진 보유 필터 (`hasPhotos`)**: 수집된 사진이 1장 이상 있는 물건(`photo_status = 'collected'`)만 선별하여 보는 필터 추가.
- **통합 키워드 검색 (`q`) 확장**: 기존 소재지(`address`) 단일 검색에서 `case_no`(사건번호), `building_name`(건물명)까지 확장한 OR 검색 지원.
- **UI 및 API 연동**:
  - `item-filter-form.tsx` 컴포넌트에 법원 선택 드롭다운, 저감률 선택 라디오/버튼, 사진 보유 체크박스 추가.
  - `ItemQuery` 파서, URL 파서, `listItems` DB 쿼리 및 `GET /api/items` 파라미터 확장.

## Capabilities

### Modified Capabilities
- `auction-viewing`: 법원 필터(`court`), 최소 저감률 필터(`minDiscountRate`), 사진 보유 필터(`hasPhotos`), 확장 키워드 검색(`q`) 요구사항 추가

## Impact

- **도메인 및 저장소**: `src/lib/domain/item-query.ts`, `src/lib/db/repository.ts` 쿼리 조건 확장
- **API 및 프론트엔드**: `src/app/_lib/item-query-url.ts`, `src/app/_components/item-filter-form.tsx`, `src/app/page.tsx`
- **호환성**: 모든 신규 필터는 optional이며, 생략 시 기존 동작과 100% 동일하게 유지됨.
