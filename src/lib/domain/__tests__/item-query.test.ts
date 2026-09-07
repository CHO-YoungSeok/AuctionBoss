import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  hasActiveFilters,
  parseItemQuery,
  parseItemQueryLenient,
  type ItemQuery,
  type ItemQueryIssue,
  type ItemQueryParseResult,
} from "../item-query";

/** strict 파서가 성공했다고 보고 조건을 꺼낸다. 실패하면 이유가 보이게 죽는다. */
function ok(result: ItemQueryParseResult): ItemQuery {
  if (!result.success) throw new Error(`파싱이 실패했다: ${JSON.stringify(result.issues)}`);
  return result.query;
}

/** strict 파서가 실패했다고 보고 오류 목록을 꺼낸다. */
function fail(result: ItemQueryParseResult): ItemQueryIssue[] {
  if (result.success) throw new Error(`실패를 기대했는데 성공했다: ${JSON.stringify(result.query)}`);
  return result.issues;
}

function fields(issues: ItemQueryIssue[]): string[] {
  return issues.map((issue) => issue.field);
}

/** 기존 기본값 = page 1, pageSize 20, 필터 없음. */
const DEFAULTS: ItemQuery = { page: 1, pageSize: DEFAULT_PAGE_SIZE };

describe("parseItemQuery (strict)", () => {
  it("파라미터가 전혀 없으면 기존 기본값(page 1, pageSize 20, 필터 없음)이 나온다", () => {
    expect(ok(parseItemQuery({}))).toEqual(DEFAULTS);
    expect(ok(parseItemQuery(new URLSearchParams()))).toEqual(DEFAULTS);
  });

  it("URLSearchParams와 서버 컴포넌트의 레코드가 같은 결과를 낸다", () => {
    const fromSearchParams = ok(
      parseItemQuery(new URLSearchParams("page=3&pageSize=50&q=강남&sort=bidRatio&dir=desc")),
    );
    const fromRecord = ok(
      parseItemQuery({ page: "3", pageSize: "50", q: "강남", sort: "bidRatio", dir: "desc" }),
    );

    expect(fromSearchParams).toEqual(fromRecord);
    expect(fromRecord).toEqual({
      page: 3,
      pageSize: 50,
      addressKeyword: "강남",
      sort: "bidRatio",
      direction: "desc",
    });
  });

  it("usage는 반복 파라미터로 여러 개를 받는다", () => {
    expect(ok(parseItemQuery(new URLSearchParams("usage=아파트&usage=다세대"))).usageTypes).toEqual([
      "아파트",
      "다세대",
    ]);
    expect(ok(parseItemQuery({ usage: ["아파트", "다세대"] })).usageTypes).toEqual([
      "아파트",
      "다세대",
    ]);
    expect(ok(parseItemQuery({ usage: "아파트" })).usageTypes).toEqual(["아파트"]);
  });

  it("용도 값 안의 쉼표를 쪼개지 않는다 — 실제 수집값에 쉼표가 있다", () => {
    // NOTES.md §8의 실측값. 쉼표로 나누면 존재하지 않는 용도 3개가 되어 아무 것도 안 나온다.
    const query = ok(parseItemQuery({ usage: ["상가,오피스텔,근린시설", "아파트"] }));
    expect(query.usageTypes).toEqual(["상가,오피스텔,근린시설", "아파트"]);
  });

  it("가격 범위는 한쪽만 지정해도 된다", () => {
    expect(ok(parseItemQuery({ minPrice: "100000000" }))).toEqual({
      ...DEFAULTS,
      minPrice: 100_000_000,
    });
    expect(ok(parseItemQuery({ maxPrice: "500000000" }))).toEqual({
      ...DEFAULTS,
      maxPrice: 500_000_000,
    });
    expect(ok(parseItemQuery({ minPrice: "100", maxPrice: "500" }))).toMatchObject({
      minPrice: 100,
      maxPrice: 500,
    });
  });

  it("빈 문자열 파라미터는 '없음'으로 취급한다(HTML form이 빈 칸을 그대로 보낸다)", () => {
    const params = new URLSearchParams(
      "page=&pageSize=&analyzed=&usage=&minPrice=&maxPrice=&minFailed=&q=&sort=&dir=",
    );
    expect(ok(parseItemQuery(params))).toEqual(DEFAULTS);
    // 공백만 있는 값도 같다.
    expect(ok(parseItemQuery({ q: "   ", usage: ["", "  "] }))).toEqual(DEFAULTS);
  });

  it("빈 값이 섞여 있어도 나머지는 살린다", () => {
    expect(ok(parseItemQuery({ minPrice: "", maxPrice: "500", usage: ["", "아파트"] }))).toEqual({
      ...DEFAULTS,
      maxPrice: 500,
      usageTypes: ["아파트"],
    });
  });

  it("키워드는 앞뒤 공백만 제거하고 안쪽은 보존한다", () => {
    expect(ok(parseItemQuery({ q: "  강남구 역삼동  " })).addressKeyword).toBe("강남구 역삼동");
  });

  it("analyzed는 true/false 문자열만 받는다", () => {
    expect(ok(parseItemQuery({ analyzed: "false" })).analyzed).toBe(false);
    expect(ok(parseItemQuery({ analyzed: "true" })).analyzed).toBe(true);
    expect(fields(fail(parseItemQuery({ analyzed: "1" })))).toEqual(["analyzed"]);
  });

  it("허용되지 않은 sort 값을 거부하고 어떤 파라미터가 문제인지 알려준다", () => {
    const issues = fail(parseItemQuery({ sort: "appraisalPrice" }));
    expect(fields(issues)).toEqual(["sort"]);
    expect(issues[0]?.message).toContain("sort");
    expect(issues[0]?.message).toContain("bidRatio");
  });

  it("네 개의 sort 값과 두 개의 dir 값만 통과한다", () => {
    for (const sort of ["auctionDate", "minBidPrice", "bidRatio", "failedBidCount"]) {
      expect(ok(parseItemQuery({ sort })).sort).toBe(sort);
    }
    expect(ok(parseItemQuery({ dir: "asc" })).direction).toBe("asc");
    expect(ok(parseItemQuery({ dir: "desc" })).direction).toBe("desc");
    expect(fields(fail(parseItemQuery({ dir: "DESC" })))).toEqual(["dir"]);
  });

  it("숫자가 아닌 값·음수·소수를 거부한다", () => {
    expect(fields(fail(parseItemQuery({ minPrice: "abc" })))).toEqual(["minPrice"]);
    expect(fields(fail(parseItemQuery({ minPrice: "-1" })))).toEqual(["minPrice"]);
    expect(fields(fail(parseItemQuery({ maxPrice: "1.5" })))).toEqual(["maxPrice"]);
    expect(fields(fail(parseItemQuery({ minFailed: "세 번" })))).toEqual(["minFailed"]);
    expect(fields(fail(parseItemQuery({ page: "0" })))).toEqual(["page"]);
    expect(fields(fail(parseItemQuery({ pageSize: "0" })))).toEqual(["pageSize"]);
    expect(fields(fail(parseItemQuery({ pageSize: String(MAX_PAGE_SIZE + 1) })))).toEqual([
      "pageSize",
    ]);
  });

  it("여러 파라미터가 동시에 잘못되면 전부 알려준다", () => {
    const issues = fail(parseItemQuery({ sort: "nope", minPrice: "abc" }));
    expect(fields(issues).sort()).toEqual(["minPrice", "sort"]);
  });

  it("minPrice > maxPrice는 두 파라미터 모두를 지목해 거부한다", () => {
    const issues = fail(parseItemQuery({ minPrice: "500", maxPrice: "100" }));
    expect(fields(issues)).toEqual(["minPrice", "maxPrice"]);
    expect(issues[0]?.message).toContain("maxPrice");
    // 같으면 통과한다(경계값).
    expect(ok(parseItemQuery({ minPrice: "100", maxPrice: "100" }))).toMatchObject({
      minPrice: 100,
      maxPrice: 100,
    });
  });

  it("스칼라 파라미터가 여러 번 오면 첫 값을 쓴다", () => {
    expect(ok(parseItemQuery(new URLSearchParams("page=2&page=7"))).page).toBe(2);
    expect(ok(parseItemQuery({ page: ["2", "7"] })).page).toBe(2);
  });

  it("모르는 파라미터는 무시한다(400이 되지 않는다)", () => {
    expect(ok(parseItemQuery({ utm_source: "kakao", nope: "x" }))).toEqual(DEFAULTS);
  });

  it("필터·정렬 전체 조합을 한 번에 파싱한다", () => {
    const params = new URLSearchParams(
      "usage=아파트&usage=다세대&minPrice=100000000&maxPrice=500000000&minFailed=3&q=강남&sort=bidRatio&dir=asc&page=2&pageSize=50&analyzed=false",
    );
    expect(ok(parseItemQuery(params))).toEqual({
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
    });
  });
});

