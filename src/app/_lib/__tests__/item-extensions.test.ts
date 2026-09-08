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
  toPyeong,
} from "../item-extensions";

describe("toPyeong", () => {
  it("㎡를 평으로 환산한다 (1평 = 3.3058㎡, 소수 1자리)", () => {
    expect(toPyeong(84)).toBe(25.4);
    expect(toPyeong(50)).toBe(15.1);
  });

  it("정확히 1평이면 1.0", () => {
    expect(toPyeong(3.3058)).toBe(1);
  });

  it("0이면 null(변환 불가, 값 없음과 같은 취급)", () => {
    expect(toPyeong(0)).toBeNull();
  });

  it("음수이면 null(데이터 이상값, 지어내지 않는다)", () => {
    expect(toPyeong(-10)).toBeNull();
  });

  it("NaN/Infinity면 null", () => {
    expect(toPyeong(Number.NaN)).toBeNull();
    expect(toPyeong(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("결과는 항상 소수 1자리를 넘지 않는다(원본보다 정밀도를 꾸며내지 않는다)", () => {
    const result = toPyeong(11_414);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(Math.round(result * 10)).toBe(result * 10);
    }
  });
});

describe("formatAreaRange", () => {
  it("min/max가 같으면 한 번만 평과 함께 보여준다 (REAL_ROW 관측값)", () => {
    expect(formatAreaRange({ minArea: 84, maxArea: 84 })).toBe("84㎡ (25.4평)");
  });

  it("정상 범위(min<=max, 둘이 다름)는 기존처럼 범위로 잇는다 — 실데이터 52%(tasks.md 1.2)", () => {
    expect(formatAreaRange({ minArea: 50, maxArea: 84 })).toBe("50㎡ (15.1평) ~ 84㎡ (25.4평)");
  });

  it("한쪽만 있으면 그 값만 평과 함께 보여준다", () => {
    expect(formatAreaRange({ minArea: 84, maxArea: null })).toBe("84㎡ (25.4평)");
    expect(formatAreaRange({ minArea: null, maxArea: 84 })).toBe("84㎡ (25.4평)");
  });

  it("둘 다 없으면 EMPTY", () => {
    expect(formatAreaRange({ minArea: null, maxArea: null })).toBe(EMPTY);
    expect(formatAreaRange({ minArea: undefined, maxArea: undefined })).toBe(EMPTY);
  });

  // design.md D1 — 실데이터 id 48(minArea=11414, maxArea=80)의 실제 역전 케이스.
  it("역전(min > max)이면 범위로 잇지 않고 '면적 A/B'로 병기하며 의미 미확정을 밝힌다 (실데이터 id 48)", () => {
    expect(formatAreaRange({ minArea: 11_414, maxArea: 80 })).toBe(
      "면적 A 11414㎡ (3452.7평) · 면적 B 80㎡ (24.2평) (의미 미확정)",
    );
  });

  it("역전이어도 값을 정렬해 뒤집지 않는다 — minArea가 항상 '면적 A' 자리다", () => {
    const reversed = formatAreaRange({ minArea: 11_414, maxArea: 80 });
    // "80㎡ ~ 11414㎡"처럼 오름차순 범위로 보이면 안 된다(없는 사실을 만드는 것).
    expect(reversed).not.toMatch(/^80㎡.*~.*11414㎡/);
    expect(reversed.indexOf("11414㎡")).toBeLessThan(reversed.indexOf("80㎡"));
  });
});

describe("computePricePerArea", () => {
  it("정상 값이면 최저매각가격 ÷ minArea, basisField는 minArea, basisAmbiguous는 false(같은 값)", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 84, maxArea: 84 });
    expect(result).not.toBeNull();
    expect(result?.pricePerArea).toBeCloseTo(711_000_000 / 84);
    expect(result?.basisArea).toBe(84);
    expect(result?.basisField).toBe("minArea");
    expect(result?.basisAmbiguous).toBe(false);
  });

  it("minArea가 없으면 maxArea로 대체하고 basisField가 maxArea가 된다", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: null, maxArea: 84 });
    expect(result?.pricePerArea).toBeCloseTo(711_000_000 / 84);
    expect(result?.basisField).toBe("maxArea");
    expect(result?.basisAmbiguous).toBe(false);
  });

  // design.md D2, 실데이터 id 48 패턴 — 역전된 물건에서도 minArea가 그대로 우선 쓰인다
  // (이번 change가 바꾸지 않는 것). basisAmbiguous만 true가 되어 호출자가 기준을 밝힐
  // 신호가 된다.
  it("역전된 면적(id 48: minArea=11414, maxArea=80)에서도 minArea 우선 — basisAmbiguous는 true", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 11_414, maxArea: 80 });
    expect(result?.basisField).toBe("minArea");
    expect(result?.basisArea).toBe(11_414);
    expect(result?.pricePerArea).toBeCloseTo(711_000_000 / 11_414);
    expect(result?.basisAmbiguous).toBe(true);
  });

  it("한쪽만 있으면 basisAmbiguous는 항상 false", () => {
    expect(
      computePricePerArea({ minBidPrice: 711_000_000, minArea: 84, maxArea: null })?.basisAmbiguous,
    ).toBe(false);
    expect(
      computePricePerArea({ minBidPrice: 711_000_000, minArea: null, maxArea: 84 })?.basisAmbiguous,
    ).toBe(false);
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
        expect(Number.isFinite(result.pricePerArea)).toBe(true);
        expect(Number.isFinite(result.basisArea)).toBe(true);
      }
    }
  });
});

describe("formatPricePerArea", () => {
  it("null이면 EMPTY", () => {
    expect(formatPricePerArea(null)).toBe(EMPTY);
  });

  it("basisAmbiguous가 false면(같은 값) 기준 표기를 생략한다", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 84, maxArea: 84 });
    expect(formatPricePerArea(result)).toBe("8,464,286원/㎡");
  });

  it("한쪽만 있으면 기준 표기를 생략한다", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 84, maxArea: null });
    expect(formatPricePerArea(result)).toBe("8,464,286원/㎡");
  });

  // design.md D2 — 실데이터 id 48 패턴. 기준(면적 A)을 밝혀야 사용자가 검증할 수 있다.
  it("basisAmbiguous가 true면(둘 다 있고 다름) 기준 면적을 밝힌다", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 11_414, maxArea: 80 });
    expect(formatPricePerArea(result)).toBe("62,292원/㎡ (면적 A 11,414㎡ 기준)");
  });

  it("NaN/Infinity/undefined 문자열이 나오지 않는다", () => {
    const result = computePricePerArea({ minBidPrice: 711_000_000, minArea: 84, maxArea: 84 });
    expect(formatPricePerArea(result)).not.toMatch(/NaN|Infinity|undefined/);
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
