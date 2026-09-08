/**
 * `ItemQuery` → 목록 페이지 URL 직렬화.
 *
 * 페이지네이션 링크가 필터를 떨어뜨리는 것이 이 화면에서 가장 흔한 버그라, 링크를
 * 손으로 조립하지 않고 **현재 적용된 조건 객체 하나에서** 만든다. lenient 파서가 만든
 * `ItemQuery`를 그대로 되돌리므로 "링크를 눌러 이동 → 다시 파싱"이 같은 조건으로
 * 왕복한다(정규화 왕복이라, URL에 있던 잘못된 값은 링크에 실려 퍼지지 않는다).
 *
 * `usage`는 **반복 파라미터**다(`usage=a&usage=b`). 실제 용도 문자열에 쉼표가 들어 있어
 * (`"상가,오피스텔,근린시설"`) 쉼표로 합칠 수 없다 — 자세한 근거는
 * `src/lib/domain/item-query.ts`의 `MULTI_VALUE_PARAMS` 주석 참조.
 * 그래서 `set`이 아니라 값마다 `append`한다.
 */
import { DEFAULT_PAGE_SIZE, type ItemQuery } from "@/lib/domain";

/** 목록 페이지 경로. 필터를 모두 버린 "초기화" 링크이기도 하다. */
export const ITEM_LIST_PATH = "/";

/**
 * 조건을 URL 파라미터로 되돌린다.
 *
 * 기본값(1페이지, 기본 페이지 크기)은 생략해 URL을 짧게 유지한다 — 파서가 없는 값에
 * 같은 기본값을 주므로 결과는 동일하다.
 */
export function itemQuerySearchParams(query: ItemQuery): URLSearchParams {
  const params = new URLSearchParams();

  for (const usageType of query.usageTypes ?? []) {
    params.append("usage", usageType); // 값마다 하나씩 — 절대 쉼표로 합치지 않는다
  }
  for (const sido of query.sidoValues ?? []) {
    params.append("sido", sido); // usage와 같은 반복 파라미터 인코딩(design.md D1)
  }
  for (const sigungu of query.sigunguValues ?? []) {
    params.append("sigungu", sigungu);
  }
  // 억/만원(minEok/minMan 등)은 왕복하지 않는다 — ItemQuery는 합산된 원 단위 값만 갖고
  // 있고(item-query.ts의 `effectivePriceBound`), 그게 API 계약이다(design.md D3). 링크가
  // 항상 minPrice/maxPrice로 정규화되는 편이 lenient 파서의 다른 필드들과 일관된다.
  if (query.minPrice !== undefined) params.set("minPrice", String(query.minPrice));
  if (query.maxPrice !== undefined) params.set("maxPrice", String(query.maxPrice));
  if (query.minFailedBidCount !== undefined) {
    params.set("minFailed", String(query.minFailedBidCount));
  }
  if (query.addressKeyword !== undefined) params.set("q", query.addressKeyword);
  if (query.auctionDateFrom !== undefined) params.set("dateFrom", query.auctionDateFrom);
  if (query.auctionDateTo !== undefined) params.set("dateTo", query.auctionDateTo);
  if (query.excludePastAuctions !== undefined) {
    params.set("excludePast", String(query.excludePastAuctions));
  }
  if (query.bookmarked !== undefined) params.set("bookmarked", String(query.bookmarked));
  if (query.sort !== undefined) params.set("sort", query.sort);
  if (query.direction !== undefined) params.set("dir", query.direction);
  // 페이지에는 UI가 없지만 URL로 들어온 값은 유지한다 — 링크를 눌렀다고 조건이
  // 조용히 바뀌면 안 된다.
  if (query.analyzed !== undefined) params.set("analyzed", String(query.analyzed));
  if (query.pageSize !== undefined && query.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(query.pageSize));
  }
  if (query.page !== undefined && query.page !== 1) params.set("page", String(query.page));

  return params;
}

/**
 * 목록 페이지 링크. `overrides`로 일부 조건만 바꿔 나머지는 전부 유지한다
 * (페이지네이션은 `{ page }`만 바꿔 필터·정렬을 그대로 들고 간다).
 */
export function itemListHref(query: ItemQuery, overrides?: Partial<ItemQuery>): string {
  const params = itemQuerySearchParams({ ...query, ...overrides });
  const search = params.toString();
  return search === "" ? ITEM_LIST_PATH : `${ITEM_LIST_PATH}?${search}`;
}