describe("parseItemQueryLenient", () => {
  it("파라미터가 없으면 strict와 같은 기본값을 낸다", () => {
    expect(parseItemQueryLenient({})).toEqual(DEFAULTS);
  });

  it("잘못된 값은 버리고 기본값으로 복구한다", () => {
    expect(parseItemQueryLenient({ page: "abc" })).toEqual(DEFAULTS);
    expect(parseItemQueryLenient({ page: "0", pageSize: "9999" })).toEqual(DEFAULTS);
    expect(parseItemQueryLenient({ sort: "nope", dir: "DESC" })).toEqual(DEFAULTS);
  });

  it("잘못된 파라미터만 버리고 멀쩡한 것은 살린다", () => {
    expect(parseItemQueryLenient({ sort: "nope", q: "강남", page: "3" })).toEqual({
      page: 3,
      pageSize: DEFAULT_PAGE_SIZE,
      addressKeyword: "강남",
    });
  });

  it("여러 파라미터가 동시에 잘못돼도 나머지를 살린다", () => {
    expect(
      parseItemQueryLenient({
        page: "abc",
        minPrice: "-1",
        analyzed: "yes",
        usage: ["아파트"],
        minFailed: "2",
      }),
    ).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      usageTypes: ["아파트"],
      minFailedBidCount: 2,
    });
  });

  it("minPrice > maxPrice면 한쪽만 남기지 않고 둘 다 버린다", () => {
    // 한쪽만 남기면 사용자가 지정하지 않은 범위를 임의로 만들어 낸다.
    expect(parseItemQueryLenient({ minPrice: "500", maxPrice: "100", q: "강남" })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      addressKeyword: "강남",
    });
  });
});

describe("hasActiveFilters", () => {
  it("필터가 하나라도 있으면 true, 페이지·정렬만 있으면 false다", () => {
    expect(hasActiveFilters(DEFAULTS)).toBe(false);
    expect(hasActiveFilters({ page: 3, sort: "bidRatio", direction: "desc" })).toBe(false);
    expect(hasActiveFilters({ usageTypes: [] })).toBe(false);
    expect(hasActiveFilters({ usageTypes: ["아파트"] })).toBe(true);
    expect(hasActiveFilters({ minPrice: 0 })).toBe(true);
    expect(hasActiveFilters({ maxPrice: 100 })).toBe(true);
    expect(hasActiveFilters({ minFailedBidCount: 0 })).toBe(true);
    expect(hasActiveFilters({ addressKeyword: "강남" })).toBe(true);
  });
});
