/**
 * `itemQuerySearchParams`의 왕복 테스트(switch-web-to-data-port 1.5).
 *
 * Spring 구현체가 목록 조건을 `GET /api/items?…`로 보낼 때 이 직렬화를 쓴다. 보낸 조건과
 * 서버가 파싱한 조건이 같지 않으면 화면이 Spring 모드에서만 다른 결과를 보여 준다.
 */
import { describe, expect, it } from "vitest";

import { itemQuerySearchParams, parseItemQuery, type ItemQuery } from "../index";

function roundTrip(query: ItemQuery): ItemQuery {
  const result = parseItemQuery(itemQuerySearchParams(query));
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.query;
}

const CASES: Array<[string, ItemQuery]> = [
  ["빈 조건", { page: 1, pageSize: 20 }],
  ["용도 반복 파라미터(쉼표 포함 값)", { page: 1, pageSize: 20, usageTypes: ["상가,오피스텔,근린시설", "아파트"] }],
  ["시도·시군구 반복", { page: 1, pageSize: 20, sidoValues: ["서울특별시", "경기도"], sigunguValues: ["강남구", "수원시 영통구"] }],
  ["가격·유찰·키워드", { page: 1, pageSize: 20, minPrice: 100_000_000, maxPrice: 900_000_000, minFailedBidCount: 2, addressKeyword: "a&b=c d" }],
  ["기일 범위와 지난 기일 제외", { page: 1, pageSize: 20, auctionDateFrom: "2026-01-01", auctionDateTo: "2026-12-31", excludePastAuctions: true }],
  ["관심·법원·저감률·사진·분석", { page: 1, pageSize: 20, bookmarked: false, court: "서울중앙지방법원", minDiscountRate: 30, hasPhotos: true, analyzed: true }],
  ["정렬과 방향", { page: 1, pageSize: 20, sort: "pricePerArea", direction: "desc" }],
  ["페이지와 페이지 크기", { page: 3, pageSize: 50 }],
];

describe("itemQuerySearchParams 왕복", () => {
  it.each(CASES)("%s", (_name, query) => {
    expect(roundTrip(query)).toStrictEqual(query);
  });

  it.each(["needsAnalysis", "promptVersion", "reanalysisCooldownHours"] as const)(
    "%s가 든 조건은 조용히 버리지 않고 던진다",
    (field) => {
      const query = { page: 1, [field]: field === "needsAnalysis" ? true : field === "promptVersion" ? "v1" : 6 } as ItemQuery;
      expect(() => itemQuerySearchParams(query)).toThrow(field);
    },
  );
});
