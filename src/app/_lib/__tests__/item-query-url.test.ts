/**
 * `item-query-url.ts`의 라운드트립 테스트.
 *
 * 스펙의 "필터 상태가 URL에 보존됨" 시나리오는 전적으로 이 파일의 직렬화가 맞아야
 * 성립한다 — 그런데도 지금까지 테스트가 하나도 없었다. 실제 수집 데이터에 쉼표가 든
 * 용도 문자열이 있다는 게 반증된 뒤(design.md D4) `usage`를 쉼표 구분에서 반복
 * 파라미터로 바꿨는데, 그 결정을 지키는 테스트가 없으면 다음 리팩터가 조용히
 * `usage=a,b`나 손으로 조립한 `?${k}=${v}` 문자열로 되돌아가도 아무도 못 잡는다.
 */
import { describe, expect, it } from "vitest";

import { parseItemQueryLenient, type ItemQuery } from "@/lib/domain";

import { ITEM_LIST_PATH, itemListHref, itemQuerySearchParams } from "../item-query-url";

function searchParamsOf(href: string): URLSearchParams {
  return new URL(href, "http://localhost").searchParams;
}

/**
 * lenient 파서는 문자열 값의 앞뒤 공백을 트림한다(`item-query.ts`의 `readParam`).
 * 그래서 앞뒤 공백이 있는 조건을 왕복하면 트림된 값으로 돌아오는 게 맞는 동작이다 —
 * 라운드트립 기대값도 그 정규화를 반영해야 "값이 달라졌다"는 오탐이 나지 않는다.
 */
function trimmed(query: ItemQuery): ItemQuery {
  return {
    ...query,
    ...(query.addressKeyword !== undefined
      ? { addressKeyword: query.addressKeyword.trim() }
      : {}),
    ...(query.usageTypes !== undefined
      ? { usageTypes: query.usageTypes.map((value) => value.trim()) }
      : {}),
  };
}

const DEFAULTS: ItemQuery = { page: 1, pageSize: 20 };

describe("itemListHref → parseItemQueryLenient 라운드트립", () => {
  const cases: Array<[string, ItemQuery]> = [
    [
      "실제 수집 데이터의 쉼표 포함 용도 문자열(NOTES.md §8)",
      { ...DEFAULTS, usageTypes: ["상가,오피스텔,근린시설", "아파트"] },
    ],
    ["URL 특수문자(&=#+공백)가 섞인 키워드", { ...DEFAULTS, addressKeyword: "a&b=c#d+e f" }],
    ["퍼센트 기호가 든 키워드", { ...DEFAULTS, addressKeyword: "100%" }],
    ["앞뒤 공백이 있는 키워드(트림돼 돌아온다)", { ...DEFAULTS, addressKeyword: "  강남 지역  " }],
    [
      "앞뒤 공백이 있는 용도 값(트림돼 돌아온다)",
      { ...DEFAULTS, usageTypes: ["  오피스텔  ", "아파트"] },
    ],
    [
      "필터·정렬·페이지 전체 조합",
      {
        page: 2,
        pageSize: 50,
        analyzed: false,
        usageTypes: ["아파트", "다세대"],
        minPrice: 100_000_000,
        maxPrice: 500_000_000,
        minFailedBidCount: 3,
        addressKeyword: "강남",
        sort: "bidRatio",
        direction: "asc",
      },
    ],
  ];

  for (const [label, query] of cases) {
    it(label, () => {
      const href = itemListHref(query);
      const roundTripped = parseItemQueryLenient(searchParamsOf(href));
      expect(roundTripped).toEqual(trimmed(query));
    });
  }

  it("usage 값의 쉼표를 절대 분리하지 않는다 — 반복 파라미터로 인코딩된다", () => {
    const query: ItemQuery = { ...DEFAULTS, usageTypes: ["상가,오피스텔,근린시설"] };
    const params = itemQuerySearchParams(query);

    // 쉼표로 합친 단일 값(`usage=상가,오피스텔,근린시설`)이 아니라 값마다 하나씩이어야 한다.
    expect(params.getAll("usage")).toEqual(["상가,오피스텔,근린시설"]);
    expect(parseItemQueryLenient(params).usageTypes).toEqual(["상가,오피스텔,근린시설"]);
  });

  it("기본값(1페이지, 기본 페이지 크기, 필터 없음)은 URL을 비운다", () => {
    expect(itemListHref(DEFAULTS)).toBe(ITEM_LIST_PATH);
    expect(parseItemQueryLenient(searchParamsOf(itemListHref(DEFAULTS)))).toEqual(DEFAULTS);
  });

  it("overrides는 지정한 필드만 바꾸고 나머지 조건은 유지한다(페이지네이션 링크)", () => {
    const query: ItemQuery = {
      ...DEFAULTS,
      addressKeyword: "강남",
      sort: "bidRatio",
      direction: "desc",
    };
    const href = itemListHref(query, { page: 3 });
    const roundTripped = parseItemQueryLenient(searchParamsOf(href));
    expect(roundTripped).toEqual({ ...query, page: 3 });
  });
});
