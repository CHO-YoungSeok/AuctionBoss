import { describe, expect, it } from "vitest";

import { EMPTY } from "../format";
import {
  computePricePerArea,
  formatAreaRange,
  formatPricePerArea,
  formatRoundPrice,
  formatStructuredAddress,
  formatUsageCodes,
  listRoundPrices,
} from "../item-extensions";

describe("formatAreaRange", () => {
  it("min/max가 같으면 한 번만 보여준다 (REAL_ROW 관측값)", () => {
    expect(formatAreaRange({ minArea: 84, maxArea: 84 })).toBe("84㎡");
  });

  it("min/max가 다르면 범위로 보여준다", () => {
    expect(formatAreaRange({ minArea: 50, maxArea: 84 })).toBe("50㎡ ~ 84㎡");
  });

  it("한쪽만 있으면 그 값만 보여준다", () => {
    expect(formatAreaRange({ minArea: 84, maxArea: null })).toBe("84㎡");
    expect(formatAreaRange({ minArea: null, maxArea: 84 })).toBe("84㎡");
  });

  it("둘 다 없으면 EMPTY", () => {
    expect(formatAreaRange({ minArea: null, maxArea: null })).toBe(EMPTY);
    expect(formatAreaRange({ minArea: undefined, maxArea: undefined })).toBe(EMPTY);
  });
});

describe("computePricePerArea", () => {
  it("정상 값이면 최저매각가격 ÷ minArea", () => {
    expect(computePricePerArea({ minBidPrice: 711_000_000, minArea: 84, maxArea: 84 })).toBeCloseTo(
      711_000_000 / 84,
    );
  });

  it("minArea가 없으면 maxArea로 대체한다", () => {
    expect(
      computePricePerArea({ minBidPrice: 711_000_000, minArea: null, maxArea: 84 }),
    ).toBeCloseTo(711_000_000 / 84);
  });

  it("면적이 둘 다 없으면 null (NaN/Infinity 아님)", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: null, maxArea: null });
    expect(result).toBeNull();
  });

  it("면적이 0이면 null (0으로 나누기 방지, 방어적 재확인)", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 0, maxArea: 0 });
    expect(result).toBeNull();
  });

  it("최저매각가격이 없으면 null", () => {
    expect(computePricePerArea({ minBidPrice: null, minArea: 84, maxArea: 84 })).toBeNull();
  });

  it("최저매각가격이 숫자가 아니면(NaN) null", () => {
    expect(computePricePerArea({ minBidPrice: Number.NaN, minArea: 84, maxArea: 84 })).toBeNull();
  });

  it("결과 어디에도 NaN/Infinity가 나오지 않는다", () => {
    const cases = [
      { minBidPrice: null, minArea: null, maxArea: null },
      { minBidPrice: 100, minArea: 0, maxArea: null },
      { minBidPrice: Number.POSITIVE_INFINITY, minArea: 84, maxArea: 84 },
      { minBidPrice: 100, minArea: Number.NaN, maxArea: Number.NaN },
    ];
    for (const c of cases) {
      const result = computePricePerArea(c);
      if (result !== null) {
        expect(Number.isFinite(result)).toBe(true);
      }
    }
  });
});

describe("formatPricePerArea", () => {
  it("null이면 EMPTY", () => {
    expect(formatPricePerArea(null)).toBe(EMPTY);
  });

  it("값이 있으면 천 단위 구분 + 원/㎡", () => {
    expect(formatPricePerArea(711_000_000 / 84)).toBe("8,464,286원/㎡");
  });
});

describe("listRoundPrices", () => {
  it("값이 있는 회차만, 순서대로 돌려준다", () => {
    const rounds = listRoundPrices({
      minBidPriceRound1: 711_000_000,
      minBidPriceRound2: null, // 소스 원값 "0" → 데이터 계층이 이미 null로 접음(design.md D3)
      minBidPriceRound3: 500_000_000,
      minBidPriceRound4: null,
      minBidPriceRateRound1: 100,
      minBidPriceRateRound2: null,
    });
    expect(rounds).toEqual([
      { round: 1, price: 711_000_000, ratePercent: 100 },
      { round: 3, price: 500_000_000, ratePercent: null },
    ]);
  });

  it("전부 없으면 빈 배열 (빈 행을 만들지 않는다)", () => {
    expect(
      listRoundPrices({
        minBidPriceRound1: null,
        minBidPriceRound2: null,
        minBidPriceRound3: null,
        minBidPriceRound4: null,
        minBidPriceRateRound1: null,
        minBidPriceRateRound2: null,
      }),
    ).toEqual([]);
  });

  it("undefined(확장 필드를 모르는 기존 리터럴)도 없는 값으로 취급한다", () => {
    expect(listRoundPrices({})).toEqual([]);
  });
});

describe("formatRoundPrice", () => {
  it("비율이 있으면 괄호로 붙인다", () => {
    expect(formatRoundPrice({ round: 1, price: 711_000_000, ratePercent: 100 })).toBe(
      "1차: 711,000,000원 (100%)",
    );
  });

  it("비율이 없으면(3·4차) 괄호를 생략한다", () => {
    expect(formatRoundPrice({ round: 3, price: 500_000_000, ratePercent: null })).toBe(
      "3차: 500,000,000원",
    );
  });
});

describe("formatUsageCodes", () => {
  it("값이 있는 코드만 이어붙인다 — 라벨을 붙이지 않는다(design.md D4)", () => {
    expect(
      formatUsageCodes({ usageCodeLarge: "20000", usageCodeMedium: "20100", usageCodeSmall: "20104" }),
    ).toBe("20000 / 20100 / 20104");
  });

  it("일부만 있어도 있는 것만 이어붙인다", () => {
    expect(
      formatUsageCodes({ usageCodeLarge: "20000", usageCodeMedium: null, usageCodeSmall: null }),
    ).toBe("20000");
  });

  it("전부 없으면 EMPTY", () => {
    expect(
      formatUsageCodes({ usageCodeLarge: null, usageCodeMedium: null, usageCodeSmall: null }),
    ).toBe(EMPTY);
  });
});

describe("formatStructuredAddress", () => {
  it("실제 관측값(NOTES.md §11)을 순서대로 이어붙인다", () => {
    expect(
      formatStructuredAddress({
        sido: "서울특별시",
        sigungu: "성북구",
        dong: "정릉동",
        lotNumber: "1032",
        buildingName: "정릉2차 대주피오레",
        buildingUnit: "203동 4층 401호",
      }),
    ).toBe("서울특별시 성북구 정릉동 1032 정릉2차 대주피오레 203동 4층 401호");
  });

  it("빈 문자열은 값 없음으로 취급해 건너뛴다", () => {
    expect(
      formatStructuredAddress({
        sido: "서울특별시",
        sigungu: "",
        dong: "정릉동",
        lotNumber: null,
        buildingName: null,
        buildingUnit: null,
      }),
    ).toBe("서울특별시 정릉동");
  });

  it("전부 없으면 EMPTY", () => {
    expect(
      formatStructuredAddress({
        sido: null,
        sigungu: null,
        dong: null,
        lotNumber: null,
        buildingName: null,
        buildingUnit: null,
      }),
    ).toBe(EMPTY);
  });
});
