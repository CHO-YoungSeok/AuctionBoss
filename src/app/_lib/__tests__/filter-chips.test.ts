import { describe, expect, it } from "vitest";

import type { ItemQuery } from "@/lib/domain";

import { buildFilterChips } from "../filter-chips";

const BASE: ItemQuery = { page: 1, pageSize: 20 };

describe("buildFilterChips", () => {
  it("필터가 없으면 빈 배열이다", () => {
    expect(buildFilterChips(BASE)).toEqual([]);
  });

  it("용도·지역은 값들을 쉼표로 이어 하나의 칩으로 보여준다", () => {
    const chips = buildFilterChips({
      ...BASE,
      usageTypes: ["아파트", "다세대"],
      sidoValues: ["서울특별시"],
      sigunguValues: ["관악구", "강남구"],
    });
    expect(chips.map((c) => c.label)).toEqual([
      "시/도: 서울특별시",
      "시/군/구: 관악구, 강남구",
      "용도: 아파트, 다세대",
    ]);
  });

  it("빈 배열 usageTypes/sidoValues는 칩을 만들지 않는다(hasActiveFilters와 같은 규칙)", () => {
    expect(buildFilterChips({ ...BASE, usageTypes: [], sidoValues: [] })).toEqual([]);
  });

  it("가격은 한쪽만 지정해도, 양쪽 다 지정해도 칩 하나다", () => {
    expect(buildFilterChips({ ...BASE, minPrice: 100_000_000 })[0]).toMatchObject({
      key: "price",
      label: "가격: 1억 이상",
      clear: { minPrice: undefined, maxPrice: undefined },
    });
    expect(buildFilterChips({ ...BASE, maxPrice: 300_000_000 })[0]).toMatchObject({
      label: "가격: 3억 이하",
    });
    expect(
      buildFilterChips({ ...BASE, minPrice: 100_000_000, maxPrice: 300_000_000 })[0],
    ).toMatchObject({ label: "가격: 1억 ~ 3억" });
  });

  it("기일 범위도 가격과 같은 규칙(한쪽/양쪽/칩 하나)을 따른다", () => {
    expect(buildFilterChips({ ...BASE, auctionDateFrom: "2026-01-01" })[0]).toMatchObject({
      key: "auctionDateRange",
      label: "기일: 2026-01-01 이후",
      clear: { auctionDateFrom: undefined, auctionDateTo: undefined },
    });
    expect(buildFilterChips({ ...BASE, auctionDateTo: "2026-12-31" })[0]).toMatchObject({
      label: "기일: 2026-12-31 이전",
    });
    expect(
      buildFilterChips({
        ...BASE,
        auctionDateFrom: "2026-01-01",
        auctionDateTo: "2026-12-31",
      })[0],
    ).toMatchObject({ label: "기일: 2026-01-01 ~ 2026-12-31" });
  });

  it("불리언 필터(지난 기일 제외·관심·분석)는 각자 칩이 되고 해제 override가 자기 필드만 지운다", () => {
    const chips = buildFilterChips({
      ...BASE,
      excludePastAuctions: true,
      bookmarked: true,
      analyzed: false,
    });
    expect(chips).toEqual([
      { key: "excludePastAuctions", label: "지난 기일 제외", clear: { excludePastAuctions: undefined } },
      { key: "bookmarked", label: "관심만 보기", clear: { bookmarked: undefined } },
      { key: "analyzed", label: "분석 전만", clear: { analyzed: undefined } },
    ]);
    expect(buildFilterChips({ ...BASE, bookmarked: false })[0]).toMatchObject({
      label: "관심 제외",
    });
  });

  it("법원, 저감률, 사진 보유 필터도 칩으로 만들어진다", () => {
    const chips = buildFilterChips({
      ...BASE,
      court: "서울중앙지방법원",
      minDiscountRate: 20,
      hasPhotos: true,
    });
    expect(chips).toContainEqual({
      key: "court",
      label: "법원: 서울중앙지방법원",
      clear: { court: undefined },
    });
    expect(chips).toContainEqual({
      key: "minDiscountRate",
      label: "저감률: 20% 이상",
      clear: { minDiscountRate: undefined },
    });
    expect(chips).toContainEqual({
      key: "hasPhotos",
      label: "사진 있음",
      clear: { hasPhotos: undefined },
    });

    const falseChips = buildFilterChips({ ...BASE, hasPhotos: false });
    expect(falseChips).toContainEqual({
      key: "hasPhotos",
      label: "사진 없음",
      clear: { hasPhotos: undefined },
    });
  });

  it("여러 필터가 동시에 있으면 각각 별도 칩이고, 하나를 해제해도 나머지 override는 영향받지 않는다", () => {
    const query: ItemQuery = {
      ...BASE,
      usageTypes: ["아파트"],
      minFailedBidCount: 2,
      addressKeyword: "강남",
    };
    const chips = buildFilterChips(query);
    expect(chips).toHaveLength(3);
    const usageChip = chips.find((c) => c.key === "usage")!;
    expect(usageChip.clear).toEqual({ usageTypes: undefined });
    // 용도 칩을 해제해도 나머지 필드는 override 객체 안에 없다 — 그대로 유지된다는 뜻.
    expect(usageChip.clear).not.toHaveProperty("minFailedBidCount");
    expect(usageChip.clear).not.toHaveProperty("addressKeyword");
  });
});
