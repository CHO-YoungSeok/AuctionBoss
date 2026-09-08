/**
 * `computeDerivedFigures` 단위 테스트.
 *
 * 이 모듈이 존재하는 이유(실데이터 검증 실패)를 그대로 회귀 케이스로 고정한다:
 * `minArea: 84`, `minBidPrice: 711000000`, `minBidPriceRound1: 711000000`,
 * `minBidPriceRateRound1: 100`이 전부 non-null인데도 모델이 "정보 없음"이라고 답한
 * 사례가 있었다. 코드가 이 값들을 미리 계산해 두면 모델이 그 판정을 다시 할 필요가
 * 없어진다 — 그 전제를 여기서 고정한다.
 */
import { describe, expect, it } from "vitest";

import {
  PRICE_PER_AREA_UNAVAILABLE_REASON,
  ROUND_TREND_UNAVAILABLE_REASON,
  computeDerivedFigures,
  type DerivedFiguresFields,
} from "../lib/derived";

function makeFields(overrides: Partial<DerivedFiguresFields> = {}): DerivedFiguresFields {
  return {
    minBidPrice: null,
    minArea: null,
    maxArea: null,
    appraisalPrice: null,
    minBidPriceRound1: null,
    minBidPriceRound2: null,
    minBidPriceRound3: null,
    minBidPriceRound4: null,
    ...overrides,
  };
}

describe("computeDerivedFigures — 면적당 가격", () => {
  it("실데이터 패턴(§11): minArea·minBidPrice가 있으면 계산된다", () => {
    const { pricePerArea } = computeDerivedFigures(
      makeFields({ minBidPrice: 711_000_000, minArea: 84 }),
    );
    expect(pricePerArea).toEqual({ computed: true, wonPerArea: 711_000_000 / 84 });
  });

  it("minArea가 null이면 maxArea로 대체한다", () => {
    const { pricePerArea } = computeDerivedFigures(
      makeFields({ minBidPrice: 711_000_000, minArea: null, maxArea: 84 }),
    );
    expect(pricePerArea).toEqual({ computed: true, wonPerArea: 711_000_000 / 84 });
  });

  it("minArea가 0이면(값 없음) 계산 불가 — maxArea도 없으면 이유를 밝힌다", () => {
    const { pricePerArea } = computeDerivedFigures(
      makeFields({ minBidPrice: 711_000_000, minArea: 0, maxArea: 0 }),
    );
    expect(pricePerArea).toEqual({ computed: false, reason: PRICE_PER_AREA_UNAVAILABLE_REASON });
  });

  it("minBidPrice가 null이면 계산 불가", () => {
    const { pricePerArea } = computeDerivedFigures(
      makeFields({ minBidPrice: null, minArea: 84 }),
    );
    expect(pricePerArea).toEqual({ computed: false, reason: PRICE_PER_AREA_UNAVAILABLE_REASON });
  });
});

describe("computeDerivedFigures — 차수별 저감 추이", () => {
  it("1차만 있으면 1차만, 비교 대상이 없어 저감률은 null", () => {
    const { roundTrend } = computeDerivedFigures(
      makeFields({ appraisalPrice: 711_000_000, minBidPriceRound1: 711_000_000 }),
    );
    expect(roundTrend).toEqual({
      computed: true,
      rounds: [
        { round: 1, price: 711_000_000, ratioToAppraisalPercent: 100, stepDownFromPreviousPercent: null },
      ],
    });
  });

  it("1·3차만 있고 2차가 없으면(회차가 아직 도래하지 않음) 1·3차를 이어서 저감률을 계산한다", () => {
    const { roundTrend } = computeDerivedFigures(
      makeFields({
        appraisalPrice: 1_000_000_000,
        minBidPriceRound1: 1_000_000_000,
        minBidPriceRound2: null,
        minBidPriceRound3: 640_000_000,
      }),
    );
    expect(roundTrend).toEqual({
      computed: true,
      rounds: [
        { round: 1, price: 1_000_000_000, ratioToAppraisalPercent: 100, stepDownFromPreviousPercent: null },
        { round: 3, price: 640_000_000, ratioToAppraisalPercent: 64, stepDownFromPreviousPercent: 36 },
      ],
    });
  });

  it("실데이터 패턴(§11): 2차 최저가율(rate)만 있고 2차 가격(price)이 없으면 2차를 건너뛴다", () => {
    // NOTES.md §11: minBidPriceRateRound2가 채워져 있어도 minBidPriceRound2가 아직
    // null인 실제 관측이 28/28 확인됐다 — 가격 유무로만 판정해야 하는 이유다.
    const { roundTrend } = computeDerivedFigures(
      makeFields({
        appraisalPrice: 711_000_000,
        minBidPriceRound1: 711_000_000,
        minBidPriceRound2: null,
      }),
    );
    expect(roundTrend.computed).toBe(true);
    if (roundTrend.computed) {
      expect(roundTrend.rounds).toHaveLength(1);
      expect(roundTrend.rounds[0]?.round).toBe(1);
    }
  });

  it("모든 회차가 없으면 계산 불가", () => {
    const { roundTrend } = computeDerivedFigures(makeFields({ appraisalPrice: 711_000_000 }));
    expect(roundTrend).toEqual({ computed: false, reason: ROUND_TREND_UNAVAILABLE_REASON });
  });

  it("appraisalPrice가 없으면 회차별 가격은 나오되 감정가 대비 비율은 null", () => {
    const { roundTrend } = computeDerivedFigures(
      makeFields({ appraisalPrice: null, minBidPriceRound1: 711_000_000 }),
    );
    expect(roundTrend).toEqual({
      computed: true,
      rounds: [
        { round: 1, price: 711_000_000, ratioToAppraisalPercent: null, stepDownFromPreviousPercent: null },
      ],
    });
  });
});
