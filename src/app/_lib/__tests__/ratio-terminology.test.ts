/**
 * 용어 회귀 방지: "저감률"(필터, 감정가 대비 깎인 %)과 "최저가율"(표시, 최저가 ÷ 감정가)은
 * 서로 반대 방향이다. 감정가 100·최저가 70이면 저감률 30%, 최저가율 70%.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ItemQuery } from "@/lib/domain";
import { useFakeBackend } from "@/lib/data-port/__tests__/fake-backend";

import ItemListPage from "../../page";
import { computeDiscountRatio, formatDiscountRatio } from "../discount";
import { buildFilterChips } from "../filter-chips";

describe("저감률(필터)과 최저가율(표시) 용어", () => {
  const backend = useFakeBackend();

  it("감정가 100·최저가 70은 최저가율 70.0%이고, 필터 칩은 저감률 30% 이상이라 읽힌다", () => {
    const ratio = computeDiscountRatio({ appraisalPrice: 100, minBidPrice: 70 });
    expect(formatDiscountRatio(ratio)).toBe("70.0%");

    const query: ItemQuery = { page: 1, pageSize: 20, minDiscountRate: 30 };
    expect(buildFilterChips(query).map((c) => c.label)).toContain("저감률: 30% 이상");
  });

  it("목록 헤더는 비율 열을 '최저가율'로 부르고 '저감률'은 쓰지 않는다", async () => {
    backend.addItem({
      court: "서울중앙지방법원",
      caseNo: "2025타경1",
      itemNo: "1",
      address: "서울특별시 관악구 봉천동 1-1",
      usageType: "아파트",
      appraisalPrice: 100,
      minBidPrice: 70,
      auctionDate: "2026-10-15",
      failedBidCount: 1,
      status: "유찰 1회",
    });
    const element = await ItemListPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement(() => element));

    expect(html).toContain("최저가율");
    expect(html).toContain("70.0%");
    expect(html).not.toContain("저감률</th>");
  });
});
