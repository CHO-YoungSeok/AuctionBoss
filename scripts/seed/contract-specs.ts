/**
 * 계약 골든 요청 목록 (generate-contracts.ts와 scripts/migrate/compare-api.ts가 함께 쓴다).
 *
 * 시각 의존 요청(excludePast=true, needsAnalysis=true)은 제외한다. 이유는 generate-contracts.ts 머리말 참고.
 */
export interface Spec {
  name: string;
  path: string;
  /** 이미 퍼센트 인코딩된 쿼리 문자열(앞의 ? 제외). */
  query: string;
}

const enc = encodeURIComponent;

export function buildSpecs(total: number): Spec[] {
  const specs: Spec[] = [];
  const list = (name: string, query: string) => specs.push({ name, path: "/api/items", query });

  list("list-default", "");
  list("list-page-size-5", "pageSize=5");

  for (const sort of ["auctionDate", "minBidPrice", "bidRatio", "failedBidCount", "pricePerArea"]) {
    for (const dir of ["asc", "desc"]) {
      list(`list-sort-${sort}-${dir}`, `sort=${sort}&dir=${dir}&pageSize=50`);
    }
  }
  // 정렬 키만, 방향만(기본값 조합)
  list("list-sort-only-bidRatio", "sort=bidRatio&pageSize=50");
  list("list-dir-only-desc", "dir=desc&pageSize=50");

  const lastPage = Math.ceil(total / 50);
  list("page-2", "page=2&pageSize=50");
  list("page-last", `page=${lastPage}&pageSize=50`);
  list("page-out-of-range", `page=${lastPage + 1}&pageSize=50`);
  list("page-max-size", "pageSize=200&sort=minBidPrice");

  list("filter-usage-single", `usage=${enc("오피스텔")}&pageSize=50`);
  list("filter-usage-compound-token", `usage=${enc("근린시설")}&pageSize=50`);
  list("filter-usage-multi", `usage=${enc("아파트")}&usage=${enc("대지")}&usage=${enc("임야")}&pageSize=50`);
  list("filter-price-range", "minPrice=100000000&maxPrice=300000000&pageSize=50");
  list("filter-price-min-only", "minPrice=1000000000&pageSize=50");
  list("filter-eok-man", "minEok=1&minMan=5000&maxEok=3&maxMan=0&pageSize=50");
  list("filter-eok-only-max", "maxEok=1&pageSize=50");
  list("filter-man-only-min", "minMan=30000&pageSize=50");
  list("filter-raw-beats-eok", "minPrice=200000000&minEok=5&maxEok=9&pageSize=50");
  list("filter-failed", "minFailed=3&pageSize=50");
  list("filter-discount", "minDiscountRate=30&pageSize=50");
  list("filter-sido-sigungu", `sido=${enc("서울특별시")}&sigungu=${enc("관악구")}&pageSize=50`);
  list("filter-sigungu-multi", `sigungu=${enc("서초구")}&sigungu=${enc("강남구")}&pageSize=50`);
  list("filter-sido-other", `sido=${enc("인천광역시")}&sido=${enc("전라남도")}`);
  list("filter-court", `court=${enc("서울중앙지방법원")}&pageSize=10`);
  list("filter-court-none", `court=${enc("부산지방법원")}`);
  list("filter-q-korean", `q=${enc("신림")}&pageSize=50`);
  list("filter-q-caseno-part", `q=${enc("타경18")}&pageSize=50`);
  list("filter-q-percent", `q=${enc("%")}`);
  list("filter-q-underscore", `q=${enc("_")}`);
  list("filter-q-backslash", `q=${enc("\\")}`);
  list("filter-q-case-insensitive", `q=${enc("genesis")}`);
  list("filter-q-trimmed", `q=${enc("  신림  ")}&pageSize=10`);
  list("filter-date-range", "dateFrom=2026-09-20&dateTo=2026-10-05&pageSize=50");
  list("filter-date-from-only", "dateFrom=2026-10-10&pageSize=50");
  list("filter-date-to-only", "dateTo=2026-09-10&pageSize=50");
  list("filter-analyzed-true", "analyzed=true");
  list("filter-analyzed-false", "analyzed=false&pageSize=20");
  list("filter-bookmarked-false", "bookmarked=false&pageSize=20");
  list("filter-bookmarked-true", "bookmarked=true");
  list("filter-has-photos-false", "hasPhotos=false&pageSize=20");
  list("filter-has-photos-true", "hasPhotos=true");
  list(
    "filter-combined",
    `usage=${enc("다세대")}&usage=${enc("연립주택")}&sido=${enc("서울특별시")}&minPrice=100000000&maxPrice=600000000&minFailed=1&sort=bidRatio&dir=desc&pageSize=50`,
  );
  list("filter-combined-pricePerArea", `sigungu=${enc("관악구")}&minDiscountRate=20&sort=pricePerArea&dir=asc&pageSize=50`);
  list("filter-empty-result", `usage=${enc("없는용도")}`);

  for (const [name, query] of [
    ["sort-invalid", "sort=nope"],
    ["dir-invalid", "dir=sideways"],
    ["page-size-zero", "pageSize=0"],
    ["page-size-too-large", "pageSize=201"],
    ["page-zero", "page=0"],
    ["page-not-number", "page=abc"],
    ["page-negative", "page=-1"],
    ["price-inverted", "minPrice=500&maxPrice=100"],
    ["eok-inverted", "minEok=3&maxEok=1"],
    ["analyzed-empty", "analyzed="],
    ["analyzed-invalid", "analyzed=maybe"],
    ["date-format", "dateFrom=2026/09/01"],
    ["date-inverted", "dateFrom=2026-10-01&dateTo=2026-09-01"],
    ["needs-analysis-without-prompt-version", "needsAnalysis=true"],
    ["needs-analysis-false", "needsAnalysis=false"],
    ["exclude-past-false", "excludePast=false"],
    ["discount-over-100", "minDiscountRate=101"],
    ["bookmarked-invalid", "bookmarked=yes"],
    ["multiple-errors", "page=abc&pageSize=999&sort=nope"],
    ["usage-empty", "usage="],
  ] as const) {
    list(`error-400-${name}`, query);
  }

  const detail = (name: string, p: string) => specs.push({ name, path: p, query: "" });
  for (const id of [1, 28, 53, 109]) detail(`detail-with-analysis-${id}`, `/api/items/${id}`);
  detail("detail-without-analysis-207", "/api/items/207");
  detail("detail-without-analysis-891", "/api/items/891");
  for (const id of [1, 3, 10]) detail(`changes-many-${id}`, `/api/items/${id}/changes`);
  for (const id of [2, 4]) detail(`changes-few-${id}`, `/api/items/${id}/changes`);
  detail("usage-types", "/api/items/usage-types");
  detail("error-404-detail-nan", "/api/items/abc");
  detail("error-404-detail-missing", "/api/items/999999");
  detail("error-404-detail-negative", "/api/items/-1");
  detail("error-404-changes-nan", "/api/items/abc/changes");
  detail("error-404-changes-missing", "/api/items/999999/changes");
  return specs;
}
