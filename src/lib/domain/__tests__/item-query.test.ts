import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_USAGE_TYPES,
  chooseEmptyState,
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

  it("인식된 파라미터가 빈 값으로 오면 400으로 거부한다(finding 2)", () => {
    // `?analyzed=`처럼 빈 값을 "없음"으로 조용히 넘기면, 예를 들어 analyzer가 실수로
    // 빈 문자열을 넣었을 때 "분석된 것도 안 된 것도 전부"라는 정반대 결과를 아무 경고
    // 없이 돌려주게 된다. HTML form은 lenient만 쓰므로(design.md D4) 이 엄격함은
    // 폼 제출에 영향을 주지 않는다.
    const params = new URLSearchParams(
      "page=&pageSize=&analyzed=&usage=&minPrice=&maxPrice=&minFailed=&q=&sort=&dir=",
    );
    expect(fields(fail(parseItemQuery(params))).sort()).toEqual(
      [
        "analyzed",
        "dir",
        "maxPrice",
        "minFailed",
        "minPrice",
        "page",
        "pageSize",
        "q",
        "sort",
        "usage",
      ].sort(),
    );
    // 공백만 있는 값도 빈 값과 같이 취급한다.
    expect(fields(fail(parseItemQuery({ analyzed: " " })))).toEqual(["analyzed"]);
    expect(fields(fail(parseItemQuery({ q: "   " })))).toEqual(["q"]);
  });

  it("빈 값이 섞여 있으면 그 파라미터만 거부하고(strict) 나머지는 정상 검증한다", () => {
    // minPrice가 빈 값이라 거부되지만, usage 안의 빈 값도 usage 전체를 거부한다 —
    // "아파트"만 남기고 절반만 통과시키면 사용자가 지정하지 않은 조건이 생긴다.
    const issues = fail(parseItemQuery({ minPrice: "", maxPrice: "500", usage: ["", "아파트"] }));
    expect(fields(issues).sort()).toEqual(["minPrice", "usage"]);
    // 빈 값이 없는 다른 파라미터는 그대로 통과한다.
    expect(ok(parseItemQuery({ minPrice: "100", maxPrice: "500" }))).toMatchObject({
      minPrice: 100,
      maxPrice: 500,
    });
  });

  it("usage 개수가 상한을 넘으면 거부한다(finding 4 — SQLite 바인딩 파라미터 상한 방어)", () => {
    const tooMany = Array.from({ length: MAX_USAGE_TYPES + 1 }, (_, i) => `용도${i}`);
    expect(fields(fail(parseItemQuery({ usage: tooMany })))).toEqual(["usage"]);
    const exactlyMax = Array.from({ length: MAX_USAGE_TYPES }, (_, i) => `용도${i}`);
    expect(ok(parseItemQuery({ usage: exactlyMax })).usageTypes).toHaveLength(MAX_USAGE_TYPES);
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

  it("서로 무관한 필드가 각각 잘못되면(둘 다 필드 단위 오류) 전부 알려준다", () => {
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

  it("필드 단위 오류가 있으면 minPrice/maxPrice 교차검증(superRefine)은 실행되지 않는다", () => {
    // 위 두 테스트를 합쳐 놓은 값처럼 보이지만 결과가 다르다: `sort`가 필드 단위에서
    // 이미 실패하면 zod object 파싱이 그 필드에서 멈추고(dirty가 아니라 aborted),
    // superRefine 자체가 실행되지 않는다 — 그래서 minPrice(500) > maxPrice(100)인데도
    // "여러 파라미터가 동시에 잘못되면 전부 알려준다"처럼 둘 다 나오지 않고 sort 하나만
    // 나온다. "필드 단위 오류는 함께 보고된다"가 "필드 단위 오류와 교차검증 오류가 항상
    // 함께 보고된다"를 뜻하지 않는다 — 실측으로 고정해 둔다.
    const issues = fail(parseItemQuery({ sort: "nope", minPrice: "500", maxPrice: "100" }));
    expect(fields(issues)).toEqual(["sort"]);
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

  it("빈 문자열 파라미터는 '없음'으로 취급한다(HTML form이 빈 칸을 그대로 보낸다)", () => {
    // strict와 달리(finding 2) lenient는 빈 값을 그대로 "없음"으로 흡수한다 — 이 파서는
    // 사람이 손으로 채운 폼/URL만 상대하므로 화면이 죽으면 안 된다(design.md D4).
    const params = new URLSearchParams(
      "page=&pageSize=&analyzed=&usage=&minPrice=&maxPrice=&minFailed=&q=&sort=&dir=",
    );
    expect(parseItemQueryLenient(params)).toEqual(DEFAULTS);
    // 공백만 있는 값도 같다.
    expect(parseItemQueryLenient({ q: "   ", usage: ["", "  "] })).toEqual(DEFAULTS);
  });

  it("빈 값이 섞여 있어도 나머지는 살린다", () => {
    expect(parseItemQueryLenient({ minPrice: "", maxPrice: "500", usage: ["", "아파트"] })).toEqual({
      ...DEFAULTS,
      maxPrice: 500,
      usageTypes: ["아파트"],
    });
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

  it("analyzed도 결과를 좁히는 필터다(finding 1) — true/false 둘 다 활성 취급한다", () => {
    // `analyzed`는 값의 참/거짓과 무관하게 "지정돼 있다"는 사실 자체가 결과를 좁힌다.
    // 이게 빠져 있던 것이 finding 1의 근본 원인이었다 — /?analyzed=true인데 결과가 0건이면
    // "필터에 걸린 것"인데도 "DB가 비었다"로 잘못 보고했다.
    expect(hasActiveFilters({ analyzed: true })).toBe(true);
    expect(hasActiveFilters({ analyzed: false })).toBe(true);
  });
});

describe("chooseEmptyState", () => {
  it("결과가 있으면 total과 무관하게 hasItems다", () => {
    expect(chooseEmptyState(5, DEFAULTS)).toEqual({ kind: "hasItems" });
    expect(chooseEmptyState(1, { ...DEFAULTS, analyzed: true })).toEqual({ kind: "hasItems" });
  });

  it("0건이고 필터가 전혀 없으면 emptyDatabase다", () => {
    expect(chooseEmptyState(0, DEFAULTS)).toEqual({ kind: "emptyDatabase" });
  });

  it("0건이고 analyzed만 지정돼 있어도 emptyFiltered다(finding 1의 핵심 회귀 케이스)", () => {
    // 500건이 미분석 상태일 때 /?analyzed=true → total=0. 이건 "DB가 비었다"가 아니라
    // "필터(analyzed=true)에 맞는 게 없다"이다. 화면은 필터 폼과 초기화 링크를 보여줘야
    // 사용자가 빠져나갈 수 있다.
    expect(chooseEmptyState(0, { ...DEFAULTS, analyzed: true })).toEqual({ kind: "emptyFiltered" });
    expect(chooseEmptyState(0, { ...DEFAULTS, analyzed: false })).toEqual({ kind: "emptyFiltered" });
  });

  it("0건이고 다른 필터(용도·가격·키워드 등)가 있어도 emptyFiltered다", () => {
    expect(chooseEmptyState(0, { ...DEFAULTS, usageTypes: ["존재하지않는용도"] })).toEqual({
      kind: "emptyFiltered",
    });
    expect(chooseEmptyState(0, { ...DEFAULTS, addressKeyword: "존재하지않는주소" })).toEqual({
      kind: "emptyFiltered",
    });
  });
});
