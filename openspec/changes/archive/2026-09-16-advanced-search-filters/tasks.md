## 1. 도메인 및 저장소 계층 확장

- [x] 1.1 `src/lib/domain/item-query.ts`: `court`, `minDiscountRate`, `hasPhotos` 필드 추가 및 zod 파서 확장
- [x] 1.2 `src/lib/db/repository.ts`: `listCourtValues()` 추가 및 `listItems` 쿼리에 법원, 저감률, 사진 유무, 키워드(사건번호/건물명 OR) 조건 반영
- [x] 1.3 `src/lib/db/__tests__/repository.test.ts` 및 `src/lib/domain/__tests__/item-query.test.ts`: 신규 필터 조건 단위 테스트 추가 및 검증

## 2. API 및 URL 파서 확장

- [x] 2.1 `src/app/_lib/item-query-url.ts`: URL searchParams ↔ `ItemQuery` 양방향 변환에 신규 필터 매핑
- [x] 2.2 `src/app/api/items/route.ts`: API 쿼리 파라미터 연동
- [x] 2.3 `src/app/_lib/__tests__/item-query-url.test.ts`: URL 직렬화/역직렬화 단위 테스트 추가 및 통과 확인

## 3. UI 컴포넌트 갱신

- [x] 3.1 `src/app/_components/item-filter-form.tsx`: 법원 드롭다운, 저감률 선택 옵션, 사진 유무 체크박스 UI 추가
- [x] 3.2 `src/app/page.tsx`: `listCourtValues()`를 호출하여 필터 폼에 법원 옵션 전달
- [x] 3.3 `src/app/_lib/filter-chips.ts` 및 관련 테스트: 활성 필터 칩에 신규 조건 표시 및 개별 해제 지원

## 4. 품질 게이트 검증

- [x] 4.1 품질 게이트 4종 (`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`) 전체 통과 검증
