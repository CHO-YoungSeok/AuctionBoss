import { describe, expect, it } from "vitest";

import { parseAnalysesLimit } from "../analyses-query";

const parse = (q: string) => parseAnalysesLimit(new URLSearchParams(q));

describe("parseAnalysesLimit", () => {
  it("생략하면 10이다", () => {
    expect(parse("")).toEqual({ success: true, query: { limit: 10 } });
  });

  it("1~50 정수를 받고 앞뒤 공백은 다듬는다", () => {
    expect(parse("limit=1")).toEqual({ success: true, query: { limit: 1 } });
    expect(parse("limit=11")).toEqual({ success: true, query: { limit: 11 } });
    expect(parse("limit=50")).toEqual({ success: true, query: { limit: 50 } });
    expect(parse("limit=%207%20")).toEqual({ success: true, query: { limit: 7 } });
  });

  it.each(["0", "51", "abc", "", "-1", "1.5", "%2B3", "1e1", "99999999999999999999"])(
    "limit=%j 는 limit 이슈다",
    (value) => {
      const result = parse(`limit=${value}`);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.issues.map((i) => i.field)).toContain("limit");
    },
  );
});
