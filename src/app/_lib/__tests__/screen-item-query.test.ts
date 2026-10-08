import { describe, expect, it } from "vitest";

import type { ItemQuery } from "@/lib/domain";

import { toScreenItemQuery } from "../screen-item-query";

describe("toScreenItemQuery", () => {
  it("분석 워커 전용 필드 세 개만 제거하고 나머지 조건은 그대로 둔다", () => {
    const query: ItemQuery = {
      needsAnalysis: true,
      promptVersion: "v3",
      reanalysisCooldownHours: 24,
      usageTypes: ["아파트"],
      sort: "minBidPrice",
      direction: "desc",
      page: 2,
      analyzed: false,
    };

    expect(toScreenItemQuery(query)).toStrictEqual({
      usageTypes: ["아파트"],
      sort: "minBidPrice",
      direction: "desc",
      page: 2,
      analyzed: false,
    });
  });

  it("입력 객체를 바꾸지 않는다(화면 링크·칩은 원래 조건에서 만든다)", () => {
    const query: ItemQuery = { needsAnalysis: true, promptVersion: "v3" };
    toScreenItemQuery(query);
    expect(query).toStrictEqual({ needsAnalysis: true, promptVersion: "v3" });
  });
});
